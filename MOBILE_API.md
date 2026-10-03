# Claim Saathi – Mobile (customer) API

**Current base URL (cloudflared tunnel → Mac :5050):** `https://stamps-logical-modems-dishes.trycloudflare.com/api`
(Local: `http://localhost:5050/api`. Quick tunnels change URL on restart. Update this line and the app's env when that happens.)

- Auth: `Authorization: Bearer <JWT>` (7-day token). Errors: `{ "error": { "code", "message" } }`.
- **Demo OTP:** no SMS is sent. Every OTP step (login, claim consent, bank verify) accepts only `111000` (`OTP_DEMO_CODE`).
- Every mutation writes to Supabase Postgres (ClaimEvent / ActivityLog / Notification), triggers the Claim Agent (mock AI), and pushes a live update to the dashboard over SSE.
- E2E test of this whole flow: `./scripts/e2e-mobile.sh` (uses the tunnel, cleans up after itself; `KEEP=1` keeps the data).

## 1. Onboarding (OTP)
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/otp/send` | `{ "phone": "9820000001" }` | `{ sent: true, phone: "+91 98200 00001", expiresInSeconds: 300, demo: true }` |
| POST | `/auth/otp/verify` | `{ "phone": "9820000001", "otp": "111000" }` | `{ token, user, isNewUser, needsProfile, starterProvisioned }` (a new phone creates a CUSTOMER and gets the starter dataset, §9.1) |
| GET | `/me` (or `/auth/me`) | – | user (see shape below) |
| PUT | `/me/profile` | `{ name, email, dob: "1990-05-14", gender: "male"\|"female"\|"other", city? }` | `{ user, token }` (**replace the stored token**, since name and email are inside it). `PATCH` for partial edits. |
| GET | `/me/policies` | – | `Policy[]` |
| GET | `/me/policies/:id` | – | policy (with stored `analysis`) + its claims |
| POST | `/me/policies/:id/analyze` | – | **Policy Reader** → `{ coverage:[{item,covered,limit,detail}], exclusions[], conditions[], waitingPeriods:[{name,months,eligibleFrom,active,status}], roomRentLimit, sumInsured, icuLimit, coPayPercent, members[], whatIsCovered, isActive, source, ai, analyzedAt }`. Built from DB policy fields + rawText and stored on the policy. |
| POST | `/me/policies` | JSON or multipart: `{ insurer, policyNumber, sumInsured, startDate, endDate?, members?: [{name, relation, dob?}], planName?, roomRentLimit?, icuLimit?, coPayPercent? }`, optional `file` = policy PDF (multipart sends `members` as a JSON string) | `201 { policy, analysis, extractedFromPdf }` (auto-analysed). Same number again from the same user is an update; a number owned by another user returns 409. |
| GET | `/me/bank` | – | `{ bank: { accountName, accountNumberMasked, ifsc, verified } \| null }` |
| POST | `/me/bank` | `{ accountName, accountNumber: "123456789012", ifsc: "HDFC0001234", bankName?, otp: "111000" }` | `{ bank }` (masked) |
| POST / DELETE | `/me/push-token` | `{ token: "ExponentPushToken[...]", platform: "ios" }` | `{ ok: true }` |
| POST | `/auth/register` | `{ name, email, password, phone?, city? }` | `{ token, user, isNewUser: true }` (email fallback) |
| POST | `/auth/login` | `{ email, password }` | `{ token, user }` |

User shape: `{ id, name, email|null, phone, role, city, dob, gender, bank|null, pushEnabled, profileComplete, createdAt }`.

## 2. Home
`GET /me/home`, computed live:
```json
{ "user": {...}, "activePolicy": {...}|null,
  "currentClaim": { "claimNumber": "CLM-1011", "status": "QUERY_RAISED", "settlement": {...}, "checklist": { "stage": "FINAL", "required": [...], "missing": [...], "flagged": [...], "verified": [...] } } | null,
  "pendingActions": [ { "kind": "QUERY|MISSING_DOC|REUPLOAD_DOC|COMPLETE_PROFILE|LINK_POLICY|ADD_BANK", "title": "...", "claimId": "...", "queryId": "...", "documentType": "..." } ],
  "counts": { "policies": 1, "claims": 1, "activeClaims": 1, "openQueries": 1, "pendingActions": 6, "unreadNotifications": 3 },
  "paidOut": 0 }
```
`GET /me/summary` is a lighter version (counts by status + 5 recent claims).

## 3. Claims
| Method | Path | Notes |
|---|---|---|
| POST | `/claims` | Body below. `201` returns the claim. Fires the Claim Agent: coverage check, then pre-auth for cashless or a document checklist. Ops also get a "New claim from the app" notification. |
| GET | `/claims` | My claims (`?status=QUERY_RAISED,DOCS_PENDING`, `?search=`) with `_count.documents`, `_count.queries` (open), `settlement` |
| GET | `/claims/:id` | `:id` = id or claim number. Full detail: documents (with `validationResult`), events, queries, settlement, activities, `checklist` |
| GET | `/claims/:id/timeline` | `{ status, events[] (oldest first), openQueries[], settlement, documents[], steps[], currentStep, latestOpsUpdate, checklistWarnings[] }`. `steps` = Created → Docs Submitted → Docs Verified → Under Review → Approved (or Rejected) → Settlement, each `{ key, label, state: done\|current\|pending\|failed, at, note }`. `latestOpsUpdate = { kind: QUERY\|OPS\|AI\|SYSTEM, message, at }` |
| GET | `/claims/:id/checklist` | `{ stage, items:[{ type, label, required, status: uploaded\|verified\|missing\|rejected, rawStatus, documentId, fileName, confidence, reason, fix }], warnings[] (e.g. "Payment receipt required"), progress:{required,verified,uploaded}, complete }` |
| GET | `/claims/:id/summary.pdf` | `application/pdf` claim summary. Also accepts `?token=<JWT>` for WebView/Linking. |
| POST | `/claims/:id/documents` | multipart `file` or any field name (pdf/jpg/jpeg/png/webp/heic, max 10 MB; §9.6) + optional `type` (`HOSPITAL_BILL`, `DISCHARGE_SUMMARY`, `PHARMACY_BILL`, `LAB_REPORT`, `PRESCRIPTION`, `CLAIM_FORM`, `PAYMENT_RECEIPT`, `HEALTH_CARD`, `PREAUTH_FORM`, `DOCTOR_ESTIMATE`, `ID_PROOF`, `OTHER`; auto-detected if omitted). Saved to Supabase storage and **validated synchronously**. `201` returns the document plus `validation: { status, appStatus, confidence, summary, fix, checks:[{ key: documentDetected\|patientNameMatched\|amountDetected\|dateValid\|requiredFieldsPresent, label, passed: true\|false\|null, detail }], issues[], warnings[], extracted }`, `checklist`, `claimStatus` |
| GET | `/claims/:id/documents` | list |
| GET | `/documents/:id/url` | `{ url }`: short-lived signed URL for `<Image>`/WebView |
| POST | `/claims/check-coverage` | same body as create, no DB write. Returns covered / warnings / clauses. |
| POST | `/claims/preview` (alias `/claims/validate`) | partial form → live amount `warnings[]` + estimate (§9.3). `POST /claims` and `GET /claims/:id` also return `warnings[]`. |
| GET | `/demo/templates` | sample prefill for Start Claim (§9.2) |
| GET | `/me/finance` | demo bank accounts / balances / expenses + medical spend & payouts (§9.4) |
| POST | `/claims/:id/preauth` | (cashless) submit pre-auth and get an estimate |
| GET | `/claims/:id/settlement` | `{ billAmount, approvedAmount, coPayAmount, deductions:[{label, amount, reason, clause}], status: PREVIEW\|ESTIMATED\|APPROVED\|PAID, utr, paidAt, isDemo: true, isEstimate, preview }`. Before ops calculate it, it returns a rules-engine estimate (`status: PREVIEW, preview: true`) instead of 404. |

Create body:
```json
{ "policyId": "…", "type": "REIMBURSEMENT",            // or "PREAUTH" / "CASHLESS" (or claimType)
  "hospital": "City Care Hospital", "hospitalCity": "Pune", "reason": "Viral fever", "treatment": "IV fluids",
  "admissionType": "EMERGENCY", "admissionDate": "2026-09-28", "dischargeDate": "2026-09-30", "days": 2,
  "billAmount": 12500, "estimatedAmount": 15000,
  "patientName": "Asha Sharma", "patientDetails": { "age": 36, "gender": "FEMALE", "relation": "Spouse" },
  "consentOtp": "111000" }                               // optional; if sent it must be 111000 and a "Customer consent verified" event is added
```

## 4. Queries
| Method | Path | Notes |
|---|---|---|
| GET | `/queries?status=OPEN` | my queries (with `claim`) |
| GET | `/claims/:id/queries` | queries on one claim |
| GET | `/queries/:id/explain` | plain-language explanation and next steps |
| POST | `/queries/:id/respond` | multipart: `response` (text), optional `file`, optional `type` (defaults to the query's requested doc type). Ops are notified. With a file, the response includes `document` (the same shape as the upload response, validated synchronously). If the requested document verifies, the query is **CLOSED** automatically; otherwise it is `ANSWERED`. |

## 5. Notifications
`GET /notifications` (alias `/notifications/my`, `?unread=true`) → `{ items: [{ id, title, body, type: INFO|SUCCESS|WARNING|ACTION_REQUIRED, read, claimId, claim:{claimNumber}, createdAt }], unread }` ·
`POST|PATCH /notifications/:id/read` · `POST /notifications/read-all`

## 6. Live updates
`GET /stream?token=<JWT>` (Server-Sent Events). Sends `event: ready` on connect, then `event: change` with `data: {"topics":["claim","document","query","activity","notification",...],"claimIds":[...],"at":"..."}` whenever something changes. Customers only receive changes on their own claims and notifications. React Native has no built-in EventSource, so either use `react-native-sse` or poll (`/me/home` and `/notifications` every 5–10 s).

## 7. AI assistant
`POST /ai/chat { message, claimId? }` → `{ answer, intent, sources[], followUps[], suggestions[], cards[], grounded:{policyNumber, claimNumber}, ai }` (finance answers and cards: §9.5). The answer is grounded in the user's own policy and claim from the DB. In mock mode it is rules-based (status, documents, rejections, queries, settlement, room rent, co-pay, waiting periods, exclusions, sub-limits, sum insured). With an LLM key set it uses the LLM with the same context.

Policy chat (older endpoint, still available): `POST /policies/:id/chat { question, claimId? }` → `{ answer, sources[], followUps[] }`

## 8. Demo document pack (fixed demo flow)

A fixed set of 7 PDFs (`claimsathi-server/demo-pack/`, also `demo-pack.zip`) for one consistent demo patient. Their text never changes. The **server** recognises each exact file and returns predetermined extraction and validation results, so the live demo is identical every time. The app only uploads; nothing special is needed on the client.

**Demo login:** phone **9999999999**, OTP **111000** → Rohan Verma (profile and bank already complete).
**Policy:** `CS-DEMO-POL-2026`, Saathi Health Insurance (Demo), sum insured ₹5,00,000, room rent ₹4,000/day, 10% co-pay, valid 01-01-2026 to 31-12-2026.
**Case:** Sunrise Multispeciality Hospital, Mumbai · acute appendicitis, laparoscopic appendectomy · admitted 24-09-2026, discharged 27-09-2026 · bill ₹84,200.

How matching works: the SHA-256 of the file bytes, or as a fallback the `CS-DEMO-DOC-0N` reference printed on each page (so renamed or re-saved copies still match). A recognised file gets **its type set by the server** (any client `type` is overridden), status `VERIFIED`, confidence `0.98`, and all checks passing. `extractedData` holds the values exactly as printed. Any other file goes through the normal checker.

| # | File | Server sets | Effect on the claim |
|---|---|---|---|
| 1 | `01_Health_Card.pdf` | `HEALTH_CARD` · member SHI-DEMO-0001-01, validity, limits | 1/7 verified, status `DOCS_PENDING` |
| 2 | `02_ID_Proof_Aadhaar.pdf` | `ID_PROOF` · masked Aadhaar XXXX XXXX 4821 | 2/7 |
| 3 | `03_Claim_Form.pdf` | `CLAIM_FORM` · ₹84,200 claimed, signed 28-09-2026 | fills hospital, admission/discharge dates, diagnosis, treatment |
| 4 | `04_Hospital_Bill.pdf` | `HOSPITAL_BILL` · 9 line items, total ₹84,200, room ₹5,000/day × 3 | fills `billAmount`, `billItems`, `roomRentPerDay`, `days` |
| 5 | `05_Discharge_Summary.pdf` | `DISCHARGE_SUMMARY` · acute appendicitis (K35.8), lap. appendectomy | confirms diagnosis and dates |
| 6 | `06_Lab_Report.pdf` | `LAB_REPORT` · WBC 14,800, CRP 48, USG inflamed appendix | 6/7 → claim **UNDER_REVIEW**, AI flags **"Payment receipt required"**, the ops bell says "raise a query", settlement estimate ready |
| – | *(ops, dashboard)* | Claim detail → Raise query, requested doc **Payment receipt** | claim `QUERY_RAISED`, customer notified |
| 7 | `07_Payment_Receipt.pdf` (as the query reply, `POST /queries/:id/respond`, or as a normal upload) | `PAYMENT_RECEIPT` · ₹84,200 by UPI, balance nil | query **CLOSED**, 7/7 verified, claim **NEEDS_HUMAN** with the AI suggestion "approve ₹62,748" |
| – | *(ops)* | Approve → Settle | `APPROVED` → `SETTLED`, settlement `PAID` with a demo UTR |

Deterministic settlement: bill ₹84,200 − non-payable items ₹1,000 − proportionate room-rent deduction ₹13,480 (room ₹5,000 vs ₹4,000 limit, so associated charges are paid at 80%) − 10% co-pay ₹6,972 = **₹62,748**.
The checklist for this claim lists all 7 documents as required. Until 07 is uploaded it shows the warning "Payment receipt required". E2E: `./scripts/e2e-demo-pack.sh` (runs through the tunnel and deletes only the test claim afterwards; the demo customer and policy are kept and re-created automatically on server start or reseed).

## 9. Starter data, sample templates, finance, amount warnings, uploads

### 9.1 Starter dataset (every customer)
On the first OTP login (`/auth/otp/verify` now also returns `starterProvisioned: true|false`) the server gives the customer the **same demo-template data**. Existing customers are backfilled at server start and via `POST /api/admin/provision-starters` (ops/admin, idempotent). The demo-pack user 9999999999 is skipped so the pack flow stays clean.
- Policy `CS-STARTER-<suffix>` (unique per user): Saathi Family Health Optima (Starter), SI ₹5,00,000, room ₹4,000/day, ICU ₹8,000/day, 10% co-pay, 01 Jan to 31 Dec 2026.
- Bank: HDFC Bank, account XXXX7788, IFSC HDFC0000123 (only if the user has no bank yet).
- Claims (all `isTemplate: true`):
  1. **Pre-auth** CASHLESS, `PREAUTH_SUBMITTED`. HeartLine Cardiac Institute, coronary angiography, estimate ₹48,000, admission today+3, 3 verified docs, estimated settlement.
  2. **Reimbursement** `UNDER_REVIEW`. Sunrise Multispeciality, dengue, bill ₹54,550 (room ₹5,000/day × 4, above the limit), estimate ₹45,000, 6 verified docs, estimated settlement. Triggers warnings.
  3. **Settled** about 150 days ago. CityLife Hospital, typhoid, bill ₹22,800, PAID with UTR.
- Timelines, activity and 4 notifications: welcome, paid, room-rent warning, pre-auth submitted.

Rows are flagged `isTemplate` (and `isDemo`, so ops can hide them with the dashboard Demo switch). They are always shown in the customer's own app views. A profile name change renames the template patient, member and bank holder.

### 9.2 Sample prefill: `GET /demo/templates`
```json
{ "policyId": "…", "policyNumber": "CS-STARTER-…",
  "preauth":       { "type": "PREAUTH", "claimType": "CASHLESS", "policyId": "…", "hospital": "HeartLine Cardiac Institute", "hospitalCity": "Mumbai", "isNetworkHospital": true, "reason": "…", "treatment": "…", "admissionType": "PLANNED", "admissionDate": "YYYY-MM-DD", "days": 2, "roomType": "Single AC", "roomRentPerDay": 4000, "estimatedAmount": 48000, "patientName": "…", "patientDetails": { "age": 35, "gender": "MALE", "relation": "Self" } },
  "reimbursement": { "type": "REIMBURSEMENT", "claimType": "REIMBURSEMENT", "hospital": "Sunrise Multispeciality Hospital", "reason": "Dengue fever", "admissionDate": "…", "dischargeDate": "…", "days": 4, "roomRentPerDay": 4500, "estimatedAmount": 40000, "billAmount": 42800, "...": "…" },
  "consentOtp": "111000", "note": "…" }
```
Dates are relative to today. For 9999999999 the reimbursement template is the demo-pack claim. The body can be sent straight to `POST /claims`.

### 9.3 Live amount warnings: `POST /claims/preview` (alias `/claims/validate`)
Partial form body. Any subset of `{ policyId?, claimId?, type|claimType, estimatedAmount, billAmount, roomRentPerDay, days, reason, treatment, admissionDate, billItems[] }`; numbers may be strings. No DB writes. Call it debounced (about 400 ms) as the user types.
```json
{ "policyId": "…", "policyNumber": "…",
  "warnings": [ { "code": "ROOM_RENT_ABOVE_LIMIT", "severity": "medium", "field": "roomRentPerDay", "message": "Room rent ₹4,500/day is above your ₹4,000/day limit, …" } ],
  "hasBlocking": false, "sumInsured": 500000, "usedSumInsured": 20070, "remainingSumInsured": 479930, "roomRentLimit": 4000, "coPayPercent": 10,
  "estimate": { "billAmount": 42800, "approvedAmount": 34000, "coPayAmount": 3800, "outOfPocket": 8800, "deductions": [ … ] } | null }
```
Codes are `ABOVE_SUM_INSURED` (high), `ABOVE_REMAINING_SUM_INSURED` (high), `ROOM_RENT_ABOVE_LIMIT` (medium), `BILL_ABOVE_ESTIMATE` (medium) and `CO_PAY` (info). Severity is `high|medium|low|info`. `field` names the form input to highlight. The used sum insured is the APPROVED/PAID settlements on the policy.
The same `warnings[]` appears on `POST /claims` (201), on `GET /claims/:id`, and on `/me/home` (`currentClaim.warnings` and a top-level `warnings[]` with `claimId`/`claimNumber`). When a created claim has a medium or high warning, the user also gets a `WARNING` notification ("Check the amounts on CLM-…").

### 9.4 Finance: `GET /me/finance`
Bank accounts, balances and monthly expenses are **fixed demo values from the server** (`isDemo: true`), the same for every user. Medical figures are computed from the user's PAID settlements.
```json
{ "isDemo": true, "accounts": [ { "id": "acc-hdfc", "bankName": "HDFC Bank", "accountType": "Savings", "maskedNumber": "XXXX4821", "ifsc": "…", "balance": 184250.75, "currency": "INR", "isPrimary": true, "linkedForPayouts": true }, … ],
  "totalBalance": 293050.85,
  "monthlyExpenses": { "month": "2026-09", "label": "September 2026", "total": 69504, "categories": [ { "category": "Rent & housing", "amount": 28000, "percent": 40.3, "icon": "house" }, … ] },
  "medical": { "totalMedicalSpend": 22800, "insurerPaid": 20070, "outOfPocket": 2730, "insurerPaidPercent": 88, "settledClaims": 1, "pendingClaims": 2, "pendingClaimAmount": 102550, "thisMonthMedicalExpense": 6820 },
  "payouts": [ { "claimId": "…", "claimNumber": "CLM-…", "hospital": "…", "amount": 20070, "billAmount": 22800, "utr": "…", "paidAt": "…", "creditedTo": "HDFC Bank XXXX4821" } ], "totalPayouts": 20070 }
```

### 9.5 Chat: finance answers, suggestions and cards
`POST /ai/chat { message, claimId? }` now always returns `suggestions[]` (up to 5 chips) and `cards[]`. Bank and money questions ("total balance", "monthly expenses", "how much did I spend on medical", "out-of-pocket vs insurer paid", "which payouts did I receive") return `intent: FINANCE_BALANCE|FINANCE_EXPENSES|FINANCE_MEDICAL|FINANCE_OUT_OF_POCKET|FINANCE_PAYOUTS|FINANCE` with cards:
- `{ type: "accounts", title, total, accounts[] }`
- `{ type: "expenses", title, total, month, categories[] }`
- `{ type: "medical", title, totalMedicalSpend, insurerPaid, outOfPocket, insurerPaidPercent }`
- `{ type: "payouts", title, total, payouts:[{ claimNumber, amount, paidAt, utr }] }`

Claim and policy answers are unchanged and still grounded in the DB. `cards` is `[]` for those answers.

### 9.6 Uploads (claim documents, query reply, policy PDF)
`POST /claims/:id/documents`, `POST /queries/:id/respond` and `POST /me/policies` (+ `POST /policies/upload`) take multipart with **any field name**. `file` is preferred, then `document`, `doc`, `attachment`, `upload`, `image`, `pdf`, `photo`. Accepted: PDF, JPG/JPEG, PNG, WEBP, HEIC/HEIF, max 10 MB. `application/octet-stream` parts are typed from the file extension.
Errors:
- `400 FILE_REQUIRED`: no file.
- `400 EMPTY_FILE`
- `413 FILE_TOO_LARGE`
- `415 UNSUPPORTED_FILE_TYPE`

All use the `{ error: { code, message } }` shape.

Native build guide (Android + iOS): see `MOBILE_APP_GUIDE.md`.

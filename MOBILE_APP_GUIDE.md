# Claim Saathi: Native Mobile App Build Guide (Android Kotlin/Compose + iOS SwiftUI)

This is the only file the mobile team needs. It covers **Android (Kotlin, Jetpack Compose)** and **iOS (SwiftUI)**, and it matches the real server (`claimsathi-server`, Express + Prisma + Supabase). Every endpoint below runs on the server today.

---

## 1. Overview

Claim Saathi is an AI health-insurance claim companion. The customer app handles onboarding, policy reading, filing claims, uploading documents, answering ops queries, tracking and settlement. An ops team works the same claims from the web dashboard, and an AI "Claim Agent" (mock mode unless an LLM key is set) validates documents, raises queries and estimates settlements. The app stays in sync with the dashboard through polling or SSE.

### Demo journey (what the app must show end-to-end)
1. **Login**: phone, then OTP (`111000`), then complete profile.
2. **Home**: active policy card, current claim, pending actions, unread alerts.
3. **Start Claim**: pick policy, hospital, reason, dates, amount, patient, consent OTP. Reimbursement or Pre-auth (cashless).
4. **Upload Bill**: camera, gallery or PDF, then `POST /claims/:id/documents`.
5. **Smart Validation**: the upload response already contains the per-check results: document detected, patient name matched, amount detected, date valid, required fields present, plus warnings.
6. **Ops query**: ops raise a query from the dashboard. The app sees it in a notification, on Home (pending action) and in Queries.
7. **Customer uploads**: the customer answers with a file through `POST /queries/:id/respond`. It is validated synchronously, and the query auto-closes if the document is verified.
8. **Approved**: ops approve. The stepper shows Approved as done, and a notification arrives.
9. **Settlement**: shows bill, deductions, co-pay, approved amount, UTR (demo, `isDemo:true`).
10. **Completed**: status SETTLED. All stepper steps are done, and a summary PDF is available.

---

## 2. Common setup (both platforms)

| Item | Value |
|---|---|
| Base URL | `https://fda-lyrics-arts-legislative.trycloudflare.com/api` (cloudflared quick tunnel to the dev Mac `:5050`). It changes when the tunnel restarts (see Troubleshooting). Keep it in build config (Android `BuildConfig.API_BASE_URL`, iOS `.xcconfig` / Info.plist `API_BASE_URL`). |
| Transport | HTTPS, so iOS ATS and Android cleartext rules need no exceptions. Android emulator only: `http://10.0.2.2:5050/api` also works if you add a debug `network_security_config`. |
| Auth | `Authorization: Bearer <JWT>` (valid for 7 days). Store it securely: Android uses EncryptedSharedPreferences or DataStore, iOS uses the Keychain. **Replace it after `PUT/PATCH /me/profile`** (the response carries a new token). |
| OTP | **Always `111000`** for login OTP, claim consent OTP and bank verification. No SMS is sent. |
| JSON | camelCase keys, dates as ISO-8601 strings with milliseconds (`2026-10-03T07:13:00.000Z`), money as integer rupees. Ignore unknown keys, because the server adds fields over time. |
| Uploads | `multipart/form-data`, with field `file` (pdf/jpg/png/webp/heic, ≤10 MB) and an optional `type` (a `DocumentType`). Validation runs before the response returns (1–3 s). |
| Live updates | Poll every **5 s** while a screen is visible (`/me/home`, `/claims/:id/timeline`, `/notifications`). Optionally listen to SSE on `GET /stream?token=<JWT>` and refetch on each `change` event. |
| PDFs / files | Open `/claims/:id/summary.pdf?token=<JWT>` in a WebView, Custom Tab or `SFSafariViewController`, or download it and share. Use `GET /documents/:id/url` for document previews (signed, short-lived). |

### Theme
| Token | Hex | Use |
|---|---|---|
| primary | `#00BAF2` | buttons, active tab, links, progress |
| navy | `#002E6E` | top bars, titles, primary text |
| background | `#F5F8FC` | screen background |
| card | `#FFFFFF` | cards |
| muted | `#6B7A90` | secondary text, pending states |
| border | `#E3EAF3` | dividers |
| success | `#12B76A` | verified, done, paid |
| warning | `#F79009` | warnings, waiting periods |
| danger | `#F04438` | rejected, failed |

Status chips: verified/done = success, uploaded/current = primary, missing/pending = muted, rejected/failed = danger. Corner radius 14, base spacing 16.

### Data model (from `prisma/schema.prisma`; both platforms mirror it)
- **Enums**: `UserRole` CUSTOMER|OPS|ADMIN · `ClaimStatus` CREATED|PREAUTH_SUBMITTED|DOCS_PENDING|UNDER_REVIEW|QUERY_RAISED|NEEDS_HUMAN|APPROVED|REJECTED|SETTLED · `ClaimType` CASHLESS|REIMBURSEMENT (create also accepts `type:"PREAUTH"` = CASHLESS) · `AdmissionType` PLANNED|EMERGENCY · `DocumentType` HEALTH_CARD|POLICY_SCHEDULE|CLAIM_FORM|PREAUTH_FORM|DOCTOR_ESTIMATE|DISCHARGE_SUMMARY|HOSPITAL_BILL|PHARMACY_BILL|LAB_REPORT|PRESCRIPTION|PAYMENT_RECEIPT|ID_PROOF|OTHER · `DocumentStatus` UPLOADED|VERIFIED|NEEDS_REVIEW|INVALID · `QueryStatus` OPEN|ANSWERED|CLOSED · `ActorType` AI|HUMAN|SYSTEM · `SettlementStatus` ESTIMATED|APPROVED|PAID (the API also returns `PREVIEW` before calculation) · `NotificationType` INFO|SUCCESS|WARNING|ACTION_REQUIRED.
- **Derived (API-only)**: app doc status `uploaded|verified|missing|rejected` (NEEDS_REVIEW and INVALID map to rejected) · step state `done|current|pending|failed` · step key `CREATED|DOCS_SUBMITTED|DOCS_VERIFIED|UNDER_REVIEW|APPROVED|SETTLEMENT`.
- **Models**: User, Policy, Claim, Document, ClaimEvent, Query, Settlement, ActivityLog, Notification, plus API shapes PolicyAnalysis, Checklist, UploadResponse, Timeline/Step, ChatReply, Home. Each platform section below has full data classes and structs.

---

## 3. Screens (13) and the endpoints each calls

| # | Screen | Endpoints |
|---|---|---|
| 1 | **Login (phone)** | `POST /auth/otp/send` |
| 2 | **OTP verify** | `POST /auth/otp/verify`. Store the token. If `needsProfile`, go to 3; otherwise go to Home |
| 3 | **Complete profile** | `PUT /me/profile` (**replace the stored token** with the returned one) |
| 4 | **Home** (tab) | `GET /me/home` (poll 5 s), `GET /notifications?unread=true` for the badge |
| 5 | **Policy + Policy Reader** | `GET /me/policies`, `POST /me/policies` (add, JSON or multipart PDF), `GET /me/policies/:id`, `POST /me/policies/:id/analyze` |
| 6 | **Start Claim** (Reimbursement / Pre-auth) | `GET /me/policies`, optional `POST /claims/check-coverage`, `POST /claims` (with `consentOtp`), cashless: `POST /claims/:id/preauth` |
| 7 | **Checklist + Upload** | `GET /claims/:id/checklist`, `POST /claims/:id/documents` (multipart) |
| 8 | **Smart Validation result** | renders `validation.checks[]`, `validation.warnings[]` and `checklist` from the upload response. Signed preview: `GET /documents/:id/url` |
| 9 | **My Claims** (tab) | `GET /claims` (`?status=` filter) |
| 10 | **Claim Tracking** (stepper) | `GET /claims/:id/timeline` (poll 5 s), `GET /claims/:id` for full detail |
| 11 | **Queries** (list + respond) | `GET /queries?status=OPEN`, `GET /claims/:id/queries`, `GET /queries/:id/explain`, `POST /queries/:id/respond` (multipart) |
| 12 | **AI Assistant** (tab) | `POST /ai/chat { message, claimId? }` |
| 13 | **Settlement + Completed** | `GET /claims/:id/settlement`, `GET /claims/:id/summary.pdf?token=<JWT>` (WebView) |
| (+) | **Alerts** (tab) | `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` |
| (+) | **Profile** (tab) | `GET /me`, `PATCH /me/profile`, `GET/POST /me/bank`, `POST/DELETE /me/push-token`, logout = clear the stored JWT |

Suggested tabs: **Home · Claims · Assistant · Alerts · Profile**. The other screens are stack screens.

---

## 4. Endpoint reference

All paths are relative to `BASE` (`…/api`). JSON unless noted. `:id` on claims accepts the id or the claim number (`CLM-1011`).

### 4.1 Onboarding / auth
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/otp/send` | `{ "phone": "9820000001" }` | `{ sent: true, phone: "+91 98200 00001", expiresInSeconds: 300, demo: true }` |
| POST | `/auth/otp/verify` | `{ "phone": "9820000001", "otp": "111000" }` | `{ token, user, isNewUser, needsProfile }` (a new phone creates a CUSTOMER) |
| GET | `/me` (or `/auth/me`) | – | `User` |
| PUT | `/me/profile` | `{ name, email, dob: "1990-05-14", gender: "male"\|"female"\|"other", city? }` | `{ user, token }`. **Replace the stored token.** `PATCH` takes partial edits. |
| POST | `/auth/register` | `{ name, email, password, phone?, city? }` | `{ token, user, isNewUser: true }` (email fallback) |
| POST | `/auth/login` | `{ email, password }` | `{ token, user }` (demo customer: `customer@claimsaathi.demo` / `demo123`) |

```json
// POST /auth/otp/verify → 200
{ "token": "eyJhbGciOi…", "isNewUser": true, "needsProfile": true,
  "user": { "id": "cm…", "name": "Customer 2345", "email": null, "phone": "+91 90000 12345", "role": "CUSTOMER", "profileComplete": false, "bank": null, "pushEnabled": false } }
```

### 4.2 Policies + Policy Reader
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/me/policies` | – | `Policy[]` |
| POST | `/me/policies` | JSON or multipart: `{ insurer, policyNumber, sumInsured, startDate, endDate?, members?: [{name, relation, dob?}], planName?, roomRentLimit?, icuLimit?, coPayPercent? }`, optional `file` = policy PDF (multipart sends `members` as a JSON string) | `201 { policy: {…, analysis}, analysis, extractedFromPdf }`. Auto-analysed. The same number again from the same user is an update; a number owned by another user returns `409`. |
| GET | `/me/policies/:id` | – | policy (with stored `analysis`) + its claims |
| POST | `/me/policies/:id/analyze` | – | `PolicyAnalysis` (also stored on the policy) |

```json
// POST /me/policies/:id/analyze → 200
{ "policyNumber": "E2E-TEST-0001", "insurer": "E2E Test Insurance (Demo)", "sumInsured": 300000, "roomRentLimit": 3000, "coPayPercent": 10, "isActive": true,
  "coverage": [ { "item": "Hospitalisation (in-patient)", "covered": true, "limit": 300000, "detail": "Up to ₹3,00,000 per policy year" },
                { "item": "Room rent", "covered": true, "limit": 3000, "detail": "Up to ₹3,000 per day" } ],
  "exclusions": [ "Cosmetic surgery", "…" ],
  "conditions": [ "Co-pay 10%: you pay 10% of every admissible claim (e.g. ₹5,000 on ₹50,000).", "Room rent above ₹3,000/day leads to a proportionate cut…", "…" ],
  "waitingPeriods": [ { "name": "Pre-existing diseases", "months": 36, "eligibleFrom": "2029-01-01T00:00:00.000Z", "active": true, "status": "Waiting until 01 Jan 2029" } ],
  "members": [ { "name": "E2E Test User", "relation": "Self" } ],
  "whatIsCovered": "Your E2E Test Insurance (Demo) policy (E2E-TEST-0001) pays hospital bills up to ₹3,00,000 a year for E2E Test User. …",
  "source": "policy-details", "ai": "mock", "analyzedAt": "2026-10-03T07:13:00.000Z" }
```

### 4.3 Bank, push, home
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/me/bank` | – | `{ bank: BankMasked \| null }` |
| POST | `/me/bank` | `{ accountName, accountNumber: "123456789012", ifsc: "HDFC0001234", bankName?, otp: "111000" }` | `{ bank }` (masked) |
| POST / DELETE | `/me/push-token` | `{ token, platform: "ios"\|"android" }` | `{ ok: true }` |
| GET | `/me/home` | – | `Home` (see below) |
| GET | `/me/summary` | – | counts by status + 5 recent claims |

```json
// GET /me/home
{ "user": {…}, "activePolicy": {…},
  "currentClaim": { "claimNumber": "CLM-1011", "status": "QUERY_RAISED", "settlement": null, "checklist": { "stage": "FINAL", "required": […], "missing": […], "flagged": […], "verified": […] } },
  "pendingActions": [ { "kind": "QUERY", "title": "Answer query on CLM-1011", "claimId": "…", "queryId": "…" } ],
  "counts": { "policies": 1, "claims": 1, "activeClaims": 1, "openQueries": 1, "pendingActions": 6, "unreadNotifications": 3 }, "paidOut": 0 }
```

### 4.4 Claims
| Method | Path | Notes |
|---|---|---|
| POST | `/claims/check-coverage` | same body as create, no DB write. Returns covered / warnings / clauses. |
| POST | `/claims` | body below. `201` returns the `Claim`. Starts the Claim Agent (coverage check, then a document checklist or pre-auth), and ops are notified. |
| GET | `/claims` | my claims (`?status=QUERY_RAISED,DOCS_PENDING`, `?search=`) with `_count`, `settlement` |
| GET | `/claims/:id` | full detail: documents (with `validationResult`), events, queries, settlement, activities, `checklist` |
| POST | `/claims/:id/preauth` | cashless: submit pre-auth and get an estimate |
| GET | `/claims/:id/checklist` | `Checklist` |
| POST | `/claims/:id/documents` | multipart `file` (pdf/jpg/png/webp/heic, ≤10 MB) + optional `type: DocumentType` (auto-detected if omitted). **Validated synchronously.** Returns `201 UploadResponse`. |
| GET | `/claims/:id/documents` | `Document[]` |
| GET | `/documents/:id/url` | `{ url }`: short-lived signed URL for `<Image>`/WebView |
| GET | `/claims/:id/timeline` | `Timeline` (events + stepper) |
| GET | `/claims/:id/settlement` | `Settlement`. `isDemo: true` always. Before ops calculate it returns a rules-engine estimate with `status: "PREVIEW", preview: true, isEstimate: true`. |
| GET | `/claims/:id/summary.pdf` | `application/pdf` claim summary (claim, policy, documents, timeline, settlement). Also accepts `?token=<JWT>` so a WebView or `Linking` can open it without headers. |

```json
// POST /claims
{ "policyId": "cm…", "type": "REIMBURSEMENT",          // or "PREAUTH" / "CASHLESS" (or claimType)
  "hospital": "City Care Hospital", "hospitalCity": "Pune", "reason": "Viral fever", "treatment": "IV fluids",
  "admissionType": "EMERGENCY", "admissionDate": "2026-09-28", "dischargeDate": "2026-09-30", "days": 2,
  "billAmount": 12500, "estimatedAmount": 15000,
  "patientName": "Asha Sharma", "patientDetails": { "age": 36, "gender": "FEMALE", "relation": "Spouse" },
  "consentOtp": "111000" }                               // optional; must be 111000 if sent
```
```json
// GET /claims/:id/checklist
{ "claimId": "cm…", "claimType": "REIMBURSEMENT", "stage": "FINAL", "complete": false,
  "progress": { "required": 6, "verified": 1, "uploaded": 1 },
  "items": [ { "type": "HOSPITAL_BILL", "label": "Hospital bill", "required": true, "status": "verified", "rawStatus": "VERIFIED", "documentId": "cm…", "fileName": "bill.pdf", "confidence": 0.93, "reason": null, "fix": null },
             { "type": "DISCHARGE_SUMMARY", "label": "Discharge summary", "required": true, "status": "missing", "rawStatus": null, "documentId": null, "fileName": null, "confidence": null, "reason": null, "fix": null },
             { "type": "PAYMENT_RECEIPT", "label": "Payment receipt", "required": false, "status": "missing", "…": "…" } ],
  "warnings": [ "Discharge summary required", "Payment receipt required" ] }
```
```json
// POST /claims/:id/documents → 201
{ "id": "cm…", "type": "HOSPITAL_BILL", "status": "VERIFIED", "fileName": "bill.pdf", "…": "…", "claimStatus": "DOCS_PENDING",
  "validation": { "status": "VERIFIED", "appStatus": "verified", "confidence": 0.93, "summary": "Hospital bill looks valid", "fix": null,
    "checks": [ { "key": "documentDetected", "label": "Document detected", "passed": true, "detail": "Looks like a hospital bill" },
                { "key": "patientNameMatched", "label": "Patient name matched", "passed": true, "detail": "Found \"E2E Test User\"" },
                { "key": "amountDetected", "label": "Amount detected", "passed": true, "detail": "₹12,500" },
                { "key": "dateValid", "label": "Date within policy period", "passed": true, "detail": "2026-09-30" },
                { "key": "requiredFieldsPresent", "label": "Required fields present", "passed": true, "detail": "All required fields found" } ],
    "issues": [], "warnings": [ "Claim form required", "Discharge summary required" ], "extracted": { "name": "E2E Test User", "amount": 12500, "date": "2026-09-30" } },
  "checklist": { "…": "same shape as GET /claims/:id/checklist" } }
```
`passed: null` means the check doesn't apply (for example, no amount on a lab report).
```json
// GET /claims/:id/timeline
{ "status": "QUERY_RAISED", "events": [ { "status": "CREATED", "title": "Claim submitted", "actor": "SYSTEM", "createdAt": "…" } ],
  "openQueries": [ … ], "settlement": null, "documents": [ … ],
  "steps": [ { "key": "CREATED", "label": "Created", "state": "done", "done": true, "at": "…", "note": null },
             { "key": "DOCS_SUBMITTED", "label": "Docs Submitted", "state": "current", "done": false, "at": null, "note": "1/6 required uploaded" },
             { "key": "DOCS_VERIFIED", "label": "Docs Verified", "state": "pending", "…": "…" },
             { "key": "UNDER_REVIEW", "label": "Under Review", "state": "pending" },
             { "key": "APPROVED", "label": "Approved", "state": "pending" },          // label "Rejected" + state "failed" if rejected
             { "key": "SETTLEMENT", "label": "Settlement", "state": "pending" } ],
  "currentStep": "DOCS_SUBMITTED",
  "latestOpsUpdate": { "kind": "QUERY", "message": "Hi, to process claim CLM-1011 please upload the payment receipt…", "at": "…" },
  "checklistWarnings": [ "Discharge summary required" ] }
```
```json
// GET /claims/:id/settlement (before approval)
{ "status": "PREVIEW", "isDemo": true, "preview": true, "isEstimate": true, "billAmount": 12500, "approvedAmount": 11250, "coPayAmount": 1250,
  "deductions": [ { "label": "Co-payment (10%)", "amount": 1250, "reason": "…", "clause": "…" } ], "utr": null, "paidAt": null }
// after ops settle
{ "status": "PAID", "isDemo": true, "preview": false, "isEstimate": false, "billAmount": 12500, "approvedAmount": 11250, "utr": "DEMOUTR011600228", "paidAt": "…", "deductions": [ … ] }
```

### 4.5 Queries
| Method | Path | Notes |
|---|---|---|
| GET | `/queries?status=OPEN` | my queries (with `claim`) |
| GET | `/claims/:id/queries` | queries on one claim |
| GET | `/queries/:id/explain` | plain-language explanation + next steps |
| POST | `/queries/:id/respond` | multipart: `response` (text), optional `file`, optional `type` (defaults to the query's requested doc type). With a file it returns the query plus `document: UploadResponse` (validated synchronously). If the requested document verifies, the query is **CLOSED**. A text-only reply sets it to `ANSWERED` and ops are notified. |

### 4.6 AI assistant
`POST /ai/chat { "message": "Which documents are still pending?", "claimId": "CLM-1011" }` (`claimId` is optional; it defaults to the latest claim). The answer is grounded in the user's own policy and claim data from the DB. In mock mode it is rules-based, covering these intents: STATUS, DOCUMENTS, DOC_REJECTED, CLAIM_REJECTED, QUERIES, SETTLEMENT, ROOM_RENT, COPAY, WAITING, EXCLUSION(S), SUBLIMIT, SUM_INSURED, POLICY_SUMMARY.
```json
{ "answer": "Claim CLM-1011 at City Care Hospital is waiting for documents: discharge summary, claim form…", "intent": "DOCUMENTS",
  "sources": ["Claim checklist"], "followUps": ["How much will I get?", "What is my room rent limit?"],
  "grounded": { "policyNumber": "E2E-TEST-0001", "claimNumber": "CLM-1011" }, "ai": "mock" }
```
Older endpoint, still available: `POST /policies/:id/chat { question, claimId? }` → `{ answer, sources[], followUps[] }`.

### 4.7 Notifications
`GET /notifications` (alias `/notifications/my`, `?unread=true`) → `{ items: Notification[], unread: number }` · `POST|PATCH /notifications/:id/read` · `POST /notifications/read-all`

### 4.8 Live updates
`GET /stream?token=<JWT>` (Server-Sent Events). It sends `event: ready` on connect, then `event: change` with `data: {"topics":["claim","document","query","activity","notification"],"claimIds":["…"],"at":"…"}`. Customers only receive their own claims and notifications. On `change`, refetch the visible screen.
Android: `okhttp-sse` (§6.6). iOS: `URLSession.bytes(from:)` line reader (§7.6). Always keep 5 s polling as the fallback.

---

## 5. Error format
Every error looks like this:
```json
{ "error": { "code": "BAD_REQUEST", "message": "Invalid OTP" } }
```
| HTTP | code | Meaning / app action |
|---|---|---|
| 400 | `BAD_REQUEST` / `VALIDATION_ERROR` | show `message` inline (wrong OTP, missing field, bad file) |
| 401 | `UNAUTHORIZED` | token missing, expired or stale: clear the stored JWT and send the user to Login |
| 403 | `FORBIDDEN` | not your resource |
| 404 | `NOT_FOUND` | claim, policy or query not found |
| 409 | `CONFLICT` | policy number belongs to another user |
| 400 | `UPLOAD_ERROR` | bad or unsupported file, or > 10 MB |
| 500 | `INTERNAL` | show a retry option |

---

## 5b. Demo document pack (fixed demo flow)

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

---

## 5c. Starter data, "Use sample data", live amount warnings, finance chat (server-driven)

Full shapes are in `MOBILE_API.md` §9. The apps keep **no hardcoded data**. Every value below comes from the server.

| Feature | Endpoint | App behaviour |
|---|---|---|
| Starter dataset | `POST /auth/otp/verify` (`starterProvisioned`) | Every new customer immediately sees a policy, bank, a pre-auth (PREAUTH_SUBMITTED), a reimbursement (UNDER_REVIEW) and a settled claim, plus alerts. Nothing to do on the client: just load `/me/home`, `/claims` and `/notifications`. |
| Use sample data | `GET /demo/templates` | The Start Claim screen has a **Use sample data** button. It fills the form from `preauth` or `reimbursement` (based on the chosen claim type), including `policyId`, patient and dates. |
| Live ⚠️ warnings | `POST /claims/preview` (alias `/claims/validate`) | Debounce about 400 ms on every amount, room-rent or days change. Show each `warnings[]` item as ⚠️ text under its `field`, coloured by `severity` (high = red, medium = amber, info = grey). Show `estimate.approvedAmount` / `outOfPocket` as "You may get ₹X". |
| Warnings after save | `POST /claims` → `warnings[]`; `GET /claims/:id` → `warnings[]`; `/me/home` → `warnings[]` | Show a warning banner on claim detail and home. The server also sends a WARNING notification. |
| Chat | `POST /ai/chat` → `answer, suggestions[], cards[]` | Chat bubbles. Show `suggestions` as tappable chips that send that text. Render `cards` by `type`: accounts (bank, masked number, balance + total), expenses (category bars), medical (insurer-paid vs out-of-pocket), payouts (claim, amount, date, UTR). |
| Finance | `GET /me/finance` | Profile → Bank shows linked demo accounts and the total balance, labelled "Demo data". |
| Uploads | claim docs, query reply, policy PDF | Use multipart field `file` (`document` also works). Send the real MIME type (`application/pdf`, `image/jpeg`, `image/png`, `image/heic`). Max 10 MB. Handle `413 FILE_TOO_LARGE` and `415 UNSUPPORTED_FILE_TYPE` and show `error.message`. |

Kotlin:
```kotlin
@Serializable data class AmountWarning(val code: String, val severity: String, val message: String, val field: String? = null)
@Serializable data class PreviewResult(val warnings: List<AmountWarning> = emptyList(), val hasBlocking: Boolean = false, val sumInsured: Int? = null,
  val remainingSumInsured: Int? = null, val roomRentLimit: Int? = null, val coPayPercent: Double? = null, val estimate: PreviewEstimate? = null)
@Serializable data class PreviewEstimate(val billAmount: Int = 0, val approvedAmount: Int = 0, val coPayAmount: Int = 0, val outOfPocket: Int = 0)
@POST("claims/preview") suspend fun preview(@Body body: JsonObject): PreviewResult
@GET("demo/templates") suspend fun templates(): JsonObject
@GET("me/finance") suspend fun finance(): Finance
```
Swift:
```swift
struct AmountWarning: Codable, Identifiable, Hashable { let code: String; let severity: String; let message: String; let field: String?; var id: String { code + (field ?? "") } }
struct ChatReply: Codable { let answer: String; let intent: String?; let suggestions: [String]?; let followUps: [String]?; let cards: [ChatCard]? }
// ChatCard: decode `type` first, then the optional fields (accounts / categories / payouts / totals)
```

## 6. ANDROID (Kotlin + Jetpack Compose)

### 6.1 Stack
| Concern | Library |
|---|---|
| UI | Jetpack Compose (Material 3), `androidx.navigation:navigation-compose` (NavHost + bottom bar) |
| Network | Retrofit 2 + OkHttp 4 + `kotlinx.serialization` (`com.jakewharton.retrofit:retrofit2-kotlinx-serialization-converter`, or Retrofit's own `converter-kotlinx-serialization`). Moshi also works. |
| Auth storage | `androidx.security:security-crypto` EncryptedSharedPreferences (or DataStore + Tink) |
| Async | Kotlin coroutines + Flow, `lifecycle-viewmodel-compose`, `collectAsStateWithLifecycle` |
| Pickers | `ActivityResultContracts.PickVisualMedia` (photos), `TakePicture` (camera via FileProvider), `OpenDocument` (`application/pdf`, `image/*`) |
| Images | Coil (`io.coil-kt:coil-compose`) for signed document URLs |
| SSE (optional) | `com.squareup.okhttp3:okhttp-sse` |
| DI (optional) | Hilt, or a simple `object ServiceLocator` |

`build.gradle.kts (app)`:
```kotlin
plugins { id("com.android.application"); kotlin("android"); kotlin("plugin.serialization"); id("org.jetbrains.kotlin.plugin.compose") }
android { defaultConfig { minSdk = 26; buildConfigField("String", "API_BASE_URL", "\"https://fda-lyrics-arts-legislative.trycloudflare.com/api/\"") }
          buildFeatures { compose = true; buildConfig = true } }
dependencies {
  implementation(platform("androidx.compose:compose-bom:2025.09.00"))
  implementation("androidx.compose.material3:material3"); implementation("androidx.activity:activity-compose:1.10.1")
  implementation("androidx.navigation:navigation-compose:2.9.0"); implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0")
  implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.0")
  implementation("com.squareup.retrofit2:retrofit:2.11.0"); implementation("com.squareup.retrofit2:converter-kotlinx-serialization:2.11.0")
  implementation("com.squareup.okhttp3:okhttp:4.12.0"); implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
  implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
  implementation("androidx.security:security-crypto:1.1.0-alpha06")
  implementation("io.coil-kt:coil-compose:2.7.0")
}
```
(The Retrofit base URL **must end with `/`**, and interface paths must have **no leading slash**.)

### 6.2 Network + auth
```kotlin
object TokenStore {
  private lateinit var prefs: SharedPreferences
  fun init(ctx: Context) {
    val key = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
    prefs = EncryptedSharedPreferences.create(ctx, "auth", key, EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
  }
  var token: String? get() = prefs.getString("jwt", null); set(v) { prefs.edit().apply { if (v == null) remove("jwt") else putString("jwt", v) }.apply() }
}
val sessionExpired = MutableSharedFlow<Unit>(extraBufferCapacity = 1)   // NavHost collects this and routes to Login

class AuthInterceptor : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    val req = chain.request().newBuilder().apply { TokenStore.token?.let { header("Authorization", "Bearer $it") } }.build()
    val res = chain.proceed(req)
    if (res.code == 401) { TokenStore.token = null; sessionExpired.tryEmit(Unit) }
    return res
  }
}
val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true; isLenient = true }
val okHttp = OkHttpClient.Builder().addInterceptor(AuthInterceptor())
  .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
  .readTimeout(90, TimeUnit.SECONDS).build()                                  // uploads wait for validation
val api: ClaimSaathiApi = Retrofit.Builder().baseUrl(BuildConfig.API_BASE_URL).client(okHttp)
  .addConverterFactory(json.asConverterFactory("application/json".toMediaType())).build().create(ClaimSaathiApi::class.java)

@Serializable data class ApiErrorBody(val error: ApiErr) { @Serializable data class ApiErr(val code: String, val message: String) }
fun HttpException.apiMessage(): String = response()?.errorBody()?.string()?.let { runCatching { json.decodeFromString<ApiErrorBody>(it).error.message }.getOrNull() } ?: message()
```

### 6.3 Models (kotlinx.serialization, mirrors Prisma)
```kotlin
@Serializable enum class UserRole { CUSTOMER, OPS, ADMIN }
@Serializable enum class ClaimStatus { CREATED, PREAUTH_SUBMITTED, DOCS_PENDING, UNDER_REVIEW, QUERY_RAISED, NEEDS_HUMAN, APPROVED, REJECTED, SETTLED }
@Serializable enum class ClaimType { CASHLESS, REIMBURSEMENT }
@Serializable enum class AdmissionType { PLANNED, EMERGENCY }
@Serializable enum class DocumentType { HEALTH_CARD, POLICY_SCHEDULE, CLAIM_FORM, PREAUTH_FORM, DOCTOR_ESTIMATE, DISCHARGE_SUMMARY, HOSPITAL_BILL, PHARMACY_BILL, LAB_REPORT, PRESCRIPTION, PAYMENT_RECEIPT, ID_PROOF, OTHER }
@Serializable enum class DocumentStatus { UPLOADED, VERIFIED, NEEDS_REVIEW, INVALID }
@Serializable enum class QueryStatus { OPEN, ANSWERED, CLOSED }
@Serializable enum class ActorType { AI, HUMAN, SYSTEM }
@Serializable enum class SettlementStatus { PREVIEW, ESTIMATED, APPROVED, PAID }
@Serializable enum class NotificationType { INFO, SUCCESS, WARNING, ACTION_REQUIRED }
@Serializable enum class AppDocStatus { @SerialName("uploaded") UPLOADED, @SerialName("verified") VERIFIED, @SerialName("missing") MISSING, @SerialName("rejected") REJECTED }
@Serializable enum class StepState { @SerialName("done") DONE, @SerialName("current") CURRENT, @SerialName("pending") PENDING, @SerialName("failed") FAILED }

@Serializable data class BankMasked(val accountName: String, val accountNumberMasked: String, val ifsc: String, val bankName: String? = null, val verified: Boolean = false)
@Serializable data class User(val id: String, val name: String, val email: String? = null, val phone: String? = null, val role: UserRole = UserRole.CUSTOMER,
  val city: String? = null, val dob: String? = null, val gender: String? = null, val bank: BankMasked? = null, val pushEnabled: Boolean = false,
  val profileComplete: Boolean = false, val createdAt: String? = null)
@Serializable data class Member(val name: String, val relation: String? = null, val dob: String? = null)
@Serializable data class WaitingPeriod(val name: String, val months: Int, val appliesTo: List<String> = emptyList())
@Serializable data class Policy(val id: String, val userId: String? = null, val insurer: String, val planName: String? = null, val policyNumber: String,
  val sumInsured: Int, val roomRentLimit: Int, val icuLimit: Int? = null, val coPayPercent: Double = 0.0, val startDate: String, val endDate: String? = null,
  val waitingPeriods: List<WaitingPeriod> = emptyList(), val subLimits: Map<String, Int>? = null, val exclusions: List<String> = emptyList(),
  val networkHospitals: List<String>? = null, val members: List<Member>? = null, val analysis: PolicyAnalysis? = null, val analyzedAt: String? = null,
  val summary: String? = null, val summaryHindi: String? = null, val fileUrl: String? = null, val createdAt: String? = null, val claims: List<Claim>? = null)
@Serializable data class PatientDetails(val age: Int? = null, val gender: String? = null, val relation: String? = null, val phone: String? = null)
@Serializable data class BillItem(val description: String, val qty: Double? = null, val rate: Double? = null, val amount: Int, val category: String? = null)
@Serializable data class AiSuggestion(val decision: String, val amount: Int? = null, val reason: String)
@Serializable data class Counts(val documents: Int = 0, val queries: Int = 0)
@Serializable data class Claim(val id: String, val claimNumber: String, val userId: String? = null, val policyId: String, val patientName: String,
  val patientDetails: PatientDetails? = null, val hospital: String, val hospitalCity: String? = null, val isNetworkHospital: Boolean = true,
  val reason: String, val treatment: String? = null, val claimType: ClaimType = ClaimType.REIMBURSEMENT, val admissionType: AdmissionType = AdmissionType.EMERGENCY,
  val isAccident: Boolean = false, val admissionDate: String? = null, val dischargeDate: String? = null, val roomType: String? = null,
  val roomRentPerDay: Int? = null, val days: Int? = null, val estimatedAmount: Int? = null, val billAmount: Int? = null, val billItems: List<BillItem>? = null,
  val status: ClaimStatus, val aiSummary: String? = null, val aiSuggestion: AiSuggestion? = null, val aiConfidence: Double? = null, val riskLevel: String? = null,
  val riskFlags: List<String>? = null, val reminderCount: Int = 0, val lastActivityAt: String? = null, val createdAt: String, val updatedAt: String? = null,
  val policy: Policy? = null, val documents: List<Document>? = null, val events: List<ClaimEvent>? = null, val queries: List<ClaimQuery>? = null,
  val settlement: Settlement? = null, @SerialName("_count") val count: Counts? = null)
@Serializable data class ExtractedData(val name: String? = null, val date: String? = null, val amount: Int? = null, val doctor: String? = null, val hasSignature: Boolean? = null)
@Serializable data class Document(val id: String, val claimId: String, val type: DocumentType, val fileName: String, val fileUrl: String, val mimeType: String? = null,
  val size: Int? = null, val status: DocumentStatus, val confidence: Double? = null, val validationResult: JsonElement? = null, val extractedData: ExtractedData? = null,
  val reviewedBy: String? = null, val reviewNote: String? = null, val createdAt: String, val updatedAt: String? = null)
@Serializable data class ClaimEvent(val id: String, val claimId: String, val status: ClaimStatus, val title: String, val description: String? = null, val actor: ActorType, val createdAt: String)
@Serializable data class ClaimRef(val id: String, val claimNumber: String, val hospital: String? = null, val status: ClaimStatus? = null)
@Serializable data class ClaimQuery(val id: String, val claimId: String, val message: String, val requestedDocType: DocumentType? = null, val response: String? = null,
  val status: QueryStatus, val createdBy: ActorType = ActorType.AI, val respondedAt: String? = null, val closedAt: String? = null, val createdAt: String,
  val claim: ClaimRef? = null, val document: UploadResponse? = null)
@Serializable data class Deduction(val label: String, val amount: Int, val reason: String? = null, val clause: String? = null)
@Serializable data class Settlement(val id: String? = null, val claimId: String? = null, val billAmount: Int, val deductions: List<Deduction> = emptyList(), val coPayAmount: Int = 0,
  val approvedAmount: Int, val explanation: String? = null, val status: SettlementStatus, val utr: String? = null, val paidAt: String? = null,
  val isDemo: Boolean = true, val isEstimate: Boolean = false, val preview: Boolean = false)
@Serializable data class ActivityLog(val id: String, val claimId: String? = null, val actor: ActorType, val actorName: String? = null, val action: String, val reason: String, val confidence: Double? = null, val createdAt: String)
@Serializable data class AppNotification(val id: String, val claimId: String? = null, val type: NotificationType, val title: String, val body: String, val read: Boolean, val createdAt: String, val claim: ClaimRef? = null)
@Serializable data class NotificationsPage(val items: List<AppNotification>, val unread: Int)

// API shapes
@Serializable data class AuthResponse(val token: String, val user: User, val isNewUser: Boolean = false, val needsProfile: Boolean = false)
@Serializable data class ProfileResponse(val user: User, val token: String)
@Serializable data class Coverage(val item: String, val covered: Boolean, val limit: Int? = null, val detail: String)
@Serializable data class WaitingStatus(val name: String, val months: Int, val eligibleFrom: String, val active: Boolean, val status: String)
@Serializable data class PolicyAnalysis(val policyId: String? = null, val policyNumber: String, val insurer: String, val planName: String? = null, val sumInsured: Int,
  val roomRentLimit: Int, val icuLimit: Int? = null, val coPayPercent: Double = 0.0, val startDate: String? = null, val endDate: String? = null, val isActive: Boolean = true,
  val members: List<Member> = emptyList(), val coverage: List<Coverage>, val exclusions: List<String>, val conditions: List<String>,
  val waitingPeriods: List<WaitingStatus>, val whatIsCovered: String, val source: String, val ai: String, val analyzedAt: String)
@Serializable data class AddPolicyResponse(val policy: Policy, val analysis: PolicyAnalysis? = null, val extractedFromPdf: Boolean = false)
@Serializable data class ChecklistItem(val type: DocumentType, val label: String, val required: Boolean, val status: AppDocStatus, val rawStatus: DocumentStatus? = null,
  val documentId: String? = null, val fileName: String? = null, val confidence: Double? = null, val reason: String? = null, val fix: String? = null)
@Serializable data class Progress(val required: Int, val verified: Int, val uploaded: Int)
@Serializable data class Checklist(val claimId: String, val claimType: ClaimType, val stage: String, val items: List<ChecklistItem>, val warnings: List<String>, val progress: Progress, val complete: Boolean)
@Serializable data class ValidationCheck(val key: String, val label: String, val passed: Boolean? = null, val detail: String)   // passed=null → not applicable
@Serializable data class Issue(val code: String? = null, val message: String)
@Serializable data class UploadValidation(val status: DocumentStatus, val appStatus: AppDocStatus, val confidence: Double, val summary: String? = null, val fix: String? = null,
  val checks: List<ValidationCheck>, val issues: List<Issue> = emptyList(), val warnings: List<String> = emptyList(), val extracted: ExtractedData? = null)
@Serializable data class UploadResponse(val id: String, val type: DocumentType, val fileName: String, val status: DocumentStatus, val validation: UploadValidation,
  val checklist: Checklist, val claimStatus: ClaimStatus)
@Serializable data class Step(val key: String, val label: String, val done: Boolean, val state: StepState, val at: String? = null, val note: String? = null)
@Serializable data class OpsUpdate(val kind: String, val message: String, val at: String)
@Serializable data class Timeline(val status: ClaimStatus, val events: List<ClaimEvent>, val openQueries: List<ClaimQuery> = emptyList(), val settlement: Settlement? = null,
  val documents: List<Document> = emptyList(), val steps: List<Step>, val currentStep: String? = null, val latestOpsUpdate: OpsUpdate? = null, val checklistWarnings: List<String> = emptyList())
@Serializable data class Grounded(val policyNumber: String? = null, val claimNumber: String? = null)
@Serializable data class ChatReply(val answer: String, val intent: String, val sources: List<String> = emptyList(), val followUps: List<String> = emptyList(), val grounded: Grounded? = null, val ai: String? = null)
@Serializable data class PendingAction(val kind: String, val title: String, val claimId: String? = null, val queryId: String? = null, val documentType: DocumentType? = null)
@Serializable data class HomeCounts(val policies: Int, val claims: Int, val activeClaims: Int, val openQueries: Int, val pendingActions: Int, val unreadNotifications: Int)
@Serializable data class Home(val user: User, val activePolicy: Policy? = null, val currentClaim: Claim? = null, val pendingActions: List<PendingAction> = emptyList(), val counts: HomeCounts, val paidOut: Int = 0)

// Request bodies
@Serializable data class PhoneBody(val phone: String)
@Serializable data class VerifyBody(val phone: String, val otp: String)
@Serializable data class ProfileBody(val name: String? = null, val email: String? = null, val dob: String? = null, val gender: String? = null, val city: String? = null)
@Serializable data class AddPolicyBody(val insurer: String, val policyNumber: String, val sumInsured: Int, val startDate: String, val endDate: String? = null,
  val planName: String? = null, val roomRentLimit: Int? = null, val icuLimit: Int? = null, val coPayPercent: Double? = null, val members: List<Member>? = null)
@Serializable data class BankBody(val accountName: String, val accountNumber: String, val ifsc: String, val bankName: String? = null, val otp: String)
@Serializable data class BankResponse(val bank: BankMasked? = null)
@Serializable data class PushBody(val token: String, val platform: String = "android")
@Serializable data class CreateClaimBody(val policyId: String, val type: String /* REIMBURSEMENT | PREAUTH */, val hospital: String, val hospitalCity: String? = null,
  val reason: String, val treatment: String? = null, val admissionType: AdmissionType = AdmissionType.EMERGENCY, val admissionDate: String? = null,
  val dischargeDate: String? = null, val days: Int? = null, val billAmount: Int? = null, val estimatedAmount: Int? = null, val patientName: String,
  val patientDetails: PatientDetails? = null, val consentOtp: String? = null)
@Serializable data class ChatBody(val message: String, val claimId: String? = null)
@Serializable data class UrlResponse(val url: String)
@Serializable data class OkResponse(val ok: Boolean = true)
```

### 6.4 Retrofit interface (exact server paths)
```kotlin
interface ClaimSaathiApi {
  @POST("auth/otp/send") suspend fun sendOtp(@Body b: PhoneBody): JsonObject
  @POST("auth/otp/verify") suspend fun verifyOtp(@Body b: VerifyBody): AuthResponse
  @GET("me") suspend fun me(): User
  @PUT("me/profile") suspend fun putProfile(@Body b: ProfileBody): ProfileResponse
  @PATCH("me/profile") suspend fun patchProfile(@Body b: ProfileBody): ProfileResponse
  @GET("me/home") suspend fun home(): Home
  @GET("me/policies") suspend fun policies(): List<Policy>
  @GET("me/policies/{id}") suspend fun policy(@Path("id") id: String): Policy
  @POST("me/policies") suspend fun addPolicy(@Body b: AddPolicyBody): AddPolicyResponse
  @Multipart @POST("me/policies") suspend fun addPolicyPdf(@PartMap fields: Map<String, @JvmSuppressWildcards RequestBody>, @Part file: MultipartBody.Part): AddPolicyResponse
  @POST("me/policies/{id}/analyze") suspend fun analyze(@Path("id") id: String): PolicyAnalysis
  @GET("me/bank") suspend fun bank(): BankResponse
  @POST("me/bank") suspend fun saveBank(@Body b: BankBody): BankResponse
  @POST("me/push-token") suspend fun pushToken(@Body b: PushBody): OkResponse
  @HTTP(method = "DELETE", path = "me/push-token", hasBody = true) suspend fun deletePushToken(@Body b: PushBody): OkResponse
  @POST("claims/check-coverage") suspend fun checkCoverage(@Body b: CreateClaimBody): JsonObject
  @POST("claims") suspend fun createClaim(@Body b: CreateClaimBody): Claim
  @GET("claims") suspend fun claims(@Query("status") status: String? = null, @Query("search") search: String? = null): List<Claim>
  @GET("claims/{id}") suspend fun claim(@Path("id") id: String): Claim
  @POST("claims/{id}/preauth") suspend fun preauth(@Path("id") id: String): JsonObject
  @GET("claims/{id}/checklist") suspend fun checklist(@Path("id") id: String): Checklist
  @Multipart @POST("claims/{id}/documents") suspend fun upload(@Path("id") id: String, @Part file: MultipartBody.Part, @Part("type") type: RequestBody?): UploadResponse
  @GET("claims/{id}/documents") suspend fun documents(@Path("id") id: String): List<Document>
  @GET("documents/{id}/url") suspend fun documentUrl(@Path("id") id: String): UrlResponse
  @GET("claims/{id}/timeline") suspend fun timeline(@Path("id") id: String): Timeline
  @GET("claims/{id}/settlement") suspend fun settlement(@Path("id") id: String): Settlement
  @GET("queries") suspend fun queries(@Query("status") status: String? = "OPEN"): List<ClaimQuery>
  @GET("claims/{id}/queries") suspend fun claimQueries(@Path("id") id: String): List<ClaimQuery>
  @GET("queries/{id}/explain") suspend fun explainQuery(@Path("id") id: String): JsonObject
  @Multipart @POST("queries/{id}/respond") suspend fun respond(@Path("id") id: String, @Part("response") response: RequestBody, @Part file: MultipartBody.Part?, @Part("type") type: RequestBody?): ClaimQuery
  @POST("ai/chat") suspend fun chat(@Body b: ChatBody): ChatReply
  @GET("notifications") suspend fun notifications(@Query("unread") unread: Boolean? = null): NotificationsPage
  @POST("notifications/{id}/read") suspend fun markRead(@Path("id") id: String): JsonObject
  @POST("notifications/read-all") suspend fun markAllRead(): JsonObject
}
// summary PDF URL (open in Custom Tab / WebView): "${BuildConfig.API_BASE_URL}claims/$id/summary.pdf?token=${TokenStore.token}"
```

### 6.5 Pickers + multipart upload
```kotlin
fun Context.uriPart(uri: Uri, field: String = "file"): MultipartBody.Part {
  val cr = contentResolver; val mime = cr.getType(uri) ?: "application/octet-stream"
  val name = cr.query(uri, null, null, null, null)?.use { c -> c.moveToFirst(); c.getString(c.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)) } ?: "upload"
  val bytes = cr.openInputStream(uri)!!.use { it.readBytes() }                      // ≤10 MB
  return MultipartBody.Part.createFormData(field, name, bytes.toRequestBody(mime.toMediaType()))
}
fun String.textPart() = toRequestBody("text/plain".toMediaType())

@Composable fun UploadButtons(onPicked: (Uri) -> Unit) {
  val ctx = LocalContext.current
  val photo = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { it?.let(onPicked) }
  val doc = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(onPicked) }
  var camUri by remember { mutableStateOf<Uri?>(null) }
  val cam = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> if (ok) camUri?.let(onPicked) }
  Row {
    Button({ val f = File(ctx.cacheDir, "cam_${System.currentTimeMillis()}.jpg"); camUri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", f); cam.launch(camUri!!) }) { Text("Camera") }
    Button({ photo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) { Text("Gallery") }
    Button({ doc.launch(arrayOf("application/pdf", "image/*")) }) { Text("PDF") }
  }
}
// in a ViewModel:
suspend fun upload(ctx: Context, claimId: String, uri: Uri, type: DocumentType?) = api.upload(claimId, ctx.uriPart(uri), type?.name?.textPart())
```
Camera needs a `<provider android:name="androidx.core.content.FileProvider" android:authorities="${applicationId}.files">` entry with `cache-path`. Add `INTERNET` and `CAMERA` permissions to the manifest.

### 6.6 Polling (5 s) + optional SSE
```kotlin
fun <T> poll(everyMs: Long = 5_000, block: suspend () -> T): Flow<Result<T>> = flow { while (currentCoroutineContext().isActive) { emit(runCatching { block() }); delay(everyMs) } }
// ViewModel
val timeline = poll { api.timeline(claimId) }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)   // stops when screen leaves
// UI: val t by vm.timeline.collectAsStateWithLifecycle()

// Optional SSE: refetch on change events
val sse = EventSources.createFactory(okHttp).newEventSource(Request.Builder().url("${BuildConfig.API_BASE_URL}stream?token=${TokenStore.token}").build(),
  object : EventSourceListener() { override fun onEvent(es: EventSource, id: String?, type: String?, data: String) { if (type == "change") refreshTrigger.tryEmit(Unit) } })
// sse.cancel() in onCleared(); keep polling as fallback
```

### 6.7 Theme
```kotlin
val Primary = Color(0xFF00BAF2); val Navy = Color(0xFF002E6E); val Bg = Color(0xFFF5F8FC); val Muted = Color(0xFF6B7A90)
val Success = Color(0xFF12B76A); val Warning = Color(0xFFF79009); val Danger = Color(0xFFF04438); val Border = Color(0xFFE3EAF3)
val AppColors = lightColorScheme(primary = Primary, onPrimary = Color.White, secondary = Navy, background = Bg, surface = Color.White, onSurface = Navy, error = Danger, outline = Border)
@Composable fun ClaimSaathiTheme(content: @Composable () -> Unit) = MaterialTheme(colorScheme = AppColors, shapes = Shapes(medium = RoundedCornerShape(14.dp)), content = content)
fun inr(n: Int?): String = n?.let { "₹" + NumberFormat.getNumberInstance(Locale("en", "IN")).format(it) } ?: "–"
```

### 6.8 Android build prompts (copy-paste, in order)

**A1. Setup**
> Create an Android app "ClaimSaathi" (Kotlin, Jetpack Compose, Material 3, minSdk 26, single Activity). Add the dependencies from MOBILE_APP_GUIDE.md §6.1 (Navigation Compose, Retrofit + kotlinx.serialization converter, OkHttp + logging + okhttp-sse, security-crypto, Coil, lifecycle-viewmodel/runtime-compose). Add `buildConfigField API_BASE_URL = "https://fda-lyrics-arts-legislative.trycloudflare.com/api/"`. Create `ui/theme/Theme.kt` with primary #00BAF2, navy #002E6E and the success/warning/danger/muted colours from §2, plus an `inr()` formatter. Create `data/TokenStore.kt` (EncryptedSharedPreferences), `data/AuthInterceptor.kt` (adds Bearer, emits `sessionExpired` on 401), and `data/Network.kt` (Json with ignoreUnknownKeys/explicitNulls=false/coerceInputValues, OkHttp with a 90 s read timeout, Retrofit). Add INTERNET and CAMERA permissions and a FileProvider. Add an `apiMessage()` helper that parses `{error:{code,message}}`.

**A2. Models + API**
> Create `data/Models.kt` with exactly the `@Serializable` enums and data classes in §6.3 (UserRole, ClaimStatus, ClaimType, AdmissionType, DocumentType, DocumentStatus, QueryStatus, ActorType, SettlementStatus incl. PREVIEW, NotificationType, AppDocStatus, StepState, plus User, Policy, Claim, Document, ClaimEvent, ClaimQuery, Settlement, AppNotification, PolicyAnalysis, Checklist, UploadResponse, Timeline, Step, ChatReply, Home and the request bodies). Create `data/ClaimSaathiApi.kt` exactly as in §6.4 (paths without a leading slash: `auth/otp/send`, `auth/otp/verify`, `me`, `me/profile`, `me/home`, `me/policies`, `me/policies/{id}`, `me/policies/{id}/analyze`, `me/bank`, `me/push-token`, `claims`, `claims/check-coverage`, `claims/{id}`, `claims/{id}/preauth`, `claims/{id}/checklist`, `claims/{id}/documents`, `documents/{id}/url`, `claims/{id}/timeline`, `claims/{id}/settlement`, `queries`, `claims/{id}/queries`, `queries/{id}/explain`, `queries/{id}/respond`, `ai/chat`, `notifications`, `notifications/{id}/read`, `notifications/read-all`). Add a `Repository` that wraps calls in `Result` and maps HttpException to `apiMessage()`.

**A3. Onboarding**
> Build Navigation Compose with an `auth` graph (Login → Otp → Profile) and a `main` graph (bottom bar: Home, Claims, Assistant, Alerts, Profile). Login: 10-digit phone field, then `api.sendOtp`. Otp: 6-digit field with the hint "Demo OTP: 111000", then `api.verifyOtp`; save `token` to TokenStore; go to Profile if `needsProfile`, otherwise Home. Profile setup: name, email, DOB (DatePicker → "yyyy-MM-dd"), gender (male/female/other), city, then `api.putProfile`; **save `response.token`**. On launch: if TokenStore has a token, call `api.me()` (on 401, go to Login). Collect `sessionExpired` in the root to pop to Login. Show `apiMessage()` errors in a snackbar or inline.

**A4. Home + Policy Reader**
> HomeScreen + HomeViewModel: `poll { api.home() }` every 5 s while visible. Show a greeting, the active policy card (insurer, policyNumber, sum insured, room rent/day, co-pay %), the current claim card (claimNumber, hospital, status chip, progress from checklist), a `pendingActions` list (QUERY → QueryDetail(queryId), MISSING_DOC/REUPLOAD_DOC → Checklist(claimId, documentType), LINK_POLICY → AddPolicy, ADD_BANK → Bank, COMPLETE_PROFILE → ProfileEdit) and a bell badge with `counts.unreadNotifications`. Policies list from `api.policies()`. AddPolicy form → `api.addPolicy(AddPolicyBody)`, or with a PDF from OpenDocument → `api.addPolicyPdf` (send `members` as a JSON-string part). PolicyReader screen: `api.analyze(id)`. Render `whatIsCovered` in a hero card, then sections for `coverage` (item + detail + ✓), `exclusions`, `conditions` and `waitingPeriods` (status chip; active = warning colour), with an "Ask assistant" button → Assistant(claimId = null).

**A5. Start Claim + Pre-auth**
> StartClaim wizard (3 steps, one ViewModel): (1) choose a policy (`api.policies()`) and the type Reimbursement/Pre-auth; (2) hospital, hospitalCity, reason, treatment, admissionType (PLANNED/EMERGENCY), admissionDate/dischargeDate (yyyy-MM-dd), days, billAmount (reimbursement) or estimatedAmount (pre-auth), and patient (name, age, gender, relation; prefill from policy.members); (3) review → optional `api.checkCoverage(body)` showing warnings → consent OTP field (hint 111000) → `api.createClaim(CreateClaimBody(type = "REIMBURSEMENT" | "PREAUTH", consentOtp = otp, ...))`. For PREAUTH, then call `api.preauth(claim.id)` and show the estimate. On success, navigate to Checklist(claim.id).

**A6. Checklist + Upload + Smart Validation**
> ChecklistScreen: `api.checklist(claimId)`. LinearProgressIndicator(`progress.verified / progress.required`), a `warnings` banner (warning colour), and rows per item: label, required badge, status chip (uploaded = primary, verified = success, missing = muted, rejected = danger) and `reason`/`fix` when rejected. Tapping a row opens a bottom sheet with the `UploadButtons` from §6.5 (Camera / Gallery / PDF). Upload via `api.upload(claimId, ctx.uriPart(uri), item.type.name.textPart())` and show a full-screen "Validating…" state (it can take a few seconds). Then navigate to ValidationResult with the `UploadResponse`: a big status (`validation.appStatus`, confidence %), the 5 `validation.checks` rows (✓ success / ✗ danger / – muted when `passed == null`) with `detail`, a `validation.warnings` list, and `fix`; buttons "Upload next" (back to the checklist using `response.checklist`) and "Track claim".

**A7. Claims + Tracking**
> ClaimsScreen: `api.claims(status)` with FilterChips All / Action needed (`"QUERY_RAISED,DOCS_PENDING"`) / Settled (`"SETTLED"`). Cards show claimNumber, hospital, a status chip, `inr(billAmount)` and the open query count from `count.queries`. ClaimTracking: `poll { api.timeline(id) }` every 5 s (optionally refetch on okhttp-sse `change` events from `stream?token=` whose `claimIds` contain this claim). Render a vertical stepper from `steps` (done = filled success circle with a check, current = primary ring with a pulse, pending = grey, failed = danger X) with `note` and the formatted `at`; a "Latest update" card from `latestOpsUpdate` (kind + message + time); an open-queries banner → Queries; documents (thumbnails via `api.documentUrl(id)` + Coil); and the events list.

**A8. Queries**
> QueriesScreen: `api.queries("OPEN")`, and per claim `api.claimQueries(claimId)`. QueryDetail: the ops `message`, a `requestedDocType` chip, and "What does this mean?" from `api.explainQuery(id)`. Respond: a text field + optional file (UploadButtons) → `api.respond(id, text.textPart(), file?.let { ctx.uriPart(it) }, requestedDocType?.name?.textPart())`. If `result.document != null`, show its `validation.checks` like the ValidationResult screen. If `result.status == CLOSED`, show "Query resolved ✓"; for text only, show "Sent to the claims team".

**A9. AI Assistant**
> AssistantScreen: a chat list (LazyColumn, reverse layout) with user and assistant bubbles. Send → `api.chat(ChatBody(message, claimId))`, where claimId comes from a dropdown of `api.claims()` (default: home.currentClaim). Render `answer`, `sources` as small AssistChips, and `followUps` as SuggestionChips that send their text. The header subtitle reads "Grounded in policy ${grounded.policyNumber} · claim ${grounded.claimNumber}". Starter chips: "Where is my claim?", "Which documents are still pending?", "What is my room rent limit?", "How much will I get?", "What is not covered?". Show a typing indicator while waiting.

**A10. Settlement + Completed + Alerts + Profile**
> SettlementScreen: `api.settlement(claimId)`. If `preview`, show an "Estimate" badge and "Final amount after approval". When `isDemo`, show a "Demo settlement" tag. Show the bill amount, the `deductions` list (label, `inr(amount)`, reason, clause), co-pay, and the approved amount (large, success), plus UTR and paidAt when `status == PAID`. When the claim is SETTLED, show the Completed screen (check animation, amount, UTR) with "Download summary" opening `${API_BASE_URL}claims/$id/summary.pdf?token=$jwt` in a Custom Tab. AlertsScreen: `poll { api.notifications() }`; rows by `type` icon; tap → `api.markRead(id)` then open the claim; "Mark all read" → `api.markAllRead()`; unread badge on the tab. ProfileScreen: `api.me()`, edit → `api.patchProfile` (save the new token); Bank: `api.bank()`, add via `api.saveBank(BankBody(..., otp = "111000"))` (shown masked); register FCM token → `api.pushToken(PushBody(token, "android"))`; Logout → `api.deletePushToken`, clear TokenStore, go to Login.

---

## 7. iOS (SwiftUI)

### 7.1 Stack
| Concern | Choice |
|---|---|
| UI | SwiftUI (iOS 17+), `TabView` + one `NavigationStack` per tab (`navigationDestination(for:)`) |
| State | `@Observable` view models (Observation), `@MainActor` |
| Network | `URLSession` async/await, `JSONDecoder` / `JSONEncoder` with Codable |
| Auth storage | Keychain (`SecItemAdd`/`SecItemCopyMatching`, small wrapper below) |
| Pickers | `PhotosPicker` (PhotosUI) for images, `.fileImporter(allowedContentTypes: [.pdf, .image])` for PDFs, optional camera via `UIImagePickerController` wrapper |
| Polling | `.task { while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(5)) } }`, which is cancelled automatically when the view disappears |
| PDFs | `SFSafariViewController` / `Link` / `QuickLook` for `summary.pdf?token=` |
| ATS | Base URL is **https**, so no ATS exceptions are needed. Add `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription`. |

Config: `Config.xcconfig` → `API_BASE_URL = https:/$()/productions-orbit-porter-investigated.trycloudflare.com/api` (the `$()` escapes `//`), and Info.plist `API_BASE_URL = $(API_BASE_URL)`.

### 7.2 Keychain + API client
```swift
enum TokenStore {
  private static let account = "jwt", service = "com.claimsaathi.auth"
  static var token: String? {
    get { var out: AnyObject?; let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true]
          return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? (out as? Data).flatMap { String(data: $0, encoding: .utf8) } : nil }
    set { let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
          SecItemDelete(q as CFDictionary)
          if let v = newValue { var add = q; add[kSecValueData as String] = Data(v.utf8); add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock; SecItemAdd(add as CFDictionary, nil) } }
  }
}
struct APIErrorBody: Decodable { struct E: Decodable { let code: String; let message: String }; let error: E }
enum APIError: LocalizedError { case http(Int, String, String), unauthorized
  var errorDescription: String? { switch self { case .http(_, _, let m): m; case .unauthorized: "Session expired. Please log in again." } } }

@MainActor final class API {
  static let shared = API()
  let base = URL(string: Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as! String)!   // …/api
  var onUnauthorized: () -> Void = {}
  private let session: URLSession = { let c = URLSessionConfiguration.default; c.timeoutIntervalForRequest = 90; return URLSession(configuration: c) }()
  let decoder = JSONDecoder(); let encoder = JSONEncoder()

  func request<T: Decodable>(_ path: String, method: String = "GET", query: [String: String?] = [:], json: Encodable? = nil, body: Data? = nil, contentType: String? = nil) async throws -> T {
    var comps = URLComponents(url: base.appending(path: path), resolvingAgainstBaseURL: false)!
    let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }; if !items.isEmpty { comps.queryItems = items }
    var req = URLRequest(url: comps.url!); req.httpMethod = method
    if let t = TokenStore.token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
    if let json { req.httpBody = try encoder.encode(json); req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    if let body { req.httpBody = body; req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
    let (data, resp) = try await session.data(for: req)
    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
    if code == 401 { TokenStore.token = nil; onUnauthorized(); throw APIError.unauthorized }
    guard (200..<300).contains(code) else {
      let e = try? decoder.decode(APIErrorBody.self, from: data)
      throw APIError.http(code, e?.error.code ?? "HTTP_\(code)", e?.error.message ?? "Request failed (\(code))")
    }
    return try decoder.decode(T.self, from: data)
  }
  func summaryPdfURL(_ claimId: String) -> URL { var c = URLComponents(url: base.appending(path: "claims/\(claimId)/summary.pdf"), resolvingAgainstBaseURL: false)!; c.queryItems = [.init(name: "token", value: TokenStore.token)]; return c.url! }
}
```

### 7.3 Multipart helper
```swift
struct Multipart {
  let boundary = "cs-\(UUID().uuidString)"; private(set) var data = Data()
  var contentType: String { "multipart/form-data; boundary=\(boundary)" }
  mutating func field(_ name: String, _ value: String) { data.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!) }
  mutating func file(_ name: String = "file", filename: String, mime: String, bytes: Data) {
    data.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\nContent-Type: \(mime)\r\n\r\n".data(using: .utf8)!); data.append(bytes); data.append("\r\n".data(using: .utf8)!) }
  func finalized() -> Data { var d = data; d.append("--\(boundary)--\r\n".data(using: .utf8)!); return d }
}
// Upload a document (validated synchronously → UploadResponse)
func upload(claimId: String, bytes: Data, filename: String, mime: String, type: DocumentType?) async throws -> UploadResponse {
  var m = Multipart(); m.file(filename: filename, mime: mime, bytes: bytes); if let type { m.field("type", type.rawValue) }
  return try await API.shared.request("claims/\(claimId)/documents", method: "POST", body: m.finalized(), contentType: m.contentType)
}
// PhotosPicker → Data:  let data = try await item.loadTransferable(type: Data.self)  (mime "image/jpeg", name "photo.jpg"; convert HEIC with UIImage(data:)?.jpegData(compressionQuality: 0.85))
// fileImporter → URL:   guard url.startAccessingSecurityScopedResource() else { return }; defer { url.stopAccessingSecurityScopedResource() }; let data = try Data(contentsOf: url)  (mime "application/pdf")
```

### 7.4 Models (Codable, mirrors Prisma)
```swift
enum UserRole: String, Codable { case CUSTOMER, OPS, ADMIN }
enum ClaimStatus: String, Codable, CaseIterable { case CREATED, PREAUTH_SUBMITTED, DOCS_PENDING, UNDER_REVIEW, QUERY_RAISED, NEEDS_HUMAN, APPROVED, REJECTED, SETTLED }
enum ClaimType: String, Codable { case CASHLESS, REIMBURSEMENT }
enum AdmissionType: String, Codable { case PLANNED, EMERGENCY }
enum DocumentType: String, Codable, CaseIterable { case HEALTH_CARD, POLICY_SCHEDULE, CLAIM_FORM, PREAUTH_FORM, DOCTOR_ESTIMATE, DISCHARGE_SUMMARY, HOSPITAL_BILL, PHARMACY_BILL, LAB_REPORT, PRESCRIPTION, PAYMENT_RECEIPT, ID_PROOF, OTHER }
enum DocumentStatus: String, Codable { case UPLOADED, VERIFIED, NEEDS_REVIEW, INVALID }
enum QueryStatus: String, Codable { case OPEN, ANSWERED, CLOSED }
enum ActorType: String, Codable { case AI, HUMAN, SYSTEM }
enum SettlementStatus: String, Codable { case PREVIEW, ESTIMATED, APPROVED, PAID }
enum NotificationType: String, Codable { case INFO, SUCCESS, WARNING, ACTION_REQUIRED }
enum AppDocStatus: String, Codable { case uploaded, verified, missing, rejected }
enum StepState: String, Codable { case done, current, pending, failed }

struct BankMasked: Codable, Hashable { let accountName: String; let accountNumberMasked: String; let ifsc: String; var bankName: String?; let verified: Bool }
struct User: Codable, Identifiable, Hashable { let id: String; let name: String; var email: String?; var phone: String?; let role: UserRole
  var city: String?; var dob: String?; var gender: String?; var bank: BankMasked?; var pushEnabled: Bool?; var profileComplete: Bool?; var createdAt: String? }
struct Member: Codable, Hashable { let name: String; var relation: String?; var dob: String? }
struct WaitingPeriod: Codable, Hashable { let name: String; let months: Int; var appliesTo: [String]? }
struct Policy: Codable, Identifiable, Hashable { let id: String; var userId: String?; let insurer: String; var planName: String?; let policyNumber: String
  let sumInsured: Int; let roomRentLimit: Int; var icuLimit: Int?; let coPayPercent: Double; let startDate: String; var endDate: String?
  var waitingPeriods: [WaitingPeriod]?; var subLimits: [String: Int]?; var exclusions: [String]?; var networkHospitals: [String]?; var members: [Member]?
  var analysis: PolicyAnalysis?; var analyzedAt: String?; var summary: String?; var summaryHindi: String?; var fileUrl: String?; var createdAt: String?; var claims: [Claim]? }
struct PatientDetails: Codable, Hashable { var age: Int?; var gender: String?; var relation: String?; var phone: String? }
struct BillItem: Codable, Hashable { let description: String; var qty: Double?; var rate: Double?; let amount: Int; var category: String? }
struct AiSuggestion: Codable, Hashable { let decision: String; var amount: Int?; let reason: String }
struct Counts: Codable, Hashable { var documents: Int?; var queries: Int? }
struct Claim: Codable, Identifiable, Hashable { let id: String; let claimNumber: String; var userId: String?; let policyId: String; let patientName: String
  var patientDetails: PatientDetails?; let hospital: String; var hospitalCity: String?; var isNetworkHospital: Bool?; let reason: String; var treatment: String?
  let claimType: ClaimType; var admissionType: AdmissionType?; var isAccident: Bool?; var admissionDate: String?; var dischargeDate: String?; var roomType: String?
  var roomRentPerDay: Int?; var days: Int?; var estimatedAmount: Int?; var billAmount: Int?; var billItems: [BillItem]?; let status: ClaimStatus
  var aiSummary: String?; var aiSuggestion: AiSuggestion?; var aiConfidence: Double?; var riskLevel: String?; var riskFlags: [String]?; var reminderCount: Int?
  var lastActivityAt: String?; let createdAt: String; var updatedAt: String?; var policy: Policy?; var documents: [Document]?; var events: [ClaimEvent]?
  var queries: [Query]?; var settlement: Settlement?; var _count: Counts? }
struct ExtractedData: Codable, Hashable { var name: String?; var date: String?; var amount: Int?; var doctor: String?; var hasSignature: Bool? }
struct Document: Codable, Identifiable, Hashable { let id: String; let claimId: String; let type: DocumentType; let fileName: String; let fileUrl: String
  var mimeType: String?; var size: Int?; let status: DocumentStatus; var confidence: Double?; var extractedData: ExtractedData?   // validationResult: decode on demand if needed
  var reviewedBy: String?; var reviewNote: String?; let createdAt: String; var updatedAt: String? }
struct ClaimEvent: Codable, Identifiable, Hashable { let id: String; let claimId: String; let status: ClaimStatus; let title: String; var description: String?; let actor: ActorType; let createdAt: String }
struct ClaimRef: Codable, Hashable { let id: String; let claimNumber: String; var hospital: String?; var status: ClaimStatus? }
struct Query: Codable, Identifiable, Hashable { let id: String; let claimId: String; let message: String; var requestedDocType: DocumentType?; var response: String?
  let status: QueryStatus; var createdBy: ActorType?; var respondedAt: String?; var closedAt: String?; let createdAt: String; var claim: ClaimRef?; var document: UploadResponse? }
struct Deduction: Codable, Hashable { let label: String; let amount: Int; var reason: String?; var clause: String? }
struct Settlement: Codable, Hashable { var id: String?; var claimId: String?; let billAmount: Int; var deductions: [Deduction]; var coPayAmount: Int?; let approvedAmount: Int
  var explanation: String?; let status: SettlementStatus; var utr: String?; var paidAt: String?; var isDemo: Bool?; var isEstimate: Bool?; var preview: Bool? }
struct ActivityLog: Codable, Identifiable, Hashable { let id: String; var claimId: String?; let actor: ActorType; var actorName: String?; let action: String; let reason: String; var confidence: Double?; let createdAt: String }
struct AppNotification: Codable, Identifiable, Hashable { let id: String; var claimId: String?; let type: NotificationType; let title: String; let body: String; var read: Bool; let createdAt: String; var claim: ClaimRef? }
struct NotificationsPage: Codable { let items: [AppNotification]; let unread: Int }

// API shapes
struct AuthResponse: Codable { let token: String; let user: User; var isNewUser: Bool?; var needsProfile: Bool? }
struct ProfileResponse: Codable { let user: User; let token: String }
struct Coverage: Codable, Hashable { let item: String; let covered: Bool; var limit: Int?; let detail: String }
struct WaitingStatus: Codable, Hashable { let name: String; let months: Int; let eligibleFrom: String; let active: Bool; let status: String }
struct PolicyAnalysis: Codable, Hashable { var policyId: String?; let policyNumber: String; let insurer: String; var planName: String?; let sumInsured: Int; let roomRentLimit: Int
  var icuLimit: Int?; var coPayPercent: Double?; var startDate: String?; var endDate: String?; var isActive: Bool?; var members: [Member]?
  let coverage: [Coverage]; let exclusions: [String]; let conditions: [String]; let waitingPeriods: [WaitingStatus]; let whatIsCovered: String; let source: String; let ai: String; let analyzedAt: String }
struct AddPolicyResponse: Codable { let policy: Policy; var analysis: PolicyAnalysis?; var extractedFromPdf: Bool? }
struct ChecklistItem: Codable, Hashable, Identifiable { var id: String { type.rawValue }; let type: DocumentType; let label: String; let required: Bool; let status: AppDocStatus
  var rawStatus: DocumentStatus?; var documentId: String?; var fileName: String?; var confidence: Double?; var reason: String?; var fix: String? }
struct DocProgress: Codable, Hashable { let required: Int; let verified: Int; let uploaded: Int }
struct Checklist: Codable, Hashable { let claimId: String; let claimType: ClaimType; let stage: String; let items: [ChecklistItem]; let warnings: [String]; let progress: DocProgress; let complete: Bool }
struct ValidationCheck: Codable, Hashable, Identifiable { var id: String { key }; let key: String; let label: String; let passed: Bool?; let detail: String }  // passed == nil → n/a
struct Issue: Codable, Hashable { var code: String?; let message: String }
struct UploadValidation: Codable, Hashable { let status: DocumentStatus; let appStatus: AppDocStatus; let confidence: Double; var summary: String?; var fix: String?
  let checks: [ValidationCheck]; var issues: [Issue]?; var warnings: [String]?; var extracted: ExtractedData? }
struct UploadResponse: Codable, Hashable { let id: String; let type: DocumentType; let fileName: String; let status: DocumentStatus; let validation: UploadValidation; let checklist: Checklist; let claimStatus: ClaimStatus }
struct Step: Codable, Hashable, Identifiable { var id: String { key }; let key: String; let label: String; let done: Bool; let state: StepState; var at: String?; var note: String? }
struct OpsUpdate: Codable, Hashable { let kind: String; let message: String; let at: String }
struct Timeline: Codable { let status: ClaimStatus; let events: [ClaimEvent]; var openQueries: [Query]?; var settlement: Settlement?; var documents: [Document]?
  let steps: [Step]; var currentStep: String?; var latestOpsUpdate: OpsUpdate?; var checklistWarnings: [String]? }
struct Grounded: Codable, Hashable { var policyNumber: String?; var claimNumber: String? }
struct ChatReply: Codable, Hashable { let answer: String; let intent: String; var sources: [String]?; var followUps: [String]?; var grounded: Grounded?; var ai: String? }
struct PendingAction: Codable, Hashable { let kind: String; let title: String; var claimId: String?; var queryId: String?; var documentType: DocumentType? }
struct HomeCounts: Codable, Hashable { let policies: Int; let claims: Int; let activeClaims: Int; let openQueries: Int; let pendingActions: Int; let unreadNotifications: Int }
struct Home: Codable { let user: User; var activePolicy: Policy?; var currentClaim: Claim?; var pendingActions: [PendingAction]; let counts: HomeCounts; var paidOut: Int? }
struct SignedURL: Codable { let url: String }
struct OtpSent: Codable { let sent: Bool; var phone: String?; var expiresInSeconds: Int?; var demo: Bool? }
struct BankResponse: Codable { var bank: BankMasked? }

// Request bodies
struct PhoneBody: Encodable { let phone: String }
struct VerifyBody: Encodable { let phone: String; let otp: String }
struct ProfileBody: Encodable { var name: String?; var email: String?; var dob: String?; var gender: String?; var city: String? }
struct AddPolicyBody: Encodable { let insurer: String; let policyNumber: String; let sumInsured: Int; let startDate: String; var endDate: String?; var planName: String?
  var roomRentLimit: Int?; var icuLimit: Int?; var coPayPercent: Double?; var members: [Member]? }
struct BankBody: Encodable { let accountName: String; let accountNumber: String; let ifsc: String; var bankName: String?; let otp: String }
struct PushBody: Encodable { let token: String; var platform = "ios" }
struct CreateClaimBody: Encodable { let policyId: String; let type: String /* "REIMBURSEMENT" | "PREAUTH" */; let hospital: String; var hospitalCity: String?; let reason: String
  var treatment: String?; var admissionType: AdmissionType = .EMERGENCY; var admissionDate: String?; var dischargeDate: String?; var days: Int?; var billAmount: Int?
  var estimatedAmount: Int?; let patientName: String; var patientDetails: PatientDetails?; var consentOtp: String? }
struct ChatBody: Encodable { let message: String; var claimId: String? }
```
> Tip: to survive future enum values, give each enum an `unknown` case with a custom `init(from:)`, or decode statuses as `String` and map them. Unknown keys are already ignored by `JSONDecoder`.

### 7.5 Endpoint wrappers (exact server paths)
```swift
extension API {
  func sendOtp(_ phone: String) async throws -> OtpSent { try await request("auth/otp/send", method: "POST", json: PhoneBody(phone: phone)) }
  func verifyOtp(_ phone: String, _ otp: String) async throws -> AuthResponse { try await request("auth/otp/verify", method: "POST", json: VerifyBody(phone: phone, otp: otp)) }
  func me() async throws -> User { try await request("me") }
  func putProfile(_ b: ProfileBody) async throws -> ProfileResponse { try await request("me/profile", method: "PUT", json: b) }
  func patchProfile(_ b: ProfileBody) async throws -> ProfileResponse { try await request("me/profile", method: "PATCH", json: b) }
  func home() async throws -> Home { try await request("me/home") }
  func policies() async throws -> [Policy] { try await request("me/policies") }
  func policy(_ id: String) async throws -> Policy { try await request("me/policies/\(id)") }
  func addPolicy(_ b: AddPolicyBody) async throws -> AddPolicyResponse { try await request("me/policies", method: "POST", json: b) }
  func analyze(_ id: String) async throws -> PolicyAnalysis { try await request("me/policies/\(id)/analyze", method: "POST") }
  func bank() async throws -> BankResponse { try await request("me/bank") }
  func saveBank(_ b: BankBody) async throws -> BankResponse { try await request("me/bank", method: "POST", json: b) }
  func createClaim(_ b: CreateClaimBody) async throws -> Claim { try await request("claims", method: "POST", json: b) }
  func claims(status: String? = nil) async throws -> [Claim] { try await request("claims", query: ["status": status]) }
  func claim(_ id: String) async throws -> Claim { try await request("claims/\(id)") }
  func checklist(_ id: String) async throws -> Checklist { try await request("claims/\(id)/checklist") }
  func timeline(_ id: String) async throws -> Timeline { try await request("claims/\(id)/timeline") }
  func settlement(_ id: String) async throws -> Settlement { try await request("claims/\(id)/settlement") }
  func documentURL(_ id: String) async throws -> SignedURL { try await request("documents/\(id)/url") }
  func queries(status: String? = "OPEN") async throws -> [Query] { try await request("queries", query: ["status": status]) }
  func claimQueries(_ id: String) async throws -> [Query] { try await request("claims/\(id)/queries") }
  func chat(_ message: String, claimId: String?) async throws -> ChatReply { try await request("ai/chat", method: "POST", json: ChatBody(message: message, claimId: claimId)) }
  func notifications(unread: Bool? = nil) async throws -> NotificationsPage { try await request("notifications", query: ["unread": unread.map { String($0) }]) }
  // + claims/check-coverage, claims/{id}/preauth, queries/{id}/explain, queries/{id}/respond (multipart), notifications/{id}/read, notifications/read-all, me/push-token
}
```
(For the loosely-typed responses (`check-coverage`, `preauth`, `explain`), define small structs with the fields you display; unknown keys are ignored.)

### 7.6 Polling + theme
```swift
struct ClaimTrackingView: View {
  let claimId: String; @State private var t: Timeline?; @State private var error: String?
  var body: some View {
    List { /* stepper from t?.steps … */ }
      .task { while !Task.isCancelled { do { t = try await API.shared.timeline(claimId); error = nil } catch { self.error = error.localizedDescription }
                                        try? await Task.sleep(for: .seconds(5)) } }   // cancelled automatically when the view disappears
  }
}
extension Color { static let csPrimary = Color(hex: 0x00BAF2), csNavy = Color(hex: 0x002E6E), csBg = Color(hex: 0xF5F8FC), csMuted = Color(hex: 0x6B7A90),
  csSuccess = Color(hex: 0x12B76A), csWarning = Color(hex: 0xF79009), csDanger = Color(hex: 0xF04438), csBorder = Color(hex: 0xE3EAF3)
  init(hex: UInt) { self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255) } }
func inr(_ n: Int?) -> String { guard let n else { return "–" }; let f = NumberFormatter(); f.numberStyle = .decimal; f.locale = Locale(identifier: "en_IN"); return "₹" + (f.string(from: n as NSNumber) ?? "\(n)") }
// App root: .tint(.csPrimary); navigation titles in .csNavy; cards: RoundedRectangle(cornerRadius: 14).fill(.white)
```
Optional SSE: open `URLSession.shared.bytes(from: stream?token=…)`, iterate `lines`, and refetch when a line starts with `event: change`. Keep 5 s polling as the fallback.

### 7.7 iOS build prompts (copy-paste, in order)

**I1. Setup**
> Create a SwiftUI iOS 17 app "ClaimSaathi" (no third-party dependencies). Add `Config.xcconfig` with `API_BASE_URL = https:/$()/productions-orbit-porter-investigated.trycloudflare.com/api` and expose it in Info.plist as `API_BASE_URL`; add NSCameraUsageDescription and NSPhotoLibraryUsageDescription. Create `Theme.swift` (Color.csPrimary #00BAF2, csNavy #002E6E, csSuccess/csWarning/csDanger/csMuted/csBg/csBorder, and `inr()` with the en_IN locale), `TokenStore.swift` (Keychain generic password), and `API.swift` exactly as in MOBILE_APP_GUIDE.md §7.2: a URLSession async/await `request<T>` that adds the Bearer token, encodes JSON, has a 90 s timeout, decodes `{error:{code,message}}` into `APIError`, and on 401 clears the Keychain and calls `onUnauthorized`. Add `Multipart.swift` from §7.3. The base URL is https, so no ATS exceptions are needed.

**I2. Models + endpoints**
> Create `Models.swift` with exactly the Codable enums and structs from §7.4 (UserRole, ClaimStatus, ClaimType, AdmissionType, DocumentType, DocumentStatus, QueryStatus, ActorType, SettlementStatus incl. PREVIEW, NotificationType, AppDocStatus, StepState; User, Policy, Claim, Document, ClaimEvent, Query, Settlement, AppNotification, PolicyAnalysis, Checklist, UploadResponse, Timeline, Step, ChatReply, Home and the request bodies). Create `API+Endpoints.swift` with one async function per endpoint using these exact paths: `auth/otp/send`, `auth/otp/verify`, `me`, `me/profile` (PUT/PATCH), `me/home`, `me/policies`, `me/policies/{id}`, `me/policies/{id}/analyze`, `me/bank`, `me/push-token` (POST/DELETE), `claims`, `claims/check-coverage`, `claims/{id}`, `claims/{id}/preauth`, `claims/{id}/checklist`, `claims/{id}/documents` (multipart), `documents/{id}/url`, `claims/{id}/timeline`, `claims/{id}/settlement`, `claims/{id}/summary.pdf?token=`, `queries`, `claims/{id}/queries`, `queries/{id}/explain`, `queries/{id}/respond` (multipart), `ai/chat`, `notifications`, `notifications/{id}/read`, `notifications/read-all`. Give each enum an `unknown` fallback.

**I3. Onboarding**
> Build an `@Observable AppState` (user, isAuthed) that sets `API.shared.onUnauthorized` to log out. Root: if there is no token, show the Login flow; else call `me()` and show MainTabs (on 401, back to Login). LoginView: phone field (10 digits, number pad) → `sendOtp`. OtpView: a 6-digit field with the hint "Demo OTP: 111000" → `verifyOtp`; save `token` to TokenStore; if `needsProfile`, push ProfileSetupView, otherwise MainTabs. ProfileSetupView: name, email, DOB DatePicker (format yyyy-MM-dd), gender Picker (male/female/other), city → `putProfile`; **save `response.token` to the Keychain**. Show `error.localizedDescription` inline.

**I4. Home + Policy Reader**
> MainTabs: a TabView (Home, Claims, Assistant, Alerts, Profile), each tab with its own NavigationStack using `navigationDestination(for: Route.self)`. HomeView polls `home()` every 5 s via `.task { while !Task.isCancelled { … } }`. Show a greeting, the active policy card (insurer, number, sum insured, room rent/day, co-pay), the current claim card (status chip, progress), `pendingActions` rows routing by kind (QUERY → QueryDetail, MISSING_DOC/REUPLOAD_DOC → Checklist with the type, LINK_POLICY → AddPolicy, ADD_BANK → Bank, COMPLETE_PROFILE → ProfileEdit) and a bell with an `unreadNotifications` badge. PoliciesView → `policies()`. AddPolicyView form → `addPolicy` (JSON), or with a PDF from `.fileImporter([.pdf])` as multipart (`members` as a JSON-string field). PolicyReaderView: `analyze(id)`, showing `whatIsCovered` in a hero card, then Sections for `coverage`, `exclusions`, `conditions` and `waitingPeriods` (status chip; active = warning), plus an "Ask assistant" button.

**I5. Start Claim + Pre-auth**
> StartClaimView: a 3-step flow with one @Observable model. (1) policy Picker from `policies()` and a segmented Reimbursement / Pre-auth; (2) hospital, city, reason, treatment, admissionType, admission/discharge DatePickers (yyyy-MM-dd), days, billAmount (reimbursement) or estimatedAmount (pre-auth), and patient (name, age, gender, relation; prefill from policy.members); (3) review → optional `claims/check-coverage` warnings → consent OTP field (hint 111000) → `createClaim(CreateClaimBody(type: "REIMBURSEMENT" | "PREAUTH", consentOtp: otp, …))`. For PREAUTH, then POST `claims/{id}/preauth` and show the estimate. On success, push ChecklistView(claimId).

**I6. Checklist + Upload + Smart Validation**
> ChecklistView: `checklist(id)`. ProgressView(value: verified, total: required), a `warnings` banner (csWarning), and rows (label, required tag, status chip: uploaded = primary, verified = success, missing = muted, rejected = danger; show `reason`/`fix`). Tapping a row opens a confirmationDialog: Camera / Photos (`PhotosPicker`, `loadTransferable(type: Data.self)`, JPEG) / PDF (`.fileImporter([.pdf, .image])` with security-scoped access). Upload with the `upload(claimId:bytes:filename:mime:type:)` helper from §7.3 and show a "Validating…" overlay. Then push ValidationResultView(UploadResponse): a big status (`validation.appStatus`, confidence %), the 5 `validation.checks` (checkmark.circle.fill success / xmark.circle.fill danger / minus.circle muted when `passed == nil`) with `detail`, `validation.warnings` and `fix`; buttons "Upload next" (refresh using `response.checklist`) and "Track claim".

**I7. Claims + Tracking**
> ClaimsView: `claims(status:)` with a segmented filter All / Action needed (`"QUERY_RAISED,DOCS_PENDING"`) / Settled (`"SETTLED"`). Rows show claimNumber, hospital, a status chip, `inr(billAmount)` and the open query count from `_count.queries`. ClaimTrackingView: polls `timeline(id)` every 5 s (§7.6). A vertical stepper from `steps` (done = filled csSuccess check, current = csPrimary ring with `.symbolEffect(.pulse)`, pending = grey, failed = csDanger X) with `note` and the formatted `at`; a "Latest update" card from `latestOpsUpdate`; an open-queries banner → Queries; document thumbnails via `documentURL(id)` + AsyncImage; and the events list. Add a toolbar button "Summary PDF" → open `API.shared.summaryPdfURL(id)` in SFSafariViewController.

**I8. Queries**
> QueriesView: `queries(status: "OPEN")` (and per claim `claimQueries(id)`). QueryDetailView: the ops `message`, a `requestedDocType` chip, and "What does this mean?" from GET `queries/{id}/explain`. Respond: a TextEditor + optional file (PhotosPicker / fileImporter) → multipart POST `queries/{id}/respond` with fields `response`, `file`, `type` (= requestedDocType), decoded as `Query`. If `document != nil`, render its `validation.checks` like ValidationResultView. If `status == .CLOSED`, show "Query resolved ✓"; for text only, show "Sent to the claims team".

**I9. AI Assistant**
> AssistantView: a chat with a ScrollViewReader and user/assistant bubbles. Send → `chat(message, claimId:)`, where claimId comes from a Menu of `claims()` (default home.currentClaim). Render `answer`, `sources` as small capsules, and `followUps` as tappable capsules that send their text. The navigation subtitle reads "Grounded in policy \(grounded.policyNumber) · claim \(grounded.claimNumber)". Starter chips: "Where is my claim?", "Which documents are still pending?", "What is my room rent limit?", "How much will I get?", "What is not covered?". Show a typing indicator while awaiting.

**I10. Settlement + Completed + Alerts + Profile**
> SettlementView: `settlement(id)`. If `preview == true`, show an "Estimate" badge and "Final amount after approval". When `isDemo`, show a "Demo settlement" tag. Show the bill amount, `deductions` (label, inr(amount), reason, clause), co-pay, and the approved amount (large, csSuccess), plus UTR and paidAt when `status == .PAID`. When the claim is SETTLED, show CompletedView (an animated checkmark, amount, UTR) with "Download summary" → `summaryPdfURL(id)` (SFSafariViewController or ShareLink after download). AlertsView: poll `notifications()`; rows with a type icon; tap → POST `notifications/{id}/read` then open the claim; a "Mark all read" button → POST `notifications/read-all`; `.badge(unread)` on the tab. ProfileView: `me()`, edit → `patchProfile` (save the new token); Bank: GET `me/bank`, add via POST `me/bank` with otp "111000" (masked display); register the APNs token → POST `me/push-token {token, platform:"ios"}`; Logout → DELETE `me/push-token`, clear the Keychain, show Login.

---

## 8. Troubleshooting
- **Timeouts / "host not found" / Cloudflare 530 or 1033:** the cloudflared quick-tunnel URL **changes every time the tunnel restarts**. Get the new URL from the backend dev, then update `API_BASE_URL` (Android `buildConfigField` → rebuild; iOS `Config.xcconfig` → rebuild). Check `GET {BASE}/health` → `{ ok: true, db: "ok" }`.
- **401 everywhere:** the token expired (7 days) or the demo DB was reset. Clear the stored JWT (EncryptedSharedPreferences / Keychain) and log in again with OTP **111000**.
- **Profile edits look stale or later calls fail:** `PUT/PATCH /me/profile` returns a **new token** (name and email are inside it). Always replace the stored one.
- **Retrofit `IllegalArgumentException: baseUrl must end in /`:** use `…/api/` and no leading slash in `@GET("claims")`.
- **Decoding errors:** Android uses `Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }`. On iOS, make optional anything that can be null, and add `unknown` enum fallbacks.
- **Upload 400 `UPLOAD_ERROR`:** the field must be named `file`, with a correct mime (`application/pdf`, `image/jpeg`, …) and ≤10 MB. On iOS, finish the multipart body with the closing `--boundary--`.
- **Upload feels slow:** validation runs before the response returns (1–3 s). Show "Validating…" and use a 90 s read timeout.
- **iOS ATS errors:** only happen with an `http://` base URL. Use the https tunnel.
- **Android emulator against a local server:** `http://10.0.2.2:5050/api/` plus a debug `network_security_config` that allows cleartext.
- **SSE silent:** some networks buffer streams. Keep 5 s polling as the primary mechanism.
- **Summary PDF blank or 401:** browsers and WebViews don't send headers, so append `?token=<JWT>` to `/claims/:id/summary.pdf`.

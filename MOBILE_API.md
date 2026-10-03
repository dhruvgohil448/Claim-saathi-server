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
| POST | `/auth/otp/verify` | `{ "phone": "9820000001", "otp": "111000" }` | `{ token, user, isNewUser, needsProfile }` (a new phone creates a CUSTOMER) |
| GET | `/me` (or `/auth/me`) | – | user (see shape below) |
| PUT | `/me/profile` | `{ name, email, dob: "1990-05-14", gender: "male"\|"female"\|"other", city? }` | `{ user, token }` (**replace the stored token**, since name and email are inside it). `PATCH` for partial edits. |
| GET | `/me/policies` | – | `Policy[]` |
| GET | `/me/policies/:id` | – | policy + its claims |
| POST | `/me/policies` | JSON or multipart: `{ insurer, policyNumber, sumInsured, startDate, endDate?, members?: [{name, relation, dob?}], planName?, roomRentLimit?, icuLimit?, coPayPercent? }`, optional `file` = policy PDF (multipart sends `members` as a JSON string) | `201 { policy, extractedFromPdf }`. Same number again from the same user is an update; a number owned by another user returns 409. |
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
| GET | `/claims/:id/timeline` | `{ status, events[] (oldest first), openQueries[], settlement, documents[] }` |
| POST | `/claims/:id/documents` | multipart `file` (pdf/jpg/png/webp/heic, max 10 MB) + optional `type` (`HOSPITAL_BILL`, `DISCHARGE_SUMMARY`, `PHARMACY_BILL`, `LAB_REPORT`, `PRESCRIPTION`, `CLAIM_FORM`, `PAYMENT_RECEIPT`, `HEALTH_CARD`, `PREAUTH_FORM`, `DOCTOR_ESTIMATE`, `ID_PROOF`, `OTHER`; auto-detected if omitted). Saved to the Supabase `claim-files` bucket. The AI then validates it in a few seconds: re-fetch the claim and read `documents[].status` (`VERIFIED`, `NEEDS_REVIEW` or `INVALID`) and `validationResult.{checks,issues,fix,summary}`. |
| GET | `/claims/:id/documents` | list |
| GET | `/documents/:id/url` | `{ url }`: short-lived signed URL for `<Image>`/WebView |
| POST | `/claims/check-coverage` | same body as create, no DB write. Returns covered / warnings / clauses. |
| POST | `/claims/:id/preauth` | (cashless) submit pre-auth and get an estimate |
| GET | `/claims/:id/settlement` | `{ billAmount, approvedAmount, coPayAmount, deductions:[{label, amount, reason, clause}], status: ESTIMATED\|APPROVED\|PAID, utr, paidAt }` (404 until it has been calculated) |

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
| POST | `/queries/:id/respond` | multipart: `response` (text), optional `file`, optional `type` (defaults to the query's requested doc type). Query becomes `ANSWERED`, ops are notified, and the Claim Agent validates the file. If the requested document verifies, the query is **CLOSED** automatically. |

## 5. Notifications
`GET /notifications` (alias `/notifications/my`, `?unread=true`) → `{ items: [{ id, title, body, type: INFO|SUCCESS|WARNING|ACTION_REQUIRED, read, claimId, claim:{claimNumber}, createdAt }], unread }` ·
`POST|PATCH /notifications/:id/read` · `POST /notifications/read-all`

## 6. Live updates
`GET /stream?token=<JWT>` (Server-Sent Events). Sends `event: ready` on connect, then `event: change` with `data: {"topics":["claim","document","query","activity","notification",...],"claimIds":[...],"at":"..."}` whenever something changes. Customers only receive changes on their own claims and notifications. React Native has no built-in EventSource, so either use `react-native-sse` or poll (`/me/home` and `/notifications` every 5–10 s).

## 7. Policy chat (existing)
`POST /policies/:id/chat { question, claimId? }` → `{ answer, sources[], followUps[] }`

## Pending (requested, not built yet)
- `POST /me/policies/:id/analyze` (Policy Reader: coverage[], exclusions[], conditions[], "What is covered?")
- `GET /claims/:id/checklist` (per-document uploaded/verified/missing/rejected status + "Payment receipt required" warnings). For now use `checklist` on `GET /claims/:id` or `/me/home`.
- Synchronous per-check validation in the upload response. Today the result appears on the claim a few seconds after upload.
- Stepper-style timeline (Created → Docs Submitted → Docs Verified → Under Review → Approved → Settlement)
- `POST /ai/chat { claimId?, message }` grounded assistant
- `isDemo` flag and pre-calculation preview on `/claims/:id/settlement`
- `GET /claims/:id/summary.pdf`

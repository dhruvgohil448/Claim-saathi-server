# Claim Saathi: Mobile App Build Guide (React Native CLI)

This is the only file the mobile developer needs. It targets **plain React Native CLI (not Expo)** and matches the real server (`claimsathi-server`, Express + Prisma + Supabase). Every endpoint below runs on the server today.

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

## 2. Setup

| Item | Value |
|---|---|
| Base URL | `https://stamps-logical-modems-dishes.trycloudflare.com/api` (cloudflared quick tunnel to the dev Mac `:5050`). It changes on tunnel restart (see Troubleshooting). |
| Transport | **HTTPS only**. iOS ATS blocks plain http, so always use the tunnel URL on devices. On the Android emulator, `http://10.0.2.2:5050/api` also works if you allow cleartext. |
| Auth | `Authorization: Bearer <JWT>` (valid for 7 days). Store it in **react-native-keychain** (`setGenericPassword('jwt', token)`). |
| OTP | **Always `111000`** for login OTP, claim consent OTP and bank verification. No SMS is sent. |
| Navigation | `@react-navigation/native` + `@react-navigation/native-stack` + `@react-navigation/bottom-tabs` (+ `react-native-screens`, `react-native-safe-area-context`) |
| Files | `react-native-image-picker` (camera/gallery) and `@react-native-documents/picker` (PDF) |
| Config | `react-native-config` with `.env`: `API_BASE_URL=https://…trycloudflare.com/api` |
| Live updates | Poll every **5 s** on focused screens (`/me/home`, `/claims/:id/timeline`, `/notifications`), **or** use `react-native-sse` on `GET /stream?token=<JWT>` and refetch when a `change` event arrives |
| PDF / file view | `react-native-webview` (or `Linking.openURL`) for `/claims/:id/summary.pdf?token=` and signed document URLs |

```bash
npx @react-native-community/cli init ClaimSaathi --pm npm
cd ClaimSaathi
npm i @react-navigation/native @react-navigation/native-stack @react-navigation/bottom-tabs react-native-screens react-native-safe-area-context \
      react-native-keychain react-native-image-picker @react-native-documents/picker react-native-config react-native-sse react-native-webview
cd ios && pod install && cd ..
```
iOS `Info.plist`: add `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription`. Android: add the `CAMERA` permission.

### Theme
```ts
export const theme = {
  primary: '#00BAF2',   // Paytm sky blue: buttons, active tab, links, progress
  navy: '#002E6E',      // headers, titles, primary text on light
  bg: '#F5F8FC', card: '#FFFFFF', text: '#002E6E', muted: '#6B7A90', border: '#E3EAF3',
  success: '#12B76A', warning: '#F79009', danger: '#F04438',
  radius: 14, spacing: 16,
};
```
Status chip colours: verified/done = success, uploaded/current = primary, missing/pending = muted, rejected/failed = danger.

### API client (sketch)
```ts
import Config from 'react-native-config';
import * as Keychain from 'react-native-keychain';
export const BASE = Config.API_BASE_URL!;
export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const creds = await Keychain.getGenericPassword();
  const isForm = opts.body instanceof FormData;
  const res = await fetch(BASE + path, { ...opts, headers: {
    ...(isForm ? {} : { 'Content-Type': 'application/json' }),
    ...(creds ? { Authorization: `Bearer ${creds.password}` } : {}), ...(opts.headers || {}) } });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401) { await Keychain.resetGenericPassword(); /* navigate to Login */ }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code, data?.error?.message ?? 'Request failed');
  return data as T;
}
// Multipart upload: never set Content-Type yourself (fetch adds the boundary)
const fd = new FormData();
fd.append('file', { uri, name: 'bill.pdf', type: 'application/pdf' } as any);
fd.append('type', 'HOSPITAL_BILL');
await api(`/claims/${id}/documents`, { method: 'POST', body: fd });
```

---

## 3. TypeScript models (from `prisma/schema.prisma`)

```ts
// ---- Enums (exact values from the Prisma schema) ----
export type UserRole = 'CUSTOMER' | 'OPS' | 'ADMIN';
export type ClaimStatus = 'CREATED' | 'PREAUTH_SUBMITTED' | 'DOCS_PENDING' | 'UNDER_REVIEW' | 'QUERY_RAISED' | 'NEEDS_HUMAN' | 'APPROVED' | 'REJECTED' | 'SETTLED';
export type ClaimType = 'CASHLESS' | 'REIMBURSEMENT';           // create also accepts type:'PREAUTH' (= CASHLESS)
export type AdmissionType = 'PLANNED' | 'EMERGENCY';
export type DocumentType = 'HEALTH_CARD' | 'POLICY_SCHEDULE' | 'CLAIM_FORM' | 'PREAUTH_FORM' | 'DOCTOR_ESTIMATE' | 'DISCHARGE_SUMMARY' | 'HOSPITAL_BILL' | 'PHARMACY_BILL' | 'LAB_REPORT' | 'PRESCRIPTION' | 'PAYMENT_RECEIPT' | 'ID_PROOF' | 'OTHER';
export type DocumentStatus = 'UPLOADED' | 'VERIFIED' | 'NEEDS_REVIEW' | 'INVALID';
export type QueryStatus = 'OPEN' | 'ANSWERED' | 'CLOSED';
export type ActorType = 'AI' | 'HUMAN' | 'SYSTEM';
export type SettlementStatus = 'ESTIMATED' | 'APPROVED' | 'PAID';
export type NotificationType = 'INFO' | 'SUCCESS' | 'WARNING' | 'ACTION_REQUIRED';
// App-level derived values
export type AppDocStatus = 'uploaded' | 'verified' | 'missing' | 'rejected';   // NEEDS_REVIEW and INVALID map to 'rejected'
export type StepState = 'done' | 'current' | 'pending' | 'failed';
export type StepKey = 'CREATED' | 'DOCS_SUBMITTED' | 'DOCS_VERIFIED' | 'UNDER_REVIEW' | 'APPROVED' | 'SETTLEMENT';

// ---- Models (dates are ISO strings over JSON) ----
export interface User {            // as returned by /me (passwordHash, pushToken and bankAccount are never sent)
  id: string; name: string; email: string | null; phone: string | null; role: UserRole; city: string | null;
  dob: string | null; gender: string | null; bank: BankMasked | null; pushEnabled: boolean; profileComplete: boolean; createdAt: string;
}
export interface BankMasked { accountName: string; accountNumberMasked: string; ifsc: string; bankName?: string; verified: boolean }
export interface WaitingPeriod { name: string; months: number; appliesTo?: string[] }
export interface Member { name: string; relation?: string; dob?: string }
export interface Policy {
  id: string; userId: string; insurer: string; planName: string | null; policyNumber: string;
  sumInsured: number; roomRentLimit: number; icuLimit: number | null; coPayPercent: number;
  startDate: string; endDate: string | null; waitingPeriods: WaitingPeriod[]; subLimits: Record<string, number> | null;
  exclusions: string[]; networkHospitals: string[] | null; members: Member[] | null;
  analysis: PolicyAnalysis | null; analyzedAt: string | null; summary: string | null; summaryHindi: string | null;
  fileUrl: string | null; rawText: string | null; createdAt: string; updatedAt: string; claims?: Claim[];
}
export interface PatientDetails { age?: number; gender?: string; relation?: string; phone?: string }
export interface BillItem { description: string; qty?: number; rate?: number; amount: number; category?: string }
export interface Claim {
  id: string; claimNumber: string; userId: string; policyId: string; patientName: string; patientDetails: PatientDetails | null;
  hospital: string; hospitalCity: string | null; isNetworkHospital: boolean; reason: string; treatment: string | null;
  claimType: ClaimType; admissionType: AdmissionType; isAccident: boolean; admissionDate: string | null; dischargeDate: string | null;
  roomType: string | null; roomRentPerDay: number | null; days: number | null; estimatedAmount: number | null; billAmount: number | null;
  billItems: BillItem[] | null; status: ClaimStatus; aiSummary: string | null; aiSuggestion: { decision: string; amount?: number; reason: string } | null;
  aiConfidence: number | null; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | null; riskFlags: string[] | null; reminderCount: number;
  lastActivityAt: string; createdAt: string; updatedAt: string;
  policy?: Policy; documents?: Document[]; events?: ClaimEvent[]; queries?: Query[]; settlement?: Settlement | null;
  _count?: { documents: number; queries: number };
}
export interface Document {
  id: string; claimId: string; type: DocumentType; fileName: string; fileUrl: string; mimeType: string | null; size: number | null;
  status: DocumentStatus; confidence: number | null; validationResult: any | null; extractedData: ExtractedData | null;
  reviewedBy: string | null; reviewNote: string | null; createdAt: string; updatedAt: string;
}
export interface ExtractedData { name?: string | null; date?: string | null; amount?: number | null; doctor?: string | null; hasSignature?: boolean }
export interface ClaimEvent { id: string; claimId: string; status: ClaimStatus; title: string; description: string | null; actor: ActorType; createdAt: string }
export interface Query {
  id: string; claimId: string; message: string; requestedDocType: DocumentType | null; response: string | null; status: QueryStatus;
  createdBy: ActorType; respondedAt: string | null; closedAt: string | null; createdAt: string; updatedAt: string; claim?: Pick<Claim, 'id' | 'claimNumber' | 'hospital' | 'status'>;
}
export interface Deduction { label: string; amount: number; reason: string; clause?: string }
export interface Settlement {
  id?: string; claimId: string; billAmount: number; deductions: Deduction[]; coPayAmount: number; approvedAmount: number;
  explanation: string | null; status: SettlementStatus | 'PREVIEW'; utr: string | null; paidAt: string | null;
  isDemo: true; isEstimate: boolean; preview: boolean;
}
export interface ActivityLog { id: string; claimId: string | null; actor: ActorType; actorName: string | null; action: string; reason: string; confidence: number | null; meta: any; createdAt: string }
export interface Notification { id: string; userId: string; claimId: string | null; type: NotificationType; title: string; body: string; read: boolean; createdAt: string; claim?: { claimNumber: string } | null }

// ---- Derived API shapes ----
export interface PolicyAnalysis {
  policyId: string; policyNumber: string; insurer: string; planName: string | null;
  sumInsured: number; roomRentLimit: number; icuLimit: number | null; coPayPercent: number; startDate: string; endDate: string | null; isActive: boolean;
  members: Member[]; coverage: { item: string; covered: boolean; limit: number | null; detail: string }[];
  exclusions: string[]; conditions: string[];
  waitingPeriods: { name: string; months: number; eligibleFrom: string; active: boolean; status: string }[];
  whatIsCovered: string; source: 'policy-document' | 'policy-details'; ai: string; analyzedAt: string;
}
export interface ChecklistItem { type: DocumentType; label: string; required: boolean; status: AppDocStatus; rawStatus: DocumentStatus | null; documentId: string | null; fileName: string | null; confidence: number | null; reason: string | null; fix: string | null }
export interface Checklist { claimId: string; claimType: ClaimType; stage: string; items: ChecklistItem[]; warnings: string[]; progress: { required: number; verified: number; uploaded: number }; complete: boolean }
export interface ValidationCheck { key: 'documentDetected' | 'patientNameMatched' | 'amountDetected' | 'dateValid' | 'requiredFieldsPresent'; label: string; passed: boolean | null; detail: string }
export interface UploadValidation { status: DocumentStatus; appStatus: AppDocStatus; confidence: number; summary: string; fix: string | null; checks: ValidationCheck[]; issues: { code?: string; message: string }[]; warnings: string[]; extracted: ExtractedData }
export interface UploadResponse extends Document { validation: UploadValidation; checklist: Checklist; claimStatus: ClaimStatus }
export interface Step { key: StepKey; label: string; done: boolean; state: StepState; at: string | null; note: string | null }
export interface Timeline { status: ClaimStatus; events: ClaimEvent[]; openQueries: Query[]; settlement: Settlement | null; documents: Document[]; steps: Step[]; currentStep: StepKey | null; latestOpsUpdate: { kind: 'QUERY' | 'OPS' | 'AI' | 'SYSTEM'; message: string; at: string } | null; checklistWarnings: string[] }
export interface ChatReply { answer: string; intent: string; sources: string[]; followUps: string[]; grounded: { policyNumber: string | null; claimNumber: string | null }; ai: string }
export interface PendingAction { kind: 'QUERY' | 'MISSING_DOC' | 'REUPLOAD_DOC' | 'COMPLETE_PROFILE' | 'LINK_POLICY' | 'ADD_BANK'; title: string; claimId?: string; queryId?: string; documentType?: DocumentType }
export interface Home { user: User; activePolicy: Policy | null; currentClaim: (Claim & { checklist: any }) | null; pendingActions: PendingAction[]; counts: { policies: number; claims: number; activeClaims: number; openQueries: number; pendingActions: number; unreadNotifications: number }; paidOut: number }
export interface ApiErrorBody { error: { code: string; message: string } }
```

---

## 4. Screens (13) and the endpoints each calls

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
| (+) | **Profile** (tab) | `GET /me`, `PATCH /me/profile`, `GET/POST /me/bank`, `POST/DELETE /me/push-token`, logout = clear keychain |

Suggested tabs: **Home · Claims · Assistant · Alerts · Profile**. The other screens are stack screens.

---

## 5. Endpoint reference

All paths are relative to `BASE` (`…/api`). JSON unless noted. `:id` on claims accepts the id or the claim number (`CLM-1011`).

### 5.1 Onboarding / auth
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

### 5.2 Policies + Policy Reader
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

### 5.3 Bank, push, home
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

### 5.4 Claims
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

### 5.5 Queries
| Method | Path | Notes |
|---|---|---|
| GET | `/queries?status=OPEN` | my queries (with `claim`) |
| GET | `/claims/:id/queries` | queries on one claim |
| GET | `/queries/:id/explain` | plain-language explanation + next steps |
| POST | `/queries/:id/respond` | multipart: `response` (text), optional `file`, optional `type` (defaults to the query's requested doc type). With a file it returns the query plus `document: UploadResponse` (validated synchronously). If the requested document verifies, the query is **CLOSED**. A text-only reply sets it to `ANSWERED` and ops are notified. |

### 5.6 AI assistant
`POST /ai/chat { "message": "Which documents are still pending?", "claimId": "CLM-1011" }` (`claimId` is optional; it defaults to the latest claim). The answer is grounded in the user's own policy and claim data from the DB. In mock mode it is rules-based, covering these intents: STATUS, DOCUMENTS, DOC_REJECTED, CLAIM_REJECTED, QUERIES, SETTLEMENT, ROOM_RENT, COPAY, WAITING, EXCLUSION(S), SUBLIMIT, SUM_INSURED, POLICY_SUMMARY.
```json
{ "answer": "Claim CLM-1011 at City Care Hospital is waiting for documents: discharge summary, claim form…", "intent": "DOCUMENTS",
  "sources": ["Claim checklist"], "followUps": ["How much will I get?", "What is my room rent limit?"],
  "grounded": { "policyNumber": "E2E-TEST-0001", "claimNumber": "CLM-1011" }, "ai": "mock" }
```
Older endpoint, still available: `POST /policies/:id/chat { question, claimId? }` → `{ answer, sources[], followUps[] }`.

### 5.7 Notifications
`GET /notifications` (alias `/notifications/my`, `?unread=true`) → `{ items: Notification[], unread: number }` · `POST|PATCH /notifications/:id/read` · `POST /notifications/read-all`

### 5.8 Live updates
`GET /stream?token=<JWT>` (Server-Sent Events). It sends `event: ready` on connect, then `event: change` with `data: {"topics":["claim","document","query","activity","notification"],"claimIds":["…"],"at":"…"}`. Customers only receive their own claims and notifications. On `change`, refetch the visible screen.
```ts
import EventSource from 'react-native-sse';
const es = new EventSource(`${BASE}/stream?token=${token}`);
es.addEventListener('change' as any, (e: any) => { const d = JSON.parse(e.data); if (d.claimIds?.includes(claimId)) refetch(); });
// cleanup: es.removeAllEventListeners(); es.close();
```

---

## 6. Error format
Every error looks like this:
```json
{ "error": { "code": "BAD_REQUEST", "message": "Invalid OTP" } }
```
| HTTP | code | Meaning / app action |
|---|---|---|
| 400 | `BAD_REQUEST` / `VALIDATION_ERROR` | show `message` inline (wrong OTP, missing field, bad file) |
| 401 | `UNAUTHORIZED` | token missing, expired or stale: clear the keychain and send the user to Login |
| 403 | `FORBIDDEN` | not your resource |
| 404 | `NOT_FOUND` | claim, policy or query not found |
| 409 | `CONFLICT` | policy number belongs to another user |
| 400 | `UPLOAD_ERROR` | bad or unsupported file, or > 10 MB |
| 500 | `INTERNAL` | show a retry option |

---

## 7. Build prompts (copy-paste, in order)

**1. Setup**
> Create a React Native CLI (not Expo) TypeScript app "ClaimSaathi". Install @react-navigation/native, native-stack and bottom-tabs, react-native-screens, react-native-safe-area-context, react-native-keychain, react-native-image-picker, @react-native-documents/picker, react-native-config, react-native-sse and react-native-webview. Add `.env` with `API_BASE_URL=https://stamps-logical-modems-dishes.trycloudflare.com/api`. Create `src/theme.ts` (primary #00BAF2, navy #002E6E, plus the success/warning/danger and neutral colours from the guide) and `src/api/client.ts`: a fetch wrapper that adds `Authorization: Bearer` from Keychain, sends JSON or FormData, throws `ApiError(status, code, message)` from `{error:{code,message}}`, and on 401 clears the Keychain and resets navigation to Login. Add camera/photo permissions to Info.plist and AndroidManifest.

**2. Models**
> Create `src/types/models.ts` with exactly the enums and interfaces in section 3 of MOBILE_APP_GUIDE.md (UserRole, ClaimStatus, ClaimType, AdmissionType, DocumentType, DocumentStatus, QueryStatus, ActorType, SettlementStatus, NotificationType, User, Policy, Claim, Document, ClaimEvent, Query, Settlement, Notification, PolicyAnalysis, Checklist, UploadResponse, Timeline, Step, ChatReply, Home, ApiErrorBody). Add `src/api/endpoints.ts` with one typed function per endpoint in section 5, using these exact paths: `/auth/otp/send`, `/auth/otp/verify`, `/me`, `/me/profile`, `/me/policies`, `/me/policies/:id`, `/me/policies/:id/analyze`, `/me/bank`, `/me/push-token`, `/me/home`, `/claims`, `/claims/check-coverage`, `/claims/:id`, `/claims/:id/preauth`, `/claims/:id/checklist`, `/claims/:id/documents`, `/documents/:id/url`, `/claims/:id/timeline`, `/claims/:id/settlement`, `/claims/:id/summary.pdf`, `/queries`, `/claims/:id/queries`, `/queries/:id/explain`, `/queries/:id/respond`, `/ai/chat`, `/notifications`, `/notifications/:id/read`, `/notifications/read-all`, `/stream`. Also add helpers: `inr(n)` (₹ with Indian grouping) and `statusLabel(ClaimStatus)`.

**3. Onboarding**
> Build the Login (10-digit phone, then `POST /auth/otp/send`), OTP (6 boxes with the hint "Demo OTP: 111000", then `POST /auth/otp/verify`, storing `token` in Keychain) and Complete Profile screens (name, email, DOB picker, gender, city, then `PUT /me/profile`; **replace the Keychain token with `response.token`**). Route to Profile when `needsProfile` is true, otherwise to the Main tabs. On app start, read the Keychain and call `GET /me`; on 401 show Login. Show `error.message` inline on failures.

**4. Home + Policy Reader**
> Build the Home tab from `GET /me/home`, polled every 5 s while focused. Show a greeting, the active policy card (sum insured, room rent/day, co-pay), the current claim card (status chip, mini progress from `checklist`), the `pendingActions` list (QUERY goes to the Query screen, MISSING_DOC/REUPLOAD_DOC go to Checklist with the type preselected, LINK_POLICY goes to Add Policy, ADD_BANK goes to Bank, COMPLETE_PROFILE goes to Profile) and an alerts bell with `counts.unreadNotifications`. Build Policies: list `GET /me/policies`, Add Policy form (`POST /me/policies`, JSON, or multipart with an optional PDF from @react-native-documents/picker; send `members` as a JSON string in multipart). Build the Policy Reader screen: call `POST /me/policies/:id/analyze` and render `whatIsCovered` as a hero paragraph, then `coverage[]` (item, detail), `exclusions[]`, `conditions[]` and `waitingPeriods[]` (status chip, active = warning), with a "Ask the assistant" button.

**5. Start Claim + Pre-auth**
> Build a 3-step Start Claim wizard: (1) policy picker from `GET /me/policies` and a type toggle (Reimbursement / Pre-auth); (2) hospital, city, reason, treatment, admissionType, admission/discharge dates, days, billAmount (reimbursement) or estimatedAmount (pre-auth), and patient (name, age, gender, relation; default to policy members); (3) review, with optional `POST /claims/check-coverage` to show warnings, then a consent OTP box (hint 111000), then `POST /claims` with `type: 'REIMBURSEMENT' | 'PREAUTH'` and `consentOtp`. For pre-auth, then call `POST /claims/:id/preauth` and show the estimate. On success navigate to Checklist for the new claim.

**6. Checklist + Upload + Smart Validation**
> Build Checklist from `GET /claims/:id/checklist`: a progress bar (`progress.verified/required`), item rows with a status chip (uploaded = primary, verified = success, missing = muted, rejected = danger, showing `reason` and `fix`), and `warnings[]` as a yellow banner. Tapping an item opens an action sheet: Camera / Gallery (react-native-image-picker) / PDF (@react-native-documents/picker). Upload with FormData `file` + `type` to `POST /claims/:id/documents` and show "Validating…" (the response arrives after validation). Then show the Smart Validation screen from the response: a big status (`validation.appStatus`, `confidence`), the 5 `validation.checks[]` with ✓/✗/– (`passed` true/false/null) and `detail`, `validation.warnings[]`, `fix` if any, and buttons "Upload next document" (refresh with `response.checklist`) and "Track claim".

**7. Claims + Tracking**
> Build the Claims tab: `GET /claims` with filter chips (All / Action needed = `?status=QUERY_RAISED,DOCS_PENDING` / Settled = `?status=SETTLED`) and cards showing claimNumber, hospital, status chip, billAmount and `_count.queries` open queries. Build Claim Tracking from `GET /claims/:id/timeline`, polled every 5 s or refreshed on `react-native-sse` `change` events from `/stream?token=` whose `claimIds` contain this claim. Render a vertical stepper of `steps[]` (done = filled success, current = pulsing primary, pending = grey, failed = danger) with `note` and `at`, a "Latest update" card from `latestOpsUpdate`, an open-queries banner (goes to Queries), the documents list (thumbnails via `GET /documents/:id/url`) and the events log.

**8. Queries**
> Build Queries: list `GET /queries?status=OPEN` (and per-claim `GET /claims/:id/queries`). The detail screen shows the ops message, `requestedDocType`, and a "What does this mean?" section from `GET /queries/:id/explain`. Respond form: text plus an optional file, sent as multipart to `POST /queries/:id/respond` (`response`, `file`, optional `type`). If the response contains `document`, show its `validation.checks` like the Smart Validation screen, and if the query `status` is `CLOSED` show "Query resolved ✓". Text-only replies show "Sent to the claims team".

**9. AI Assistant**
> Build the Assistant tab as a chat UI. Send `POST /ai/chat { message, claimId? }` (claimId comes from a claim picker, defaulting to the current claim from `/me/home`). Render `answer` as an assistant bubble, `sources[]` as small chips, and `followUps[]` as tappable suggestion chips that send that text. Show "Grounded in policy {grounded.policyNumber} · claim {grounded.claimNumber}" under the header. Starter chips: "Where is my claim?", "Which documents are pending?", "What is my room rent limit?", "How much will I get?", "What is not covered?".

**10. Settlement + Completed + Alerts + Profile**
> Build Settlement from `GET /claims/:id/settlement`. If `preview` is true, show an "Estimate" badge and "Final amount after approval". Always show a "Demo settlement" tag when `isDemo`. Show the bill amount, each deduction (label, amount, reason, clause), co-pay, the approved amount (large, success), and the UTR and paidAt when `status === 'PAID'`. When the claim status is SETTLED, show the Completed screen (check animation, amount, UTR) with a "Download summary" button that opens `${BASE}/claims/${id}/summary.pdf?token=${jwt}` in a WebView. Alerts tab: `GET /notifications` list (type icon, title, body, time), tap → `POST /notifications/:id/read` and open the claim, plus a "Mark all read" button (`POST /notifications/read-all`) and an unread badge on the tab. Profile tab: `GET /me`, edit (`PATCH /me/profile`, replacing the token), Bank (`GET /me/bank`, add with `POST /me/bank` and OTP 111000, shown masked), push token registration (`POST /me/push-token`), and Logout (clear Keychain and `DELETE /me/push-token`).

---

## 8. Troubleshooting
- **Network request failed / 530 / 1033:** the cloudflared quick-tunnel URL **changes every time the tunnel restarts**. Get the new URL from the server Terminal (or ask the backend dev), update `API_BASE_URL` in `.env`, and rebuild (react-native-config needs a native rebuild, not just a Metro reload). Check `GET {BASE}/health` → `{ ok: true, db: "ok" }`.
- **401 everywhere:** the token expired (7 days), or the demo DB was reset. Clear Keychain and log in again (OTP 111000).
- **Name/email stale or 401 after editing profile:** `PUT/PATCH /me/profile` returns a **new token**. Always replace the stored one.
- **iOS can't reach http://…:** ATS blocks cleartext, so use the https tunnel URL.
- **Upload fails with 400:** don't set the `Content-Type` header for FormData. The file object needs `uri`, `name` and `type`. The maximum is 10 MB, and HEIC is accepted.
- **Upload feels slow:** validation runs before the response returns (usually 1–3 s). Show a "Validating…" state.
- **SSE not firing on Android:** some proxies buffer. Fall back to 5 s polling (always keep polling as a fallback).
- **PDF opens blank:** pass `?token=<JWT>` on `/claims/:id/summary.pdf` (WebViews don't send the Authorization header).

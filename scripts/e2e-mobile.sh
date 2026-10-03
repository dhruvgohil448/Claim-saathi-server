#!/usr/bin/env bash
# Mobile-app E2E: acts as the phone through BASE (public tunnel by default), then checks the ops/dashboard APIs.
# Usage: BASE=https://<tunnel> ./scripts/e2e-mobile.sh      (KEEP=1 to skip cleanup)
set -euo pipefail
BASE="${BASE:-https://productions-orbit-porter-investigated.trycloudflare.com}"
API="$BASE/api"; PHONE="9000012345"; OTP="111000"
DIR="$(cd "$(dirname "$0")" && pwd)"
ok(){ printf '  \033[32m✔\033[0m %s\n' "$*"; }
fail(){ printf '  \033[31m✘ %s\033[0m\n' "$*"; exit 1; }
j(){ jq -r "$1"; }
H=(-s -m 60 -H 'content-type: application/json')

echo "== 0. health via $BASE"
curl "${H[@]}" "$API/health" | j '.ok' | grep -q true && ok "health ok" || fail "health"

echo "== 1. OTP onboarding (phone)"
curl "${H[@]}" -X POST "$API/auth/otp/send" -d "{\"phone\":\"$PHONE\"}" | j '.sent' | grep -q true && ok "otp/send → sent:true"
BAD=$(curl "${H[@]}" -X POST "$API/auth/otp/verify" -d "{\"phone\":\"$PHONE\",\"otp\":\"000000\"}" | j '.error.code'); [ "$BAD" = BAD_REQUEST ] && ok "wrong OTP rejected"
V=$(curl "${H[@]}" -X POST "$API/auth/otp/verify" -d "{\"phone\":\"$PHONE\",\"otp\":\"$OTP\"}")
CT=$(echo "$V" | j '.token'); [ "$CT" != null ] || fail "otp verify: $V"
ok "otp/verify → isNewUser=$(echo "$V" | j '.isNewUser') needsProfile=$(echo "$V" | j '.needsProfile') starterProvisioned=$(echo "$V" | j '.starterProvisioned')"
A=(-H "Authorization: Bearer $CT")
SC=$(curl "${H[@]}" "${A[@]}" "$API/claims" | jq -r '[.[]|"\(.claimType)/\(.status)"]|sort|join(",")')
echo "$SC" | grep -q "CASHLESS/PREAUTH_SUBMITTED" && echo "$SC" | grep -q "REIMBURSEMENT/UNDER_REVIEW" && echo "$SC" | grep -q "REIMBURSEMENT/SETTLED" && ok "starter claims: $SC" || fail "starter claims missing: $SC"

P=$(curl "${H[@]}" "${A[@]}" -X PUT "$API/me/profile" -d '{"name":"E2E Test User","email":"e2e-test@claimsaathi.test","dob":"1990-05-14","gender":"male","city":"Pune"}')
CT=$(echo "$P" | j '.token'); A=(-H "Authorization: Bearer $CT")
[ "$(echo "$P" | j '.user.profileComplete')" = true ] && ok "PUT /me/profile → profileComplete"
POL=$(curl "${H[@]}" "${A[@]}" -X POST "$API/me/policies" -d '{"insurer":"E2E Test Insurance (Demo)","policyNumber":"E2E-TEST-0001","sumInsured":300000,"startDate":"2026-01-01","endDate":"2026-12-31","coPayPercent":10,"members":[{"name":"E2E Test User","relation":"Self"}]}')
POLICY_ID=$(echo "$POL" | j '.policy.id'); [ "$POLICY_ID" != null ] || fail "policy: $POL"; ok "POST /me/policies → $POLICY_ID (room cap ₹$(echo "$POL" | j '.policy.roomRentLimit')/day)"
AN=$(curl "${H[@]}" "${A[@]}" -X POST "$API/me/policies/$POLICY_ID/analyze")
ok "Policy Reader → coverage=$(echo "$AN" | j '.coverage|length') conditions=$(echo "$AN" | j '.conditions|length') waiting=$(echo "$AN" | j '.waitingPeriods|length') :: $(echo "$AN" | j '.whatIsCovered' | cut -c1-110)…"
ok "GET /me/policies/:id has stored analysis: $(curl "${H[@]}" "${A[@]}" "$API/me/policies/$POLICY_ID" | j '.analysis.sumInsured')"
B=$(curl "${H[@]}" "${A[@]}" -X POST "$API/me/bank" -d "{\"accountName\":\"E2E Test User\",\"accountNumber\":\"123456789012\",\"ifsc\":\"HDFC0001234\",\"otp\":\"$OTP\"}")
ok "POST /me/bank → $(echo "$B" | j '.bank.accountNumberMasked') verified=$(echo "$B" | j '.bank.verified')"
ok "GET /me → $(curl "${H[@]}" "${A[@]}" "$API/me" | j '"\(.name) \(.phone) \(.email)"')"

echo "== 2. ops login + SSE listener"
OT=$(curl "${H[@]}" -X POST "$API/auth/login" -d '{"email":"ops@claimsaathi.demo","password":"demo123"}' | j '.token'); O=(-H "Authorization: Bearer $OT")
SSE_LOG=$(mktemp); curl -s -N -m 40 "http://localhost:5050/api/stream?token=$OT" > "$SSE_LOG" & SSE_PID=$!
sleep 1

echo "== 3. create claim (reimbursement, consent OTP)"
C=$(curl "${H[@]}" "${A[@]}" -X POST "$API/claims" -d "{\"policyId\":\"$POLICY_ID\",\"type\":\"REIMBURSEMENT\",\"hospital\":\"City Care Hospital\",\"hospitalCity\":\"Pune\",\"reason\":\"E2E TEST - viral fever\",\"treatment\":\"IV fluids and observation\",\"admissionType\":\"EMERGENCY\",\"admissionDate\":\"2026-09-28\",\"dischargeDate\":\"2026-09-30\",\"days\":2,\"billAmount\":12500,\"patientDetails\":{\"age\":36,\"gender\":\"MALE\",\"relation\":\"Self\"},\"consentOtp\":\"$OTP\"}")
CID=$(echo "$C" | j '.id'); CNO=$(echo "$C" | j '.claimNumber'); [ "$CID" != null ] || fail "claim: $C"; ok "POST /claims → $CNO ($CID)"
sleep 2
ok "checklist → $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/checklist" | jq -c '{stage,progress,items:[.items[]|"\(.type)=\(.status)"]}')"
ok "settlement preview → $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/settlement" | jq -c '{status,isDemo,preview,billAmount,approvedAmount}')"

echo "== 4. upload hospital bill (multipart → Supabase storage)"
D=$(curl -s -m 60 "${A[@]}" -F "file=@$DIR/e2e-assets/e2e-hospital-bill.pdf;type=application/pdf" -F type=HOSPITAL_BILL "$API/claims/$CID/documents")
DID=$(echo "$D" | j '.id'); ok "POST /claims/:id/documents → $DID storage=$(echo "$D" | j '.fileUrl' | cut -d/ -f1) status=$(echo "$D" | j '.validation.appStatus')"
ok "upload checks: $(echo "$D" | jq -r '[.validation.checks[]|"\(.label)=\(.passed)"]|join(", ")')"
ok "upload warnings: $(echo "$D" | jq -r '.validation.warnings|.[0:3]|join(" | ")')"

echo "== 5. ops raises a query (dashboard API) → customer answers with a receipt"
Q=$(curl "${H[@]}" "${O[@]}" -X POST "$API/claims/$CID/queries" -d '{"message":"Please upload the payment receipt for the hospital bill.","requestedDocType":"PAYMENT_RECEIPT"}')
QID=$(echo "$Q" | j '.id'); ok "ops POST /claims/:id/queries → $QID"
ok "customer GET /queries?status=OPEN → $(curl "${H[@]}" "${A[@]}" "$API/queries?status=OPEN" | jq -r --arg q "$QID" '[.[]|select(.id==$q)]|length') match"
R=$(curl -s -m 60 "${A[@]}" -F "file=@$DIR/e2e-assets/e2e-payment-receipt.pdf;type=application/pdf" -F "response=Receipt attached" "$API/queries/$QID/respond")
ok "POST /queries/:id/respond → query $(echo "$R" | j '.status'), receipt $(echo "$R" | j '.document.validation.appStatus')"
sleep 2
ok "query now: $(curl "${H[@]}" "${O[@]}" "$API/claims/$CID" | jq -r --arg q "$QID" '.queries[]|select(.id==$q)|.status')"

echo "== 6. customer views"
ok "GET /claims (mine) → $(curl "${H[@]}" "${A[@]}" "$API/claims" | jq -r 'map(.claimNumber)|join(",")')"
T=$(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/timeline"); ok "timeline → status=$(echo "$T" | j '.status') events: $(echo "$T" | jq -r '[.events[].title]|join(" → ")')"
ok "stepper → $(echo "$T" | jq -r '[.steps[]|"\(.label):\(.state)"]|join(" · ")') | latest: $(echo "$T" | j '.latestOpsUpdate.message' | cut -c1-80)"
for M in "Where is my claim?" "Which documents are still pending?" "What is my room rent limit?" "How much will I get?" "What is not covered?"; do
  BODY=$(jq -nc --arg c "$CID" --arg m "$M" '{claimId:$c,message:$m}')
  R=$(curl "${H[@]}" "${A[@]}" -X POST "$API/ai/chat" -d "$BODY")
  ok "ai/chat '$M' → $(echo "$R" | jq -r '"[\(.intent)] \(.answer)"' | cut -c1-150)"
done
N=$(curl "${H[@]}" "${A[@]}" "$API/notifications"); ok "notifications → unread=$(echo "$N" | j '.unread'): $(echo "$N" | jq -r '[.items[].title]|.[0:4]|join(" | ")')"
NID=$(echo "$N" | j '.items[0].id'); curl "${H[@]}" "${A[@]}" -X POST "$API/notifications/$NID/read" >/dev/null; ok "marked one read → unread=$(curl "${H[@]}" "${A[@]}" "$API/notifications" | j '.unread')"
ok "GET /me/home → $(curl "${H[@]}" "${A[@]}" "$API/me/home" | jq -c '{policy:.activePolicy.policyNumber,current:.currentClaim.claimNumber,status:.currentClaim.status,counts}')"
curl "${H[@]}" "${A[@]}" -X POST "$API/me/push-token" -d '{"token":"ExponentPushToken[e2e-test-token]","platform":"ios"}' | j '.ok' | grep -q true && ok "push token saved"

echo "== 6b. starter data, sample templates, live amount warnings, finance chat, upload tolerance"
HM=$(curl "${H[@]}" "${A[@]}" "$API/me/home"); ok "home warnings → $(echo "$HM" | jq -r '[.warnings[].code]|join(",")') paidOut=$(echo "$HM" | j '.paidOut')"
TP=$(curl "${H[@]}" "${A[@]}" "$API/demo/templates"); [ "$(echo "$TP" | j '.preauth.claimType')" = CASHLESS ] && ok "GET /demo/templates → preauth ₹$(echo "$TP" | j '.preauth.estimatedAmount') @ $(echo "$TP" | j '.preauth.hospital'), reimbursement bill ₹$(echo "$TP" | j '.reimbursement.billAmount')" || fail "templates: $TP"
PV=$(curl "${H[@]}" "${A[@]}" -X POST "$API/claims/preview" -d "{\"policyId\":\"$POLICY_ID\",\"type\":\"REIMBURSEMENT\",\"estimatedAmount\":\"40000\",\"billAmount\":\"3,50,000\",\"roomRentPerDay\":6000,\"days\":3}")
for W in ABOVE_SUM_INSURED ROOM_RENT_ABOVE_LIMIT BILL_ABOVE_ESTIMATE CO_PAY; do echo "$PV" | jq -e --arg w $W '.warnings|map(.code)|index($w)' >/dev/null || fail "preview missing $W: $PV"; done
ok "POST /claims/preview → $(echo "$PV" | jq -r '[.warnings[]|"\(.severity):\(.code)"]|join(", ")') remaining=₹$(echo "$PV" | j '.remainingSumInsured')"
ok "POST /claims/validate (alias, empty form) → $(curl "${H[@]}" "${A[@]}" -X POST "$API/claims/validate" -d '{}' | jq -c '{warnings:(.warnings|length),sumInsured}')"
ok "claim detail warnings → $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID" | jq -r '[.warnings[].code]|join(",")')"
FN=$(curl "${H[@]}" "${A[@]}" "$API/me/finance"); ok "GET /me/finance → accounts=$(echo "$FN" | j '.accounts|length') total=₹$(echo "$FN" | j '.totalBalance') medical=$(echo "$FN" | jq -c .medical)"
for M in "What is my total balance?" "Show my monthly expenses by category" "How much did I spend on medical?" "Out-of-pocket vs insurer paid" "Which claim payouts did I receive?"; do
  R=$(curl "${H[@]}" "${A[@]}" -X POST "$API/ai/chat" -d "$(jq -nc --arg m "$M" '{message:$m}')")
  echo "$R" | j '.intent' | grep -q FINANCE || fail "chat finance '$M': $R"
  ok "ai/chat '$M' → [$(echo "$R" | j '.intent')] cards=$(echo "$R" | jq -r '[.cards[].type]|join(",")') chips=$(echo "$R" | j '.suggestions|length') :: $(echo "$R" | j '.answer' | cut -c1-90)"
done
U1=$(curl -s -m 60 "${A[@]}" -F "document=@$DIR/e2e-assets/e2e-pharmacy-photo.jpg;type=application/octet-stream" -F type=PHARMACY_BILL "$API/claims/$CID/documents")
[ "$(echo "$U1" | j '.mimeType')" = image/jpeg ] && ok "upload field 'document' + octet-stream jpg → $(echo "$U1" | j '.validation.appStatus')" || fail "jpg upload: $U1"
U2=$(curl -s -m 60 "${A[@]}" -F "attachment=@$DIR/e2e-assets/e2e-pharmacy-photo.png" "$API/claims/$CID/documents")
[ "$(echo "$U2" | j '.mimeType')" = image/png ] && ok "upload field 'attachment' png → type=$(echo "$U2" | j '.type') $(echo "$U2" | j '.validation.appStatus')" || fail "png upload: $U2"
printf 'not a document' > "$DIR/e2e-assets/.bad.txt"
ok "bad type → $(curl -s -m 30 -o /dev/null -w '%{http_code}' "${A[@]}" -F "file=@$DIR/e2e-assets/.bad.txt;type=text/plain" "$API/claims/$CID/documents") · no file → $(curl -s -m 30 "${A[@]}" -F type=OTHER "$API/claims/$CID/documents" | j '.error.code')"
rm -f "$DIR/e2e-assets/.bad.txt"
PU=$(curl -s -m 60 "${A[@]}" -F "document=@$DIR/e2e-assets/e2e-hospital-bill.pdf;type=application/pdf" -F insurer="E2E Test Insurance (Demo)" -F policyNumber=E2E-TEST-0001 -F sumInsured=300000 -F startDate=2026-01-01 "$API/me/policies")
ok "policy PDF upload (field 'document') → $(echo "$PU" | jq -c '{policy:.policy.policyNumber,fileUrl:(.policy.fileUrl!=null),err:.error.code}')"

echo "== 7. dashboard (ops) sees it"
ok "GET /claims?search → $(curl "${H[@]}" "${O[@]}" "$API/claims?search=$CNO" | jq -r '.[0] | "\(.claimNumber) \(.status) docs=\(._count.documents) by \(.user.name)"')"
ok "overview totalClaims=$(curl "${H[@]}" "${O[@]}" "$API/analytics/overview" | j '.totalClaims')"
ok "activity on claim: $(curl "${H[@]}" "${O[@]}" "$API/activity?claimId=$CID&limit=50" | jq -r '[.items[].action]|reverse|join(" → ")')"
ok "ops bell: $(curl "${H[@]}" "${O[@]}" "$API/notifications/my" | jq -r --arg c "$CNO" '[.items[]|select(.title|contains($c))|.title]|join(" | ")')"
ok "users list has test user: $(curl "${H[@]}" "${O[@]}" "$API/users" | jq -r '.[]|select(.phone=="+91 90000 12345")|"\(.name) bank=\(.bank.accountNumberMasked)"')"

echo "== 8. ops approves + settles → customer sees settlement"
curl "${H[@]}" "${O[@]}" -X POST "$API/claims/$CID/decision" -d '{"decision":"APPROVE","note":"E2E test approval"}' | jq -r '"  approve → \(.status)"'
curl "${H[@]}" "${O[@]}" -X POST "$API/claims/$CID/decision" -d '{"decision":"SETTLE"}' | jq -r '"  settle → \(.status)"'
ok "customer settlement: $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/settlement" | jq -c '{isDemo,billAmount,approvedAmount,status,utr,deductions:[.deductions[]|"\(.label) \(.amount)"]}')"
ok "final stepper → $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/timeline" | jq -r '[.steps[]|"\(.label):\(.state)"]|join(" · ")')"
PDF="$DIR/e2e-assets/.summary-test.pdf"
PS=$(curl -s -m 90 -o "$PDF" -w '%{http_code} %{content_type}' "$API/claims/$CID/summary.pdf?token=$CT" || echo "curl-failed")
ok "summary.pdf → $PS $(wc -c < "$PDF" | tr -d ' ') bytes, header $(head -c 8 "$PDF")"
(cd "$DIR/.." && node -e "require('pdf-parse')(require('fs').readFileSync('$PDF')).then(d=>console.log('  ✔ summary.pdf parses: '+d.numpages+' page(s): '+d.text.replace(/\\s+/g,' ').slice(0,140)))") || echo "  ✘ pdf parse failed"
rm -f "$PDF"

kill $SSE_PID 2>/dev/null || true; sleep 0.3
ok "SSE: $(grep -c '^event: change' "$SSE_LOG") change events pushed to the ops stream during the run"
echo "TEST_CLAIM=$CNO"
if [ "${KEEP:-0}" != 1 ]; then echo "== 9. cleanup"; (cd "$DIR/.." && npx tsx scripts/cleanup-e2e.ts "$PHONE"); fi

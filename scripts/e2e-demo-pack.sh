#!/usr/bin/env bash
# Demo document pack E2E: logs in as the fixed demo customer (9999999999 / OTP 111000), files a claim and uploads
# demo-pack/01..07 in order through BASE (public tunnel by default). Ops raise the receipt query in between.
# Usage: BASE=https://<tunnel> ./scripts/e2e-demo-pack.sh      (KEEP=1 keeps the claim; otherwise only the claim is removed)
set -euo pipefail
BASE="${BASE:-https://role-budgets-genuine-maps.trycloudflare.com}"
API="$BASE/api"; PHONE="9999999999"; OTP="111000"
DIR="$(cd "$(dirname "$0")" && pwd)"; PACK="$DIR/../demo-pack"
ok(){ printf '  \033[32m✔\033[0m %s\n' "$*"; }
fail(){ printf '  \033[31m✘ %s\033[0m\n' "$*"; exit 1; }
j(){ jq -r "$1"; }
H=(-s -m 90 -H 'content-type: application/json')
(cd "$DIR/.." && npx tsx scripts/cleanup-e2e.ts "$PHONE" --claims-only >/dev/null)

echo "== 1. demo customer login"
V=$(curl "${H[@]}" -X POST "$API/auth/otp/verify" -d "{\"phone\":\"$PHONE\",\"otp\":\"$OTP\"}")
CT=$(echo "$V" | j '.token'); [ "$CT" != null ] || fail "otp: $V"; A=(-H "Authorization: Bearer $CT")
ok "OTP login → $(echo "$V" | j '.user.name') $(echo "$V" | j '.user.phone') needsProfile=$(echo "$V" | j '.needsProfile')"
POL=$(curl "${H[@]}" "${A[@]}" "$API/me/policies" | jq -c '.[] | select(.policyNumber=="CS-DEMO-POL-2026")')
PID=$(echo "$POL" | j '.id'); [ -n "$PID" ] || fail "demo policy missing"
ok "policy $(echo "$POL" | j '.policyNumber'): SI ₹$(echo "$POL" | j '.sumInsured'), room ₹$(echo "$POL" | j '.roomRentLimit')/day, co-pay $(echo "$POL" | j '.coPayPercent')%"
OT=$(curl "${H[@]}" -X POST "$API/auth/login" -d '{"email":"ops@claimsaathi.demo","password":"demo123"}' | j '.token'); O=(-H "Authorization: Bearer $OT")

echo "== 2. create claim (minimal details; the documents fill the rest)"
C=$(curl "${H[@]}" "${A[@]}" -X POST "$API/claims" -d "{\"policyId\":\"$PID\",\"type\":\"REIMBURSEMENT\",\"hospital\":\"Sunrise Multispeciality Hospital\",\"reason\":\"Stomach pain\",\"consentOtp\":\"$OTP\"}")
CID=$(echo "$C" | j '.id'); CNO=$(echo "$C" | j '.claimNumber'); [ "$CID" != null ] || fail "claim: $C"; ok "POST /claims → $CNO"
ok "checklist: $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/checklist" | jq -r '[.items[]|"\(.type)\(if .required then "*" else "" end)"]|join(" ")')"

echo "== 3. upload 01-06 in order (no type sent; 02 sent with a wrong type; 06 is a re-saved copy → marker match)"
RESAVED="$(mktemp -d)/06_Lab_Report_copy.pdf"; cp "$PACK/06_Lab_Report.pdf" "$RESAVED"; printf '\n%% re-saved copy\n' >> "$RESAVED"
for F in 01_Health_Card 02_ID_Proof_Aadhaar 03_Claim_Form 04_Hospital_Bill 05_Discharge_Summary 06_Lab_Report; do
  FILE="$PACK/$F.pdf"; EXTRA=(); [ "$F" = 02_ID_Proof_Aadhaar ] && EXTRA=(-F "type=OTHER"); [ "$F" = 06_Lab_Report ] && FILE="$RESAVED"
  D=$(curl -s -m 90 "${A[@]}" -F "file=@$FILE;type=application/pdf" ${EXTRA[@]+"${EXTRA[@]}"} "$API/claims/$CID/documents")
  [ "$(echo "$D" | j '.status')" = VERIFIED ] || fail "$F: $D"
  ok "$F → $(echo "$D" | jq -r '"\(.type) \(.status) conf=\(.validation.confidence) by=\(.validationResult.demoPack.matchedBy) checks=\([.validation.checks[]|select(.passed==false)]|length) failed · claim \(.claimStatus) · \(.checklist.progress.verified)/\(.checklist.progress.required) verified"')"
done
CL=$(curl "${H[@]}" "${A[@]}" "$API/claims/$CID")
ok "claim filled from docs: $(echo "$CL" | jq -c '{status,hospital,reason,treatment,admissionDate:(.admissionDate[0:10]),dischargeDate:(.dischargeDate[0:10]),billAmount,items:(.billItems|length),roomRentPerDay}')"
[ "$(echo "$CL" | j '.status')" = UNDER_REVIEW ] || fail "expected UNDER_REVIEW"
ok "warnings: $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/checklist" | jq -r '.warnings|join(" | ")')"
ok "settlement preview: $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/settlement" | jq -c '{status,isDemo,billAmount,approvedAmount,deductions:[.deductions[]|"\(.label) \(.amount)"]}')"
ok "AI flag: $(curl "${H[@]}" "${O[@]}" "$API/activity?claimId=$CID&limit=50" | jq -r '[.items[]|select(.action=="RECEIPT_REQUIRED")][0].reason' | cut -c1-120)"
ok "ops bell: $(curl "${H[@]}" "${O[@]}" "$API/notifications/my" | jq -r --arg c "$CNO" '[.items[]|select(.title|contains($c))|.title][0]')"

echo "== 4. ops raise the receipt query (dashboard API)"
Q=$(curl "${H[@]}" "${O[@]}" -X POST "$API/claims/$CID/queries" -d '{"message":"Please upload the payment receipt for the hospital bill of ₹84,200.","requestedDocType":"PAYMENT_RECEIPT"}')
QID=$(echo "$Q" | j '.id'); ok "query $QID → claim $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID" | j '.status')"

echo "== 5. customer replies with 07_Payment_Receipt.pdf"
R=$(curl -s -m 90 "${A[@]}" -F "file=@$PACK/07_Payment_Receipt.pdf;type=application/pdf" -F "response=Receipt attached" "$API/queries/$QID/respond")
ok "reply → query $(echo "$R" | j '.status'), $(echo "$R" | jq -r '"\(.document.type) \(.document.status) · claim \(.document.claimStatus) · \(.document.checklist.progress.verified)/\(.document.checklist.progress.required) verified, complete=\(.document.checklist.complete)"')"
ok "settlement: $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/settlement" | jq -c '{status,approvedAmount}') · AI suggestion: $(curl "${H[@]}" "${O[@]}" "$API/claims/$CID" | jq -c '.aiSuggestion|{decision,amount}')"

echo "== 6. ops approve + settle"
curl "${H[@]}" "${O[@]}" -X POST "$API/claims/$CID/decision" -d '{"decision":"APPROVE","note":"Demo pack approval"}' | jq -r '"  approve → \(.status)"'
curl "${H[@]}" "${O[@]}" -X POST "$API/claims/$CID/decision" -d '{"decision":"SETTLE"}' | jq -r '"  settle → \(.status)"'
ok "customer settlement: $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/settlement" | jq -c '{status,billAmount,approvedAmount,utr}')"
ok "stepper: $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/timeline" | jq -r '[.steps[]|"\(.label):\(.state)"]|join(" · ")')"
echo "TEST_CLAIM=$CNO"
if [ "${KEEP:-0}" != 1 ]; then echo "== 7. cleanup (claim only; demo customer + policy kept)"; (cd "$DIR/.." && npx tsx scripts/cleanup-e2e.ts "$PHONE" --claims-only); fi

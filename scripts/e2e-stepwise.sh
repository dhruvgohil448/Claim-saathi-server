#!/usr/bin/env bash
# Step-wise demo E2E for ANY user: new phone → OTP 111000 → empty home → link policy with empty values → claim →
# upload 7 ARBITRARY files one by one (Nth upload = demo doc N) → receipt query → ops approve + settle (₹62,748).
# Usage: BASE=https://<tunnel> PHONE=9000012345 ./scripts/e2e-stepwise.sh   (KEEP=1 keeps the test user)
set -euo pipefail
BASE="${BASE:-http://localhost:5050}"; API="$BASE/api"; PHONE="${PHONE:-9000012345}"; OTP="111000"
DIR="$(cd "$(dirname "$0")" && pwd)"
ok(){ printf '  \033[32m✔\033[0m %s\n' "$*"; }
fail(){ printf '  \033[31m✘ %s\033[0m\n' "$*"; exit 1; }
j(){ jq -r "$1"; }
H=(-s -m 90 -H 'content-type: application/json')
(cd "$DIR/.." && npx tsx scripts/cleanup-e2e.ts "$PHONE" >/dev/null)
TMP="$(mktemp -d)"
PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
for i in 1 2 3 4 5 6 7; do echo "$PNG" | base64 -d > "$TMP/photo_$i.png"; printf 'random-%s-%s' "$i" "$RANDOM$RANDOM" >> "$TMP/photo_$i.png"; done

echo "== 1. new user OTP login → empty home"
curl "${H[@]}" -X POST "$API/auth/otp/send" -d "{\"phone\":\"$PHONE\"}" >/dev/null || true
V=$(curl "${H[@]}" -X POST "$API/auth/otp/verify" -d "{\"phone\":\"$PHONE\",\"otp\":\"$OTP\"}")
CT=$(echo "$V" | j '.token'); [ "$CT" != null ] || fail "otp: $V"; A=(-H "Authorization: Bearer $CT")
ok "login isNewUser=$(echo "$V" | j '.isNewUser') starterProvisioned=$(echo "$V" | j '.starterProvisioned')"
curl "${H[@]}" "${A[@]}" -X PUT "$API/me/profile" -d '{"name":"Asha Mehta","dob":"1992-05-10","gender":"female","city":"Mumbai"}' >/dev/null || true
NC=$(curl "${H[@]}" "${A[@]}" "$API/claims" | jq 'length'); NN=$(curl "${H[@]}" "${A[@]}" "$API/notifications" | jq '(.items // .) | length')
[ "$NC" = 0 ] || fail "home not empty: $NC claims"; ok "home: $NC claims, $NN notifications, policies=$(curl "${H[@]}" "${A[@]}" "$API/me/policies" | jq 'length')"

echo "== 2. link policy with empty values → fixed demo policy"
P=$(curl "${H[@]}" "${A[@]}" -X POST "$API/me/policies" -d '{}')
PID=$(echo "$P" | j '.policy.id'); [ "$PID" != null ] || fail "policy: $P"
ok "$(echo "$P" | jq -r '.policy|"\(.policyNumber): SI ₹\(.sumInsured), room ₹\(.roomRentLimit)/day, co-pay \(.coPayPercent)%"')"
OT=$(curl "${H[@]}" -X POST "$API/auth/login" -d '{"email":"ops@claimsaathi.demo","password":"demo123"}' | j '.token'); O=(-H "Authorization: Bearer $OT")

echo "== 3. create claim"
C=$(curl "${H[@]}" "${A[@]}" -X POST "$API/claims" -d "{\"policyId\":\"$PID\",\"type\":\"REIMBURSEMENT\",\"hospital\":\"Sunrise Multispeciality Hospital\",\"reason\":\"Stomach pain\",\"consentOtp\":\"$OTP\"}")
CID=$(echo "$C" | j '.id'); CNO=$(echo "$C" | j '.claimNumber'); [ "$CID" != null ] || fail "claim: $C"; ok "POST /claims → $CNO"
ok "dashboard sees it: $(curl "${H[@]}" "${O[@]}" "$API/claims?search=$CNO" | jq -r '.[0]|"\(.claimNumber) \(.status) \(.patientName)"')"

echo "== 4. upload 7 arbitrary photos one by one"
for i in 1 2 3 4 5 6 7; do
  if [ $i = 7 ]; then
    for k in $(seq 1 20); do QID=$(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/queries" | jq -r '[.[]|select(.status=="OPEN")][0].id'); [ "$QID" != null ] && break; sleep 1; done
    [ "$QID" != null ] || fail "no receipt query raised"
    ok "query raised: $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/queries" | jq -r '[.[]|select(.status=="OPEN")][0].message' | cut -c1-80) · claim $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID" | j .status)"
    R=$(curl -s -m 90 "${A[@]}" -F "file=@$TMP/photo_$i.png;type=image/png" -F "response=Receipt attached" "$API/queries/$QID/respond"); D=$(echo "$R" | jq '.document')
  else
    D=$(curl -s -m 90 "${A[@]}" -F "file=@$TMP/photo_$i.png;type=image/png" "$API/claims/$CID/documents")
  fi
  [ "$(echo "$D" | j '.status')" = VERIFIED ] || fail "photo $i: $D"
  CL=$(curl "${H[@]}" "${A[@]}" "$API/claims/$CID")
  ok "photo_$i → $(echo "$D" | jq -r '"\(.type) n=\(.validationResult.demoPack.n) by=\(.validationResult.demoPack.matchedBy)"') · claim $(echo "$CL" | jq -c '{status,hospital,reason,billAmount,adm:(.admissionDate//""|.[0:10])}')"
done
sleep 1
ok "settlement estimate: $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/settlement" | jq -c '{status,approvedAmount}') · claim $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID" | j .status)"

echo "== 5. ops approve + settle"
curl "${H[@]}" "${O[@]}" -X POST "$API/claims/$CID/decision" -d '{"decision":"APPROVE"}' | jq -r '"  approve → \(.status)"'
curl "${H[@]}" "${O[@]}" -X POST "$API/claims/$CID/decision" -d '{"decision":"SETTLE"}' | jq -r '"  settle → \(.status)"'
S=$(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/settlement")
ok "settlement: $(echo "$S" | jq -c '{status,billAmount,approvedAmount,utr,deductions:[.deductions[]|"\(.label) \(.amount)"],coPayAmount}')"
[ "$(echo "$S" | j .approvedAmount)" = 62748 ] || fail "expected 62748"
ok "timeline: $(curl "${H[@]}" "${A[@]}" "$API/claims/$CID/timeline" | jq -r '[.events[]|.title]|join(" → ")')"
ok "alerts: $(curl "${H[@]}" "${A[@]}" "$API/notifications" | jq -r '[(.items // .)[]|.title]|reverse|join(" | ")')"
if [ "${KEEP:-0}" != 1 ]; then (cd "$DIR/.." && npx tsx scripts/cleanup-e2e.ts "$PHONE"); fi
echo "PASS"

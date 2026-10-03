/**
 * AI Claim Copilot: payout prediction, bill analysis and the ops AI summary.
 * Deterministic: everything is computed by the same rules engine that settles the claim, so the
 * prediction always matches the final settlement (demo: ₹84,200 → ₹62,748).
 */
import * as tools from '../tools';
import { BillItem, calculateSettlementRules, categorize, checkCoverageRules } from './rules';
import { DEMO_ALL, DEMO_BILL_ITEMS, DEMO_GATING, isDemoPackClaim } from '../demo/demoDocs';
import { docLabel, inr } from '../utils/format';

type FullClaim = tools.FullClaim;
const ASSOCIATED = ['ROOM', 'NURSING', 'PROFESSIONAL', 'OT'];
const pct = (n: number) => Math.round(n * 100);

function billSource(c: FullClaim): { items: BillItem[] | null; source: 'hospital_bill' | 'demo_estimate' | 'claim_amount' } {
  const own = (c.billItems as unknown as BillItem[] | null) ?? null;
  if (own && own.length) return { items: own.map((i) => ({ ...i, category: i.category ?? categorize(i.description) })), source: 'hospital_bill' };
  if (isDemoPackClaim(c)) return { items: DEMO_BILL_ITEMS, source: 'demo_estimate' };
  return { items: null, source: 'claim_amount' };
}

const hasDoc = (c: FullClaim, type: string) => c.documents.some((d) => d.type === type && d.status !== 'INVALID');
const billUploaded = (c: FullClaim) => hasDoc(c, 'HOSPITAL_BILL') || !!((c.billItems as unknown as BillItem[] | null)?.length);

function hiReason(label: string, d: { amount: number }, rules: { roomRentLimit: number; coPayPercent: number }, roomRate?: number | null) {
  const l = label.toLowerCase();
  if (l.startsWith('non-payable')) return `रजिस्ट्रेशन / एडमिशन शुल्क (${inr(d.amount)}) IRDAI की नॉन-पेएबल सूची में हैं, इसलिए यह राशि नहीं मिलेगी।`;
  if (l.startsWith('proportionate')) return `कमरे का किराया ${roomRate ? inr(roomRate) : ''}/दिन है, जबकि पॉलिसी सीमा ${inr(rules.roomRentLimit)}/दिन है। इसलिए कमरा, नर्सिंग, OT और डॉक्टर फीस अनुपात में कम मिलेगी (${inr(d.amount)} की कटौती)।`;
  if (l.startsWith('co-pay')) return `आपकी पॉलिसी में ${rules.coPayPercent}% को-पे है, यानी स्वीकार्य राशि का ${rules.coPayPercent}% (${inr(d.amount)}) आपको खुद देना होगा।`;
  if (l.startsWith('icu')) return `ICU का खर्च पॉलिसी की प्रतिदिन सीमा से ज़्यादा है (${inr(d.amount)} की कटौती)।`;
  if (l.includes('waiting')) return 'इलाज पॉलिसी की वेटिंग पीरियड के अंदर है, इसलिए यह क्लेम अभी देय नहीं है।';
  return `${label}: ${inr(d.amount)} की कटौती।`;
}

export interface RiskFlag { code: string; severity: 'high' | 'medium' | 'low'; message: string; messageHi: string }

function riskFlags(c: FullClaim, roomRate: number | null, limit: number, waiting: string | null): RiskFlag[] {
  const f: RiskFlag[] = [];
  if (waiting) f.push({ code: 'WAITING_PERIOD', severity: 'high', message: waiting, messageHi: 'इलाज वेटिंग पीरियड के अंदर है, क्लेम अस्वीकार हो सकता है।' });
  if (roomRate && roomRate > limit) f.push({ code: 'ROOM_RENT_ABOVE_LIMIT', severity: 'medium', message: `Room rent ${inr(roomRate)}/day is above the ${inr(limit)}/day limit, so associated charges are cut proportionately.`, messageHi: `कमरे का किराया ${inr(roomRate)}/दिन, सीमा ${inr(limit)}/दिन से ज़्यादा है।` });
  const need = isDemoPackClaim(c) ? DEMO_ALL : ['CLAIM_FORM', 'DISCHARGE_SUMMARY', 'HOSPITAL_BILL'];
  const missing = need.filter((t) => !hasDoc(c, t));
  const gatingMissing = missing.filter((t) => t !== 'PAYMENT_RECEIPT');
  if (gatingMissing.length) f.push({ code: 'DOCUMENTS_PENDING', severity: 'medium', message: `${gatingMissing.length} document(s) still pending: ${gatingMissing.map((t) => docLabel(t)).join(', ')}.`, messageHi: `${gatingMissing.length} दस्तावेज़ अभी बाकी हैं।` });
  if (missing.includes('PAYMENT_RECEIPT')) f.push({ code: 'PAYMENT_RECEIPT_MISSING', severity: 'low', message: 'Hospital payment receipt not uploaded yet; the insurer needs it to reimburse.', messageHi: 'अस्पताल की पेमेंट रसीद अभी अपलोड नहीं हुई है।' });
  const bad = c.documents.filter((d) => d.status === 'INVALID');
  if (bad.length) f.push({ code: 'DOCUMENT_REJECTED', severity: 'high', message: `${bad.length} document(s) failed verification: ${bad.map((d) => docLabel(d.type)).join(', ')}.`, messageHi: `${bad.length} दस्तावेज़ सत्यापन में फेल हुए।` });
  if (c.queries.some((q) => q.status === 'OPEN')) f.push({ code: 'OPEN_QUERY', severity: 'medium', message: 'Insurer query is open and waiting for a reply.', messageHi: 'बीमा कंपनी का सवाल खुला है, जवाब देना बाकी है।' });
  return f;
}

export async function prediction(claimId: string) {
  const c = await tools.loadClaim(claimId);
  const rules = tools.policyRules(c.policy);
  const { items, source } = billSource(c);
  const facts = { ...tools.claimFacts(c), billItems: items };
  const s = calculateSettlementRules(rules, facts);
  const cov = checkCoverageRules(rules, facts);
  const roomItem = (items || []).find((i) => i.category === 'ROOM');
  const roomRate = c.roomRentPerDay ?? roomItem?.rate ?? null;
  const flags = riskFlags(c, roomRate, rules.roomRentLimit, cov.waitingPeriodIssue);
  const confidence = c.settlement ? 0.97 : source === 'hospital_bill' ? 0.94 : source === 'demo_estimate' ? 0.86 : 0.72;
  const risk = flags.some((f) => f.severity === 'high') ? 'HIGH' : flags.some((f) => f.severity === 'medium') ? 'MEDIUM' : 'LOW';
  return {
    claimId: c.id, claimNumber: c.claimNumber,
    predictedPayout: s.approvedAmount, billAmount: s.billAmount, admissibleAmount: s.admissibleAmount, coPayAmount: s.coPayAmount,
    totalDeductions: s.billAmount - s.approvedAmount,
    confidence, confidenceLabel: `${pct(confidence)}% confident`,
    basis: source === 'hospital_bill' ? 'Based on your hospital bill and policy rules' : source === 'demo_estimate' ? 'Based on your policy rules and a typical bill for this treatment' : 'Based on the claimed amount and policy rules',
    headline: `Saathi predicts you will get ${inr(s.approvedAmount)} of ${inr(s.billAmount)}`,
    headlineHi: `साथी का अनुमान: आपको ${inr(s.billAmount)} में से लगभग ${inr(s.approvedAmount)} मिलेंगे`,
    deductions: s.deductions.map((d) => ({ label: d.label, amount: d.amount, reason: d.reason, reasonHi: hiReason(d.label, d, rules, roomRate), clause: d.clause ?? null })),
    rejectionRisk: risk, riskFlags: flags,
    explanation: s.explanation,
    tips: [
      ...(roomRate && roomRate > rules.roomRentLimit ? [`Next time choose a room within ${inr(rules.roomRentLimit)}/day to avoid the ${inr(s.deductions.find((d) => d.label.startsWith('Proportionate'))?.amount ?? 0)} proportionate cut.`] : []),
      ...(flags.some((f) => f.code === 'PAYMENT_RECEIPT_MISSING') ? ['Keep the hospital payment receipt ready; the insurer usually asks for it.'] : []),
    ],
    ai: 'deterministic-rules',
  };
}

export async function billAnalysis(claimId: string) {
  const c = await tools.loadClaim(claimId);
  const rules = tools.policyRules(c.policy);
  if (!billUploaded(c)) {
    return { claimId: c.id, claimNumber: c.claimNumber, available: false, message: 'Upload the hospital bill (document 4) and Saathi will analyse every line item.', messageHi: 'हॉस्पिटल बिल (दस्तावेज़ 4) अपलोड करें, साथी हर आइटम की जाँच करेगा।', items: [] };
  }
  const { items } = billSource(c);
  const list = items ?? [{ description: 'Hospitalisation expenses', qty: 1, rate: c.billAmount ?? c.estimatedAmount ?? 0, amount: c.billAmount ?? c.estimatedAmount ?? 0, category: 'OTHER' as const }];
  const room = list.find((i) => i.category === 'ROOM');
  const roomRate = c.roomRentPerDay ?? room?.rate ?? null;
  const ratio = roomRate && roomRate > rules.roomRentLimit ? rules.roomRentLimit / roomRate : 1;
  const out = list.map((i) => {
    const cat = i.category ?? categorize(i.description);
    if (cat === 'NON_PAYABLE') return { ...i, category: cat, status: 'NON_PAYABLE' as const, color: 'red', payableAmount: 0, deduction: i.amount,
      reason: 'Registration / admission charges (with gloves, admin kit, food) are on the IRDAI non-payable list.', reasonHi: 'रजिस्ट्रेशन / एडमिशन शुल्क IRDAI की नॉन-पेएबल सूची में है।' };
    if (ratio < 1 && ASSOCIATED.includes(cat)) {
      const pay = Math.round(i.amount * ratio);
      return { ...i, category: cat, status: 'PARTIAL' as const, color: 'amber', payableAmount: pay, deduction: i.amount - pay,
        reason: `Paid at ${pct(ratio)}% because the room (${inr(roomRate!)}/day) is above the ${inr(rules.roomRentLimit)}/day limit.`, reasonHi: `कमरा सीमा से महँगा है, इसलिए ${pct(ratio)}% ही मिलेगा।` };
    }
    return { ...i, category: cat, status: 'PAYABLE' as const, color: 'green', payableAmount: i.amount, deduction: 0, reason: 'Fully payable under your policy.', reasonHi: 'पॉलिसी में पूरा देय है।' };
  });
  const s = calculateSettlementRules(rules, { ...tools.claimFacts(c), billItems: list });
  const sum = (k: 'amount' | 'payableAmount') => out.reduce((a, i) => a + i[k], 0);
  const count = (st: string) => out.filter((i) => i.status === st).length;
  return {
    claimId: c.id, claimNumber: c.claimNumber, available: true, hospital: c.hospital,
    items: out,
    totals: { billed: sum('amount'), payableBeforeCoPay: sum('payableAmount'), nonPayable: out.filter((i) => i.status === 'NON_PAYABLE').reduce((a, i) => a + i.deduction, 0), proportionateCut: out.filter((i) => i.status === 'PARTIAL').reduce((a, i) => a + i.deduction, 0), coPay: s.coPayAmount, finalPayable: s.approvedAmount },
    counts: { payable: count('PAYABLE'), partial: count('PARTIAL'), nonPayable: count('NON_PAYABLE') },
    summary: `${out.length} items checked: ${count('PAYABLE')} fully payable, ${count('PARTIAL')} partly payable, ${count('NON_PAYABLE')} not payable. After ${rules.coPayPercent}% co-pay you get ${inr(s.approvedAmount)} of ${inr(sum('amount'))}.`,
    summaryHi: `${out.length} आइटम जाँचे गए: ${count('PAYABLE')} पूरे देय, ${count('PARTIAL')} आंशिक, ${count('NON_PAYABLE')} देय नहीं। ${rules.coPayPercent}% को-पे के बाद आपको ${inr(s.approvedAmount)} मिलेंगे।`,
    ai: 'deterministic-rules',
  };
}

export async function aiSummary(claimId: string) {
  const c = await tools.loadClaim(claimId);
  const p = await prediction(claimId);
  const docsDone = c.documents.filter((d) => d.status === 'VERIFIED').length;
  const need = isDemoPackClaim(c) ? DEMO_ALL.length : Math.max(docsDone, 6);
  const flags = p.riskFlags;
  const gatingMissing = isDemoPackClaim(c) ? DEMO_GATING.filter((t) => !hasDoc(c, t)) : [];
  const receiptMissing = flags.some((f) => f.code === 'PAYMENT_RECEIPT_MISSING');
  const openQuery = flags.some((f) => f.code === 'OPEN_QUERY');
  const high = flags.some((f) => f.severity === 'high');
  let recommendation: 'APPROVE' | 'RAISE_QUERY' | 'AWAIT_REPLY' | 'REVIEW' | 'SETTLED';
  let confidence: number; let action: string;
  if (c.status === 'SETTLED') { recommendation = 'SETTLED'; confidence = 0.99; action = `Settled: ${inr(c.settlement?.approvedAmount ?? p.predictedPayout)} paid.`; }
  else if (high) { recommendation = 'REVIEW'; confidence = 0.8; action = 'Manual review: a high-severity flag needs a specialist.'; }
  else if (openQuery) { recommendation = 'AWAIT_REPLY'; confidence = 0.88; action = 'Wait for the customer to reply to the open query.'; }
  else if (gatingMissing.length) { recommendation = 'RAISE_QUERY'; confidence = 0.84; action = `Ask for ${gatingMissing.map((t) => docLabel(t).toLowerCase()).join(', ')}.`; }
  else if (receiptMissing) { recommendation = 'RAISE_QUERY'; confidence = 0.91; action = 'Raise a query for the hospital payment receipt, then approve.'; }
  else { recommendation = 'APPROVE'; confidence = 0.93; action = `Approve ${inr(p.predictedPayout)} (bill ${inr(p.billAmount)} less ${inr(p.totalDeductions)} deductions).`; }
  const who = c.patientName || 'The patient';
  const ded = p.deductions.map((d) => `${d.label.toLowerCase()} ${inr(d.amount)}`).join(', ');
  const summary = `${who} was treated at ${c.hospital}${c.hospitalCity ? `, ${c.hospitalCity}` : ''} for ${c.reason}${c.treatment ? ` (${c.treatment})` : ''}. ` +
    `Claim ${c.claimNumber} is a ${c.claimType.toLowerCase()} claim for ${inr(p.billAmount)}; ${docsDone} of ${need} documents are verified. ` +
    `Applying policy ${c.policy.policyNumber} rules (${ded || 'no deductions'}), the expected payable is ${inr(p.predictedPayout)}. ` +
    (flags.length ? `Watch-outs: ${flags.map((f) => f.message.replace(/\.$/, '')).join('; ')}.` : 'No risk flags found.');
  return {
    claimId: c.id, claimNumber: c.claimNumber, status: c.status,
    summary, recommendation, recommendationLabel: { APPROVE: 'Approve', RAISE_QUERY: 'Raise query', AWAIT_REPLY: 'Await reply', REVIEW: 'Manual review', SETTLED: 'Settled' }[recommendation],
    confidence, nextAction: action,
    riskFlags: flags, riskLevel: p.rejectionRisk,
    predictedPayout: p.predictedPayout, billAmount: p.billAmount, deductions: p.deductions,
    documents: { verified: docsDone, required: need },
    ai: 'deterministic-rules',
  };
}

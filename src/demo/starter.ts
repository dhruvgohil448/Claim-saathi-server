/**
 * Starter dataset: every customer gets the same demo-template data on first OTP login (backfilled for existing
 * customers on startup / POST /api/admin/provision-starters). Rows carry isTemplate=true (and isDemo=true so the ops
 * dashboard can hide them with the Demo data switch); the customer's own app views always show them.
 * The fixed demo-pack customer (9999999999) is skipped so the document-pack flow stays clean.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { calculateSettlementRules, categorize, type BillItem } from '../services/rules';
import { inr } from '../utils/format';
import { DEMO_PACK } from './demoDocs';

const DAY = 86400000;
const day = (offset: number) => { const d = new Date(Date.now() + offset * DAY); d.setUTCHours(6, 0, 0, 0); return d; };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (d: Date, h: number) => new Date(d.getTime() + h * 3600000);
const items = (xs: [string, number, number][]): BillItem[] => xs.map(([description, qty, rate]) => ({ description, qty, rate, amount: qty * rate, category: categorize(description) }));
const sum = (xs: BillItem[]) => xs.reduce((s, i) => s + i.amount, 0);

export const STARTER_POLICY = {
  insurer: 'Saathi Health Insurance Co. Ltd. (Demo)', planName: 'Saathi Family Health Optima (Starter)', sumInsured: 500000, roomRentLimit: 4000, icuLimit: 8000, coPayPercent: 10,
  startDate: new Date('2026-01-01T00:00:00Z'), endDate: new Date('2026-12-31T00:00:00Z'),
  waitingPeriods: [{ name: 'Initial waiting period', months: 1, appliesTo: ['all illnesses except accidents'] }, { name: 'Specific illnesses', months: 24, appliesTo: ['cataract', 'hernia', 'joint replacement'] }, { name: 'Pre-existing diseases', months: 36, appliesTo: ['declared conditions'] }],
  subLimits: { cataractPerEye: 40000, ambulance: 2000 },
  exclusions: ['Cosmetic or aesthetic treatment', 'Non-medical items (registration, admission kits, toiletries)', 'Self-inflicted injury', 'Experimental treatment'],
  networkHospitals: ['Sunrise Multispeciality Hospital', 'HeartLine Cardiac Institute', 'CityLife Hospital', 'Lotus Care Hospital'],
  summary: 'Starter demo policy: hospital bills up to ₹5,00,000 a year. Room rent up to ₹4,000/day, ICU ₹8,000/day, 10% co-pay on every claim.',
};
export const STARTER_BANK = { accountNumber: '50100234564821', ifsc: 'HDFC0000123', bankName: 'HDFC Bank', verifiedAt: '2026-01-05T06:30:00.000Z', template: true };
const BANK_LABEL = 'HDFC Bank XXXX4821';

const REIMB_ITEMS = items([['Room rent - Private room', 4, 5000], ['Nursing charges', 4, 700], ['Consultant visits', 4, 1500], ['Medicines & IV fluids', 1, 9850], ['Lab investigations (CBC, NS1, platelets)', 1, 6400], ['Platelet transfusion', 1, 8500], ['Registration & admission charges', 1, 1000]]);
const PAST_ITEMS = items([['Room rent - Twin sharing', 3, 3500], ['Nursing charges', 3, 600], ['Consultant visits', 3, 1200], ['Medicines & IV fluids', 1, 4250], ['Lab investigations (Widal, CBC)', 1, 2150], ['Registration & admission charges', 1, 500]]);

const doc = (folder: string, file: string, type: string, name: string, amount: number | null, date: string) => ({
  type: type as never, fileName: file, fileUrl: `sample/${folder}/${file}`, mimeType: 'application/pdf', size: 40000, status: 'VERIFIED' as const, confidence: 0.95,
  validationResult: { valid: true, confidence: 0.95, detectedType: type, issues: [], checks: { readable: true, typeMatches: true, nameMatches: true, dateInPolicyPeriod: true, amountConsistent: amount != null ? true : null, hasSignature: true }, extracted: { name, date, amount, doctor: null, hospital: null, hasSignature: true }, fix: null, summary: 'Sample document from the starter dataset.', template: true } as Prisma.InputJsonValue,
  extractedData: { name, date, amount, template: true } as Prisma.InputJsonValue,
});

async function nextNumbers(n: number) {
  const last = await prisma.claim.findFirst({ where: { claimNumber: { startsWith: 'CLM-' } }, orderBy: { claimNumber: 'desc' } });
  const start = last ? Number(last.claimNumber.slice(4)) + 1 : 1001;
  return Array.from({ length: n }, (_, i) => `CLM-${start + i}`);
}

/** Claim numbers are global; retry on a unique clash (another claim created at the same moment). */
async function createNumbered(build: (n: string) => Prisma.ClaimUncheckedCreateInput) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const [n] = await nextNumbers(1);
    try { await prisma.claim.create({ data: build(n) }); return n; }
    catch (e) { if ((e as { code?: string }).code !== 'P2002') throw e; }
  }
  throw new Error('Could not allocate a claim number');
}

export const isStarterEligible = (u: { role: string; phone: string | null; email: string }) => u.role === 'CUSTOMER' && u.phone !== DEMO_PACK.phone && u.email !== DEMO_PACK.email;
const inflight = new Map<string, Promise<{ created: boolean; claims?: string[] }>>();

/** Idempotent: creates the starter policy, bank and 3 claims once per customer. */
export function provisionStarter(userId: string) {
  if (!inflight.has(userId)) inflight.set(userId, doProvision(userId).finally(() => inflight.delete(userId)));
  return inflight.get(userId)!;
}

async function doProvision(userId: string): Promise<{ created: boolean; claims?: string[] }> {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  if (!u || !isStarterEligible(u)) return { created: false };
  const existing = await prisma.policy.findFirst({ where: { userId, isTemplate: true }, include: { _count: { select: { claims: true } } } });
  if (existing && existing._count.claims > 0) return { created: false };
  if (existing) await prisma.policy.delete({ where: { id: existing.id } }); // half-provisioned earlier (no claims yet): rebuild
  const name = u.name && u.name !== 'New user' ? u.name : 'Policy holder';
  const policy = await prisma.policy.create({ data: { userId, isTemplate: true, policyNumber: `CS-STARTER-${userId.slice(-8).toUpperCase()}`, ...STARTER_POLICY, members: [{ name, relation: 'Self' }] } });
  if (!u.bankAccount) await prisma.user.update({ where: { id: userId }, data: { bankAccount: { ...STARTER_BANK, accountName: name } } });
  const rules = { sumInsured: policy.sumInsured, roomRentLimit: policy.roomRentLimit, icuLimit: policy.icuLimit, coPayPercent: policy.coPayPercent, startDate: policy.startDate };
  const common = { userId, policyId: policy.id, patientName: name, patientDetails: { relation: 'Self', template: true }, isTemplate: true, isDemo: true, isNetworkHospital: true };

  // 1. settled past claim
  const pastAdm = day(-150), pastDis = day(-147);
  const pastS = calculateSettlementRules(rules, { reason: 'Typhoid fever', treatment: 'IV antibiotics and supportive care', admissionDate: pastAdm, billItems: PAST_ITEMS, billAmount: sum(PAST_ITEMS), roomRentPerDay: 3500, days: 3 });
  const S = 'CLM-1001_Rahul_Sharma_SETTLED';
  const nPast = await createNumbered((nPast) => ({
      ...common, claimNumber: nPast, hospital: 'CityLife Hospital', hospitalCity: 'Navi Mumbai', reason: 'Typhoid fever', treatment: 'IV antibiotics and supportive care', claimType: 'REIMBURSEMENT', admissionType: 'EMERGENCY',
      admissionDate: pastAdm, dischargeDate: pastDis, roomType: 'Twin sharing', roomRentPerDay: 3500, days: 3, billAmount: pastS.billAmount, estimatedAmount: 20000, billItems: PAST_ITEMS as never, status: 'SETTLED', riskLevel: 'LOW', riskFlags: [],
      aiSummary: `Typhoid fever at CityLife Hospital, bill ${inr(pastS.billAmount)}.\nAll documents verified.\nPaid ${inr(pastS.approvedAmount)}.`, aiConfidence: 0.96, createdAt: at(pastDis, 30), lastActivityAt: at(pastDis, 24 * 9),
      documents: { create: [doc(S, '03_Claim_Form.pdf', 'CLAIM_FORM', name, pastS.billAmount, iso(pastDis)), doc(S, '05_Discharge_Summary.pdf', 'DISCHARGE_SUMMARY', name, null, iso(pastDis)), doc(S, '06_Final_Hospital_Bill.pdf', 'HOSPITAL_BILL', name, pastS.billAmount, iso(pastDis)), doc(S, '07_Pharmacy_Bill.pdf', 'PHARMACY_BILL', name, 4250, iso(pastDis)), doc(S, '08_Lab_Report.pdf', 'LAB_REPORT', name, null, iso(pastAdm)), doc(S, '09_Prescription.pdf', 'PRESCRIPTION', name, null, iso(pastDis))] },
      events: { create: [
        { status: 'CREATED', title: 'Claim submitted', description: 'Reimbursement claim for typhoid fever at CityLife Hospital (starter data).', actor: 'SYSTEM', createdAt: at(pastDis, 30) },
        { status: 'UNDER_REVIEW', title: 'Documents verified', description: 'All 6 documents verified by the AI.', actor: 'AI', createdAt: at(pastDis, 31) },
        { status: 'APPROVED', title: 'Claim approved', description: `Approved ${inr(pastS.approvedAmount)} of ${inr(pastS.billAmount)}${pastS.deductions.length ? ` after ${pastS.deductions.map((d) => d.label.toLowerCase()).join(', ')}` : ''}.`, actor: 'HUMAN', createdAt: at(pastDis, 24 * 4) },
        { status: 'SETTLED', title: 'Payment sent', description: `${inr(pastS.approvedAmount)} paid to ${BANK_LABEL}.`, actor: 'SYSTEM', createdAt: at(pastDis, 24 * 9) },
      ] },
      settlement: { create: { billAmount: pastS.billAmount, deductions: pastS.deductions as never, coPayAmount: pastS.coPayAmount, approvedAmount: pastS.approvedAmount, explanation: pastS.explanation, status: 'PAID', utr: `HDFCN${nPast.slice(4)}${userId.slice(-6).toUpperCase()}`, paidAt: at(pastDis, 24 * 9) } },
  }));

  // 2. reimbursement under review (docs verified, room above limit, bill above estimate)
  const rAdm = day(-12), rDis = day(-8);
  const rS = calculateSettlementRules(rules, { reason: 'Dengue fever with low platelets', treatment: 'IV fluids, platelet transfusion', admissionDate: rAdm, billItems: REIMB_ITEMS, billAmount: sum(REIMB_ITEMS), roomRentPerDay: 5000, days: 4 });
  const R = 'CLM-1007_Vikram_Singh_UNDER_REVIEW';
  const nReimb = await createNumbered((nReimb) => ({
      ...common, claimNumber: nReimb, hospital: 'Sunrise Multispeciality Hospital', hospitalCity: 'Mumbai', reason: 'Dengue fever with low platelets', treatment: 'IV fluids, platelet transfusion', claimType: 'REIMBURSEMENT', admissionType: 'EMERGENCY',
      admissionDate: rAdm, dischargeDate: rDis, roomType: 'Private room', roomRentPerDay: 5000, days: 4, billAmount: rS.billAmount, estimatedAmount: 45000, billItems: REIMB_ITEMS as never, status: 'UNDER_REVIEW', riskLevel: 'MEDIUM', riskFlags: ['ROOM_RENT_ABOVE_CAP'],
      aiSummary: `Dengue fever at Sunrise Multispeciality Hospital, bill ${inr(rS.billAmount)}.\nRoom ₹5,000/day is above the ₹4,000 limit.\nEstimated payable ${inr(rS.approvedAmount)}.`, aiSuggestion: { decision: 'PARTIAL_APPROVE', amount: rS.approvedAmount, reason: 'Proportionate deduction for room rent above the limit, plus 10% co-pay.' }, aiConfidence: 0.92,
      createdAt: at(rDis, 26), lastActivityAt: day(-2),
      documents: { create: [doc(R, '03_Claim_Form.pdf', 'CLAIM_FORM', name, rS.billAmount, iso(rDis)), doc(R, '05_Discharge_Summary.pdf', 'DISCHARGE_SUMMARY', name, null, iso(rDis)), doc(R, '06_Final_Hospital_Bill.pdf', 'HOSPITAL_BILL', name, rS.billAmount, iso(rDis)), doc(R, '07_Pharmacy_Bill.pdf', 'PHARMACY_BILL', name, 9850, iso(rDis)), doc(R, '08_Lab_Report.pdf', 'LAB_REPORT', name, null, iso(rAdm)), doc(R, '09_Prescription.pdf', 'PRESCRIPTION', name, null, iso(rDis))] },
      events: { create: [
        { status: 'CREATED', title: 'Claim submitted', description: 'Reimbursement claim for dengue fever at Sunrise Multispeciality Hospital (starter data).', actor: 'SYSTEM', createdAt: at(rDis, 26) },
        { status: 'DOCS_PENDING', title: 'Documents requested', description: 'Waiting for claim form, discharge summary, bills, lab report and prescription.', actor: 'AI', createdAt: at(rDis, 27) },
        { status: 'UNDER_REVIEW', title: 'All documents verified', description: `AI verified 6 documents. Estimated payable ${inr(rS.approvedAmount)}.`, actor: 'AI', createdAt: day(-2) },
      ] },
      settlement: { create: { billAmount: rS.billAmount, deductions: rS.deductions as never, coPayAmount: rS.coPayAmount, approvedAmount: rS.approvedAmount, explanation: rS.explanation, status: 'ESTIMATED' } },
  }));

  // 3. cashless pre-auth submitted (planned admission in 3 days)
  const pAdm = day(3);
  const pS = calculateSettlementRules(rules, { reason: 'Coronary artery disease, planned angiography', treatment: 'Coronary angiography (CAG)', admissionDate: pAdm, estimatedAmount: 48000, roomRentPerDay: 4000, days: 2 });
  const P = 'CLM-1008_Anjali_Desai_PREAUTH_SUBMITTED';
  const nPre = await createNumbered((nPre) => ({
      ...common, claimNumber: nPre, hospital: 'HeartLine Cardiac Institute', hospitalCity: 'Mumbai', reason: 'Coronary artery disease, planned angiography', treatment: 'Coronary angiography (CAG)', claimType: 'CASHLESS', admissionType: 'PLANNED',
      admissionDate: pAdm, roomType: 'Single AC', roomRentPerDay: 4000, days: 2, estimatedAmount: 48000, status: 'PREAUTH_SUBMITTED', riskLevel: 'LOW', riskFlags: [],
      aiSummary: `Planned coronary angiography at HeartLine Cardiac Institute, estimate ${inr(48000)}.\nNetwork hospital, cashless eligible.\nEstimated approval ${inr(pS.approvedAmount)}.`, aiSuggestion: { decision: 'APPROVE', amount: pS.approvedAmount, reason: 'Within limits; 10% co-pay applies.' }, aiConfidence: 0.94,
      createdAt: day(-1), lastActivityAt: new Date(),
      documents: { create: [doc(P, '01_Health_eCard.pdf', 'HEALTH_CARD', name, null, iso(day(-1))), doc(P, '04_PreAuth_Request.pdf', 'PREAUTH_FORM', name, 48000, iso(day(-1))), doc(P, '05_Doctor_Estimate_Letter.pdf', 'DOCTOR_ESTIMATE', name, 48000, iso(day(-1)))] },
      events: { create: [
        { status: 'CREATED', title: 'Pre-auth request created', description: 'Cashless pre-authorisation for a planned coronary angiography (starter data).', actor: 'SYSTEM', createdAt: day(-1) },
        { status: 'PREAUTH_SUBMITTED', title: 'Pre-auth sent to the TPA', description: `AI filled the pre-auth form and sent it with the doctor's estimate of ${inr(48000)}.`, actor: 'AI', createdAt: new Date() },
      ] },
      settlement: { create: { billAmount: pS.billAmount, deductions: pS.deductions as never, coPayAmount: pS.coPayAmount, approvedAmount: pS.approvedAmount, explanation: pS.explanation, status: 'ESTIMATED' } },
  }));

  const claims = await prisma.claim.findMany({ where: { userId, isTemplate: true }, select: { id: true, claimNumber: true } });
  const id = (n: string) => claims.find((c) => c.claimNumber === n)!.id;
  await prisma.notification.createMany({ data: [
    { userId, type: 'INFO', title: 'Welcome to Claim Saathi', body: 'We added a sample policy, bank account and three sample claims so you can explore the app. Your own claims appear here too.', createdAt: day(-1) },
    { userId, claimId: id(nPast), type: 'SUCCESS', title: `${inr(pastS.approvedAmount)} paid for ${nPast}`, body: `Your typhoid claim was settled to ${BANK_LABEL}.`, read: true, createdAt: at(pastDis, 24 * 9) },
    { userId, claimId: id(nReimb), type: 'WARNING', title: `⚠️ Room rent above limit on ${nReimb}`, body: `Room ₹5,000/day is above your ₹4,000/day limit, so room-linked charges are paid at 80%. Estimated payable ${inr(rS.approvedAmount)} of ${inr(rS.billAmount)}.`, createdAt: day(-2) },
    { userId, claimId: id(nPre), type: 'INFO', title: `Pre-auth submitted for ${nPre}`, body: `Cashless request of ${inr(48000)} sent to the TPA for your angiography at HeartLine Cardiac Institute.`, createdAt: new Date() },
  ] });
  await prisma.activityLog.createMany({ data: [
    { claimId: id(nReimb), actor: 'AI', action: 'DOC_VERIFIED', reason: 'Starter data: 6 sample documents verified.', confidence: 0.95 },
    { claimId: id(nReimb), actor: 'AI', action: 'SETTLEMENT_CALCULATED', reason: rS.explanation, confidence: 0.97 },
    { claimId: id(nPre), actor: 'AI', action: 'PREAUTH_SUBMITTED', reason: 'Starter data: pre-auth sent to the TPA.', confidence: 0.92 },
  ] });
  return { created: true, claims: [nPre, nReimb, nPast] };
}

/** Keep the starter rows in sync when the customer sets their real name. */
export async function renameStarterPatient(userId: string, oldName: string, newName: string) {
  if (!newName || oldName === newName) return;
  await prisma.claim.updateMany({ where: { userId, isTemplate: true, patientName: { in: [oldName, 'Policy holder'] } }, data: { patientName: newName } });
  await prisma.policy.updateMany({ where: { userId, isTemplate: true }, data: { members: [{ name: newName, relation: 'Self' }] } });
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { bankAccount: true } });
  const b = u?.bankAccount as Record<string, unknown> | null;
  if (b?.template) await prisma.user.update({ where: { id: userId }, data: { bankAccount: { ...b, accountName: newName } as Prisma.InputJsonValue } });
}

export async function backfillStarters() {
  const users = await prisma.user.findMany({ where: { role: 'CUSTOMER', policies: { none: { isTemplate: true } } }, select: { id: true, role: true, phone: true, email: true } });
  let provisioned = 0;
  for (const u of users.filter(isStarterEligible)) if ((await provisionStarter(u.id)).created) provisioned++;
  return { checked: users.length, provisioned };
}

/** Prefill values for Start Claim ("Use sample data"). */
export async function demoTemplates(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const policies = await prisma.policy.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { id: true, policyNumber: true, isTemplate: true } });
  const pack = u.phone === DEMO_PACK.phone;
  const policy = (pack ? policies.find((p) => p.id === DEMO_PACK.policyId) : policies.find((p) => !p.isTemplate)) ?? policies[0] ?? null;
  const name = u.name && u.name !== 'New user' ? u.name : 'Policy holder';
  const age = u.dob ? Math.floor((Date.now() - u.dob.getTime()) / (365.25 * DAY)) : 35;
  const patient = { patientName: name, patientDetails: { age, gender: (u.gender ?? 'MALE').toUpperCase(), relation: 'Self' } };
  const policyId = policy?.id ?? null;
  return {
    policyId, policyNumber: policy?.policyNumber ?? null,
    preauth: { type: 'PREAUTH', claimType: 'CASHLESS', policyId, hospital: 'HeartLine Cardiac Institute', hospitalCity: 'Mumbai', isNetworkHospital: true, reason: 'Coronary artery disease, planned angiography', treatment: 'Coronary angiography (CAG)', admissionType: 'PLANNED', admissionDate: iso(day(5)), days: 2, roomType: 'Single AC', roomRentPerDay: 4000, estimatedAmount: 48000, ...patient },
    reimbursement: pack
      ? { type: 'REIMBURSEMENT', claimType: 'REIMBURSEMENT', policyId, hospital: DEMO_PACK.hospital, hospitalCity: DEMO_PACK.hospitalCity, isNetworkHospital: true, reason: 'Acute appendicitis', treatment: 'Laparoscopic appendectomy', admissionType: 'EMERGENCY', admissionDate: '2026-09-24', dischargeDate: '2026-09-27', days: 3, roomType: 'Single AC room', roomRentPerDay: 5000, estimatedAmount: 80000, billAmount: 84200, ...patient }
      : { type: 'REIMBURSEMENT', claimType: 'REIMBURSEMENT', policyId, hospital: 'Sunrise Multispeciality Hospital', hospitalCity: 'Mumbai', isNetworkHospital: true, reason: 'Dengue fever', treatment: 'IV fluids and platelet monitoring', admissionType: 'EMERGENCY', admissionDate: iso(day(-6)), dischargeDate: iso(day(-2)), days: 4, roomType: 'Private room', roomRentPerDay: 4500, estimatedAmount: 40000, billAmount: 42800, ...patient },
    consentOtp: '111000',
    note: 'Sample values served by the server for the "Use sample data" button. Amount warnings come from POST /api/claims/preview.',
  };
}

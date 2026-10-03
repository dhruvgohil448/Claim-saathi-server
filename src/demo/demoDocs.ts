/**
 * Fixed demo document pack (demo-pack/01..07 PDFs). Each file is recognised by the SHA-256 of its bytes, or by the
 * "CS-DEMO-DOC-0N" marker printed on it (so renamed / re-saved copies still match). A recognised file skips the
 * mock OCR checker and gets the predetermined extraction + validation below, exactly as printed on the document.
 */
import { createHash } from 'crypto';
import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient } from '@prisma/client';
import type { DocValidation } from '../services/ai.service';
import type { BillItem } from '../services/rules';

export const DEMO_PACK = {
  phoneDigits: '9999999999',
  phone: '+91 99999 99999',
  userId: 'demo-pack-user',
  email: 'rohan.verma@claimsaathi.demo',
  name: 'Rohan Verma',
  policyId: 'demo-pack-policy',
  policyNumber: 'CS-DEMO-POL-2026',
  hospital: 'Sunrise Multispeciality Hospital',
  hospitalCity: 'Mumbai',
};
/** Documents that must be verified before the claim goes to review (the receipt is requested by ops afterwards). */
export const DEMO_GATING = ['HEALTH_CARD', 'ID_PROOF', 'CLAIM_FORM', 'HOSPITAL_BILL', 'DISCHARGE_SUMMARY', 'LAB_REPORT'];
export const DEMO_ALL = [...DEMO_GATING, 'PAYMENT_RECEIPT'];
/** Step-wise demo flow: Rohan's demo-pack policy AND every claim filed from the app (isDemo=false). Seeded dashboard samples (isDemo=true) keep the normal flow. */
export const isDemoPackClaim = (c: { policyId?: string | null; isDemo?: boolean | null } | null | undefined) => !!c && (c.policyId === DEMO_PACK.policyId || c.isDemo === false);

/** Any file: the next demo document (01..07) not yet verified on this claim. A declared demo type that is still missing wins. */
export function nextDemoDoc(docs: { id: string; type: string; status: string; validationResult?: unknown }[], selfId: string, declaredType?: string | null): (DemoDoc & { matchedBy: 'order' }) | null {
  const done = new Set(docs.filter((d) => d.id !== selfId && d.status === 'VERIFIED').map((d) => ((d.validationResult as { demoPack?: { n?: number } } | null)?.demoPack?.n ? DEMO_DOCS[(d.validationResult as { demoPack: { n: number } }).demoPack.n - 1].type : d.type)));
  const declared = declaredType ? DEMO_DOCS.find((x) => x.type === declaredType && !done.has(x.type)) : undefined;
  const d = declared ?? DEMO_DOCS.find((x) => !done.has(x.type));
  return d ? { ...d, matchedBy: 'order' } : null;
}

/** Personalise the fixed demo values for the claim's patient (Rohan's values stay exactly as printed). */
export function personalize<T>(v: T, name: string | null | undefined, policyNumber?: string | null): T {
  if (!name || name === DEMO_PACK.name || name === 'New user') return v;
  let j = JSON.stringify(v).split(DEMO_PACK.name).join(name);
  if (policyNumber) j = j.split(DEMO_PACK.policyNumber).join(policyNumber);
  return JSON.parse(j) as T;
}

/** Calendar date stored at 00:00 UTC (05:30 IST), so it reads as the same day in UTC and IST. */
const ist = (d: string) => new Date(`${d}T00:00:00Z`);
export const DEMO_BILL_ITEMS: BillItem[] = [
  { description: 'Room rent - Single AC room', qty: 3, rate: 5000, amount: 15000, category: 'ROOM' },
  { description: 'Nursing charges', qty: 3, rate: 800, amount: 2400, category: 'NURSING' },
  { description: 'Surgeon fee - laparoscopic appendectomy', qty: 1, rate: 30000, amount: 30000, category: 'PROFESSIONAL' },
  { description: 'Anaesthetist fee', qty: 1, rate: 8000, amount: 8000, category: 'PROFESSIONAL' },
  { description: 'Operation theatre charges', qty: 1, rate: 12000, amount: 12000, category: 'OT' },
  { description: 'Medicines & IV fluids', qty: 1, rate: 7850, amount: 7850, category: 'MEDICINE' },
  { description: 'Surgical consumables', qty: 1, rate: 3600, amount: 3600, category: 'CONSUMABLE' },
  { description: 'Lab investigations (CBC, CRP, USG abdomen)', qty: 1, rate: 4350, amount: 4350, category: 'DIAGNOSTIC' },
  { description: 'Registration & admission charges', qty: 1, rate: 1000, amount: 1000, category: 'NON_PAYABLE' },
];
const TOTAL = 84200;

export interface DemoDoc {
  n: number; marker: string; sha256: string; file: string; type: string; label: string;
  extracted: DocValidation['extracted']; details: Record<string, unknown>; summary: string;
  claimPatch?: Prisma.ClaimUpdateInput;
}
const base = { name: DEMO_PACK.name, hospital: DEMO_PACK.hospital, hasSignature: true };
export const DEMO_DOCS: DemoDoc[] = [
  { n: 1, marker: 'CS-DEMO-DOC-01', sha256: '638e91ded5639acd8fb0e4521ff25c5d963c8d0d0d4ff4f3fc1ebbb92d969803', file: '01_Health_Card.pdf', type: 'HEALTH_CARD', label: 'Health card',
    extracted: { ...base, hospital: null, date: '2026-01-01', amount: null, doctor: null },
    details: { insurer: 'Saathi Health Insurance Co. Ltd. (Demo)', policyNumber: DEMO_PACK.policyNumber, memberId: 'SHI-DEMO-0001-01', dob: '1991-03-12', gender: 'Male', validFrom: '2026-01-01', validTo: '2026-12-31', sumInsured: 500000, roomRentLimit: 4000, coPayPercent: 10, tpa: 'Saathi Claims TPA Pvt. Ltd. (Demo)' },
    summary: 'Health card verified: Rohan Verma, policy CS-DEMO-POL-2026, valid 01 Jan to 31 Dec 2026.' },
  { n: 2, marker: 'CS-DEMO-DOC-02', sha256: '2f74f4125bec4c31846e7f3567063aeb27c898912acd2315e156fb933f6de49a', file: '02_ID_Proof_Aadhaar.pdf', type: 'ID_PROOF', label: 'ID proof',
    extracted: { ...base, hospital: null, date: '2019-06-15', amount: null, doctor: null },
    details: { idType: 'Aadhaar (masked)', idNumberMasked: 'XXXX XXXX 4821', dob: '1991-03-12', gender: 'Male', address: 'B-702, Lakeview Residency, Powai, Mumbai 400076' },
    summary: 'ID proof verified: masked Aadhaar XXXX XXXX 4821, name and date of birth match the policy.' },
  { n: 3, marker: 'CS-DEMO-DOC-03', sha256: 'e4a496fb185f510be6033ecb3a0ebfba4a1cac7a68ef85742cb62d15ae2993ee', file: '03_Claim_Form.pdf', type: 'CLAIM_FORM', label: 'Claim form',
    extracted: { ...base, date: '2026-09-28', amount: TOTAL, doctor: null },
    details: { claimType: 'Reimbursement', policyNumber: DEMO_PACK.policyNumber, admissionDate: '2026-09-24', dischargeDate: '2026-09-27', diagnosis: 'Acute appendicitis', treatment: 'Laparoscopic appendectomy', amountClaimed: TOTAL, bank: 'HDFC Bank XXXX4821', signedOn: '2026-09-28' },
    summary: 'Claim form verified: signed by Rohan Verma on 28 Sep 2026, claiming ₹84,200.',
    claimPatch: { hospital: DEMO_PACK.hospital, hospitalCity: DEMO_PACK.hospitalCity, admissionDate: ist('2026-09-24'), dischargeDate: ist('2026-09-27'), admissionType: 'EMERGENCY', reason: 'Acute appendicitis', treatment: 'Laparoscopic appendectomy', claimType: 'REIMBURSEMENT' } },
  { n: 4, marker: 'CS-DEMO-DOC-04', sha256: '9ec707a8827da90a3bef6dbb970af0aa341e9a86857308e1eac9fce3c3d7f751', file: '04_Hospital_Bill.pdf', type: 'HOSPITAL_BILL', label: 'Hospital bill',
    extracted: { ...base, date: '2026-09-27', amount: TOTAL, doctor: 'Dr. Sanjay Kulkarni' },
    details: { billNumber: 'SUN/IPD/2026/04471', billDate: '2026-09-27', ipNumber: 'IP-2026-0924-117', uhid: 'SUN-UH-558201', room: 'Single AC room', roomRentPerDay: 5000, days: 3, items: DEMO_BILL_ITEMS, total: TOTAL },
    summary: 'Hospital bill verified: 9 line items totalling ₹84,200 (room ₹5,000/day for 3 days).',
    claimPatch: { billAmount: TOTAL, billItems: DEMO_BILL_ITEMS as unknown as Prisma.InputJsonValue, roomRentPerDay: 5000, days: 3, roomType: 'Single AC room', isNetworkHospital: true } },
  { n: 5, marker: 'CS-DEMO-DOC-05', sha256: 'b6198e20c51ab397670a1e41fd9c7e54045816c887375b7591f4bb3600972639', file: '05_Discharge_Summary.pdf', type: 'DISCHARGE_SUMMARY', label: 'Discharge summary',
    extracted: { ...base, date: '2026-09-27', amount: null, doctor: 'Dr. Sanjay Kulkarni' },
    details: { admissionDate: '2026-09-24', dischargeDate: '2026-09-27', diagnosis: 'Acute appendicitis (ICD-10 K35.8)', procedure: 'Laparoscopic appendectomy on 2026-09-25', condition: 'Stable', ipNumber: 'IP-2026-0924-117' },
    summary: 'Discharge summary verified: acute appendicitis, laparoscopic appendectomy, admitted 24 Sep and discharged 27 Sep 2026.',
    claimPatch: { reason: 'Acute appendicitis', treatment: 'Laparoscopic appendectomy', admissionDate: ist('2026-09-24'), dischargeDate: ist('2026-09-27'), days: 3 } },
  { n: 6, marker: 'CS-DEMO-DOC-06', sha256: '796cf7f6e1af80d9c8d40989a023f025e6a0d6030ec67e17be21a0ff3f768467', file: '06_Lab_Report.pdf', type: 'LAB_REPORT', label: 'Lab report',
    extracted: { ...base, date: '2026-09-24', amount: null, doctor: 'Dr. Meera Iyer' },
    details: { labNumber: 'SUN/LAB/2026/33907', results: [{ test: 'Total WBC count', value: '14,800 /cu mm', flag: 'HIGH' }, { test: 'Neutrophils', value: '82 %', flag: 'HIGH' }, { test: 'CRP', value: '48 mg/L', flag: 'HIGH' }, { test: 'USG abdomen', value: 'Inflamed non-compressible appendix, 9 mm' }], impression: 'Consistent with acute appendicitis' },
    summary: 'Lab report verified: raised WBC (14,800) and CRP (48 mg/L), USG shows an inflamed appendix, which supports the diagnosis.' },
  { n: 7, marker: 'CS-DEMO-DOC-07', sha256: '45f03111fc2d79decf7ccd36372310ed3c1ec925686189917a0be03d5be93b85', file: '07_Payment_Receipt.pdf', type: 'PAYMENT_RECEIPT', label: 'Payment receipt',
    extracted: { ...base, date: '2026-09-27', amount: TOTAL, doctor: null },
    details: { receiptNumber: 'SUN/RCPT/2026/09815', againstBill: 'SUN/IPD/2026/04471', mode: 'UPI', transactionRef: 'UPI-627014583190', amount: TOTAL, balanceDue: 0 },
    summary: 'Payment receipt verified: ₹84,200 paid by UPI against bill SUN/IPD/2026/04471, balance nil.' },
];

export function matchDemoDoc(buf: Buffer | null | undefined, text?: string | null): (DemoDoc & { matchedBy: 'sha256' | 'marker' }) | null {
  if (buf) {
    const h = createHash('sha256').update(buf).digest('hex');
    const d = DEMO_DOCS.find((x) => x.sha256 === h);
    if (d) return { ...d, matchedBy: 'sha256' };
  }
  const m = text?.match(/CS-DEMO-DOC-0([1-7])/);
  if (m) return { ...DEMO_DOCS[Number(m[1]) - 1], matchedBy: 'marker' };
  return null;
}

export function demoValidation(d: DemoDoc): DocValidation {
  return {
    valid: true, confidence: 0.98, detectedType: d.type, issues: [],
    checks: { readable: true, typeMatches: true, nameMatches: true, dateInPolicyPeriod: true, amountConsistent: d.extracted.amount != null ? true : null, hasSignature: true },
    extracted: d.extracted, fix: null, summary: d.summary,
  };
}

/** Create (or repair) the demo-pack customer + policy. Idempotent; never touches other users. */
export async function ensureDemoPack(prisma: PrismaClient) {
  let u = await prisma.user.findFirst({ where: { phone: DEMO_PACK.phone } });
  const profile = { name: DEMO_PACK.name, city: 'Mumbai', dob: new Date('1991-03-12T00:00:00Z'), gender: 'male' };
  const bankAccount = { accountName: DEMO_PACK.name, accountNumber: '50100234564821', ifsc: 'HDFC0000123', bankName: 'HDFC Bank', verifiedAt: '2026-09-28T06:30:00.000Z' };
  if (!u) {
    const byEmail = await prisma.user.findUnique({ where: { email: DEMO_PACK.email } });
    u = byEmail
      ? await prisma.user.update({ where: { id: byEmail.id }, data: { phone: DEMO_PACK.phone } })
      : await prisma.user.create({ data: { id: DEMO_PACK.userId, email: DEMO_PACK.email, phone: DEMO_PACK.phone, role: 'CUSTOMER', passwordHash: await bcrypt.hash('demo123', 10), bankAccount, ...profile } });
  }
  if (u.name === 'New user' || !u.dob || !u.bankAccount) u = await prisma.user.update({ where: { id: u.id }, data: { ...profile, ...(u.bankAccount ? {} : { bankAccount }) } });
  const policy = {
    userId: u.id, insurer: 'Saathi Health Insurance Co. Ltd. (Demo)', planName: 'Saathi Family Health Optima (Demo)', sumInsured: 500000, roomRentLimit: 4000, icuLimit: 8000, coPayPercent: 10,
    startDate: new Date('2026-01-01T00:00:00Z'), endDate: new Date('2026-12-31T00:00:00Z'),
    waitingPeriods: [{ name: 'Initial waiting period', months: 1, appliesTo: ['all illnesses except accidents'] }, { name: 'Specific illnesses', months: 24, appliesTo: ['cataract', 'hernia', 'joint replacement'] }, { name: 'Pre-existing diseases', months: 36, appliesTo: ['declared conditions'] }],
    subLimits: { cataractPerEye: 40000, ambulance: 2000 }, exclusions: ['Cosmetic or aesthetic treatment', 'Non-medical items (registration, admission kits, toiletries)', 'Self-inflicted injury', 'Experimental treatment'],
    networkHospitals: [DEMO_PACK.hospital, 'Lotus Care Hospital', 'CityLife Hospital'], members: [{ name: DEMO_PACK.name, relation: 'Self', dob: '1991-03-12' }],
    summary: 'Hospital bills up to ₹5,00,000 a year. Room rent up to ₹4,000/day, ICU ₹8,000/day, 10% co-pay on every claim.',
  } satisfies Omit<Prisma.PolicyUncheckedCreateInput, 'policyNumber'>;
  await prisma.policy.upsert({ where: { policyNumber: DEMO_PACK.policyNumber }, create: { id: DEMO_PACK.policyId, policyNumber: DEMO_PACK.policyNumber, ...policy }, update: policy });
  return { userId: u.id, policyId: DEMO_PACK.policyId };
}

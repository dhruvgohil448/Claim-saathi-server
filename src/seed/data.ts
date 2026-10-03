/**
 * Demo seed data: 3 staff/demo logins + the 9 claims that match sample-data/documents
 * (the dummy PDFs in Claim_Saathi_Dummy_Documents). Timestamps are written in IST against ANCHOR and
 * shifted so the newest activity is "now" when you seed (the dashboard always looks alive).
 * Used by prisma/seed.ts, POST /api/admin/reset-demo and scripts/gen-sql.ts (prisma/supabase_seed.sql).
 */
import fs from 'fs';
import path from 'path';
import { extractText } from '../services/extract';
import { mockExtractPolicy, mockSummary, mockValidate, DocValidation } from '../services/ai.service';
import { BillItem, calculateSettlementRules, categorize, checkCoverageRules, PolicyRules, SettlementResult } from '../services/rules';
import { inr } from '../utils/format';
import { ROOT } from '../services/storage';

export const ANCHOR = Date.parse('2026-10-03T10:30:00+05:30');
/** IST wall-clock → seconds before ANCHOR */
export const T = (ist: string) => Math.round((ANCHOR - Date.parse(ist.replace(' ', 'T') + ':00+05:30')) / 1000);
const D = (dmy: string) => {
  const [d, m, y] = dmy.split('-');
  const mi = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m);
  return new Date(Date.UTC(+y, mi, +d, 4, 30)); // 10:00 IST
};

type Actor = 'AI' | 'HUMAN' | 'SYSTEM';
export interface SeedUser { id: string; name: string; email: string; phone: string; role: 'CUSTOMER' | 'OPS' | 'ADMIN'; city: string; ago: number }
export interface SeedPolicy { id: string; userId: string; policyNumber: string; startDate: Date; endDate: Date; extraction: ReturnType<typeof mockExtractPolicy>; fileUrl: string; rawText: string; ago: number }
export interface SeedDoc { id: string; claimId: string; type: string; fileName: string; fileUrl: string; mimeType: string; size: number; status: string; confidence: number; validation: DocValidation; reviewedBy?: string | null; reviewNote?: string | null; ago: number }
export interface SeedEvent { id: string; claimId: string; status: string; title: string; description: string; actor: Actor; ago: number }
export interface SeedQuery { id: string; claimId: string; message: string; requestedDocType: string | null; response: string | null; status: 'OPEN' | 'ANSWERED' | 'CLOSED'; createdBy: Actor; respondedAgo: number | null; closedAgo: number | null; ago: number }
export interface SeedSettlement { id: string; claimId: string; result: SettlementResult; status: 'ESTIMATED' | 'APPROVED' | 'PAID'; utr: string | null; paidAgo: number | null; ago: number }
export interface SeedLog { id: string; claimId: string | null; actor: Actor; actorName: string | null; action: string; reason: string; confidence: number | null; ago: number }
export interface SeedNotification { id: string; userId: string; claimId: string | null; type: 'INFO' | 'SUCCESS' | 'WARNING' | 'ACTION_REQUIRED'; title: string; body: string; read: boolean; ago: number }
export interface SeedClaim {
  id: string; claimNumber: string; userId: string; policyId: string; patientName: string; hospital: string; hospitalCity: string; reason: string; treatment: string;
  claimType: 'CASHLESS' | 'REIMBURSEMENT'; admissionType: 'PLANNED' | 'EMERGENCY'; isAccident: boolean; admissionDate: Date; dischargeDate: Date; roomType: string;
  roomRentPerDay: number | null; days: number; estimatedAmount: number | null; billAmount: number | null; billItems: BillItem[] | null; status: string;
  aiSummary: string | null; aiSuggestion: Record<string, unknown> | null; aiConfidence: number | null; riskLevel: string; riskFlags: string[]; reminderCount: number; lastActivityAgo: number; ago: number;
}
export interface SeedData { users: SeedUser[]; policies: SeedPolicy[]; claims: SeedClaim[]; documents: SeedDoc[]; events: SeedEvent[]; queries: SeedQuery[]; settlements: SeedSettlement[]; logs: SeedLog[]; notifications: SeedNotification[] }

// ---------- master data (mirrors dummy-docs/make_docs.py) ----------
interface ClaimDef {
  n: string; folder: string; name: string; email: string; phone: string; city: string; pol: string; start: string; hospital: string; city2: string; type: 'CASHLESS' | 'REIMBURSEMENT';
  doctor: string; adm: string; dis: string; ward: string; dx: string; proc: string; items: [string, number, number][]; status: string; accident?: boolean; planned?: boolean;
}
const C: ClaimDef[] = [
  { n: '1001', folder: 'CLM-1001_Rahul_Sharma_SETTLED', name: 'Rahul Sharma', email: 'customer@claimsaathi.demo', phone: '+91 98200 00001', city: 'Mumbai', pol: 'SHI-2023-0045871', start: '01-Apr-2023', hospital: 'Sunrise Multispeciality Hospital', city2: 'Andheri West, Mumbai', type: 'REIMBURSEMENT', doctor: 'Dr. Meera Kulkarni', adm: '08-Sep-2026', dis: '12-Sep-2026', ward: 'Semi-private', dx: 'Dengue fever with thrombocytopenia', proc: 'Conservative management, platelet transfusion', status: 'SETTLED',
    items: [['Room rent – Semi-private (₹3,500/day)', 4, 3500], ['Nursing charges', 4, 800], ['Consultant visits', 8, 1000], ['CBC with platelet count', 6, 450], ['Dengue NS1 antigen & IgM', 1, 1800], ['Single donor platelet (SDP) transfusion', 1, 9500], ['IV fluids & injectables', 1, 6800], ['Medical consumables', 1, 2400], ['Registration & admission', 1, 500]] },
  { n: '1002', folder: 'CLM-1002_Priya_Nair_APPROVED', name: 'Priya Nair', email: 'priya.nair@example.demo', phone: '+91 98200 00002', city: 'Thane', pol: 'SHI-2022-0031204', start: '15-Jan-2022', hospital: 'Lotus Care Hospital', city2: 'Thane West', type: 'CASHLESS', doctor: 'Dr. Arjun Menon', adm: '15-Sep-2026', dis: '17-Sep-2026', ward: 'Single private', dx: 'Acute appendicitis', proc: 'Laparoscopic appendectomy', status: 'APPROVED',
    items: [['Room rent – Single private (₹4,500/day)', 2, 4500], ['Operation theatre charges', 1, 22000], ['Surgeon fee', 1, 28000], ['Anaesthetist fee', 1, 9000], ['Laparoscopy equipment', 1, 8500], ['Lab investigations', 1, 4200], ['USG abdomen', 1, 1800], ['Medicines & injectables', 1, 8600], ['Surgical consumables', 1, 5900], ['Nursing charges', 2, 900]] },
  { n: '1003', folder: 'CLM-1003_Amit_Patel_NEEDS_HUMAN', name: 'Amit Patel', email: 'amit.patel@example.demo', phone: '+91 98200 00003', city: 'Pune', pol: 'SHI-2021-0018876', start: '10-Jun-2021', hospital: 'Arogya Ortho & Joint Centre', city2: 'Shivajinagar, Pune', type: 'REIMBURSEMENT', doctor: 'Dr. Sanjay Deshpande', adm: '02-Sep-2026', dis: '08-Sep-2026', ward: 'Deluxe room', dx: 'Primary osteoarthritis, right knee (Grade IV)', proc: 'Right total knee replacement (TKR)', status: 'NEEDS_HUMAN', planned: true,
    items: [['Room rent – Deluxe (₹7,000/day)', 6, 7000], ['Knee implant (cemented, posterior stabilised)', 1, 85000], ['Operation theatre charges', 1, 40000], ['Surgeon fee', 1, 45000], ['Anaesthetist fee', 1, 15000], ['Physiotherapy sessions', 6, 1200], ['Medicines & injectables', 1, 18500], ['Lab & radiology', 1, 6500], ['Surgical consumables', 1, 9800], ['Nursing charges', 6, 1000]] },
  { n: '1004', folder: 'CLM-1004_Sneha_Iyer_QUERY_RAISED', name: 'Sneha Iyer', email: 'sneha.iyer@example.demo', phone: '+91 98200 00004', city: 'Mumbai', pol: 'SHI-2024-0052019', start: '05-May-2024', hospital: 'Shanti Medical Centre', city2: 'Borivali West, Mumbai', type: 'REIMBURSEMENT', doctor: 'Dr. Rakesh Joshi', adm: '19-Sep-2026', dis: '22-Sep-2026', ward: 'General ward', dx: 'Enteric (typhoid) fever', proc: 'IV antibiotics', status: 'QUERY_RAISED',
    items: [['Room rent – General ward (₹2,000/day)', 3, 2000], ['Nursing charges', 3, 600], ['Consultant visits', 6, 800], ['Blood culture & Widal', 1, 2200], ['IV Ceftriaxone & fluids', 1, 7400], ['Other medicines', 1, 2600], ['Medical consumables', 1, 1500], ['Registration & admission', 1, 400]] },
  { n: '1005', folder: 'CLM-1005_Karan_Mehta_DOCS_PENDING', name: 'Karan Mehta', email: 'karan.mehta@example.demo', phone: '+91 98200 00005', city: 'Navi Mumbai', pol: 'SHI-2023-0047730', start: '20-Jul-2023', hospital: 'CityLife Hospital', city2: 'Vashi, Navi Mumbai', type: 'REIMBURSEMENT', doctor: 'Dr. Nikhil Rao', adm: '24-Sep-2026', dis: '26-Sep-2026', ward: 'Twin sharing', dx: 'Fracture distal end of left radius', proc: 'Open reduction and internal fixation (ORIF) with volar plate', status: 'DOCS_PENDING', accident: true,
    items: [['Room rent – Twin sharing (₹3,000/day)', 2, 3000], ['Operation theatre charges', 1, 15000], ['Surgeon fee', 1, 18000], ['Anaesthetist fee', 1, 6000], ['Volar locking plate & screws', 1, 16500], ['X-ray wrist (2 views) x2', 2, 650], ['Medicines & injectables', 1, 5200], ['Surgical consumables', 1, 3400], ['Emergency & registration', 1, 1200]] },
  { n: '1006', folder: 'CLM-1006_Neha_Gupta_REJECTED', name: 'Neha Gupta', email: 'neha.gupta@example.demo', phone: '+91 98200 00006', city: 'Mumbai', pol: 'SHI-2026-0071145', start: '10-Mar-2026', hospital: "Kamala Maternity & Women's Hospital", city2: 'Dadar West, Mumbai', type: 'REIMBURSEMENT', doctor: 'Dr. Kavita Shah', adm: '21-Sep-2026', dis: '23-Sep-2026', ward: 'Single private', dx: 'Full term normal vaginal delivery', proc: 'Normal vaginal delivery with episiotomy', status: 'REJECTED',
    items: [['Room rent – Single private (₹4,000/day)', 2, 4000], ['Labour room & delivery charges', 1, 18000], ['Obstetrician fee', 1, 15000], ['Paediatrician fee', 1, 4000], ['Anaesthetist (epidural)', 1, 6000], ['Medicines & injectables', 1, 5400], ['Lab investigations', 1, 3100], ['Baby care & vaccination', 1, 2600], ['Consumables', 1, 2300]] },
  { n: '1007', folder: 'CLM-1007_Vikram_Singh_UNDER_REVIEW', name: 'Vikram Singh', email: 'vikram.singh@example.demo', phone: '+91 98200 00007', city: 'Mumbai', pol: 'SHI-2020-0009921', start: '01-Dec-2020', hospital: 'Drishti Eye Hospital', city2: 'Ghatkopar West, Mumbai', type: 'REIMBURSEMENT', doctor: 'Dr. Ananya Bhatt', adm: '25-Sep-2026', dis: '25-Sep-2026', ward: 'Day care', dx: 'Senile cataract, right eye', proc: 'Phacoemulsification with foldable IOL, right eye', status: 'UNDER_REVIEW', planned: true,
    items: [['Day care charges', 1, 6000], ['Surgeon fee', 1, 15000], ['Foldable IOL (hydrophobic acrylic)', 1, 18000], ['OT & equipment', 1, 5000], ['Biometry & pre-op tests', 1, 2500], ['Eye drops & medicines', 1, 1800]] },
  { n: '1008', folder: 'CLM-1008_Anjali_Desai_PREAUTH_SUBMITTED', name: 'Anjali Desai', email: 'anjali.desai@example.demo', phone: '+91 98200 00008', city: 'Mumbai', pol: 'SHI-2019-0004410', start: '01-Aug-2019', hospital: 'HeartLine Cardiac Institute', city2: 'Powai, Mumbai', type: 'CASHLESS', doctor: 'Dr. Rajiv Malhotra', adm: '06-Oct-2026', dis: '08-Oct-2026', ward: 'Single private', dx: 'Coronary artery disease – double vessel (LAD, RCA)', proc: 'Planned PTCA with 2 drug-eluting stents', status: 'PREAUTH_SUBMITTED', planned: true,
    items: [['Room rent – Single private (₹5,000/day)', 3, 5000], ['Cath lab charges', 1, 45000], ['Drug-eluting stents (2 nos, NPPA capped)', 2, 38000], ['Cardiologist procedure fee', 1, 60000], ['ICU (1 day)', 1, 15000], ['Medicines & consumables', 1, 42000], ['Investigations', 1, 12000]] },
  { n: '1009', folder: 'CLM-1009_Rohan_Joshi_CREATED', name: 'Rohan Joshi', email: 'rohan.joshi@example.demo', phone: '+91 98200 00009', city: 'Kalyan', pol: 'SHI-2022-0036650', start: '12-Sep-2022', hospital: 'Oakwood General Hospital', city2: 'Kalyan West', type: 'REIMBURSEMENT', doctor: 'Dr. Farhan Qureshi', adm: '30-Sep-2026', dis: '02-Oct-2026', ward: 'Twin sharing', dx: 'Acute gastroenteritis with moderate dehydration', proc: 'IV rehydration', status: 'CREATED',
    items: [['Room rent – Twin sharing (₹2,800/day)', 2, 2800], ['IV fluids & medicines', 1, 4800], ['Consultant visits', 3, 900], ['Lab tests', 1, 1900]] },
];

const FILE_TYPES: [RegExp, string][] = [
  [/eCard/i, 'HEALTH_CARD'], [/Policy_Schedule/i, 'POLICY_SCHEDULE'], [/Claim_Form/i, 'CLAIM_FORM'], [/PreAuth/i, 'PREAUTH_FORM'], [/Estimate/i, 'DOCTOR_ESTIMATE'],
  [/Discharge/i, 'DISCHARGE_SUMMARY'], [/Final_(Hospital_)?Bill/i, 'HOSPITAL_BILL'], [/Pharmacy/i, 'PHARMACY_BILL'], [/Lab_Report/i, 'LAB_REPORT'], [/Prescription/i, 'PRESCRIPTION'],
];

export const STAFF: SeedUser[] = [
  { id: 'usr_ops', name: 'Ishita Rao', email: 'ops@claimsaathi.demo', phone: '+91 98200 10001', role: 'OPS', city: 'Mumbai', ago: T('2026-09-01 10:00') },
  { id: 'usr_admin', name: 'Kabir Shah', email: 'admin@claimsaathi.demo', phone: '+91 98200 10002', role: 'ADMIN', city: 'Mumbai', ago: T('2026-09-01 09:30') },
];

export async function buildSeedData(): Promise<SeedData> {
  const out: SeedData = { users: [...STAFF], policies: [], claims: [], documents: [], events: [], queries: [], settlements: [], logs: [], notifications: [] };
  let logN = 0, evN = 0, ntN = 0;
  const log = (claimId: string | null, at: string, action: string, reason: string, confidence: number | null = null, actor: Actor = 'AI', actorName?: string | null) =>
    out.logs.push({ id: `log_${String(++logN).padStart(3, '0')}`, claimId, actor, actorName: actorName ?? (actor === 'AI' ? 'Claim Agent' : actor === 'SYSTEM' ? 'Follow-up job' : null), action, reason, confidence, ago: T(at) });
  const event = (claimId: string, at: string, status: string, title: string, description: string, actor: Actor = 'AI') =>
    out.events.push({ id: `evt_${String(++evN).padStart(3, '0')}`, claimId, status, title, description, actor, ago: T(at) });
  const notify = (userId: string, claimId: string | null, at: string, type: SeedNotification['type'], title: string, body: string, read: boolean) =>
    out.notifications.push({ id: `ntf_${String(++ntN).padStart(3, '0')}`, userId, claimId, type, title, body, read, ago: T(at) });
  const notifyStaff = (claimId: string | null, at: string, type: SeedNotification['type'], title: string, body: string, read: boolean) => {
    for (const s of STAFF) notify(s.id, claimId, at, type, title, body, read);
  };

  const ctx: Record<string, { def: ClaimDef; claimId: string; userId: string; rules: PolicyRules; settlement: SettlementResult; docs: SeedDoc[] }> = {};

  for (const def of C) {
    const userId = def.email === 'customer@claimsaathi.demo' ? 'usr_customer' : `usr_c${def.n}`;
    const claimId = `clm_${def.n}`;
    const policyId = `pol_${def.n}`;
    out.users.push({ id: userId, name: def.name, email: def.email, phone: def.phone, role: 'CUSTOMER', city: def.city, ago: T('2026-09-10 10:00') });

    // Policy: run the real (rule-based) extractor on the dummy policy schedule
    const folder = path.join(ROOT, 'sample-data', 'documents', def.folder);
    const polText = (await extractText(fs.readFileSync(path.join(folder, '02_Policy_Schedule.pdf')), 'application/pdf')).text;
    const extraction = mockExtractPolicy(polText);
    const startDate = D(def.start);
    out.policies.push({ id: policyId, userId, policyNumber: def.pol, startDate, endDate: new Date(Date.UTC(2027, 2, 31, 18, 29)), extraction, fileUrl: `sample/${def.folder}/02_Policy_Schedule.pdf`, rawText: polText.slice(0, 20000), ago: 0 });
    const rules: PolicyRules = { sumInsured: extraction.sumInsured, roomRentLimit: extraction.roomRentLimit, icuLimit: extraction.icuLimit, coPayPercent: extraction.coPayPercent, startDate, subLimits: extraction.subLimits, waitingPeriods: extraction.waitingPeriods };

    const items: BillItem[] = def.items.map(([description, qty, rate]) => ({ description, qty, rate, amount: qty * rate, category: categorize(description) }));
    const total = items.reduce((s, i) => s + i.amount, 0);
    const room = items.find((i) => i.category === 'ROOM' && !/day care/i.test(i.description));
    const facts = { reason: def.dx, treatment: def.proc, admissionDate: D(def.adm), isAccident: !!def.accident, isNetworkHospital: true, billAmount: total, estimatedAmount: total, billItems: items, roomRentPerDay: room?.rate ?? null };
    const settlement = calculateSettlementRules(rules, facts);
    const coverage = checkCoverageRules(rules, facts);

    // Documents: run the real (rule-based) validator on every dummy file
    const docs: SeedDoc[] = [];
    for (const f of fs.readdirSync(folder).sort()) {
      const type = FILE_TYPES.find(([re]) => re.test(f))?.[1] ?? 'OTHER';
      const buf = fs.readFileSync(path.join(folder, f));
      const mimeType = f.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf';
      const ex = await extractText(buf, mimeType);
      const v = mockValidate(ex, { declaredType: type, fileName: f, mimeType, policyHolder: def.name, policyStart: startDate, policyEnd: new Date(Date.UTC(2027, 2, 31)), admissionDate: D(def.adm), claimAmount: total, hospital: def.hospital });
      const status = v.valid && v.confidence >= 0.8 ? 'VERIFIED' : 'NEEDS_REVIEW';
      docs.push({ id: `doc_${def.n}_${f.slice(0, 2)}`, claimId, type, fileName: f, fileUrl: `sample/${def.folder}/${f}`, mimeType, size: buf.length, status, confidence: v.confidence, validation: v, ago: 0 });
    }
    out.documents.push(...docs);

    out.claims.push({
      id: claimId, claimNumber: `CLM-${def.n}`, userId, policyId, patientName: def.name, hospital: def.hospital, hospitalCity: def.city2, reason: def.dx, treatment: def.proc,
      claimType: def.type, admissionType: def.planned ? 'PLANNED' : 'EMERGENCY', isAccident: !!def.accident, admissionDate: D(def.adm), dischargeDate: D(def.dis), roomType: def.ward,
      roomRentPerDay: room?.rate ?? null, days: Math.max(1, Math.round((D(def.dis).getTime() - D(def.adm).getTime()) / 86400000)),
      estimatedAmount: total, billAmount: def.n === '1008' ? null : total, billItems: items, status: def.status,
      aiSummary: null, aiSuggestion: null, aiConfidence: null, riskLevel: coverage.covered ? (coverage.riskFlags.length ? 'MEDIUM' : 'LOW') : 'HIGH', riskFlags: coverage.riskFlags, reminderCount: 0, lastActivityAgo: 0, ago: 0,
    });
    ctx[def.n] = { def, claimId, userId, rules, settlement, docs };
  }

  const claim = (n: string) => out.claims.find((c) => c.claimNumber === `CLM-${n}`)!;
  const docAt = (n: string, type: string, at: string, by?: string) => {
    const d = ctx[n].docs.find((x) => x.type === type)!;
    d.ago = T(at);
    const v = d.validation;
    if (d.status === 'VERIFIED') log(ctx[n].claimId, at, 'DOC_VERIFIED', `${label(type)} auto-verified: ${v.summary.replace(/^.*?verified:\s*/i, '')}`, d.confidence);
    else log(ctx[n].claimId, at, 'DOC_FLAGGED', `${label(type)} flagged: ${v.issues.map((i) => i.message).join(' ')}`, d.confidence);
    void by;
    return d;
  };
  const uploads = (n: string, at: string, who: string, types: string[]) =>
    log(ctx[n].claimId, at, 'DOC_UPLOADED', `${who} uploaded ${types.length} document${types.length > 1 ? 's' : ''}: ${types.map((t) => label(t).toLowerCase()).join(', ')}.`, null, 'HUMAN', who);
  const policyRead = (n: string, at: string) => {
    const p = out.policies.find((x) => x.id === `pol_${n}`)!;
    p.ago = T(at);
    log(null, at, 'POLICY_EXTRACTED', `Read ${ctx[n].def.name.split(' ')[0]}'s policy ${p.policyNumber}: sum insured ${inr(p.extraction.sumInsured)}, room rent ${inr(p.extraction.roomRentLimit)}/day, ${p.extraction.coPayPercent}% co-pay, 4 waiting periods.`, 0.94);
    notify(ctx[n].userId, null, at, 'SUCCESS', 'Your policy, explained', p.extraction.summaryEnglish, true);
  };
  const created = (n: string, at: string, who?: string) => {
    const c = claim(n);
    c.ago = T(at);
    const by = who ?? ctx[n].def.name;
    event(c.id, at, 'CREATED', 'Claim submitted', `${c.claimType === 'CASHLESS' ? 'Cashless' : 'Reimbursement'} claim for ${c.reason.toLowerCase()} at ${c.hospital}.`, 'SYSTEM');
    log(c.id, at, 'CLAIM_CREATED', `${c.claimNumber} created by ${by} for ${inr(c.billAmount ?? c.estimatedAmount ?? 0)}.`, null, 'HUMAN', by);
  };
  const covered = (n: string, at: string, extra: string, conf = 0.95) => log(ctx[n].claimId, at, 'COVERAGE_CHECKED', extra, conf);
  const status = (n: string, at: string, st: string, title: string, desc: string, action: string, conf: number | null, actor: Actor = 'AI', actorName?: string) => {
    event(ctx[n].claimId, at, st, title, desc, actor);
    log(ctx[n].claimId, at, action, desc, conf, actor, actorName);
  };
  const settle = (n: string, at: string, st: SeedSettlement['status'], utr: string | null = null, paidAt: string | null = null) => {
    const s = ctx[n].settlement;
    out.settlements.push({ id: `stl_${n}`, claimId: ctx[n].claimId, result: s, status: st, utr, paidAgo: paidAt ? T(paidAt) : null, ago: T(at) });
    log(ctx[n].claimId, at, 'SETTLEMENT_CALCULATED', s.explanation, 0.97);
  };
  const summarize = (n: string, confidence: number, stage?: 'PREAUTH') => {
    const c = claim(n);
    const s = ctx[n].settlement;
    const cov = checkCoverageRules(ctx[n].rules, { reason: c.reason, treatment: c.treatment, admissionDate: c.admissionDate, isAccident: c.isAccident, billAmount: c.billAmount, estimatedAmount: c.estimatedAmount, billItems: c.billItems, roomRentPerDay: c.roomRentPerDay });
    const docIssues = ctx[n].docs.filter((d) => d.status !== 'VERIFIED').map((d) => `${label(d.type)}: ${d.validation.issues[0]?.message ?? 'needs review'}`);
    const sum = mockSummary({ claimNumber: c.claimNumber, patientName: c.patientName, hospital: c.hospital, reason: c.reason, claimType: c.claimType, amount: c.billAmount ?? c.estimatedAmount ?? 0, approvedAmount: s.approvedAmount, deductions: s.deductions, flags: c.riskFlags, docIssues, coverage: cov, confidence, stage });
    c.aiSummary = sum.summary.join('\n');
    c.aiSuggestion = { decision: sum.suggestedDecision, amount: sum.suggestedAmount, reason: sum.reason };
    c.aiConfidence = confidence;
    return sum;
  };
  const ALL = (n: string) => ctx[n].docs.map((d) => d.type);

  // ===== CLM-1001 Rahul: clean claim → auto-approved → settled =====
  policyRead('1001', '2026-09-20 09:02');
  created('1001', '2026-09-20 09:12');
  covered('1001', '2026-09-20 09:12', `Covered: dengue is not under any waiting period and the policy is 41 months old. Sunrise Multispeciality is a network hospital. Estimated payable ${inr(ctx['1001'].settlement.approvedAmount)} after 10% co-pay.`, 0.96);
  uploads('1001', '2026-09-20 09:14', 'Rahul Sharma', ALL('1001'));
  ['HEALTH_CARD', 'POLICY_SCHEDULE', 'CLAIM_FORM', 'DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'PHARMACY_BILL', 'LAB_REPORT', 'PRESCRIPTION'].forEach((t, i) => docAt('1001', t, `2026-09-20 09:${String(15 + Math.floor(i * 0.7)).padStart(2, '0')}`));
  status('1001', '2026-09-20 09:21', 'UNDER_REVIEW', 'Documents verified', 'All 8 documents verified by AI (lowest confidence 0.94). Claim submitted for assessment.', 'DOCS_COMPLETE', 0.95);
  settle('1001', '2026-09-20 09:21', 'PAID', 'DEMOUTR260921001', '2026-09-21 11:05');
  summarize('1001', 0.95);
  claim('1001').aiSuggestion = { decision: 'APPROVE', amount: ctx['1001'].settlement.approvedAmount, reason: 'Clean claim, auto-approved', resolved: true };
  status('1001', '2026-09-20 09:22', 'APPROVED', 'Claim approved', `Auto-approved: ${inr(ctx['1001'].settlement.approvedAmount)} payable after non-payable items and 10% co-pay.`, 'AUTO_APPROVED', 0.95);
  notify('usr_customer', 'clm_1001', '2026-09-20 09:12', 'INFO', 'Claim CLM-1001 created', 'Upload your documents and I will check each one instantly.', true);
  notify('usr_customer', 'clm_1001', '2026-09-20 09:22', 'SUCCESS', 'Claim CLM-1001 approved', `${inr(ctx['1001'].settlement.approvedAmount)} will be paid to your bank account. Bill ${inr(48900)}, deductions ${inr(48900 - ctx['1001'].settlement.approvedAmount)}.`, true);
  status('1001', '2026-09-21 11:05', 'SETTLED', 'Claim settled', `${inr(ctx['1001'].settlement.approvedAmount)} paid by NEFT (UTR DEMOUTR260921001).`, 'SETTLED', null, 'SYSTEM', 'Follow-up job');
  notify('usr_customer', 'clm_1001', '2026-09-21 11:05', 'SUCCESS', 'Money sent to your bank', `${inr(ctx['1001'].settlement.approvedAmount)} for CLM-1001 was paid (UTR DEMOUTR260921001).`, false);

  // ===== CLM-1002 Priya: cashless, pre-auth auto-approved, pharmacy bill query loop, auto-approved =====
  policyRead('1002', '2026-09-15 08:30');
  created('1002', '2026-09-15 08:40', 'Lotus Care cashless desk');
  covered('1002', '2026-09-15 08:41', 'Covered: appendicitis has no specific waiting period; policy is 56 months old; Lotus Care is a network hospital, cashless allowed.', 0.95);
  uploads('1002', '2026-09-15 08:41', 'Lotus Care cashless desk', ['HEALTH_CARD', 'POLICY_SCHEDULE', 'CLAIM_FORM', 'PREAUTH_FORM']);
  ['HEALTH_CARD', 'POLICY_SCHEDULE', 'CLAIM_FORM', 'PREAUTH_FORM'].forEach((t, i) => docAt('1002', t, `2026-09-15 08:4${2 + i}`));
  status('1002', '2026-09-15 08:46', 'PREAUTH_SUBMITTED', 'Pre-authorisation submitted', 'AI filled the pre-auth from the hospital request and sent it to the TPA.', 'PREAUTH_SUBMITTED', 0.92);
  log('clm_1002', '2026-09-15 09:10', 'PREAUTH_APPROVED', `Pre-auth auto-approved for ${inr(ctx['1002'].settlement.approvedAmount)} (estimate ${inr(98800)} is within the ₹1,00,000 auto-approve limit).`, 0.92);
  event('clm_1002', '2026-09-15 09:10', 'PREAUTH_SUBMITTED', 'Pre-auth approved', `Cashless approved for ${inr(ctx['1002'].settlement.approvedAmount)}.`, 'AI');
  notify('usr_c1002', 'clm_1002', '2026-09-15 09:10', 'SUCCESS', 'Cashless approved', `Pre-authorisation of ${inr(ctx['1002'].settlement.approvedAmount)} is approved at Lotus Care Hospital.`, true);
  uploads('1002', '2026-09-17 15:00', 'Lotus Care cashless desk', ['DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'LAB_REPORT', 'PRESCRIPTION']);
  ['DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'LAB_REPORT', 'PRESCRIPTION'].forEach((t, i) => docAt('1002', t, `2026-09-17 15:0${1 + i}`));
  status('1002', '2026-09-17 15:06', 'QUERY_RAISED', 'Query raised', 'Pharmacy bill for discharge medicines is missing. AI asked the hospital desk to upload it.', 'QUERY_RAISED', 0.9);
  out.queries.push({ id: 'qry_1002', claimId: 'clm_1002', message: 'Hi Priya, to finish claim CLM-1002 (Lotus Care Hospital) please upload the pharmacy bill for your discharge medicines. A clear PDF or photo is fine.', requestedDocType: 'PHARMACY_BILL', response: 'Uploaded the pharmacy bill from the hospital pharmacy.', status: 'CLOSED', createdBy: 'AI', respondedAgo: T('2026-09-17 15:38'), closedAgo: T('2026-09-17 15:39'), ago: T('2026-09-17 15:06') });
  log('clm_1002', '2026-09-17 15:38', 'QUERY_ANSWERED', 'Priya Nair replied: "Uploaded the pharmacy bill from the hospital pharmacy."', null, 'HUMAN', 'Priya Nair');
  docAt('1002', 'PHARMACY_BILL', '2026-09-17 15:39');
  log('clm_1002', '2026-09-17 15:39', 'QUERY_CLOSED', 'Pharmacy bill received and verified, so the query was closed automatically.', 0.94);
  status('1002', '2026-09-17 15:40', 'UNDER_REVIEW', 'Documents verified', 'All required documents verified. AI submitted the claim for assessment.', 'DOCS_COMPLETE', 0.95);
  settle('1002', '2026-09-17 15:41', 'APPROVED');
  summarize('1002', 0.94);
  claim('1002').aiSuggestion = { decision: 'APPROVE', amount: ctx['1002'].settlement.approvedAmount, reason: 'Clean surgical claim under ₹1 lakh', resolved: true };
  status('1002', '2026-09-17 15:41', 'APPROVED', 'Claim approved', `Auto-approved: ${inr(ctx['1002'].settlement.approvedAmount)} payable to Lotus Care Hospital after 10% co-pay (${inr(ctx['1002'].settlement.coPayAmount)} paid by Priya at discharge).`, 'AUTO_APPROVED', 0.94);
  notify('usr_c1002', 'clm_1002', '2026-09-17 15:41', 'SUCCESS', 'Claim CLM-1002 approved', `${inr(ctx['1002'].settlement.approvedAmount)} will be paid to the hospital. Your share (co-pay) is ${inr(ctx['1002'].settlement.coPayAmount)}.`, true);

  // ===== CLM-1006 Neha: maternity inside the 24-month waiting period → AI recommends reject → human rejects =====
  policyRead('1006', '2026-09-25 09:45');
  created('1006', '2026-09-25 10:00');
  covered('1006', '2026-09-25 10:01', 'Not payable: maternity is covered only after a 24-month waiting period. Policy SHI-2026-0071145 started 10-Mar-2026, 6 months before admission.', 0.97);
  notify('usr_c1006', 'clm_1006', '2026-09-25 10:01', 'WARNING', 'Heads up about your claim', 'Maternity is covered only after 24 months from your policy start (10-Mar-2026). A claims specialist will confirm the decision.', true);
  log('clm_1006', '2026-09-25 10:01', 'NOTIFIED_CUSTOMER', 'Heads up about your claim: maternity waiting period of 24 months applies; a specialist will confirm.', null);
  uploads('1006', '2026-09-25 10:02', 'Neha Gupta', ALL('1006'));
  ['HEALTH_CARD', 'POLICY_SCHEDULE', 'CLAIM_FORM', 'DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'PHARMACY_BILL', 'LAB_REPORT', 'PRESCRIPTION'].forEach((t, i) => docAt('1006', t, `2026-09-25 10:0${3 + Math.floor(i / 2)}`));
  settle('1006', '2026-09-25 10:08', 'ESTIMATED');
  summarize('1006', 0.95);
  status('1006', '2026-09-25 10:08', 'NEEDS_HUMAN', 'Sent to claims specialist', 'Escalated to a claims specialist: treatment falls inside the maternity waiting period. AI recommends REJECT under "Maternity: up to ₹50,000 after a 24-month waiting period".', 'ESCALATED', 0.95);
  notifyStaff('clm_1006', '2026-09-25 10:08', 'ACTION_REQUIRED', 'CLM-1006 needs a human decision', 'Maternity claim inside the 24-month waiting period. AI suggests reject.', true);
  claim('1006').aiSuggestion = { ...claim('1006').aiSuggestion!, resolved: true, resolvedBy: 'Ishita Rao', humanDecision: 'REJECT' };
  status('1006', '2026-09-25 15:30', 'REJECTED', 'Claim rejected', 'Rejected by Ishita Rao. Confirmed: policy schedule clause "Maternity – up to ₹50,000 after a 24-month waiting period"; policy is 6 months old. Customer informed she can claim from 10-Mar-2028.', 'HUMAN_REJECTED', null, 'HUMAN', 'Ishita Rao');
  notify('usr_c1006', 'clm_1006', '2026-09-25 15:30', 'WARNING', 'Claim CLM-1006 not approved', 'Maternity benefits start after a 24-month waiting period (from 10-Mar-2028 on your policy). Tap to see the exact clause.', false);

  // ===== CLM-1007 Vikram: cataract cap + name variation on bill → under review, partial suggestion =====
  policyRead('1007', '2026-09-27 15:40');
  created('1007', '2026-09-27 16:00');
  covered('1007', '2026-09-27 16:01', 'Covered: cataract is a specific illness (24-month wait), policy is 69 months old. Cataract is capped at ₹40,000 per eye, so a part of the ₹48,300 bill will be deducted.', 0.93);
  uploads('1007', '2026-09-27 16:02', 'Vikram Singh', ALL('1007'));
  ['HEALTH_CARD', 'POLICY_SCHEDULE', 'CLAIM_FORM', 'DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'PHARMACY_BILL', 'LAB_REPORT', 'PRESCRIPTION'].forEach((t, i) => docAt('1007', t, `2026-09-27 16:0${3 + Math.floor(i / 2)}`));
  out.queries.push({ id: 'qry_1007', claimId: 'clm_1007', message: 'Hi Vikram, your hospital bill says "Vikram S. Singh" but the policy says "Vikram Singh". Please upload a photo ID (Aadhaar or PAN) so we can confirm it is you. Your claim stays under review meanwhile.', requestedDocType: 'ID_PROOF', response: null, status: 'OPEN', createdBy: 'AI', respondedAgo: null, closedAgo: null, ago: T('2026-09-27 16:06') });
  log('clm_1007', '2026-09-27 16:06', 'QUERY_RAISED', 'Asked Vikram for a photo ID to confirm "Vikram S. Singh" on the bill is the policy holder "Vikram Singh".', 0.88);
  notify('usr_c1007', 'clm_1007', '2026-09-27 16:06', 'ACTION_REQUIRED', 'Please confirm your name', 'Your hospital bill says "Vikram S. Singh". Upload Aadhaar or PAN so we can match it to your policy.', false);
  settle('1007', '2026-09-27 16:08', 'ESTIMATED');
  claim('1007').riskFlags = ['NAME_VARIATION'];
  claim('1007').riskLevel = 'MEDIUM';
  summarize('1007', 0.76);
  status('1007', '2026-09-27 16:09', 'UNDER_REVIEW', 'Under review', `All documents received. Bill name variation is minor (middle initial), so AI kept the claim under review with a partial settlement suggestion of ${inr(ctx['1007'].settlement.approvedAmount)} (cataract cap ₹40,000 per eye, 10% co-pay).`, 'STATUS_UNDER_REVIEW', 0.76);

  // ===== CLM-1004 Sneha: lab report missing → AI query → reminder =====
  policyRead('1004', '2026-09-29 17:50');
  created('1004', '2026-09-29 18:05');
  covered('1004', '2026-09-29 18:06', 'Covered: typhoid has no specific waiting period; policy is 28 months old. Estimated payable after co-pay and non-payable registration charges.', 0.95);
  uploads('1004', '2026-09-29 18:06', 'Sneha Iyer', ALL('1004'));
  ['HEALTH_CARD', 'POLICY_SCHEDULE', 'CLAIM_FORM', 'DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'PHARMACY_BILL', 'PRESCRIPTION'].forEach((t, i) => docAt('1004', t, `2026-09-29 18:${String(7 + Math.floor(i / 2)).padStart(2, '0')}`));
  const q1004 = 'Hi Sneha, to process claim CLM-1004 (Shanti Medical Centre) please upload the lab / investigation reports (Widal test and blood culture) that confirm the typhoid diagnosis. A clear PDF or photo is fine. Your claim continues automatically once it is uploaded.';
  out.queries.push({ id: 'qry_1004', claimId: 'clm_1004', message: q1004, requestedDocType: 'LAB_REPORT', response: null, status: 'OPEN', createdBy: 'AI', respondedAgo: null, closedAgo: null, ago: T('2026-09-29 18:11') });
  status('1004', '2026-09-29 18:11', 'QUERY_RAISED', 'Query raised', 'Lab report (Widal / blood culture) is missing. AI asked Sneha to upload it.', 'QUERY_RAISED', 0.9);
  notify('usr_c1004', 'clm_1004', '2026-09-29 18:11', 'ACTION_REQUIRED', 'Action required on CLM-1004', q1004, true);
  log('clm_1004', '2026-10-01 18:15', 'REMINDER_SENT', 'Claim idle for over 48h. Reminder 1 of 2 sent to the customer.', null, 'SYSTEM');
  notify('usr_c1004', 'clm_1004', '2026-10-01 18:15', 'ACTION_REQUIRED', 'Reminder 1: CLM-1004 needs you', `Reminder: ${q1004}`, false);
  claim('1004').reminderCount = 1;

  // ===== CLM-1005 Karan: blurry bill photo → flagged with exact fix =====
  policyRead('1005', '2026-09-30 12:20');
  created('1005', '2026-09-30 12:30');
  covered('1005', '2026-09-30 12:31', 'Covered: injury from a road accident, so waiting periods do not apply. Policy is 38 months old; CityLife is a network hospital.', 0.96);
  uploads('1005', '2026-09-30 12:32', 'Karan Mehta', ALL('1005'));
  ['HEALTH_CARD', 'POLICY_SCHEDULE', 'CLAIM_FORM', 'DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'PHARMACY_BILL', 'LAB_REPORT', 'PRESCRIPTION'].forEach((t, i) => docAt('1005', t, `2026-09-30 12:${String(33 + Math.floor(i / 2)).padStart(2, '0')}`));
  const bill1005 = ctx['1005'].docs.find((d) => d.type === 'HOSPITAL_BILL')!;
  notify('usr_c1005', 'clm_1005', '2026-09-30 12:36', 'ACTION_REQUIRED', 'Please re-upload your final hospital bill', `${bill1005.validation.issues[0]?.message} Fix: ${bill1005.validation.fix}`, false);
  log('clm_1005', '2026-09-30 12:36', 'NOTIFIED_CUSTOMER', `Asked Karan to re-upload the final bill: ${bill1005.validation.fix}`, null);
  status('1005', '2026-09-30 12:37', 'DOCS_PENDING', 'Documents pending', 'Waiting for a clearer copy of the final hospital bill (photo is blurry, amounts unreadable).', 'DOCS_PENDING', 0.85);
  log('clm_1005', '2026-10-03 09:05', 'REMINDER_SENT', 'Claim idle for over 48h. Reminder 1 of 2 sent to the customer.', null, 'SYSTEM');
  notify('usr_c1005', 'clm_1005', '2026-10-03 09:05', 'ACTION_REQUIRED', 'Reminder 1: CLM-1005 needs you', 'Your final bill photo is still unreadable. Upload the original PDF or a sharp photo to keep your claim moving.', false);
  claim('1005').reminderCount = 1;

  // ===== CLM-1008 Anjali: planned PTCA, cashless pre-auth > ₹1L → AI drafts approval note =====
  policyRead('1008', '2026-10-01 11:05');
  created('1008', '2026-10-01 11:20', 'HeartLine cashless desk');
  covered('1008', '2026-10-01 11:21', 'Covered: policy is 86 months old, so the 36-month pre-existing wait (hypertension) is over. ICU is billed at ₹15,000/day vs the ₹10,000/day limit.', 0.92);
  uploads('1008', '2026-10-01 11:22', 'HeartLine cashless desk', ALL('1008'));
  ['HEALTH_CARD', 'POLICY_SCHEDULE', 'CLAIM_FORM', 'PREAUTH_FORM', 'DOCTOR_ESTIMATE', 'LAB_REPORT', 'PRESCRIPTION'].forEach((t, i) => docAt('1008', t, `2026-10-01 11:2${3 + Math.floor(i / 2)}`));
  status('1008', '2026-10-01 11:27', 'PREAUTH_SUBMITTED', 'Pre-authorisation submitted', 'AI filled the pre-auth for planned PTCA (admission 06-Oct-2026) and sent it to the TPA.', 'PREAUTH_SUBMITTED', 0.92);
  settle('1008', '2026-10-01 11:28', 'ESTIMATED');
  summarize('1008', 0.88, 'PREAUTH');
  log('clm_1008', '2026-10-01 11:29', 'PREAUTH_NOTE_DRAFTED', `Estimate ${inr(265000)} is above ₹1,00,000, so the AI drafted an approval note for ops: approve ${inr(ctx['1008'].settlement.approvedAmount)} (ICU capped at ₹10,000/day, 10% co-pay).`, 0.88);
  notifyStaff('clm_1008', '2026-10-01 11:29', 'ACTION_REQUIRED', 'Pre-auth note ready for CLM-1008', `AI suggests approving ${inr(ctx['1008'].settlement.approvedAmount)} for Anjali Desai at HeartLine Cardiac Institute.`, false);
  notify('usr_c1008', 'clm_1008', '2026-10-01 11:27', 'INFO', 'Pre-auth sent to the insurer', 'Your cashless request for 06-Oct-2026 at HeartLine Cardiac Institute is with the insurer. We will update you here.', true);

  // ===== CLM-1003 Amit: TKR ₹2.75L, deluxe room above cap → escalated with partial approval =====
  policyRead('1003', '2026-10-02 14:50');
  created('1003', '2026-10-02 15:10');
  covered('1003', '2026-10-02 15:11', 'Covered: knee replacement is a specific illness (24-month wait), policy is 63 months old. Deluxe room at ₹7,000/day is above the ₹5,000/day limit, so associated charges will be paid proportionately.', 0.9);
  uploads('1003', '2026-10-02 15:12', 'Amit Patel', ALL('1003'));
  ['HEALTH_CARD', 'POLICY_SCHEDULE', 'CLAIM_FORM', 'DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'PHARMACY_BILL', 'LAB_REPORT', 'PRESCRIPTION'].forEach((t, i) => docAt('1003', t, `2026-10-02 15:1${3 + Math.floor(i / 2)}`));
  status('1003', '2026-10-02 15:19', 'UNDER_REVIEW', 'Documents verified', 'All 8 documents verified by AI. Claim submitted for assessment.', 'DOCS_COMPLETE', 0.93);
  settle('1003', '2026-10-02 15:20', 'ESTIMATED');
  summarize('1003', 0.74);
  status('1003', '2026-10-02 15:21', 'NEEDS_HUMAN', 'Sent to claims specialist', `Escalated to a claims specialist: claim amount ${inr(275000)} is above ${inr(100000)}; room rent ${inr(7000)}/day above the ${inr(5000)}/day cap triggers a proportionate deduction; AI confidence 0.74 is below 0.8.`, 'ESCALATED', 0.74);
  notifyStaff('clm_1003', '2026-10-02 15:21', 'ACTION_REQUIRED', 'CLM-1003 needs a human decision', `Amount above ₹1,00,000 and room rent above cap. AI suggests partial approval for ${inr(ctx['1003'].settlement.approvedAmount)}.`, false);
  notify('usr_c1003', 'clm_1003', '2026-10-02 15:21', 'INFO', 'Your claim is with a specialist', 'CLM-1003 is being checked by our claims team. You do not need to do anything right now.', false);

  // ===== CLM-1009 Rohan: just created, only form + e-card =====
  policyRead('1009', '2026-10-02 19:30');
  created('1009', '2026-10-02 19:45');
  covered('1009', '2026-10-02 19:46', 'Covered: gastroenteritis has no specific waiting period; policy is 48 months old. Oakwood General is a network hospital.', 0.95);
  uploads('1009', '2026-10-02 19:46', 'Rohan Joshi', ALL('1009'));
  ['HEALTH_CARD', 'POLICY_SCHEDULE', 'CLAIM_FORM'].forEach((t, i) => docAt('1009', t, `2026-10-02 19:4${7 + Math.floor(i / 2)}`));
  const ask1009 = 'Next, upload: discharge summary, final hospital bill, pharmacy bill, lab report, prescription. I will check each one instantly.';
  log('clm_1009', '2026-10-02 19:49', 'NOTIFIED_CUSTOMER', `Claim CLM-1009 created: ${ask1009}`, null);
  notify('usr_c1009', 'clm_1009', '2026-10-02 19:49', 'ACTION_REQUIRED', 'Claim CLM-1009 created', ask1009, false);

  // AI notes for claims that are waiting on the customer
  const waiting: [string, string, number][] = [
    ['1004', '7 of 8 documents verified; lab report (Widal / blood culture) is missing. Query sent, 1 reminder so far.', 0.9],
    ['1005', 'Final bill photo is blurry (confidence 0.41), so amounts cannot be read. Customer asked for the original PDF.', 0.41],
    ['1009', 'Claim form, e-card and policy verified. Discharge summary, bills, lab report and prescription not uploaded yet.', 0.95],
  ];
  for (const [n, line2, conf] of waiting) {
    const c = claim(n);
    c.aiSummary = [`Reimbursement claim of ${inr(c.billAmount ?? 0)} for ${c.patientName.split(' ')[0]} at ${c.hospital}: ${c.reason}.`, line2, `Waiting on the customer. Estimated payable ${inr(ctx[n].settlement.approvedAmount)} once everything is verified.`].join('\n');
    c.aiSuggestion = { decision: 'REQUEST_INFO', amount: ctx[n].settlement.approvedAmount, reason: 'Documents pending from the customer' };
    c.aiConfidence = conf;
  }

  // ===== Staff digest =====
  log(null, '2026-10-03 09:00', 'DAILY_DIGEST', 'Morning sweep: 9 claims tracked, 2 awaiting a human decision, 3 waiting on customers. 6 of 8 processed claims handled end-to-end by AI.', null, 'SYSTEM');
  notifyStaff(null, '2026-10-03 09:00', 'INFO', 'Morning digest', '2 claims need you today (CLM-1003, CLM-1008 pre-auth). AI handled 6 of 8 processed claims on its own.', false);

  // lastActivityAt / createdAt for claims = latest/earliest of their events & logs
  for (const c of out.claims) {
    const times = [...out.logs.filter((l) => l.claimId === c.id).map((l) => l.ago), ...out.events.filter((e) => e.claimId === c.id).map((e) => e.ago)];
    c.lastActivityAgo = Math.min(...times);
    // claims waiting on the customer were touched by this morning's sweep (keeps the follow-up job calm right after seeding)
    if (['CREATED', 'DOCS_PENDING', 'QUERY_RAISED'].includes(c.status)) c.lastActivityAgo = Math.min(c.lastActivityAgo, T('2026-10-03 09:00'));
    c.ago = Math.max(...times);
  }
  for (const d of out.documents) if (!d.ago) d.ago = out.claims.find((c) => c.id === d.claimId)!.ago;
  for (const p of out.policies) if (!p.ago) p.ago = T('2026-09-10 10:00');
  return out;
}

const LABELS: Record<string, string> = {
  HEALTH_CARD: 'Health e-card', POLICY_SCHEDULE: 'Policy schedule', CLAIM_FORM: 'Claim form', PREAUTH_FORM: 'Pre-auth request', DOCTOR_ESTIMATE: "Doctor's estimate letter",
  DISCHARGE_SUMMARY: 'Discharge summary', HOSPITAL_BILL: 'Final hospital bill', PHARMACY_BILL: 'Pharmacy bill', LAB_REPORT: 'Lab report', PRESCRIPTION: 'Prescription', OTHER: 'Document',
};
const label = (t: string) => LABELS[t] ?? t;

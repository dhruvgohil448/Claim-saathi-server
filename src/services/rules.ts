/**
 * Claim Saathi policy rules engine (pure functions, no DB).
 * Used by the Claim Agent, the seed, and the API so every number is computed the same way.
 *
 * Saathi Secure Plus rules (from the policy schedule):
 *  - Sum insured ₹5,00,000 · 10% co-pay on every admissible claim
 *  - Room rent up to ₹5,000/day; a costlier room → proportionate deduction on associated charges
 *  - ICU up to ₹10,000/day · Cataract up to ₹40,000 per eye · Maternity up to ₹50,000 after 24 months
 *  - Waiting periods: 30 days initial (accidents exempt), 24 months specific illnesses, 36 months pre-existing
 */
import { daysBetween, inr, monthsBetween } from '../utils/format';

export type BillCategory =
  | 'ROOM' | 'ICU' | 'NURSING' | 'PROFESSIONAL' | 'OT' | 'IMPLANT' | 'MEDICINE' | 'DIAGNOSTIC' | 'CONSUMABLE' | 'NON_PAYABLE' | 'OTHER';

export interface BillItem { description: string; qty: number; rate: number; amount: number; category?: BillCategory }
export interface Deduction { label: string; amount: number; reason: string; clause?: string }

export interface PolicyRules {
  sumInsured: number;
  roomRentLimit: number;
  icuLimit?: number | null;
  coPayPercent: number;
  startDate: Date;
  subLimits?: { cataractPerEye?: number; maternity?: number; ambulance?: number } | null;
  waitingPeriods?: { name: string; months: number }[] | null;
}

export interface ClaimFacts {
  reason: string; // diagnosis
  treatment?: string | null;
  admissionDate?: Date | null;
  isAccident?: boolean;
  isNetworkHospital?: boolean;
  preExistingDisease?: boolean;
  billAmount?: number | null;
  estimatedAmount?: number | null;
  billItems?: BillItem[] | null;
  roomRentPerDay?: number | null;
  days?: number | null;
}

export const DEFAULT_RULES = {
  sumInsured: 500000,
  roomRentLimit: 5000,
  icuLimit: 10000,
  coPayPercent: 10,
  cataractPerEye: 40000,
  maternity: 50000,
  initialWaitDays: 30,
  specificIllnessMonths: 24,
  preExistingMonths: 36,
  maternityMonths: 24,
};

export function categorize(description: string): BillCategory {
  const d = description.toLowerCase();
  if (/registration|admission kit|admission charge|& admission|toiletr|attendant/.test(d)) return 'NON_PAYABLE';
  if (/\bicu\b|intensive care|iccu|nicu/.test(d)) return 'ICU';
  if (/room rent|day care charges|ward charges|bed charges/.test(d)) return 'ROOM';
  if (/nursing/.test(d)) return 'NURSING';
  if (/surgeon|anaesthet|anesthet|consultant|obstetrician|paediatrician|pediatrician|cardiologist|doctor fee|procedure fee/.test(d)) return 'PROFESSIONAL';
  if (/operation theatre|\bot\b|ot &|cath lab|labour room|delivery charges|laparoscopy equipment/.test(d)) return 'OT';
  if (/implant|stent|\bplate\b|screw|\biol\b|lens/.test(d)) return 'IMPLANT';
  if (/medicine|injectable|drug|pharmacy|iv fluids|ceftriaxone|eye drops/.test(d)) return 'MEDICINE';
  if (/lab|x-ray|xray|usg|ultrasound|cbc|culture|widal|test|investigation|radiology|biometry|ns1|scan|mri|ct /.test(d)) return 'DIAGNOSTIC';
  if (/consumable/.test(d)) return 'CONSUMABLE';
  return 'OTHER';
}

/** Charges that scale with the room category (IRDAI proportionate-deduction rule). */
const ASSOCIATED: BillCategory[] = ['ROOM', 'NURSING', 'PROFESSIONAL', 'OT'];

export function detectCondition(reason: string, treatment?: string | null) {
  const t = `${reason} ${treatment || ''}`.toLowerCase();
  return {
    maternity: /deliver|maternity|pregnan|caesarean|lscs|labour|obstetric/.test(t),
    cataract: /cataract|phaco|\biol\b/.test(t),
    specificIllness: /cataract|hernia|knee replacement|joint replacement|\btkr\b|\bthr\b|osteoarthritis|tonsil|sinus|septum|adenoid|gall ?stone|cholecyst|kidney stone|calculus|piles|haemorrhoid|fistula|hysterectomy/.test(t),
  };
}

export interface CoverageResult {
  covered: boolean;
  waitingPeriodIssue: string | null;
  networkHospital: boolean;
  estimatedPayable: number;
  estimatedOutOfPocket: number;
  warnings: string[];
  clauses: string[];
  riskFlags: string[];
  explanation: string;
}

export function checkCoverageRules(policy: PolicyRules, claim: ClaimFacts): CoverageResult {
  const warnings: string[] = [];
  const clauses: string[] = [];
  const riskFlags: string[] = [];
  const adm = claim.admissionDate ?? new Date();
  const months = monthsBetween(policy.startDate, adm);
  const days = daysBetween(policy.startDate, adm);
  const cond = detectCondition(claim.reason, claim.treatment);
  let waitingPeriodIssue: string | null = null;

  if (!claim.isAccident && days < DEFAULT_RULES.initialWaitDays) {
    waitingPeriodIssue = `Admission is ${days} days after the policy started; the 30-day initial waiting period applies (accidents are exempt).`;
    clauses.push('Waiting periods: Initial waiting period (except accidents): 30 days');
  }
  if (cond.maternity) {
    const limit = policy.subLimits?.maternity ?? DEFAULT_RULES.maternity;
    if (months < DEFAULT_RULES.maternityMonths) {
      waitingPeriodIssue = `Maternity is covered only after a 24-month waiting period. The policy started ${months} months before admission.`;
      clauses.push('Coverage summary: Maternity — up to ₹50,000 after a 24-month waiting period');
      clauses.push('Waiting periods: Maternity — 24 months');
    } else {
      warnings.push(`Maternity is capped at ${inr(limit)}.`);
    }
  }
  if (cond.specificIllness && months < DEFAULT_RULES.specificIllnessMonths) {
    waitingPeriodIssue = `This treatment is a listed specific illness with a 24-month waiting period; the policy is ${months} months old.`;
    clauses.push('Waiting periods: Specific illnesses (cataract, hernia, joint replacement, ENT, etc.) — 24 months');
  }
  if (claim.preExistingDisease && months < DEFAULT_RULES.preExistingMonths) {
    waitingPeriodIssue = `Pre-existing disease waiting period of 36 months applies; the policy is ${months} months old.`;
    clauses.push('Waiting periods: Pre-existing diseases — 36 months');
  }
  if (cond.cataract) warnings.push(`Cataract is capped at ${inr(policy.subLimits?.cataractPerEye ?? DEFAULT_RULES.cataractPerEye)} per eye.`);

  const roomRent = claim.roomRentPerDay ?? roomRateFromItems(claim.billItems);
  if (roomRent && roomRent > policy.roomRentLimit) {
    warnings.push(`Room rent ${inr(roomRent)}/day is above the ${inr(policy.roomRentLimit)}/day limit, so associated charges will be reduced proportionately.`);
    riskFlags.push('ROOM_RENT_ABOVE_CAP');
  }
  if (claim.isNetworkHospital === false) warnings.push('Non-network hospital: cashless is not available, claim by reimbursement.');
  if (waitingPeriodIssue) riskFlags.push('WAITING_PERIOD');

  const settlement = calculateSettlementRules(policy, claim);
  const covered = !waitingPeriodIssue;
  const amount = claim.billAmount ?? claim.estimatedAmount ?? 0;
  if (amount > 100000) riskFlags.push('HIGH_VALUE');

  const explanation = covered
    ? `Covered under your policy. Estimated payable ${inr(settlement.approvedAmount)} of ${inr(amount)} after ${policy.coPayPercent}% co-pay${settlement.deductions.length > 1 ? ' and policy limits' : ''}.`
    : `Not payable right now: ${waitingPeriodIssue}`;

  return {
    covered,
    waitingPeriodIssue,
    networkHospital: claim.isNetworkHospital !== false,
    estimatedPayable: covered ? settlement.approvedAmount : 0,
    estimatedOutOfPocket: covered ? amount - settlement.approvedAmount : amount,
    warnings,
    clauses,
    riskFlags,
    explanation,
  };
}

function roomRateFromItems(items?: BillItem[] | null): number | null {
  const room = (items || []).find((i) => (i.category ?? categorize(i.description)) === 'ROOM' && i.qty > 0 && !/day care/i.test(i.description));
  return room ? room.rate : null;
}

export interface SettlementResult {
  billAmount: number;
  admissibleAmount: number;
  deductions: Deduction[];
  coPayAmount: number;
  approvedAmount: number;
  explanation: string;
}

export function calculateSettlementRules(policy: PolicyRules, claim: ClaimFacts): SettlementResult {
  const items: BillItem[] = (claim.billItems && claim.billItems.length
    ? claim.billItems
    : [{ description: 'Hospitalisation expenses', qty: 1, rate: claim.billAmount ?? claim.estimatedAmount ?? 0, amount: claim.billAmount ?? claim.estimatedAmount ?? 0 }]
  ).map((i) => ({ ...i, category: i.category ?? categorize(i.description) }));
  const bill = items.reduce((s, i) => s + i.amount, 0);
  const deductions: Deduction[] = [];
  const cond = detectCondition(claim.reason, claim.treatment);
  const coverage = { months: monthsBetween(policy.startDate, claim.admissionDate ?? new Date()) };

  // Hard exclusions: waiting periods → nothing payable
  const wpMaternity = cond.maternity && coverage.months < DEFAULT_RULES.maternityMonths;
  const wpSpecific = cond.specificIllness && coverage.months < DEFAULT_RULES.specificIllnessMonths;
  const wpInitial = !claim.isAccident && daysBetween(policy.startDate, claim.admissionDate ?? new Date()) < DEFAULT_RULES.initialWaitDays;
  const wpPed = !!claim.preExistingDisease && coverage.months < DEFAULT_RULES.preExistingMonths;
  if (wpMaternity || wpSpecific || wpInitial || wpPed) {
    const clause = wpMaternity
      ? 'Maternity: up to ₹50,000 after a 24-month waiting period'
      : wpSpecific
        ? 'Specific illnesses: 24-month waiting period'
        : wpPed ? 'Pre-existing diseases: 36-month waiting period' : 'Initial waiting period: 30 days (except accidents)';
    deductions.push({ label: 'Not admissible (waiting period)', amount: bill, reason: `Treatment falls inside the policy waiting period. ${clause}.`, clause });
    return { billAmount: bill, admissibleAmount: 0, deductions, coPayAmount: 0, approvedAmount: 0, explanation: `Claim not payable: ${clause}.` };
  }

  // 1. Non-payable items (IRDAI list)
  const nonPay = items.filter((i) => i.category === 'NON_PAYABLE').reduce((s, i) => s + i.amount, 0);
  if (nonPay > 0) deductions.push({ label: 'Non-payable items', amount: nonPay, reason: 'Registration / admission charges are on the IRDAI non-payable list.', clause: 'Exclusions: non-medical items' });

  // 2. ICU cap
  for (const i of items.filter((x) => x.category === 'ICU')) {
    const cap = (policy.icuLimit ?? DEFAULT_RULES.icuLimit) * i.qty;
    if (i.amount > cap) deductions.push({ label: 'ICU above limit', amount: i.amount - cap, reason: `ICU billed at ${inr(i.rate)}/day; the policy pays up to ${inr(policy.icuLimit ?? DEFAULT_RULES.icuLimit)}/day.`, clause: 'ICU: up to ₹10,000 per day' });
  }

  // 3. Room rent cap → proportionate deduction on associated charges
  const roomRate = claim.roomRentPerDay ?? roomRateFromItems(items);
  if (roomRate && roomRate > policy.roomRentLimit) {
    const ratio = policy.roomRentLimit / roomRate;
    const assoc = items.filter((i) => ASSOCIATED.includes(i.category!)).reduce((s, i) => s + i.amount, 0);
    const ded = Math.round(assoc * (1 - ratio));
    deductions.push({
      label: 'Proportionate deduction (room rent)',
      amount: ded,
      reason: `Room at ${inr(roomRate)}/day vs ${inr(policy.roomRentLimit)}/day limit. Room, nursing, OT and doctor fees (${inr(assoc)}) are paid at ${Math.round(ratio * 100)}%.`,
      clause: 'Room rent: up to ₹5,000 per day; higher room → proportionate deduction on associated charges',
    });
  }

  let admissible = bill - deductions.reduce((s, d) => s + d.amount, 0);

  // 4. Sub-limits
  if (cond.cataract) {
    const cap = policy.subLimits?.cataractPerEye ?? DEFAULT_RULES.cataractPerEye;
    if (admissible > cap) {
      deductions.push({ label: 'Cataract sub-limit', amount: admissible - cap, reason: `Cataract surgery is capped at ${inr(cap)} per eye.`, clause: 'Cataract: up to ₹40,000 per eye' });
      admissible = cap;
    }
  }
  if (cond.maternity) {
    const cap = policy.subLimits?.maternity ?? DEFAULT_RULES.maternity;
    if (admissible > cap) {
      deductions.push({ label: 'Maternity sub-limit', amount: admissible - cap, reason: `Maternity is capped at ${inr(cap)}.`, clause: 'Maternity: up to ₹50,000' });
      admissible = cap;
    }
  }
  if (admissible > policy.sumInsured) {
    deductions.push({ label: 'Above sum insured', amount: admissible - policy.sumInsured, reason: `Sum insured is ${inr(policy.sumInsured)}.`, clause: 'Sum insured' });
    admissible = policy.sumInsured;
  }

  // 5. Co-pay
  const coPay = Math.round((admissible * policy.coPayPercent) / 100);
  if (coPay > 0) deductions.push({ label: `Co-payment (${policy.coPayPercent}%)`, amount: coPay, reason: `You share ${policy.coPayPercent}% of every admissible claim.`, clause: 'Co-payment: 10% on every admissible claim' });
  const approved = admissible - coPay;

  const parts = deductions.map((d) => `${d.label.toLowerCase()} ${inr(d.amount)}`).join(', ');
  return {
    billAmount: bill,
    admissibleAmount: admissible,
    deductions,
    coPayAmount: coPay,
    approvedAmount: approved,
    explanation: `Bill ${inr(bill)} − ${parts || 'no deductions'} = ${inr(approved)} payable.`,
  };
}

/** Which documents a claim needs before it can be assessed. */
export function requiredDocTypes(claimType: 'CASHLESS' | 'REIMBURSEMENT', stage: 'PREAUTH' | 'FINAL'): string[] {
  if (stage === 'PREAUTH') return ['HEALTH_CARD', 'PREAUTH_FORM', 'DOCTOR_ESTIMATE'];
  if (claimType === 'CASHLESS') return ['PREAUTH_FORM', 'DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'PHARMACY_BILL', 'LAB_REPORT', 'PRESCRIPTION'];
  return ['CLAIM_FORM', 'DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'PHARMACY_BILL', 'LAB_REPORT', 'PRESCRIPTION'];
}

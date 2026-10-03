/**
 * AI service. Every function returns zod-validated JSON.
 * MOCK_AI=true (default) → realistic rule-based results with no API key.
 * MOCK_AI=false → OpenAI or Gemini (AI_PROVIDER); any LLM failure falls back to the rule-based result.
 */
import { z } from 'zod';
import { llmEnabled } from '../config/env';
import { completeJSON } from './llm';
import { Extracted } from './extract';
import { calculateSettlementRules, checkCoverageRules, ClaimFacts, CoverageResult, PolicyRules, DEFAULT_RULES } from './rules';
import { docLabel, fmtDate, inr } from '../utils/format';

// ---------- Schemas ----------
export const policyExtractionSchema = z.object({
  insurer: z.string(),
  planName: z.string().optional(),
  policyNumber: z.string(),
  holderName: z.string().optional(),
  startDate: z.string().optional(),
  sumInsured: z.number(),
  roomRentLimit: z.number(),
  icuLimit: z.number().optional(),
  coPayPercent: z.number(),
  waitingPeriods: z.array(z.object({ name: z.string(), months: z.number() })),
  subLimits: z.object({ cataractPerEye: z.number().optional(), maternity: z.number().optional(), ambulance: z.number().optional() }).partial(),
  exclusions: z.array(z.string()),
  networkHospitals: z.array(z.string()).default([]),
  summaryEnglish: z.string(),
  summaryHindi: z.string(),
});
export type PolicyExtraction = z.infer<typeof policyExtractionSchema>;

export const docValidationSchema = z.object({
  valid: z.boolean(),
  confidence: z.number().min(0).max(1),
  detectedType: z.string(),
  issues: z.array(z.object({ code: z.string(), severity: z.enum(['low', 'medium', 'high']), message: z.string() })),
  checks: z.object({
    readable: z.boolean(),
    typeMatches: z.boolean(),
    nameMatches: z.boolean().nullable(),
    dateInPolicyPeriod: z.boolean().nullable(),
    amountConsistent: z.boolean().nullable(),
    hasSignature: z.boolean(),
  }),
  extracted: z.object({
    name: z.string().nullable(),
    date: z.string().nullable(),
    amount: z.number().nullable(),
    doctor: z.string().nullable(),
    hospital: z.string().nullable(),
    hasSignature: z.boolean(),
  }),
  fix: z.string().nullable(),
  summary: z.string(),
});
export type DocValidation = z.infer<typeof docValidationSchema>;

export const claimSummarySchema = z.object({
  summary: z.array(z.string()).length(3),
  suggestedDecision: z.enum(['APPROVE', 'PARTIAL_APPROVE', 'REJECT', 'REQUEST_INFO', 'APPROVE_PREAUTH']),
  suggestedAmount: z.number().nullable(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});
export type ClaimSummary = z.infer<typeof claimSummarySchema>;

export const chatAnswerSchema = z.object({ answer: z.string(), sources: z.array(z.string()).default([]), followUps: z.array(z.string()).default([]) });
export const queryExplainSchema = z.object({ explanation: z.string(), nextSteps: z.array(z.string()) });
export const queryDraftSchema = z.object({ message: z.string() });

async function withLLM<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, system: string, user: string, fallback: () => T): Promise<T> {
  if (!llmEnabled()) return schema.parse(fallback());
  try {
    return schema.parse(await completeJSON(system, user));
  } catch (e) {
    console.warn('[ai] LLM failed, using rule-based fallback:', (e as Error).message);
    return schema.parse(fallback());
  }
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function parseDocDate(s: string): Date | null {
  const m = s.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()] ?? 0, +m[1], 4, 30));
}
const money = (s: string) => Number(s.replace(/[^\d]/g, ''));

// ---------- 1. Policy extraction ----------
export async function extractPolicy(rawText: string): Promise<PolicyExtraction> {
  return withLLM(
    policyExtractionSchema,
    'You extract Indian health insurance policy rules. Reply with JSON only matching: {insurer, planName, policyNumber, holderName, startDate (DD-Mon-YYYY), sumInsured, roomRentLimit (per day, INR), icuLimit, coPayPercent, waitingPeriods:[{name, months}], subLimits:{cataractPerEye, maternity, ambulance}, exclusions:[string], networkHospitals:[string], summaryEnglish (3 short sentences, simple words), summaryHindi (same in Hindi)}.',
    rawText.slice(0, 12000),
    () => mockExtractPolicy(rawText),
  );
}

export function mockExtractPolicy(t: string): PolicyExtraction {
  const flat = t.replace(/\n/g, ' ');
  const pick = (re: RegExp) => flat.match(re)?.[1]?.trim();
  const policyNumber = pick(/Policy number\s*([A-Z]{2,5}-\d{4}-\d{5,8})/i) || pick(/\b(SHI-\d{4}-\d{7})\b/) || `SHI-${new Date().getFullYear()}-${String(Date.now()).slice(-7)}`;
  const holderName = pick(/Policy holder\s*([A-Z][a-z]+(?: [A-Z][a-z.]+){0,3})/)?.replace(/\s(Date|Gender|Mobile|Email)\b.*$/, '');
  const startDate = pick(/Policy start\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/);
  const si = pick(/Sum insured\s*₹?\s*([\d,]+)/i);
  const room = pick(/Room rent\s*Up to\s*₹?\s*([\d,]+)/i);
  const icu = pick(/ICU\s*Up to\s*₹?\s*([\d,]+)/i);
  const copay = pick(/Co-?payment\s*(\d{1,2})%/i);
  const sumInsured = si ? money(si) : DEFAULT_RULES.sumInsured;
  const roomRentLimit = room ? money(room) : DEFAULT_RULES.roomRentLimit;
  const coPayPercent = copay ? Number(copay) : DEFAULT_RULES.coPayPercent;
  const exclusions = [
    'Cosmetic or plastic surgery (unless after an accident)',
    'Dental treatment unless it needs hospitalisation',
    'Self-inflicted injury, substance abuse',
    'Infertility and assisted reproduction',
    'Non-medical items (toiletries, attendant, admission kit)',
    'War, nuclear hazards, adventure sports',
    'OPD treatment and routine check-ups',
  ];
  return {
    insurer: /Saathi Health/i.test(flat) ? 'Saathi Health Insurance Co. Ltd. (Demo)' : pick(/^([A-Z][\w .&]+Insurance[\w .()]*)/) || 'Saathi Health Insurance Co. Ltd. (Demo)',
    planName: /Saathi Secure Plus/i.test(flat) ? 'Saathi Secure Plus – Individual' : 'Individual Health Insurance',
    policyNumber,
    holderName,
    startDate,
    sumInsured,
    roomRentLimit,
    icuLimit: icu ? money(icu) : DEFAULT_RULES.icuLimit,
    coPayPercent,
    waitingPeriods: [
      { name: 'Initial waiting period (except accidents)', months: 1 },
      { name: 'Specific illnesses (cataract, hernia, joint replacement, ENT)', months: 24 },
      { name: 'Pre-existing diseases', months: 36 },
      { name: 'Maternity', months: 24 },
    ],
    subLimits: { cataractPerEye: 40000, maternity: 50000, ambulance: 2000 },
    exclusions,
    networkHospitals: [],
    summaryEnglish: `Your policy covers hospital stays up to ${inr(sumInsured)}. Room rent is covered up to ${inr(roomRentLimit)} per day; a costlier room reduces other charges too. You pay ${coPayPercent}% of every claim (co-pay), and some treatments have waiting periods: 30 days for most illnesses, 2 years for cataract, joint replacement and maternity, 3 years for pre-existing diseases.`,
    summaryHindi: `आपकी पॉलिसी अस्पताल में भर्ती होने पर ${inr(sumInsured)} तक का खर्च कवर करती है। कमरे का किराया ${inr(roomRentLimit)} प्रति दिन तक कवर है; महंगा कमरा लेने पर बाकी खर्चों में भी कटौती होती है। हर क्लेम में ${coPayPercent}% आपको देना होगा (को-पे)। वेटिंग पीरियड: ज़्यादातर बीमारियों के लिए 30 दिन, मोतियाबिंद, जॉइंट रिप्लेसमेंट और मैटरनिटी के लिए 2 साल, और पहले से मौजूद बीमारियों के लिए 3 साल।`,
  };
}

// ---------- 2. Policy chat ----------
export interface ChatContext {
  policy: PolicyRules & { policyNumber: string; insurer: string; exclusions: string[]; summary?: string | null };
  claim?: { claimNumber: string; status: string; hospital: string; billAmount?: number | null; approvedAmount?: number | null; missingDocs?: string[] } | null;
}
export async function askPolicy(ctx: ChatContext, question: string) {
  return withLLM(
    chatAnswerSchema,
    'You are Claim Saathi, a friendly health-insurance helper for Indian customers. Answer in 2-4 short sentences of simple English (or Hindi if asked in Hindi) using ONLY the policy and claim data given. Mention rupee amounts with ₹. Reply JSON {answer, sources:[policy clause names], followUps:[2 short suggested questions]}.',
    JSON.stringify({ policy: ctx.policy, claim: ctx.claim, question }),
    () => mockAnswer(ctx, question),
  );
}

function mockAnswer(ctx: ChatContext, q: string) {
  const p = ctx.policy;
  const t = q.toLowerCase();
  const fu = ['How much will I get for my claim?', 'Which documents are still pending?'];
  if (/room|rent|ward|icu/.test(t))
    return { answer: `Room rent is covered up to ${inr(p.roomRentLimit)} per day, and ICU up to ${inr(p.icuLimit ?? 10000)} per day. If you pick a costlier room, the room and related charges (nursing, OT, doctor fees) are paid in the same proportion, so choose a room within the limit to avoid a cut.`, sources: ['Room rent', 'ICU'], followUps: fu };
  if (/co-?pay|copay|share|pay myself/.test(t))
    return { answer: `Your policy has a ${p.coPayPercent}% co-pay. For every admissible claim you pay ${p.coPayPercent}% and the insurer pays the rest. Example: on an admissible ₹50,000, you pay ₹5,000.`, sources: ['Co-payment'], followUps: fu };
  if (/wait|waiting|when can|eligible/.test(t))
    return { answer: 'Waiting periods: 30 days for most illnesses (accidents are covered from day 1), 24 months for cataract, hernia, joint replacement and ENT, 24 months for maternity, and 36 months for pre-existing diseases.', sources: ['Waiting periods'], followUps: fu };
  if (/matern|pregnan|deliver|baby/.test(t))
    return { answer: `Maternity is covered up to ${inr(50000)}, but only after a 24-month waiting period from your policy start date.`, sources: ['Maternity'], followUps: fu };
  if (/cataract|eye/.test(t))
    return { answer: `Cataract surgery is covered up to ${inr(40000)} per eye after a 24-month waiting period. Anything above that is a deduction.`, sources: ['Cataract'], followUps: fu };
  if (/exclu|not covered|cover/.test(t) && /exclu|not/.test(t))
    return { answer: `Not covered: ${p.exclusions.slice(0, 4).join('; ')}.`, sources: ['Exclusions'], followUps: fu };
  if (ctx.claim && /status|claim|where|update/.test(t))
    return { answer: `Your claim ${ctx.claim.claimNumber} at ${ctx.claim.hospital} is ${ctx.claim.status.replace(/_/g, ' ').toLowerCase()}.${ctx.claim.missingDocs?.length ? ` Still needed: ${ctx.claim.missingDocs.join(', ')}.` : ''}`, sources: ['Claim timeline'], followUps: fu };
  if (ctx.claim && /how much|amount|get|settle|deduct/.test(t))
    return { answer: ctx.claim.approvedAmount != null ? `For claim ${ctx.claim.claimNumber}, the payable amount is ${inr(ctx.claim.approvedAmount)} out of a bill of ${inr(ctx.claim.billAmount ?? 0)}. The difference is the ${p.coPayPercent}% co-pay plus any policy limits; open Settlement to see each deduction.` : 'Your settlement will be calculated as soon as all documents are verified. I will show every deduction with its reason.', sources: ['Settlement'], followUps: fu };
  if (/sum insured|cover amount|limit|how much cover/.test(t))
    return { answer: `Your sum insured is ${inr(p.sumInsured)} per year for hospitalisation.`, sources: ['Sum insured'], followUps: fu };
  if (/document|upload|papers/.test(t))
    return { answer: 'For reimbursement, upload the claim form, discharge summary, final itemised bill, pharmacy bills, lab reports and prescriptions within 30 days of discharge. I check each one as soon as you upload it.', sources: ['Claim process'], followUps: fu };
  return { answer: p.summary || `Your ${p.insurer} policy ${p.policyNumber} covers hospitalisation up to ${inr(p.sumInsured)} with a ${p.coPayPercent}% co-pay and room rent up to ${inr(p.roomRentLimit)}/day.`, sources: ['Policy summary'], followUps: ['What is my room rent limit?', 'Is maternity covered?'] };
}

// ---------- 3. Coverage ----------
export async function checkCoverage(policy: PolicyRules, claim: ClaimFacts): Promise<CoverageResult> {
  // Numbers always come from the rules engine; an LLM may only rephrase the explanation.
  return checkCoverageRules(policy, claim);
}

// ---------- 4. Document validation ----------
export interface DocContext {
  declaredType: string;
  fileName: string;
  mimeType: string;
  policyHolder: string;
  policyStart: Date;
  policyEnd?: Date | null;
  admissionDate?: Date | null;
  claimAmount?: number | null;
  hospital?: string | null;
}

const TYPE_KEYWORDS: [string, RegExp][] = [
  ['PREAUTH_FORM', /pre-?authori[sz]ation|cashless hospitalisation/i],
  ['DOCTOR_ESTIMATE', /treatment estimate|doctor's certificate/i],
  ['DISCHARGE_SUMMARY', /discharge summary/i],
  ['PHARMACY_BILL', /pharmacy bill|retail invoice|discharge medicines/i],
  ['HOSPITAL_BILL', /final hospital bill|final bill|tax invoice|itemised/i],
  ['LAB_REPORT', /investigation report|laboratory report|lab report/i],
  ['CLAIM_FORM', /claim form/i],
  ['POLICY_SCHEDULE', /policy schedule|certificate of insurance/i],
  ['HEALTH_CARD', /health e-?card/i],
  ['PRESCRIPTION', /prescription|℞/i],
  ['PAYMENT_RECEIPT', /payment receipt|receipt no/i],
];
export function detectDocType(text: string, fileName = ''): string | null {
  // Titles sit near the top of a document, so check the header first, then the full text.
  const head = text.slice(0, 600);
  for (const [type, re] of TYPE_KEYWORDS) if (re.test(head)) return type;
  for (const [type, re] of TYPE_KEYWORDS) if (re.test(text)) return type;
  const f = fileName.toLowerCase();
  if (/bill/.test(f)) return /pharm/.test(f) ? 'PHARMACY_BILL' : 'HOSPITAL_BILL';
  if (/discharge/.test(f)) return 'DISCHARGE_SUMMARY';
  if (/lab|report/.test(f)) return 'LAB_REPORT';
  if (/prescri/.test(f)) return 'PRESCRIPTION';
  if (/claim_?form/.test(f)) return 'CLAIM_FORM';
  if (/ecard|e-card/.test(f)) return 'HEALTH_CARD';
  if (/policy/.test(f)) return 'POLICY_SCHEDULE';
  if (/pre-?auth/.test(f)) return 'PREAUTH_FORM';
  if (/estimate/.test(f)) return 'DOCTOR_ESTIMATE';
  if (/receipt/.test(f)) return 'PAYMENT_RECEIPT';
  return null;
}

export async function validateDocument(ex: Extracted, ctx: DocContext): Promise<DocValidation> {
  const rules = mockValidate(ex, ctx);
  if (!llmEnabled() || !ex.text) return docValidationSchema.parse(rules);
  try {
    const llm = docValidationSchema.parse(
      await completeJSON(
        'You validate Indian hospital/insurance claim documents. Check: readable, document type, patient name matches the policy holder, dates inside the policy period, amounts consistent, signature/stamp present. Reply JSON {valid, confidence 0-1, detectedType, issues:[{code, severity: low|medium|high, message}], checks:{readable, typeMatches, nameMatches, dateInPolicyPeriod, amountConsistent, hasSignature}, extracted:{name, date, amount, doctor, hospital, hasSignature}, fix (exact instruction for the customer or null), summary}.',
        JSON.stringify({ context: ctx, text: ex.text.slice(0, 8000) }),
      ),
    );
    // Guardrail: never be more confident than the deterministic checks allow.
    return { ...llm, confidence: Math.min(llm.confidence, rules.confidence + 0.05), valid: llm.valid && rules.valid };
  } catch (e) {
    console.warn('[ai] validateDocument LLM failed:', (e as Error).message);
    return docValidationSchema.parse(rules);
  }
}

export function mockValidate(ex: Extracted, ctx: DocContext): DocValidation {
  const text = ex.text || '';
  const flat = text.replace(/\n/g, ' ');
  const issues: DocValidation['issues'] = [];
  let conf = 0.96;
  const label = docLabel(ctx.declaredType);

  // Readability
  const isImage = ctx.mimeType.startsWith('image/');
  let readable = text.length >= 80;
  if (isImage && ex.method === 'ocr') readable = (ex.ocrConfidence ?? 0) >= 0.6 && text.length >= 80;
  if (!readable) {
    conf = isImage ? 0.41 : 0.35;
    issues.push({
      code: 'UNREADABLE',
      severity: 'high',
      message: isImage
        ? 'The photo is blurry or tilted, so the bill number, dates and amounts cannot be read reliably.'
        : 'The file has no readable text (it may be a scan without text or a corrupted file).',
    });
  }

  // Type
  const detected = detectDocType(text, ctx.fileName) || ctx.declaredType;
  const typeMatches = !readable || detected === ctx.declaredType || ctx.declaredType === 'OTHER';
  if (readable && !typeMatches) {
    conf -= 0.3;
    issues.push({ code: 'WRONG_TYPE', severity: 'high', message: `This looks like a ${docLabel(detected).toLowerCase()}, not a ${label.toLowerCase()}.` });
  }

  // Extract fields
  const holder = ctx.policyHolder.trim();
  const STOP = new Set(['Date', 'Age', 'Relationship', 'Self', 'Prescribed', 'Policy', 'Gender', 'Mobile', 'Referred', 'Bill', 'Sample', 'Admission', 'Discharge', 'Consultant', 'Payer', 'Email', 'Contact', 'Treating', 'Diagnosis', 'Ward', 'Member', 'Hospital', 'Invoice', 'Occupation', 'Address', 'Valid', 'Sum']);
  const nameAfter = (lbl: string) => {
    const m = flat.match(new RegExp(`${lbl}\\s*((?:[A-Z][a-z]+|[A-Z]\\.)(?:\\s(?:[A-Z][a-z]+|[A-Z]\\.)){0,4})`));
    if (!m) return null;
    const out: string[] = [];
    for (const t of m[1].split(/\s+/)) {
      if (STOP.has(t)) break;
      out.push(t);
    }
    return out.length >= 2 ? out.join(' ') : null;
  };
  const labelled = nameAfter('Patient(?: name)?') || nameAfter('Policy holder') || nameAfter('Name');
  const exact = flat.includes(holder);
  let nameMatches: boolean | null = null;
  let foundName: string | null = labelled;
  if (readable) {
    if (labelled) {
      const clean = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
      const a = clean(labelled);
      const b = clean(holder);
      if (a.join(' ') === b.join(' ')) nameMatches = true;
      else if (b.every((w) => a.includes(w))) {
        nameMatches = false;
        conf -= 0.24;
        issues.push({ code: 'NAME_VARIATION', severity: 'medium', message: `Name on the document is "${labelled}" but the policy says "${holder}".` });
      } else if (exact) {
        nameMatches = true;
        foundName = holder;
      } else {
        nameMatches = false;
        conf -= 0.45;
        issues.push({ code: 'NAME_MISMATCH', severity: 'high', message: `Patient name "${labelled}" does not match the policy holder "${holder}".` });
      }
    } else if (exact) {
      nameMatches = true;
      foundName = holder;
    }
  }

  const dates = [...flat.matchAll(/\b\d{1,2}-[A-Z][a-z]{2}-\d{4}\b/g)].map((m) => m[0]);
  const relevantDate = dates.find((d) => { const x = parseDocDate(d); return x && x >= ctx.policyStart; }) ?? dates[0] ?? null;
  let dateInPolicyPeriod: boolean | null = null;
  if (readable && relevantDate && !['POLICY_SCHEDULE', 'HEALTH_CARD'].includes(ctx.declaredType)) {
    const d = parseDocDate(ctx.admissionDate ? dates.find((x) => parseDocDate(x)?.toDateString() === ctx.admissionDate!.toDateString()) ?? relevantDate : relevantDate)!;
    dateInPolicyPeriod = d >= ctx.policyStart && (!ctx.policyEnd || d <= ctx.policyEnd);
    if (!dateInPolicyPeriod) {
      conf -= 0.3;
      issues.push({ code: 'DATE_OUTSIDE_POLICY', severity: 'high', message: `Treatment date ${fmtDate(d)} is outside the policy period.` });
    }
  }

  let amount: number | null = null;
  const am = flat.match(/(?:Net payable|Gross total|Total claimed|Total estimated cost|Amount paid|Total)\s*:?\s*(?:₹|Rs\.?|INR)\s?([\d,]+)/i);
  if (am) amount = money(am[1]);
  let amountConsistent: boolean | null = null;
  if (readable && ctx.declaredType === 'HOSPITAL_BILL' && amount && ctx.claimAmount) {
    amountConsistent = Math.abs(amount - ctx.claimAmount) <= Math.max(100, ctx.claimAmount * 0.01);
    if (!amountConsistent) {
      conf -= 0.2;
      issues.push({ code: 'AMOUNT_MISMATCH', severity: 'medium', message: `Bill total ${inr(amount)} differs from the claimed ${inr(ctx.claimAmount)}.` });
    }
  }

  const doctor = flat.match(/Dr\.\s[A-Z][a-z]+\s[A-Z][a-z]+/)?.[0] ?? null;
  const hasSignature = readable && /(Reg\. No|Signature|Authorised|Pharmacist|Billing Executive|Pathologist|Treating doctor|VERIFIED)/i.test(flat);
  if (readable && !hasSignature && !['HEALTH_CARD', 'POLICY_SCHEDULE'].includes(ctx.declaredType)) {
    conf -= 0.1;
    issues.push({ code: 'NO_SIGNATURE', severity: 'low', message: 'No doctor or hospital signature / stamp found.' });
  }
  const hospital = ctx.hospital && flat.toLowerCase().includes(ctx.hospital.toLowerCase()) ? ctx.hospital : null;

  conf = Math.max(0.05, Math.min(0.99, Number(conf.toFixed(2))));
  const valid = !issues.some((i) => i.severity === 'high') && conf >= 0.8;
  const fixFor: Record<string, string> = {
    UNREADABLE: `Re-upload the ${label.toLowerCase()} as the original PDF from the hospital, or a sharp photo taken flat in good light with all four corners visible.`,
    WRONG_TYPE: `Upload the ${label.toLowerCase()} itself. The file you sent is a ${docLabel(detected).toLowerCase()}.`,
    NAME_VARIATION: `Upload a photo ID (Aadhaar/PAN) or a name-correction letter from the hospital so we can confirm "${foundName}" and "${holder}" are the same person.`,
    NAME_MISMATCH: `This document seems to belong to someone else. Upload the ${label.toLowerCase()} issued in the name of ${holder}.`,
    DATE_OUTSIDE_POLICY: 'Check the treatment date. If the hospital printed a wrong date, ask for a corrected copy.',
    AMOUNT_MISMATCH: 'Upload the final itemised bill that matches the amount you claimed, or update the claim amount.',
    NO_SIGNATURE: 'Ask the hospital to sign and stamp this document, then upload it again.',
  };
  const first = issues.sort((a, b) => (a.severity === 'high' ? -1 : b.severity === 'high' ? 1 : 0))[0];
  return {
    valid,
    confidence: conf,
    detectedType: detected,
    issues,
    checks: { readable, typeMatches, nameMatches, dateInPolicyPeriod, amountConsistent, hasSignature },
    extracted: { name: foundName, date: relevantDate, amount, doctor, hospital, hasSignature },
    fix: first ? fixFor[first.code] ?? null : null,
    summary: valid
      ? `${label} verified: name, dates${amount ? ', amount' : ''} and signature check out.`
      : `${label} needs attention: ${issues.map((i) => i.message).join(' ')}`,
  };
}

// ---------- 5. Query helpers ----------
export async function explainQuery(text: string) {
  return withLLM(queryExplainSchema, 'Explain an insurer query to an Indian customer in simple words. JSON {explanation, nextSteps:[string]}.', text, () => ({
    explanation: `The claims team needs one more thing before they can finish your claim: ${text.replace(/^please\s*/i, '').replace(/\.$/, '')}.`,
    nextSteps: ['Open the claim in the app', 'Tap "Respond" on the query', 'Upload the document or type your answer'],
  }));
}

export async function draftQueryMessage(missing: string[], ctx: { patientName: string; hospital: string; claimNumber: string }) {
  const labels = missing.map((m) => docLabel(m).toLowerCase());
  const reasons: Record<string, string> = {
    LAB_REPORT: 'the lab / investigation reports (for example Widal test and blood culture) that confirm the diagnosis',
    HOSPITAL_BILL: 'the final itemised hospital bill with the payment receipt',
    DISCHARGE_SUMMARY: 'the discharge summary signed by the treating doctor',
    PHARMACY_BILL: 'the pharmacy bills for discharge medicines',
    PRESCRIPTION: "the doctor's prescription",
    CLAIM_FORM: 'the signed claim form (Part A)',
  };
  return withLLM(
    queryDraftSchema,
    'Write a short, polite query to an Indian health-insurance customer asking for missing claim documents. Plain English, max 3 sentences. JSON {message}.',
    JSON.stringify({ missing: labels, ...ctx }),
    () => ({
      message: `Hi ${ctx.patientName.split(' ')[0]}, to process claim ${ctx.claimNumber} (${ctx.hospital}) please upload ${missing.map((m) => reasons[m] ?? docLabel(m).toLowerCase()).join(', ')}. A clear PDF or photo is fine. Your claim continues automatically once it is uploaded.`,
    }),
  );
}

// ---------- 6. Settlement ----------
export async function calculateSettlement(policy: PolicyRules, claim: ClaimFacts) {
  return calculateSettlementRules(policy, claim);
}

// ---------- 7. Claim summary for ops ----------
export interface SummaryInput {
  claimNumber: string;
  patientName: string;
  hospital: string;
  reason: string;
  claimType: string;
  amount: number;
  approvedAmount: number | null;
  deductions: { label: string; amount: number }[];
  flags: string[];
  docIssues: string[];
  coverage: CoverageResult | null;
  confidence: number;
  stage?: 'PREAUTH' | 'FINAL';
}
export async function summarizeClaim(i: SummaryInput): Promise<ClaimSummary> {
  return withLLM(
    claimSummarySchema,
    'You are a senior health-claims assessor. Write exactly 3 short lines for the ops team (what happened, what the AI found, what to decide) and suggest a decision. JSON {summary:[3 strings], suggestedDecision: APPROVE|PARTIAL_APPROVE|REJECT|REQUEST_INFO|APPROVE_PREAUTH, suggestedAmount, reason, confidence 0-1}. Amounts must come from the input.',
    JSON.stringify(i),
    () => mockSummary(i),
  );
}

export function mockSummary(i: SummaryInput): ClaimSummary {
  const first = i.patientName.split(' ')[0];
  const line1 = `${i.claimType === 'CASHLESS' ? 'Cashless' : 'Reimbursement'} claim of ${inr(i.amount)} for ${first} at ${i.hospital}: ${i.reason}.`;
  if (i.coverage && !i.coverage.covered) {
    return {
      summary: [line1, `Not admissible: ${i.coverage.waitingPeriodIssue}`, `Suggest REJECT citing "${i.coverage.clauses[0] ?? 'policy waiting period'}". Documents themselves are in order.`],
      suggestedDecision: 'REJECT',
      suggestedAmount: 0,
      reason: i.coverage.waitingPeriodIssue ?? 'Waiting period',
      confidence: 0.95,
    };
  }
  if (i.stage === 'PREAUTH') {
    return {
      summary: [line1, `Estimate is above ${inr(100000)}; ${i.deductions.filter((d) => !/co-pay/i.test(d.label)).map((d) => `${d.label.toLowerCase()} ${inr(d.amount)}`).join(', ') || 'no limits breached'}, 10% co-pay applies.`, `Suggest approving pre-auth for ${inr(i.approvedAmount ?? 0)}; final bill to be re-checked at discharge.`],
      suggestedDecision: 'APPROVE_PREAUTH',
      suggestedAmount: i.approvedAmount,
      reason: 'Planned procedure, policy older than 36 months, network hospital, estimate within sum insured.',
      confidence: 0.88,
    };
  }
  const nonCopay = i.deductions.filter((d) => !/co-pay/i.test(d.label));
  const found = [...i.docIssues, ...nonCopay.map((d) => `${d.label} ${inr(d.amount)}`)];
  const partial = nonCopay.reduce((a, d) => a + d.amount, 0) > i.amount * 0.02 || i.docIssues.length > 0;
  return {
    summary: [
      line1,
      found.length ? `AI found: ${found.slice(0, 3).join('; ')}.` : 'All documents verified; no policy limits breached.',
      `Suggest ${partial ? 'partial approval' : 'approval'} of ${inr(i.approvedAmount ?? 0)} after deductions and 10% co-pay${i.flags.includes('HIGH_VALUE') ? ' (above the ₹1,00,000 auto-approve limit)' : ''}.`,
    ],
    suggestedDecision: partial ? 'PARTIAL_APPROVE' : 'APPROVE',
    suggestedAmount: i.approvedAmount,
    reason: i.flags.length ? i.flags.map((f) => f.toLowerCase().replace(/_/g, ' ')).join(', ') : found.length ? found.slice(0, 2).join('; ') : 'Clean claim',
    confidence: i.confidence,
  };
}

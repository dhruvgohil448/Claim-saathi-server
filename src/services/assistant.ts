/**
 * Claim Saathi assistant. Grounded only in the signed-in user's policy + claim rows.
 * Mock mode (default): intent rules over live DB data. With a real LLM configured, the same
 * grounded context is sent to ai.askPolicy and the rules answer is the fallback.
 */
import { prisma } from '../utils/prisma';
import { llmEnabled, env } from '../config/env';
import * as ai from './ai.service';
import * as tools from '../tools';
import { analyzePolicy, appChecklist } from './mobile';
import { docLabel, inr, fmtDate } from '../utils/format';
import { notFound, forbidden } from '../utils/errors';
import { financeAnswer } from '../demo/finance';

const STATUS_TEXT: Record<string, string> = {
  CREATED: 'submitted and being checked', PREAUTH_SUBMITTED: 'waiting for pre-authorisation', DOCS_PENDING: 'waiting for documents', UNDER_REVIEW: 'under review',
  QUERY_RAISED: 'waiting for your reply to a query', NEEDS_HUMAN: 'with a claims specialist', APPROVED: 'approved', REJECTED: 'not approved', SETTLED: 'settled (paid)',
};

async function chatCore(user: { id: string; role: string }, message: string, claimId?: string) {
  const staff = user.role !== 'CUSTOMER';
  const claim = claimId
    ? await prisma.claim.findFirst({ where: { OR: [{ id: claimId }, { claimNumber: claimId }] }, include: { documents: true, queries: { orderBy: { createdAt: 'desc' } }, settlement: true, events: { orderBy: { createdAt: 'asc' } }, policy: true } })
    : await prisma.claim.findFirst({ where: { userId: user.id }, orderBy: { lastActivityAt: 'desc' }, include: { documents: true, queries: { orderBy: { createdAt: 'desc' } }, settlement: true, events: { orderBy: { createdAt: 'asc' } }, policy: true } });
  if (claimId && !claim) throw notFound('Claim not found');
  if (claim && !staff && claim.userId !== user.id) throw forbidden();
  const policy = claim?.policy ?? (await prisma.policy.findFirst({ where: { userId: user.id }, orderBy: { startDate: 'desc' } }));
  if (!policy) return { answer: 'I could not find a policy on your account yet. Link your policy first and I can explain your cover and claims.', intent: 'NO_POLICY', sources: [], followUps: ['How do I link my policy?'], grounded: null, ai: 'mock' };

  const a = analyzePolicy(policy);
  const ck = claim ? appChecklist(claim) : null;
  const t = message.toLowerCase();
  const fu = (xs: string[]) => xs.slice(0, 3);
  const grounded = { policyNumber: policy.policyNumber, claimNumber: claim?.claimNumber ?? null };

  if (llmEnabled()) {
    try {
      const r = await ai.askPolicy({ policy: { ...tools.policyRules(policy), policyNumber: policy.policyNumber, insurer: policy.insurer, exclusions: a.exclusions, summary: a.whatIsCovered }, claim: claim ? { claimNumber: claim.claimNumber, status: claim.status, hospital: claim.hospital, billAmount: claim.billAmount ?? claim.estimatedAmount, approvedAmount: claim.settlement?.approvedAmount ?? null, missingDocs: ck!.items.filter((i) => i.status === 'missing').map((i) => i.label) } : null }, message);
      return { ...r, intent: 'LLM', grounded, ai: env.aiProvider };
    } catch { /* fall back to rules */ }
  }
  const say = (intent: string, answer: string, sources: string[], followUps: string[]) => ({ answer, intent, sources, followUps: fu(followUps), grounded, ai: 'mock' as const });

  // Specific term in exclusions / sub-limits / waiting periods ("is cataract covered?")
  const words = t.match(/[a-z]{4,}/g) ?? [];
  const STOP = new Set(['covered', 'cover', 'coverage', 'what', 'does', 'policy', 'claim', 'will', 'have', 'there', 'about', 'with', 'from', 'this', 'that', 'much', 'insurance', 'included', 'include']);
  const terms = words.filter((w) => !STOP.has(w));
  const exHit = a.exclusions.find((e) => terms.some((w) => e.toLowerCase().includes(w)));
  const wpHit = a.waitingPeriods.find((w) => terms.some((x) => w.name.toLowerCase().includes(x)));
  const subHit = a.coverage.find((c) => c.item !== 'Room rent' && terms.some((x) => c.item.toLowerCase().includes(x)));

  if (/reject|why.*(flag|invalid|fail)|not accepted|re-?upload/.test(t) && claim) {
    const bad = ck!.items.filter((i) => i.status === 'rejected');
    if (claim.status === 'REJECTED') {
      const ev = [...claim.events].reverse().find((e) => e.status === 'REJECTED');
      return say('CLAIM_REJECTED', `Claim ${claim.claimNumber} was not approved. Reason recorded: ${ev?.description ?? 'not admissible under the policy terms'}.`, ['Claim timeline'], ['What is not covered by my policy?']);
    }
    if (bad.length) return say('DOC_REJECTED', bad.map((b) => `${b.label}: ${b.reason ?? 'could not be verified'}${b.fix ? ` Fix: ${b.fix}` : ''}`).join(' '), bad.map((b) => b.label), ['Which documents are still pending?']);
    return say('DOC_REJECTED', `None of the documents on ${claim.claimNumber} are rejected right now.`, ['Document checklist'], ['Which documents are still pending?']);
  }
  if (/document|upload|pending|missing|checklist|papers|required/.test(t) && claim) {
    const miss = ck!.items.filter((i) => i.status === 'missing');
    const bad = ck!.items.filter((i) => i.status === 'rejected');
    const parts = [
      `${ck!.progress.verified} of ${ck!.progress.required} required documents on ${claim.claimNumber} are verified.`,
      miss.length ? `Still needed: ${miss.map((m) => m.label.toLowerCase()).join(', ')}.` : 'Nothing is missing.',
      bad.length ? `Please re-upload: ${bad.map((b) => b.label.toLowerCase()).join(', ')}.` : '',
    ];
    return say('DOCUMENTS', parts.filter(Boolean).join(' '), ['Document checklist'], ['Why was my document rejected?', 'Where is my claim?']);
  }
  if (/query|question from|asked me/.test(t) && claim) {
    const open = claim.queries.filter((q) => q.status === 'OPEN');
    return say('QUERIES', open.length ? `There ${open.length === 1 ? 'is 1 open query' : `are ${open.length} open queries`} on ${claim.claimNumber}: ${open.map((q) => `"${q.message}"${q.requestedDocType ? ` (needs ${docLabel(q.requestedDocType).toLowerCase()})` : ''}`).join(' ')}` : `No open queries on ${claim.claimNumber}.`, ['Queries'], ['Which documents are still pending?']);
  }
  if (/settle|how much|amount|deduct|payout|pay me|get back|approved amount|money/.test(t) && claim) {
    const s: { status: string; approvedAmount: number; billAmount: number; deductions: unknown } = claim.settlement ?? { ...(await ai.calculateSettlement(tools.policyRules(policy), tools.claimFacts(claim as unknown as tools.FullClaim))), status: 'PREVIEW' };
    const ded = (s.deductions as unknown as { label: string; amount: number }[]) ?? [];
    return say('SETTLEMENT', `${s.status === 'PAID' ? 'Paid' : s.status === 'PREVIEW' ? 'Estimated' : 'Payable'}: ${inr(s.approvedAmount)} of ${inr(s.billAmount)} on ${claim.claimNumber}.${ded.length ? ` Deductions: ${ded.map((d) => `${d.label} ${inr(d.amount)}`).join(', ')}.` : ' No deductions.'}`, ['Settlement'], ['Why was money deducted?', 'Where is my claim?']);
  }
  if (/status|where|track|update|progress|when/.test(t) && claim && !wpHit) {
    const last = claim.events[claim.events.length - 1];
    const miss = ck!.items.filter((i) => i.status === 'missing' || i.status === 'rejected');
    return say('STATUS', `Claim ${claim.claimNumber} at ${claim.hospital} is ${STATUS_TEXT[claim.status] ?? claim.status.toLowerCase()}. Latest update: ${last?.description ?? last?.title ?? 'none yet'}${miss.length && !['APPROVED', 'SETTLED', 'REJECTED'].includes(claim.status) ? ` Next step: upload ${miss.map((m) => m.label.toLowerCase()).join(', ')}.` : ''}`, ['Claim timeline'], ['How much will I get?', 'Which documents are still pending?']);
  }
  if (/room|rent|ward|icu/.test(t))
    return say('ROOM_RENT', `Room rent is covered up to ${inr(a.roomRentLimit)} per day${a.icuLimit ? ` and ICU up to ${inr(a.icuLimit)} per day` : ''}. A costlier room reduces room-linked charges in the same proportion.${claim?.roomRentPerDay ? ` Your claim lists ${inr(claim.roomRentPerDay)}/day, which is ${claim.roomRentPerDay > a.roomRentLimit ? 'above' : 'within'} the limit.` : ''}`, ['Room rent'], ['Is there a co-pay?']);
  if (/co-?pay|copay|my share/.test(t))
    return say('COPAY', a.coPayPercent ? `Your policy has a ${a.coPayPercent}% co-pay: you pay ${a.coPayPercent}% of every admissible claim.${claim ? ` On ${claim.claimNumber} that is about ${inr(Math.round(((claim.billAmount ?? claim.estimatedAmount ?? 0) * a.coPayPercent) / 100))}.` : ''}` : 'Your policy has no co-pay.', ['Co-payment'], ['How much will I get?']);
  if (wpHit || /wait|waiting/.test(t)) {
    const list = wpHit ? [wpHit] : a.waitingPeriods;
    return say('WAITING', list.length ? list.map((w) => `${w.name}: ${w.months} months (${w.active ? `covered from ${fmtDate(w.eligibleFrom)}` : 'already covered'})`).join('; ') + '.' : 'No waiting periods are recorded on your policy.', ['Waiting periods'], ['What is not covered?']);
  }
  if (exHit) return say('EXCLUSION', `Not covered: "${exHit}" is listed as an exclusion in policy ${policy.policyNumber}.`, ['Exclusions'], ['What is covered?']);
  if (subHit) return say('SUBLIMIT', `${subHit.item} is covered: ${subHit.detail}.`, ['Sub-limits'], ['What is not covered?']);
  if (/exclu|not covered|isn.?t covered/.test(t))
    return say('EXCLUSIONS', a.exclusions.length ? `Not covered under ${policy.policyNumber}: ${a.exclusions.join('; ')}.` : 'No exclusions are recorded on your policy. Upload the policy PDF so I can read them.', ['Exclusions'], ['What is covered?']);
  if (/sum insured|balance|left|remaining|limit|how much cover/.test(t)) {
    const used = await prisma.settlement.aggregate({ _sum: { approvedAmount: true }, where: { status: { in: ['APPROVED', 'PAID'] }, claim: { policyId: policy.id, createdAt: { gte: policy.startDate } } } });
    const u = used._sum.approvedAmount ?? 0;
    return say('SUM_INSURED', `Sum insured is ${inr(a.sumInsured)}. ${inr(u)} has been used by approved claims, so about ${inr(Math.max(0, a.sumInsured - u))} is left this policy year.`, ['Sum insured'], ['What is covered?']);
  }
  return say('POLICY_SUMMARY', a.whatIsCovered, ['Policy summary'], claim ? ['Where is my claim?', 'Which documents are still pending?', 'How much will I get?'] : ['What is not covered?', 'What is my room rent limit?']);
}

export const BASE_SUGGESTIONS = ['Where is my claim?', 'How much will I get?', 'Which documents are still pending?', 'What is my total balance?', 'How much did I spend on medical?', 'What is not covered?'];

/**
 * POST /api/ai/chat. Bank / finance questions are answered from the server's fixed demo finance data
 * (src/demo/finance.ts) plus the user's own settled claims; everything else stays grounded in the DB.
 * Every response carries suggestions[] (chips) and cards[] (finance cards, empty for non-finance answers).
 */
export async function chat(user: { id: string; role: string }, message: string, claimId?: string) {
  const fin = await financeAnswer(user.id, message);
  if (fin) {
    const policy = await prisma.policy.findFirst({ where: { userId: user.id }, orderBy: { startDate: 'desc' }, select: { policyNumber: true } });
    return { ...fin, grounded: { policyNumber: policy?.policyNumber ?? null, claimNumber: null }, ai: 'mock' as const, suggestions: [...new Set([...fin.followUps, ...BASE_SUGGESTIONS])].slice(0, 5) };
  }
  const r = await chatCore(user, message, claimId);
  const followUps = (r as { followUps?: string[] }).followUps ?? [];
  return { ...r, followUps, cards: [], suggestions: [...new Set([...followUps, ...BASE_SUGGESTIONS])].slice(0, 5) };
}

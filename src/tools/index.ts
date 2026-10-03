/**
 * Agent tools: plain functions that change the database through Prisma.
 * Every tool writes an ActivityLog row (actor AI unless told otherwise).
 */
import { ActorType, ClaimStatus, DocumentStatus, DocumentType, NotificationType, Prisma, SettlementStatus } from '@prisma/client';
import { prisma } from '../utils/prisma';
import * as ai from '../services/ai.service';
import { extractText } from '../services/extract';
import { readFile } from '../services/storage';
import { BillItem, PolicyRules, requiredDocTypes } from '../services/rules';
import { docLabel, inr } from '../utils/format';
import { publish, Topic } from '../realtime/hub';

type Json = Prisma.InputJsonValue;
import { DEMO_GATING, demoValidation, isDemoPackClaim, matchDemoDoc } from '../demo/demoDocs';

export interface LogInput {
  claimId?: string | null;
  action: string;
  reason: string;
  confidence?: number | null;
  actor?: ActorType;
  actorName?: string | null;
  meta?: Json;
}

const topicFor = (action: string): Topic =>
  action.startsWith('DOC') ? 'document' : action.includes('QUERY') ? 'query' : action.startsWith('POLICY') ? 'policy' : action.startsWith('USER') || action.startsWith('PROFILE') || action.startsWith('BANK') ? 'user' : action.includes('SETTLE') ? 'settlement' : 'claim';

export async function logActivity(i: LogInput) {
  const row = await prisma.activityLog.create({
    data: {
      claimId: i.claimId ?? null,
      action: i.action,
      reason: i.reason,
      confidence: i.confidence ?? null,
      actor: i.actor ?? 'AI',
      actorName: i.actorName ?? (i.actor === 'HUMAN' ? null : i.actor === 'SYSTEM' ? 'Follow-up job' : 'Claim Agent'),
      meta: i.meta ?? Prisma.JsonNull,
    },
  });
  publish({ topic: 'activity', claimId: i.claimId });
  publish({ topic: topicFor(i.action), claimId: i.claimId });
  return row;
}

export async function notifyUser(userId: string, n: { title: string; body: string; type?: NotificationType; claimId?: string | null }, log = true) {
  const row = await prisma.notification.create({ data: { userId, title: n.title, body: n.body, type: n.type ?? 'INFO', claimId: n.claimId ?? null } });
  publish({ topic: 'notification', userId, claimId: n.claimId });
  if (log) await logActivity({ claimId: n.claimId, action: 'NOTIFIED_CUSTOMER', reason: `${n.title}: ${n.body}` });
  return row;
}

export async function notifyOps(n: { title: string; body: string; type?: NotificationType; claimId?: string | null }) {
  const ops = await prisma.user.findMany({ where: { role: { in: ['OPS', 'ADMIN'] } }, select: { id: true } });
  await prisma.notification.createMany({ data: ops.map((u) => ({ userId: u.id, title: n.title, body: n.body, type: n.type ?? 'INFO', claimId: n.claimId ?? null })) });
  publish({ topic: 'notification', claimId: n.claimId });
}

const STATUS_TITLES: Record<ClaimStatus, string> = {
  CREATED: 'Claim submitted',
  PREAUTH_SUBMITTED: 'Pre-authorisation submitted',
  DOCS_PENDING: 'Documents pending',
  UNDER_REVIEW: 'Under review',
  QUERY_RAISED: 'Query raised',
  NEEDS_HUMAN: 'Sent to claims specialist',
  APPROVED: 'Claim approved',
  REJECTED: 'Claim rejected',
  SETTLED: 'Claim settled',
};

export async function updateClaimStatus(
  claimId: string,
  status: ClaimStatus,
  o: { description: string; actor?: ActorType; actorName?: string | null; confidence?: number | null; action?: string; title?: string },
) {
  const claim = await prisma.claim.update({ where: { id: claimId }, data: { status, lastActivityAt: new Date(), ...(status === 'NEEDS_HUMAN' ? {} : {}) } });
  await prisma.claimEvent.create({ data: { claimId, status, title: o.title ?? STATUS_TITLES[status], description: o.description, actor: o.actor ?? 'AI' } });
  await logActivity({ claimId, action: o.action ?? `STATUS_${status}`, reason: o.description, confidence: o.confidence, actor: o.actor ?? 'AI', actorName: o.actorName });
  return claim;
}

export async function updateDocumentStatus(
  documentId: string,
  status: DocumentStatus,
  o: { reason: string; confidence?: number | null; actor?: ActorType; actorName?: string | null; note?: string | null; action?: string },
) {
  const doc = await prisma.document.update({
    where: { id: documentId },
    data: { status, ...(o.actor === 'HUMAN' ? { reviewedBy: o.actorName ?? 'Ops', reviewNote: o.note ?? null } : {}), ...(o.confidence != null ? { confidence: o.confidence } : {}) },
  });
  await logActivity({ claimId: doc.claimId, action: o.action ?? `DOC_${status}`, reason: o.reason, confidence: o.confidence, actor: o.actor ?? 'AI', actorName: o.actorName, meta: { documentId, type: doc.type } });
  return doc;
}

export async function loadClaim(claimId: string) {
  return prisma.claim.findUniqueOrThrow({
    where: { id: claimId },
    include: { policy: true, user: true, documents: { orderBy: { createdAt: 'asc' } }, queries: true, settlement: true },
  });
}
export type FullClaim = Awaited<ReturnType<typeof loadClaim>>;

export function policyRules(p: FullClaim['policy']): PolicyRules {
  return {
    sumInsured: p.sumInsured,
    roomRentLimit: p.roomRentLimit,
    icuLimit: p.icuLimit,
    coPayPercent: p.coPayPercent,
    startDate: p.startDate,
    subLimits: (p.subLimits as PolicyRules['subLimits']) ?? null,
    waitingPeriods: (p.waitingPeriods as PolicyRules['waitingPeriods']) ?? null,
  };
}
export function claimFacts(c: FullClaim) {
  return {
    reason: c.reason,
    treatment: c.treatment,
    admissionDate: c.admissionDate,
    isAccident: c.isAccident,
    isNetworkHospital: c.isNetworkHospital,
    billAmount: c.billAmount,
    estimatedAmount: c.estimatedAmount,
    billItems: (c.billItems as unknown as BillItem[]) ?? null,
    roomRentPerDay: c.roomRentPerDay,
    days: c.days,
  };
}

/** OCR + AI validation of one document; saves the result and sets VERIFIED / NEEDS_REVIEW / INVALID. */
export async function validateDocument(documentId: string, threshold = 0.8) {
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  const claim = await loadClaim(doc.claimId);
  const buf = await readFile(doc.fileUrl);
  const ex = buf ? await extractText(buf, doc.mimeType || 'application/pdf') : { text: '', method: 'none' as const, note: 'File not found in storage' };
  // Fixed demo pack: recognise the exact document and return its predetermined extraction + validation.
  const demo = matchDemoDoc(buf, ex.text);
  if (demo) {
    const v = demoValidation(demo);
    const type = demo.type as DocumentType;
    await prisma.document.update({ where: { id: doc.id }, data: { type, status: 'VERIFIED', confidence: v.confidence, validationResult: { ...v, demoPack: { n: demo.n, marker: demo.marker, matchedBy: demo.matchedBy } } as unknown as Json, extractedData: { ...v.extracted, ...demo.details } as unknown as Json } });
    if (demo.claimPatch) await prisma.claim.update({ where: { id: doc.claimId }, data: demo.claimPatch });
    await logActivity({ claimId: doc.claimId, action: 'DOC_VERIFIED', reason: `${demo.label} auto-verified (demo pack ${String(demo.n).padStart(2, '0')}, matched by ${demo.matchedBy === 'sha256' ? 'file fingerprint' : 'document reference'}): ${demo.summary.replace(/^.*?verified:\s*/i, '')}`, confidence: v.confidence, meta: { documentId: doc.id, type, method: 'demo-pack', demoDoc: demo.n } });
    return { doc: { ...doc, type, status: 'VERIFIED' as DocumentStatus, confidence: v.confidence }, validation: v, claim: await loadClaim(doc.claimId) };
  }
  const v = await ai.validateDocument(ex, {
    declaredType: doc.type,
    fileName: doc.fileName,
    mimeType: doc.mimeType || 'application/pdf',
    policyHolder: claim.patientName,
    policyStart: claim.policy.startDate,
    policyEnd: claim.policy.endDate,
    admissionDate: claim.admissionDate,
    claimAmount: claim.billAmount ?? claim.estimatedAmount,
    hospital: claim.hospital,
  });
  const hardFail = v.issues.some((i) => ['WRONG_TYPE', 'NAME_MISMATCH'].includes(i.code));
  const status: DocumentStatus = v.valid && v.confidence >= threshold ? 'VERIFIED' : hardFail ? 'INVALID' : 'NEEDS_REVIEW';
  await prisma.document.update({
    where: { id: doc.id },
    data: { status, confidence: v.confidence, validationResult: v as unknown as Json, extractedData: v.extracted as unknown as Json },
  });
  await logActivity({
    claimId: doc.claimId,
    action: status === 'VERIFIED' ? 'DOC_VERIFIED' : 'DOC_FLAGGED',
    reason: status === 'VERIFIED' ? `${docLabel(doc.type)} auto-verified: ${v.summary.replace(/^.*?verified:\s*/i, '')}` : `${docLabel(doc.type)} flagged: ${v.issues.map((i) => i.message).join(' ')}`,
    confidence: v.confidence,
    meta: { documentId: doc.id, type: doc.type, method: ex.method },
  });
  return { doc: { ...doc, status }, validation: v, claim };
}

export async function checkCoverage(claimId: string) {
  const c = await loadClaim(claimId);
  const r = await ai.checkCoverage(policyRules(c.policy), claimFacts(c));
  const riskLevel = !r.covered ? 'HIGH' : r.riskFlags.length >= 2 ? 'MEDIUM' : r.riskFlags.length ? 'MEDIUM' : 'LOW';
  await prisma.claim.update({ where: { id: claimId }, data: { riskLevel, riskFlags: r.riskFlags, lastActivityAt: new Date() } });
  await logActivity({ claimId, action: 'COVERAGE_CHECKED', reason: r.explanation + (r.warnings.length ? ` ${r.warnings.join(' ')}` : ''), confidence: r.covered ? 0.93 : 0.97, meta: { covered: r.covered, clauses: r.clauses } });
  return r;
}

export async function submitPreauth(claimId: string, note: string) {
  return updateClaimStatus(claimId, 'PREAUTH_SUBMITTED', { description: note, action: 'PREAUTH_SUBMITTED', confidence: 0.92 });
}

export async function raiseQuery(claimId: string, message: string, requestedDocType: DocumentType | null, actor: ActorType = 'AI', actorName?: string | null) {
  const q = await prisma.query.create({ data: { claimId, message, requestedDocType, createdBy: actor } });
  const c = await prisma.claim.findUniqueOrThrow({ where: { id: claimId } });
  await updateClaimStatus(claimId, 'QUERY_RAISED', { description: message, actor, actorName, action: 'QUERY_RAISED', confidence: actor === 'AI' ? 0.9 : null });
  await notifyUser(c.userId, { title: `Action required on ${c.claimNumber}`, body: message, type: 'ACTION_REQUIRED', claimId }, false);
  return q;
}

export async function closeQuery(queryId: string, reason: string, actor: ActorType = 'AI', actorName?: string | null) {
  const q = await prisma.query.update({ where: { id: queryId }, data: { status: 'CLOSED', closedAt: new Date() } });
  await logActivity({ claimId: q.claimId, action: 'QUERY_CLOSED', reason, confidence: actor === 'AI' ? 0.94 : null, actor, actorName });
  return q;
}

export async function calculateSettlement(claimId: string, status: SettlementStatus = 'ESTIMATED') {
  const c = await loadClaim(claimId);
  const s = await ai.calculateSettlement(policyRules(c.policy), claimFacts(c));
  const data = { billAmount: s.billAmount, deductions: s.deductions as unknown as Json, coPayAmount: s.coPayAmount, approvedAmount: s.approvedAmount, explanation: s.explanation, status };
  await prisma.settlement.upsert({ where: { claimId }, create: { claimId, ...data }, update: data });
  await logActivity({ claimId, action: 'SETTLEMENT_CALCULATED', reason: s.explanation, confidence: 0.97, meta: { approvedAmount: s.approvedAmount } });
  return s;
}

export async function escalateToHuman(claimId: string, summary: ai.ClaimSummary, why: string) {
  const c = await prisma.claim.update({
    where: { id: claimId },
    data: { aiSummary: summary.summary.join('\n'), aiSuggestion: { decision: summary.suggestedDecision, amount: summary.suggestedAmount, reason: summary.reason }, aiConfidence: summary.confidence },
  });
  await updateClaimStatus(claimId, 'NEEDS_HUMAN', { description: `Escalated to a claims specialist: ${why}`, action: 'ESCALATED', confidence: summary.confidence });
  await notifyOps({ title: `${c.claimNumber} needs a human decision`, body: `${why}. AI suggests ${summary.suggestedDecision.replace('_', ' ').toLowerCase()}${summary.suggestedAmount != null ? ` for ${inr(summary.suggestedAmount)}` : ''}.`, type: 'ACTION_REQUIRED', claimId });
  await notifyUser(c.userId, { title: 'Your claim is with a specialist', body: `${c.claimNumber} is being checked by our claims team. You don't need to do anything right now.`, type: 'INFO', claimId }, false);
  return c;
}

/** Latest document per type → which required types are missing / flagged / verified. */
export function docProgress<D extends { type: string; status: string }>(c: { status: string; claimType: 'CASHLESS' | 'REIMBURSEMENT'; documents: D[]; policyId?: string | null }) {
  const stage = c.status === 'PREAUTH_SUBMITTED' || (c.claimType === 'CASHLESS' && !c.documents.some((d) => ['DISCHARGE_SUMMARY', 'HOSPITAL_BILL'].includes(d.type))) ? 'PREAUTH' : 'FINAL';
  const required = isDemoPackClaim(c) ? DEMO_GATING : requiredDocTypes(c.claimType, stage);
  const latest = new Map<string, D>();
  for (const d of c.documents) latest.set(d.type, d);
  const missing = required.filter((t) => !latest.has(t));
  const flagged = required.filter((t) => latest.has(t) && latest.get(t)!.status !== 'VERIFIED' && latest.get(t)!.status !== 'UPLOADED');
  const pending = required.filter((t) => latest.get(t)?.status === 'UPLOADED');
  const verified = required.filter((t) => latest.get(t)?.status === 'VERIFIED');
  return { stage, required, missing, flagged, pending, verified, latest };
}

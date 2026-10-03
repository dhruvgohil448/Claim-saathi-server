/**
 * Claim Agent: event → decide next step → call tools → DB updated → user + dashboard notified.
 * AGENT_PLANNER=rules (default) uses deterministic rules; AGENT_PLANNER=llm lets OpenAI/Gemini pick tools
 * through function calling (max 5 steps), with the same escalation guardrails enforced in code.
 */
import { DocumentType } from '@prisma/client';
import { bus } from '../events/bus';
import { env, llmEnabled } from '../config/env';
import { prisma } from '../utils/prisma';
import * as tools from '../tools';
import * as ai from '../services/ai.service';
import { runToolLoop, ToolSpec } from '../services/llm';
import { docLabel, inr } from '../utils/format';

const TERMINAL = ['APPROVED', 'REJECTED', 'SETTLED', 'NEEDS_HUMAN'];

// Serialize work per claim so two uploads at once don't race.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(claimId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(claimId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(claimId, next.catch(() => undefined));
  return next;
}

// ---------- policy.uploaded ----------
async function onPolicyUploaded({ policyId, userId }: { policyId: string; userId: string }) {
  const p = await prisma.policy.findUniqueOrThrow({ where: { id: policyId } });
  await tools.logActivity({ action: 'POLICY_EXTRACTED', reason: `Read policy ${p.policyNumber}: sum insured ${inr(p.sumInsured)}, room rent ${inr(p.roomRentLimit)}/day, ${p.coPayPercent}% co-pay, ${(p.waitingPeriods as unknown[]).length} waiting periods.`, confidence: 0.94, meta: { policyId } });
  await tools.notifyUser(userId, { title: 'Your policy, explained', body: p.summary ?? 'Your policy summary is ready.', type: 'SUCCESS' }, false);
}

// ---------- claim.created ----------
async function onClaimCreated({ claimId }: { claimId: string }) {
  return withLock(claimId, async () => {
    const cov = await tools.checkCoverage(claimId);
    const c = await tools.loadClaim(claimId);
    const rules = tools.policyRules(c.policy);
    if (!cov.covered) {
      await tools.notifyUser(c.userId, { title: 'Heads up about your claim', body: `${cov.waitingPeriodIssue} A claims specialist will confirm the decision.`, type: 'WARNING', claimId });
      const s = await ai.calculateSettlement(rules, tools.claimFacts(c));
      const summary = await ai.summarizeClaim(summaryInput(c, s, cov, [], 0.95));
      await tools.calculateSettlement(claimId, 'ESTIMATED');
      await tools.escalateToHuman(claimId, summary, 'Treatment falls inside a policy waiting period');
      return;
    }
    if (c.claimType === 'CASHLESS') {
      await tools.submitPreauth(claimId, `AI filled the pre-auth from the claim details and sent it to the TPA (${c.hospital} is a network hospital).`);
      const s = await tools.calculateSettlement(claimId, 'ESTIMATED');
      const amount = c.estimatedAmount ?? c.billAmount ?? 0;
      if (amount > env.escalationAmount) {
        const summary = await ai.summarizeClaim({ ...summaryInput(c, s, cov, [], 0.88), stage: 'PREAUTH' });
        await prisma.claim.update({ where: { id: claimId }, data: { aiSummary: summary.summary.join('\n'), aiSuggestion: { decision: summary.suggestedDecision, amount: summary.suggestedAmount, reason: summary.reason }, aiConfidence: summary.confidence } });
        await tools.logActivity({ claimId, action: 'PREAUTH_NOTE_DRAFTED', reason: `Estimate ${inr(amount)} is above ${inr(env.escalationAmount)}, so the AI drafted an approval note for ops: approve ${inr(s.approvedAmount)}.`, confidence: summary.confidence });
        await tools.notifyOps({ title: `Pre-auth note ready for ${c.claimNumber}`, body: `AI suggests approving ${inr(s.approvedAmount)} for ${c.patientName} at ${c.hospital}.`, type: 'ACTION_REQUIRED', claimId });
      } else {
        await tools.logActivity({ claimId, action: 'PREAUTH_APPROVED', reason: `Pre-auth auto-approved for ${inr(s.approvedAmount)} (estimate ${inr(amount)} within auto-approve limit).`, confidence: 0.92 });
        await tools.notifyUser(c.userId, { title: 'Cashless approved', body: `Pre-authorisation of ${inr(s.approvedAmount)} is approved at ${c.hospital}.`, type: 'SUCCESS', claimId });
      }
      return;
    }
    const prog = tools.docProgress(c);
    await tools.notifyUser(c.userId, {
      title: `Claim ${c.claimNumber} created`,
      body: prog.missing.length ? `Next, upload: ${prog.missing.map((m) => docLabel(m).toLowerCase()).join(', ')}. I'll check each one instantly.` : 'All documents received. Checking them now.',
      type: prog.missing.length ? 'ACTION_REQUIRED' : 'INFO',
      claimId,
    });
    await evaluate(claimId, false);
  });
}

// ---------- document.uploaded ----------
/** Validate an uploaded document and run the agent's follow-up steps. Awaitable so the API can return the result. */
export function processDocument(claimId: string, documentId: string, answeredQueryId?: string) {
  return withLock(claimId, async () => {
    const { doc, validation: v, claim } = await tools.validateDocument(documentId, env.autoVerifyConfidence);
    if (doc.status === 'VERIFIED') {
      const q = claim.queries.find((x) => x.status !== 'CLOSED' && (x.requestedDocType === doc.type || (x.id === answeredQueryId && !x.requestedDocType)));
      if (q) {
        await tools.closeQuery(q.id, `${docLabel(doc.type)} received and verified, so the query was closed automatically.`);
        const stillOpen = claim.queries.filter((x) => x.id !== q.id && x.status === 'OPEN').length;
        const prog = tools.docProgress(claim);
        if (!stillOpen && claim.status === 'QUERY_RAISED' && prog.missing.length)
          await tools.updateClaimStatus(claimId, 'DOCS_PENDING', { description: `Query resolved. Still waiting for ${prog.missing.map((m) => docLabel(m).toLowerCase()).join(', ')}.`, action: 'QUERY_RESOLVED', confidence: 0.9 });
      }
    } else {
      await tools.notifyUser(claim.userId, {
        title: `Please re-upload your ${docLabel(doc.type).toLowerCase()}`,
        body: `${v.issues[0]?.message ?? 'We could not verify this document.'} Fix: ${v.fix ?? 'upload a clearer copy.'}`,
        type: 'ACTION_REQUIRED',
        claimId,
      });
    }
    await evaluate(claimId, true);
    return { doc, validation: v };
  });
}
async function onDocumentUploaded({ claimId, documentId }: { claimId: string; documentId: string }) {
  await processDocument(claimId, documentId);
}

// ---------- query.answered ----------
async function onQueryAnswered({ claimId, queryId, documentId }: { claimId: string; queryId: string; documentId?: string }) {
  if (documentId) return onDocumentUploaded({ claimId, documentId });
  return withLock(claimId, async () => {
    const q = await prisma.query.findUniqueOrThrow({ where: { id: queryId } });
    if (q.requestedDocType) {
      const c = await prisma.claim.findUniqueOrThrow({ where: { id: claimId } });
      await tools.logActivity({ claimId, action: 'QUERY_RECHECKED', reason: `Customer replied "${(q.response ?? '').slice(0, 120)}" but the ${docLabel(q.requestedDocType).toLowerCase()} is still missing.`, confidence: 0.9 });
      await tools.notifyUser(c.userId, { title: 'Thanks! One more step', body: `Please attach the ${docLabel(q.requestedDocType).toLowerCase()} so we can continue.`, type: 'ACTION_REQUIRED', claimId }, false);
      return;
    }
    await tools.closeQuery(queryId, `Customer answered: "${(q.response ?? '').slice(0, 140)}". AI re-checked the claim and closed the query.`);
    await evaluate(claimId, false);
  });
}

// ---------- completeness check ----------
async function evaluate(claimId: string, afterUpload: boolean) {
  const c = await tools.loadClaim(claimId);
  if (TERMINAL.includes(c.status)) return;
  const prog = tools.docProgress(c);
  if (prog.stage === 'PREAUTH') return; // cashless pre-auth stage: wait for discharge documents

  if (env.agentPlanner === 'llm' && llmEnabled()) {
    const handled = await planWithLLM(c, prog).catch((e) => {
      console.warn('[agent] LLM planner failed, using rules:', e.message);
      return false;
    });
    if (handled) return;
  }

  if (!prog.missing.length) {
    for (const q of c.queries.filter((x) => x.status !== 'CLOSED' && !x.requestedDocType && x.createdBy === 'AI'))
      await tools.closeQuery(q.id, 'Every document the query asked for has now been uploaded, so it was closed automatically.');
  }
  if (prog.missing.length) {
    const open = c.queries.find((q) => q.status === 'OPEN');
    if (!open && (afterUpload || c.documents.length >= 3) && c.documents.some((d) => ['DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'LAB_REPORT', 'PHARMACY_BILL', 'PRESCRIPTION'].includes(d.type))) {
      const { message } = await ai.draftQueryMessage(prog.missing, { patientName: c.patientName, hospital: c.hospital, claimNumber: c.claimNumber });
      await tools.raiseQuery(claimId, message, prog.missing.length === 1 ? (prog.missing[0] as DocumentType) : null);
    } else if (c.status === 'CREATED' && afterUpload) {
      await tools.updateClaimStatus(claimId, 'DOCS_PENDING', { description: `Waiting for ${prog.missing.map((m) => docLabel(m).toLowerCase()).join(', ')}.`, action: 'DOCS_PENDING', confidence: 0.9 });
    }
    return;
  }
  if (prog.flagged.length) {
    if (c.status !== 'DOCS_PENDING' && c.status !== 'QUERY_RAISED')
      await tools.updateClaimStatus(claimId, 'DOCS_PENDING', { description: `Waiting for a corrected ${prog.flagged.map((m) => docLabel(m).toLowerCase()).join(', ')}.`, action: 'DOCS_PENDING', confidence: 0.85 });
    return;
  }
  if (prog.pending.length) return;
  bus.emitEvent('documents.complete', { claimId });
}

// ---------- documents.complete / claim.ready ----------
async function onDocumentsComplete({ claimId }: { claimId: string }) {
  return withLock(claimId, () => assess(claimId));
}

async function assess(claimId: string) {
  let c = await tools.loadClaim(claimId);
  if (TERMINAL.includes(c.status)) return;
  if (c.status !== 'UNDER_REVIEW')
    await tools.updateClaimStatus(claimId, 'UNDER_REVIEW', { description: 'All required documents verified. AI submitted the claim for assessment.', action: 'DOCS_COMPLETE', confidence: 0.95 });
  for (const q of c.queries.filter((x) => x.status !== 'CLOSED')) await tools.closeQuery(q.id, 'All documents are now verified, so the open query was closed.');
  const cov = await tools.checkCoverage(claimId);
  const s = await tools.calculateSettlement(claimId, 'ESTIMATED');
  c = await tools.loadClaim(claimId);
  const prog = tools.docProgress(c);
  const confs = prog.required.map((t) => prog.latest.get(t)?.confidence ?? 0.9);
  const confidence = Number(Math.min(...confs, cov.covered ? 0.97 : 0.6).toFixed(2));
  const amount = c.billAmount ?? c.estimatedAmount ?? 0;
  const reasons: string[] = [];
  if (!cov.covered) reasons.push('treatment falls inside a waiting period');
  if (confidence < env.autoVerifyConfidence) reasons.push(`AI confidence ${confidence} is below ${env.autoVerifyConfidence}`);
  if (amount > env.escalationAmount) reasons.push(`claim amount ${inr(amount)} is above ${inr(env.escalationAmount)}`);
  if (c.riskLevel === 'HIGH') reasons.push('high-risk claim');

  const summary = await ai.summarizeClaim(summaryInput(c, s, cov, [], confidence));
  await prisma.claim.update({ where: { id: claimId }, data: { aiSummary: summary.summary.join('\n'), aiSuggestion: { decision: summary.suggestedDecision, amount: summary.suggestedAmount, reason: summary.reason }, aiConfidence: confidence } });

  if (reasons.length) {
    await tools.escalateToHuman(claimId, summary, reasons.join('; ').replace(/^./, (x) => x.toUpperCase()));
    return;
  }
  await prisma.settlement.update({ where: { claimId }, data: { status: 'APPROVED' } });
  await tools.updateClaimStatus(claimId, 'APPROVED', { description: `Auto-approved: ${inr(s.approvedAmount)} payable after ${s.deductions.map((d) => d.label.toLowerCase()).join(', ') || 'no deductions'}.`, action: 'AUTO_APPROVED', confidence });
  await tools.notifyUser(c.userId, { title: `Claim ${c.claimNumber} approved`, body: `${inr(s.approvedAmount)} will be paid to your bank account. Bill ${inr(s.billAmount)}, deductions ${inr(s.billAmount - s.approvedAmount)}. Tap to see each deduction.`, type: 'SUCCESS', claimId }, false);
}

function summaryInput(c: tools.FullClaim, s: { approvedAmount: number; deductions: { label: string; amount: number }[] }, cov: ai.SummaryInput['coverage'], docIssues: string[], confidence: number): ai.SummaryInput {
  const issues = [
    ...docIssues,
    ...c.documents.filter((d) => d.status !== 'VERIFIED').map((d) => `${docLabel(d.type)}: ${((d.validationResult as any)?.issues?.[0]?.message as string) ?? d.status.toLowerCase()}`),
  ];
  return {
    claimNumber: c.claimNumber,
    patientName: c.patientName,
    hospital: c.hospital,
    reason: c.reason,
    claimType: c.claimType,
    amount: c.billAmount ?? c.estimatedAmount ?? 0,
    approvedAmount: s.approvedAmount,
    deductions: s.deductions,
    flags: (c.riskFlags as string[]) ?? [],
    docIssues: issues,
    coverage: cov,
    confidence,
  };
}

// ---------- optional LLM planner (function calling) ----------
const LLM_TOOLS: ToolSpec[] = [
  { name: 'raiseQuery', description: 'Ask the customer for missing documents or information.', parameters: { type: 'object', properties: { message: { type: 'string' }, requestedDocType: { type: 'string' } }, required: ['message'] } },
  { name: 'notifyUser', description: 'Send the customer a notification with an exact fix.', parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] } },
  { name: 'markDocsPending', description: 'Set the claim to DOCS_PENDING while waiting for corrected documents.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
  { name: 'submitForAssessment', description: 'All required documents are verified: submit the claim for settlement calculation and approval/escalation.', parameters: { type: 'object', properties: {} } },
  { name: 'escalateToHuman', description: 'Send to a human specialist when unsure or high risk.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
];

async function planWithLLM(c: tools.FullClaim, prog: ReturnType<typeof tools.docProgress<tools.FullClaim['documents'][number]>>): Promise<boolean> {
  const state = {
    claim: { number: c.claimNumber, status: c.status, type: c.claimType, amount: c.billAmount ?? c.estimatedAmount, reason: c.reason },
    requiredDocs: prog.required,
    missing: prog.missing,
    flagged: prog.flagged.map((t) => ({ type: t, issue: (prog.latest.get(t)?.validationResult as any)?.issues?.[0]?.message })),
    verified: prog.verified,
    openQueries: c.queries.filter((q) => q.status === 'OPEN').map((q) => q.message),
  };
  const calls = await runToolLoop(
    'You are the Claim Saathi claim agent for an Indian health insurer. Decide the next step for this claim using the tools. Rules: do not raise a duplicate query if one is open; if documents are missing, raise ONE query listing them; if a document is flagged, notify the customer with the exact fix and mark docs pending; if everything is verified, call submitForAssessment. Be brief.',
    JSON.stringify(state),
    LLM_TOOLS,
    async (name, args) => {
      if (name === 'raiseQuery') {
        if (c.queries.some((q) => q.status === 'OPEN')) return { skipped: 'query already open' };
        const t = String(args.requestedDocType ?? '');
        await tools.raiseQuery(c.id, String(args.message), (prog.missing.includes(t) ? t : null) as DocumentType | null);
        return { ok: true };
      }
      if (name === 'notifyUser') return tools.notifyUser(c.userId, { title: String(args.title), body: String(args.body), type: 'ACTION_REQUIRED', claimId: c.id }).then(() => ({ ok: true }));
      if (name === 'markDocsPending') return tools.updateClaimStatus(c.id, 'DOCS_PENDING', { description: String(args.reason), action: 'DOCS_PENDING' }).then(() => ({ ok: true }));
      if (name === 'submitForAssessment') {
        if (prog.missing.length || prog.flagged.length) return { refused: 'documents are not complete' }; // guardrail
        bus.emitEvent('documents.complete', { claimId: c.id });
        return { ok: true };
      }
      if (name === 'escalateToHuman') {
        const s = await tools.calculateSettlement(c.id, 'ESTIMATED');
        const sum = await ai.summarizeClaim(summaryInput(c, s, null, [], 0.7));
        await tools.escalateToHuman(c.id, sum, String(args.reason));
        return { ok: true };
      }
      return { error: 'unknown tool' };
    },
    5,
  );
  if (calls.length) await tools.logActivity({ claimId: c.id, action: 'AGENT_PLANNED', reason: `LLM planner chose: ${calls.map((x) => x.name).join(' → ')}`, confidence: 0.85 });
  return calls.length > 0;
}

export function registerClaimAgent() {
  bus.onEvent('policy.uploaded', onPolicyUploaded);
  bus.onEvent('claim.created', onClaimCreated);
  bus.onEvent('document.uploaded', onDocumentUploaded);
  bus.onEvent('documents.complete', onDocumentsComplete);
  bus.onEvent('claim.ready', onDocumentsComplete);
  bus.onEvent('query.answered', onQueryAnswered);
  bus.onEvent('document.missing', async ({ claimId }) => withLock(claimId, () => evaluate(claimId, true)));
  console.log(`[agent] Claim Agent listening (planner=${env.agentPlanner}${llmEnabled() ? `, llm=${env.aiProvider}` : ', MOCK_AI'})`);
}

/** Re-run the agent on a claim (used by "Re-run AI" in the dashboard). */
export function rerunAgent(claimId: string) {
  return withLock(claimId, () => evaluate(claimId, true));
}

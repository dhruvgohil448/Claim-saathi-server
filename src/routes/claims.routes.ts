import { Router, Request } from 'express';
import { z } from 'zod';
import { ClaimStatus, DocumentType, Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { auth, isStaff, staffOnly } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { badRequest, forbidden, notFound } from '../utils/errors';
import { bus } from '../events/bus';
import * as tools from '../tools';
import * as ai from '../services/ai.service';
import { categorize } from '../services/rules';
import { putFile } from '../services/storage';
import { extractText } from '../services/extract';
import { rerunAgent } from '../agent/claimAgent';
import { inr } from '../utils/format';
import { assertOtp } from '../services/otp';
import { appChecklist, buildPdf, stepper, uploadChecks } from '../services/mobile';
import { agentIdle, processDocument } from '../agent/claimAgent';
import { DocValidation } from '../services/ai.service';
import { fmtDate, docLabel } from '../utils/format';
import { claimScope } from '../services/demo';

const r = Router();
// The app opens the summary PDF in a browser/share sheet, which cannot set headers: allow ?token= for that route only.
r.use((req, _res, next) => {
  if (!req.headers.authorization && req.query.token && req.path.endsWith('/summary.pdf')) req.headers.authorization = `Bearer ${String(req.query.token)}`;
  next();
});
r.use(auth);

export const claimListInclude = {
  user: { select: { id: true, name: true, email: true, phone: true } },
  policy: { select: { id: true, policyNumber: true, insurer: true } },
  settlement: { select: { approvedAmount: true, billAmount: true, status: true } },
  _count: { select: { documents: true, queries: { where: { status: 'OPEN' as const } } } },
} satisfies Prisma.ClaimInclude;

async function getClaimFor(req: Request, id: string) {
  const c = await prisma.claim.findFirst({ where: { OR: [{ id }, { claimNumber: id }] } });
  if (!c) throw notFound('Claim not found');
  if (!isStaff(req) && c.userId !== req.user!.id) throw forbidden();
  return c;
}

const billItem = z.object({ description: z.string(), qty: z.number().positive(), rate: z.number().nonnegative(), amount: z.number().nonnegative().optional() });
// The app may send type: PREAUTH | CASHLESS | REIMBURSEMENT (PREAUTH = cashless pre-authorisation).
const normalizeType = (b: unknown) => {
  if (b && typeof b === 'object' && 'type' in b && !('claimType' in b)) {
    const t = String((b as { type: unknown }).type).toUpperCase();
    return { ...b, claimType: t === 'PREAUTH' ? 'CASHLESS' : t };
  }
  return b;
};
const claimInputBase = z.object({
  policyId: z.string().optional(),
  hospital: z.string().min(2),
  hospitalCity: z.string().optional(),
  isNetworkHospital: z.boolean().optional(),
  reason: z.string().min(2),
  treatment: z.string().optional(),
  claimType: z.enum(['CASHLESS', 'REIMBURSEMENT']).default('REIMBURSEMENT'),
  admissionType: z.enum(['PLANNED', 'EMERGENCY']).default('EMERGENCY'),
  isAccident: z.boolean().optional(),
  admissionDate: z.coerce.date().optional(),
  dischargeDate: z.coerce.date().optional(),
  roomType: z.string().optional(),
  roomRentPerDay: z.number().int().positive().optional(),
  days: z.number().int().positive().optional(),
  estimatedAmount: z.number().int().nonnegative().optional(),
  billAmount: z.number().int().nonnegative().optional(),
  billItems: z.array(billItem).optional(),
  /** Insured member the claim is for (defaults to the policy holder). */
  patientName: z.string().trim().min(2).max(80).optional(),
  patientDetails: z.object({ age: z.number().int().min(0).max(120).optional(), gender: z.string().max(10).optional(), relation: z.string().max(30).optional(), phone: z.string().max(20).optional() }).optional(),
  /** Optional consent OTP from the app's "confirm & submit" step. Demo: always OTP_DEMO_CODE (111000). */
  consentOtp: z.string().optional(),
});
const claimInput = { parse: (b: unknown) => claimInputBase.parse(normalizeType(b)) };

async function resolvePolicy(req: Request, policyId?: string) {
  const p = policyId
    ? await prisma.policy.findUnique({ where: { id: policyId } })
    : await prisma.policy.findFirst({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' } });
  if (!p) throw badRequest('Upload your policy first (no policy found)');
  if (!isStaff(req) && p.userId !== req.user!.id) throw forbidden();
  return p;
}

// ---- list ----
r.get('/', async (req, res) => {
  const q = z.object({ status: z.string().optional(), search: z.string().optional(), type: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
  const where: Prisma.ClaimWhereInput = {};
  if (!isStaff(req)) where.userId = req.user!.id;
  else Object.assign(where, await claimScope());
  if (q.status && q.status !== 'ALL') where.status = { in: q.status.split(',') as ClaimStatus[] };
  if (q.type && q.type !== 'ALL') where.claimType = q.type as 'CASHLESS' | 'REIMBURSEMENT';
  if (q.search) {
    const s = q.search.trim();
    where.OR = [
      { claimNumber: { contains: s, mode: 'insensitive' } },
      { patientName: { contains: s, mode: 'insensitive' } },
      { hospital: { contains: s, mode: 'insensitive' } },
      { reason: { contains: s, mode: 'insensitive' } },
      { policy: { policyNumber: { contains: s, mode: 'insensitive' } } },
    ];
  }
  res.json(await prisma.claim.findMany({ where, include: claimListInclude, orderBy: { lastActivityAt: 'desc' }, take: q.limit }));
});

// ---- coverage check (no DB writes) ----
r.post('/check-coverage', async (req, res) => {
  const body = claimInput.parse(req.body);
  const p = await resolvePolicy(req, body.policyId);
  const result = await ai.checkCoverage(tools.policyRules(p), {
    reason: body.reason,
    treatment: body.treatment,
    admissionDate: body.admissionDate ?? new Date(),
    isAccident: body.isAccident,
    isNetworkHospital: body.isNetworkHospital,
    estimatedAmount: body.estimatedAmount ?? (body.roomRentPerDay && body.days ? body.roomRentPerDay * body.days * 4 : undefined),
    billAmount: body.billAmount,
    roomRentPerDay: body.roomRentPerDay,
    days: body.days,
    billItems: body.billItems?.map((i) => ({ ...i, amount: i.amount ?? i.qty * i.rate })),
  });
  res.json(result);
});

// ---- create ----
r.post('/', async (req, res) => {
  const body = claimInput.parse(req.body);
  if (body.consentOtp !== undefined) assertOtp(body.consentOtp);
  const p = await resolvePolicy(req, body.policyId);
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: p.userId } });
  const last = await prisma.claim.findFirst({ where: { claimNumber: { startsWith: 'CLM-' } }, orderBy: { claimNumber: 'desc' } });
  const next = last ? Number(last.claimNumber.slice(4)) + 1 : 1001;
  const items = body.billItems?.map((i) => ({ ...i, amount: i.amount ?? i.qty * i.rate, category: categorize(i.description) }));
  const claim = await prisma.claim.create({
    data: {
      claimNumber: `CLM-${next}`,
      userId: owner.id,
      policyId: p.id,
      patientName: body.patientName ?? owner.name,
      patientDetails: body.patientDetails ?? undefined,
      hospital: body.hospital,
      hospitalCity: body.hospitalCity,
      isNetworkHospital: body.isNetworkHospital ?? true,
      reason: body.reason,
      treatment: body.treatment,
      claimType: body.claimType,
      admissionType: body.admissionType,
      isAccident: body.isAccident ?? false,
      admissionDate: body.admissionDate,
      dischargeDate: body.dischargeDate,
      roomType: body.roomType,
      roomRentPerDay: body.roomRentPerDay,
      days: body.days,
      estimatedAmount: body.estimatedAmount ?? items?.reduce((s, i) => s + i.amount, 0),
      billAmount: body.billAmount ?? (body.claimType === 'REIMBURSEMENT' ? items?.reduce((s, i) => s + i.amount, 0) : undefined),
      billItems: items,
      events: {
        create: [
          { status: 'CREATED', title: 'Claim submitted', description: `${body.claimType === 'CASHLESS' ? 'Cashless' : 'Reimbursement'} claim for ${body.reason} at ${body.hospital}${isStaff(req) ? '' : ' (from the mobile app)'}.`, actor: isStaff(req) ? 'HUMAN' : 'SYSTEM' },
          ...(body.consentOtp !== undefined ? [{ status: 'CREATED' as const, title: 'Customer consent verified', description: 'The customer confirmed the claim details with an OTP.', actor: 'SYSTEM' as const }] : []),
        ],
      },
    },
    include: claimListInclude,
  });
  await tools.logActivity({ claimId: claim.id, action: 'CLAIM_CREATED', reason: `${claim.claimNumber} created by ${req.user!.name} for ${inr(claim.billAmount ?? claim.estimatedAmount ?? 0)}.`, actor: 'HUMAN', actorName: req.user!.name });
  if (!isStaff(req))
    await tools.notifyOps({ title: `New claim ${claim.claimNumber} from the app`, body: `${claim.patientName} filed a ${claim.claimType === 'CASHLESS' ? 'cashless' : 'reimbursement'} claim at ${claim.hospital} for ${inr(claim.billAmount ?? claim.estimatedAmount ?? 0)}.`, type: 'INFO', claimId: claim.id });
  bus.emitEvent('claim.created', { claimId: claim.id });
  res.status(201).json(claim);
});

// ---- detail ----
r.get('/:id', async (req, res) => {
  const c = await getClaimFor(req, String(req.params.id));
  const claim = await prisma.claim.findUniqueOrThrow({
    where: { id: c.id },
    include: {
      user: { select: { id: true, name: true, email: true, phone: true, city: true } },
      policy: { omit: { rawText: true } },
      documents: { orderBy: { createdAt: 'asc' } },
      events: { orderBy: { createdAt: 'asc' } },
      queries: { orderBy: { createdAt: 'desc' } },
      settlement: true,
      activities: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  });
  const prog = tools.docProgress(claim);
  res.json({ ...claim, checklist: { stage: prog.stage, required: prog.required, missing: prog.missing, flagged: prog.flagged, verified: prog.verified } });
});

/** Customer-facing timeline (status events, oldest first) plus open queries and the settlement, for the app's tracker screen. */
r.get('/:id/timeline', async (req, res) => {
  const c = await getClaimFor(req, String(req.params.id));
  const [events, queries, settlement, documents] = await Promise.all([
    prisma.claimEvent.findMany({ where: { claimId: c.id }, orderBy: { createdAt: 'asc' } }),
    prisma.query.findMany({ where: { claimId: c.id, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'desc' } }),
    prisma.settlement.findUnique({ where: { claimId: c.id } }),
    prisma.document.findMany({ where: { claimId: c.id }, select: { id: true, type: true, status: true, fileName: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
  ]);
  const st = stepper({ ...c, documents: await prisma.document.findMany({ where: { claimId: c.id } }) }, events, settlement, queries.filter((q) => q.status === 'OPEN'));
  res.json({ claimId: c.id, claimNumber: c.claimNumber, status: c.status, ...st, events, openQueries: queries, settlement, documents });
});

r.get('/:id/checklist', async (req, res) => {
  const c = await getClaimFor(req, String(req.params.id));
  res.json(appChecklist({ ...c, documents: await prisma.document.findMany({ where: { claimId: c.id }, orderBy: { createdAt: 'asc' } }) }));
});

/** Download Summary: simple generated PDF with claim, amounts, deductions, documents and timeline. */
r.get('/:id/summary.pdf', async (req, res) => {
  const c0 = await getClaimFor(req, String(req.params.id));
  const c = await prisma.claim.findUniqueOrThrow({ where: { id: c0.id }, include: { user: true, policy: true, documents: { orderBy: { createdAt: 'asc' } }, events: { orderBy: { createdAt: 'asc' } }, settlement: true, queries: true } });
  const s = c.settlement;
  const ded = (s?.deductions as unknown as { label: string; amount: number; reason: string }[]) ?? [];
  const when = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const blocks = [
    { text: 'Claim Saathi - Claim summary', size: 18, bold: true },
    { text: `${c.claimNumber} · ${c.status.replace(/_/g, ' ')} · generated ${when(new Date())} IST`, size: 9, gap: 2 },
    { text: 'Claim', size: 12, bold: true, gap: 12 },
    { text: `Patient: ${c.patientName}   Policy holder: ${c.user.name}${c.user.phone ? ` (${c.user.phone})` : ''}` },
    { text: `Hospital: ${c.hospital}${c.hospitalCity ? `, ${c.hospitalCity}` : ''}   Type: ${c.claimType === 'CASHLESS' ? 'Cashless' : 'Reimbursement'} (${c.admissionType.toLowerCase()})` },
    { text: `Reason: ${c.reason}${c.treatment ? ` · ${c.treatment}` : ''}` },
    { text: `Admission: ${c.admissionDate ? fmtDate(c.admissionDate) : '-'}   Discharge: ${c.dischargeDate ? fmtDate(c.dischargeDate) : '-'}` },
    { text: `Policy: ${c.policy.policyNumber} · ${c.policy.insurer} · sum insured ${inr(c.policy.sumInsured)} · co-pay ${c.policy.coPayPercent}%` },
    { text: 'Settlement', size: 12, bold: true, gap: 12 },
    ...(s
      ? [{ text: `Bill amount: ${inr(s.billAmount)}` }, ...ded.map((d) => ({ text: `  - ${d.label}: -${inr(d.amount)} (${d.reason})` })), { text: `Payable: ${inr(s.approvedAmount)} · status ${s.status}${s.utr ? ` · UTR ${s.utr}` : ''}${s.paidAt ? ` · paid ${when(s.paidAt)}` : ''}`, bold: true }]
      : [{ text: 'Not calculated yet.' }]),
    { text: 'Documents', size: 12, bold: true, gap: 12 },
    ...(c.documents.length ? c.documents.map((d) => ({ text: `${docLabel(d.type)} - ${d.fileName} - ${d.status}${d.confidence != null ? ` (${Math.round(d.confidence * 100)}%)` : ''}` })) : [{ text: 'None uploaded.' }]),
    { text: 'Timeline', size: 12, bold: true, gap: 12 },
    ...c.events.map((e) => ({ text: `${when(e.createdAt)} · ${e.title}${e.description ? ` - ${e.description}` : ''}` })),
    { text: 'Demo document generated by Claim Saathi (hackathon build). Not an insurer settlement letter.', size: 8, gap: 16 },
  ];
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${c.claimNumber}-summary.pdf"`);
  res.end(buildPdf(blocks));
});

r.get('/:id/activity', async (req, res) => {
  const c = await getClaimFor(req, String(req.params.id));
  res.json(await prisma.activityLog.findMany({ where: { claimId: c.id }, orderBy: { createdAt: 'desc' } }));
});

r.get('/:id/settlement', async (req, res) => {
  const c = await getClaimFor(req, String(req.params.id));
  const s = await prisma.settlement.findUnique({ where: { claimId: c.id } });
  const base = { claimId: c.id, claimNumber: c.claimNumber, claimStatus: c.status, isDemo: true };
  if (s) return void res.json({ ...base, ...s, isEstimate: s.status === 'ESTIMATED', preview: false });
  // Not calculated yet: preview with the same rules engine, without saving.
  const full = await tools.loadClaim(c.id);
  const est = await ai.calculateSettlement(tools.policyRules(full.policy), tools.claimFacts(full));
  res.json({ ...base, ...est, status: 'PREVIEW', isEstimate: true, preview: true, utr: null, paidAt: null });
});

r.post('/:id/settlement/calculate', staffOnly, async (req, res) => {
  const c = await getClaimFor(req, String(req.params.id));
  await tools.calculateSettlement(c.id, 'ESTIMATED');
  res.json(await prisma.settlement.findUnique({ where: { claimId: c.id } }));
});

// ---- pre-auth ----
r.post('/:id/preauth', async (req, res) => {
  const c = await getClaimFor(req, String(req.params.id));
  if (c.claimType !== 'CASHLESS') throw badRequest('Pre-auth applies to cashless claims only');
  await tools.submitPreauth(c.id, `Pre-auth submitted to the TPA by ${req.user!.name}.`);
  const s = await tools.calculateSettlement(c.id, 'ESTIMATED');
  res.json({ ok: true, estimate: s });
});

// ---- status change (ops) ----
const statusBody = z.object({ status: z.nativeEnum(ClaimStatus), note: z.string().max(500).optional() });
const changeStatus = async (req: Request, res: any) => {
  const c = await getClaimFor(req, String(req.params.id));
  const { status, note } = statusBody.parse(req.body);
  await tools.updateClaimStatus(c.id, status, { description: note || `Status changed to ${status.replace('_', ' ').toLowerCase()} by ${req.user!.name}.`, actor: 'HUMAN', actorName: req.user!.name, action: `STATUS_${status}` });
  res.json(await prisma.claim.findUnique({ where: { id: c.id }, include: claimListInclude }));
};
r.post('/:id/status', staffOnly, changeStatus);
r.patch('/:id/status', staffOnly, changeStatus);

// ---- human decision (ops) ----
r.post('/:id/decision', staffOnly, async (req, res) => {
  const { decision, note, amount } = z
    .object({ decision: z.enum(['APPROVE', 'REJECT', 'SETTLE']), note: z.string().max(1000).optional(), amount: z.number().int().nonnegative().optional() })
    .parse(req.body);
  const c = await tools.loadClaim((await getClaimFor(req, String(req.params.id))).id);
  const who = req.user!.name;
  const suggestion = (c.aiSuggestion as Record<string, unknown> | null) ?? null;
  const markResolved = () => (suggestion ? prisma.claim.update({ where: { id: c.id }, data: { aiSuggestion: { ...suggestion, resolved: true, resolvedBy: who, humanDecision: decision } as Prisma.InputJsonValue } }) : null);

  if (decision === 'APPROVE') {
    let s = c.settlement ?? (await prisma.settlement.findUnique({ where: { claimId: c.id } }));
    if (!s) {
      await tools.calculateSettlement(c.id, 'ESTIMATED');
      s = await prisma.settlement.findUniqueOrThrow({ where: { claimId: c.id } });
    }
    const final = amount ?? s.approvedAmount;
    const deductions = (s.deductions as unknown as { label: string; amount: number; reason: string }[]) ?? [];
    if (amount != null && amount !== s.approvedAmount)
      deductions.push({ label: 'Specialist adjustment', amount: s.approvedAmount - amount, reason: note || `Adjusted by ${who}` });
    await prisma.settlement.update({ where: { claimId: c.id }, data: { approvedAmount: final, deductions: deductions as unknown as Prisma.InputJsonValue, status: 'APPROVED' } });
    await markResolved();
    if (c.status === 'PREAUTH_SUBMITTED') {
      await prisma.claimEvent.create({ data: { claimId: c.id, status: 'PREAUTH_SUBMITTED', title: 'Pre-auth approved', description: `Cashless approved for ${inr(final)} by ${who}.${note ? ` ${note}` : ''}`, actor: 'HUMAN' } });
      await tools.logActivity({ claimId: c.id, action: 'PREAUTH_APPROVED', reason: `${who} approved pre-auth for ${inr(final)}.${note ? ` Note: ${note}` : ''}`, actor: 'HUMAN', actorName: who });
      await tools.notifyUser(c.userId, { title: 'Cashless approved', body: `Your pre-authorisation for ${inr(final)} at ${c.hospital} is approved.`, type: 'SUCCESS', claimId: c.id }, false);
    } else {
      await tools.updateClaimStatus(c.id, 'APPROVED', { description: `Approved by ${who} for ${inr(final)}.${note ? ` ${note}` : ''}`, actor: 'HUMAN', actorName: who, action: 'HUMAN_APPROVED' });
      await tools.notifyUser(c.userId, { title: `Claim ${c.claimNumber} approved`, body: `${inr(final)} approved. Open Settlement to see each deduction.`, type: 'SUCCESS', claimId: c.id }, false);
    }
  } else if (decision === 'REJECT') {
    const s = await prisma.settlement.findUnique({ where: { claimId: c.id } });
    if (s) await prisma.settlement.update({ where: { claimId: c.id }, data: { approvedAmount: 0, status: 'APPROVED' } });
    await markResolved();
    await tools.updateClaimStatus(c.id, 'REJECTED', { description: `Rejected by ${who}. ${note || 'Not admissible under the policy terms.'}`, actor: 'HUMAN', actorName: who, action: 'HUMAN_REJECTED' });
    await tools.notifyUser(c.userId, { title: `Claim ${c.claimNumber} not approved`, body: note || 'This claim is not payable under your policy terms. Tap to see the exact clause.', type: 'WARNING', claimId: c.id }, false);
  } else {
    const s = await prisma.settlement.findUnique({ where: { claimId: c.id } });
    if (!s) throw badRequest('Approve the claim first');
    const utr = `DEMOUTR${Date.now().toString().slice(-9)}`;
    await prisma.settlement.update({ where: { claimId: c.id }, data: { status: 'PAID', utr, paidAt: new Date() } });
    await tools.updateClaimStatus(c.id, 'SETTLED', { description: `${inr(s.approvedAmount)} paid (UTR ${utr}). Marked by ${who}.`, actor: 'HUMAN', actorName: who, action: 'SETTLED' });
    await tools.notifyUser(c.userId, { title: 'Money sent to your bank', body: `${inr(s.approvedAmount)} for ${c.claimNumber} was paid (UTR ${utr}).`, type: 'SUCCESS', claimId: c.id }, false);
  }
  res.json(await prisma.claim.findUnique({ where: { id: c.id }, include: claimListInclude }));
});

r.post('/:id/rerun-ai', staffOnly, async (req, res) => {
  const c = await getClaimFor(req, String(req.params.id));
  await tools.logActivity({ claimId: c.id, action: 'AGENT_RERUN', reason: `${req.user!.name} asked the Claim Agent to re-check this claim.`, actor: 'HUMAN', actorName: req.user!.name });
  await rerunAgent(c.id);
  res.json({ ok: true });
});

// ---- documents on a claim ----
r.get('/:id/documents', async (req, res) => {
  const c = await getClaimFor(req, String(req.params.id));
  res.json(await prisma.document.findMany({ where: { claimId: c.id }, orderBy: { createdAt: 'asc' } }));
});

/** Run the Claim Agent's document check now and return per-check results (also stored on the document). */
export async function validateNow(claimId: string, documentId: string, answeredQueryId?: string) {
  const { doc, validation } = await processDocument(claimId, documentId, answeredQueryId);
  await agentIdle(claimId); // include follow-up steps (e.g. submitted for review) in the response
  const claim = await prisma.claim.findUniqueOrThrow({ where: { id: claimId }, include: { documents: { orderBy: { createdAt: 'asc' } } } });
  const checklist = appChecklist(claim);
  const result = uploadChecks(doc.type, doc.status, validation as DocValidation, checklist);
  const prev = await prisma.document.findUniqueOrThrow({ where: { id: documentId }, select: { validationResult: true } });
  const stored = await prisma.document.update({ where: { id: documentId }, data: { validationResult: { ...((prev.validationResult as object) ?? {}), ...(validation as object), appChecks: result.checks, warnings: result.warnings } as Prisma.InputJsonValue } });
  return { ...stored, validation: result, checklist, claimStatus: claim.status };
}

export async function createDocument(req: Request, claimId: string, claimNumber: string, typeHint?: string) {
  if (!req.file) throw badRequest('Attach the document as "file"');
  let type = (typeHint && (Object.values(DocumentType) as string[]).includes(typeHint) ? typeHint : null) as DocumentType | null;
  if (!type) {
    const ex = await extractText(req.file.buffer, req.file.mimetype);
    type = (ai.detectDocType(ex.text, req.file.originalname) as DocumentType) ?? 'OTHER';
  }
  const fileUrl = await putFile(req.file.buffer, req.file.originalname, req.file.mimetype, `claims/${claimNumber}`);
  const doc = await prisma.document.create({ data: { claimId, type, fileName: req.file.originalname, fileUrl, mimeType: req.file.mimetype, size: req.file.size } });
  await prisma.claim.update({ where: { id: claimId }, data: { lastActivityAt: new Date(), reminderCount: 0 } });
  await tools.logActivity({ claimId, action: 'DOC_UPLOADED', reason: `${req.user!.name} uploaded ${req.file.originalname} (${type.replace(/_/g, ' ').toLowerCase()}).`, actor: 'HUMAN', actorName: req.user!.name, meta: { documentId: doc.id } });
  return doc;
}

r.post('/:id/documents', upload.single('file'), async (req, res) => {
  const c = await getClaimFor(req, String(req.params.id));
  const doc = await createDocument(req, c.id, c.claimNumber, req.body?.type);
  res.status(201).json(await validateNow(c.id, doc.id));
});

// ---- queries on a claim ----
r.get('/:id/queries', async (req, res) => {
  const c = await getClaimFor(req, String(req.params.id));
  res.json(await prisma.query.findMany({ where: { claimId: c.id }, orderBy: { createdAt: 'desc' } }));
});

r.post('/:id/queries', staffOnly, async (req, res) => {
  const { message, requestedDocType } = z.object({ message: z.string().min(3).max(1000), requestedDocType: z.nativeEnum(DocumentType).optional() }).parse(req.body);
  const c = await getClaimFor(req, String(req.params.id));
  const q = await tools.raiseQuery(c.id, message, requestedDocType ?? null, 'HUMAN', req.user!.name);
  res.status(201).json(q);
});

export default r;

/** Customer (mobile app) self-service: profile, policies, bank account, push token, home summary. */
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { auth } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { badRequest, conflict } from '../utils/errors';
import { assertOtp } from '../services/otp';
import { publicUser, tokenFor, maskBank } from '../services/users';
import { putFile } from '../services/storage';
import { extractText } from '../services/extract';
import * as ai from '../services/ai.service';
import { bus } from '../events/bus';
import * as tools from '../tools';
import { docLabel, inr } from '../utils/format';
import { analyzePolicy } from '../services/mobile';
import { llmEnabled } from '../config/env';
import { claimWarnings } from '../services/warnings';
import { financeFor } from '../demo/finance';
import { renameStarterPatient } from '../demo/starter';

const r = Router();
r.use(auth);

r.get('/', async (req, res) => {
  res.json(publicUser(await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } })));
});

const profileSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email(),
  dob: z.coerce.date().refine((d) => d < new Date() && d.getFullYear() > 1900, 'Enter a valid date of birth'),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'male', 'female', 'other']).transform((g) => g.toUpperCase()),
  city: z.string().trim().max(60).optional(),
});

/** Complete / edit profile. Returns a fresh token because name/email live in the JWT. */
r.put('/profile', async (req, res) => {
  const b = profileSchema.partial({ city: true }).parse(req.body);
  const email = b.email.toLowerCase();
  const clash = await prisma.user.findFirst({ where: { email, NOT: { id: req.user!.id } }, select: { id: true } });
  if (clash) throw conflict('This email is already used by another account');
  const before = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  const u = await prisma.user.update({ where: { id: req.user!.id }, data: { name: b.name, email, dob: b.dob, gender: b.gender, city: b.city ?? before.city } });
  await renameStarterPatient(u.id, before.name, u.name);
  await tools.logActivity({ action: before.name === 'New user' ? 'PROFILE_COMPLETED' : 'PROFILE_UPDATED', reason: `${u.name} ${before.name === 'New user' ? 'completed' : 'updated'} their profile in the app${u.city ? ` (${u.city})` : ''}.`, actor: 'HUMAN', actorName: u.name });
  res.json({ user: publicUser(u), token: tokenFor(u) });
});
r.patch('/profile', async (req, res) => {
  const b = profileSchema.partial().parse(req.body);
  if (b.email) {
    const clash = await prisma.user.findFirst({ where: { email: b.email.toLowerCase(), NOT: { id: req.user!.id } }, select: { id: true } });
    if (clash) throw conflict('This email is already used by another account');
  }
  const prev = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { name: true } });
  const u = await prisma.user.update({ where: { id: req.user!.id }, data: { ...b, email: b.email?.toLowerCase() } });
  if (b.name) await renameStarterPatient(u.id, prev.name, u.name);
  await tools.logActivity({ action: 'PROFILE_UPDATED', reason: `${u.name} updated their profile in the app.`, actor: 'HUMAN', actorName: u.name });
  res.json({ user: publicUser(u), token: tokenFor(u) });
});

// ---------- policies ----------
r.get('/policies', async (req, res) => {
  res.json(await prisma.policy.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, omit: { rawText: true }, include: { _count: { select: { claims: true } } } }));
});

const member = z.object({ name: z.string().min(1).max(80), relation: z.string().max(30).optional(), dob: z.string().optional(), gender: z.string().optional() });
const jsonish = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (typeof v === 'string' && v.trim().startsWith('[') ? JSON.parse(v) : v), s);
const policySchema = z.object({
  insurer: z.string().trim().min(2).max(120),
  policyNumber: z.string().trim().min(3).max(60),
  planName: z.string().trim().max(120).optional(),
  sumInsured: z.coerce.number().int().positive(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional(),
  members: jsonish(z.array(member)).optional(),
  roomRentLimit: z.coerce.number().int().positive().optional(),
  icuLimit: z.coerce.number().int().positive().optional(),
  coPayPercent: z.coerce.number().min(0).max(50).optional(),
});

/** Link a policy (JSON or multipart with optional "file" = policy PDF). With a PDF, the AI fills the rules it can read. */
r.post('/policies', upload.single('file'), async (req, res) => {
  const b = policySchema.parse(req.body ?? {});
  if (b.endDate && b.endDate <= b.startDate) throw badRequest('endDate must be after startDate');
  const existing = await prisma.policy.findUnique({ where: { policyNumber: b.policyNumber } });
  if (existing && existing.userId !== req.user!.id) throw conflict('This policy number is already linked to another account');

  let extracted: ai.PolicyExtraction | null = null;
  let fileUrl: string | undefined;
  let rawText: string | undefined;
  if (req.file) {
    const ex = await extractText(req.file.buffer, req.file.mimetype);
    rawText = ex.text.slice(0, 20000);
    if (ex.text.trim()) extracted = await ai.extractPolicy(ex.text);
    fileUrl = await putFile(req.file.buffer, req.file.originalname, req.file.mimetype, `policies/${req.user!.id}`);
  }
  // Customer-entered values win; then what the AI read from the PDF; then standard Indian retail-policy defaults.
  const roomRentLimit = b.roomRentLimit ?? extracted?.roomRentLimit ?? Math.round(b.sumInsured * 0.01);
  const coPayPercent = b.coPayPercent ?? extracted?.coPayPercent ?? 0;
  const waitingPeriods = extracted?.waitingPeriods ?? [
    { name: 'Initial waiting period (except accidents)', months: 1 },
    { name: 'Specific illnesses (cataract, hernia, joint replacement, ENT)', months: 24 },
    { name: 'Pre-existing diseases', months: 36 },
  ];
  const summary = extracted?.summaryEnglish ?? `Covers hospital stays up to ${inr(b.sumInsured)}. Room rent up to ${inr(roomRentLimit)} per day.${coPayPercent ? ` You pay ${coPayPercent}% of every claim (co-pay).` : ' No co-pay.'}`;
  const data = {
    insurer: b.insurer,
    planName: b.planName ?? extracted?.planName ?? null,
    sumInsured: b.sumInsured,
    roomRentLimit,
    icuLimit: b.icuLimit ?? extracted?.icuLimit ?? null,
    coPayPercent,
    startDate: b.startDate,
    endDate: b.endDate ?? new Date(b.startDate.getTime() + 365 * 86400000 - 86400000),
    waitingPeriods: waitingPeriods as Prisma.InputJsonValue,
    subLimits: (extracted?.subLimits ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    // Mock extraction returns generic lists, so only trust exclusions from a real LLM; the Policy Reader also parses the PDF text.
    exclusions: (llmEnabled() ? extracted?.exclusions ?? [] : []) as Prisma.InputJsonValue,
    networkHospitals: (extracted?.networkHospitals ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    members: (b.members ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    summary,
    summaryHindi: extracted?.summaryHindi ?? null,
    ...(fileUrl ? { fileUrl, rawText } : {}),
  };
  const policy = existing
    ? await prisma.policy.update({ where: { id: existing.id }, data, omit: { rawText: true } })
    : await prisma.policy.create({ data: { userId: req.user!.id, policyNumber: b.policyNumber, ...data }, omit: { rawText: true } });
  await tools.logActivity({ action: existing ? 'POLICY_UPDATED' : 'POLICY_LINKED', reason: `${req.user!.name} ${existing ? 'updated' : 'linked'} policy ${policy.policyNumber} (${policy.insurer}, ${inr(policy.sumInsured)})${fileUrl ? ' with the policy PDF' : ''}.`, actor: 'HUMAN', actorName: req.user!.name, meta: { policyId: policy.id } });
  const full = await prisma.policy.findUniqueOrThrow({ where: { id: policy.id } });
  const analysis = analyzePolicy(full);
  await prisma.policy.update({ where: { id: policy.id }, data: { analysis: analysis as unknown as Prisma.InputJsonValue, analyzedAt: new Date() } });
  bus.emitEvent('policy.uploaded', { policyId: policy.id, userId: req.user!.id });
  res.status(existing ? 200 : 201).json({ policy: { ...policy, analysis }, analysis, extractedFromPdf: !!extracted });
});

// ---------- bank account (OTP-verified) ----------
r.get('/bank', async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { bankAccount: true } });
  res.json({ bank: maskBank(u.bankAccount) });
});

r.post('/bank', async (req, res) => {
  const b = z
    .object({
      accountName: z.string().trim().min(2).max(80),
      accountNumber: z.string().trim().regex(/^\d{9,18}$/, 'Account number must be 9 to 18 digits'),
      ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC (e.g. HDFC0001234)'),
      bankName: z.string().trim().max(80).optional(),
      otp: z.string(),
    })
    .parse(req.body);
  assertOtp(b.otp);
  const bankAccount = { accountName: b.accountName, accountNumber: b.accountNumber, ifsc: b.ifsc, bankName: b.bankName ?? null, verifiedAt: new Date().toISOString() };
  const u = await prisma.user.update({ where: { id: req.user!.id }, data: { bankAccount } });
  await tools.logActivity({ action: 'BANK_VERIFIED', reason: `${u.name} added bank account XXXX${b.accountNumber.slice(-4)} (${b.ifsc}) for claim payouts (OTP verified).`, actor: 'HUMAN', actorName: u.name });
  res.json({ bank: maskBank(bankAccount) });
});

// ---------- push ----------
r.post('/push-token', async (req, res) => {
  const b = z.object({ token: z.string().min(10).max(300), platform: z.enum(['ios', 'android', 'web']).default('ios') }).parse(req.body);
  await prisma.user.update({ where: { id: req.user!.id }, data: { pushToken: b.token, pushPlatform: b.platform } });
  res.json({ ok: true });
});
r.delete('/push-token', async (req, res) => {
  await prisma.user.update({ where: { id: req.user!.id }, data: { pushToken: null, pushPlatform: null } });
  res.json({ ok: true });
});

/** Bank accounts, balances, monthly expenses (fixed demo values from the server) + medical spend / payouts from the user's claims. */
r.get('/finance', async (req, res) => {
  res.json(await financeFor(req.user!.id));
});

// ---------- home screen (all live from the DB) ----------
r.get('/home', async (req, res) => {
  const id = req.user!.id;
  const now = new Date();
  const [user, policies, claims, unread, openQueries] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id } }),
    prisma.policy.findMany({ where: { userId: id }, orderBy: { startDate: 'desc' }, omit: { rawText: true } }),
    prisma.claim.findMany({ where: { userId: id }, orderBy: { lastActivityAt: 'desc' }, include: { documents: { select: { id: true, type: true, status: true, validationResult: true } }, settlement: { select: { approvedAmount: true, billAmount: true, status: true } } } }),
    prisma.notification.count({ where: { userId: id, read: false } }),
    prisma.query.findMany({ where: { status: 'OPEN', claim: { userId: id } }, orderBy: { createdAt: 'desc' }, include: { claim: { select: { id: true, claimNumber: true } } } }),
  ]);
  const isActive = (p: (typeof policies)[number]) => p.startDate <= now && (!p.endDate || p.endDate >= now);
  // the customer's own policy wins over the starter (demo-template) policy
  const activePolicy = policies.find((p) => isActive(p) && !p.isTemplate) ?? policies.find(isActive) ?? policies[0] ?? null;
  const current = claims.find((c) => !['SETTLED', 'REJECTED'].includes(c.status)) ?? claims[0] ?? null;
  const pendingActions: { kind: 'QUERY' | 'MISSING_DOC' | 'REUPLOAD_DOC' | 'COMPLETE_PROFILE' | 'ADD_BANK' | 'LINK_POLICY'; title: string; claimId?: string; claimNumber?: string; queryId?: string; documentType?: string }[] = [];
  const pub = publicUser(user);
  if (!pub.profileComplete) pendingActions.push({ kind: 'COMPLETE_PROFILE', title: 'Complete your profile' });
  if (!policies.length) pendingActions.push({ kind: 'LINK_POLICY', title: 'Link your health policy' });
  for (const q of openQueries) pendingActions.push({ kind: 'QUERY', title: q.message, claimId: q.claim.id, claimNumber: q.claim.claimNumber, queryId: q.id, documentType: q.requestedDocType ?? undefined });
  for (const c of claims.filter((x) => !['SETTLED', 'REJECTED', 'APPROVED'].includes(x.status))) {
    const prog = tools.docProgress(c);
    for (const t of prog.missing) pendingActions.push({ kind: 'MISSING_DOC', title: `Upload ${docLabel(t).toLowerCase()}`, claimId: c.id, claimNumber: c.claimNumber, documentType: t });
    for (const t of prog.flagged) {
      const fix = (prog.latest.get(t)?.validationResult as { fix?: string } | null)?.fix;
      pendingActions.push({ kind: 'REUPLOAD_DOC', title: fix ?? `Re-upload ${docLabel(t).toLowerCase()}`, claimId: c.id, claimNumber: c.claimNumber, documentType: t });
    }
  }
  if (claims.some((c) => c.claimType === 'REIMBURSEMENT') && !user.bankAccount) pendingActions.push({ kind: 'ADD_BANK', title: 'Add a bank account for claim payouts' });
  const strip = <T extends { documents: unknown }>({ documents, ...c }: T) => c;
  const warnings = current && !['SETTLED', 'REJECTED'].includes(current.status) ? await claimWarnings(current, policies.find((p) => p.id === current.policyId)) : [];
  res.json({
    user: pub,
    activePolicy,
    currentClaim: current ? { ...strip(current), checklist: (({ stage, required, missing, flagged, verified }) => ({ stage, required, missing, flagged, verified }))(tools.docProgress(current)), warnings } : null,
    warnings: warnings.map((w) => ({ ...w, claimId: current!.id, claimNumber: current!.claimNumber })),
    pendingActions,
    counts: {
      policies: policies.length,
      claims: claims.length,
      activeClaims: claims.filter((c) => !['SETTLED', 'REJECTED'].includes(c.status)).length,
      openQueries: openQueries.length,
      pendingActions: pendingActions.length,
      unreadNotifications: unread,
    },
    paidOut: claims.reduce((s, c) => s + (c.settlement?.status === 'PAID' ? c.settlement.approvedAmount : 0), 0),
  });
});

/** Policy Reader: (re)derive coverage, exclusions, conditions, waiting periods and a plain summary from the stored policy + PDF text. */
r.post('/policies/:id/analyze', async (req, res) => {
  const p = await prisma.policy.findFirst({ where: { id: req.params.id, ...(req.user!.role === 'CUSTOMER' ? { userId: req.user!.id } : {}) } });
  if (!p) throw badRequest('Policy not found');
  const analysis = analyzePolicy(p);
  await prisma.policy.update({ where: { id: p.id }, data: { analysis: analysis as unknown as Prisma.InputJsonValue, analyzedAt: new Date() } });
  await tools.logActivity({ action: 'POLICY_ANALYZED', reason: `Policy Reader analysed ${p.policyNumber}: ${analysis.coverage.length} cover items, ${analysis.exclusions.length} exclusions, ${analysis.waitingPeriods.filter((w) => w.active).length} active waiting periods.`, confidence: 0.9, meta: { policyId: p.id } });
  res.json(analysis);
});

r.get('/policies/:id', async (req, res) => {
  const p = await prisma.policy.findFirst({ where: { id: req.params.id, userId: req.user!.id }, omit: { rawText: true }, include: { claims: { select: { id: true, claimNumber: true, status: true, hospital: true, createdAt: true } } } });
  if (!p) throw badRequest('Policy not found');
  res.json(p);
});

// ---------- home screen summary ----------
r.get('/summary', async (req, res) => {
  const id = req.user!.id;
  const [claims, unread, openQueries, policies] = await Promise.all([
    prisma.claim.findMany({ where: { userId: id }, select: { id: true, claimNumber: true, status: true, hospital: true, reason: true, lastActivityAt: true, billAmount: true, estimatedAmount: true, settlement: { select: { approvedAmount: true, status: true } } }, orderBy: { lastActivityAt: 'desc' } }),
    prisma.notification.count({ where: { userId: id, read: false } }),
    prisma.query.count({ where: { status: 'OPEN', claim: { userId: id } } }),
    prisma.policy.count({ where: { userId: id } }),
  ]);
  const active = claims.filter((c) => !['SETTLED', 'REJECTED'].includes(c.status));
  res.json({
    policies,
    claims: { total: claims.length, active: active.length, byStatus: claims.reduce<Record<string, number>>((m, c) => ((m[c.status] = (m[c.status] ?? 0) + 1), m), {}) },
    openQueries,
    unreadNotifications: unread,
    paidOut: claims.reduce((s, c) => s + (c.settlement?.status === 'PAID' ? c.settlement.approvedAmount : 0), 0),
    recent: claims.slice(0, 5),
  });
});

export default r;

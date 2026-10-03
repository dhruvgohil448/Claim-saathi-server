import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { auth, isStaff, staffOnly } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { AppError, badRequest, forbidden, notFound } from '../utils/errors';
import { extractText } from '../services/extract';
import * as ai from '../services/ai.service';
import { putFile } from '../services/storage';
import { bus } from '../events/bus';
import { policyRules } from '../tools';
import { parseDocDate } from '../services/ai.service';
import { docLabel } from '../utils/format';

const r = Router();
r.use(auth);

r.get('/', staffOnly, async (req, res) => {
  const search = String(req.query.search ?? '').trim();
  const policies = await prisma.policy.findMany({
    where: search ? { OR: [{ policyNumber: { contains: search, mode: 'insensitive' } }, { user: { name: { contains: search, mode: 'insensitive' } } }] } : {},
    include: { user: { select: { id: true, name: true, email: true, phone: true } }, _count: { select: { claims: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(policies.map(({ rawText, ...p }) => p));
});

r.get('/my', async (req, res) => {
  res.json(await prisma.policy.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, omit: { rawText: true } }));
});

r.get('/:id', async (req, res) => {
  const p = await prisma.policy.findUnique({ where: { id: req.params.id }, include: { user: { select: { id: true, name: true, email: true } }, claims: { select: { id: true, claimNumber: true, status: true, hospital: true, billAmount: true, estimatedAmount: true, createdAt: true } } }, omit: { rawText: true } });
  if (!p) throw notFound('Policy not found');
  if (!isStaff(req) && p.userId !== req.user!.id) throw forbidden();
  res.json(p);
});

/** Upload a policy PDF → extract text → AI returns structured rules → saved → returned. */
r.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) throw new AppError(400, 'Attach the policy PDF as a multipart file (field "file" or "document")', 'FILE_REQUIRED');
  const ownerId = isStaff(req) && req.body.userId ? String(req.body.userId) : req.user!.id;
  const ex = await extractText(req.file.buffer, req.file.mimetype);
  const data = await ai.extractPolicy(ex.text);
  const fileUrl = await putFile(req.file.buffer, req.file.originalname, req.file.mimetype, `policies/${ownerId}`);
  const startDate = (data.startDate && parseDocDate(data.startDate)) || new Date();
  const fields = {
    insurer: data.insurer,
    planName: data.planName,
    sumInsured: data.sumInsured,
    roomRentLimit: data.roomRentLimit,
    icuLimit: data.icuLimit,
    coPayPercent: data.coPayPercent,
    startDate,
    waitingPeriods: data.waitingPeriods,
    subLimits: data.subLimits,
    exclusions: data.exclusions,
    networkHospitals: data.networkHospitals,
    summary: data.summaryEnglish,
    summaryHindi: data.summaryHindi,
    fileUrl,
    rawText: ex.text.slice(0, 20000),
  };
  const policy = await prisma.policy.upsert({ where: { policyNumber: data.policyNumber }, create: { userId: ownerId, policyNumber: data.policyNumber, ...fields }, update: fields, omit: { rawText: true } });
  bus.emitEvent('policy.uploaded', { policyId: policy.id, userId: ownerId });
  res.status(201).json({ policy, extraction: data });
});

/** AI chat about the policy (and optionally a claim). */
r.post('/:id/chat', async (req, res) => {
  const { question, claimId } = z.object({ question: z.string().min(1).max(500), claimId: z.string().optional() }).parse(req.body);
  const p = await prisma.policy.findUnique({ where: { id: req.params.id } });
  if (!p) throw notFound('Policy not found');
  if (!isStaff(req) && p.userId !== req.user!.id) throw forbidden();
  const claim = claimId
    ? await prisma.claim.findFirst({ where: { id: claimId, policyId: p.id }, include: { settlement: true, documents: true } })
    : await prisma.claim.findFirst({ where: { policyId: p.id }, orderBy: { createdAt: 'desc' }, include: { settlement: true, documents: true } });
  const have = new Set(claim?.documents.map((d) => d.type));
  const answer = await ai.askPolicy(
    {
      policy: { ...policyRules(p), policyNumber: p.policyNumber, insurer: p.insurer, exclusions: (p.exclusions as string[]) ?? [], summary: p.summary },
      claim: claim
        ? { claimNumber: claim.claimNumber, status: claim.status, hospital: claim.hospital, billAmount: claim.billAmount ?? claim.estimatedAmount, approvedAmount: claim.settlement?.approvedAmount ?? null, missingDocs: ['DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'LAB_REPORT'].filter((t) => !have.has(t as never)).map(docLabel) }
        : null,
    },
    question,
  );
  res.json(answer);
});

export default r;

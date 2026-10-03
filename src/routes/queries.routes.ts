import { Router } from 'express';
import { z } from 'zod';
import { Prisma, QueryStatus } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { auth, isStaff, staffOnly } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { forbidden, notFound } from '../utils/errors';
import { bus } from '../events/bus';
import * as tools from '../tools';
import * as ai from '../services/ai.service';
import { createDocument } from './claims.routes';

const r = Router();
r.use(auth);

r.get('/', async (req, res) => {
  const status = String(req.query.status ?? '');
  const where: Prisma.QueryWhereInput = {};
  if (status && status !== 'ALL') where.status = { in: status.split(',') as QueryStatus[] };
  if (!isStaff(req)) where.claim = { userId: req.user!.id };
  res.json(
    await prisma.query.findMany({
      where,
      include: { claim: { select: { id: true, claimNumber: true, patientName: true, hospital: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  );
});

r.get('/:id/explain', async (req, res) => {
  const q = await prisma.query.findUnique({ where: { id: req.params.id }, include: { claim: true } });
  if (!q) throw notFound();
  if (!isStaff(req) && q.claim.userId !== req.user!.id) throw forbidden();
  res.json(await ai.explainQuery(q.message));
});

/** Customer (or ops on their behalf) answers a query, optionally with a file. */
r.post('/:id/respond', upload.single('file'), async (req, res) => {
  const { response, type } = z.object({ response: z.string().max(2000).optional().default(''), type: z.string().optional() }).parse(req.body ?? {});
  const q = await prisma.query.findUnique({ where: { id: String(req.params.id) }, include: { claim: true } });
  if (!q) throw notFound('Query not found');
  if (!isStaff(req) && q.claim.userId !== req.user!.id) throw forbidden();
  let documentId: string | undefined;
  if (req.file) {
    const doc = await createDocument(req, q.claimId, q.claim.claimNumber, type ?? q.requestedDocType ?? undefined);
    documentId = doc.id;
  }
  const updated = await prisma.query.update({ where: { id: q.id }, data: { status: 'ANSWERED', response: response || (req.file ? `Uploaded ${req.file.originalname}` : 'Responded'), respondedAt: new Date() } });
  await tools.logActivity({ claimId: q.claimId, action: 'QUERY_ANSWERED', reason: `${req.user!.name} replied: "${updated.response}"`, actor: 'HUMAN', actorName: req.user!.name });
  if (!isStaff(req))
    await tools.notifyOps({ title: `${q.claim.claimNumber}: customer replied to a query`, body: `${req.user!.name}: ${updated.response}`.slice(0, 280), type: 'INFO', claimId: q.claimId });
  bus.emitEvent('query.answered', { claimId: q.claimId, queryId: q.id, documentId });
  res.json(updated);
});

r.patch('/:id/close', staffOnly, async (req, res) => {
  const q = await prisma.query.findUnique({ where: { id: String(req.params.id) } });
  if (!q) throw notFound();
  res.json(await tools.closeQuery(q.id, `Closed by ${req.user!.name}.`, 'HUMAN', req.user!.name));
});

export default r;

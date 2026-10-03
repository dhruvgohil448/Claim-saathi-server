import { relClaimScope } from '../services/demo';
import { Router, Request } from 'express';
import fs from 'fs';
import { z } from 'zod';
import { DocumentStatus, DocumentType, Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { auth, isStaff, staffOnly } from '../middleware/auth';
import { forbidden, notFound } from '../utils/errors';
import * as tools from '../tools';
import { localPath, readFile, signedUrl, verifyFileSig, mimeFromName } from '../services/storage';
import { rerunAgent } from '../agent/claimAgent';
import { env } from '../config/env';
import { docLabel } from '../utils/format';

export const filesRouter = Router();
/** Signed, short-lived file links (so <iframe>/<img> can load private files without a header). */
filesRouter.get('/:id', async (req, res) => {
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig ?? '');
  if (!exp || !sig || !verifyFileSig(req.params.id, exp, sig)) throw forbidden('Link expired');
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) throw notFound();
  const type = doc.mimeType || mimeFromName(doc.fileName);
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `inline; filename="${doc.fileName.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=600');
  const p = localPath(doc.fileUrl);
  if (p && fs.existsSync(p)) return void fs.createReadStream(p).pipe(res);
  const buf = await readFile(doc.fileUrl);
  if (!buf) throw notFound('File missing from storage');
  res.end(buf);
});

const r = Router();
r.use(auth);

export const baseUrl = (req: Request) => `${req.protocol}://${req.get('host')}`;

async function getDocFor(req: Request) {
  const d = await prisma.document.findUnique({ where: { id: req.params.id as string }, include: { claim: { select: { id: true, claimNumber: true, userId: true, patientName: true, hospital: true, status: true } } } });
  if (!d) throw notFound('Document not found');
  if (!isStaff(req) && d.claim.userId !== req.user!.id) throw forbidden();
  return d;
}

r.get('/', staffOnly, async (req, res) => {
  const q = z.object({ status: z.string().optional(), type: z.string().optional(), search: z.string().optional() }).parse(req.query);
  const where: Prisma.DocumentWhereInput = { ...(await relClaimScope()) };
  if (q.status && q.status !== 'ALL') where.status = { in: q.status.split(',') as DocumentStatus[] };
  if (q.type && q.type !== 'ALL') where.type = q.type as DocumentType;
  if (q.search) where.OR = [{ fileName: { contains: q.search, mode: 'insensitive' } }, { claim: { claimNumber: { contains: q.search, mode: 'insensitive' } } }, { claim: { patientName: { contains: q.search, mode: 'insensitive' } } }];
  res.json(
    await prisma.document.findMany({
      where,
      include: { claim: { select: { id: true, claimNumber: true, patientName: true, hospital: true, status: true } } },
      orderBy: [{ updatedAt: 'desc' }],
      take: 300,
    }),
  );
});

r.get('/:id', async (req, res) => res.json(await getDocFor(req)));

r.get('/:id/url', async (req, res) => {
  const d = await getDocFor(req);
  res.json({ url: await signedUrl(d.fileUrl, d.id, baseUrl(req)), mimeType: d.mimeType, fileName: d.fileName });
});

/** Re-run OCR + AI validation on demand. */
r.post('/:id/validate', async (req, res) => {
  const d = await getDocFor(req);
  const { validation } = await tools.validateDocument(d.id, env.autoVerifyConfidence);
  rerunAgent(d.claimId).catch((e) => console.error(e));
  res.json({ document: await prisma.document.findUnique({ where: { id: d.id } }), validation });
});

/** Human review / override of a document's status. */
r.patch('/:id/review', staffOnly, async (req, res) => {
  const { status, note } = z.object({ status: z.enum(['VERIFIED', 'NEEDS_REVIEW', 'INVALID']), note: z.string().max(500).optional() }).parse(req.body);
  const d = await getDocFor(req);
  const who = req.user!.name;
  const updated = await tools.updateDocumentStatus(d.id, status, {
    reason: `${who} marked ${docLabel(d.type).toLowerCase()} as ${status.replace('_', ' ').toLowerCase()}${d.status !== 'UPLOADED' ? ` (AI said ${d.status.replace('_', ' ').toLowerCase()})` : ''}.${note ? ` Note: ${note}` : ''}`,
    actor: 'HUMAN',
    actorName: who,
    note,
    action: d.status !== status ? 'DOC_OVERRIDDEN' : 'DOC_REVIEWED',
  });
  if (status !== 'VERIFIED')
    await tools.notifyUser(d.claim.userId, { title: `Please re-upload your ${docLabel(d.type).toLowerCase()}`, body: note || 'Our team could not accept this document. Please upload a clearer, complete copy.', type: 'ACTION_REQUIRED', claimId: d.claimId }, false);
  rerunAgent(d.claimId).catch((e) => console.error(e));
  res.json(updated);
});

export default r;

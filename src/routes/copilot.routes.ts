/** AI Claim Copilot endpoints (customer + ops). Deterministic rules-based AI; numbers match the settlement engine. */
import { Router, Request } from 'express';
import { prisma } from '../utils/prisma';
import { auth, isStaff } from '../middleware/auth';
import { forbidden, notFound } from '../utils/errors';
import { aiSummary, billAnalysis, prediction } from '../services/copilot';

const r = Router();

async function claimId(req: Request) {
  const id = String(req.params.id);
  const c = await prisma.claim.findFirst({ where: { OR: [{ id }, { claimNumber: id }] }, select: { id: true, userId: true } });
  if (!c) throw notFound('Claim not found');
  if (!isStaff(req) && c.userId !== req.user!.id) throw forbidden();
  return c.id;
}

r.get('/:id/prediction', auth, async (req, res) => res.json(await prediction(await claimId(req))));
r.get('/:id/bill-analysis', auth, async (req, res) => res.json(await billAnalysis(await claimId(req))));
r.get('/:id/ai-summary', auth, async (req, res) => res.json(await aiSummary(await claimId(req))));

export default r;

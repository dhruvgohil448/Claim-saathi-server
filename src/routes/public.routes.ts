/** Unauthenticated, aggregate-only numbers for the login screen. No names, amounts or contact details. */
import { Router } from 'express';
import { prisma } from '../utils/prisma';

const r = Router();

r.get('/summary', async (_req, res) => {
  const [claims, escalated, aiLogs, explained, recent, docPairs] = await Promise.all([
    prisma.claim.findMany({ select: { id: true, status: true } }),
    prisma.activityLog.findMany({ where: { action: 'ESCALATED' }, select: { claimId: true }, distinct: ['claimId'] }),
    prisma.activityLog.count({ where: { actor: 'AI' } }),
    prisma.activityLog.count({ where: { actor: 'AI', NOT: { reason: '' } } }),
    prisma.activityLog.findMany({ where: { actor: 'AI', claimId: { not: null }, action: { notIn: ['NOTIFIED_CUSTOMER'] } }, orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, action: true, confidence: true, createdAt: true, claim: { select: { claimNumber: true } } } }),
    prisma.$queryRaw<{ seconds: number | null; n: bigint }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (v."createdAt" - u."createdAt"))) AS seconds, count(*) AS n
      FROM "ActivityLog" u JOIN "ActivityLog" v ON v.meta->>'documentId' = u.meta->>'documentId'
      WHERE u.action = 'DOC_UPLOADED' AND v.action IN ('DOC_VERIFIED','DOC_FLAGGED') AND v."createdAt" >= u."createdAt"`,
  ]);
  const esc = new Set(escalated.map((e) => e.claimId));
  claims.filter((c) => c.status === 'NEEDS_HUMAN').forEach((c) => esc.add(c.id));
  const decided = claims.filter((c) => c.status !== 'CREATED');
  const auto = decided.filter((c) => !esc.has(c.id)).length;
  res.json({
    totalClaims: claims.length,
    autoHandledPct: decided.length ? Math.round((auto / decided.length) * 100) : null,
    medianDocCheckSeconds: docPairs[0]?.seconds != null ? Math.round(Number(docPairs[0].seconds)) : null,
    docChecksMeasured: Number(docPairs[0]?.n ?? 0),
    explainedPct: aiLogs ? Math.round((explained / aiLogs) * 100) : null,
    recent: recent.map((a) => ({ id: a.id, action: a.action, confidence: a.confidence, createdAt: a.createdAt, claimNumber: a.claim?.claimNumber ?? null })),
  });
});

export default r;

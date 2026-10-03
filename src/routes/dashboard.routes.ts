import { Router } from 'express';
import { z } from 'zod';
import { ActorType, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { auth, requireRole, staffOnly } from '../middleware/auth';
import { claimListInclude } from './claims.routes';
import { runSeed } from '../seed/seed';
import { runFollowups } from '../jobs/followup';
import * as tools from '../tools';
import { maskBank } from '../services/users';
import { PLACEHOLDER_EMAIL_DOMAIN } from '../services/otp';
import { env, llmEnabled } from '../config/env';
import { storageMode } from '../services/storage';
import { clientCount, publish } from '../realtime/hub';

const r = Router();
r.use(auth, staffOnly);

const DAY = 86400000;
const istDay = (d: Date) => new Date(d.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
const pctChange = (cur: number, prev: number) => (prev === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 100));

r.get('/analytics/overview', async (_req, res) => {
  const now = Date.now();
  const wk = new Date(now - 7 * DAY);
  const pwk = new Date(now - 14 * DAY);
  const [claims, openQueries, logs7, logsPrev7, escalatedIds, docs] = await Promise.all([
    prisma.claim.findMany({ select: { id: true, status: true, billAmount: true, estimatedAmount: true, createdAt: true, settlement: { select: { approvedAmount: true, status: true } } } }),
    prisma.query.count({ where: { status: 'OPEN' } }),
    prisma.activityLog.groupBy({ by: ['actor'], where: { createdAt: { gte: wk } }, _count: true }),
    prisma.activityLog.groupBy({ by: ['actor'], where: { createdAt: { gte: pwk, lt: wk } }, _count: true }),
    prisma.activityLog.findMany({ where: { action: 'ESCALATED' }, select: { claimId: true }, distinct: ['claimId'] }),
    prisma.document.groupBy({ by: ['status'], _count: true }),
  ]);
  const value = (c: (typeof claims)[number]) => c.billAmount ?? c.estimatedAmount ?? 0;
  const by = (s: string[]) => claims.filter((c) => s.includes(c.status));
  const escalated = new Set(escalatedIds.map((x) => x.claimId));
  claims.filter((c) => c.status === 'NEEDS_HUMAN').forEach((c) => escalated.add(c.id));
  const decided = claims.filter((c) => !['CREATED'].includes(c.status));
  const autoHandled = decided.filter((c) => !escalated.has(c.id)).length;
  const aiActions = (g: typeof logs7) => g.find((x) => x.actor === 'AI')?._count ?? 0;
  const humanActions = (g: typeof logs7) => g.find((x) => x.actor === 'HUMAN')?._count ?? 0;
  const thisWeek = claims.filter((c) => c.createdAt >= wk).length;
  const lastWeek = claims.filter((c) => c.createdAt >= pwk && c.createdAt < wk).length;
  const confAgg = await prisma.activityLog.aggregate({ _avg: { confidence: true }, where: { actor: 'AI', confidence: { not: null } } });
  const approvedValue = claims.reduce((s, c) => s + (['APPROVED', 'SETTLED'].includes(c.status) ? c.settlement?.approvedAmount ?? 0 : 0), 0);
  res.json({
    totalClaims: claims.length,
    claimsThisWeek: thisWeek,
    claimsTrend: pctChange(thisWeek, lastWeek),
    pendingReview: by(['UNDER_REVIEW', 'NEEDS_HUMAN', 'PREAUTH_SUBMITTED']).length,
    needsHuman: by(['NEEDS_HUMAN']).length,
    openQueries,
    approved: by(['APPROVED', 'SETTLED']).length,
    rejected: by(['REJECTED']).length,
    awaitingCustomer: by(['CREATED', 'DOCS_PENDING', 'QUERY_RAISED']).length,
    totalClaimValue: claims.reduce((s, c) => s + value(c), 0),
    approvedValue,
    autoHandled,
    escalated: escalated.size,
    autoHandledPct: decided.length ? Math.round((autoHandled / decided.length) * 100) : 0,
    aiActions7d: aiActions(logs7),
    aiActionsTrend: pctChange(aiActions(logs7), aiActions(logsPrev7)),
    humanActions7d: humanActions(logs7),
    avgConfidence: Number((confAgg._avg.confidence ?? 0).toFixed(2)),
    documents: Object.fromEntries(docs.map((d) => [d.status, d._count])),
  });
});

r.get('/analytics/charts', async (req, res) => {
  const days = Math.min(60, Number(req.query.days) || 14);
  const since = new Date(Date.now() - (days - 1) * DAY);
  since.setHours(0, 0, 0, 0);
  const [claims, logs, settlements, docs, decisions] = await Promise.all([
    prisma.claim.findMany({ select: { id: true, status: true, createdAt: true, claimType: true, hospital: true, billAmount: true, estimatedAmount: true } }),
    prisma.activityLog.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, actor: true, action: true } }),
    prisma.settlement.findMany({ include: { claim: { select: { claimNumber: true, patientName: true, status: true } } } }),
    prisma.document.groupBy({ by: ['status'], _count: true }),
    prisma.claimEvent.findMany({ where: { status: { in: ['APPROVED', 'REJECTED', 'SETTLED'] } }, orderBy: { createdAt: 'asc' }, select: { claimId: true, createdAt: true } }),
  ]);
  // Turnaround: hours from claim creation to its first final decision (approved / rejected / settled), by IST day of decision.
  const created = new Map(claims.map((c) => [c.id, c.createdAt]));
  const firstDecision = new Map<string, Date>();
  for (const d of decisions) if (!firstDecision.has(d.claimId)) firstDecision.set(d.claimId, d.createdAt);
  const tat: Record<string, { date: string; totalHours: number; decided: number }> = {};
  const allHours: number[] = [];
  for (const [claimId, at] of firstDecision) {
    const c = created.get(claimId);
    if (!c) continue;
    const h = Math.max(0, (at.getTime() - c.getTime()) / 3600000);
    allHours.push(h);
    const d = istDay(at);
    tat[d] ??= { date: d, totalHours: 0, decided: 0 };
    tat[d].totalHours += h;
    tat[d].decided++;
  }
  const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null);
  const statuses = ['CREATED', 'PREAUTH_SUBMITTED', 'DOCS_PENDING', 'UNDER_REVIEW', 'QUERY_RAISED', 'NEEDS_HUMAN', 'APPROVED', 'REJECTED', 'SETTLED'];
  const series: Record<string, { date: string; claims: number; aiActions: number; humanActions: number; escalations: number }> = {};
  for (let i = 0; i < days; i++) {
    const d = istDay(new Date(since.getTime() + i * DAY + 12 * 3600000));
    series[d] = { date: d, claims: 0, aiActions: 0, humanActions: 0, escalations: 0 };
  }
  for (const c of claims) { const d = istDay(c.createdAt); if (series[d]) series[d].claims++; }
  for (const l of logs) {
    const d = istDay(l.createdAt);
    if (!series[d]) continue;
    if (l.actor === 'HUMAN') series[d].humanActions++;
    else series[d].aiActions++;
    if (l.action === 'ESCALATED') series[d].escalations++;
  }
  const deductionTotals: Record<string, number> = {};
  for (const s of settlements) for (const d of (s.deductions as unknown as { label: string; amount: number }[]) ?? []) {
    const k = d.label.replace(/\s*\(.*\)/, '');
    deductionTotals[k] = (deductionTotals[k] ?? 0) + d.amount;
  }
  const actionCounts: Record<string, number> = {};
  for (const l of logs) if (l.actor !== 'HUMAN') actionCounts[l.action] = (actionCounts[l.action] ?? 0) + 1;
  res.json({
    claimsByStatus: statuses.map((s) => ({ status: s, count: claims.filter((c) => c.status === s).length })),
    perDay: Object.values(series),
    claimsByType: ['CASHLESS', 'REIMBURSEMENT'].map((t) => ({ type: t, count: claims.filter((c) => c.claimType === t).length })),
    settlements: settlements
      .sort((a, b) => a.claim.claimNumber.localeCompare(b.claim.claimNumber))
      .map((s) => ({ claimNumber: s.claim.claimNumber, patient: s.claim.patientName, bill: s.billAmount, approved: s.approvedAmount, deductions: s.billAmount - s.approvedAmount, status: s.status })),
    deductionsByType: Object.entries(deductionTotals).map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount),
    documentValidation: Object.fromEntries(docs.map((d) => [d.status, d._count])),
    aiActionsByType: Object.entries(actionCounts).map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count),
    turnaround: {
      decidedClaims: allHours.length,
      avgHours: allHours.length ? Number((allHours.reduce((a, b) => a + b, 0) / allHours.length).toFixed(1)) : null,
      medianHours: median(allHours) != null ? Number(median(allHours)!.toFixed(1)) : null,
      perDay: Object.keys(series).map((d) => ({ date: d, decided: tat[d]?.decided ?? 0, avgHours: tat[d] ? Number((tat[d].totalHours / tat[d].decided).toFixed(1)) : null })),
    },
  });
});

/** Business rules the dashboard displays (escalation threshold, auto-verify confidence, follow-up cadence). */
r.get('/config', (_req, res) => {
  res.json({
    escalationAmount: env.escalationAmount,
    autoVerifyConfidence: env.autoVerifyConfidence,
    stuckAfterMinutes: env.stuckAfterMinutes,
    maxReminders: env.maxReminders,
    autoSettleAfterMinutes: env.autoSettleAfterMinutes,
    ai: llmEnabled() ? env.aiProvider : 'mock',
    planner: env.agentPlanner,
    storage: storageMode(),
    liveClients: clientCount(),
  });
});

r.get('/escalations', async (_req, res) => {
  const claims = await prisma.claim.findMany({
    where: { OR: [{ status: 'NEEDS_HUMAN' }, { status: 'PREAUTH_SUBMITTED', aiSuggestion: { not: Prisma.DbNull } }] },
    include: { ...claimListInclude, documents: { select: { id: true, type: true, status: true, confidence: true } }, settlement: true, activities: { where: { action: { in: ['ESCALATED', 'PREAUTH_NOTE_DRAFTED'] } }, orderBy: { createdAt: 'desc' }, take: 1 } },
    orderBy: { lastActivityAt: 'desc' },
  });
  res.json(
    claims
      .filter((c) => !(c.aiSuggestion as Record<string, unknown> | null)?.resolved)
      .map((c) => ({ ...c, kind: c.status === 'NEEDS_HUMAN' ? 'ESCALATION' : 'PREAUTH', escalatedAt: c.activities[0]?.createdAt ?? c.lastActivityAt, escalationReason: c.activities[0]?.reason ?? null })),
  );
});

r.get('/activity', async (req, res) => {
  const q = z
    .object({ claimId: z.string().optional(), actor: z.nativeEnum(ActorType).optional(), limit: z.coerce.number().int().min(1).max(200).default(60), before: z.coerce.date().optional(), since: z.coerce.date().optional() })
    .parse(req.query);
  const where: Prisma.ActivityLogWhereInput = {};
  if (q.claimId) where.claimId = q.claimId;
  if (q.actor) where.actor = q.actor;
  if (q.before || q.since) where.createdAt = { ...(q.before ? { lt: q.before } : {}), ...(q.since ? { gt: q.since } : {}) };
  const items = await prisma.activityLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: q.limit, include: { claim: { select: { id: true, claimNumber: true, patientName: true, status: true } } } });
  res.json({ items, nextCursor: items.length === q.limit ? items[items.length - 1].createdAt : null });
});

r.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, phone: true, role: true, city: true, dob: true, gender: true, bankAccount: true, lastLoginAt: true, createdAt: true, _count: { select: { claims: true, policies: true } } },
    orderBy: [{ role: 'desc' }, { createdAt: 'desc' }],
  });
  res.json(users.map(({ bankAccount, ...u }) => ({ ...u, email: u.email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`) ? null : u.email, bank: maskBank(bankAccount) })));
});

r.patch('/users/:id/role', requireRole('ADMIN'), async (req, res) => {
  const { role } = z.object({ role: z.nativeEnum(UserRole) }).parse(req.body);
  const u = await prisma.user.update({ where: { id: req.params.id as string }, data: { role }, select: { id: true, name: true, role: true } });
  await tools.logActivity({ action: 'USER_ROLE_CHANGED', reason: `${req.user!.name} changed ${u.name}'s role to ${role}.`, actor: 'HUMAN', actorName: req.user!.name });
  res.json(u);
});

r.get('/search', async (req, res) => {
  const s = String(req.query.q ?? '').trim();
  if (s.length < 2) return void res.json({ claims: [], users: [], policies: [] });
  const ci = { contains: s, mode: 'insensitive' as const };
  const [claims, users, policies] = await Promise.all([
    prisma.claim.findMany({ where: { OR: [{ claimNumber: ci }, { patientName: ci }, { hospital: ci }, { reason: ci }] }, select: { id: true, claimNumber: true, patientName: true, hospital: true, status: true }, take: 6 }),
    prisma.user.findMany({ where: { OR: [{ name: ci }, { email: ci }] }, select: { id: true, name: true, email: true, role: true }, take: 4 }),
    prisma.policy.findMany({ where: { OR: [{ policyNumber: ci }, { user: { name: ci } }] }, select: { id: true, policyNumber: true, user: { select: { name: true } } }, take: 4 }),
  ]);
  res.json({ claims, users, policies });
});

r.post('/admin/reset-demo', requireRole('ADMIN'), async (_req, res) => {
  const result = await runSeed(prisma);
  publish({ topic: 'claim' });
  res.json({ ok: true, ...result });
});

r.post('/admin/run-followups', requireRole('ADMIN'), async (_req, res) => {
  res.json(await runFollowups());
});

export default r;

/**
 * n8n automation bridge.
 * - Outbound: fire-and-forget POST of claim events to N8N_WEBHOOK_URL (never blocks or fails a request).
 * - Inbound: POST /api/integrations/n8n/callback (header x-n8n-secret) stores the n8n-built
 *   customer message as a Notification + ActivityLog tagged "via n8n", pushed live over SSE.
 * - GET /api/integrations/n8n/stats (same secret) feeds the Daily Ops Summary workflow.
 */
import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { bus } from '../events/bus';
import { publish } from '../realtime/hub';

const WEBHOOK = () => process.env.N8N_WEBHOOK_URL || '';
const SECRET = () => process.env.N8N_SHARED_SECRET || '';

export type N8nEvent = 'claim.submitted' | 'document.uploaded' | 'query.raised' | 'query.resolved' | 'claim.approved' | 'claim.settled';

const BANKS: Record<string, string> = { HDFC: 'HDFC', ICIC: 'ICICI', SBIN: 'SBI', UTIB: 'Axis', KKBK: 'Kotak', PUNB: 'PNB', BARB: 'Bank of Baroda', YESB: 'Yes Bank', PYTM: 'Paytm Payments Bank' };

async function buildPayload(event: N8nEvent, claimId: string, extra: Record<string, unknown> = {}) {
  const c = await prisma.claim.findUnique({
    where: { id: claimId },
    include: { user: { select: { id: true, name: true, phone: true, bankAccount: true } }, settlement: true, queries: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!c) return null;
  const bank = (c.user?.bankAccount ?? {}) as { accountNumber?: string; ifsc?: string };
  const ifsc = (bank.ifsc || '').toUpperCase();
  return {
    event,
    at: new Date().toISOString(),
    claimId: c.id,
    claimNumber: c.claimNumber,
    userId: c.userId,
    customerName: c.user?.name ?? c.patientName,
    patientName: c.patientName,
    hospital: c.hospital,
    status: c.status,
    billAmount: c.billAmount ?? c.settlement?.billAmount ?? null,
    approvedAmount: c.settlement?.approvedAmount ?? null,
    utr: c.settlement?.utr ?? null,
    bankName: BANKS[ifsc.slice(0, 4)] ?? (ifsc ? ifsc.slice(0, 4) : 'bank'),
    accountLast4: bank.accountNumber ? String(bank.accountNumber).slice(-4) : null,
    queryMessage: c.queries[0]?.message ?? null,
    callbackUrl: process.env.N8N_CALLBACK_URL || null,
    ...extra,
  };
}

/** Fire-and-forget. Safe to call anywhere; swallows every error. */
export function emitN8n(event: N8nEvent, claimId: string | null | undefined, extra: Record<string, unknown> = {}) {
  const url = WEBHOOK();
  if (!url || !claimId) return;
  void (async () => {
    try {
      const payload = await buildPayload(event, claimId, extra);
      if (!payload) return;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claim-saathi': '1' }, body: JSON.stringify(payload), signal: ctl.signal });
      clearTimeout(t);
      console.log(`[n8n] ${event} ${payload.claimNumber} -> ${r.status}`);
    } catch (e) {
      console.warn(`[n8n] ${event} send failed:`, (e as Error).message);
    }
  })();
}

const STATUS_EVENT: Record<string, N8nEvent> = { QUERY_RAISED: 'query.raised', APPROVED: 'claim.approved', SETTLED: 'claim.settled' };
/** Called from updateClaimStatus. */
export function n8nOnStatus(claimId: string, status: string) {
  const ev = STATUS_EVENT[status];
  if (ev) emitN8n(ev, claimId);
}

let registered = false;
export function registerN8n() {
  if (registered) return;
  registered = true;
  bus.onEvent('claim.created', (p) => emitN8n('claim.submitted', p.claimId));
  bus.onEvent('document.uploaded', (p) => emitN8n('document.uploaded', p.claimId, { documentId: p.documentId }));
  bus.onEvent('query.answered', (p) => emitN8n('query.resolved', p.claimId, { queryId: p.queryId }));
  console.log(`[n8n] ${WEBHOOK() ? 'enabled' : 'disabled (N8N_WEBHOOK_URL not set)'}`);
}

export const n8nRouter = Router();
n8nRouter.use((req, res, next) => {
  if (!SECRET() || req.get('x-n8n-secret') !== SECRET()) return res.status(401).json({ error: 'bad n8n secret' });
  next();
});

n8nRouter.post('/callback', async (req, res) => {
  const b = (req.body ?? {}) as { event?: string; claimId?: string; userId?: string; title?: string; body?: string; bodyHi?: string; type?: string };
  if (!b.userId || !b.title || !b.body) return res.status(400).json({ error: 'userId, title, body required' });
  const user = await prisma.user.findUnique({ where: { id: b.userId }, select: { id: true } });
  if (!user) return res.status(404).json({ error: 'user not found' });
  const claimId = b.claimId && (await prisma.claim.findUnique({ where: { id: b.claimId }, select: { id: true } })) ? b.claimId : null;
  const type = (['INFO', 'SUCCESS', 'WARNING', 'ACTION_REQUIRED'].includes(String(b.type)) ? b.type : 'INFO') as 'INFO' | 'SUCCESS' | 'WARNING' | 'ACTION_REQUIRED';
  const body = b.bodyHi ? `${b.body}\n${b.bodyHi}` : b.body;
  const n = await prisma.notification.create({ data: { userId: b.userId, claimId, title: `${b.title} · via n8n`, body, type } });
  await prisma.activityLog.create({ data: { claimId, actor: 'SYSTEM', actorName: 'n8n', action: 'N8N_NOTIFIED', reason: `via n8n (${b.event ?? 'event'}): ${b.body}`, meta: { via: 'n8n', event: b.event ?? null, notificationId: n.id } } });
  publish({ topic: 'notification', userId: b.userId, claimId });
  publish({ topic: 'activity', claimId });
  res.json({ ok: true, notificationId: n.id });
});

n8nRouter.get('/stats', async (_req, res) => {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [byStatus, newClaims, settled, n8nAlerts] = await Promise.all([
    prisma.claim.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.claim.count({ where: { createdAt: { gte: since } } }),
    prisma.settlement.aggregate({ _sum: { approvedAmount: true }, _count: { _all: true }, where: { status: 'PAID', paidAt: { gte: since } } }),
    prisma.activityLog.count({ where: { action: 'N8N_NOTIFIED', createdAt: { gte: since } } }),
  ]);
  res.json({
    at: new Date().toISOString(),
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    newClaims24h: newClaims,
    settled24h: settled._count._all,
    settledAmount24h: settled._sum.approvedAmount ?? 0,
    n8nAlerts24h: n8nAlerts,
  });
});

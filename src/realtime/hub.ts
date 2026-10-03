/**
 * Server-sent events hub. Every DB-changing tool (logActivity / notifications) calls publish();
 * changes are batched for 250 ms and pushed to connected dashboards (all changes) and
 * mobile clients (only changes on their own claims / notifications).
 */
import { Response } from 'express';
import { prisma } from '../utils/prisma';

export type Topic = 'claim' | 'document' | 'query' | 'activity' | 'notification' | 'policy' | 'user' | 'settlement';
interface Client { id: number; res: Response; userId: string; staff: boolean }

const clients = new Map<number, Client>();
let seq = 0;
let pending: { topics: Set<Topic>; claimIds: Set<string>; userIds: Set<string> } | null = null;
let timer: NodeJS.Timeout | null = null;

const write = (c: Client, event: string, data: unknown) => {
  try {
    c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(c.id);
  }
};

export function addClient(res: Response, userId: string, staff: boolean) {
  const c: Client = { id: ++seq, res, userId, staff };
  clients.set(c.id, c);
  write(c, 'ready', { at: new Date().toISOString(), clients: clients.size });
  const ping = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      /* closed */
    }
  }, 25000);
  res.on('close', () => {
    clearInterval(ping);
    clients.delete(c.id);
  });
}

export const clientCount = () => clients.size;

export function publish(e: { topic: Topic; claimId?: string | null; userId?: string | null }) {
  if (!clients.size) return;
  pending ??= { topics: new Set(), claimIds: new Set(), userIds: new Set() };
  pending.topics.add(e.topic);
  if (e.claimId) pending.claimIds.add(e.claimId);
  if (e.userId) pending.userIds.add(e.userId);
  timer ??= setTimeout(flush, 250);
}

async function flush() {
  timer = null;
  const p = pending;
  pending = null;
  if (!p || !clients.size) return;
  const payload = { topics: [...p.topics], claimIds: [...p.claimIds], at: new Date().toISOString() };
  const customers = [...clients.values()].filter((c) => !c.staff);
  let owners = new Map<string, string>();
  if (customers.length && p.claimIds.size) {
    const rows = await prisma.claim.findMany({ where: { id: { in: [...p.claimIds] } }, select: { id: true, userId: true } }).catch(() => []);
    owners = new Map(rows.map((r) => [r.id, r.userId]));
  }
  for (const c of clients.values()) {
    if (c.staff) {
      write(c, 'change', payload);
      continue;
    }
    const mine = payload.claimIds.filter((id) => owners.get(id) === c.userId);
    if (mine.length || p.userIds.has(c.userId)) write(c, 'change', { ...payload, claimIds: mine });
  }
}

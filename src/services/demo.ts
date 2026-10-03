/** Global "Demo data" switch for the ops dashboard. Seeded sample claims carry isDemo=true; app-created claims never do. */
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';

const KEY = 'showDemoData';
let cache: { v: boolean; at: number } | null = null;

export async function showDemoData(): Promise<boolean> {
  if (cache && Date.now() - cache.at < 5000) return cache.v;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  const v = row ? row.value !== false : true; // default ON
  cache = { v, at: Date.now() };
  return v;
}
export async function setShowDemoData(v: boolean) {
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: v }, update: { value: v } });
  cache = { v, at: Date.now() };
  return v;
}
/** Where-clause for claims visible on the dashboard. */
export async function claimScope(): Promise<Prisma.ClaimWhereInput> {
  return (await showDemoData()) ? {} : { isDemo: false };
}
/** For rows with an optional claim (activity logs, notifications): keep rows without a claim or with a live claim. */
export async function optionalClaimScope(): Promise<{ OR?: { claimId: null }[] | object[] }> {
  return (await showDemoData()) ? {} : { OR: [{ claimId: null }, { claim: { isDemo: false } }] };
}
/** For rows that always belong to a claim (documents, queries, settlements, events). */
export async function relClaimScope(): Promise<{ claim?: Prisma.ClaimWhereInput }> {
  return (await showDemoData()) ? {} : { claim: { isDemo: false } };
}

/**
 * Removes everything the mobile E2E tests created: users whose email starts with "e2e-test" or whose phone is the
 * test number, their policies / claims / documents (DB cascade), their uploaded files in Supabase storage, and the
 * user-level activity rows (no claimId) that mention them.
 * Usage: npx tsx scripts/cleanup-e2e.ts [phoneDigits] [--claims-only]
 *   --claims-only keeps the user and policies (the fixed demo-pack customer) and removes only their claims + files.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const phone = process.argv.slice(2).find((a) => !a.startsWith('--')) || '9000012345';
const claimsOnly = process.argv.includes('--claims-only');

async function main() {
  const users = claimsOnly
    ? await prisma.$queryRaw<{ id: string; name: string; email: string; phone: string | null }[]>`
        SELECT id, name, email, phone FROM "User" WHERE right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ${phone}`
    : await prisma.$queryRaw<{ id: string; name: string; email: string; phone: string | null }[]>`
        SELECT id, name, email, phone FROM "User"
        WHERE email LIKE 'e2e-test%' OR right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ${phone}`;
  if (!users.length) return console.log('[cleanup] nothing to remove');
  const ids = users.map((u) => u.id);
  const docs = await prisma.document.findMany({ where: { claim: { userId: { in: ids } } }, select: { fileUrl: true } });
  const pols = claimsOnly ? [] : await prisma.policy.findMany({ where: { userId: { in: ids } }, select: { fileUrl: true } });
  const keys = [...docs.map((d) => d.fileUrl), ...pols.map((p) => p.fileUrl ?? '')].filter((k) => k.startsWith('supabase/')).map((k) => k.slice(9));
  if (keys.length && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const { error } = await sb.storage.from(process.env.SUPABASE_BUCKET || 'claim-files').remove(keys);
    console.log(`[cleanup] storage: removed ${keys.length} file(s)${error ? ` (error: ${error.message})` : ''}`);
  }
  if (claimsOnly) {
    const del = await prisma.claim.deleteMany({ where: { userId: { in: ids } } });
    const n = await prisma.notification.deleteMany({ where: { userId: { in: ids }, claimId: null } });
    return console.log(`[cleanup] removed ${del.count} claim(s) (+ documents, events, queries, settlement, activity, notifications by cascade) and ${n.count} other notification(s); kept the user + policy`);
  }
  const names = users.map((u) => u.name);
  const phones = users.map((u) => u.phone).filter(Boolean) as string[];
  const logs = await prisma.activityLog.deleteMany({ where: { claimId: null, OR: [{ actorName: { in: [...names, ...phones] } }, ...phones.map((p) => ({ reason: { contains: p } }))] } });
  const del = await prisma.user.deleteMany({ where: { id: { in: ids } } });
  console.log(`[cleanup] removed ${del.count} user(s) (+ their policies, claims, documents, events, queries, notifications by cascade) and ${logs.count} user-level activity row(s)`);
}
main().finally(() => prisma.$disconnect());

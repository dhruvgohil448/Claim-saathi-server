/** node-cron follow-ups: remind customers on stuck claims, escalate after MAX_REMINDERS, simulate payouts. */
import cron from 'node-cron';
import { env } from '../config/env';
import { prisma } from '../utils/prisma';
import * as tools from '../tools';
import { inr } from '../utils/format';

export async function runFollowups() {
  const cutoff = new Date(Date.now() - env.stuckAfterMinutes * 60000);
  const stuck = await prisma.claim.findMany({
    where: { status: { in: ['CREATED', 'DOCS_PENDING', 'QUERY_RAISED'] }, lastActivityAt: { lt: cutoff } },
    include: { queries: true, documents: true },
  });
  for (const c of stuck) {
    if (c.reminderCount >= env.maxReminders) {
      await prisma.claim.update({ where: { id: c.id }, data: { aiSummary: [`${c.claimNumber}: ${c.patientName} at ${c.hospital}, ${inr(c.billAmount ?? c.estimatedAmount ?? 0)}.`, `Customer has not responded after ${c.reminderCount} reminders (status ${c.status.replace('_', ' ').toLowerCase()}).`, 'Suggest calling the customer before closing the claim.'].join('\n'), aiSuggestion: { decision: 'REQUEST_INFO', amount: null, reason: 'Customer unresponsive' }, aiConfidence: 0.6 } });
      await tools.updateClaimStatus(c.id, 'NEEDS_HUMAN', { description: `No response after ${c.reminderCount} reminders. Escalated for a call-back.`, actor: 'SYSTEM', action: 'ESCALATED', confidence: 0.6 });
      await tools.notifyOps({ title: `${c.claimNumber} is stuck`, body: `No customer response after ${c.reminderCount} reminders.`, type: 'WARNING', claimId: c.id });
      continue;
    }
    const open = c.queries.find((q) => q.status === 'OPEN');
    const body = open ? `Reminder: ${open.message}` : `Your claim ${c.claimNumber} is waiting for documents. Upload them to keep it moving.`;
    await prisma.claim.update({ where: { id: c.id }, data: { reminderCount: { increment: 1 }, lastActivityAt: new Date() } });
    await prisma.notification.create({ data: { userId: c.userId, claimId: c.id, type: 'ACTION_REQUIRED', title: `Reminder ${c.reminderCount + 1}: ${c.claimNumber} needs you`, body } });
    await tools.logActivity({ claimId: c.id, action: 'REMINDER_SENT', reason: `Claim idle for over ${Math.round(env.stuckAfterMinutes / 60)}h. Reminder ${c.reminderCount + 1} of ${env.maxReminders} sent to the customer.`, actor: 'SYSTEM', confidence: null });
  }

  // Simulated NEFT payout for claims the agent approved recently (reimbursement only).
  if (env.autoSettleAfterMinutes > 0) {
    const ready = await prisma.claim.findMany({
      where: {
        status: 'APPROVED',
        claimType: 'REIMBURSEMENT',
        lastActivityAt: { lt: new Date(Date.now() - env.autoSettleAfterMinutes * 60000), gt: new Date(Date.now() - 24 * 3600000) },
        settlement: { status: 'APPROVED' },
      },
      include: { settlement: true },
    });
    for (const c of ready) {
      const utr = `DEMOUTR${Date.now().toString().slice(-9)}`;
      await prisma.settlement.update({ where: { claimId: c.id }, data: { status: 'PAID', utr, paidAt: new Date() } });
      await tools.updateClaimStatus(c.id, 'SETTLED', { description: `${inr(c.settlement!.approvedAmount)} paid by NEFT (UTR ${utr}).`, actor: 'SYSTEM', action: 'SETTLED' });
      await prisma.notification.create({ data: { userId: c.userId, claimId: c.id, type: 'SUCCESS', title: 'Money sent to your bank', body: `${inr(c.settlement!.approvedAmount)} for ${c.claimNumber} was paid (UTR ${utr}).` } });
    }
  }
  return { reminded: stuck.length };
}

export function startFollowupJob() {
  if (!cron.validate(env.followupCron)) {
    console.warn('[followup] invalid FOLLOWUP_CRON, job disabled');
    return;
  }
  cron.schedule(env.followupCron, () => {
    runFollowups().catch((e) => console.error('[followup] failed', e));
  });
  console.log(`[followup] scheduled "${env.followupCron}" (stuck after ${env.stuckAfterMinutes} min, max ${env.maxReminders} reminders)`);
}

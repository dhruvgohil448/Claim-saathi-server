/** Amount warnings shown live in Start Claim (POST /claims/preview), on create, claim detail and home. */
import { prisma } from '../utils/prisma';
import { inr } from '../utils/format';
import { calculateSettlementRules, type BillItem } from './rules';

export type Severity = 'high' | 'medium' | 'low' | 'info';
export interface AmountWarning { code: string; severity: Severity; message: string; field?: string }
export interface AmountInput { estimatedAmount?: number | null; billAmount?: number | null; roomRentPerDay?: number | null; days?: number | null; claimType?: string | null }
type PolicyLite = { id: string; sumInsured: number; roomRentLimit: number; coPayPercent: number };

/** Sum insured already used on this policy (approved / paid settlements), excluding one claim. */
export async function usedSumInsured(policyId: string, excludeClaimId?: string) {
  const s = await prisma.settlement.aggregate({ _sum: { approvedAmount: true }, where: { status: { in: ['APPROVED', 'PAID'] }, claim: { policyId, ...(excludeClaimId ? { id: { not: excludeClaimId } } : {}) } } });
  return s._sum.approvedAmount ?? 0;
}

export function amountWarnings(p: PolicyLite, i: AmountInput, used: number): AmountWarning[] {
  const w: AmountWarning[] = [];
  const amount = i.billAmount ?? i.estimatedAmount ?? null;
  const field = i.billAmount != null ? 'billAmount' : 'estimatedAmount';
  const remaining = Math.max(0, p.sumInsured - used);
  if (amount != null && amount > p.sumInsured)
    w.push({ code: 'ABOVE_SUM_INSURED', severity: 'high', field, message: `${inr(amount)} is above your sum insured of ${inr(p.sumInsured)}. At least ${inr(amount - p.sumInsured)} will not be covered.` });
  else if (amount != null && amount > remaining)
    w.push({ code: 'ABOVE_REMAINING_SUM_INSURED', severity: 'high', field, message: `Only ${inr(remaining)} of your ${inr(p.sumInsured)} sum insured is left this year (${inr(used)} already used). About ${inr(amount - remaining)} may not be covered.` });
  if (i.roomRentPerDay != null && i.roomRentPerDay > p.roomRentLimit) {
    const pct = Math.round((p.roomRentLimit / i.roomRentPerDay) * 100);
    const extra = i.days ? ` Room alone: you pay about ${inr((i.roomRentPerDay - p.roomRentLimit) * i.days)} for ${i.days} day${i.days > 1 ? 's' : ''}.` : '';
    w.push({ code: 'ROOM_RENT_ABOVE_LIMIT', severity: 'medium', field: 'roomRentPerDay', message: `Room rent ${inr(i.roomRentPerDay)}/day is above your ${inr(p.roomRentLimit)}/day limit, so room-linked charges (nursing, doctor, OT) are paid at ${pct}%.${extra}` });
  }
  if (i.billAmount != null && i.estimatedAmount != null && i.estimatedAmount > 0 && i.billAmount > i.estimatedAmount) {
    const diff = i.billAmount - i.estimatedAmount;
    w.push({ code: 'BILL_ABOVE_ESTIMATE', severity: 'medium', field: 'billAmount', message: `Final bill ${inr(i.billAmount)} is ${inr(diff)} (${Math.round((diff / i.estimatedAmount) * 100)}%) above the estimate of ${inr(i.estimatedAmount)}. Keep the itemised bill ready.` });
  }
  if (p.coPayPercent > 0 && amount) {
    const covered = Math.min(amount, remaining, p.sumInsured);
    w.push({ code: 'CO_PAY', severity: 'info', field, message: `Your policy has ${p.coPayPercent}% co-pay: you pay about ${inr(Math.round((covered * p.coPayPercent) / 100))} of ${inr(amount)} yourself.` });
  }
  return w;
}

export async function claimWarnings(c: { id?: string; policyId: string; estimatedAmount: number | null; billAmount: number | null; roomRentPerDay: number | null; days: number | null; claimType: string }, policy?: PolicyLite | null) {
  const p = policy ?? (await prisma.policy.findUniqueOrThrow({ where: { id: c.policyId }, select: { id: true, sumInsured: true, roomRentLimit: true, coPayPercent: true } }));
  return amountWarnings(p, c, await usedSumInsured(p.id, c.id));
}

/** Preview: warnings + a rules-engine estimate for unsaved form values. */
export async function previewAmounts(p: PolicyLite & { icuLimit: number | null; startDate: Date; subLimits: unknown; waitingPeriods: unknown }, i: AmountInput & { reason?: string; treatment?: string; admissionDate?: Date; isAccident?: boolean; billItems?: BillItem[] }) {
  const used = await usedSumInsured(p.id);
  const warnings = amountWarnings(p, i, used);
  const amount = i.billAmount ?? i.estimatedAmount ?? null;
  const estimate = amount || i.billItems?.length
    ? calculateSettlementRules({ sumInsured: Math.max(0, p.sumInsured - used), roomRentLimit: p.roomRentLimit, icuLimit: p.icuLimit, coPayPercent: p.coPayPercent, startDate: p.startDate, subLimits: p.subLimits as never, waitingPeriods: p.waitingPeriods as never },
        { reason: i.reason ?? '', treatment: i.treatment, admissionDate: i.admissionDate ?? new Date(), isAccident: i.isAccident, billAmount: i.billAmount, estimatedAmount: i.estimatedAmount, billItems: i.billItems, roomRentPerDay: i.roomRentPerDay, days: i.days })
    : null;
  return { warnings, hasBlocking: warnings.some((x) => x.severity === 'high'), sumInsured: p.sumInsured, usedSumInsured: used, remainingSumInsured: Math.max(0, p.sumInsured - used), roomRentLimit: p.roomRentLimit, coPayPercent: p.coPayPercent,
    estimate: estimate ? { billAmount: estimate.billAmount, approvedAmount: estimate.approvedAmount, coPayAmount: estimate.coPayAmount, outOfPocket: Math.max(0, estimate.billAmount - estimate.approvedAmount), deductions: estimate.deductions.filter((d) => d.amount > 0) } : null };
}

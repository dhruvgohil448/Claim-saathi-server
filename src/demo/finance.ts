/**
 * Finance data for GET /api/me/finance and the chatbot's bank / money answers.
 * Bank accounts, balances and monthly expenses are FIXED DEMO VALUES served by the server (same for every user).
 * Medical spend, insurer-paid, out-of-pocket and payouts are computed from the user's own claims in the DB.
 */
import { prisma } from '../utils/prisma';
import { inr } from '../utils/format';

export const DEMO_ACCOUNTS = [
  { id: 'acc-hdfc', bankName: 'HDFC Bank', accountType: 'Savings', maskedNumber: 'XXXX4821', ifsc: 'HDFC0000123', balance: 184250.75, currency: 'INR', isPrimary: true, linkedForPayouts: true },
  { id: 'acc-sbi', bankName: 'State Bank of India', accountType: 'Salary', maskedNumber: 'XXXX1093', ifsc: 'SBIN0001234', balance: 96420.1, currency: 'INR', isPrimary: false, linkedForPayouts: false },
  { id: 'acc-paytm', bankName: 'Paytm Payments Bank', accountType: 'Wallet / Savings', maskedNumber: 'XXXX7781', ifsc: 'PYTM0123456', balance: 12380, currency: 'INR', isPrimary: false, linkedForPayouts: false },
];
const MONTH = { month: '2026-09', label: 'September 2026' };
export const DEMO_EXPENSES = [
  { category: 'Rent & housing', amount: 28000, icon: 'house' },
  { category: 'Groceries', amount: 9450, icon: 'cart' },
  { category: 'Medical & pharmacy', amount: 6820, icon: 'cross' },
  { category: 'Utilities & bills', amount: 4310, icon: 'bolt' },
  { category: 'Transport & fuel', amount: 5260, icon: 'car' },
  { category: 'Dining & food delivery', amount: 4875, icon: 'fork' },
  { category: 'Insurance premiums', amount: 2150, icon: 'shield' },
  { category: 'Shopping', amount: 6740, icon: 'bag' },
  { category: 'Entertainment & subscriptions', amount: 1899, icon: 'tv' },
];
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function financeFor(userId: string) {
  const claims = await prisma.claim.findMany({ where: { userId }, include: { settlement: true }, orderBy: { createdAt: 'desc' } });
  const paid = claims.filter((c) => c.settlement?.status === 'PAID');
  const billed = paid.reduce((s, c) => s + (c.settlement!.billAmount ?? c.billAmount ?? 0), 0);
  const insurerPaid = paid.reduce((s, c) => s + c.settlement!.approvedAmount, 0);
  const totalBalance = round2(DEMO_ACCOUNTS.reduce((s, a) => s + a.balance, 0));
  const totalExpenses = DEMO_EXPENSES.reduce((s, e) => s + e.amount, 0);
  const pending = claims.filter((c) => !['SETTLED', 'REJECTED'].includes(c.status));
  return {
    isDemo: true,
    note: 'Bank balances and monthly expenses are fixed demo values from the server. Medical figures come from your settled claims.',
    asOf: new Date().toISOString(),
    accounts: DEMO_ACCOUNTS,
    totalBalance,
    monthlyExpenses: { ...MONTH, total: totalExpenses, categories: DEMO_EXPENSES.map((e) => ({ ...e, percent: Math.round((e.amount / totalExpenses) * 1000) / 10 })) },
    medical: {
      totalMedicalSpend: billed, insurerPaid, outOfPocket: Math.max(0, billed - insurerPaid),
      insurerPaidPercent: billed ? Math.round((insurerPaid / billed) * 1000) / 10 : 0,
      settledClaims: paid.length,
      pendingClaims: pending.length,
      pendingClaimAmount: pending.reduce((s, c) => s + (c.billAmount ?? c.estimatedAmount ?? 0), 0),
      thisMonthMedicalExpense: DEMO_EXPENSES.find((e) => e.category.startsWith('Medical'))!.amount,
    },
    payouts: paid.map((c) => ({ claimId: c.id, claimNumber: c.claimNumber, hospital: c.hospital, amount: c.settlement!.approvedAmount, billAmount: c.settlement!.billAmount, utr: c.settlement!.utr, paidAt: c.settlement!.paidAt, creditedTo: `${DEMO_ACCOUNTS[0].bankName} ${DEMO_ACCOUNTS[0].maskedNumber}` })),
    totalPayouts: insurerPaid,
  };
}

export type FinanceCard =
  | { type: 'accounts'; title: string; total: number; accounts: typeof DEMO_ACCOUNTS }
  | { type: 'expenses'; title: string; total: number; month: string; categories: { category: string; amount: number; percent: number }[] }
  | { type: 'medical'; title: string; totalMedicalSpend: number; insurerPaid: number; outOfPocket: number; insurerPaidPercent: number }
  | { type: 'payouts'; title: string; total: number; payouts: { claimNumber: string; amount: number; paidAt: Date | null; utr: string | null }[] };

const RX = {
  balance: /\b(balance|balances|bank account|accounts?|how much money|savings|linked bank|my bank|total money|funds)\b/,
  expenses: /\b(expense|expenses|spend|spent|spending|budget|category|categories|monthly|month)\b/,
  medical: /\b(medical spend|medical expense|healthcare spend|hospital spend|health spend|spent on (medical|health|hospital))\b/,
  oop: /\b(out[- ]of[- ]pocket|oop|i paid|paid myself|insurer paid|insurance paid|covered vs|co-?pay paid)\b/,
  payouts: /\b(payout|payouts|received|credited|refund|reimbursed|money (i )?got|settlement amount received)\b/,
};

/** Returns a chat answer for bank / finance questions, or null if the message is not about money. */
export async function financeAnswer(userId: string, message: string) {
  const t = message.toLowerCase();
  const hit = (k: keyof typeof RX) => RX[k].test(t);
  const isMedical = hit('medical') || (hit('expenses') && /\b(medical|health|hospital|treatment)\b/.test(t));
  const kinds = [hit('balance') && 'balance', isMedical ? 'medical' : hit('expenses') && 'expenses', hit('oop') && 'oop', hit('payouts') && 'payouts'].filter(Boolean) as string[];
  // "how much will I get" / "settlement" on a claim belongs to the claim assistant
  if (!kinds.length || (/\b(claim|settlement|deduct)\b/.test(t) && !hit('balance') && !hit('payouts') && !hit('oop') && !isMedical)) return null;
  const f = await financeFor(userId);
  const parts: string[] = []; const cards: FinanceCard[] = []; const sources: string[] = [];
  if (kinds.includes('balance')) {
    parts.push(`You have ${f.accounts.length} linked accounts with a total balance of ${inr(Math.round(f.totalBalance))}: ${f.accounts.map((a) => `${a.bankName} ${a.accountType} ${a.maskedNumber} ${inr(Math.round(a.balance))}`).join('; ')}.`);
    cards.push({ type: 'accounts', title: 'Linked bank accounts', total: f.totalBalance, accounts: f.accounts }); sources.push('Linked accounts (demo)');
  }
  if (kinds.includes('expenses')) {
    const top = [...f.monthlyExpenses.categories].sort((a, b) => b.amount - a.amount).slice(0, 3);
    parts.push(`In ${f.monthlyExpenses.label} you spent ${inr(f.monthlyExpenses.total)}. Biggest categories: ${top.map((c) => `${c.category} ${inr(c.amount)}`).join(', ')}.`);
    cards.push({ type: 'expenses', title: `Expenses · ${f.monthlyExpenses.label}`, total: f.monthlyExpenses.total, month: f.monthlyExpenses.month, categories: f.monthlyExpenses.categories }); sources.push('Monthly expenses (demo)');
  }
  if (kinds.includes('medical') || kinds.includes('oop')) {
    const m = f.medical;
    parts.push(m.settledClaims
      ? `Across ${m.settledClaims} settled claim${m.settledClaims > 1 ? 's' : ''} your hospital bills were ${inr(m.totalMedicalSpend)}. The insurer paid ${inr(m.insurerPaid)} (${m.insurerPaidPercent}%) and you paid ${inr(m.outOfPocket)} out of pocket.${kinds.includes('medical') ? ` This month you also spent ${inr(m.thisMonthMedicalExpense)} on medical & pharmacy.` : ''}`
      : `You have no settled claims yet, so nothing has been paid by the insurer. This month you spent ${inr(m.thisMonthMedicalExpense)} on medical & pharmacy.`);
    cards.push({ type: 'medical', title: 'Medical spend', totalMedicalSpend: m.totalMedicalSpend, insurerPaid: m.insurerPaid, outOfPocket: m.outOfPocket, insurerPaidPercent: m.insurerPaidPercent }); sources.push('Settled claims');
  }
  if (kinds.includes('payouts')) {
    parts.push(f.payouts.length ? `You received ${inr(f.totalPayouts)} in claim payouts: ${f.payouts.map((p) => `${p.claimNumber} ${inr(p.amount)}${p.paidAt ? ` on ${new Date(p.paidAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}` : ''}${p.utr ? ` (UTR ${p.utr})` : ''}`).join('; ')}.` : 'No claim payouts have been received yet.');
    cards.push({ type: 'payouts', title: 'Claim payouts received', total: f.totalPayouts, payouts: f.payouts.map((p) => ({ claimNumber: p.claimNumber, amount: p.amount, paidAt: p.paidAt, utr: p.utr })) }); sources.push('Settlements');
  }
  const intent = kinds.length > 1 ? 'FINANCE' : ({ balance: 'FINANCE_BALANCE', expenses: 'FINANCE_EXPENSES', medical: 'FINANCE_MEDICAL', oop: 'FINANCE_OUT_OF_POCKET', payouts: 'FINANCE_PAYOUTS' } as Record<string, string>)[kinds[0]];
  const next = ['What is my total balance?', 'Show my monthly expenses', 'How much did I spend on medical?', 'Out-of-pocket vs insurer paid', 'Which claim payouts did I receive?'];
  const asked = { balance: 0, expenses: 1, medical: 2, oop: 3, payouts: 4 } as Record<string, number>;
  const followUps = next.filter((_, i) => !kinds.some((k) => asked[k] === i)).slice(0, 3);
  return { answer: parts.join(' '), intent, sources, followUps, cards, isDemoFinance: true };
}

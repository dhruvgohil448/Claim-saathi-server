/** ₹ formatting with Indian digit grouping: 275000 -> ₹2,75,000 */
export function inr(n: number): string {
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString('en-IN');
  return `${v < 0 ? '-' : ''}₹${s}`;
}

export const DOC_LABELS: Record<string, string> = {
  HEALTH_CARD: 'Health e-card',
  POLICY_SCHEDULE: 'Policy schedule',
  CLAIM_FORM: 'Claim form',
  PREAUTH_FORM: 'Pre-auth request',
  DOCTOR_ESTIMATE: "Doctor's estimate letter",
  DISCHARGE_SUMMARY: 'Discharge summary',
  HOSPITAL_BILL: 'Final hospital bill',
  PHARMACY_BILL: 'Pharmacy bill',
  LAB_REPORT: 'Lab report',
  PRESCRIPTION: 'Prescription',
  PAYMENT_RECEIPT: 'Payment receipt',
  ID_PROOF: 'ID proof',
  OTHER: 'Other document',
};
export const docLabel = (t: string) => DOC_LABELS[t] || t;

export function monthsBetween(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0);
}
export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}
export const fmtDate = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

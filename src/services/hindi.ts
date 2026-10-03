/** Deterministic Hindi replies for Voice Saathi (used when Sarvam translation is not configured or fails). */
import { prisma } from '../utils/prisma';
import { inr, docLabel } from '../utils/format';
import { prediction } from './copilot';
import { DEMO_ALL, isDemoPackClaim } from '../demo/demoDocs';

const STATUS_HI: Record<string, string> = {
  CREATED: 'जमा हो गया है और जाँच चल रही है', PREAUTH_SUBMITTED: 'प्री-ऑथराइज़ेशन का इंतज़ार कर रहा है', DOCS_PENDING: 'दस्तावेज़ों का इंतज़ार कर रहा है', UNDER_REVIEW: 'समीक्षा में है',
  QUERY_RAISED: 'बीमा कंपनी के सवाल के जवाब का इंतज़ार कर रहा है', NEEDS_HUMAN: 'क्लेम विशेषज्ञ के पास है', APPROVED: 'मंज़ूर हो गया है', REJECTED: 'मंज़ूर नहीं हुआ', SETTLED: 'सेटल हो गया है और पैसा आपके खाते में भेज दिया गया है',
};
const DOC_HI: Record<string, string> = { HEALTH_CARD: 'हेल्थ कार्ड', ID_PROOF: 'आईडी प्रूफ', CLAIM_FORM: 'क्लेम फॉर्म', HOSPITAL_BILL: 'हॉस्पिटल बिल', DISCHARGE_SUMMARY: 'डिस्चार्ज समरी', LAB_REPORT: 'लैब रिपोर्ट', PAYMENT_RECEIPT: 'पेमेंट रसीद' };

export const HI_SUGGESTIONS = ['मेरा क्लेम कहाँ है?', 'मुझे कितना पैसा मिलेगा?', 'कौन से दस्तावेज़ बाकी हैं?', 'पैसे क्यों कटे?'];
export const isDevanagari = (s: string) => /[\u0900-\u097F]/.test(s);

type Intent = 'PAYOUT' | 'STATUS' | 'DOCS' | 'DEDUCTIONS' | 'POLICY' | 'OTHER';
export function intentOf(msg: string): Intent {
  const t = msg.toLowerCase();
  if (/कटौती|कट|क्यों|deduct|cut|kat|kyu|why/.test(t)) return 'DEDUCTIONS';
  if (/कितना|कितने|मिलेगा|मिलेंगे|पैसा|पैसे|रकम|how much|payout|amount|kitna|milega|paisa/.test(t)) return 'PAYOUT';
  if (/दस्तावेज़|दस्तावेज|डॉक्यूमेंट|डाक्यूमेंट|बाकी|pending|document|missing|upload/.test(t)) return 'DOCS';
  if (/पॉलिसी|कवर|policy|cover/.test(t)) return 'POLICY';
  if (/कहाँ|कहां|कब|स्टेटस|स्थिति|क्लेम|where|status|kab|kahan|track/.test(t)) return 'STATUS';
  return 'OTHER';
}
/** English question for the grounded chat engine when the user speaks Hindi. */
export const englishQuestion = (i: Intent, original: string) =>
  ({ PAYOUT: 'How much will I get?', STATUS: 'Where is my claim?', DOCS: 'Which documents are still pending?', DEDUCTIONS: 'Explain the deductions', POLICY: 'What is not covered?', OTHER: original })[i];

export async function hindiAnswer(userId: string, message: string, claimId?: string) {
  const claim = claimId
    ? await prisma.claim.findFirst({ where: { OR: [{ id: claimId }, { claimNumber: claimId }] }, include: { documents: true } })
    : await prisma.claim.findFirst({ where: { userId }, orderBy: { lastActivityAt: 'desc' }, include: { documents: true } });
  if (!claim) return 'अभी आपके खाते में कोई क्लेम नहीं है। "Start Claim" दबाकर नया क्लेम शुरू करें, मैं हर कदम पर मदद करूँगा।';
  const i = intentOf(message);
  const p = await prediction(claim.id);
  const missing = (isDemoPackClaim(claim) ? DEMO_ALL : []).filter((t) => !claim.documents.some((d) => d.type === t && d.status !== 'INVALID'));
  switch (i) {
    case 'PAYOUT':
      return `${p.headlineHi}। ${p.deductions.map((d) => d.reasonHi).join(' ')}`;
    case 'DEDUCTIONS':
      return `कुल ${inr(p.totalDeductions)} की कटौती: ${p.deductions.map((d) => d.reasonHi).join(' ')} बाकी ${inr(p.predictedPayout)} आपको मिलेंगे।`;
    case 'DOCS':
      return missing.length ? `${missing.length} दस्तावेज़ बाकी हैं: ${missing.map((t) => DOC_HI[t] ?? docLabel(t)).join(', ')}। इन्हें अपलोड करते ही साथी तुरंत जाँच करेगा।` : 'आपके सभी ज़रूरी दस्तावेज़ अपलोड और सत्यापित हो चुके हैं।';
    case 'POLICY':
      return 'आपकी पॉलिसी में ₹5,00,000 का कवर है, 10% को-पे लागू है और कमरे का किराया ₹4,000 प्रतिदिन तक मिलता है। रजिस्ट्रेशन, एडमिशन और नॉन-मेडिकल आइटम कवर नहीं होते।';
    case 'STATUS':
    default:
      return `आपका क्लेम ${claim.claimNumber} (${claim.hospital}) अभी ${STATUS_HI[claim.status] ?? 'प्रोसेस हो रहा है'}।${missing.length && !['APPROVED', 'SETTLED', 'REJECTED'].includes(claim.status) ? ` अगला कदम: ${missing.map((t) => DOC_HI[t] ?? docLabel(t)).join(', ')} अपलोड करें।` : ''} ${claim.status === 'SETTLED' ? '' : `साथी का अनुमान: लगभग ${inr(p.predictedPayout)} मिलेंगे।`}`.trim();
  }
}

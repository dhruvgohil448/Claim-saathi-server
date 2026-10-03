/**
 * Mobile-app view models. Everything here is derived from DB rows (policy fields / extracted policy text,
 * claim, documents, events, queries, settlement), never from fixed demo strings.
 */
import { Policy, Prisma } from '@prisma/client';
import { env, llmEnabled } from '../config/env';
import { docProgress } from '../tools';
import { requiredDocTypes } from './rules';
import { docLabel, fmtDate, inr } from '../utils/format';
import type { DocValidation } from './ai.service';

const asArr = <T>(v: Prisma.JsonValue | null | undefined): T[] => (Array.isArray(v) ? (v as unknown as T[]) : []);
const asObj = <T>(v: Prisma.JsonValue | null | undefined): T | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as unknown as T) : null);
const human = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const addMonths = (d: Date, m: number) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };

/** Bullet lines under a heading in the policy text, e.g. "Exclusions" / "Conditions". */
function section(raw: string | null | undefined, heading: RegExp): string[] {
  if (!raw) return [];
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l) => heading.test(l) && l.length < 80);
  if (i < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (/^[A-Z][A-Za-z &/-]{2,40}:?$/.test(l) && !/^[-•*\d]/.test(l) && out.length) break; // next heading
    const t = l.replace(/^[-•*\d.)\s]+/, '').trim();
    if (t.length > 3) out.push(t);
    if (out.length >= 15) break;
  }
  return out;
}

// ---------------- Policy Reader ----------------
export function analyzePolicy(p: Policy) {
  const now = new Date();
  const waiting = asArr<{ name: string; months: number }>(p.waitingPeriods).map((w) => {
    const eligibleFrom = addMonths(p.startDate, w.months);
    return { name: w.name, months: w.months, eligibleFrom, active: eligibleFrom > now, status: eligibleFrom > now ? `Waiting until ${fmtDate(eligibleFrom)}` : 'Waiting period over' };
  });
  const subLimits = asObj<Record<string, number>>(p.subLimits) ?? {};
  const network = asArr<string>(p.networkHospitals);
  const members = asArr<{ name: string; relation?: string }>(p.members);
  const stored = asArr<string>(p.exclusions);
  const fromText = section(p.rawText, /exclusion|not covered|what is not/i);
  const exclusions = [...new Set([...stored, ...fromText])];
  const textConditions = section(p.rawText, /conditions|terms|important/i);

  const coverage = [
    { item: 'Hospitalisation (in-patient)', covered: true, limit: p.sumInsured, detail: `Up to ${inr(p.sumInsured)} per policy year` },
    { item: 'Room rent', covered: true, limit: p.roomRentLimit, detail: `Up to ${inr(p.roomRentLimit)} per day` },
    ...(p.icuLimit ? [{ item: 'ICU', covered: true, limit: p.icuLimit, detail: `Up to ${inr(p.icuLimit)} per day` }] : []),
    ...Object.entries(subLimits).filter(([, v]) => typeof v === 'number').map(([k, v]) => ({ item: human(k), covered: true, limit: v, detail: `Sub-limit ${inr(v)}` })),
    ...(network.length ? [{ item: 'Cashless at network hospitals', covered: true, limit: null, detail: `${network.length} network hospital${network.length > 1 ? 's' : ''} listed: ${network.slice(0, 3).join(', ')}${network.length > 3 ? '…' : ''}` }] : []),
  ];
  const conditions = [
    p.coPayPercent ? `Co-pay ${p.coPayPercent}%: you pay ${p.coPayPercent}% of every admissible claim (e.g. ${inr(Math.round(50000 * p.coPayPercent / 100))} on ${inr(50000)}).` : 'No co-pay: the insurer pays the full admissible amount.',
    `Room rent above ${inr(p.roomRentLimit)}/day leads to a proportionate cut on room-linked charges (nursing, doctor, OT).`,
    ...waiting.map((w) => `${w.name}: ${w.months}-month waiting period from ${fmtDate(p.startDate)} (${w.active ? `covered from ${fmtDate(w.eligibleFrom)}` : 'now covered'}).`),
    ...(p.endDate ? [`Cover valid ${fmtDate(p.startDate)} to ${fmtDate(p.endDate)}${p.endDate < now ? ' (expired)' : ''}.`] : []),
    ...textConditions,
  ];
  const activeWaits = waiting.filter((w) => w.active);
  const whatIsCovered = [
    `Your ${p.insurer}${p.planName ? ` ${p.planName}` : ''} policy (${p.policyNumber}) pays hospital bills up to ${inr(p.sumInsured)} a year${members.length ? ` for ${members.map((m) => m.name).join(', ')}` : ''}.`,
    `Room rent is covered up to ${inr(p.roomRentLimit)} per day${p.icuLimit ? ` and ICU up to ${inr(p.icuLimit)} per day` : ''}.`,
    p.coPayPercent ? `You pay ${p.coPayPercent}% of each claim yourself.` : 'There is no co-pay.',
    activeWaits.length ? `Not yet covered (waiting period): ${activeWaits.map((w) => `${w.name.toLowerCase()} until ${fmtDate(w.eligibleFrom)}`).join('; ')}.` : waiting.length ? 'All waiting periods are over.' : '',
    exclusions.length ? `Never covered: ${exclusions.slice(0, 3).join('; ').toLowerCase()}${exclusions.length > 3 ? ` and ${exclusions.length - 3} more` : ''}.` : '',
  ].filter(Boolean).join(' ');
  return {
    policyId: p.id, policyNumber: p.policyNumber, insurer: p.insurer, planName: p.planName,
    sumInsured: p.sumInsured, roomRentLimit: p.roomRentLimit, icuLimit: p.icuLimit, coPayPercent: p.coPayPercent,
    startDate: p.startDate, endDate: p.endDate, isActive: p.startDate <= now && (!p.endDate || p.endDate >= now),
    members, coverage, exclusions, conditions, waitingPeriods: waiting, whatIsCovered,
    source: p.rawText ? 'policy-document' : 'policy-details', ai: llmEnabled() ? env.aiProvider : 'mock', analyzedAt: new Date().toISOString(),
  };
}
export type PolicyAnalysis = ReturnType<typeof analyzePolicy>;

// ---------------- Checklist ----------------
type DocLite = { id: string; type: string; status: string; fileName?: string; validationResult?: Prisma.JsonValue | null; createdAt?: Date };
type ClaimLite = { id: string; status: string; claimType: 'CASHLESS' | 'REIMBURSEMENT'; documents: DocLite[] };
const appStatus = (s?: string) => (!s ? 'missing' : s === 'VERIFIED' ? 'verified' : s === 'UPLOADED' ? 'uploaded' : 'rejected');

export function appChecklist(c: ClaimLite) {
  const prog = docProgress(c);
  // Reimbursement payouts also need proof of payment once the final bill is in.
  const extra = c.claimType === 'REIMBURSEMENT' && prog.stage === 'FINAL' ? ['PAYMENT_RECEIPT'] : [];
  const types = [...prog.required, ...extra.filter((t) => !prog.required.includes(t))];
  const latest = new Map<string, DocLite>();
  for (const d of c.documents) latest.set(d.type, d);
  const items = types.map((t) => {
    const d = latest.get(t);
    const v = asObj<DocValidation>(d?.validationResult ?? null);
    return {
      type: t, label: docLabel(t), required: prog.required.includes(t), status: appStatus(d?.status), rawStatus: d?.status ?? null,
      documentId: d?.id ?? null, fileName: d?.fileName ?? null, confidence: v?.confidence ?? null,
      reason: d && d.status !== 'VERIFIED' ? v?.issues?.[0]?.message ?? null : null, fix: d && d.status !== 'VERIFIED' ? v?.fix ?? null : null,
    };
  });
  for (const d of c.documents) if (!types.includes(d.type) && latest.get(d.type) === d) items.push({ type: d.type, label: docLabel(d.type), required: false, status: appStatus(d.status), rawStatus: d.status, documentId: d.id, fileName: d.fileName ?? null, confidence: asObj<DocValidation>(d.validationResult ?? null)?.confidence ?? null, reason: null, fix: null });
  const warnings = [
    ...items.filter((i) => i.status === 'missing').map((i) => `${i.label} required`),
    ...items.filter((i) => i.status === 'rejected').map((i) => `${i.label} rejected${i.reason ? `: ${i.reason}` : ''}`),
  ];
  const req = items.filter((i) => i.required);
  return {
    claimId: c.id, claimType: c.claimType, stage: prog.stage, items, warnings,
    progress: { required: req.length, verified: req.filter((i) => i.status === 'verified').length, uploaded: req.filter((i) => i.status !== 'missing').length },
    complete: req.every((i) => i.status === 'verified'),
  };
}

// ---------------- Per-upload checks ----------------
const MONEY_DOCS = ['HOSPITAL_BILL', 'PHARMACY_BILL', 'PAYMENT_RECEIPT', 'DOCTOR_ESTIMATE', 'PREAUTH_FORM'];
export function uploadChecks(docType: string, status: string, v: DocValidation, checklist: ReturnType<typeof appChecklist>) {
  const needsAmount = MONEY_DOCS.includes(docType);
  const fields = { patientName: !!v.extracted.name, date: !!v.extracted.date, amount: needsAmount ? v.extracted.amount != null : null, signatureOrStamp: v.checks.hasSignature };
  const missingFields = Object.entries(fields).filter(([, ok]) => ok === false).map(([k]) => human(k).toLowerCase());
  const checks = [
    { key: 'documentDetected', label: 'Document detected', passed: v.checks.readable && v.checks.typeMatches, detail: v.checks.readable ? `Looks like a ${docLabel(v.detectedType).toLowerCase()}` : 'Could not read the file' },
    { key: 'patientNameMatched', label: 'Patient name matched', passed: v.checks.nameMatches, detail: v.extracted.name ? `Found "${v.extracted.name}"` : 'No patient name found' },
    { key: 'amountDetected', label: 'Amount detected', passed: needsAmount ? v.extracted.amount != null : null, detail: v.extracted.amount != null ? inr(v.extracted.amount) : needsAmount ? 'No total amount found' : 'Not needed for this document' },
    { key: 'dateValid', label: 'Date within policy period', passed: v.checks.dateInPolicyPeriod, detail: v.extracted.date ?? 'No date found' },
    { key: 'requiredFieldsPresent', label: 'Required fields present', passed: missingFields.length === 0, detail: missingFields.length ? `Missing: ${missingFields.join(', ')}` : 'All required fields found' },
  ];
  return {
    status, appStatus: appStatus(status), confidence: v.confidence, summary: v.summary, fix: v.fix, checks,
    issues: v.issues, warnings: [...v.issues.map((i) => i.message), ...checklist.warnings], extracted: v.extracted,
  };
}

// ---------------- Stepper ----------------
type Ev = { status: string; title: string; description: string | null; actor: string; createdAt: Date };
export function stepper(c: ClaimLite & { createdAt: Date }, events: Ev[], settlement: { status: string; approvedAmount: number; paidAt: Date | null } | null, openQueries: { message: string; createdAt: Date }[]) {
  const ck = appChecklist(c);
  const req = ck.items.filter((i) => i.required);
  const firstAt = (pred: (e: Ev) => boolean) => events.find(pred)?.createdAt ?? null;
  const s = c.status;
  const decided = ['APPROVED', 'SETTLED', 'REJECTED'].includes(s);
  const docsSubmitted = req.length > 0 && req.every((i) => i.status !== 'missing');
  const docsVerified = ck.complete || decided;
  const steps = [
    { key: 'CREATED', label: 'Created', done: true, at: c.createdAt, note: null as string | null },
    { key: 'DOCS_SUBMITTED', label: 'Docs Submitted', done: docsSubmitted || decided, at: null, note: `${ck.progress.uploaded}/${ck.progress.required} required uploaded` },
    { key: 'DOCS_VERIFIED', label: 'Docs Verified', done: docsVerified, at: firstAt((e) => e.status === 'UNDER_REVIEW'), note: `${ck.progress.verified}/${ck.progress.required} verified` },
    { key: 'UNDER_REVIEW', label: 'Under Review', done: decided, at: firstAt((e) => ['UNDER_REVIEW', 'NEEDS_HUMAN', 'PREAUTH_SUBMITTED'].includes(e.status)), note: s === 'NEEDS_HUMAN' ? 'With a claims specialist' : null },
    { key: 'APPROVED', label: s === 'REJECTED' ? 'Rejected' : 'Approved', done: decided, at: firstAt((e) => ['APPROVED', 'REJECTED'].includes(e.status)), note: s === 'REJECTED' ? events.filter((e) => e.status === 'REJECTED').pop()?.description ?? null : null },
    { key: 'SETTLEMENT', label: 'Settlement', done: s === 'SETTLED', at: settlement?.paidAt ?? null, note: settlement ? `${inr(settlement.approvedAmount)} · ${settlement.status.toLowerCase()}` : null },
  ];
  const cur = s === 'REJECTED' ? -1 : steps.findIndex((x) => !x.done);
  const out = steps.map((x, i) => ({ ...x, state: x.done ? 'done' : i === cur ? 'current' : 'pending', ...(x.key === 'APPROVED' && s === 'REJECTED' ? { state: 'failed' } : {}) }));
  const human = [...events].reverse().find((e) => e.actor === 'HUMAN');
  const last = events[events.length - 1];
  const latestOpsUpdate = openQueries[0]
    ? { kind: 'QUERY', message: openQueries[0].message, at: openQueries[0].createdAt }
    : human ? { kind: 'OPS', message: human.description ?? human.title, at: human.createdAt }
    : last ? { kind: last.actor === 'AI' ? 'AI' : 'SYSTEM', message: last.description ?? last.title, at: last.createdAt } : null;
  return { steps: out, currentStep: cur >= 0 ? out[cur].key : null, latestOpsUpdate, checklistWarnings: ck.warnings };
}

// ---------------- Summary PDF (no dependencies) ----------------
const pdfSafe = (s: string) => s.replace(/₹/g, 'Rs. ').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E]/g, '').replace(/([\\()])/g, '\\$1');
function wrap(s: string, n = 92) {
  const out: string[] = [];
  for (const para of s.split('\n')) {
    let line = '';
    for (const w of para.split(' ')) {
      if ((line + ' ' + w).trim().length > n) { out.push(line); line = w; } else line = (line + ' ' + w).trim();
    }
    out.push(line);
  }
  return out;
}
export function buildPdf(blocks: { text: string; size?: number; bold?: boolean; gap?: number }[]) {
  const pages: string[] = [];
  let ops = '';
  let y = 800;
  const flush = () => { pages.push(ops); ops = ''; y = 800; };
  for (const b of blocks) {
    const size = b.size ?? 10;
    y -= b.gap ?? 0;
    for (const l of wrap(b.text, Math.floor(92 * 10 / size))) {
      if (y < 50) flush();
      ops += `BT /${b.bold ? 'F2' : 'F1'} ${size} Tf 45 ${y} Td (${pdfSafe(l)}) Tj ET\n`;
      y -= size + 5;
    }
  }
  flush();
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  pages.forEach((c, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${6 + i * 2} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`);
    objs.push(`<< /Length ${Buffer.byteLength(c)} >>\nstream\n${c}endstream`);
  });
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
export { requiredDocTypes };

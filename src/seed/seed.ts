/** Wipes and re-creates all demo data. Used by `npm run seed` and POST /api/admin/reset-demo. */
import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient } from '@prisma/client';
import { buildSeedData } from './data';

type J = Prisma.InputJsonValue;

export async function runSeed(prisma: PrismaClient) {
  const data = await buildSeedData();
  const now = Date.now();
  const at = (ago: number) => new Date(now - ago * 1000);
  const hash = await bcrypt.hash('demo123', 10);

  await prisma.$transaction(
    async (tx) => {
      await tx.notification.deleteMany();
      await tx.activityLog.deleteMany();
      await tx.settlement.deleteMany();
      await tx.query.deleteMany();
      await tx.claimEvent.deleteMany();
      await tx.document.deleteMany();
      await tx.claim.deleteMany();
      await tx.policy.deleteMany();
      await tx.user.deleteMany();

      await tx.user.createMany({ data: data.users.map((u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, city: u.city, passwordHash: hash, createdAt: at(u.ago), updatedAt: at(u.ago) })) });
      await tx.policy.createMany({
        data: data.policies.map((p) => ({
          id: p.id,
          userId: p.userId,
          insurer: p.extraction.insurer,
          planName: p.extraction.planName,
          policyNumber: p.policyNumber,
          sumInsured: p.extraction.sumInsured,
          roomRentLimit: p.extraction.roomRentLimit,
          icuLimit: p.extraction.icuLimit,
          coPayPercent: p.extraction.coPayPercent,
          startDate: p.startDate,
          endDate: p.endDate,
          waitingPeriods: p.extraction.waitingPeriods as J,
          subLimits: p.extraction.subLimits as J,
          exclusions: p.extraction.exclusions as J,
          networkHospitals: p.extraction.networkHospitals as J,
          summary: p.extraction.summaryEnglish,
          summaryHindi: p.extraction.summaryHindi,
          fileUrl: p.fileUrl,
          rawText: p.rawText,
          createdAt: at(p.ago),
          updatedAt: at(p.ago),
        })),
      });
      await tx.claim.createMany({
        data: data.claims.map((c) => ({
          id: c.id,
          claimNumber: c.claimNumber,
          userId: c.userId,
          policyId: c.policyId,
          patientName: c.patientName,
          hospital: c.hospital,
          hospitalCity: c.hospitalCity,
          reason: c.reason,
          treatment: c.treatment,
          claimType: c.claimType,
          admissionType: c.admissionType,
          isAccident: c.isAccident,
          admissionDate: c.admissionDate,
          dischargeDate: c.dischargeDate,
          roomType: c.roomType,
          roomRentPerDay: c.roomRentPerDay,
          days: c.days,
          estimatedAmount: c.estimatedAmount,
          billAmount: c.billAmount,
          billItems: c.billItems ? (c.billItems as unknown as J) : Prisma.DbNull,
          status: c.status as never,
          aiSummary: c.aiSummary,
          aiSuggestion: c.aiSuggestion ? (c.aiSuggestion as J) : Prisma.DbNull,
          aiConfidence: c.aiConfidence,
          riskLevel: c.riskLevel,
          riskFlags: c.riskFlags as J,
          reminderCount: c.reminderCount,
          isDemo: true,
          lastActivityAt: at(c.lastActivityAgo),
          createdAt: at(c.ago),
          updatedAt: at(c.lastActivityAgo),
        })),
      });
      await tx.document.createMany({
        data: data.documents.map((d) => ({
          id: d.id,
          claimId: d.claimId,
          type: d.type as never,
          fileName: d.fileName,
          fileUrl: d.fileUrl,
          mimeType: d.mimeType,
          size: d.size,
          status: d.status as never,
          confidence: d.confidence,
          validationResult: d.validation as unknown as J,
          extractedData: d.validation.extracted as unknown as J,
          createdAt: at(d.ago),
          updatedAt: at(d.ago),
        })),
      });
      await tx.claimEvent.createMany({ data: data.events.map((e) => ({ id: e.id, claimId: e.claimId, status: e.status as never, title: e.title, description: e.description, actor: e.actor, createdAt: at(e.ago) })) });
      await tx.query.createMany({
        data: data.queries.map((q) => ({ id: q.id, claimId: q.claimId, message: q.message, requestedDocType: q.requestedDocType as never, response: q.response, status: q.status, createdBy: q.createdBy, respondedAt: q.respondedAgo != null ? at(q.respondedAgo) : null, closedAt: q.closedAgo != null ? at(q.closedAgo) : null, createdAt: at(q.ago), updatedAt: at(Math.min(q.ago, q.closedAgo ?? q.ago, q.respondedAgo ?? q.ago)) })),
      });
      await tx.settlement.createMany({
        data: data.settlements.map((s) => ({ id: s.id, claimId: s.claimId, billAmount: s.result.billAmount, deductions: s.result.deductions as unknown as J, coPayAmount: s.result.coPayAmount, approvedAmount: s.result.approvedAmount, explanation: s.result.explanation, status: s.status, utr: s.utr, paidAt: s.paidAgo != null ? at(s.paidAgo) : null, createdAt: at(s.ago), updatedAt: at(s.paidAgo ?? s.ago) })),
      });
      await tx.activityLog.createMany({ data: data.logs.map((l) => ({ id: l.id, claimId: l.claimId, actor: l.actor, actorName: l.actorName, action: l.action, reason: l.reason, confidence: l.confidence, createdAt: at(l.ago) })) });
      await tx.notification.createMany({ data: data.notifications.map((n) => ({ id: n.id, userId: n.userId, claimId: n.claimId, type: n.type, title: n.title, body: n.body, read: n.read, createdAt: at(n.ago) })) });
    },
    { timeout: 60000, maxWait: 20000 },
  );

  return { users: data.users.length, policies: data.policies.length, claims: data.claims.length, documents: data.documents.length, events: data.events.length, queries: data.queries.length, settlements: data.settlements.length, activityLogs: data.logs.length, notifications: data.notifications.length };
}

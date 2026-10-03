-- Claim Saathi: full schema for Supabase Postgres (generated from prisma/schema.prisma by npm run gen:sql)
-- Prisma default naming: tables and enums use the model names.
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'OPS', 'ADMIN');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('CREATED', 'PREAUTH_SUBMITTED', 'DOCS_PENDING', 'UNDER_REVIEW', 'QUERY_RAISED', 'NEEDS_HUMAN', 'APPROVED', 'REJECTED', 'SETTLED');

-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('CASHLESS', 'REIMBURSEMENT');

-- CreateEnum
CREATE TYPE "AdmissionType" AS ENUM ('PLANNED', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('HEALTH_CARD', 'POLICY_SCHEDULE', 'CLAIM_FORM', 'PREAUTH_FORM', 'DOCTOR_ESTIMATE', 'DISCHARGE_SUMMARY', 'HOSPITAL_BILL', 'PHARMACY_BILL', 'LAB_REPORT', 'PRESCRIPTION', 'PAYMENT_RECEIPT', 'ID_PROOF', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'VERIFIED', 'NEEDS_REVIEW', 'INVALID');

-- CreateEnum
CREATE TYPE "QueryStatus" AS ENUM ('OPEN', 'ANSWERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('AI', 'HUMAN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('ESTIMATED', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'ACTION_REQUIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
    "city" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "insurer" TEXT NOT NULL,
    "planName" TEXT,
    "policyNumber" TEXT NOT NULL,
    "sumInsured" INTEGER NOT NULL,
    "roomRentLimit" INTEGER NOT NULL,
    "icuLimit" INTEGER,
    "coPayPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "waitingPeriods" JSONB NOT NULL,
    "subLimits" JSONB,
    "exclusions" JSONB NOT NULL,
    "networkHospitals" JSONB,
    "summary" TEXT,
    "summaryHindi" TEXT,
    "fileUrl" TEXT,
    "rawText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "claimNumber" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "patientName" TEXT NOT NULL,
    "hospital" TEXT NOT NULL,
    "hospitalCity" TEXT,
    "isNetworkHospital" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "treatment" TEXT,
    "claimType" "ClaimType" NOT NULL DEFAULT 'REIMBURSEMENT',
    "admissionType" "AdmissionType" NOT NULL DEFAULT 'EMERGENCY',
    "isAccident" BOOLEAN NOT NULL DEFAULT false,
    "admissionDate" TIMESTAMP(3),
    "dischargeDate" TIMESTAMP(3),
    "roomType" TEXT,
    "roomRentPerDay" INTEGER,
    "days" INTEGER,
    "estimatedAmount" INTEGER,
    "billAmount" INTEGER,
    "billItems" JSONB,
    "status" "ClaimStatus" NOT NULL DEFAULT 'CREATED',
    "aiSummary" TEXT,
    "aiSuggestion" JSONB,
    "aiConfidence" DOUBLE PRECISION,
    "riskLevel" TEXT,
    "riskFlags" JSONB,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "mimeType" TEXT,
    "size" INTEGER,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "confidence" DOUBLE PRECISION,
    "validationResult" JSONB,
    "extractedData" JSONB,
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimEvent" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "actor" "ActorType" NOT NULL DEFAULT 'SYSTEM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Query" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "requestedDocType" "DocumentType",
    "response" TEXT,
    "status" "QueryStatus" NOT NULL DEFAULT 'OPEN',
    "createdBy" "ActorType" NOT NULL DEFAULT 'AI',
    "respondedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Query_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "billAmount" INTEGER NOT NULL,
    "deductions" JSONB NOT NULL,
    "coPayAmount" INTEGER NOT NULL DEFAULT 0,
    "approvedAmount" INTEGER NOT NULL,
    "explanation" TEXT,
    "status" "SettlementStatus" NOT NULL DEFAULT 'ESTIMATED',
    "utr" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "claimId" TEXT,
    "actor" "ActorType" NOT NULL DEFAULT 'AI',
    "actorName" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "claimId" TEXT,
    "type" "NotificationType" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_policyNumber_key" ON "Policy"("policyNumber");

-- CreateIndex
CREATE INDEX "Policy_userId_idx" ON "Policy"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_claimNumber_key" ON "Claim"("claimNumber");

-- CreateIndex
CREATE INDEX "Claim_status_idx" ON "Claim"("status");

-- CreateIndex
CREATE INDEX "Claim_userId_idx" ON "Claim"("userId");

-- CreateIndex
CREATE INDEX "Document_claimId_idx" ON "Document"("claimId");

-- CreateIndex
CREATE INDEX "Document_status_idx" ON "Document"("status");

-- CreateIndex
CREATE INDEX "ClaimEvent_claimId_idx" ON "ClaimEvent"("claimId");

-- CreateIndex
CREATE INDEX "Query_claimId_idx" ON "Query"("claimId");

-- CreateIndex
CREATE INDEX "Query_status_idx" ON "Query"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_claimId_key" ON "Settlement"("claimId");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_claimId_idx" ON "ActivityLog"("claimId");

-- CreateIndex
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimEvent" ADD CONSTRAINT "ClaimEvent_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Query" ADD CONSTRAINT "Query_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security: ON for every table with NO public policies.
-- The API connects with the database role / service key, so the anon & authenticated keys cannot read anything.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Claim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClaimEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Query" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Settlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ActivityLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;

-- Mobile app profile fields (added for OTP onboarding / bank / push)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "dob" TIMESTAMP(3), ADD COLUMN IF NOT EXISTS "gender" TEXT, ADD COLUMN IF NOT EXISTS "pushToken" TEXT, ADD COLUMN IF NOT EXISTS "pushPlatform" TEXT, ADD COLUMN IF NOT EXISTS "bankAccount" JSONB, ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "Policy" ADD COLUMN IF NOT EXISTS "members" JSONB;
ALTER TABLE "Policy" ADD COLUMN IF NOT EXISTS "analysis" JSONB, ADD COLUMN IF NOT EXISTS "analyzedAt" TIMESTAMP(3);
ALTER TABLE "Claim" ADD COLUMN IF NOT EXISTS "patientDetails" JSONB;

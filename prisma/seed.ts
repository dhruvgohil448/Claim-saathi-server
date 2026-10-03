import { PrismaClient } from '@prisma/client';
import { runSeed } from '../src/seed/seed';

const prisma = new PrismaClient();
runSeed(prisma)
  .then((r) => console.log('Seeded Claim Saathi demo data:', r))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

import { env } from './config/env';
import { createApp } from './app';
import { registerClaimAgent } from './agent/claimAgent';
import { startFollowupJob } from './jobs/followup';
import { storageMode } from './services/storage';
import { prisma } from './utils/prisma';
import { ensureDemoPack } from './demo/demoDocs';

registerClaimAgent();
startFollowupJob();
ensureDemoPack(prisma).catch((e) => console.warn('[demo-pack] ensure failed:', e.message));

const server = createApp().listen(env.port, () => {
  console.log(`[server] Claim Saathi API on :${env.port} (storage=${storageMode()}, MOCK_AI=${env.mockAI})`);
});

const shutdown = async () => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

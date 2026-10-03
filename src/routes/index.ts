import { Router } from 'express';
import auth from './auth.routes';
import policies from './policies.routes';
import claims from './claims.routes';
import documents, { filesRouter } from './documents.routes';
import queries from './queries.routes';
import notifications from './notifications.routes';
import dashboard from './dashboard.routes';
import me from './me.routes';
import aiRoutes from './ai.routes';
import realtime from './realtime.routes';
import publicRoutes from './public.routes';
import { prisma } from '../utils/prisma';
import { env, llmEnabled } from '../config/env';
import { storageMode } from '../services/storage';

const api = Router();

api.get('/health', async (_req, res) => {
  let db = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = 'down';
  }
  res.status(db === 'ok' ? 200 : 503).json({ ok: db === 'ok', db, storage: storageMode(), ai: llmEnabled() ? env.aiProvider : 'mock', planner: env.agentPlanner, time: new Date().toISOString() });
});

api.use('/auth', auth);
api.use('/public', publicRoutes);
api.use('/', realtime);
api.use('/me', me);
api.use('/ai', aiRoutes);
api.use('/policies', policies);
api.use('/claims', claims);
api.use('/documents', documents);
api.use('/files', filesRouter);
api.use('/queries', queries);
api.use('/notifications', notifications);
api.use('/', dashboard);

export default api;

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import api from './routes';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render / ngrok terminate TLS in front of us
  const origins = env.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins.includes('*') ? true : origins, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan(env.nodeEnv === 'production' ? 'tiny' : 'dev', { skip: (req) => req.path === '/api/health' }));
  app.get('/', (_req, res) => res.json({ name: 'Claim Saathi API', docs: '/api/health' }));
  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

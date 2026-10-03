/** GET /api/stream?token=JWT  (Server-Sent Events). EventSource cannot send headers, so the token may come in the query. */
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AuthUser } from '../middleware/auth';
import { unauthorized } from '../utils/errors';
import { addClient, clientCount } from '../realtime/hub';

const r = Router();

r.get('/stream', (req, res) => {
  const h = req.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7) : String(req.query.token ?? '');
  let user: AuthUser;
  try {
    user = jwt.verify(token, env.jwtSecret) as AuthUser;
  } catch {
    throw unauthorized('Session expired, please log in again');
  }
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  addClient(res, user.id, user.role === 'OPS' || user.role === 'ADMIN');
});

r.get('/stream/status', (_req, res) => res.json({ clients: clientCount() }));

export default r;

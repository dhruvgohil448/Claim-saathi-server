import { Router, Request, Response } from 'express';
import { publish } from '../realtime/hub';
import { prisma } from '../utils/prisma';
import { auth, isStaff } from '../middleware/auth';
import { optionalClaimScope } from '../services/demo';

const r = Router();
r.use(auth);

const list = async (req: Request, res: Response) => {
  const unreadOnly = req.query.unread === 'true';
  const scope = isStaff(req) ? await optionalClaimScope() : {};
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: req.user!.id, ...scope, ...(unreadOnly ? { read: false } : {}) }, orderBy: { createdAt: 'desc' }, take: 50, include: { claim: { select: { claimNumber: true } } } }),
    prisma.notification.count({ where: { userId: req.user!.id, read: false, ...scope } }),
  ]);
  res.json({ items, unread });
};
r.get('/my', list);
r.get('/', list);

r.patch('/:id/read', async (req, res) => {
  await prisma.notification.updateMany({ where: { id: req.params.id, userId: req.user!.id }, data: { read: true } });
  publish({ topic: 'notification', userId: req.user!.id });
  res.json({ ok: true });
});
r.post('/:id/read', async (req, res) => {
  await prisma.notification.updateMany({ where: { id: req.params.id, userId: req.user!.id }, data: { read: true } });
  publish({ topic: 'notification', userId: req.user!.id });
  res.json({ ok: true });
});

r.post('/read-all', async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user!.id, read: false }, data: { read: true } });
  publish({ topic: 'notification', userId: req.user!.id });
  res.json({ ok: true });
});

export default r;

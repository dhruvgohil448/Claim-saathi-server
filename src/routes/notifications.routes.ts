import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { auth } from '../middleware/auth';

const r = Router();
r.use(auth);

r.get('/my', async (req, res) => {
  const unreadOnly = req.query.unread === 'true';
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: req.user!.id, ...(unreadOnly ? { read: false } : {}) }, orderBy: { createdAt: 'desc' }, take: 50, include: { claim: { select: { claimNumber: true } } } }),
    prisma.notification.count({ where: { userId: req.user!.id, read: false } }),
  ]);
  res.json({ items, unread });
});

r.patch('/:id/read', async (req, res) => {
  await prisma.notification.updateMany({ where: { id: req.params.id, userId: req.user!.id }, data: { read: true } });
  res.json({ ok: true });
});

r.post('/read-all', async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user!.id, read: false }, data: { read: true } });
  res.json({ ok: true });
});

export default r;

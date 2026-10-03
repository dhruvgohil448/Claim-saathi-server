import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { auth, signToken } from '../middleware/auth';
import { unauthorized } from '../utils/errors';

const r = Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

r.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw unauthorized('Wrong email or password');
  const payload = { id: user.id, role: user.role, name: user.name, email: user.email };
  res.json({ token: signToken(payload), user: { ...payload, phone: user.phone, city: user.city } });
});

r.get('/me', auth, async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, name: true, email: true, role: true, phone: true, city: true, createdAt: true } });
  res.json(u);
});

export default r;

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { auth } from '../middleware/auth';
import { unauthorized } from '../utils/errors';
import { assertOtp, formatPhone, phoneDigits, PLACEHOLDER_EMAIL_DOMAIN } from '../services/otp';
import { publicUser, tokenFor } from '../services/users';
import * as tools from '../tools';

const r = Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

r.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw unauthorized('Wrong email or password');
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  res.json({ token: tokenFor(user), user: publicUser(user) });
});

/** Email + password sign-up for customers (the app's main flow is OTP below). */
r.post('/register', async (req, res) => {
  const b = z.object({ name: z.string().min(2).max(80), email: z.string().email(), password: z.string().min(6).max(100), phone: z.string().optional(), city: z.string().max(60).optional() }).parse(req.body);
  const user = await prisma.user.create({
    data: { name: b.name.trim(), email: b.email.toLowerCase().trim(), passwordHash: await bcrypt.hash(b.password, 10), phone: b.phone ? formatPhone(phoneDigits(b.phone)) : null, city: b.city, role: 'CUSTOMER', lastLoginAt: new Date() },
  });
  await tools.logActivity({ action: 'USER_REGISTERED', reason: `${user.name} signed up in the Claim Saathi app.`, actor: 'HUMAN', actorName: user.name });
  res.status(201).json({ token: tokenFor(user), user: publicUser(user), isNewUser: true });
});

/** Step 1 of OTP login. Demo: no SMS is sent, the code is always OTP_DEMO_CODE (111000). */
r.post('/otp/send', async (req, res) => {
  const { phone } = z.object({ phone: z.string().min(10) }).parse(req.body);
  const digits = phoneDigits(phone);
  res.json({ sent: true, phone: formatPhone(digits), expiresInSeconds: 300, demo: true });
});

async function findByPhone(digits: string) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ${digits} ORDER BY "createdAt" ASC LIMIT 1`;
  return rows[0] ? prisma.user.findUnique({ where: { id: rows[0].id } }) : null;
}

/** Step 2: verify OTP → returns a JWT. Creates a CUSTOMER account on first login. */
r.post('/otp/verify', async (req, res) => {
  const { phone, otp } = z.object({ phone: z.string().min(10), otp: z.string().min(4) }).parse(req.body);
  assertOtp(otp);
  const digits = phoneDigits(phone);
  let user = await findByPhone(digits);
  let isNewUser = false;
  if (!user) {
    isNewUser = true;
    user = await prisma.user.create({
      data: { name: 'New user', email: `${digits}@${PLACEHOLDER_EMAIL_DOMAIN}`, phone: formatPhone(digits), passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), role: 'CUSTOMER', lastLoginAt: new Date() },
    });
    await tools.logActivity({ action: 'USER_REGISTERED', reason: `New customer signed up with mobile ${formatPhone(digits)} (OTP verified).`, actor: 'HUMAN', actorName: user.phone });
  } else {
    user = await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  }
  const pub = publicUser(user);
  res.json({ token: tokenFor(user), user: pub, isNewUser, needsProfile: !pub.profileComplete });
});

r.get('/me', auth, async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  res.json(publicUser(u));
});

export default r;

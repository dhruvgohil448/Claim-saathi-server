import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { env } from '../config/env';
import { forbidden, unauthorized } from '../utils/errors';

export interface AuthUser { id: string; role: UserRole; name: string; email: string }
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

export const signToken = (u: AuthUser) => jwt.sign(u, env.jwtSecret, { expiresIn: '7d' });

export function auth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
  if (!token) return next(unauthorized());
  try {
    const p = jwt.verify(token, env.jwtSecret) as AuthUser;
    req.user = { id: p.id, role: p.role, name: p.name, email: p.email };
    next();
  } catch {
    next(unauthorized('Session expired, please log in again'));
  }
}

export const requireRole = (...roles: UserRole[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden(`This needs the ${roles.join(' or ')} role`));
  next();
};
export const staffOnly = requireRole('OPS', 'ADMIN');
export const isStaff = (req: Request) => req.user?.role === 'OPS' || req.user?.role === 'ADMIN';

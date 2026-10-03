import { User } from '@prisma/client';
import { signToken } from '../middleware/auth';
import { PLACEHOLDER_EMAIL_DOMAIN } from './otp';

type Bank = { accountName: string; accountNumber: string; ifsc: string; bankName?: string | null; verifiedAt: string } | null;

export const maskBank = (b: unknown) => {
  const x = b as Bank;
  if (!x) return null;
  return { accountName: x.accountName, accountNumberMasked: `XXXX${x.accountNumber.slice(-4)}`, ifsc: x.ifsc, bankName: x.bankName ?? null, verified: !!x.verifiedAt, verifiedAt: x.verifiedAt };
};

/** Safe user shape returned to the app / dashboard (never the password hash or full bank number). */
export function publicUser(u: User) {
  const hasRealEmail = !u.email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
  return {
    id: u.id,
    name: u.name,
    email: hasRealEmail ? u.email : null,
    phone: u.phone,
    role: u.role,
    city: u.city,
    dob: u.dob,
    gender: u.gender,
    bank: maskBank(u.bankAccount),
    pushEnabled: !!u.pushToken,
    profileComplete: hasRealEmail && !!u.name && u.name !== 'New user' && !!u.dob && !!u.gender,
    createdAt: u.createdAt,
  };
}

export const tokenFor = (u: User) => signToken({ id: u.id, role: u.role, name: u.name, email: u.email });

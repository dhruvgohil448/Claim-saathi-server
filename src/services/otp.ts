/** Demo OTP. No SMS is ever sent: every OTP step accepts only env.otpDemoCode (default 111000). */
import { env } from '../config/env';
import { badRequest } from '../utils/errors';

export const PLACEHOLDER_EMAIL_DOMAIN = 'phone.claimsaathi.app';

/** "+91 98200 00001", "9820000001", "09820000001" → "9820000001" (last 10 digits). */
export function phoneDigits(raw: string) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length < 10) throw badRequest('Enter a valid 10-digit mobile number');
  return d.slice(-10);
}
/** Same display format the seed data uses: "+91 98200 00001". */
export const formatPhone = (digits10: string) => `+91 ${digits10.slice(0, 5)} ${digits10.slice(5)}`;

export function assertOtp(otp: unknown) {
  if (String(otp ?? '').trim() !== env.otpDemoCode) throw badRequest('Incorrect OTP. Please try again.');
}

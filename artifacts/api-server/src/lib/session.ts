import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// Validated at boot by validateEnv(); see lib/config.ts.
const SESSION_SECRET = process.env.SESSION_SECRET ?? '';
const SESSION_COOKIE = 'zksync_session';
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function sign(value: string): string {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(value);
  return `${value}.${hmac.digest('base64url')}`;
}

function unsign(signedValue: string): string | null {
  const lastDot = signedValue.lastIndexOf('.');
  if (lastDot === -1) return null;
  const value = signedValue.substring(0, lastDot);
  const expected = Buffer.from(sign(value), 'utf8');
  const actual = Buffer.from(signedValue, 'utf8');
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  return value;
}

export function setSessionCookie(res: Response): void {
  const token = sign(`authenticated:${Date.now()}`);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function isAuthenticated(req: Request): boolean {
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (!cookie) return false;
  const value = unsign(cookie);
  if (!value || !value.startsWith('authenticated:')) return false;

  const timestampStr = value.substring('authenticated:'.length);
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return false;

  const age = Date.now() - timestamp;
  if (age > SESSION_MAX_AGE || age < 0) return false;

  return true;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) {
    next();
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
}

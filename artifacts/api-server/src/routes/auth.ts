import { Router, type IRouter } from 'express';
import crypto from 'crypto';
import { setSessionCookie, clearSessionCookie, isAuthenticated } from '../lib/session';

const router: IRouter = Router();

// ── In-memory rate limiter for auth endpoint ──
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const loginAttempts = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = loginAttempts.get(ip) || [];
  // Keep only timestamps within the current window
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  loginAttempts.set(ip, recent);
  return recent.length >= RATE_LIMIT_MAX;
}

function recordAttempt(ip: string): void {
  const timestamps = loginAttempts.get(ip) || [];
  timestamps.push(Date.now());
  loginAttempts.set(ip, timestamps);
}

// Clean up stale entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of loginAttempts.entries()) {
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) {
      loginAttempts.delete(ip);
    } else {
      loginAttempts.set(ip, recent);
    }
  }
}, 5 * 60 * 1000).unref();

function timingSafePasswordCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Compare against self to burn the same time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

router.post('/auth', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (isRateLimited(ip)) {
    res.status(429).json({ authenticated: false, message: 'Too many login attempts. Try again in a minute.' });
    return;
  }

  recordAttempt(ip);

  const { password } = req.body;
  const expected = process.env.DASHBOARD_PASSWORD;

  if (!expected) {
    req.log.error('DASHBOARD_PASSWORD not set');
    res.status(500).json({ authenticated: false, message: 'Server configuration error' });
    return;
  }

  if (typeof password !== 'string') {
    res.status(401).json({ authenticated: false, message: 'Incorrect password' });
    return;
  }

  if (timingSafePasswordCompare(password, expected)) {
    setSessionCookie(res);
    res.json({ authenticated: true, message: 'Login successful' });
  } else {
    res.status(401).json({ authenticated: false, message: 'Incorrect password' });
  }
});

router.get('/auth/check', (req, res) => {
  const authed = isAuthenticated(req);
  res.json({ authenticated: authed });
});

router.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ authenticated: false, message: 'Logged out' });
});

export default router;

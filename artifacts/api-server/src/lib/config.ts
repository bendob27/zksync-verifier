import { isDemoMode } from './demo/mode';

/**
 * Boot-time environment validation.
 *
 * Every one of these variables is load-bearing: without them the server would either refuse
 * every login, silently invalidate sessions, or fail on the first verification run. Failing
 * loudly at startup is preferable to failing in the middle of a token-distribution review.
 *
 * A demo instance serves invented data and makes no external calls, so it needs only the
 * two variables that keep its own login working. Everything else stays required, so a real
 * deployment that is missing a secret still refuses to start.
 */
const REQUIRED_ALWAYS = [
  ['SESSION_SECRET', 'HMAC key for signing session cookies'],
  ['DASHBOARD_PASSWORD', 'shared password for dashboard access'],
] as const;

const REQUIRED_FOR_REAL_DATA = [
  ['GOOGLE_CREDENTIALS', 'Google service account JSON for the Sheets API'],
  ['OPENROUTER_API_KEY', 'OpenRouter key used for grant matching and OCR'],
  ['TOKEN_MODEL_SHEET_ID', 'spreadsheet ID of the unlock schedule'],
  ['FINANCE_WORKBOOK_SHEET_ID', 'spreadsheet ID of the payment history'],
] as const;

export function validateEnv(): void {
  const demo = isDemoMode();
  const required = demo
    ? [...REQUIRED_ALWAYS]
    : [...REQUIRED_ALWAYS, ...REQUIRED_FOR_REAL_DATA];

  const missing = required.filter(([name]) => !process.env[name]);

  if (missing.length > 0) {
    const list = missing.map(([name, why]) => `  - ${name}: ${why}`).join('\n');
    throw new Error(
      `Missing required environment variable(s):\n${list}\n\nCopy .env.example to .env and fill these in.`,
    );
  }

  if (!demo) {
    try {
      JSON.parse(process.env.GOOGLE_CREDENTIALS as string);
    } catch {
      throw new Error('GOOGLE_CREDENTIALS must be the service account JSON, as a single-line string.');
    }
  }

  // A demo instance serves its own dashboard from the same origin and holds nothing
  // worth stealing, so it does not need an origin allow-list. A real deployment does.
  if (!demo && process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
    throw new Error(
      'CORS_ORIGIN must be set in production. Without it CORS reflects any origin while ' +
        'credentials are enabled, which would let any site call this API as a logged-in user.',
    );
  }
}

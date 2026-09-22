// Verification tolerances. An amount is only treated as matching when it falls
// within BOTH the relative and the absolute bound.
export const AMOUNT_TOLERANCE_PERCENT = 0.001; // 0.1%
export const AMOUNT_TOLERANCE_ABSOLUTE = 1000; // tokens
export const DATE_TOLERANCE_DAYS = 1;

// Spreadsheet identifiers are environment-specific and are never committed.
// See .env.example. Presence is enforced at boot by validateEnv().
export const TOKEN_MODEL_SHEET_ID = process.env.TOKEN_MODEL_SHEET_ID || '';
export const FINANCE_WORKBOOK_SHEET_ID = process.env.FINANCE_WORKBOOK_SHEET_ID || '';

export const TOKEN_MODEL_TABS = {
  UNLOCK_SCHEDULES: process.env.UNLOCK_SCHEDULES_TAB || 'Unlock Schedules',
  VESTING_SCHEDULES: process.env.VESTING_SCHEDULES_TAB || 'Vesting Schedules',
};

// Header text of the grant identifier column in the unlock schedule. The
// deployment's sheet may label it differently; alias fallbacks are applied too.
export const GRANT_ID_HEADER = process.env.GRANT_ID_HEADER || 'Grant ID';

export const FINANCE_WORKBOOK_TABS = {
  ALL_CASH_FLOWS: process.env.CASH_FLOWS_TAB || 'Cash Flows',
};

// OpenRouter model slug. Note the dot: `claude-opus-4-6` is not a valid slug and
// every request with it 404s.
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-opus-4.6';

export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 1000;

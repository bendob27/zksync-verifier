import { google } from 'googleapis';
import { logger } from './logger';
import {
  TOKEN_MODEL_SHEET_ID,
  FINANCE_WORKBOOK_SHEET_ID,
  TOKEN_MODEL_TABS,
  FINANCE_WORKBOOK_TABS,
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
  GRANT_ID_HEADER,
} from './constants';
import type { UnlockScheduleRow, VestingScheduleRow, CashFlowRow, SheetData } from './types';

/**
 * Pre-filtered extract of the Unlock Schedules sheet, ready for AI matching.
 * Contains just the columns the AI needs (Name, grant ID, current month amount)
 * filtered to only rows whose Grant ID appears in the Excel upload.
 */
export interface RawUnlockExtract {
  /** The header labels for the columns we extracted */
  headers: string[];
  /** Data rows: each row is an array of cell values aligned with `headers` */
  rows: string[][];
  /** Which month column we found (e.g. "Mar 2026") */
  monthLabel: string;
  /** If the smart extract failed, this contains the full raw grid (first 100 rows x 10 cols) as fallback */
  fallbackGrid?: string[][];
}

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedSheetData: SheetData | null = null;
let cacheTimestamp = 0;

function getAuth() {
  const credentialsJson = process.env.GOOGLE_CREDENTIALS;
  if (!credentialsJson) {
    throw new Error('GOOGLE_CREDENTIALS environment variable is not set');
  }
  const credentials = JSON.parse(credentialsJson);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

function colIndexToLetter(idx: number): string {
  let letter = '';
  let n = idx;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

function getCurrentMonthLabel(): string {
  const now = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[now.getMonth()]} ${now.getFullYear()}`;
}

function getNextMonthLabel(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[next.getMonth()]} ${next.getFullYear()}`;
}

async function fetchRange(
  sheetId: string,
  range: string,
  retries = MAX_RETRIES
): Promise<string[][]> {
  const sheets = getSheetsClient();
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });
      return (response.data.values as string[][]) || [];
    } catch (error: unknown) {
      const err = error as { code?: number; message?: string };
      if (err.code === 429 && attempt < retries - 1) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        logger.warn({ attempt, delay, range }, 'Rate limited, retrying');
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (err.code === 403) {
        throw new Error(
          `Can't access Google Sheets. Make sure the sheet is shared with the service account email. (Range: ${range})`
        );
      }
      throw error;
    }
  }
  throw new Error(`Failed to fetch range "${range}" after ${retries} retries`);
}

async function fetchBatchRanges(
  sheetId: string,
  ranges: string[]
): Promise<string[][][]> {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges,
  });
  return (response.data.valueRanges || []).map((vr) => (vr.values as string[][]) || []);
}

function findHeaderRow(rows: string[][], markerText: string): number {
  const marker = markerText.toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.some((cell) => String(cell || '').trim().toLowerCase().includes(marker))) {
      return i;
    }
  }
  return -1;
}

function findColumnByHeader(headerRow: string[], possibleNames: string[]): number {
  for (const name of possibleNames) {
    const lowerName = name.toLowerCase();
    const idx = headerRow.findIndex((h) => String(h || '').trim().toLowerCase() === lowerName);
    if (idx !== -1) return idx;
  }
  for (const name of possibleNames) {
    const lowerName = name.toLowerCase();
    const idx = headerRow.findIndex((h) => String(h || '').trim().toLowerCase().includes(lowerName));
    if (idx !== -1) return idx;
  }
  return -1;
}

function findMonthColumn(headerRow: string[], monthLabel: string): number {
  const lower = monthLabel.toLowerCase();
  return headerRow.findIndex((h) => String(h || '').trim().toLowerCase() === lower);
}

function parseNumericValue(val: string | undefined): number {
  if (!val) return 0;
  const cleaned = String(val).replace(/,/g, '').replace(/\s/g, '').trim();
  return parseFloat(cleaned) || 0;
}

async function parseUnlockSchedules(): Promise<UnlockScheduleRow[]> {
  const tabName = TOKEN_MODEL_TABS.UNLOCK_SCHEDULES;
  // Scan first 50 rows — the sheet has a large title/description block before the data table
  const headerRows = await fetchRange(
    TOKEN_MODEL_SHEET_ID,
    `'${tabName}'!1:50`
  );

  if (headerRows.length === 0) {
    logger.warn('No data in Unlock Schedules first 50 rows');
    return [];
  }

  let headerRowIdx = findHeaderRow(headerRows, GRANT_ID_HEADER.toLowerCase());
  if (headerRowIdx === -1) {
    headerRowIdx = findHeaderRow(headerRows, 'total tokens');
  }
  if (headerRowIdx === -1) {
    // Last resort: look for a row with "Name" as first non-empty cell and at least 5 non-empty cells
    for (let i = 0; i < headerRows.length; i++) {
      const row = headerRows[i] || [];
      const nonEmpty = row.filter((c) => String(c || '').trim()).length;
      const firstCell = String(row[0] || '').trim().toLowerCase();
      if (nonEmpty >= 5 && firstCell === 'name') {
        headerRowIdx = i;
        break;
      }
    }
  }
  if (headerRowIdx === -1) {
    const rowDump = headerRows.map((r, i) => `[Row ${i}]: ${r.map((c) => String(c || '').trim()).filter(c => c).join(' | ')}`).filter(r => !r.endsWith(': ')).join('\n');
    throw new Error(`Could not find header row in Unlock Schedules. Non-empty rows:\n${rowDump}`);
  }

  const headerRow = headerRows[headerRowIdx].map((c) => String(c || '').trim());
  const headerRowNum = headerRowIdx + 1;
  logger.info({ headerRowNum, headers: headerRow.filter((h) => h).slice(0, 15) }, 'Found Unlock Schedules header row');

  const grantIdCol = findColumnByHeader(headerRow, [GRANT_ID_HEADER, 'Grant ID', 'GrantID']);
  const nameCol = findColumnByHeader(headerRow, ['Name']);
  const totalTokensCol = findColumnByHeader(headerRow, ['Total Tokens', 'Total Grant Amount']);

  const currentMonth = getCurrentMonthLabel();
  const nextMonth = getNextMonthLabel();
  const currentMonthCol = findMonthColumn(headerRow, currentMonth);
  const nextMonthCol = findMonthColumn(headerRow, nextMonth);

  logger.info({
    grantIdCol: grantIdCol !== -1 ? colIndexToLetter(grantIdCol) : 'NOT FOUND',
    nameCol: nameCol !== -1 ? colIndexToLetter(nameCol) : 'NOT FOUND',
    totalTokensCol: totalTokensCol !== -1 ? colIndexToLetter(totalTokensCol) : 'NOT FOUND',
    currentMonth,
    currentMonthCol: currentMonthCol !== -1 ? colIndexToLetter(currentMonthCol) : 'NOT FOUND',
    nextMonth,
    nextMonthCol: nextMonthCol !== -1 ? colIndexToLetter(nextMonthCol) : 'NOT FOUND',
  }, 'Unlock Schedules column mapping');

  if (grantIdCol === -1) {
    throw new Error(`Could not find the grant ID column (${GRANT_ID_HEADER}) in Unlock Schedules. Headers: ${headerRow.filter((h) => h).join(', ')}`);
  }

  // Filter out -1 (not found) columns before computing max
  const foundCols = [grantIdCol, nameCol, totalTokensCol, currentMonthCol, nextMonthCol].filter(c => c !== -1);
  const lastDataCol = foundCols.length > 0 ? Math.max(...foundCols) : 30;
  const startRow = headerRowNum + 1;
  const endColLetter = colIndexToLetter(Math.max(lastDataCol, 30));

  const dataRows = await fetchRange(
    TOKEN_MODEL_SHEET_ID,
    `'${tabName}'!A${startRow}:${endColLetter}1000`
  );

  logger.info({ dataRowCount: dataRows.length }, 'Fetched Unlock Schedules data rows');

  const results: UnlockScheduleRow[] = [];
  for (const row of dataRows) {
    const grantId = String(row[grantIdCol] || '').trim();
    if (!grantId) continue;

    const name = nameCol !== -1 ? String(row[nameCol] || '').trim() : '';
    const totalTokens = totalTokensCol !== -1 ? parseNumericValue(row[totalTokensCol]) : undefined;

    let monthlyAmount = 0;
    if (currentMonthCol !== -1 && row[currentMonthCol]) {
      monthlyAmount = parseNumericValue(row[currentMonthCol]);
    }

    let unlockDate = currentMonth;
    if (monthlyAmount === 0 && nextMonthCol !== -1 && row[nextMonthCol]) {
      const nextAmount = parseNumericValue(row[nextMonthCol]);
      if (nextAmount > 0) {
        monthlyAmount = nextAmount;
        unlockDate = nextMonth;
      }
    }

    results.push({
      grantId,
      recipient: name,
      amount: monthlyAmount,
      unlockDate,
      totalGrantAmount: totalTokens,
    });
  }

  logger.info({ grantCount: results.length }, 'Parsed Unlock Schedules');
  return results;
}

async function parseVestingSchedules(): Promise<VestingScheduleRow[]> {
  const tabName = TOKEN_MODEL_TABS.VESTING_SCHEDULES;

  let headerRows: string[][];
  try {
    headerRows = await fetchRange(TOKEN_MODEL_SHEET_ID, `'${tabName}'!1:50`);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Failed to fetch Vesting Schedules');
    return [];
  }

  if (headerRows.length === 0) return [];

  let headerRowIdx = findHeaderRow(headerRows, GRANT_ID_HEADER.toLowerCase());
  if (headerRowIdx === -1) {
    headerRowIdx = findHeaderRow(headerRows, 'name');
  }
  if (headerRowIdx === -1) {
    // Fallback: look for row with 5+ non-empty cells
    for (let i = 0; i < headerRows.length; i++) {
      const row = headerRows[i] || [];
      const nonEmpty = row.filter((c) => String(c || '').trim()).length;
      if (nonEmpty >= 5) {
        headerRowIdx = i;
        break;
      }
    }
  }
  if (headerRowIdx === -1) return [];

  const headerRow = headerRows[headerRowIdx].map((c) => String(c || '').trim());
  const headerRowNum = headerRowIdx + 1;

  const grantIdCol = findColumnByHeader(headerRow, [GRANT_ID_HEADER, 'Grant ID']);
  const nameCol = findColumnByHeader(headerRow, ['Name']);
  const recipientCol = grantIdCol !== -1 ? grantIdCol : 1;

  const currentMonth = getCurrentMonthLabel();
  const currentMonthCol = findMonthColumn(headerRow, currentMonth);

  const lastCol = Math.max(recipientCol, nameCol, currentMonthCol, 10);
  const endColLetter = colIndexToLetter(lastCol);
  const startRow = headerRowNum + 1;

  const dataRows = await fetchRange(
    TOKEN_MODEL_SHEET_ID,
    `'${tabName}'!A${startRow}:${endColLetter}1000`
  );

  const results: VestingScheduleRow[] = [];
  for (const row of dataRows) {
    const grantId = grantIdCol !== -1 ? String(row[grantIdCol] || '').trim() : '';
    const name = nameCol !== -1 ? String(row[nameCol] || '').trim() : '';
    if (!grantId && !name) continue;

    results.push({
      grantId: grantId || name,
    });
  }

  logger.info({ vestingCount: results.length }, 'Parsed Vesting Schedules');
  return results;
}

async function parseCashFlows(): Promise<{ rows: CashFlowRow[]; fetchFailed: boolean }> {
  const tabName = FINANCE_WORKBOOK_TABS.ALL_CASH_FLOWS;

  let headerRows: string[][];
  try {
    headerRows = await fetchRange(FINANCE_WORKBOOK_SHEET_ID, `'${tabName}'!1:50`);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Failed to fetch Cash Flows');
    return { rows: [], fetchFailed: true };
  }

  if (headerRows.length === 0) return { rows: [], fetchFailed: false };

  let headerRowIdx = findHeaderRow(headerRows, 'grant');
  if (headerRowIdx === -1) {
    headerRowIdx = findHeaderRow(headerRows, 'amount');
  }
  if (headerRowIdx === -1) {
    // Fallback: look for row with 5+ non-empty cells
    for (let i = 0; i < headerRows.length; i++) {
      const row = headerRows[i] || [];
      const nonEmpty = row.filter((c) => String(c || '').trim()).length;
      if (nonEmpty >= 5) {
        headerRowIdx = i;
        break;
      }
    }
  }
  if (headerRowIdx === -1) {
    logger.warn('Could not find header row in Cash Flows');
    return { rows: [], fetchFailed: true };
  }

  const headerRow = headerRows[headerRowIdx].map((c) => String(c || '').trim());
  const headerRowNum = headerRowIdx + 1;
  logger.info({ headerRowNum, headers: headerRow.filter((h) => h).join(', ') }, 'Found Cash Flows header row');

  const grantIdCol = findColumnByHeader(headerRow, [GRANT_ID_HEADER, 'Grant ID', 'Grant Name', 'Grant']);
  const amountCol = findColumnByHeader(headerRow, ['Amount', 'Token Amount', 'Tokens']);
  const dateCol = findColumnByHeader(headerRow, ['Date', 'Payment Date', 'Distribution Date']);

  if (grantIdCol === -1) {
    logger.warn({ headers: headerRow.filter((h) => h).join(', ') }, 'Could not find Grant ID column in Cash Flows');
    return { rows: [], fetchFailed: true };
  }

  const colsToFetch = [grantIdCol, amountCol, dateCol].filter((c) => c !== -1);
  const maxCol = Math.max(...colsToFetch, 16);
  const endColLetter = colIndexToLetter(maxCol);
  const startRow = headerRowNum + 1;

  const dataRows = await fetchRange(
    FINANCE_WORKBOOK_SHEET_ID,
    `'${tabName}'!A${startRow}:${endColLetter}2000`
  );

  const results: CashFlowRow[] = [];
  for (const row of dataRows) {
    const grantId = String(row[grantIdCol] || '').trim();
    if (!grantId) continue;

    results.push({
      grantId,
      amount: amountCol !== -1 ? parseNumericValue(row[amountCol]) : 0,
      date: dateCol !== -1 ? String(row[dateCol] || '').trim() : '',
    });
  }

  logger.info({ cashFlowCount: results.length }, 'Parsed Cash Flows');
  return { rows: results, fetchFailed: false };
}

/**
 * Fetch a targeted extract of the Unlock Schedules sheet for AI matching.
 * Strategy:
 *   1. Fetch first 50 rows to find the header row (scan for the grant ID header)
 *   2. Once found, fetch the full data range (header row onward, columns A through BD)
 *   3. Extract only: Name (col A), grant ID (col B), and the current-month column
 *   4. Filter to only rows where the Grant ID appears in `excelGrantIds`
 *   5. If header detection fails, fall back to returning a broad raw grid for Claude to parse
 */
export async function fetchRawUnlockData(excelGrantIds: string[]): Promise<RawUnlockExtract> {
  const tabName = TOKEN_MODEL_TABS.UNLOCK_SCHEDULES;
  const grantIdSet = new Set(excelGrantIds.map((id) => id.toLowerCase().trim()));

  // Step 1: Fetch first 50 rows to locate the header
  const scanRows = await fetchRange(TOKEN_MODEL_SHEET_ID, `'${tabName}'!A1:BD50`);

  if (scanRows.length === 0) {
    logger.warn('No data in Unlock Schedules scan range');
    return { headers: [], rows: [], monthLabel: '', fallbackGrid: [] };
  }

  // Find the header row by looking for the grant ID header in any cell
  let headerRowIdx = -1;
  for (let i = 0; i < scanRows.length; i++) {
    const row = scanRows[i] || [];
    if (row.some((cell) => String(cell || '').trim().toLowerCase().includes(GRANT_ID_HEADER.toLowerCase()))) {
      headerRowIdx = i;
      break;
    }
  }

  // If not found, try "Total Tokens" as fallback
  if (headerRowIdx === -1) {
    for (let i = 0; i < scanRows.length; i++) {
      const row = scanRows[i] || [];
      if (row.some((cell) => String(cell || '').trim().toLowerCase().includes('total tokens'))) {
        headerRowIdx = i;
        break;
      }
    }
  }

  if (headerRowIdx === -1) {
    // Fallback: return first 100 rows x 10 cols as raw grid for Claude to figure out
    logger.warn('Could not find header row in Unlock Schedules — falling back to raw grid');
    const fallback = await fetchRange(TOKEN_MODEL_SHEET_ID, `'${tabName}'!A1:J100`);
    return {
      headers: [],
      rows: [],
      monthLabel: '',
      fallbackGrid: fallback,
    };
  }

  const headerRow = scanRows[headerRowIdx].map((c) => String(c || '').trim());
  const headerRowNum = headerRowIdx + 1; // 1-indexed for Sheets API

  // Find key column indices
  const nameCol = headerRow.findIndex((h) => h.toLowerCase() === 'name');
  const grantIdCol = headerRow.findIndex((h) => h.toLowerCase().includes(GRANT_ID_HEADER.toLowerCase()));
  const totalTokensCol = headerRow.findIndex((h) => h.toLowerCase().includes('total tokens'));

  // Find both current and next month columns (unlocks may span month boundaries, e.g. CW14 has Mar 30 - Apr 2)
  const currentMonth = getCurrentMonthLabel();
  const nextMonth = getNextMonthLabel();
  const currentMonthCol = headerRow.findIndex((h) => h.toLowerCase() === currentMonth.toLowerCase());
  const nextMonthCol = headerRow.findIndex((h) => h.toLowerCase() === nextMonth.toLowerCase());
  const monthLabel = [
    currentMonthCol !== -1 ? currentMonth : null,
    nextMonthCol !== -1 ? nextMonth : null,
  ].filter(Boolean).join(' / ') || currentMonth;

  logger.info({
    headerRowNum,
    nameCol: nameCol !== -1 ? colIndexToLetter(nameCol) : 'NOT FOUND',
    grantIdCol: grantIdCol !== -1 ? colIndexToLetter(grantIdCol) : 'NOT FOUND',
    totalTokensCol: totalTokensCol !== -1 ? colIndexToLetter(totalTokensCol) : 'NOT FOUND',
    currentMonthCol: currentMonthCol !== -1 ? colIndexToLetter(currentMonthCol) : 'NOT FOUND',
    nextMonthCol: nextMonthCol !== -1 ? colIndexToLetter(nextMonthCol) : 'NOT FOUND',
    monthLabel,
  }, 'Raw unlock extract: column mapping');

  // Step 2: Fetch all data rows from the header row onward (up to 500 rows)
  const dataStartRow = headerRowNum + 1;
  const maxCol = Math.max(
    ...[nameCol, grantIdCol, totalTokensCol, currentMonthCol, nextMonthCol].filter((c) => c !== -1),
    10 // minimum width
  );
  const endColLetter = colIndexToLetter(maxCol);
  // Fetch up to row 1000 — the sheet has 600+ rows of grant data
  const allDataRows = await fetchRange(
    TOKEN_MODEL_SHEET_ID,
    `'${tabName}'!A${dataStartRow}:${endColLetter}1000`
  );

  // Step 3: Build the extract — pick only the columns we care about
  const extractCols: { label: string; idx: number }[] = [];
  if (nameCol !== -1) extractCols.push({ label: 'Name', idx: nameCol });
  if (grantIdCol !== -1) extractCols.push({ label: GRANT_ID_HEADER, idx: grantIdCol });
  if (totalTokensCol !== -1) extractCols.push({ label: 'Total Tokens', idx: totalTokensCol });
  if (currentMonthCol !== -1) extractCols.push({ label: currentMonth, idx: currentMonthCol });
  if (nextMonthCol !== -1) extractCols.push({ label: nextMonth, idx: nextMonthCol });

  // If we couldn't find enough columns, include the full header set in fallback
  if (extractCols.length < 2) {
    logger.warn('Not enough columns identified — falling back to raw grid');
    const fallback = await fetchRange(TOKEN_MODEL_SHEET_ID, `'${tabName}'!A1:J100`);
    return {
      headers: [],
      rows: [],
      monthLabel,
      fallbackGrid: fallback,
    };
  }

  const extractHeaders = extractCols.map((c) => c.label);
  const extractRows: string[][] = [];

  // Include ALL non-empty rows — let Claude handle the matching.
  // Pre-filtering was too strict and missed grants with slightly different IDs.
  for (const row of allDataRows) {
    const rowGrantId = grantIdCol !== -1 ? String(row[grantIdCol] || '').trim() : '';
    const rowName = nameCol !== -1 ? String(row[nameCol] || '').trim() : '';
    if (rowGrantId || rowName) {
      extractRows.push(extractCols.map((c) => String(row[c.idx] || '').trim()));
    }
  }

  logger.info({
    totalDataRows: allDataRows.length,
    includedRows: extractRows.length,
    columns: extractHeaders,
  }, 'Raw unlock extract: all non-empty rows included for AI matching');

  return {
    headers: extractHeaders,
    rows: extractRows,
    monthLabel,
  };
}

export async function fetchAllSheetData(): Promise<SheetData> {
  const now = Date.now();
  if (cachedSheetData && now - cacheTimestamp < CACHE_TTL_MS) {
    logger.info('Using cached sheet data');
    return cachedSheetData;
  }

  const [unlockSchedules, vestingSchedules, cashFlowResult] = await Promise.all([
    parseUnlockSchedules(),
    parseVestingSchedules(),
    parseCashFlows(),
  ]);

  const timestamp = new Date().toISOString();
  const data: SheetData = {
    unlockSchedules,
    vestingSchedules,
    cashFlows: cashFlowResult.rows,
    tokenModelSyncedAt: timestamp,
    financeWorkbookSyncedAt: cashFlowResult.rows.length > 0 ? timestamp : undefined,
    cashFlowsFetchFailed: cashFlowResult.fetchFailed,
  };

  cachedSheetData = data;
  cacheTimestamp = Date.now();
  logger.info({
    unlockCount: unlockSchedules.length,
    vestingCount: vestingSchedules.length,
    cashFlowCount: cashFlowResult.rows.length,
    cashFlowsFetchFailed: cashFlowResult.fetchFailed,
  }, 'Sheet data fetched and cached');

  return data;
}

export async function checkSheetsAccess(): Promise<{
  tokenModelSynced: boolean;
  tokenModelSyncedAt?: string;
  tokenModelTabCount?: number;
  financeWorkbookSynced: boolean;
  financeWorkbookSyncedAt?: string;
  financeWorkbookTabCount?: number;
}> {
  const results = await Promise.allSettled([
    fetchRange(TOKEN_MODEL_SHEET_ID, `'${TOKEN_MODEL_TABS.UNLOCK_SCHEDULES}'!1:5`),
    fetchRange(FINANCE_WORKBOOK_SHEET_ID, `'${FINANCE_WORKBOOK_TABS.ALL_CASH_FLOWS}'!1:5`),
  ]);

  const now = new Date().toISOString();
  const tokenResult = results[0];
  const financeResult = results[1];

  return {
    tokenModelSynced: tokenResult.status === 'fulfilled',
    tokenModelSyncedAt: tokenResult.status === 'fulfilled' ? now : undefined,
    tokenModelTabCount:
      tokenResult.status === 'fulfilled' ? tokenResult.value.length : undefined,
    financeWorkbookSynced: financeResult.status === 'fulfilled',
    financeWorkbookSyncedAt: financeResult.status === 'fulfilled' ? now : undefined,
    financeWorkbookTabCount:
      financeResult.status === 'fulfilled' ? financeResult.value.length : undefined,
  };
}

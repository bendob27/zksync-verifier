/**
 * Loading the unlock schedule and payment history for a specific batch.
 *
 * The important difference from the previous loader: the columns fetched are decided by
 * the BATCH's dates, not by the server clock. Re-running a batch from three months ago
 * reads the columns that batch needs.
 *
 * Two sets of columns are loaded:
 *   - the periods the payments fall in, to look up each instalment (R1)
 *   - every earlier period as well, so "scheduled to date" can be totalled (R4b)
 *
 * Truncation is detected rather than assumed away: if the sheet fills the row window we
 * asked for, we say so, and the run reports that it could not see everything.
 */

import { fingerprint } from './engine';
import { comparePeriods, parsePeriodLabel, periodKey, periodLabel, type Period } from './period';
import { buildHistoryIndex, buildScheduleIndex, type HistoryIndex, type ScheduleIndex } from './sources';

export interface RangeFetcher {
  (sheetId: string, range: string): Promise<string[][]>;
}

export interface LoadedSources {
  schedule: ScheduleIndex;
  history: HistoryIndex;
  /** True when every column needed for the scheduled-to-date total was found. */
  cumulativePeriodsComplete: boolean;
  fingerprints: { unlockSchedule: string; paymentHistory: string };
  degradations: string[];
}

const SCHEDULE_ROW_WINDOW = 2000;
const HISTORY_ROW_WINDOW = 5000;

function colLetter(idx: number): string {
  let s = '';
  let n = idx;
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function findHeaderRow(rows: string[][], marker: string): number {
  const needle = marker.trim().toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] ?? []).some((c) => String(c ?? '').trim().toLowerCase().includes(needle))) return i;
  }
  return -1;
}

function findColumn(header: string[], names: string[]): number {
  for (const n of names) {
    const i = header.findIndex((h) => h.trim().toLowerCase() === n.trim().toLowerCase());
    if (i !== -1) return i;
  }
  for (const n of names) {
    const i = header.findIndex((h) => h.trim().toLowerCase().includes(n.trim().toLowerCase()));
    if (i !== -1) return i;
  }
  return -1;
}

export async function loadSources(opts: {
  fetchRange: RangeFetcher;
  scheduleSheetId: string;
  scheduleTab: string;
  historySheetId: string;
  historyTab: string;
  grantIdHeader: string;
  /** Periods the batch's payments fall in. */
  batchPeriods: Period[];
}): Promise<LoadedSources> {
  const degradations: string[] = [];

  // ── Unlock schedule ──────────────────────────────────────────────────────
  const scan = await opts.fetchRange(opts.scheduleSheetId, `'${opts.scheduleTab}'!A1:BZ50`);
  let headerIdx = findHeaderRow(scan, opts.grantIdHeader);
  if (headerIdx === -1) headerIdx = findHeaderRow(scan, 'total tokens');
  if (headerIdx === -1) {
    throw new Error(
      `Could not find the header row in the unlock schedule (looked for "${opts.grantIdHeader}" in the first 50 rows).`,
    );
  }

  const header = (scan[headerIdx] ?? []).map((c) => String(c ?? '').trim());
  const nameCol = findColumn(header, ['Name', 'Grantee', 'Recipient']);
  const grantCol = findColumn(header, [opts.grantIdHeader, 'Grant ID', 'GrantID']);
  const totalCol = findColumn(header, ['Total Tokens', 'Total']);

  if (grantCol === -1) {
    throw new Error(`Could not find the grant ID column ("${opts.grantIdHeader}") in the unlock schedule.`);
  }

  // Every period column present in the sheet, mapped to its column index.
  const periodColumns = new Map<string, number>();
  header.forEach((h, i) => {
    const p = parsePeriodLabel(h);
    if (p) periodColumns.set(periodKey(p), i);
  });

  const latestBatchPeriod = opts.batchPeriods.length > 0
    ? opts.batchPeriods[opts.batchPeriods.length - 1]
    : null;

  // Load every period column at or before the batch's latest period: the batch's own
  // months for R1, and all earlier ones so R4b can be totalled.
  const wanted: Period[] = [];
  for (const [key, _i] of periodColumns) {
    const [y, m] = key.split('-').map(Number);
    const p = { year: y, month: m };
    if (!latestBatchPeriod || comparePeriods(p, latestBatchPeriod) <= 0) wanted.push(p);
  }
  wanted.sort(comparePeriods);

  const missingBatchPeriods = opts.batchPeriods.filter((p) => !periodColumns.has(periodKey(p)));
  for (const p of missingBatchPeriods) {
    degradations.push(`the unlock schedule has no column for ${periodLabel(p)}`);
  }

  const maxCol = Math.max(nameCol, grantCol, totalCol, ...[...periodColumns.values()], 10);
  const dataStart = headerIdx + 2;
  const rows = await opts.fetchRange(
    opts.scheduleSheetId,
    `'${opts.scheduleTab}'!A${dataStart}:${colLetter(maxCol)}${dataStart + SCHEDULE_ROW_WINDOW}`,
  );
  if (rows.length >= SCHEDULE_ROW_WINDOW) {
    degradations.push(`the unlock schedule filled the ${SCHEDULE_ROW_WINDOW}-row read window, so it may be truncated`);
  }

  const schedule = buildScheduleIndex(
    rows
      .filter((r) => String(r?.[grantCol] ?? '').trim() !== '')
      .map((r, i) => ({
        grantId: r[grantCol],
        granteeName: nameCol === -1 ? '' : r[nameCol],
        totalTokens: totalCol === -1 ? null : r[totalCol],
        instalments: wanted.map((p) => ({ period: p, value: r[periodColumns.get(periodKey(p))!] })),
        sourceRef: `unlock schedule row ${dataStart + i}`,
      })),
    wanted,
  );

  // ── Payment history ──────────────────────────────────────────────────────
  let history: HistoryIndex;
  let historyRaw: string[][] = [];
  try {
    const hScan = await opts.fetchRange(opts.historySheetId, `'${opts.historyTab}'!A1:BZ50`);
    const hHeaderIdx = findHeaderRow(hScan, opts.grantIdHeader) !== -1
      ? findHeaderRow(hScan, opts.grantIdHeader)
      : findHeaderRow(hScan, 'grant');
    if (hHeaderIdx === -1) throw new Error('could not find the header row');

    const hHeader = (hScan[hHeaderIdx] ?? []).map((c) => String(c ?? '').trim());
    const hGrant = findColumn(hHeader, [opts.grantIdHeader, 'Grant ID', 'Grant Name', 'Grant']);
    const hAmount = findColumn(hHeader, ['Token Amount', 'Amount', 'Tokens']);
    const hDate = findColumn(hHeader, ['Date', 'Payment Date', 'Event Date']);

    if (hGrant === -1 || hAmount === -1) {
      throw new Error('the grant or amount column is missing');
    }

    const hStart = hHeaderIdx + 2;
    historyRaw = await opts.fetchRange(
      opts.historySheetId,
      `'${opts.historyTab}'!A${hStart}:${colLetter(Math.max(hGrant, hAmount, hDate, 10))}${hStart + HISTORY_ROW_WINDOW}`,
    );
    const truncated = historyRaw.length >= HISTORY_ROW_WINDOW;
    if (truncated) {
      degradations.push(`the payment history filled the ${HISTORY_ROW_WINDOW}-row read window, so it may be truncated`);
    }

    history = buildHistoryIndex(
      historyRaw
        .filter((r) => String(r?.[hGrant] ?? '').trim() !== '')
        .map((r, i) => ({
          grantId: r[hGrant],
          amount: r[hAmount],
          date: hDate === -1 ? '' : r[hDate],
          sourceRef: `payment history row ${hStart + i}`,
        })),
      truncated ? { incomplete: true, incompleteReason: 'the read window was filled, so older payments may be missing' } : {},
    );

    // An empty history is only credible if the sheet is genuinely empty. Treat a
    // zero-row read as a failure to load rather than as "nothing has ever been paid".
    if (history.entries.length === 0) {
      history = { ...history, incomplete: true, incompleteReason: 'the payment history returned no rows' };
      degradations.push('the payment history returned no rows');
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    degradations.push(`the payment history could not be read (${reason})`);
    history = buildHistoryIndex([], { incomplete: true, incompleteReason: reason });
  }

  const cumulativePeriodsComplete =
    latestBatchPeriod === null || missingBatchPeriods.length === 0;

  return {
    schedule,
    history,
    cumulativePeriodsComplete,
    fingerprints: {
      unlockSchedule: fingerprint(rows),
      paymentHistory: fingerprint(historyRaw),
    },
    degradations,
  };
}

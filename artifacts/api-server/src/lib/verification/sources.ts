/**
 * Validated source data.
 *
 * Everything the engine compares against lives here, already parsed into exact types.
 * Parsing happens once, at the boundary; by the time a check runs there are no strings
 * left to reinterpret and no chance of a second, differently-behaving parser.
 *
 * A value that could not be parsed is not silently dropped or coerced to zero — it is
 * recorded as an issue, and any check that needed it reports NEEDS_REVIEW.
 */

import { parseTokens, type Tokens } from './money';
import { parseDate, periodKey, type Period, type PlainDate } from './period';

export interface SourceIssue {
  source: 'unlockSchedule' | 'paymentHistory' | 'custodyExport' | 'custodyQueue';
  ref: string;
  problem: string;
}

/**
 * One row of the unlock schedule: a grant, its lifetime cap, and its instalments by period.
 * The sheet is laid out wide (a column per month), so an instalment is a single cell.
 */
export interface ScheduleRow {
  grantId: string;
  granteeName: string;
  /** Lifetime cap for the grant. Null when the sheet does not give one — never defaulted. */
  totalTokens: Tokens | null;
  /** periodKey -> scheduled amount for that month. Absent means no column was loaded. */
  instalments: Map<string, Tokens>;
  sourceRef: string;
}

export interface ScheduleIndex {
  rows: ScheduleRow[];
  /** Lowercased grant id -> rows. A grant may legitimately have several tranche rows. */
  byGrantId: Map<string, ScheduleRow[]>;
  /** Periods actually loaded. A period outside this set cannot be checked. */
  periodsLoaded: Set<string>;
  issues: SourceIssue[];
}

export interface HistoryEntry {
  grantId: string;
  amount: Tokens;
  date: PlainDate | null;
  sourceRef: string;
}

export interface HistoryIndex {
  entries: HistoryEntry[];
  byGrantId: Map<string, HistoryEntry[]>;
  /** True when the history could not be loaded or is suspected incomplete. */
  incomplete: boolean;
  incompleteReason?: string;
  issues: SourceIssue[];
}

/** One line observed in the custody queue (from a screenshot, or a structured export). */
export interface QueueLine {
  lineId: string;
  recipient: string;
  amount: Tokens;
  date: PlainDate | null;
  sourceRef: string;
}

export interface CustodyQueue {
  lines: QueueLine[];
  /** True when queue evidence is partial — some screenshots failed, or none were supplied. */
  incomplete: boolean;
  incompleteReason?: string;
  issues: SourceIssue[];
}

export function normaliseGrantId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s\-_.]/g, '');
}

export function normaliseName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Build a schedule index from already-extracted cells, validating every value. */
export function buildScheduleIndex(
  raw: Array<{
    grantId: unknown;
    granteeName: unknown;
    totalTokens: unknown;
    instalments: Array<{ period: Period; value: unknown }>;
    sourceRef: string;
  }>,
  periodsLoaded: Period[],
): ScheduleIndex {
  const issues: SourceIssue[] = [];
  const rows: ScheduleRow[] = [];

  for (const r of raw) {
    const grantId = String(r.grantId ?? '').trim();
    if (grantId === '') continue; // rows without an identifier are not grants

    let totalTokens: Tokens | null = null;
    if (r.totalTokens !== undefined && r.totalTokens !== null && String(r.totalTokens).trim() !== '') {
      const parsed = parseTokens(r.totalTokens);
      if (parsed.ok) {
        totalTokens = parsed.value;
      } else {
        issues.push({
          source: 'unlockSchedule',
          ref: r.sourceRef,
          problem: `total cap unreadable (${parsed.reason}) — cap check cannot complete for ${grantId}`,
        });
      }
    }

    const instalments = new Map<string, Tokens>();
    for (const cell of r.instalments) {
      const text = String(cell.value ?? '').trim();
      if (text === '') continue; // a blank month simply has no instalment
      const parsed = parseTokens(cell.value);
      if (parsed.ok) {
        instalments.set(periodKey(cell.period), parsed.value);
      } else {
        issues.push({
          source: 'unlockSchedule',
          ref: `${r.sourceRef}, ${periodKey(cell.period)}`,
          problem: `instalment unreadable (${parsed.reason})`,
        });
      }
    }

    rows.push({
      grantId,
      granteeName: String(r.granteeName ?? '').trim(),
      totalTokens,
      instalments,
      sourceRef: r.sourceRef,
    });
  }

  const byGrantId = new Map<string, ScheduleRow[]>();
  for (const row of rows) {
    const key = normaliseGrantId(row.grantId);
    const list = byGrantId.get(key);
    if (list) list.push(row);
    else byGrantId.set(key, [row]);
  }

  return {
    rows,
    byGrantId,
    periodsLoaded: new Set(periodsLoaded.map(periodKey)),
    issues,
  };
}

export function buildHistoryIndex(
  raw: Array<{ grantId: unknown; amount: unknown; date: unknown; sourceRef: string }>,
  opts: { incomplete?: boolean; incompleteReason?: string } = {},
): HistoryIndex {
  const issues: SourceIssue[] = [];
  const entries: HistoryEntry[] = [];

  for (const r of raw) {
    const grantId = String(r.grantId ?? '').trim();
    if (grantId === '') continue;

    const amount = parseTokens(r.amount);
    if (!amount.ok) {
      // A payment we cannot read is a hole in the exposure calculation, not a zero.
      issues.push({
        source: 'paymentHistory',
        ref: r.sourceRef,
        problem: `amount unreadable (${amount.reason}) — exposure for ${grantId} is incomplete`,
      });
      continue;
    }

    const date = parseDate(r.date);
    if (!date.ok) {
      issues.push({
        source: 'paymentHistory',
        ref: r.sourceRef,
        problem: `date unreadable (${date.reason})`,
      });
    }

    entries.push({
      grantId,
      amount: amount.value,
      date: date.ok ? date.value : null,
      sourceRef: r.sourceRef,
    });
  }

  const byGrantId = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    const key = normaliseGrantId(e.grantId);
    const list = byGrantId.get(key);
    if (list) list.push(e);
    else byGrantId.set(key, [e]);
  }

  // Any unreadable amount means the exposure sum is understated, which would make the cap
  // checks look safer than they are. Treat that as an incomplete history.
  const hasUnreadableAmounts = issues.some((i) => i.problem.includes('amount unreadable'));

  return {
    entries,
    byGrantId,
    incomplete: Boolean(opts.incomplete) || hasUnreadableAmounts,
    incompleteReason: opts.incompleteReason
      ?? (hasUnreadableAmounts ? 'one or more historical payment amounts could not be read' : undefined),
    issues,
  };
}

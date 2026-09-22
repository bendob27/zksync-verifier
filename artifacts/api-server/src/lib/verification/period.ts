/**
 * Dates and schedule periods.
 *
 * The unlock schedule is laid out wide: one row per grant, one column per month, headed
 * "Mar 2026". A payment's instalment is therefore the cell where its grant's row meets
 * the column for the month of that payment's OWN event date (business rule R1).
 *
 * Two consequences drive this module:
 *   - The periods a run needs are derived from the batch's dates, never from the server
 *     clock. Re-running a batch from three months ago must read the same columns it read
 *     at the time.
 *   - A date that cannot be read unambiguously is rejected, not guessed. A payment whose
 *     date we cannot pin down cannot be matched to an instalment, and that is a review
 *     item rather than a silent pass.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** A calendar month, e.g. { year: 2026, month: 3 } for March 2026. `month` is 1-based. */
export interface Period {
  year: number;
  month: number;
}

/** A calendar date with no time or zone component. Dates here are wall-clock, never UTC instants. */
export interface PlainDate {
  year: number;
  month: number;
  day: number;
}

export type DateParse =
  | { ok: true; value: PlainDate }
  | { ok: false; reason: string };

/** "Mar 2026" — the exact form used as a schedule column header. */
export function periodLabel(p: Period): string {
  return `${MONTHS[p.month - 1]} ${p.year}`;
}

export function periodOf(d: PlainDate): Period {
  return { year: d.year, month: d.month };
}

export function periodKey(p: Period): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function comparePeriods(a: Period, b: Period): number {
  return a.year !== b.year ? a.year - b.year : a.month - b.month;
}

/** Steps forward or backward across a year boundary correctly. */
export function addMonths(p: Period, delta: number): Period {
  const zeroBased = p.year * 12 + (p.month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (((zeroBased % 12) + 12) % 12) + 1 };
}

/** Every period from `from` to `to` inclusive, ascending. */
export function periodRange(from: Period, to: Period): Period[] {
  if (comparePeriods(from, to) > 0) return [];
  const out: Period[] = [];
  let cur = from;
  while (comparePeriods(cur, to) <= 0) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

/**
 * The distinct periods a batch touches, ascending.
 *
 * A batch spanning a month end (30 Mar - 2 Apr) yields both months, so each row can be
 * checked against its own column. Derived purely from the supplied dates.
 */
export function periodsForDates(dates: PlainDate[]): Period[] {
  const seen = new Map<string, Period>();
  for (const d of dates) {
    const p = periodOf(d);
    seen.set(periodKey(p), p);
  }
  return [...seen.values()].sort(comparePeriods);
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1970 || y > 2999 || m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Read a date from a spreadsheet cell or upload.
 *
 * Accepts, in order of preference:
 *   - a JS Date (what ExcelJS hands back for a native date cell) — read in UTC, because
 *     ExcelJS materialises date serials at UTC midnight
 *   - ISO `YYYY-MM-DD`, optionally with a time part
 *   - `DD/MM/YYYY`, the custody export's convention, with `-` or `.` also accepted
 *
 * `dayFirst` controls the ambiguous `03/04/2026` case. It defaults to true because the
 * custody export is DD/MM/YYYY. When a value is unambiguous (a component above 12) the
 * flag is ignored and the unambiguous reading wins.
 */
export function parseDate(input: unknown, opts: { dayFirst?: boolean } = {}): DateParse {
  const dayFirst = opts.dayFirst ?? true;

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return { ok: false, reason: 'invalid Date object' };
    const value = {
      year: input.getUTCFullYear(),
      month: input.getUTCMonth() + 1,
      day: input.getUTCDate(),
    };
    return { ok: true, value };
  }

  if (typeof input === 'number') {
    return { ok: false, reason: `bare number is not an unambiguous date: ${input}` };
  }

  if (typeof input !== 'string') {
    return { ok: false, reason: `expected a date string or Date, got ${typeof input}` };
  }

  const raw = input.trim();
  if (raw === '') return { ok: false, reason: 'empty date' };

  // Strip a trailing time component: "17/03/2026, 00:00:00" or "2026-03-17T00:00:00Z"
  const datePart = raw.split(/[T,]/)[0].trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(datePart);
  if (iso) {
    const [, y, m, d] = iso.map(Number) as unknown as [string, number, number, number];
    if (!isValidYmd(y, m, d)) return { ok: false, reason: `not a real date: "${input}"` };
    return { ok: true, value: { year: y, month: m, day: d } };
  }

  const parts = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(datePart);
  if (parts) {
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    const year = Number(parts[3]);

    const aIsDay = a > 12;
    const bIsDay = b > 12;

    if (aIsDay && bIsDay) return { ok: false, reason: `not a real date: "${input}"` };

    let day: number;
    let month: number;
    if (aIsDay) {
      day = a;
      month = b;
    } else if (bIsDay) {
      day = b;
      month = a;
    } else {
      // Both components are 12 or under — genuinely ambiguous, resolved by convention.
      day = dayFirst ? a : b;
      month = dayFirst ? b : a;
    }

    if (!isValidYmd(year, month, day)) return { ok: false, reason: `not a real date: "${input}"` };
    return { ok: true, value: { year, month, day } };
  }

  return { ok: false, reason: `unrecognised date format: "${input}"` };
}

export function formatDate(d: PlainDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** Parse a schedule column header such as "Mar 2026" back into a period. */
export function parsePeriodLabel(label: string): Period | null {
  const m = /^([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(label.trim());
  if (!m) return null;
  const idx = MONTHS.findIndex((x) => x.toLowerCase() === m[1].slice(0, 3).toLowerCase());
  if (idx === -1) return null;
  return { year: Number(m[2]), month: idx + 1 };
}

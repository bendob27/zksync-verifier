import { describe, it, expect } from 'vitest';
import {
  parseDate, periodsForDates, periodLabel, periodOf, addMonths,
  periodRange, parsePeriodLabel, formatDate, comparePeriods,
} from './period';

function date(input: unknown, dayFirst?: boolean) {
  const r = parseDate(input, dayFirst === undefined ? {} : { dayFirst });
  if (!r.ok) throw new Error(`expected a date, got rejection: ${r.reason}`);
  return r.value;
}

function rejected(input: unknown): string {
  const r = parseDate(input);
  if (r.ok) throw new Error(`expected rejection, got ${formatDate(r.value)}`);
  return r.reason;
}

describe('parseDate', () => {
  it('reads the custody export DD/MM/YYYY convention, with or without a time part', () => {
    expect(formatDate(date('17/03/2026'))).toBe('2026-03-17');
    expect(formatDate(date('17/03/2026, 00:00:00'))).toBe('2026-03-17');
  });

  it('reads ISO dates', () => {
    expect(formatDate(date('2026-03-17'))).toBe('2026-03-17');
    expect(formatDate(date('2026-03-17T12:30:00Z'))).toBe('2026-03-17');
  });

  it('reads a native Date cell in UTC, so the day does not shift by timezone', () => {
    expect(formatDate(date(new Date(Date.UTC(2026, 2, 17))))).toBe('2026-03-17');
  });

  it('uses the unambiguous component when one is above 12, ignoring the convention flag', () => {
    expect(formatDate(date('25/03/2026', false))).toBe('2026-03-25');
    expect(formatDate(date('03/25/2026', true))).toBe('2026-03-25');
  });

  it('resolves a genuinely ambiguous date by the stated convention', () => {
    expect(formatDate(date('03/04/2026', true))).toBe('2026-04-03');
    expect(formatDate(date('03/04/2026', false))).toBe('2026-03-04');
  });

  it('rejects rather than coercing', () => {
    expect(rejected('31/02/2026')).toMatch(/not a real date/);
    expect(rejected('')).toMatch(/empty/);
    expect(rejected(45000)).toMatch(/unambiguous/);
    expect(rejected('next tuesday')).toMatch(/unrecognised/);
  });
});

describe('periods are derived from the batch, never from the clock', () => {
  it('gives each row of a month-straddling batch its own period', () => {
    // CW14: 30 Mar - 2 Apr. Rule R1: each row is judged against its own month.
    const periods = periodsForDates([date('30/03/2026'), date('02/04/2026')]);
    expect(periods.map(periodLabel)).toEqual(['Mar 2026', 'Apr 2026']);
  });

  it('resolves a historical batch to its own months, not today\'s', () => {
    const periods = periodsForDates([date('15/01/2024'), date('20/01/2024')]);
    expect(periods.map(periodLabel)).toEqual(['Jan 2024']);
  });

  it('deduplicates and sorts ascending', () => {
    const periods = periodsForDates([date('20/05/2026'), date('01/02/2026'), date('03/05/2026')]);
    expect(periods.map(periodLabel)).toEqual(['Feb 2026', 'May 2026']);
  });

  it('returns nothing for an empty batch', () => {
    expect(periodsForDates([])).toEqual([]);
  });
});

describe('year boundaries', () => {
  it('steps from December into January of the next year', () => {
    expect(periodLabel(addMonths({ year: 2026, month: 12 }, 1))).toBe('Jan 2027');
  });

  it('steps backwards from January into the previous December', () => {
    expect(periodLabel(addMonths({ year: 2026, month: 1 }, -1))).toBe('Dec 2025');
  });

  it('builds an inclusive range across a year boundary', () => {
    const range = periodRange({ year: 2026, month: 11 }, { year: 2027, month: 2 });
    expect(range.map(periodLabel)).toEqual(['Nov 2026', 'Dec 2026', 'Jan 2027', 'Feb 2027']);
  });

  it('orders periods across years correctly', () => {
    expect(comparePeriods({ year: 2025, month: 12 }, { year: 2026, month: 1 })).toBeLessThan(0);
  });
});

describe('schedule column headers', () => {
  it('round-trips a label', () => {
    expect(parsePeriodLabel('Mar 2026')).toEqual({ year: 2026, month: 3 });
    expect(periodLabel(periodOf(date('17/03/2026')))).toBe('Mar 2026');
  });

  it('tolerates longer month names and stray punctuation', () => {
    expect(parsePeriodLabel('March 2026')).toEqual({ year: 2026, month: 3 });
    expect(parsePeriodLabel('Sept. 2026')).toEqual({ year: 2026, month: 9 });
  });

  it('returns null for something that is not a period header', () => {
    expect(parsePeriodLabel('Total Tokens')).toBeNull();
  });
});

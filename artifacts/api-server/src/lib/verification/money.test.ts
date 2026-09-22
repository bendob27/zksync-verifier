import { describe, it, expect } from 'vitest';
import { parseTokens, tokensToString, formatTokens, SCALE } from './money';

function parsed(input: unknown): string {
  const r = parseTokens(input);
  if (!r.ok) throw new Error(`expected a value, got rejection: ${r.reason}`);
  return tokensToString(r.value);
}

function rejection(input: unknown): string {
  const r = parseTokens(input);
  if (r.ok) throw new Error(`expected a rejection, got ${tokensToString(r.value)}`);
  return r.reason;
}

describe('parseTokens — European decimal comma', () => {
  // The previous parser stripped a lone comma as a thousands separator, turning
  // "999,99" into 99999 — a 100x inflation on any sub-1000 amount.
  it('reads a comma decimal with no grouping as a fraction, not a separator', () => {
    expect(parsed('999,99')).toBe('999.99');
    expect(parsed('12,75')).toBe('12.75');
    expect(parsed('1,5')).toBe('1.5');
  });

  it('reads dot-grouped comma-decimal amounts', () => {
    expect(parsed('123.456,78')).toBe('123456.78');
    expect(parsed('2.345.678,901')).toBe('2345678.901');
  });
});

describe('parseTokens — anglophone formats', () => {
  it('reads a plain decimal point', () => {
    expect(parsed('123456.78')).toBe('123456.78');
    expect(parsed(123456.78)).toBe('123456.78');
  });

  it('reads comma-grouped dot-decimal amounts', () => {
    expect(parsed('1,234,567.89')).toBe('1234567.89');
  });
});

describe('parseTokens — grouping that could be mistaken for a decimal', () => {
  it('treats a well-formed three-digit group as grouping', () => {
    expect(parsed('1.000')).toBe('1000');
    expect(parsed('1,000')).toBe('1000');
    expect(parsed('1.234.567')).toBe('1234567');
  });
});

describe('parseTokens — rejects rather than guesses', () => {
  it('rejects values that are not numeric', () => {
    expect(rejection('abc')).toMatch(/numeric/);
    expect(rejection('')).toMatch(/empty/);
    expect(rejection(null)).toMatch(/number or string/);
    expect(rejection(undefined)).toMatch(/number or string/);
  });

  it('rejects non-finite numbers instead of coercing them to zero', () => {
    expect(rejection(Number.NaN)).toMatch(/finite/);
    expect(rejection(Number.POSITIVE_INFINITY)).toMatch(/finite/);
  });

  it('rejects precision it cannot represent exactly', () => {
    expect(rejection('1.123456789')).toMatch(/decimal places/);
  });

  it('rejects malformed grouping', () => {
    expect(rejection('1.23.456')).toMatch(/grouping/);
  });
});

describe('exactness', () => {
  it('holds values that float arithmetic would drift on', () => {
    const a = parseTokens('0.1');
    const b = parseTokens('0.2');
    if (!a.ok || !b.ok) throw new Error('setup failed');
    expect(tokensToString(a.value + b.value)).toBe('0.3');
    // for contrast: 0.1 + 0.2 !== 0.3 in IEEE doubles
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('uses eight decimal places of scale', () => {
    expect(SCALE).toBe(100000000n);
  });

  it('formats for display with thousands separators', () => {
    const r = parseTokens('2345678.901');
    if (!r.ok) throw new Error('setup failed');
    expect(formatTokens(r.value)).toBe('2,345,678.901');
  });
});

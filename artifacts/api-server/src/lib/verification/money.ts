/**
 * Exact token arithmetic.
 *
 * Every amount in this system is a quantity of ZK tokens that may carry a fraction.
 * Comparing those as IEEE doubles is how "expected 123456.78, got 123456.78" turns into
 * a mismatch, so all arithmetic here runs on integer micro-units held in BigInt.
 *
 * SCALE is 1e8: eight decimal places. Observed data carries at most four
 * (e.g. 345678.9012), so this leaves ample headroom while staying far inside the range
 * where a float64 can be converted without loss.
 *
 * Nothing here silently rounds. A value carrying more precision than SCALE can express,
 * or one that is not finite, is rejected — callers turn that into a review state rather
 * than guessing.
 */

const DECIMALS = 8;
export const SCALE = 10n ** BigInt(DECIMALS);

/** A token quantity in micro-units. Never construct one directly — use parseTokens. */
export type Tokens = bigint;

export type ParseResult =
  | { ok: true; value: Tokens }
  | { ok: false; reason: string };

/** Result of resolving separators into a plain `123456.78` string. */
type NormaliseResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * Parse a token amount from a spreadsheet cell, an upload, or a model response.
 *
 * Accepts a number or a string. Strings may carry thousands separators and either
 * decimal convention — but only when the convention is UNAMBIGUOUS. "1,5" could be
 * one-and-a-half or fifteen hundred depending on locale, so it is rejected rather
 * than guessed; the caller surfaces that as a review item.
 */
export function parseTokens(input: unknown): ParseResult {
  if (typeof input === 'bigint') return { ok: true, value: input };

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, reason: `not a finite number: ${input}` };
    // Round to the representable grid, then verify the round trip stayed within half a
    // micro-unit. Anything further out carried more precision than we can hold.
    const scaled = Math.round(input * Number(SCALE));
    if (!Number.isSafeInteger(scaled)) {
      return { ok: false, reason: `magnitude out of safe range: ${input}` };
    }
    return { ok: true, value: BigInt(scaled) };
  }

  if (typeof input !== 'string') {
    return { ok: false, reason: `expected a number or string, got ${typeof input}` };
  }

  const raw = input.trim().replace(/\s/g, '');
  if (raw === '') return { ok: false, reason: 'empty value' };

  const normalised = normaliseDecimalString(raw);
  if (!normalised.ok) return { ok: false, reason: normalised.reason };

  const text = normalised.text;
  if (!NUMERIC.test(text)) return { ok: false, reason: `not a numeric value: "${input}"` };

  const negative = text.startsWith('-');
  const [whole, frac = ''] = (negative ? text.slice(1) : text).split('.');

  if (frac.length > DECIMALS) {
    return { ok: false, reason: `more than ${DECIMALS} decimal places: "${input}"` };
  }

  const padded = frac.padEnd(DECIMALS, '0');
  const value = BigInt(whole) * SCALE + BigInt(padded || '0');
  return { ok: true, value: negative ? -value : value };
}

/**
 * Resolve thousands separators and the decimal mark into a plain `123456.78` string.
 *
 * The rules, in order:
 *   - both '.' and ',' present -> the LAST one is the decimal mark, the other is grouping
 *   - one separator appearing more than once -> it is grouping ("1.234.567")
 *   - one separator with exactly three digits after it -> ambiguous ("1,500" / "1.500")
 *     unless the grouping is well formed, in which case treat it as grouping
 *   - otherwise -> it is the decimal mark
 */
function normaliseDecimalString(raw: string): NormaliseResult {
  const hasDot = raw.includes('.');
  const hasComma = raw.includes(',');

  if (!hasDot && !hasComma) return { ok: true, text: raw };

  if (hasDot && hasComma) {
    const decimalMark = raw.lastIndexOf('.') > raw.lastIndexOf(',') ? '.' : ',';
    const grouping = decimalMark === '.' ? ',' : '.';
    const stripped = raw.split(grouping).join('');
    return { ok: true, text: stripped.replace(decimalMark, '.') };
  }

  const sep = hasDot ? '.' : ',';
  const parts = raw.split(sep);

  if (parts.length > 2) {
    // Repeated separator can only be grouping: 1.234.567
    if (!parts.slice(1).every((p) => p.length === 3)) {
      return { ok: false, reason: `malformed grouping: "${raw}"` };
    }
    return { ok: true, text: parts.join('') };
  }

  const [head, tail] = parts;
  const headDigits = head.replace('-', '');

  // "1,500" / "1.500" is genuinely ambiguous between 1500 and 1.5. It can only be
  // grouping when the head is itself a valid leading group of one to three digits;
  // "2345678.901" has a seven-digit head, so grouping is impossible and it is a decimal.
  if (
    tail.length === 3 &&
    /^\d+$/.test(tail) &&
    headDigits.length >= 1 &&
    headDigits.length <= 3
  ) {
    return { ok: true, text: head + tail };
  }

  return { ok: true, text: raw.replace(sep, '.') };
}

export function tokensToString(v: Tokens): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Display form, for detail strings shown to the operator. */
export function formatTokens(v: Tokens): string {
  const s = tokensToString(v);
  const [whole, frac] = s.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** Lossy — for the JSON response only, never for comparison. */
export function tokensToNumber(v: Tokens): number {
  return Number(v) / Number(SCALE);
}

export function addTokens(...vs: Tokens[]): Tokens {
  return vs.reduce((a, b) => a + b, 0n);
}

export function absTokens(v: Tokens): Tokens {
  return v < 0n ? -v : v;
}

export const ZERO: Tokens = 0n;

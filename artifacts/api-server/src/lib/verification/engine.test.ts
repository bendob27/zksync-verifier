import { describe, it, expect } from 'vitest';
import { verifyBatch, fingerprint, mintPaymentId, describeRun, periodsRequired } from './engine';
import { buildScheduleIndex, buildHistoryIndex, type CustodyQueue } from './sources';
import { parseTokens, type Tokens } from './money';
import { parseDate, periodLabel } from './period';
import type { GrantResolution } from './checks';
import type { PaymentIdentity } from './model';

const tok = (v: string | number): Tokens => {
  const r = parseTokens(v);
  if (!r.ok) throw new Error('bad amount');
  return r.value;
};

const schedule = buildScheduleIndex(
  [{ grantId: 'ACM001', granteeName: 'Acme Labs', totalTokens: 100000, instalments: [{ period: { year: 2026, month: 6 }, value: 100 }], sourceRef: 'schedule row 2' }],
  [{ year: 2026, month: 6 }],
);

function payment(amount = 100, recipient = 'Acme Labs', notes?: string): PaymentIdentity {
  const d = parseDate('15/06/2026');
  return {
    paymentId: 'p1', rowNumber: 2, grantRef: 'ACM001', recipient,
    amount: tok(amount), date: d.ok ? d.value : null, rawDate: '15/06/2026', notes,
  };
}

function resolutions(p: PaymentIdentity): Map<string, GrantResolution> {
  return new Map([[p.paymentId, { paymentId: p.paymentId, status: 'resolved', row: schedule.rows[0], basis: 'exact' }]]);
}

function queueFor(amount: number, recipient = 'Acme Labs'): CustodyQueue {
  const d = parseDate('15/06/2026');
  return {
    lines: [{ lineId: 'l1', recipient, amount: tok(amount), date: d.ok ? d.value : null, sourceRef: 'screenshot 1' }],
    incomplete: false, issues: [],
  };
}

function run(p: PaymentIdentity, queue: CustodyQueue | null, extra: Partial<Parameters<typeof verifyBatch>[0]> = {}) {
  return verifyBatch({
    payments: [p],
    schedule,
    history: buildHistoryIndex([]),
    queue,
    resolutions: resolutions(p),
    cumulativePeriodsComplete: true,
    now: '2026-06-20T10:00:00.000Z',
    runId: 'run-1',
    appVersion: '1.0.0-test',
    sourceFingerprints: { unlockSchedule: 'abc', paymentHistory: 'def' },
    ...extra,
  });
}

describe('a batch is only cleared when every required check actually passed', () => {
  it('clears a fully correct batch', () => {
    const r = run(payment(), queueFor(100));
    expect(r.summary.allRequiredChecksPassed).toBe(true);
    expect(r.summary.passed).toBe(1);
  });

  it('does not clear a batch when the queue was never supplied', () => {
    const r = run(payment(), null);
    expect(r.summary.allRequiredChecksPassed).toBe(false);
    expect(r.summary.needsReview).toBe(1);
  });

  it('does not clear a batch when a source was degraded', () => {
    const r = run(payment(), queueFor(100), { degradations: ['payment history truncated at row 2000'] });
    expect(r.summary.allRequiredChecksPassed).toBe(false);
    expect(r.provenance.degradations).toContain('payment history truncated at row 2000');
  });

  it('does not clear a batch when an unexpected transaction sits in the queue', () => {
    const d = parseDate('15/06/2026');
    const queue: CustodyQueue = {
      lines: [
        { lineId: 'l1', recipient: 'Acme Labs', amount: tok(100), date: d.ok ? d.value : null, sourceRef: 's1' },
        { lineId: 'l2', recipient: 'Ghost Corp', amount: tok(5000), date: d.ok ? d.value : null, sourceRef: 's1' },
      ],
      incomplete: false, issues: [],
    };
    const r = run(payment(), queue);
    expect(r.summary.allRequiredChecksPassed).toBe(false);
    expect(r.queueFindings.some((f) => f.outcome === 'FAIL' && f.detail.includes('Ghost Corp'))).toBe(true);
  });
});

describe('20. the summary agrees with the per-payment results', () => {
  it('never lists a recipient as cleared while that recipient has a failing payment', () => {
    const r = run(payment(999), queueFor(999)); // amount does not match the instalment
    const text = describeRun(r);
    expect(r.summary.allRequiredChecksPassed).toBe(false);
    expect(text).toMatch(/NOT CLEARED/);
    expect(text).toContain('Acme Labs');
    expect(text).not.toMatch(/All required checks passed/);
  });

  it('reports an excluded payment as excluded, not as a pass and not as a failure', () => {
    const r = run(payment(100, 'Acme Labs', 'PAUSE'), queueFor(100));
    expect(r.summary.excluded).toBe(1);
    expect(r.summary.passed).toBe(0);
    expect(describeRun(r)).toMatch(/Excluded \(still present in the custody queue\)/);
  });
});

describe('21. a change to a source invalidates an earlier result', () => {
  it('produces a different fingerprint when the schedule changes', () => {
    const before = fingerprint([{ grantId: 'ACM001', jun: 100 }]);
    const after = fingerprint([{ grantId: 'ACM001', jun: 250 }]);
    expect(before).not.toBe(after);
  });

  it('is stable for identical input, so an unchanged source compares equal', () => {
    expect(fingerprint([{ a: 1 }])).toBe(fingerprint([{ a: 1 }]));
  });

  it('records what the run was computed from', () => {
    const r = run(payment(), queueFor(100));
    expect(r.provenance.runId).toBe('run-1');
    expect(r.provenance.verifiedAt).toBe('2026-06-20T10:00:00.000Z');
    expect(r.provenance.appVersion).toBe('1.0.0-test');
    expect(r.provenance.periodsLoaded).toEqual(['2026-06']);
    expect(r.provenance.sources.unlockSchedule).toBe('abc');
  });
});

describe('payment identity', () => {
  it('mints a stable id for identical rows and a different one for different rows', () => {
    const a = mintPaymentId(2, 'ACM001', '100', '15/06/2026');
    expect(mintPaymentId(2, 'ACM001', '100', '15/06/2026')).toBe(a);
    expect(mintPaymentId(3, 'ACM001', '100', '15/06/2026')).not.toBe(a);
    expect(mintPaymentId(2, 'ACM001', '101', '15/06/2026')).not.toBe(a);
  });
});

describe('the periods a run must load', () => {
  it('takes them from the batch, and reports the latest for the scheduled-to-date total', () => {
    const d1 = parseDate('30/03/2026');
    const d2 = parseDate('02/04/2026');
    if (!d1.ok || !d2.ok) throw new Error('setup');
    const { batchPeriods, latest } = periodsRequired([d1.value, d2.value]);
    expect(batchPeriods.map(periodLabel)).toEqual(['Mar 2026', 'Apr 2026']);
    expect(periodLabel(latest!)).toBe('Apr 2026');
  });

  it('ignores rows whose date could not be read', () => {
    const d = parseDate('15/06/2026');
    if (!d.ok) throw new Error('setup');
    const { batchPeriods } = periodsRequired([d.value, null]);
    expect(batchPeriods.map(periodLabel)).toEqual(['Jun 2026']);
  });
});

import { describe, it, expect } from 'vitest';
import { runChecks, toleranceFrom, type GrantResolution } from './checks';
import { buildScheduleIndex, buildHistoryIndex, type ScheduleRow } from './sources';
import { parseTokens, type Tokens } from './money';
import { parseDate, periodOf, type Period } from './period';
import type { CheckId, Outcome, PaymentIdentity, PaymentResult } from './model';

// ── scenario builder ─────────────────────────────────────────────────────────

const tok = (v: string | number): Tokens => {
  const r = parseTokens(v);
  if (!r.ok) throw new Error(`bad test amount ${v}: ${r.reason}`);
  return r.value;
};

const period = (label: string): Period => {
  const [m, y] = label.split(' ');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return { year: Number(y), month: months.indexOf(m) + 1 };
};

interface GrantSpec {
  grantId: string;
  grantee: string;
  total?: string | number | null;
  instalments: Record<string, string | number>;
}

interface PaymentSpec {
  grantRef: string;
  recipient: string;
  amount: string | number;
  date: string;
  status?: string;
  notes?: string;
}

function scenario(opts: {
  grants: GrantSpec[];
  payments: PaymentSpec[];
  history?: Array<{ grantId: string; amount: string | number; date: string }>;
  historyIncomplete?: boolean;
  periodsLoaded?: string[];
  cumulativeComplete?: boolean;
  /** Override identity resolution, e.g. to simulate an ambiguous or invented AI match. */
  resolve?: (p: PaymentIdentity, rows: ScheduleRow[]) => GrantResolution;
}): PaymentResult[] {
  const allPeriods = opts.periodsLoaded
    ?? [...new Set(opts.grants.flatMap((g) => Object.keys(g.instalments)))];

  const schedule = buildScheduleIndex(
    opts.grants.map((g, i) => ({
      grantId: g.grantId,
      granteeName: g.grantee,
      totalTokens: g.total === undefined ? null : g.total,
      instalments: Object.entries(g.instalments).map(([label, value]) => ({ period: period(label), value })),
      sourceRef: `schedule row ${i + 2}`,
    })),
    allPeriods.map(period),
  );

  const history = buildHistoryIndex(
    (opts.history ?? []).map((h, i) => ({ ...h, sourceRef: `history row ${i + 2}` })),
    opts.historyIncomplete ? { incomplete: true, incompleteReason: 'fetch failed' } : {},
  );

  const payments: PaymentIdentity[] = opts.payments.map((p, i) => {
    const d = parseDate(p.date);
    return {
      paymentId: `row-${i + 1}`,
      rowNumber: i + 2,
      grantRef: p.grantRef,
      recipient: p.recipient,
      amount: tok(p.amount),
      date: d.ok ? d.value : null,
      rawDate: p.date,
      status: p.status,
      notes: p.notes,
    };
  });

  const resolutions = new Map<string, GrantResolution>();
  for (const p of payments) {
    if (opts.resolve) {
      resolutions.set(p.paymentId, opts.resolve(p, schedule.rows));
      continue;
    }
    const matches = schedule.rows.filter(
      (r) => r.grantId.toLowerCase() === p.grantRef.toLowerCase(),
    );
    resolutions.set(p.paymentId, matches.length === 1
      ? { paymentId: p.paymentId, status: 'resolved', row: matches[0], basis: 'exact grant id' }
      : matches.length === 0
        ? { paymentId: p.paymentId, status: 'not-found', basis: 'no row with that grant id' }
        : { paymentId: p.paymentId, status: 'ambiguous', candidates: matches, basis: 'several rows share that grant id' });
  }

  return runChecks({
    payments,
    resolutions,
    schedule,
    history,
    tolerance: toleranceFrom(0.001, 1000),
    cumulativePeriodsComplete: opts.cumulativeComplete ?? true,
  });
}

const outcomeOf = (r: PaymentResult, id: CheckId): Outcome | undefined =>
  r.checks.find((c) => c.id === id)?.outcome;

// ── the required scenarios ───────────────────────────────────────────────────

describe('1. a correct payment passes', () => {
  it('passes every required check', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 1000, instalments: { 'Jun 2026': 100 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '15/06/2026' }],
    });
    expect(r.outcome).toBe('PASS');
    expect(r.checks.every((c) => c.outcome === 'PASS')).toBe(true);
  });
});

describe('2. right amount, wrong month must not pass', () => {
  // The brief's example: June instalment 100, July 200, a payment of 200 dated in June.
  it('fails because June schedules 100, not 200', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10000, instalments: { 'Jun 2026': 100, 'Jul 2026': 200 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 200, date: '15/06/2026' }],
    });
    expect(r.outcome).toBe('FAIL');
    expect(outcomeOf(r, 'amountMatches')).toBe('FAIL');
  });

  it('fails when nothing at all is scheduled for the payment\'s month', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10000, instalments: { 'Jun 2026': 100 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '15/08/2026' }],
      periodsLoaded: ['Jun 2026', 'Aug 2026'],
    });
    expect(outcomeOf(r, 'instalmentScheduled')).toBe('FAIL');
    expect(r.outcome).toBe('FAIL');
  });
});

describe('3. amount and date cannot be taken from different schedule rows', () => {
  // The old reference engine picked the closest-amount row for the amount check and the
  // closest-date row for the timing check, so 5,000 dated July passed against June's 5,000.
  it('does not pass 5,000 in July when July schedules 7,000 and June schedules 5,000', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 100000, instalments: { 'Jun 2026': 5000, 'Jul 2026': 7000 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 5000, date: '01/07/2026' }],
    });
    expect(r.outcome).toBe('FAIL');
    expect(outcomeOf(r, 'amountMatches')).toBe('FAIL');
    expect(r.checks.find((c) => c.id === 'amountMatches')!.detail).toContain('7,000');
  });
});

describe('4. duplicate rows within one upload are detected', () => {
  it('flags identical rows for review rather than passing both', () => {
    const results = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10000, instalments: { 'Jun 2026': 200 } }],
      payments: [
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '15/06/2026' },
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '15/06/2026' },
      ],
    });
    expect(results.every((r) => outcomeOf(r, 'notDuplicated') === 'NEEDS_REVIEW')).toBe(true);
    expect(results.every((r) => r.outcome !== 'PASS')).toBe(true);
  });
});

describe('5. individually acceptable payments that collectively breach a cap fail', () => {
  // The brief's example: cap 100, already paid 80, two proposed payments of 15.
  it('fails both rows because 80 + 15 + 15 exceeds the cap of 100', () => {
    const results = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 100, instalments: { 'Jun 2026': 30 } }],
      payments: [
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 15, date: '10/06/2026' },
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 15, date: '20/06/2026' },
      ],
      history: [{ grantId: 'ACM001', amount: 80, date: '10/05/2026' }],
    });
    expect(results.every((r) => outcomeOf(r, 'withinGrantCap') === 'FAIL')).toBe(true);
    expect(results.every((r) => r.outcome === 'FAIL')).toBe(true);
    expect(results[0].checks.find((c) => c.id === 'withinGrantCap')!.detail).toContain('110');
  });
});

describe('6. previously paid amounts are accounted for', () => {
  it('fails a payment already present in the payment history', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10000, instalments: { 'Jun 2026': 100 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '15/06/2026' }],
      history: [{ grantId: 'ACM001', amount: 100, date: '15/06/2026' }],
    });
    expect(outcomeOf(r, 'notDuplicated')).toBe('FAIL');
  });

  it('will not claim a duplicate was ruled out when the history is incomplete', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10000, instalments: { 'Jun 2026': 100 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '15/06/2026' }],
      historyIncomplete: true,
    });
    expect(outcomeOf(r, 'notDuplicated')).toBe('NEEDS_REVIEW');
    expect(outcomeOf(r, 'withinGrantCap')).toBe('NEEDS_REVIEW');
    expect(r.outcome).not.toBe('PASS');
  });
});

describe('7. several payments sharing a grant id keep separate results', () => {
  it('does not let one row overwrite another', () => {
    const results = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 100000, instalments: { 'Jun 2026': 100, 'Jul 2026': 500 } }],
      payments: [
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '15/06/2026' },
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 999, date: '15/07/2026' },
      ],
    });
    expect(results).toHaveLength(2);
    expect(outcomeOf(results[0], 'amountMatches')).toBe('PASS');
    expect(outcomeOf(results[1], 'amountMatches')).toBe('FAIL');
  });
});

describe('8. an invented or ambiguous match cannot pass', () => {
  it('treats an ambiguous resolution as needing review', () => {
    const [r] = scenario({
      grants: [
        { grantId: 'ACM001', grantee: 'Acme Labs', total: 1000, instalments: { 'Jun 2026': 100 } },
        { grantId: 'ACM001', grantee: 'Acme Holdings', total: 1000, instalments: { 'Jun 2026': 100 } },
      ],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '15/06/2026' }],
    });
    expect(outcomeOf(r, 'grantResolved')).toBe('NEEDS_REVIEW');
    expect(r.outcome).not.toBe('PASS');
  });

  it('fails a grant reference that exists in no schedule row', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 1000, instalments: { 'Jun 2026': 100 } }],
      payments: [{ grantRef: 'GHOST9', recipient: 'Nobody', amount: 100, date: '15/06/2026' }],
    });
    expect(outcomeOf(r, 'grantResolved')).toBe('FAIL');
    expect(r.outcome).toBe('FAIL');
  });

  it('cannot be made to pass by a resolver that points at an unrelated row', () => {
    // Simulates a model confidently returning the wrong row. The deterministic checks
    // still read that row's real values, so the payment cannot pass.
    const [r] = scenario({
      grants: [
        { grantId: 'ACM001', grantee: 'Acme Labs', total: 1000, instalments: { 'Jun 2026': 100 } },
        { grantId: 'NWD014', grantee: 'Northwind', total: 999999, instalments: { 'Jun 2026': 50000 } },
      ],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 50000, date: '15/06/2026' }],
      resolve: (p, rows) => ({
        paymentId: p.paymentId, status: 'resolved',
        row: rows.find((x) => x.grantId === 'NWD014')!, basis: 'model proposed this row',
      }),
    });
    // The recipient no longer matches the row the model chose, so it is caught.
    expect(outcomeOf(r, 'recipientMatches')).toBe('FAIL');
    expect(r.outcome).toBe('FAIL');
  });
});

describe('9. a model-supplied amount cannot override the source amount', () => {
  it('reads the expected amount from the schedule row, not from any proposal', () => {
    // Whatever a model might assert, the comparison uses the cell.
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10000, instalments: { 'Jun 2026': 100 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 5000, date: '15/06/2026' }],
    });
    const amount = r.checks.find((c) => c.id === 'amountMatches')!;
    expect(amount.outcome).toBe('FAIL');
    expect(amount.evidence?.expectedTokens).toBe(tok(100));
    expect(amount.evidence?.source).toContain('schedule row');
  });
});

describe('11. missing source data prevents a pass', () => {
  it('cannot confirm the cap when the schedule gives no total', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: null, instalments: { 'Jun 2026': 100 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '15/06/2026' }],
    });
    expect(outcomeOf(r, 'withinGrantCap')).toBe('NEEDS_REVIEW');
    expect(r.outcome).toBe('NEEDS_REVIEW');
  });

  it('cannot total the scheduled-to-date limit when earlier columns were not loaded', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10000, instalments: { 'Jun 2026': 100 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '15/06/2026' }],
      cumulativeComplete: false,
    });
    expect(outcomeOf(r, 'withinScheduledToDate')).toBe('NEEDS_REVIEW');
    expect(r.outcome).not.toBe('PASS');
  });

  it('cannot identify an instalment when the payment date is unreadable', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10000, instalments: { 'Jun 2026': 100 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: 'sometime in June' }],
    });
    expect(outcomeOf(r, 'instalmentScheduled')).toBe('NEEDS_REVIEW');
    expect(r.outcome).not.toBe('PASS');
  });
});

describe('12. month and year boundaries use the correct column', () => {
  it('judges each row of a month-straddling batch against its own month', () => {
    const results = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 100000, instalments: { 'Mar 2026': 100, 'Apr 2026': 200 } }],
      payments: [
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '30/03/2026' },
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 200, date: '02/04/2026' },
      ],
    });
    expect(results.every((r) => outcomeOf(r, 'amountMatches') === 'PASS')).toBe(true);
  });

  it('crosses a year boundary correctly', () => {
    const results = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 100000, instalments: { 'Dec 2026': 100, 'Jan 2027': 200 } }],
      payments: [
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '31/12/2026' },
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 200, date: '02/01/2027' },
      ],
    });
    expect(results.every((r) => outcomeOf(r, 'amountMatches') === 'PASS')).toBe(true);
  });

  it('verifies a historical batch against its own period, not the present one', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 100000, instalments: { 'Jan 2024': 750 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 750, date: '15/01/2024' }],
    });
    expect(r.outcome).toBe('PASS');
  });
});

describe('13. similar recipient names do not produce a match', () => {
  it('fails an unrelated recipient', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 1000, instalments: { 'Jun 2026': 100 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Northwind', amount: 100, date: '15/06/2026' }],
    });
    expect(outcomeOf(r, 'recipientMatches')).toBe('FAIL');
  });

  it('asks for review on a partial name match instead of accepting it', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs Holdings', total: 1000, instalments: { 'Jun 2026': 100 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '15/06/2026' }],
    });
    expect(outcomeOf(r, 'recipientMatches')).toBe('NEEDS_REVIEW');
    expect(r.outcome).toBe('NEEDS_REVIEW');
  });
});

describe('18. paused rows still in the queue are flagged, not dropped', () => {
  it('marks them excluded with a reason rather than silently removing them', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 1000, instalments: { 'Jun 2026': 100 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '15/06/2026', notes: 'PAUSE' }],
    });
    expect(r.outcome).toBe('EXCLUDED');
    expect(r.exclusionReason).toContain('PAUSE');
    expect(r.checks[0].detail).toMatch(/still present in the custody queue/i);
  });
});

describe('19. tolerance boundaries behave as approved', () => {
  it('passes only an exact match', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10_000_000, instalments: { 'Jun 2026': 1_000_000 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 1_000_000, date: '15/06/2026' }],
    });
    expect(outcomeOf(r, 'amountMatches')).toBe('PASS');
  });

  it('asks for review inside both bounds rather than passing silently', () => {
    // 500 out of 1,000,000 is 0.05% and under 1000 tokens: inside both bounds.
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10_000_000, instalments: { 'Jun 2026': 1_000_000 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 1_000_500, date: '15/06/2026' }],
    });
    expect(outcomeOf(r, 'amountMatches')).toBe('NEEDS_REVIEW');
  });

  it('fails when only one bound holds', () => {
    // 900 out of 100,000 is 0.9% — inside the absolute bound but outside the relative one.
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10_000_000, instalments: { 'Jun 2026': 100_000 } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100_900, date: '15/06/2026' }],
    });
    expect(outcomeOf(r, 'amountMatches')).toBe('FAIL');
  });

  it('compares fractional amounts exactly', () => {
    const [r] = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10_000_000, instalments: { 'Jun 2026': '123456.78' } }],
      payments: [{ grantRef: 'ACM001', recipient: 'Acme Labs', amount: '123456.78', date: '15/06/2026' }],
    });
    expect(outcomeOf(r, 'amountMatches')).toBe('PASS');
  });
});

describe('R3 — splitting an instalment across rows', () => {
  it('passes when the rows sum to the scheduled amount', () => {
    const results = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10000, instalments: { 'Jun 2026': 300 } }],
      payments: [
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '10/06/2026' },
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 200, date: '20/06/2026' },
      ],
    });
    expect(results.every((r) => outcomeOf(r, 'amountMatches') === 'PASS')).toBe(true);
    expect(results.every((r) => r.outcome === 'PASS')).toBe(true);
  });

  it('fails every row of a split that overshoots the instalment', () => {
    const results = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 10000, instalments: { 'Jun 2026': 300 } }],
      payments: [
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 200, date: '10/06/2026' },
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 200, date: '20/06/2026' },
      ],
    });
    expect(results.every((r) => outcomeOf(r, 'amountMatches') === 'FAIL')).toBe(true);
  });
});

describe('R4b — paying ahead of schedule', () => {
  it('fails a payment that pulls a later instalment forward', () => {
    // June schedules 100 and July 200. Paying 300 in June is within the lifetime cap
    // but ahead of what is scheduled by June.
    const results = scenario({
      grants: [{ grantId: 'ACM001', grantee: 'Acme Labs', total: 100000, instalments: { 'Jun 2026': 100, 'Jul 2026': 200 } }],
      payments: [
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 100, date: '10/06/2026' },
        { grantRef: 'ACM001', recipient: 'Acme Labs', amount: 200, date: '20/06/2026' },
      ],
    });
    expect(results.some((r) => outcomeOf(r, 'withinScheduledToDate') === 'FAIL')).toBe(true);
  });
});

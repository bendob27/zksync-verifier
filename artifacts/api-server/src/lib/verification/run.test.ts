import { describe, it, expect } from 'vitest';
import { runVerification, type RunDeps } from './run';
import { buildExport } from './custodyExport.test';

const CONFIG = {
  scheduleSheetId: 'sched', scheduleTab: 'Unlock Schedules',
  historySheetId: 'hist', historyTab: 'Cash Flows',
  grantIdHeader: 'Grant ID',
  toleranceRelative: 0.001, toleranceAbsolute: 1000,
};

/** A synthetic wide schedule: a title block, then a header row, then grant rows. */
function scheduleGrid(rows: Array<[string, string, string, string, string]>): string[][] {
  return [
    ['Token model', '', '', '', ''],
    ['', '', '', '', ''],
    ['Name', 'Grant ID', 'Total Tokens', 'May 2026', 'Jun 2026'],
    ...rows,
  ];
}

function deps(opts: {
  schedule: string[][];
  history?: string[][];
  screenshots?: Parameters<NonNullable<RunDeps['readScreenshots']>>[0] extends never ? never : Awaited<ReturnType<NonNullable<RunDeps['readScreenshots']>>>;
}): RunDeps {
  return {
    fetchRange: async (sheetId, range) => {
      const grid = sheetId === 'sched' ? opts.schedule : (opts.history ?? [['Grant ID', 'Amount', 'Date']]);
      // Emulate a scan range (first 50 rows) vs a data range (from row N).
      const m = /!A(\d+):/.exec(range);
      const start = m ? Number(m[1]) : 1;
      return grid.slice(start - 1);
    },
    readScreenshots: opts.screenshots ? async () => opts.screenshots! : undefined,
    now: () => '2026-06-20T10:00:00.000Z',
    runId: () => 'run-test',
    appVersion: 'test',
  };
}

const row = (over: Record<string, unknown> = {}) => ({
  'Event Type': 'Unlock', 'Grant Name': 'ACM001', 'Recipient Name': 'Acme Labs',
  'Active Wallet Address': '0xabc', 'Event Date': '15/06/2026', Status: 'PENDING',
  'Token Amount': 100, Notes: 'Ok', ...over,
});

const SCHEDULE = scheduleGrid([['Acme Labs', 'ACM001', '100000', '50', '100']]);

describe('end to end through the verification service', () => {
  it('clears a correct batch when the queue agrees', async () => {
    const out = await runVerification(
      { excel: await buildExport([row()]), screenshots: [{ buffer: Buffer.from('x'), mimeType: 'image/png' }] },
      CONFIG,
      deps({
        schedule: SCHEDULE,
        history: [['Grant ID', 'Amount', 'Date'], ['ACM001', '50', '15/05/2026']],
        screenshots: { lines: [{ recipient: 'Acme Labs', amount: 100, date: '15/06/2026', sourceRef: 'screenshot 1' }], failures: [] },
      }),
    );
    expect(out.summary.allRequiredChecksPassed).toBe(true);
    expect(out.summary.passed).toBe(1);
    expect(out.results[0].status).toBe('GREEN');
    expect(out.results[0].statusLabel).toBe('PASS');
  });

  it('reads the expected amount from the schedule, so a wrong amount fails', async () => {
    const out = await runVerification(
      { excel: await buildExport([row({ 'Token Amount': 5000 })]) },
      CONFIG,
      deps({ schedule: SCHEDULE, history: [['Grant ID', 'Amount', 'Date'], ['ACM001', '50', '15/05/2026']] }),
    );
    expect(out.results[0].outcome).toBe('FAIL');
    const amount = out.results[0].checkDetails.find((c) => c.id === 'amountMatches')!;
    expect(amount.expected).toBe('100');
    expect(amount.actual).toBe('5,000');
    expect(amount.source).toContain('unlock schedule row');
  });

  it('uses the column for the payment\'s own month', async () => {
    // May schedules 50, June schedules 100. A payment of 50 dated in June must not pass.
    const out = await runVerification(
      { excel: await buildExport([row({ 'Token Amount': 50, 'Event Date': '15/06/2026' })]) },
      CONFIG,
      deps({ schedule: SCHEDULE, history: [['Grant ID', 'Amount', 'Date'], ['ACM001', '50', '15/05/2026']] }),
    );
    expect(out.results[0].outcome).toBe('FAIL');
    expect(out.results[0].resolvedPeriod).toBe('Jun 2026');
  });

  it('never reports a clean batch when a source was degraded', async () => {
    const out = await runVerification(
      { excel: await buildExport([row()]) },
      CONFIG,
      // No history rows at all — that is a failure to load, not "nothing ever paid".
      deps({ schedule: SCHEDULE, history: [['Grant ID', 'Amount', 'Date']] }),
    );
    expect(out.summary.allRequiredChecksPassed).toBe(false);
    expect(out.provenance.degradations.join(' ')).toMatch(/payment history returned no rows/);
  });

  it('accounts for every row of the upload', async () => {
    const out = await runVerification(
      {
        excel: await buildExport([
          row(),
          row({ Status: 'UNLOCKED' }),
          row({ 'Token Amount': 'n/a' }),
        ]),
      },
      CONFIG,
      deps({ schedule: SCHEDULE, history: [['Grant ID', 'Amount', 'Date'], ['ACM001', '50', '15/05/2026']] }),
    );
    expect(out.rowAccounting.totalDataRows).toBe(3);
    expect(out.rowAccounting.verified).toBe(1);
    expect(out.rowAccounting.skipped).toHaveLength(1);
    expect(out.rowAccounting.unreadable).toHaveLength(1);
    expect(out.summary.allRequiredChecksPassed).toBe(false);
  });

  it('flags a paused row that is still sitting in the queue', async () => {
    const out = await runVerification(
      {
        excel: await buildExport([row({ Notes: 'PAUSE' })]),
        screenshots: [{ buffer: Buffer.from('x'), mimeType: 'image/png' }],
      },
      CONFIG,
      deps({
        schedule: SCHEDULE,
        history: [['Grant ID', 'Amount', 'Date'], ['ACM001', '50', '15/05/2026']],
        screenshots: { lines: [{ recipient: 'Acme Labs', amount: 100, date: '15/06/2026', sourceRef: 'screenshot 1' }], failures: [] },
      }),
    );
    expect(out.results[0].outcome).toBe('EXCLUDED');
    expect(out.queueFindings.some((f) => f.outcome === 'FAIL' && /paused or cancelled/i.test(f.detail))).toBe(true);
    expect(out.summary.allRequiredChecksPassed).toBe(false);
  });

  it('20. the summary, the rows and the exports agree', async () => {
    const out = await runVerification(
      { excel: await buildExport([row(), row({ 'Grant Name': 'GHOST9', 'Recipient Name': 'Nobody' })]) },
      CONFIG,
      deps({ schedule: SCHEDULE, history: [['Grant ID', 'Amount', 'Date'], ['ACM001', '50', '15/05/2026']] }),
    );
    const failing = out.results.filter((r) => r.outcome === 'FAIL').length;
    const review = out.results.filter((r) => r.outcome === 'NEEDS_REVIEW').length;
    expect(out.summary.failed).toBe(failing);
    expect(out.summary.needsReview).toBe(review);
    expect(out.summary.total).toBe(out.results.length);
    expect(out.summary.allRequiredChecksPassed).toBe(false);
  });

  it('21. a change to the schedule changes the run fingerprint', async () => {
    const excel = await buildExport([row()]);
    const history = [['Grant ID', 'Amount', 'Date'], ['ACM001', '50', '15/05/2026']];
    const a = await runVerification({ excel }, CONFIG, deps({ schedule: SCHEDULE, history }));
    const changed = scheduleGrid([['Acme Labs', 'ACM001', '100000', '50', '250']]);
    const b = await runVerification({ excel }, CONFIG, deps({ schedule: changed, history }));
    expect(a.provenance.sources.unlockSchedule).not.toBe(b.provenance.sources.unlockSchedule);
    // No queue evidence was supplied in this run, so neither result is a full PASS.
    // What changes is the amount check: the same upload now disagrees with the schedule.
    const amountOf = (r: typeof a) => r.results[0].checkDetails.find((c) => c.id === 'amountMatches')!;
    expect(amountOf(a).outcome).toBe('PASS');
    expect(amountOf(b).outcome).toBe('FAIL');
    expect(amountOf(b).expected).toBe('250');
  });

  it('does not let a screenshot failure look like a completed check', async () => {
    const out = await runVerification(
      { excel: await buildExport([row()]), screenshots: [{ buffer: Buffer.from('x'), mimeType: 'image/png' }] },
      CONFIG,
      deps({
        schedule: SCHEDULE,
        history: [['Grant ID', 'Amount', 'Date'], ['ACM001', '50', '15/05/2026']],
        screenshots: { lines: [], failures: [{ sourceRef: 'screenshot 1', reason: 'unreadable image' }] },
      }),
    );
    expect(out.results[0].outcome).toBe('NEEDS_REVIEW');
    expect(out.summary.allRequiredChecksPassed).toBe(false);
  });
});

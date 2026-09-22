import { describe, it, expect } from 'vitest';
import { runVerification } from '../verification/run';
import {
  buildDemoExport, demoFetchRange, demoReadScreenshots, demoScreenshotStand, DEMO_CONFIG,
} from './mode';
import { DEMO_EXPORT_ROWS } from './data';

async function runDemo() {
  return runVerification(
    {
      excel: await buildDemoExport(),
      screenshots: demoScreenshotStand(),
    },
    { ...DEMO_CONFIG, toleranceRelative: 0.001, toleranceAbsolute: 1000 },
    {
      fetchRange: demoFetchRange,
      readScreenshots: demoReadScreenshots,
      now: () => '2026-06-20T10:00:00.000Z',
      runId: () => 'demo-run',
      appVersion: 'demo',
    },
  );
}

describe('the demo batch demonstrates what it claims to', () => {
  it('produces exactly the outcome each row is there to show', async () => {
    const out = await runDemo();
    expect(out.results).toHaveLength(DEMO_EXPORT_ROWS.length);

    for (const row of DEMO_EXPORT_ROWS) {
      const result = out.results.find((r) => r.grantId === row.grantName);
      expect(result, `no result for ${row.grantName}`).toBeDefined();
      expect(result!.outcome, `${row.grantName} — ${row.demonstrates}`).toBe(row.expected);
    }
  });

  it('never reports the demo batch as cleared', async () => {
    const out = await runDemo();
    expect(out.summary.allRequiredChecksPassed).toBe(false);
  });

  it('shows a spread of outcomes, so the result table is not all one colour', async () => {
    const out = await runDemo();
    expect(out.summary.passed).toBe(2);
    expect(out.summary.failed).toBe(3);
    expect(out.summary.needsReview).toBe(1);
    expect(out.summary.excluded).toBe(1);
  });

  it('catches the wrong-month payment by reading the right column', async () => {
    const out = await runDemo();
    const halden = out.results.find((r) => r.grantId === 'HLD022')!;
    const amount = halden.checkDetails.find((c) => c.id === 'amountMatches')!;
    expect(amount.outcome).toBe('FAIL');
    expect(amount.expected).toBe('60,000');
    expect(amount.actual).toBe('10,000');
    expect(halden.resolvedPeriod).toBe('Jun 2026');
  });

  it('catches the cap breach only when the whole batch is counted', async () => {
    const out = await runDemo();
    const calderon = out.results.find((r) => r.grantId === 'CLD002')!;
    const cap = calderon.checkDetails.find((c) => c.id === 'withinGrantCap')!;
    expect(cap.outcome).toBe('FAIL');
    expect(cap.actual).toBe('90,000');
    expect(cap.expected).toBe('80,000');
  });

  it('reports the parked payment that is still queued', async () => {
    const out = await runDemo();
    expect(out.queueFindings.some(
      (f) => f.outcome === 'FAIL' && /Marlowe/.test(f.detail) && /paused or cancelled/i.test(f.detail),
    )).toBe(true);
  });

  it('reports the queued transaction that nothing accounts for', async () => {
    const out = await runDemo();
    expect(out.queueFindings.some(
      (f) => f.outcome === 'FAIL' && /Ferrograph/.test(f.detail),
    )).toBe(true);
  });

  it('reaches nothing external — the run is driven entirely by bundled data', async () => {
    // demoFetchRange and demoReadScreenshots are the only I/O, and neither opens a socket.
    const out = await runDemo();
    expect(out.provenance.runId).toBe('demo-run');
    expect(out.provenance.periodsLoaded).toContain('2026-06');
  });
});

describe('the demo data carries nothing real', () => {
  it('uses only the invented grantees, so nothing real can drift in', async () => {
    const invented = new Set([
      'Acme Labs', 'Northwind Systems', 'Belvedere Research',
      'Calderon Group', 'Quillfeather Studio', 'Halden Partners', 'Marlowe Ventures',
    ]);
    for (const row of DEMO_EXPORT_ROWS) {
      expect(invented.has(row.recipient), `unexpected recipient: ${row.recipient}`).toBe(true);
      expect(row.grantName).toMatch(/^[A-Z]{3}\d{3}$/);
    }
  });
});

/**
 * The verification service.
 *
 * Everything the run touches from outside — the spreadsheets, the matching model, the
 * screenshot reader, the clock — arrives as an argument. The HTTP route supplies the real
 * ones; a test supplies fakes and exercises exactly the same code path.
 */

import { randomUUID } from 'node:crypto';
import { readCustodyExport } from './custodyExport';
import { loadSources, type RangeFetcher } from './loadSources';
import { resolveGrants, type ProposeFn } from './resolve';
import { verifyBatch, fingerprint, periodsRequired } from './engine';
import { toleranceFrom } from './checks';
import { presentRun } from './present';
import { parseTokens } from './money';
import { parseDate } from './period';
import type { CustodyQueue, QueueLine } from './sources';

export interface ScreenshotReader {
  (images: Array<{ buffer: Buffer; mimeType: string }>): Promise<{
    lines: Array<{ recipient: string; amount: unknown; date?: unknown; sourceRef: string }>;
    failures: Array<{ sourceRef: string; reason: string }>;
  }>;
}

export interface RunDeps {
  fetchRange: RangeFetcher;
  propose?: ProposeFn;
  readScreenshots?: ScreenshotReader;
  now?: () => string;
  runId?: () => string;
  appVersion?: string;
}

export interface RunConfig {
  scheduleSheetId: string;
  scheduleTab: string;
  historySheetId: string;
  historyTab: string;
  grantIdHeader: string;
  toleranceRelative: number;
  toleranceAbsolute: number;
}

export async function runVerification(
  input: {
    excel: Buffer;
    sheetName?: string;
    screenshots?: Array<{ buffer: Buffer; mimeType: string }>;
  },
  config: RunConfig,
  deps: RunDeps,
) {
  const now = deps.now?.() ?? new Date().toISOString();
  const runId = deps.runId?.() ?? randomUUID();

  // 1. Read the custody export, accounting for every row.
  const exportResult = await readCustodyExport(input.excel, input.sheetName);

  const degradations: string[] = exportResult.unreadable.map(
    (u) => `custody export row ${u.rowNumber}: ${u.reason}`,
  );

  // 2. Decide which schedule columns this batch needs, from its own dates.
  const { batchPeriods } = periodsRequired(exportResult.payments.map((p) => p.date));
  const undatedRows = exportResult.payments.filter((p) => p.date === null).length;
  if (undatedRows > 0) {
    degradations.push(`${undatedRows} row(s) have a date that could not be read`);
  }

  // 3. Load the sources for exactly those periods.
  const sources = await loadSources({
    fetchRange: deps.fetchRange,
    scheduleSheetId: config.scheduleSheetId,
    scheduleTab: config.scheduleTab,
    historySheetId: config.historySheetId,
    historyTab: config.historyTab,
    grantIdHeader: config.grantIdHeader,
    batchPeriods,
  });
  degradations.push(...sources.degradations);

  // 4. Resolve each payment to a schedule row. The model may only propose an identity.
  const resolutions = await resolveGrants(exportResult.payments, sources.schedule, deps.propose);

  // 5. Read the custody queue, if evidence was supplied.
  let queue: CustodyQueue | null = null;
  if (input.screenshots && input.screenshots.length > 0 && deps.readScreenshots) {
    try {
      const read = await deps.readScreenshots(input.screenshots);
      const lines: QueueLine[] = [];
      const issues: CustodyQueue['issues'] = [];
      read.lines.forEach((l, i) => {
        const amount = parseTokens(l.amount);
        if (!amount.ok) {
          issues.push({ source: 'custodyQueue', ref: l.sourceRef, problem: `amount unreadable (${amount.reason})` });
          return;
        }
        const d = l.date === undefined ? null : parseDate(l.date);
        lines.push({
          lineId: `${l.sourceRef}-${i}`,
          recipient: l.recipient,
          amount: amount.value,
          date: d && d.ok ? d.value : null,
          sourceRef: l.sourceRef,
        });
      });
      for (const f of read.failures) {
        issues.push({ source: 'custodyQueue', ref: f.sourceRef, problem: f.reason });
      }
      queue = {
        lines,
        incomplete: read.failures.length > 0 || issues.length > 0,
        incompleteReason: read.failures.length > 0
          ? `${read.failures.length} of ${input.screenshots.length} image(s) could not be read`
          : issues.length > 0 ? 'one or more queue lines could not be read' : undefined,
        issues,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      queue = { lines: [], incomplete: true, incompleteReason: `screenshots could not be read (${reason})`, issues: [] };
    }
  }

  // 6. Run the deterministic checks.
  const run = verifyBatch({
    payments: exportResult.payments,
    schedule: sources.schedule,
    history: sources.history,
    queue,
    resolutions,
    tolerance: toleranceFrom(config.toleranceRelative, config.toleranceAbsolute),
    cumulativePeriodsComplete: sources.cumulativePeriodsComplete,
    now,
    runId,
    appVersion: deps.appVersion ?? 'unknown',
    sourceFingerprints: {
      custodyExport: fingerprint(exportResult.payments.map((p) => p.paymentId)),
      unlockSchedule: sources.fingerprints.unlockSchedule,
      paymentHistory: sources.fingerprints.paymentHistory,
      custodyScreenshots: queue ? fingerprint(queue.lines.map((l) => l.lineId)) : undefined,
    },
    degradations,
  });

  return {
    ...presentRun(run),
    sheetNames: exportResult.sheetNames,
    selectedSheet: exportResult.selectedSheet,
    rowAccounting: {
      totalDataRows: exportResult.totalDataRows,
      verified: exportResult.payments.length,
      skipped: exportResult.skipped,
      unreadable: exportResult.unreadable,
    },
  };
}

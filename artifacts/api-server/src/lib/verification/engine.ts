/**
 * The verification engine.
 *
 * One entry point, used by the API endpoint and by the tests, so what the tests prove is
 * what the endpoint does. Everything it needs is passed in: no module-scope state, no
 * clock reads, no network calls of its own. That is what makes a run reproducible and a
 * result comparable against an earlier one.
 */

import { createHash } from 'node:crypto';
import { addTokens, formatTokens, type Tokens } from './money';
import { periodKey, periodLabel, periodsForDates, type Period } from './period';
import { runChecks, toleranceFrom, type GrantResolution, type Tolerance } from './checks';
import { reconcileQueue, applyQueueResults } from './queue';
import type { CustodyQueue, HistoryIndex, ScheduleIndex } from './sources';
import {
  summarise, type PaymentIdentity, type PaymentResult, type RunResult, type RunProvenance,
} from './model';

export interface EngineInput {
  payments: PaymentIdentity[];
  schedule: ScheduleIndex;
  history: HistoryIndex;
  queue: CustodyQueue | null;
  resolutions: Map<string, GrantResolution>;
  tolerance?: Tolerance;
  /** True when every schedule column needed to total "scheduled to date" was loaded. */
  cumulativePeriodsComplete: boolean;
  /** Supplied by the caller — the engine never reads the clock itself. */
  now: string;
  runId: string;
  appVersion: string;
  /** Content fingerprints of each source, for detecting a stale result later. */
  sourceFingerprints: RunProvenance['sources'];
  /** Anything that could not be loaded. A run carrying these cannot report a clean pass. */
  degradations?: string[];
}

export function verifyBatch(input: EngineInput): RunResult {
  const tolerance = input.tolerance ?? toleranceFrom(0.001, 1000);

  const results = runChecks({
    payments: input.payments,
    resolutions: input.resolutions,
    schedule: input.schedule,
    history: input.history,
    tolerance,
    cumulativePeriodsComplete: input.cumulativePeriodsComplete,
  });

  const excluded = new Set(results.filter((r) => r.outcome === 'EXCLUDED').map((r) => r.payment.paymentId));
  const expected = results.filter((r) => !excluded.has(r.payment.paymentId)).map((r) => r.payment);
  const parked = results.filter((r) => excluded.has(r.payment.paymentId)).map((r) => r.payment);

  const reconciliation = reconcileQueue(expected, parked, input.queue);
  const withQueue = applyQueueResults(results, reconciliation);

  const degradations = [
    ...(input.degradations ?? []),
    ...input.schedule.issues.map((i) => `unlock schedule (${i.ref}): ${i.problem}`),
    ...input.history.issues.map((i) => `payment history (${i.ref}): ${i.problem}`),
  ];

  const provenance: RunProvenance = {
    runId: input.runId,
    verifiedAt: input.now,
    appVersion: input.appVersion,
    periodsLoaded: [...input.schedule.periodsLoaded].sort(),
    sources: input.sourceFingerprints,
    degradations,
  };

  const summary = summarise(withQueue, reconciliation.queueFindings);

  return {
    provenance,
    summary: {
      ...summary,
      // A run with a degraded source cannot claim every required check passed.
      allRequiredChecksPassed: summary.allRequiredChecksPassed && degradations.length === 0,
    },
    payments: withQueue,
    queueFindings: reconciliation.queueFindings,
  };
}

/** Stable fingerprint of a source, so a later change to it invalidates an earlier run. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
}

/**
 * Mint a stable identifier for a custody-export row.
 *
 * The export carries no identifier of its own, so this is derived from the row's position
 * and its content. Identical input yields identical ids, which is what lets a re-run be
 * compared against an earlier one.
 */
export function mintPaymentId(rowNumber: number, grantRef: string, amount: string, rawDate: string): string {
  const h = createHash('sha256')
    .update(`${rowNumber}|${grantRef.trim().toLowerCase()}|${amount}|${rawDate.trim()}`)
    .digest('hex')
    .slice(0, 12);
  return `p${rowNumber}-${h}`;
}

/**
 * The schedule columns a batch needs.
 *
 * Two sets are required and they are not the same:
 *   - the periods the payments actually fall in (rule R1)
 *   - every period from the start of the schedule up to the latest of those, so that
 *     "scheduled to date" can be totalled (rule R4b)
 */
export function periodsRequired(dates: Array<PaymentIdentity['date']>): {
  batchPeriods: Period[];
  latest: Period | null;
} {
  const present = dates.filter((d): d is NonNullable<typeof d> => d !== null);
  const batchPeriods = periodsForDates(present);
  return {
    batchPeriods,
    latest: batchPeriods.length > 0 ? batchPeriods[batchPeriods.length - 1] : null,
  };
}

/** A short, human-readable account of what the run concluded. */
export function describeRun(run: RunResult): string {
  const s = run.summary;
  const lines: string[] = [];

  lines.push(
    s.allRequiredChecksPassed
      ? `All required checks passed for ${s.totalPayments - s.excluded} payment(s).`
      : `NOT CLEARED: ${s.failed} failed, ${s.needsReview} need review, ${s.passed} passed, ${s.excluded} excluded.`,
  );

  const failing = run.payments.filter((p) => p.outcome === 'FAIL');
  if (failing.length > 0) {
    lines.push('', 'Failed:');
    for (const p of failing) {
      const why = p.checks.filter((c) => c.outcome === 'FAIL').map((c) => c.detail);
      lines.push(`  - ${p.payment.recipient} (${p.payment.grantRef}), ${formatTokens(p.payment.amount)}: ${why[0] ?? 'see details'}`);
    }
  }

  const review = run.payments.filter((p) => p.outcome === 'NEEDS_REVIEW');
  if (review.length > 0) {
    lines.push('', 'Needs review:');
    for (const p of review) {
      const why = p.checks.filter((c) => c.outcome === 'NEEDS_REVIEW').map((c) => c.detail);
      lines.push(`  - ${p.payment.recipient} (${p.payment.grantRef}), ${formatTokens(p.payment.amount)}: ${why[0] ?? 'see details'}`);
    }
  }

  const parked = run.payments.filter((p) => p.outcome === 'EXCLUDED');
  if (parked.length > 0) {
    lines.push('', 'Excluded (still present in the custody queue):');
    for (const p of parked) {
      lines.push(`  - ${p.payment.recipient} (${p.payment.grantRef}), ${formatTokens(p.payment.amount)}: ${p.exclusionReason}`);
    }
  }

  const queueIssues = run.queueFindings.filter((f) => f.outcome !== 'PASS' && f.outcome !== 'NOT_APPLICABLE');
  if (queueIssues.length > 0) {
    lines.push('', 'Custody queue:');
    for (const f of queueIssues) lines.push(`  - ${f.detail}`);
  }

  if (run.provenance.degradations.length > 0) {
    lines.push('', 'Source data problems (these prevent a clean result):');
    for (const d of run.provenance.degradations) lines.push(`  - ${d}`);
  }

  return lines.join('\n');
}

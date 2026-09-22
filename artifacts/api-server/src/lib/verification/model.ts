/**
 * The verification result model.
 *
 * One vocabulary, used by the engine, the endpoint, the dashboard and both exports.
 *
 * The central rule is that absence of evidence is never a pass. A check that could not be
 * completed returns NEEDS_REVIEW; it does not quietly return PASS, and it does not get
 * dropped from the roll-up. A batch is only ALL_CHECKS_PASSED when every required check on
 * every payment actually ran and actually passed.
 */

import type { Tokens } from './money';
import type { Period, PlainDate } from './period';

export type Outcome =
  /** The check ran and the payment satisfied it. */
  | 'PASS'
  /** The check ran and found a definite discrepancy or a prohibited payment. */
  | 'FAIL'
  /** The check could not be completed, or its evidence is ambiguous, stale or unreadable. */
  | 'NEEDS_REVIEW'
  /** The payment is deliberately not being made (paused, cancelled) — justified, never an implicit pass. */
  | 'EXCLUDED'
  /** The check does not apply to this payment, with a stated reason. */
  | 'NOT_APPLICABLE';

/** Outcomes that mean "a human must look at this before anyone signs". */
export const BLOCKING_OUTCOMES: readonly Outcome[] = ['FAIL', 'NEEDS_REVIEW'];

/** Ordered worst-first, for rolling several checks up into one. */
const SEVERITY: Record<Outcome, number> = {
  FAIL: 0,
  NEEDS_REVIEW: 1,
  EXCLUDED: 2,
  PASS: 3,
  NOT_APPLICABLE: 4,
};

export function worstOutcome(outcomes: Outcome[]): Outcome {
  if (outcomes.length === 0) return 'NOT_APPLICABLE';
  return outcomes.reduce((a, b) => (SEVERITY[a] <= SEVERITY[b] ? a : b));
}

/** The checks this engine performs. Stable ids — exports and the UI key off these. */
export type CheckId =
  | 'grantResolved'
  | 'recipientMatches'
  | 'instalmentScheduled'
  | 'amountMatches'
  | 'notDuplicated'
  | 'withinGrantCap'
  | 'withinScheduledToDate'
  | 'custodyQueueReconciled';

/** Checks that must complete and pass for a payment to be approved. */
export const REQUIRED_CHECKS: readonly CheckId[] = [
  'grantResolved',
  'recipientMatches',
  'instalmentScheduled',
  'amountMatches',
  'notDuplicated',
  'withinGrantCap',
  'withinScheduledToDate',
];

export const CHECK_TITLES: Record<CheckId, string> = {
  grantResolved: 'Grant resolved in the unlock schedule',
  recipientMatches: 'Recipient matches the scheduled grantee',
  instalmentScheduled: 'An instalment is scheduled for this period',
  amountMatches: 'Amount matches the scheduled instalment',
  notDuplicated: 'Not a duplicate of another payment',
  withinGrantCap: "Within the grant's total cap",
  withinScheduledToDate: 'Within the amount scheduled up to this period',
  custodyQueueReconciled: 'Reconciled against the custody queue',
};

/** A value the operator can check for themselves, carried alongside every comparison. */
export interface Evidence {
  /** Where the authoritative value came from, e.g. "unlock schedule, row 42, column 'Mar 2026'". */
  source?: string;
  expectedTokens?: Tokens;
  actualTokens?: Tokens;
  expectedDate?: string;
  actualDate?: string;
  expectedText?: string;
  actualText?: string;
}

export interface CheckResult {
  id: CheckId;
  outcome: Outcome;
  /** One sentence an operator can act on. */
  detail: string;
  /** The rule applied, so a reader knows which policy produced this. */
  rule?: string;
  evidence?: Evidence;
}

/**
 * A single row of the custody export.
 *
 * The export carries no payment identifier of its own, so `paymentId` is minted from the
 * row's position and content. It is stable for identical input, which is what lets a re-run
 * be compared against an earlier one.
 */
export interface PaymentIdentity {
  paymentId: string;
  rowNumber: number;
  grantRef: string;
  recipient: string;
  amount: Tokens;
  date: PlainDate | null;
  rawDate: string;
  walletAddress?: string;
  status?: string;
  notes?: string;
}

export interface PaymentResult {
  payment: PaymentIdentity;
  outcome: Outcome;
  checks: CheckResult[];
  /** Which schedule row this payment was resolved to, if any. */
  resolvedGrantId?: string;
  resolvedPeriod?: Period;
  /** Set when the payment is EXCLUDED, explaining why it is not being verified. */
  exclusionReason?: string;
}

export interface RunSummary {
  totalPayments: number;
  passed: number;
  needsReview: number;
  failed: number;
  excluded: number;
  /** True only when every required check on every non-excluded payment ran and passed. */
  allRequiredChecksPassed: boolean;
}

/** What a run was computed from, so a stale result can be detected later. */
export interface RunProvenance {
  runId: string;
  verifiedAt: string;
  appVersion: string;
  /** Periods actually loaded from the schedule, derived from the batch's dates. */
  periodsLoaded: string[];
  /** Content hashes of each source, so a later change invalidates this run. */
  sources: {
    custodyExport?: string;
    unlockSchedule?: string;
    paymentHistory?: string;
    custodyScreenshots?: string;
  };
  /** Anything that could not be loaded. A run with these cannot report a clean pass. */
  degradations: string[];
}

export interface RunResult {
  provenance: RunProvenance;
  summary: RunSummary;
  payments: PaymentResult[];
  /** Queue-level findings that belong to no single payment (unexpected extra transactions, etc). */
  queueFindings: CheckResult[];
}

/** Roll a payment's checks up into its overall outcome. */
export function outcomeForPayment(checks: CheckResult[], exclusionReason?: string): Outcome {
  if (exclusionReason) return 'EXCLUDED';
  return worstOutcome(checks.map((c) => c.outcome));
}

export function summarise(payments: PaymentResult[], queueFindings: CheckResult[]): RunSummary {
  const counts = { passed: 0, needsReview: 0, failed: 0, excluded: 0 };
  for (const p of payments) {
    if (p.outcome === 'FAIL') counts.failed++;
    else if (p.outcome === 'NEEDS_REVIEW') counts.needsReview++;
    else if (p.outcome === 'EXCLUDED') counts.excluded++;
    else if (p.outcome === 'PASS') counts.passed++;
  }

  // Every required check must have actually run and passed on every non-excluded payment,
  // and no queue-level finding may be outstanding.
  const everyPaymentClean = payments.every((p) => {
    if (p.outcome === 'EXCLUDED') return true;
    if (p.outcome !== 'PASS') return false;
    const ran = new Set(p.checks.filter((c) => c.outcome === 'PASS').map((c) => c.id));
    return REQUIRED_CHECKS.every((id) => ran.has(id));
  });
  const queueClean = queueFindings.every((f) => f.outcome === 'PASS' || f.outcome === 'NOT_APPLICABLE');

  return {
    totalPayments: payments.length,
    ...counts,
    allRequiredChecksPassed: everyPaymentClean && queueClean,
  };
}

/** Legacy traffic-light status, kept so the existing dashboard and exports keep working. */
export type LegacyStatus = 'GREEN' | 'YELLOW' | 'RED';

export function toLegacyStatus(o: Outcome): LegacyStatus {
  if (o === 'FAIL') return 'RED';
  if (o === 'PASS') return 'GREEN';
  if (o === 'NOT_APPLICABLE') return 'GREEN';
  return 'YELLOW'; // NEEDS_REVIEW and EXCLUDED both warrant a human glance
}

export function outcomeLabel(o: Outcome): string {
  switch (o) {
    case 'PASS': return 'PASS';
    case 'FAIL': return 'FAIL';
    case 'NEEDS_REVIEW': return 'REVIEW';
    case 'EXCLUDED': return 'EXCLUDED';
    case 'NOT_APPLICABLE': return 'N/A';
  }
}

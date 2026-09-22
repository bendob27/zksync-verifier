/**
 * Presenting a run.
 *
 * The dashboard, the CSV and the PDF all read the same shape, so they cannot disagree.
 * The legacy traffic-light fields are kept so the existing UI keeps working, and the
 * richer outcome is carried alongside them.
 */

import { formatTokens, tokensToNumber } from './money';
import { periodLabel } from './period';
import {
  CHECK_TITLES, outcomeLabel, toLegacyStatus,
  type CheckId, type CheckResult, type PaymentResult, type RunResult,
} from './model';

/** Legacy check slots the dashboard already renders, mapped from the new check ids. */
const LEGACY_SLOT: Partial<Record<CheckId, string>> = {
  grantResolved: 'recipientExists',
  recipientMatches: 'recipientExists',
  instalmentScheduled: 'timingMatch',
  amountMatches: 'amountMatch',
  notDuplicated: 'duplicateCheck',
  withinGrantCap: 'cumulativeCheck',
  withinScheduledToDate: 'cumulativeCheck',
  custodyQueueReconciled: 'screenshotMatch',
};

const ORDER = { FAIL: 0, NEEDS_REVIEW: 1, EXCLUDED: 2, PASS: 3, NOT_APPLICABLE: 4 } as const;

function legacyDetail(checks: CheckResult[]): {
  status: 'GREEN' | 'YELLOW' | 'RED';
  detail: string;
  expected?: number;
  actual?: number;
  expectedDate?: string;
  actualDate?: string;
} {
  const worst = checks.reduce((a, b) => (ORDER[a.outcome] <= ORDER[b.outcome] ? a : b));
  const withEvidence = checks.find((c) => c.evidence?.expectedTokens !== undefined) ?? worst;
  return {
    status: toLegacyStatus(worst.outcome),
    detail: checks.map((c) => c.detail).join(' '),
    expected: withEvidence.evidence?.expectedTokens !== undefined
      ? tokensToNumber(withEvidence.evidence.expectedTokens) : undefined,
    actual: withEvidence.evidence?.actualTokens !== undefined
      ? tokensToNumber(withEvidence.evidence.actualTokens) : undefined,
    expectedDate: withEvidence.evidence?.expectedDate,
    actualDate: withEvidence.evidence?.actualDate,
  };
}

export function presentPayment(p: PaymentResult) {
  const bySlot = new Map<string, CheckResult[]>();
  for (const c of p.checks) {
    const slot = LEGACY_SLOT[c.id];
    if (!slot) continue;
    const list = bySlot.get(slot);
    if (list) list.push(c);
    else bySlot.set(slot, [c]);
  }

  const checks: Record<string, ReturnType<typeof legacyDetail>> = {};
  for (const [slot, list] of bySlot) checks[slot] = legacyDetail(list);

  // Slots the dashboard always expects to be present.
  for (const slot of ['recipientExists', 'amountMatch', 'timingMatch']) {
    if (!checks[slot]) {
      checks[slot] = { status: 'YELLOW', detail: 'This check did not run.' };
    }
  }

  return {
    // legacy fields, unchanged shape
    grantId: p.payment.grantRef,
    recipient: p.payment.recipient,
    amount: tokensToNumber(p.payment.amount),
    date: p.payment.rawDate,
    status: toLegacyStatus(p.outcome),
    statusLabel: outcomeLabel(p.outcome),
    walletAddress: p.payment.walletAddress,
    notes: p.payment.notes,
    checks,

    // new fields, carried alongside
    paymentId: p.payment.paymentId,
    rowNumber: p.payment.rowNumber,
    outcome: p.outcome,
    exclusionReason: p.exclusionReason,
    resolvedGrantId: p.resolvedGrantId,
    resolvedPeriod: p.resolvedPeriod ? periodLabel(p.resolvedPeriod) : undefined,
    amountFormatted: formatTokens(p.payment.amount),
    checkDetails: p.checks.map((c) => ({
      id: c.id,
      title: CHECK_TITLES[c.id],
      outcome: c.outcome,
      detail: c.detail,
      rule: c.rule,
      source: c.evidence?.source,
      expected: c.evidence?.expectedTokens !== undefined ? formatTokens(c.evidence.expectedTokens) : undefined,
      actual: c.evidence?.actualTokens !== undefined ? formatTokens(c.evidence.actualTokens) : undefined,
    })),
  };
}

export function presentRun(run: RunResult) {
  return {
    results: run.payments.map(presentPayment),
    summary: {
      total: run.summary.totalPayments,
      passed: run.summary.passed,
      warnings: run.summary.needsReview + run.summary.excluded,
      failed: run.summary.failed,
      // new, explicit
      needsReview: run.summary.needsReview,
      excluded: run.summary.excluded,
      allRequiredChecksPassed: run.summary.allRequiredChecksPassed,
    },
    queueFindings: run.queueFindings.map((f) => ({
      outcome: f.outcome,
      detail: f.detail,
      rule: f.rule,
    })),
    provenance: run.provenance,
  };
}

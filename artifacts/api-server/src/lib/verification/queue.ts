/**
 * Reconciling the batch against the custody queue.
 *
 * Checked in both directions, because each catches a different failure:
 *   - every payment we expect must appear in the queue
 *   - every transaction sitting in the queue must be explained by an expected payment
 *
 * Amounts are compared per recipient, because the custody platform bundles several grants
 * for one counterparty into a single withdrawal. A recipient's expected total must equal
 * their observed total; one observed transaction therefore cannot satisfy two obligations,
 * because the totals would not agree.
 *
 * Screenshot evidence is treated as candidate evidence, never as fact. If any image failed
 * to read, or no images were supplied at all, the reconciliation reports that it could not
 * be completed rather than reporting agreement.
 */

import { absTokens, addTokens, formatTokens, ZERO, type Tokens } from './money';
import { normaliseName, type CustodyQueue } from './sources';
import type { CheckResult, PaymentIdentity, PaymentResult } from './model';

export interface QueueReconciliation {
  /** Per-payment check, keyed by paymentId. */
  perPayment: Map<string, CheckResult>;
  /** Findings that belong to the queue as a whole rather than to one payment. */
  queueFindings: CheckResult[];
}

interface RecipientTotals {
  display: string;
  expected: Tokens;
  observed: Tokens;
  expectedPayments: PaymentIdentity[];
  observedLines: number;
}

function finding(outcome: CheckResult['outcome'], detail: string, rule?: string): CheckResult {
  return { id: 'custodyQueueReconciled', outcome, detail, rule };
}

/**
 * @param expected  the batch's payments, EXCLUDING ones deliberately parked
 * @param parked    payments marked paused/cancelled that are nonetheless still queued
 */
export function reconcileQueue(
  expected: PaymentIdentity[],
  parked: PaymentIdentity[],
  queue: CustodyQueue | null,
): QueueReconciliation {
  const perPayment = new Map<string, CheckResult>();
  const queueFindings: CheckResult[] = [];

  if (!queue) {
    const note = finding('NEEDS_REVIEW',
      'No custody queue evidence was supplied, so the batch was not reconciled against the queue.',
      'Queue reconciliation is required; absence of evidence is not agreement');
    for (const p of expected) perPayment.set(p.paymentId, note);
    queueFindings.push(note);
    return { perPayment, queueFindings };
  }

  // Identical lines seen more than once are more likely overlapping screenshots than two
  // genuine identical withdrawals. We refuse to guess: we neither drop nor double-count.
  const seen = new Map<string, number>();
  for (const line of queue.lines) {
    const key = `${normaliseName(line.recipient)}|${line.amount}|${line.date ? `${line.date.year}-${line.date.month}-${line.date.day}` : 'nodate'}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const overlapping = [...seen.entries()].filter(([, n]) => n > 1);

  const totals = new Map<string, RecipientTotals>();
  const bucket = (name: string): RecipientTotals => {
    const key = normaliseName(name);
    let t = totals.get(key);
    if (!t) {
      t = { display: name, expected: ZERO, observed: ZERO, expectedPayments: [], observedLines: 0 };
      totals.set(key, t);
    }
    return t;
  };

  for (const p of expected) {
    const t = bucket(p.recipient);
    t.expected += p.amount;
    t.expectedPayments.push(p);
  }
  for (const line of queue.lines) {
    const t = bucket(line.recipient);
    t.observed += line.amount;
    t.observedLines++;
  }

  const evidenceIncomplete = queue.incomplete || overlapping.length > 0;
  const incompleteReason = overlapping.length > 0
    ? `${overlapping.length} transaction(s) appear more than once across the supplied images, so the observed totals may be double-counted`
    : queue.incompleteReason;

  for (const p of expected) {
    const t = bucket(p.recipient)!;
    const diff = absTokens(t.expected - t.observed);
    const shared = t.expectedPayments.length > 1
      ? ` ${t.expectedPayments.length} payments for this recipient were compared as one bundled total.`
      : '';

    if (evidenceIncomplete) {
      perPayment.set(p.paymentId, finding('NEEDS_REVIEW',
        `The custody queue evidence is incomplete${incompleteReason ? ` (${incompleteReason})` : ''}, so this payment could not be confirmed against the queue.`,
        'Absence of evidence is not agreement'));
      continue;
    }

    if (t.observedLines === 0) {
      perPayment.set(p.paymentId, finding('FAIL',
        `Nothing for "${p.recipient}" appears in the custody queue, but a payment of ${formatTokens(p.amount)} is expected.`,
        'Every expected payment must appear in the queue'));
      continue;
    }

    if (diff === ZERO) {
      perPayment.set(p.paymentId, finding('PASS',
        `Matches the custody queue: ${formatTokens(t.observed)} queued for "${t.display}".${shared}`,
        'Expected and observed totals per recipient must agree'));
    } else {
      perPayment.set(p.paymentId, finding('FAIL',
        `The custody queue does not agree for "${t.display}": ${formatTokens(t.expected)} expected, ${formatTokens(t.observed)} queued (difference ${formatTokens(diff)}).${shared}`,
        'Expected and observed totals per recipient must agree'));
    }
  }

  // ── Queue-level findings ────────────────────────────────────────────────
  if (overlapping.length > 0) {
    queueFindings.push(finding('NEEDS_REVIEW',
      `${overlapping.length} transaction(s) appear more than once across the supplied images. They were neither discarded nor counted twice — confirm whether the images overlap or the withdrawals are genuinely repeated.`,
      'Duplicate screenshot coverage is surfaced, never silently resolved'));
  }

  if (queue.incomplete) {
    queueFindings.push(finding('NEEDS_REVIEW',
      `Custody queue evidence is incomplete${queue.incompleteReason ? `: ${queue.incompleteReason}` : ''}.`,
      'Absence of evidence is not agreement'));
  }

  for (const issue of queue.issues) {
    queueFindings.push(finding('NEEDS_REVIEW',
      `Custody queue evidence could not be read (${issue.ref}): ${issue.problem}`));
  }

  // Transactions in the queue that no expected payment accounts for.
  const expectedNames = new Set(expected.map((p) => normaliseName(p.recipient)));
  const parkedNames = new Map(parked.map((p) => [normaliseName(p.recipient), p]));

  for (const [key, t] of totals) {
    if (t.observedLines === 0) continue;
    if (expectedNames.has(key)) continue;

    const parkedMatch = parkedNames.get(key);
    if (parkedMatch) {
      queueFindings.push(finding('FAIL',
        `"${t.display}" is queued for ${formatTokens(t.observed)} but its payment is marked as paused or cancelled. It must be removed from the queue or approved deliberately.`,
        'A parked payment must not remain queued unnoticed'));
    } else {
      queueFindings.push(finding('FAIL',
        `The custody queue contains ${formatTokens(t.observed)} for "${t.display}", which no payment in this batch accounts for.`,
        'Every queued transaction must be explained by an expected payment'));
    }
  }

  if (queueFindings.length === 0) {
    queueFindings.push(finding('PASS', 'Every queued transaction is accounted for by a payment in this batch.'));
  }

  return { perPayment, queueFindings };
}

/** Attach the queue check onto already-computed payment results. */
export function applyQueueResults(
  results: PaymentResult[],
  reconciliation: QueueReconciliation,
): PaymentResult[] {
  return results.map((r) => {
    const q = reconciliation.perPayment.get(r.payment.paymentId);
    if (!q || r.outcome === 'EXCLUDED') return r;
    const checks = [...r.checks, q];
    // The queue check is a required check: unlike before, it can change the outcome.
    const order = { FAIL: 0, NEEDS_REVIEW: 1, EXCLUDED: 2, PASS: 3, NOT_APPLICABLE: 4 } as const;
    const outcome = checks.reduce<PaymentResult['outcome']>(
      (worst, c) => (order[c.outcome] < order[worst] ? c.outcome : worst),
      'PASS',
    );
    return { ...r, checks, outcome };
  });
}

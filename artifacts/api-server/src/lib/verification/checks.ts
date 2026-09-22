/**
 * The deterministic checks.
 *
 * Every value compared here is read from a fetched source record. A model may have proposed
 * WHICH schedule row a payment belongs to, but it never supplies the expected amount, the
 * scheduled period or the grant cap — those are read from the row in code.
 *
 * Approved rules (see README):
 *   R1  A payment's own event date selects the instalment it is paying.
 *   R2  Exact amount passes; within tolerance needs review; outside tolerance fails.
 *   R3  Splitting one instalment across rows is allowed, so the amount check compares the
 *       SUM of all payments sharing a grant and period against that period's cell.
 *   R4  Exposure is checked against both the grant's lifetime cap and the amount scheduled
 *       up to the payment's period, counting the whole batch, not one row at a time.
 */

import {
  absTokens, addTokens, formatTokens, parseTokens, ZERO, type Tokens,
} from './money';
import {
  comparePeriods, periodKey, periodLabel, periodOf, type Period,
} from './period';
import {
  normaliseGrantId, normaliseName,
  type HistoryIndex, type ScheduleIndex, type ScheduleRow,
} from './sources';
import {
  outcomeForPayment, type CheckId, type CheckResult, type PaymentIdentity,
  type PaymentResult,
} from './model';

/** How a payment was mapped onto a schedule row. */
export interface GrantResolution {
  paymentId: string;
  status: 'resolved' | 'ambiguous' | 'not-found';
  row?: ScheduleRow;
  /** Populated when several rows could match — never silently narrowed to one. */
  candidates?: ScheduleRow[];
  /** How the mapping was arrived at, for the evidence trail. */
  basis: string;
}

export interface Tolerance {
  /** Fractional, e.g. 0.001 for 0.1%. */
  relative: number;
  absolute: Tokens;
}

export interface CheckContext {
  payments: PaymentIdentity[];
  resolutions: Map<string, GrantResolution>;
  schedule: ScheduleIndex;
  history: HistoryIndex;
  tolerance: Tolerance;
  /** Periods required for the scheduled-to-date check but not loaded, if any. */
  cumulativePeriodsComplete: boolean;
}

function check(
  id: CheckId,
  outcome: CheckResult['outcome'],
  detail: string,
  extra: Partial<CheckResult> = {},
): CheckResult {
  return { id, outcome, detail, ...extra };
}

/** Sum of a grant's historical payments. Unreadable entries were already excluded upstream. */
function paidToDate(history: HistoryIndex, grantId: string): Tokens {
  const entries = history.byGrantId.get(normaliseGrantId(grantId)) ?? [];
  return addTokens(...entries.map((e) => e.amount));
}

/** Everything scheduled for a grant from the start of the schedule through `upTo`. */
function scheduledThrough(row: ScheduleRow, upTo: Period): Tokens {
  let total = ZERO;
  for (const [key, amount] of row.instalments) {
    const [y, m] = key.split('-').map(Number);
    if (comparePeriods({ year: y, month: m }, upTo) <= 0) total += amount;
  }
  return total;
}

export function runChecks(ctx: CheckContext): PaymentResult[] {
  const { payments, resolutions, history, tolerance } = ctx;

  // ── Pass 1: resolve identity and period for every payment ──────────────────
  interface Resolved {
    payment: PaymentIdentity;
    resolution: GrantResolution;
    period: Period | null;
  }
  const resolved: Resolved[] = payments.map((payment) => ({
    payment,
    resolution: resolutions.get(payment.paymentId)
      ?? { paymentId: payment.paymentId, status: 'not-found', basis: 'no resolution was produced for this row' },
    period: payment.date ? periodOf(payment.date) : null,
  }));

  // ── Pass 2: group for the checks that span several rows ────────────────────
  // R3: rows sharing a grant and period jointly pay one instalment.
  const groups = new Map<string, Resolved[]>();
  // R4: exposure is per grant across the whole batch.
  const batchByGrant = new Map<string, Resolved[]>();

  for (const r of resolved) {
    if (r.resolution.status !== 'resolved' || !r.resolution.row || !r.period) continue;
    const grantKey = normaliseGrantId(r.resolution.row.grantId);
    const gk = `${grantKey}|${periodKey(r.period)}`;
    (groups.get(gk) ?? groups.set(gk, []).get(gk)!).push(r);
    (batchByGrant.get(grantKey) ?? batchByGrant.set(grantKey, []).get(grantKey)!).push(r);
  }

  // Exact-signature repeats inside the upload: same grant, same amount, same date.
  const signatureCounts = new Map<string, number>();
  for (const r of resolved) {
    const sig = `${normaliseGrantId(r.payment.grantRef)}|${r.payment.amount}|${r.payment.rawDate}`;
    signatureCounts.set(sig, (signatureCounts.get(sig) ?? 0) + 1);
  }

  // ── Pass 3: emit checks ────────────────────────────────────────────────────
  return resolved.map((r) => {
    const { payment, resolution, period } = r;

    // A row the team has deliberately parked. It is NOT verified, but it is also not
    // dropped: it is still sitting in the custody queue awaiting someone's approval.
    const marker = `${payment.status ?? ''} ${payment.notes ?? ''}`.trim();
    if (marker !== '' && /pause|skip|cancel|no wallet/i.test(marker)) {
      const reason = `marked "${(payment.notes || payment.status || '').trim()}" in the custody export`;
      return {
        payment,
        outcome: 'EXCLUDED' as const,
        exclusionReason: reason,
        checks: [
          check('grantResolved', 'EXCLUDED', `Not verified — ${reason}. It is still present in the custody queue and must be removed or approved deliberately.`),
        ],
      };
    }

    const checks: CheckResult[] = [];

    // 1. Grant resolved ─────────────────────────────────────────────────────
    if (resolution.status === 'resolved' && resolution.row) {
      checks.push(check('grantResolved', 'PASS',
        `Resolved to grant ${resolution.row.grantId} (${resolution.row.sourceRef}).`,
        { rule: 'A payment must map to exactly one schedule row', evidence: { source: resolution.row.sourceRef, expectedText: resolution.row.grantId, actualText: payment.grantRef } }));
    } else if (resolution.status === 'ambiguous') {
      const names = (resolution.candidates ?? []).map((c) => c.sourceRef).join(', ');
      checks.push(check('grantResolved', 'NEEDS_REVIEW',
        `"${payment.grantRef}" matched more than one schedule row (${names}). ${resolution.basis}`,
        { rule: 'An ambiguous match is never treated as a match' }));
    } else {
      checks.push(check('grantResolved', 'FAIL',
        `"${payment.grantRef}" could not be matched to any schedule row. ${resolution.basis}`,
        { rule: 'A payment must map to exactly one schedule row' }));
    }

    const row = resolution.status === 'resolved' ? resolution.row : undefined;

    // 2. Recipient matches ──────────────────────────────────────────────────
    if (!row) {
      checks.push(check('recipientMatches', 'NEEDS_REVIEW', 'No schedule row to compare the recipient against.'));
    } else if (row.granteeName === '') {
      checks.push(check('recipientMatches', 'NEEDS_REVIEW',
        `The schedule row for ${row.grantId} has no grantee name, so the recipient could not be confirmed.`));
    } else {
      const a = normaliseName(payment.recipient);
      const b = normaliseName(row.granteeName);
      const evidence = { source: row.sourceRef, expectedText: row.granteeName, actualText: payment.recipient };
      if (a === b) {
        checks.push(check('recipientMatches', 'PASS', `Recipient matches the scheduled grantee "${row.granteeName}".`, { evidence }));
      } else if (a !== '' && b !== '' && (a.includes(b) || b.includes(a))) {
        checks.push(check('recipientMatches', 'NEEDS_REVIEW',
          `Recipient "${payment.recipient}" only partly matches the scheduled grantee "${row.granteeName}".`,
          { rule: 'A partial name match is not accepted as a match', evidence }));
      } else {
        checks.push(check('recipientMatches', 'FAIL',
          `Recipient "${payment.recipient}" does not match the scheduled grantee "${row.granteeName}".`,
          { evidence }));
      }
    }

    // 3. An instalment is scheduled for this period (R1) ────────────────────
    let scheduledForPeriod: Tokens | null = null;
    if (!payment.date) {
      checks.push(check('instalmentScheduled', 'NEEDS_REVIEW',
        `The payment date "${payment.rawDate}" could not be read, so its instalment could not be identified.`,
        { rule: 'R1 — a payment is checked against the instalment for its own month' }));
    } else if (!row || !period) {
      checks.push(check('instalmentScheduled', 'NEEDS_REVIEW', 'No schedule row to look up an instalment in.'));
    } else if (!ctx.schedule.periodsLoaded.has(periodKey(period))) {
      checks.push(check('instalmentScheduled', 'NEEDS_REVIEW',
        `The schedule column for ${periodLabel(period)} was not loaded, so this payment could not be checked.`,
        { rule: 'R1 — a payment is checked against the instalment for its own month' }));
    } else {
      const amount = row.instalments.get(periodKey(period));
      if (amount === undefined || amount === ZERO) {
        checks.push(check('instalmentScheduled', 'FAIL',
          `No instalment is scheduled for ${resolution.row!.grantId} in ${periodLabel(period)}.`,
          {
            rule: 'R1 — a payment is checked against the instalment for its own month',
            evidence: { source: `${row.sourceRef}, column ${periodLabel(period)}`, actualDate: payment.rawDate },
          }));
      } else {
        scheduledForPeriod = amount;
        checks.push(check('instalmentScheduled', 'PASS',
          `An instalment of ${formatTokens(amount)} is scheduled for ${periodLabel(period)}.`,
          {
            rule: 'R1 — a payment is checked against the instalment for its own month',
            evidence: { source: `${row.sourceRef}, column ${periodLabel(period)}`, expectedTokens: amount, actualDate: payment.rawDate },
          }));
      }
    }

    // 4. Amount matches the instalment, summed across any split (R2, R3) ────
    if (row && period && scheduledForPeriod !== null) {
      const gk = `${normaliseGrantId(row.grantId)}|${periodKey(period)}`;
      const siblings = groups.get(gk) ?? [r];
      const groupTotal = addTokens(...siblings.map((s) => s.payment.amount));
      const diff = absTokens(groupTotal - scheduledForPeriod);
      const withinAbsolute = diff <= ctx.tolerance.absolute;
      const withinRelative = scheduledForPeriod !== ZERO
        && Number(diff) / Number(absTokens(scheduledForPeriod)) <= ctx.tolerance.relative;

      const split = siblings.length > 1
        ? ` (${siblings.length} rows totalling ${formatTokens(groupTotal)})`
        : '';
      const evidence = {
        source: `${row.sourceRef}, column ${periodLabel(period)}`,
        expectedTokens: scheduledForPeriod,
        actualTokens: groupTotal,
      };

      if (diff === ZERO) {
        checks.push(check('amountMatches', 'PASS',
          `Amount matches the scheduled instalment exactly${split}.`,
          { rule: 'R2/R3 — rows sharing a grant and month are summed, and must match exactly to pass', evidence }));
      } else if (withinAbsolute && withinRelative) {
        checks.push(check('amountMatches', 'NEEDS_REVIEW',
          `Amount is within tolerance but not exact${split}: scheduled ${formatTokens(scheduledForPeriod)}, proposed ${formatTokens(groupTotal)} (difference ${formatTokens(diff)}).`,
          { rule: 'R2 — a near miss is surfaced for review, never passed silently', evidence }));
      } else {
        checks.push(check('amountMatches', 'FAIL',
          `Amount does not match the scheduled instalment${split}: scheduled ${formatTokens(scheduledForPeriod)}, proposed ${formatTokens(groupTotal)} (difference ${formatTokens(diff)}).`,
          { rule: 'R2 — outside tolerance', evidence }));
      }
    } else {
      checks.push(check('amountMatches', 'NEEDS_REVIEW',
        'The scheduled amount for this payment could not be established, so the amount was not verified.',
        { rule: 'R2 — an unverified amount is never a pass' }));
    }

    // 5. Not a duplicate ────────────────────────────────────────────────────
    const sig = `${normaliseGrantId(payment.grantRef)}|${payment.amount}|${payment.rawDate}`;
    const repeats = signatureCounts.get(sig) ?? 1;
    const historical = row
      ? (history.byGrantId.get(normaliseGrantId(row.grantId)) ?? []).filter(
          (h) => h.amount === payment.amount && h.date && payment.date
            && h.date.year === payment.date.year && h.date.month === payment.date.month
            && Math.abs(h.date.day - payment.date.day) <= 1,
        )
      : [];

    if (historical.length > 0) {
      checks.push(check('notDuplicated', 'FAIL',
        `A payment of ${formatTokens(payment.amount)} for this grant was already recorded on ${payment.rawDate} (${historical[0].sourceRef}).`,
        { rule: 'A payment already present in the payment history is a duplicate', evidence: { source: historical[0].sourceRef, expectedTokens: payment.amount } }));
    } else if (repeats > 1) {
      checks.push(check('notDuplicated', 'NEEDS_REVIEW',
        `${repeats} rows in this upload share the same grant, amount and date. Splitting an instalment is allowed, so this may be deliberate — confirm it is not an accidental duplicate.`,
        { rule: 'R3 — identical rows are surfaced for review rather than failed' }));
    } else if (history.incomplete) {
      checks.push(check('notDuplicated', 'NEEDS_REVIEW',
        `The payment history is incomplete${history.incompleteReason ? ` (${history.incompleteReason})` : ''}, so a duplicate could not be ruled out.`,
        { rule: 'Absence of evidence is not a pass' }));
    } else {
      checks.push(check('notDuplicated', 'PASS', 'No matching payment found in the payment history or elsewhere in this upload.'));
    }

    // 6 & 7. Exposure against both caps, counting the whole batch (R4) ──────
    if (!row) {
      checks.push(check('withinGrantCap', 'NEEDS_REVIEW', 'No schedule row, so the grant cap could not be checked.'));
      checks.push(check('withinScheduledToDate', 'NEEDS_REVIEW', 'No schedule row, so the scheduled-to-date limit could not be checked.'));
    } else {
      const grantKey = normaliseGrantId(row.grantId);
      const batchRows = batchByGrant.get(grantKey) ?? [r];
      const batchTotal = addTokens(...batchRows.map((b) => b.payment.amount));
      const already = paidToDate(history, row.grantId);
      const exposure = already + batchTotal;
      const batchNote = batchRows.length > 1 ? ` (${batchRows.length} rows in this batch totalling ${formatTokens(batchTotal)})` : '';

      // 6. Lifetime cap
      if (history.incomplete) {
        checks.push(check('withinGrantCap', 'NEEDS_REVIEW',
          `The payment history is incomplete${history.incompleteReason ? ` (${history.incompleteReason})` : ''}, so total exposure for this grant could not be established.`,
          { rule: 'R4a — absence of evidence is not a pass' }));
      } else if (row.totalTokens === null) {
        checks.push(check('withinGrantCap', 'NEEDS_REVIEW',
          `The schedule gives no total cap for ${row.grantId}, so overpayment against the grant could not be ruled out.`,
          { rule: 'R4a — a missing cap is never treated as unlimited', evidence: { source: row.sourceRef } }));
      } else if (exposure > row.totalTokens) {
        checks.push(check('withinGrantCap', 'FAIL',
          `This batch would take ${row.grantId} past its total cap${batchNote}: ${formatTokens(already)} already paid plus ${formatTokens(batchTotal)} proposed is ${formatTokens(exposure)}, against a cap of ${formatTokens(row.totalTokens)}.`,
          { rule: 'R4a — paid to date plus the whole batch must not exceed the grant cap', evidence: { source: row.sourceRef, expectedTokens: row.totalTokens, actualTokens: exposure } }));
      } else {
        checks.push(check('withinGrantCap', 'PASS',
          `Within the grant cap: ${formatTokens(exposure)} of ${formatTokens(row.totalTokens)}${batchNote}.`,
          { rule: 'R4a — paid to date plus the whole batch must not exceed the grant cap', evidence: { source: row.sourceRef, expectedTokens: row.totalTokens, actualTokens: exposure } }));
      }

      // 7. Scheduled to date
      if (!period) {
        checks.push(check('withinScheduledToDate', 'NEEDS_REVIEW', 'The payment date could not be read, so the scheduled-to-date limit could not be checked.'));
      } else if (history.incomplete) {
        checks.push(check('withinScheduledToDate', 'NEEDS_REVIEW',
          'The payment history is incomplete, so the scheduled-to-date limit could not be checked.',
          { rule: 'R4b — absence of evidence is not a pass' }));
      } else if (!ctx.cumulativePeriodsComplete) {
        checks.push(check('withinScheduledToDate', 'NEEDS_REVIEW',
          `The schedule columns before ${periodLabel(period)} were not all loaded, so the amount scheduled to date could not be totalled.`,
          { rule: 'R4b — absence of evidence is not a pass' }));
      } else {
        const due = scheduledThrough(row, period);
        if (exposure > due) {
          checks.push(check('withinScheduledToDate', 'FAIL',
            `This batch would pay ${row.grantId} ahead of schedule${batchNote}: ${formatTokens(exposure)} in total against ${formatTokens(due)} scheduled up to and including ${periodLabel(period)}.`,
            { rule: 'R4b — paid to date plus the whole batch must not exceed the amount scheduled by this period', evidence: { source: row.sourceRef, expectedTokens: due, actualTokens: exposure } }));
        } else {
          checks.push(check('withinScheduledToDate', 'PASS',
            `Within the amount scheduled to ${periodLabel(period)}: ${formatTokens(exposure)} of ${formatTokens(due)}.`,
            { rule: 'R4b — paid to date plus the whole batch must not exceed the amount scheduled by this period', evidence: { source: row.sourceRef, expectedTokens: due, actualTokens: exposure } }));
        }
      }
    }

    return {
      payment,
      outcome: outcomeForPayment(checks),
      checks,
      resolvedGrantId: row?.grantId,
      resolvedPeriod: period ?? undefined,
    };
  });
}

/** Build the tolerance from configured settings. */
export function toleranceFrom(relative: number, absolute: number): Tolerance {
  const parsed = parseTokens(absolute);
  return { relative, absolute: parsed.ok ? parsed.value : ZERO };
}

import {
  AMOUNT_TOLERANCE_PERCENT,
  AMOUNT_TOLERANCE_ABSOLUTE,
  DATE_TOLERANCE_DAYS,
} from './constants';
import type {
  CheckStatus,
  CheckDetail,
  VerificationResult,
  UnlockScheduleRow,
  CashFlowRow,
  ExcelTransaction,
  OcrTransaction,
} from './types';

function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    const parts = dateStr.split(/[/\-\.]/);
    if (parts.length === 3) {
      const [a, b, c] = parts.map(Number);
      if (a > 31) return new Date(a, b - 1, c);
      if (c > 31) return new Date(c, a - 1, b);
    }
    return null;
  }
  return d;
}

function daysDifference(date1: Date, date2: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.abs(Math.round((date1.getTime() - date2.getTime()) / msPerDay));
}

function worstStatus(...statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('RED')) return 'RED';
  if (statuses.includes('YELLOW')) return 'YELLOW';
  return 'GREEN';
}

function checkRecipientExists(
  transaction: ExcelTransaction,
  unlockSchedules: UnlockScheduleRow[]
): CheckDetail {
  const matchingGrants = unlockSchedules.filter(
    (s) => s.grantId.toLowerCase() === transaction.grantId.toLowerCase()
  );

  if (matchingGrants.length === 0) {
    return {
      status: 'RED',
      detail: `Grant ID "${transaction.grantId}" not found in token model`,
    };
  }

  const recipientMatch = matchingGrants.some(
    (s) => s.recipient.toLowerCase() === transaction.recipient.toLowerCase()
  );

  if (recipientMatch) {
    return {
      status: 'GREEN',
      detail: `Grant ID "${transaction.grantId}" found in token model with matching recipient "${transaction.recipient}"`,
    };
  }

  return {
    status: 'YELLOW',
    detail: `Grant ID "${transaction.grantId}" found but recipient mismatch: expected "${matchingGrants[0].recipient}", got "${transaction.recipient}"`,
  };
}

function checkAmountMatch(
  transaction: ExcelTransaction,
  matchingSchedules: UnlockScheduleRow[]
): CheckDetail {
  if (matchingSchedules.length === 0) {
    return {
      status: 'RED',
      detail: 'No matching schedule found to compare amount',
      expected: 0,
      actual: transaction.amount,
    };
  }

  const bestMatch = matchingSchedules.reduce((best, schedule) => {
    const diff = Math.abs(schedule.amount - transaction.amount);
    const bestDiff = Math.abs(best.amount - transaction.amount);
    return diff < bestDiff ? schedule : best;
  }, matchingSchedules[0]);

  const expected = bestMatch.amount;
  const actual = transaction.amount;

  if (expected === actual) {
    return {
      status: 'GREEN',
      detail: `Amount matches exactly: ${actual.toLocaleString()} tokens`,
      expected,
      actual,
    };
  }

  const percentDiff = expected !== 0 ? Math.abs(actual - expected) / expected : Infinity;
  const absoluteDiff = Math.abs(actual - expected);

  if (
    percentDiff <= AMOUNT_TOLERANCE_PERCENT &&
    absoluteDiff <= AMOUNT_TOLERANCE_ABSOLUTE
  ) {
    return {
      status: 'YELLOW',
      detail: `Amount within tolerance: expected ${expected.toLocaleString()}, got ${actual.toLocaleString()} (${(percentDiff * 100).toFixed(3)}% diff, ${absoluteDiff.toLocaleString()} tokens)`,
      expected,
      actual,
    };
  }

  return {
    status: 'RED',
    detail: `Amount mismatch: expected ${expected.toLocaleString()}, got ${actual.toLocaleString()} (${(percentDiff * 100).toFixed(3)}% diff, ${absoluteDiff.toLocaleString()} tokens)`,
    expected,
    actual,
  };
}

function checkTimingMatch(
  transaction: ExcelTransaction,
  matchingSchedules: UnlockScheduleRow[]
): CheckDetail {
  if (matchingSchedules.length === 0) {
    return {
      status: 'RED',
      detail: 'No matching schedule found to compare timing',
    };
  }

  const txDate = parseDate(transaction.unlockDate);
  if (!txDate) {
    return {
      status: 'RED',
      detail: `Cannot parse transaction date: "${transaction.unlockDate}"`,
      expectedDate: matchingSchedules[0].unlockDate,
      actualDate: transaction.unlockDate,
    };
  }

  let bestDays = Infinity;
  let bestSchedule = matchingSchedules[0];

  for (const schedule of matchingSchedules) {
    const schedDate = parseDate(schedule.unlockDate);
    if (schedDate) {
      const days = daysDifference(txDate, schedDate);
      if (days < bestDays) {
        bestDays = days;
        bestSchedule = schedule;
      }
    }
  }

  const schedDate = parseDate(bestSchedule.unlockDate);
  if (!schedDate) {
    return {
      status: 'RED',
      detail: `Cannot parse scheduled date: "${bestSchedule.unlockDate}"`,
      expectedDate: bestSchedule.unlockDate,
      actualDate: transaction.unlockDate,
    };
  }

  if (bestDays === 0) {
    return {
      status: 'GREEN',
      detail: `Date matches exactly: ${transaction.unlockDate}`,
      expectedDate: bestSchedule.unlockDate,
      actualDate: transaction.unlockDate,
    };
  }

  if (bestDays <= DATE_TOLERANCE_DAYS) {
    return {
      status: 'YELLOW',
      detail: `Date within tolerance: expected ${bestSchedule.unlockDate}, got ${transaction.unlockDate} (${bestDays} day${bestDays > 1 ? 's' : ''} difference)`,
      expectedDate: bestSchedule.unlockDate,
      actualDate: transaction.unlockDate,
    };
  }

  return {
    status: 'RED',
    detail: `Date mismatch: expected ${bestSchedule.unlockDate}, got ${transaction.unlockDate} (${bestDays} days difference)`,
    expectedDate: bestSchedule.unlockDate,
    actualDate: transaction.unlockDate,
  };
}

function checkDuplicate(
  transaction: ExcelTransaction,
  cashFlows: CashFlowRow[]
): CheckDetail {
  const matchingFlows = cashFlows.filter(
    (cf) => cf.grantId.toLowerCase() === transaction.grantId.toLowerCase()
  );

  if (matchingFlows.length === 0) {
    return {
      status: 'GREEN',
      detail: 'No prior distributions found for this grant ID',
    };
  }

  const txDate = parseDate(transaction.unlockDate);
  const duplicate = matchingFlows.some((cf) => {
    const amountMatch = Math.abs(cf.amount - transaction.amount) < 1;
    const cfDate = parseDate(cf.date);
    const dateMatch = txDate && cfDate && daysDifference(txDate, cfDate) <= 1;
    return amountMatch && dateMatch;
  });

  if (duplicate) {
    return {
      status: 'RED',
      detail: `Possible duplicate: a distribution of ${transaction.amount.toLocaleString()} tokens for grant "${transaction.grantId}" was already recorded around ${transaction.unlockDate}`,
    };
  }

  return {
    status: 'GREEN',
    detail: `No duplicate found among ${matchingFlows.length} prior distribution(s) for this grant`,
  };
}

function checkCumulative(
  transaction: ExcelTransaction,
  cashFlows: CashFlowRow[],
  unlockSchedules: UnlockScheduleRow[]
): CheckDetail {
  const schedules = unlockSchedules.filter(
    (s) => s.grantId.toLowerCase() === transaction.grantId.toLowerCase()
  );

  const totalGrantAmount = schedules.reduce((max, s) => {
    return s.totalGrantAmount && s.totalGrantAmount > max ? s.totalGrantAmount : max;
  }, 0);

  if (totalGrantAmount === 0) {
    return {
      status: 'GREEN',
      detail: 'No total grant amount defined — cumulative check skipped',
    };
  }

  const pastDistributions = cashFlows
    .filter((cf) => cf.grantId.toLowerCase() === transaction.grantId.toLowerCase())
    .reduce((sum, cf) => sum + cf.amount, 0);

  const newTotal = pastDistributions + transaction.amount;

  if (newTotal > totalGrantAmount) {
    return {
      status: 'RED',
      detail: `Cumulative total (${newTotal.toLocaleString()}) would exceed grant total (${totalGrantAmount.toLocaleString()}). Past distributions: ${pastDistributions.toLocaleString()}, this transaction: ${transaction.amount.toLocaleString()}`,
    };
  }

  return {
    status: 'GREEN',
    detail: `Cumulative total OK: ${newTotal.toLocaleString()} of ${totalGrantAmount.toLocaleString()} (${((newTotal / totalGrantAmount) * 100).toFixed(1)}% used)`,
  };
}

function fuzzyRecipientMatch(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function checkScreenshotMatch(
  transaction: ExcelTransaction,
  ocrTransactions: OcrTransaction[]
): CheckDetail {
  if (ocrTransactions.length === 0) {
    return {
      status: 'GREEN',
      detail: 'No screenshot data available',
    };
  }

  const amountTolerance = Math.max(transaction.amount * 0.001, 1);
  let bestMatch: OcrTransaction | null = null;
  let matchType: 'exact' | 'amount' | 'recipient' | null = null;

  for (const ocr of ocrTransactions) {
    const amountClose = Math.abs(ocr.amount - transaction.amount) <= amountTolerance;
    const recipientClose = fuzzyRecipientMatch(ocr.recipient, transaction.recipient);

    if (amountClose && recipientClose) {
      bestMatch = ocr;
      matchType = 'exact';
      break;
    }
    if (recipientClose && !bestMatch) {
      bestMatch = ocr;
      matchType = 'recipient';
    }
    if (amountClose && !bestMatch) {
      bestMatch = ocr;
      matchType = 'amount';
    }
  }

  if (!bestMatch) {
    return {
      status: 'RED',
      detail: `No matching screenshot transaction found for "${transaction.recipient}" (${transaction.amount.toLocaleString()} tokens)`,
    };
  }

  if (matchType === 'exact') {
    return {
      status: 'GREEN',
      detail: `Screenshot matches: "${bestMatch.recipient}" with ${bestMatch.amount.toLocaleString()} tokens`,
    };
  }

  const issues: string[] = [];
  if (matchType === 'recipient') {
    issues.push(
      `Amount: Excel=${transaction.amount.toLocaleString()}, Screenshot=${bestMatch.amount.toLocaleString()}`
    );
  }
  if (matchType === 'amount') {
    issues.push(
      `Recipient: Excel="${transaction.recipient}", Screenshot="${bestMatch.recipient}"`
    );
  }

  return {
    status: 'RED',
    detail: `Screenshot discrepancies: ${issues.join('; ')}`,
  };
}

export function verifyTransactions(
  transactions: ExcelTransaction[],
  unlockSchedules: UnlockScheduleRow[],
  cashFlows: CashFlowRow[],
  ocrTransactions?: OcrTransaction[]
): VerificationResult[] {
  return transactions.map((tx) => {
    if (tx.noteWarning && tx.notes) {
      const warningDetail: CheckDetail = {
        status: 'YELLOW',
        detail: `Skipped verification — Note: "${tx.notes}"`,
      };
      return {
        grantId: tx.grantId,
        recipient: tx.recipient,
        amount: tx.amount,
        date: tx.unlockDate,
        status: 'YELLOW' as CheckStatus,
        statusLabel: 'FYI' as const,
        walletAddress: tx.walletAddress,
        notes: tx.notes,
        checks: {
          recipientExists: warningDetail,
          amountMatch: warningDetail,
          timingMatch: warningDetail,
        },
      };
    }

    const matchingSchedules = unlockSchedules.filter(
      (s) => s.grantId.toLowerCase() === tx.grantId.toLowerCase()
    );

    const recipientExists = checkRecipientExists(tx, unlockSchedules);
    const amountMatch = checkAmountMatch(tx, matchingSchedules);
    const timingMatch = checkTimingMatch(tx, matchingSchedules);
    const duplicateCheck = checkDuplicate(tx, cashFlows);
    const cumulativeCheck = checkCumulative(tx, cashFlows, unlockSchedules);

    const checks: VerificationResult['checks'] = {
      recipientExists,
      amountMatch,
      timingMatch,
      duplicateCheck,
      cumulativeCheck,
    };

    if (ocrTransactions && ocrTransactions.length > 0) {
      checks.screenshotMatch = checkScreenshotMatch(tx, ocrTransactions);
    }

    const allStatuses = Object.values(checks)
      .filter((c): c is CheckDetail => c !== undefined)
      .map((c) => c.status);

    const status = worstStatus(...allStatuses);

    return {
      grantId: tx.grantId,
      recipient: tx.recipient,
      amount: tx.amount,
      date: tx.unlockDate,
      status,
      statusLabel: status === 'GREEN' ? 'PASS' as const : 'FAIL' as const,
      walletAddress: tx.walletAddress,
      notes: tx.notes,
      checks,
    };
  });
}

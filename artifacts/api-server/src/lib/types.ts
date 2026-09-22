export type CheckStatus = 'GREEN' | 'YELLOW' | 'RED';

export interface CheckDetail {
  status: CheckStatus;
  detail: string;
  expected?: number;
  actual?: number;
  expectedDate?: string;
  actualDate?: string;
}

export interface VerificationResult {
  grantId: string;
  recipient: string;
  amount: number;
  date: string;
  status: CheckStatus;
  /** Human-readable label: PASS, FAIL, or FYI. Defaults to PASS/FAIL based on status. */
  statusLabel?: 'PASS' | 'FAIL' | 'FYI';
  walletAddress?: string;
  notes?: string;
  checks: {
    recipientExists: CheckDetail;
    amountMatch: CheckDetail;
    timingMatch: CheckDetail;
    duplicateCheck?: CheckDetail;
    cumulativeCheck?: CheckDetail;
    screenshotMatch?: CheckDetail;
  };
}

export interface VerificationSummary {
  total: number;
  passed: number;
  warnings: number;
  failed: number;
}

export interface UnlockScheduleRow {
  grantId: string;
  recipient: string;
  amount: number;
  unlockDate: string;
  totalGrantAmount?: number;
  [key: string]: unknown;
}

export interface VestingScheduleRow {
  grantId: string;
  cliffDate?: string;
  cadence?: string;
  [key: string]: unknown;
}

export interface CashFlowRow {
  grantId: string;
  amount: number;
  date: string;
  trancheRef?: string;
  [key: string]: unknown;
}

export interface ExcelTransaction {
  grantId: string;
  recipient: string;
  amount: number;
  unlockDate: string;
  trancheRef?: string;
  walletAddress?: string;
  status?: string;
  notes?: string;
  noteWarning?: boolean;
  [key: string]: unknown;
}

export interface OcrTransaction {
  grantId?: string;
  recipient: string;
  amount: number;
  date?: string;
}

export interface SheetData {
  unlockSchedules: UnlockScheduleRow[];
  vestingSchedules: VestingScheduleRow[];
  cashFlows: CashFlowRow[];
  tokenModelSyncedAt: string;
  financeWorkbookSyncedAt?: string;
  /** True when the cash flow fetch failed (returned [] due to error, not genuinely empty) */
  cashFlowsFetchFailed?: boolean;
}

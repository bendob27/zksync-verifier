import OpenAI from 'openai';
import { logger } from './logger';
import { AMOUNT_TOLERANCE_PERCENT, AMOUNT_TOLERANCE_ABSOLUTE } from './constants';
import type {
  CheckStatus,
  CheckDetail,
  VerificationResult,
  ExcelTransaction,
  CashFlowRow,
  OcrTransaction,
} from './types';
import type { RawUnlockExtract } from './sheets';

// ────────────────────────────────────────────────────────────────
// Types for the AI response
// ────────────────────────────────────────────────────────────────

interface AIMatchResult {
  /** The Excel Grant Name / grant ID that was matched */
  excelGrantId: string;
  /** Whether a matching row was found in the token model */
  foundInTokenModel: boolean;
  /** The matched grant ID from the unlock schedule (may differ in formatting) */
  tokenModelGrantId?: string;
  /** The matched Name from the token model */
  tokenModelName?: string;
  /** The expected amount from the token model for the current month */
  expectedAmount?: number;
  /** The actual amount from the Excel */
  actualAmount: number;
  /** Whether the amounts match (within reasonable tolerance) */
  amountMatches: boolean;
  /** Human-readable note about the match quality or any issues */
  note: string;
}

// ────────────────────────────────────────────────────────────────
// Prompt construction
// ────────────────────────────────────────────────────────────────

function buildMatchingPrompt(
  excelTransactions: ExcelTransaction[],
  unlockExtract: RawUnlockExtract
): string {
  // Build a compact representation of the Excel data
  const excelSummary = excelTransactions.map((tx) => ({
    grantId: tx.grantId,
    recipient: tx.recipient,
    amount: tx.amount,
    unlockDate: tx.unlockDate,
  }));

  // Build the token model data representation
  let tokenModelData: string;
  if (unlockExtract.fallbackGrid) {
    // Fallback: send the raw grid and let Claude figure it out
    tokenModelData = `RAW GRID (headers not identified — please find the header row yourself):\n${unlockExtract.fallbackGrid.map((row, i) => `Row ${i}: ${row.join(' | ')}`).join('\n')}`;
  } else {
    // Normal: send the clean extract
    tokenModelData = `Headers: ${unlockExtract.headers.join(' | ')}\n`;
    tokenModelData += unlockExtract.rows.map((row) => row.join(' | ')).join('\n');
  }

  return `You are a financial verification assistant. Your job is to match pending token unlock transactions from an Excel file against the Back Office token model (Google Sheet).

## Excel Transactions (pending unlocks to verify)
${JSON.stringify(excelSummary, null, 2)}

## Token Model Data (Unlock Schedules from Back Office)
Month columns available: ${unlockExtract.monthLabel || 'current month'}
${tokenModelData}

## Matching Rules
1. The Excel "Grant Name" (grantId field) should match the unlock schedule's grant ID column. These might NOT be identical strings — use intelligent matching:
   - Try exact match first (e.g., "ACM001" = "ACM001")
   - Try with/without hyphens, spaces, zeros (e.g., "ACM002" = "ACM-002" = "ACM 002")
   - Try partial prefix matching (e.g., "ACM001" might match a row where the grant ID starts with "ACM")
   - **CRITICAL: If the grant ID doesn't match, also search by the Name column.** For example, if the export says grantId "ACM002" with recipient "Acme Labs", search for a row in the unlock schedule where the Name column contains "Acme Labs" or "Acme" or similar.
   - Some grants may have multiple rows in the token model (multiple streams/tranches). Match the one whose amount is closest to the Excel amount.
2. For each Excel transaction, find the matching row in the token model.
3. **Each transaction has an unlock date.** Use that date to pick the correct month column. For example, if a transaction date is in Mar 2026, use the "Mar 2026" column; if the date is in Apr 2026, use the "Apr 2026" column. The data may include multiple month columns. If the matching month column has no data for a matched row, check the adjacent month column.
4. Amounts should match. Small rounding differences (under ${AMOUNT_TOLERANCE_PERCENT * 100}% AND under ${AMOUNT_TOLERANCE_ABSOLUTE} tokens absolute) are acceptable and should be marked as amountMatches: true.
5. If a grant ID from the Excel truly does NOT appear in the token model data by ID or by name, mark it as not found. But search thoroughly first — try all matching strategies above before giving up.

## Response Format
Return ONLY a JSON array, no other text. Each element must have this exact structure:
{
  "excelGrantId": "the grant ID from the Excel",
  "foundInTokenModel": true/false,
  "tokenModelGrantId": "the matched grant ID from token model (or null)",
  "tokenModelName": "the Name value from token model (or null)",
  "expectedAmount": number or null,
  "actualAmount": number,
  "amountMatches": true/false,
  "note": "brief explanation"
}

Return one entry per Excel transaction, in the same order as the input.`;
}

// ────────────────────────────────────────────────────────────────
// Screenshot grouping for recipient-level comparison
// ────────────────────────────────────────────────────────────────

interface RecipientGroup {
  recipient: string;
  grantIds: string[];
  totalAmount: number;
}

function groupTransactionsByRecipient(transactions: ExcelTransaction[]): RecipientGroup[] {
  const groups = new Map<string, RecipientGroup>();

  for (const tx of transactions) {
    const key = tx.recipient.toLowerCase().trim();
    if (!groups.has(key)) {
      groups.set(key, {
        recipient: tx.recipient,
        grantIds: [],
        totalAmount: 0,
      });
    }
    const group = groups.get(key)!;
    group.grantIds.push(tx.grantId);
    group.totalAmount += tx.amount;
  }

  return [...groups.values()];
}

function fuzzyRecipientMatch(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function checkScreenshotMatchGrouped(
  transaction: ExcelTransaction,
  recipientGroups: RecipientGroup[],
  ocrTransactions: OcrTransaction[]
): CheckDetail {
  if (ocrTransactions.length === 0) {
    return {
      status: 'GREEN',
      detail: 'No screenshot data available',
    };
  }

  // Find which group this transaction belongs to
  const group = recipientGroups.find(
    (g) => g.recipient.toLowerCase() === transaction.recipient.toLowerCase()
  );

  if (!group) {
    return {
      status: 'RED',
      detail: `Could not find recipient group for "${transaction.recipient}"`,
    };
  }

  // Find the OCR transaction(s) that match this recipient
  const matchingOcr = ocrTransactions.filter((ocr) =>
    fuzzyRecipientMatch(ocr.recipient, group.recipient)
  );

  if (matchingOcr.length === 0) {
    return {
      status: 'YELLOW',
      detail: `No screenshot transaction found for recipient "${group.recipient}" (expected grouped total: ${group.totalAmount.toLocaleString()} tokens across grants: ${group.grantIds.join(', ')})`,
    };
  }

  // Sum the OCR amounts for this recipient (the custody platform may show one bundled withdrawal)
  const ocrTotal = matchingOcr.reduce((sum, ocr) => sum + ocr.amount, 0);
  const amountTolerance = Math.max(group.totalAmount * 0.001, 1);

  if (Math.abs(ocrTotal - group.totalAmount) <= amountTolerance) {
    return {
      status: 'GREEN',
      detail: `Screenshot matches: "${group.recipient}" grouped total ${ocrTotal.toLocaleString()} tokens matches expected ${group.totalAmount.toLocaleString()} tokens (grants: ${group.grantIds.join(', ')})`,
    };
  }

  // Check if there's a partial match — maybe the individual transaction amount matches
  const individualMatch = matchingOcr.some(
    (ocr) => Math.abs(ocr.amount - transaction.amount) <= Math.max(transaction.amount * 0.001, 1)
  );

  if (individualMatch) {
    return {
      status: 'GREEN',
      detail: `Screenshot matches individual transaction: "${transaction.recipient}" ${transaction.amount.toLocaleString()} tokens`,
    };
  }

  return {
    status: 'RED',
    detail: `Screenshot amount mismatch for "${group.recipient}": screenshot shows ${ocrTotal.toLocaleString()} tokens, expected grouped total ${group.totalAmount.toLocaleString()} tokens (grants: ${group.grantIds.join(', ')}). Difference: ${Math.abs(ocrTotal - group.totalAmount).toLocaleString()} tokens`,
    expected: group.totalAmount,
    actual: ocrTotal,
  };
}

// ────────────────────────────────────────────────────────────────
// Duplicate & cumulative checks (kept local — no AI needed)
// ────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────
// Main AI matching function
// ────────────────────────────────────────────────────────────────

export async function verifyWithAI(
  transactions: ExcelTransaction[],
  unlockExtract: RawUnlockExtract,
  cashFlows: CashFlowRow[],
  ocrTransactions?: OcrTransaction[],
  cashFlowsFetchFailed?: boolean
): Promise<VerificationResult[]> {
  // Separate noteWarning items (PAUSE, Skipping, no-wallet) — these skip AI entirely
  const warningTxs: ExcelTransaction[] = [];
  const normalTxs: ExcelTransaction[] = [];

  for (const tx of transactions) {
    if (tx.noteWarning && tx.notes) {
      warningTxs.push(tx);
    } else {
      normalTxs.push(tx);
    }
  }

  // Build results for PAUSE/Skipping/no-wallet items — these are FYI, not warnings
  const warningResults: VerificationResult[] = warningTxs.map((tx) => {
    const fyi: CheckDetail = {
      status: 'YELLOW',
      detail: `Not verified — ${tx.notes}`,
    };
    return {
      grantId: tx.grantId,
      recipient: tx.recipient,
      amount: tx.amount,
      date: tx.unlockDate,
      status: 'YELLOW' as CheckStatus,
      statusLabel: 'FYI',
      walletAddress: tx.walletAddress,
      notes: tx.notes,
      checks: {
        recipientExists: fyi,
        amountMatch: fyi,
        timingMatch: fyi,
      },
    };
  });

  // If no normal transactions to verify, return early
  if (normalTxs.length === 0) {
    return warningResults;
  }

  // Call Claude for the intelligent matching
  let aiResults: AIMatchResult[];
  try {
    aiResults = await callClaudeForMatching(normalTxs, unlockExtract);
  } catch (err) {
    logger.error({ err }, 'AI matching failed — falling back to RED for all transactions');
    // If AI fails, mark everything as RED with an error message
    aiResults = normalTxs.map((tx) => ({
      excelGrantId: tx.grantId,
      foundInTokenModel: false,
      actualAmount: tx.amount,
      amountMatches: false,
      note: `AI matching failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    }));
  }

  // Build a lookup from excelGrantId to AI result
  const aiResultMap = new Map<string, AIMatchResult>();
  for (const result of aiResults) {
    aiResultMap.set(result.excelGrantId.toLowerCase().trim(), result);
  }

  // Build recipient groups for screenshot matching
  const recipientGroups = groupTransactionsByRecipient(normalTxs);

  // Convert AI results into VerificationResult format
  const normalResults: VerificationResult[] = normalTxs.map((tx) => {
    const aiMatch = aiResultMap.get(tx.grantId.toLowerCase().trim());

    // recipientExists check — based on AI finding the grant in token model
    const recipientExists: CheckDetail = aiMatch?.foundInTokenModel
      ? {
          status: 'GREEN',
          detail: `Grant "${tx.grantId}" found in token model${aiMatch.tokenModelName ? ` — Name: "${aiMatch.tokenModelName}"` : ''}${aiMatch.tokenModelGrantId ? ` — Grant ID: "${aiMatch.tokenModelGrantId}"` : ''}`,
        }
      : {
          status: 'RED',
          detail: aiMatch
            ? `Grant "${tx.grantId}" not found in token model. ${aiMatch.note}`
            : `Grant "${tx.grantId}" — no AI match result returned`,
        };

    // amountMatch check — deterministic server-side arithmetic, NOT trusting AI's amountMatches
    let amountMatch: CheckDetail;
    if (!aiMatch?.foundInTokenModel) {
      amountMatch = {
        status: 'RED',
        detail: 'No matching schedule found to compare amount',
        expected: 0,
        actual: tx.amount,
      };
    } else {
      const expected = aiMatch.expectedAmount ?? 0;
      const actual = tx.amount;
      const diff = Math.abs(expected - actual);
      const percentDiff = expected !== 0 ? diff / expected : Infinity;

      // Server-side deterministic tolerance check — overrides AI's amountMatches boolean
      const amountWithinTolerance =
        expected != null && actual != null
          ? percentDiff <= AMOUNT_TOLERANCE_PERCENT && diff <= AMOUNT_TOLERANCE_ABSOLUTE
          : false;

      if (amountWithinTolerance) {
        amountMatch = {
          status: 'GREEN',
          detail: diff === 0
            ? `Amount matches exactly: ${actual.toLocaleString()} tokens. ${aiMatch.note}`
            : `Amount within tolerance: expected ${expected.toLocaleString()}, got ${actual.toLocaleString()} (${(percentDiff * 100).toFixed(3)}% diff). ${aiMatch.note}. Minor rounding difference of ~${diff.toFixed(2)} tokens (well within tolerance).`,
          expected,
          actual,
        };
      } else {
        amountMatch = {
          status: 'RED',
          detail: `Amount mismatch: expected ${expected.toLocaleString()}, got ${actual.toLocaleString()} (${expected !== 0 ? (percentDiff * 100).toFixed(3) : '∞'}% diff). ${aiMatch.note}`,
          expected,
          actual,
        };
      }
    }

    // timingMatch — simplified: if the AI found the grant and the month column matched,
    // the timing is implicitly verified (the token model only has data for specific months)
    let timingMatch: CheckDetail;
    if (!aiMatch?.foundInTokenModel) {
      timingMatch = {
        status: 'RED',
        detail: 'No matching schedule found to compare timing',
      };
    } else if (aiMatch.expectedAmount && aiMatch.expectedAmount > 0) {
      timingMatch = {
        status: 'GREEN',
        detail: `Token model has a non-zero amount for ${unlockExtract.monthLabel}, confirming an unlock is scheduled this month`,
        expectedDate: unlockExtract.monthLabel,
        actualDate: tx.unlockDate,
      };
    } else {
      timingMatch = {
        status: 'YELLOW',
        detail: `Grant found but token model shows 0 or no amount for ${unlockExtract.monthLabel} — the unlock may not be scheduled this month`,
        expectedDate: unlockExtract.monthLabel,
        actualDate: tx.unlockDate,
      };
    }

    // Duplicate check — purely local, no AI needed
    // If cash flow data fetch failed, flag as YELLOW instead of false GREEN
    const duplicateCheck = cashFlowsFetchFailed
      ? { status: 'YELLOW' as CheckStatus, detail: 'Cash flow data unavailable — duplicate check skipped' }
      : checkDuplicate(tx, cashFlows);

    // Assemble the checks object
    const checks: VerificationResult['checks'] = {
      recipientExists,
      amountMatch,
      timingMatch,
      duplicateCheck,
    };

    // Screenshot match — grouped by recipient for bundled custody withdrawals
    if (ocrTransactions && ocrTransactions.length > 0) {
      checks.screenshotMatch = checkScreenshotMatchGrouped(
        tx,
        recipientGroups,
        ocrTransactions
      );
    }

    // Determine overall status from PRIMARY checks only
    // Screenshot match is supplementary (shown in details but doesn't drive pass/fail)
    const primaryStatuses = [
      checks.recipientExists,
      checks.amountMatch,
      checks.timingMatch,
      checks.duplicateCheck,
    ]
      .filter((c): c is CheckDetail => c !== undefined)
      .map((c) => c.status);
    const status: CheckStatus = primaryStatuses.includes('RED')
      ? 'RED'
      : primaryStatuses.includes('YELLOW')
        ? 'YELLOW'
        : 'GREEN';

    return {
      grantId: tx.grantId,
      recipient: tx.recipient,
      amount: tx.amount,
      date: tx.unlockDate,
      status,
      walletAddress: tx.walletAddress,
      notes: tx.notes,
      checks,
    };
  });

  // Combine warning results + normal results, preserving original order
  const allResults: VerificationResult[] = [];
  let wIdx = 0;
  let nIdx = 0;
  for (const tx of transactions) {
    if (tx.noteWarning && tx.notes) {
      allResults.push(warningResults[wIdx++]);
    } else {
      allResults.push(normalResults[nIdx++]);
    }
  }

  return allResults;
}

// ────────────────────────────────────────────────────────────────
// OpenRouter API call (Claude Opus via OpenRouter)
// ────────────────────────────────────────────────────────────────

async function callClaudeForMatching(
  transactions: ExcelTransaction[],
  unlockExtract: RawUnlockExtract
): Promise<AIMatchResult[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is not set');
  }

  const prompt = buildMatchingPrompt(transactions, unlockExtract);

  // Log approximate token count for monitoring
  const approxTokens = Math.ceil(prompt.length / 4);
  logger.info({ approxTokens, transactionCount: transactions.length }, 'Calling Claude for AI matching via OpenRouter');

  if (approxTokens > 50000) {
    logger.warn({ approxTokens }, 'Prompt exceeds 50k token estimate — consider reducing data size');
  }

  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  });

  const response = await client.chat.completions.create({
    model: 'anthropic/claude-opus-4-6',
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const rawResponse = response.choices[0]?.message?.content;
  if (!rawResponse) {
    throw new Error('No text response from Claude via OpenRouter');
  }
  logger.info({ responseLength: rawResponse.length }, 'Claude AI matching response received');

  // Parse the JSON response — try direct parse first, then smart bracket-matching extraction
  let parsed: unknown;

  // Attempt 1: Direct JSON.parse (Claude may return clean JSON with no wrapper text)
  try {
    const direct = JSON.parse(rawResponse);
    if (Array.isArray(direct)) {
      parsed = direct;
    }
  } catch {
    // Not clean JSON — fall through to extraction
  }

  // Attempt 2: Find the last complete JSON array using bracket matching
  if (!parsed) {
    const lastBracket = rawResponse.lastIndexOf(']');
    if (lastBracket !== -1) {
      let depth = 0;
      let start = -1;
      for (let i = lastBracket; i >= 0; i--) {
        if (rawResponse[i] === ']') depth++;
        if (rawResponse[i] === '[') depth--;
        if (depth === 0) { start = i; break; }
      }
      if (start !== -1) {
        try {
          const extracted = JSON.parse(rawResponse.substring(start, lastBracket + 1));
          if (Array.isArray(extracted)) {
            parsed = extracted;
          }
        } catch (parseErr) {
          logger.error({ rawJson: rawResponse.substring(start, Math.min(start + 500, lastBracket + 1)) }, 'Failed to parse extracted JSON array from Claude response');
        }
      }
    }
  }

  if (!parsed || !Array.isArray(parsed)) {
    logger.error({ rawResponse: rawResponse.substring(0, 500) }, 'Could not find valid JSON array in Claude response');
    throw new Error('Claude response did not contain a valid JSON array');
  }

  // Validate result count — if AI returned a different number, something went wrong
  if (parsed.length !== transactions.length) {
    logger.warn(
      { expected: transactions.length, received: parsed.length },
      'AI returned different number of results than transactions sent — results may not align correctly'
    );
  }

  // Validate and type-check each result — require excelGrantId from AI response, never fall back to positional index
  const results: AIMatchResult[] = parsed.map((item: Record<string, unknown>) => {
    if (!item.excelGrantId) {
      logger.warn({ item }, 'AI result missing excelGrantId — result may be unmatched');
    }
    return {
      excelGrantId: String(item.excelGrantId || ''),
      foundInTokenModel: Boolean(item.foundInTokenModel),
      tokenModelGrantId: item.tokenModelGrantId ? String(item.tokenModelGrantId) : undefined,
      tokenModelName: item.tokenModelName ? String(item.tokenModelName) : undefined,
      expectedAmount: typeof item.expectedAmount === 'number' ? item.expectedAmount : (item.expectedAmount ? Number(item.expectedAmount) : undefined),
      actualAmount: typeof item.actualAmount === 'number' ? item.actualAmount : Number(item.actualAmount || 0),
      amountMatches: Boolean(item.amountMatches),
      note: String(item.note || ''),
    };
  });

  logger.info({
    resultCount: results.length,
    found: results.filter((r) => r.foundInTokenModel).length,
    amountMatched: results.filter((r) => r.amountMatches).length,
  }, 'AI matching results parsed');

  return results;
}

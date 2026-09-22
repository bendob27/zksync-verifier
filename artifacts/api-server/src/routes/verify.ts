import { Router, type IRouter } from 'express';
import multer from 'multer';
import { requireAuth } from '../lib/session';
import { parseExcelBuffer, getSheetNames } from '../lib/excel';
import { fetchAllSheetData, fetchRawUnlockData } from '../lib/sheets';
import { verifyWithAI } from '../lib/ai-matcher';
import { extractTransactionsFromScreenshots, isApiKeyAvailable } from '../lib/ocr';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router: IRouter = Router();

router.post('/verify/sheets', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    const names = await getSheetNames(req.file.buffer);
    res.json({ sheetNames: names });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read sheet names';
    req.log.error({ err }, 'Sheet names error');
    res.status(400).json({ error: message });
  }
});

router.post('/verify', requireAuth, upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'screenshots', maxCount: 10 },
]), async (req, res) => {
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const excelFile = files?.file?.[0];

    if (!excelFile) {
      res.status(400).json({ error: 'No Excel file uploaded' });
      return;
    }

    const filename = excelFile.originalname?.toLowerCase() || '';
    if (!filename.endsWith('.xlsx') && !filename.endsWith('.xls')) {
      res.status(400).json({ error: 'Not an Excel file. Please upload .xlsx' });
      return;
    }

    const sheetName = req.body?.sheetName || undefined;

    req.log.info({ filename: excelFile.originalname, size: excelFile.size, sheetName }, 'Parsing Excel file');

    // Step 1: Parse the Excel file first (we need the grant IDs for the sheet fetch)
    const excelResult = await parseExcelBuffer(excelFile.buffer, sheetName);
    const excelGrantIds = excelResult.transactions.map((tx) => tx.grantId);

    // Step 2: Fetch sheet data and raw unlock extract in parallel
    const [sheetData, unlockExtract] = await Promise.all([
      fetchAllSheetData(),
      fetchRawUnlockData(excelGrantIds),
    ]);

    // Step 3: Process screenshots (OCR) if provided
    const screenshotFiles = files?.screenshots || [];
    const imageBuffers = screenshotFiles
      .filter((f) => f.mimetype.startsWith('image/'))
      .map((f) => ({ buffer: f.buffer, mimeType: f.mimetype }));

    let ocrTransactions: { recipient: string; amount: number; date?: string }[] = [];
    let ocrRawText: string | undefined;

    if (imageBuffers.length > 0 && isApiKeyAvailable()) {
      req.log.info({ imageCount: imageBuffers.length }, 'Running OCR on screenshots');
      const ocrResult = await extractTransactionsFromScreenshots(imageBuffers);
      ocrTransactions = ocrResult.transactions;
      ocrRawText = ocrResult.rawText;
      req.log.info({ ocrTransactionCount: ocrTransactions.length }, 'OCR extraction complete');
    }

    req.log.info(
      {
        transactionCount: excelResult.transactions.length,
        scheduleCount: sheetData.unlockSchedules.length,
        cashFlowCount: sheetData.cashFlows.length,
        ocrCount: ocrTransactions.length,
        unlockExtractRows: unlockExtract.rows.length,
        hasFallback: !!unlockExtract.fallbackGrid,
      },
      'Running AI-powered verification'
    );

    // Step 4: Run the AI-powered verification
    const results = await verifyWithAI(
      excelResult.transactions,
      unlockExtract,
      sheetData.cashFlows,
      ocrTransactions.length > 0
        ? ocrTransactions.map((t) => ({
            recipient: t.recipient,
            amount: t.amount,
            date: t.date,
          }))
        : undefined,
      sheetData.cashFlowsFetchFailed
    );

    const summary = {
      total: results.length,
      passed: results.filter((r) => r.status === 'GREEN').length,
      warnings: results.filter((r) => r.status === 'YELLOW').length,
      failed: results.filter((r) => r.status === 'RED').length,
    };

    // Build structured text summary for the dashboard
    const passedItems = results.filter((r) => r.status === 'GREEN');
    const failedItems = results.filter((r) => r.status === 'RED');
    const fyiItems = results.filter((r) => r.status === 'YELLOW');

    // Group by recipient for cleaner summary
    const uniquePassedRecipients = [...new Set(passedItems.map((r) => r.recipient))];
    const uniqueFyiRecipients = [...new Set(fyiItems.map((r) => r.recipient))];

    const failedSummaries = failedItems.map((r) => {
      const screenshotCheck = r.checks.screenshotMatch;
      const amountCheck = r.checks.amountMatch;
      let reason = '';
      if (screenshotCheck?.status === 'RED') {
        const diff = screenshotCheck.expected && screenshotCheck.actual
          ? Math.abs(screenshotCheck.expected - screenshotCheck.actual)
          : 0;
        reason = diff > 0 ? `${diff.toLocaleString()} ZK discrepancy vs custody queue` : 'screenshot mismatch';
      } else if (amountCheck?.status === 'RED') {
        reason = 'amount mismatch vs token model';
      } else if (r.checks.recipientExists?.status === 'RED') {
        reason = 'not found in token model';
      } else if (r.checks.duplicateCheck?.status === 'RED') {
        reason = 'possible duplicate';
      } else {
        reason = 'verification failed';
      }
      return `${r.recipient} (${r.grantId}): ${reason}`;
    });

    // Group failed by recipient to avoid repetition
    const failedByRecipient = new Map<string, string[]>();
    for (const item of failedItems) {
      const reasons = failedByRecipient.get(item.recipient) || [];
      reasons.push(item.grantId);
      failedByRecipient.set(item.recipient, reasons);
    }

    const textSummary = {
      safeToSign: uniquePassedRecipients.length > 0
        ? `Safe to sign: ${uniquePassedRecipients.join(', ')}`
        : 'Safe to sign: none',
      needsInvestigation: failedSummaries.length > 0
        ? `Needs investigation: ${failedSummaries.join('; ')}`
        : 'Needs investigation: none',
      excluded: uniqueFyiRecipients.length > 0
        ? `Excluded (PAUSE/no wallet): ${uniqueFyiRecipients.join(', ')}`
        : 'Excluded: none',
    };

    res.json({
      results,
      summary,
      textSummary,
      sheetNames: excelResult.sheetNames,
      selectedSheet: excelResult.selectedSheet,
      tokenModelSyncedAt: sheetData.tokenModelSyncedAt,
      financeWorkbookSyncedAt: sheetData.financeWorkbookSyncedAt,
      ocrTransactionCount: ocrTransactions.length,
      ocrRawText: ocrRawText,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verification failed';
    req.log.error({ err }, 'Verification error');
    res.status(400).json({ error: message });
  }
});

export default router;

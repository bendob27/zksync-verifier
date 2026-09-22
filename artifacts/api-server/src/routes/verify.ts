import { Router, type IRouter } from 'express';
import multer from 'multer';
import { requireAuth } from '../lib/session';
import { fetchRange } from '../lib/sheets';
import {
  TOKEN_MODEL_SHEET_ID, FINANCE_WORKBOOK_SHEET_ID, TOKEN_MODEL_TABS,
  FINANCE_WORKBOOK_TABS, GRANT_ID_HEADER,
  AMOUNT_TOLERANCE_PERCENT, AMOUNT_TOLERANCE_ABSOLUTE,
} from '../lib/constants';
import { readCustodyExport } from '../lib/verification/custodyExport';
import { runVerification } from '../lib/verification/run';
import { proposeWithModel } from '../lib/verification/propose';
import { readCustodyScreenshots } from '../lib/verification/readQueue';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 11 },
});

const router: IRouter = Router();

const CONFIG = {
  scheduleSheetId: TOKEN_MODEL_SHEET_ID,
  scheduleTab: TOKEN_MODEL_TABS.UNLOCK_SCHEDULES,
  historySheetId: FINANCE_WORKBOOK_SHEET_ID,
  historyTab: FINANCE_WORKBOOK_TABS.ALL_CASH_FLOWS,
  grantIdHeader: GRANT_ID_HEADER,
  toleranceRelative: AMOUNT_TOLERANCE_PERCENT,
  toleranceAbsolute: AMOUNT_TOLERANCE_ABSOLUTE,
};

router.post('/verify/sheets', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    const { sheetNames } = await readCustodyExport(req.file.buffer);
    res.json({ sheetNames });
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
    const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
    const excelFile = files?.file?.[0];

    if (!excelFile) {
      res.status(400).json({ error: 'No Excel file uploaded' });
      return;
    }

    const filename = excelFile.originalname?.toLowerCase() ?? '';
    if (!filename.endsWith('.xlsx') && !filename.endsWith('.xls')) {
      res.status(400).json({ error: 'Not an Excel file. Please upload .xlsx' });
      return;
    }

    const screenshots = (files?.screenshots ?? []).map((f) => ({
      buffer: f.buffer,
      mimeType: f.mimetype,
    }));

    req.log.info(
      { filename: excelFile.originalname, size: excelFile.size, screenshots: screenshots.length },
      'Starting verification run',
    );

    const result = await runVerification(
      {
        excel: excelFile.buffer,
        sheetName: req.body?.sheetName || undefined,
        screenshots,
      },
      CONFIG,
      {
        fetchRange,
        propose: process.env.OPENROUTER_API_KEY ? proposeWithModel : undefined,
        readScreenshots: process.env.OPENROUTER_API_KEY ? readCustodyScreenshots : undefined,
        appVersion: process.env.APP_VERSION ?? 'dev',
      },
    );

    req.log.info(
      {
        runId: result.provenance.runId,
        cleared: result.summary.allRequiredChecksPassed,
        failed: result.summary.failed,
        needsReview: result.summary.needsReview,
      },
      'Verification run complete',
    );

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verification failed';
    req.log.error({ err }, 'Verification error');
    res.status(400).json({ error: message });
  }
});

export default router;

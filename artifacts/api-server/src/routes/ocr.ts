import { Router, type IRouter } from 'express';
import multer from 'multer';
import { requireAuth } from '../lib/session';
import { readCustodyScreenshots } from '../lib/verification/readQueue';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 /* stays under the 4.5 MB serverless body cap */, files: 10 },
});

const router: IRouter = Router();

router.get('/ocr/status', requireAuth, (_req, res) => {
  res.json({ available: Boolean(process.env.OPENROUTER_API_KEY) });
});

// Reads screenshots on their own, for checking what the queue contains before running a
// full verification. The result is evidence to look at, not a verdict.
router.post('/ocr', requireAuth, upload.array('files', 10), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No files uploaded' });
      return;
    }

    const { lines, failures } = await readCustodyScreenshots(
      files.map((f) => ({ buffer: f.buffer, mimeType: f.mimetype })),
    );

    res.json({
      transactions: lines.map((l) => ({
        recipient: l.recipient,
        amount: l.amount,
        date: l.date,
        source: l.sourceRef,
      })),
      // Reported explicitly: a partial read must not look like a complete one.
      imagesRead: files.length - failures.length,
      imagesTotal: files.length,
      failures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read screenshots';
    req.log.error({ err }, 'Screenshot read error');
    res.status(400).json({ error: message });
  }
});

export default router;

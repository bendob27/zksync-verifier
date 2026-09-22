import { Router, type IRouter } from 'express';
import multer from 'multer';
import { requireAuth } from '../lib/session';
import { extractTransactionsFromScreenshots, isApiKeyAvailable } from '../lib/ocr';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router: IRouter = Router();

router.get('/ocr/status', requireAuth, (req, res) => {
  res.json({ available: isApiKeyAvailable() });
});

router.post('/ocr', requireAuth, upload.array('files', 10), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No files uploaded' });
      return;
    }

    const imageBuffers = files
      .filter((f) => f.mimetype.startsWith('image/'))
      .map((f) => ({
        buffer: f.buffer,
        mimeType: f.mimetype,
      }));

    if (imageBuffers.length === 0) {
      res.status(400).json({ error: 'No valid image files found. Please upload PNG or JPG files.' });
      return;
    }

    req.log.info({ imageCount: imageBuffers.length }, 'Running OCR extraction');

    const result = await extractTransactionsFromScreenshots(imageBuffers);

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OCR extraction failed';
    req.log.error({ err }, 'OCR error');
    res.status(500).json({ error: message });
  }
});

export default router;

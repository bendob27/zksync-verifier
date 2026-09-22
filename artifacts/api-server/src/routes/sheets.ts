import { Router, type IRouter } from 'express';
import { requireAuth } from '../lib/session';
import { checkSheetsAccess } from '../lib/sheets';

const router: IRouter = Router();

router.get('/sheets', requireAuth, async (req, res) => {
  try {
    const status = await checkSheetsAccess();
    res.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to check Google Sheets';
    req.log.error({ err }, 'Sheets status error');
    res.status(500).json({ error: message });
  }
});

export default router;

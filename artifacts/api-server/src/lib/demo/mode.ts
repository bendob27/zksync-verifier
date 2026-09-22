/**
 * Demo mode.
 *
 * A public instance that shows the verification engine working on invented data. It makes
 * no network calls at all — no spreadsheet, no AI provider — so it needs no credentials.
 *
 * Two deliberate design choices:
 *
 *   1. Authentication is NOT bypassed. There is no code path anywhere that skips
 *      requireAuth. The demo simply publishes its own password on the login page, so a
 *      visitor gets in with one click while the real middleware stays exactly as it is.
 *      A bug in this file therefore cannot open up a real deployment.
 *
 *   2. Demo mode is opt-in through a single environment variable and is reported loudly at
 *      boot. It cannot be turned on by a request, a header or a query parameter.
 */

import ExcelJS from 'exceljs';
import type { RangeFetcher } from '../verification/loadSources';
import type { ScreenshotReader } from '../verification/run';
import {
  DEMO_EXPORT_ROWS, DEMO_HISTORY_GRID, DEMO_QUEUE_LINES, DEMO_SCHEDULE_GRID,
} from './data';

export const DEMO_PASSWORD = 'demo';

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === 'true';
}

/** Config the demo run uses. These ids address nothing; the fetcher ignores them. */
export const DEMO_CONFIG = {
  scheduleSheetId: 'demo-schedule',
  scheduleTab: 'Unlock Schedules',
  historySheetId: 'demo-history',
  historyTab: 'Cash Flows',
  grantIdHeader: 'Grant ID',
} as const;

/**
 * Stands in for the Google Sheets client, serving the bundled grids.
 * Slices by the requested start row so it behaves like the real range fetcher.
 */
export const demoFetchRange: RangeFetcher = async (sheetId, range) => {
  const grid = sheetId === DEMO_CONFIG.scheduleSheetId ? DEMO_SCHEDULE_GRID : DEMO_HISTORY_GRID;
  const m = /!A(\d+):/.exec(range);
  const start = m ? Number(m[1]) : 1;
  return grid.slice(start - 1).map((row) => [...row]);
};

/** Stands in for reading screenshots, returning the bundled queue. */
export const demoReadScreenshots: ScreenshotReader = async () => ({
  lines: DEMO_QUEUE_LINES.map((l) => ({
    recipient: l.recipient,
    amount: l.amount,
    date: l.date,
    sourceRef: 'sample custody queue',
  })),
  failures: [],
});

/** Build the sample custody export as a real .xlsx, so the demo exercises the real reader. */
export async function buildDemoExport(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ZK Unlock Verifier — demo';
  const ws = wb.addWorksheet('CW25');

  const headers = [
    'Event Type', 'Grant Name', 'Recipient Name', 'Active Wallet Address',
    'Event Date', 'Status', 'Token Amount', 'Notes',
  ];
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };

  for (const r of DEMO_EXPORT_ROWS) {
    ws.addRow([
      r.eventType, r.grantName, r.recipient, r.wallet,
      r.eventDate, r.status, r.amount, r.notes,
    ]);
  }

  ws.columns.forEach((c) => { c.width = 22; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A single fake image, so the demo run has custody queue evidence to reconcile against. */
export function demoScreenshotStand(): Array<{ buffer: Buffer; mimeType: string }> {
  return [{ buffer: Buffer.from('demo'), mimeType: 'image/png' }];
}

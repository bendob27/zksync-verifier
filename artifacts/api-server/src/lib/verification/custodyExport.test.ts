import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { readCustodyExport } from './custodyExport';
import { tokensToString } from './money';
import { formatDate } from './period';

/** Build a real .xlsx in memory, so the parser is exercised against a genuine file. */
export async function buildExport(
  rows: Array<Record<string, unknown>>,
  opts: { sheetName?: string; headers?: string[] } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(opts.sheetName ?? 'CW24');
  const headers = opts.headers ?? [
    'Event Type', 'Grant Name', 'Recipient Name', 'Active Wallet Address',
    'Event Date', 'Status', 'Token Amount', 'Notes',
  ];
  ws.addRow(headers);
  for (const r of rows) ws.addRow(headers.map((h) => r[h] ?? null));
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

const validRow = {
  'Event Type': 'Unlock',
  'Grant Name': 'ACM001',
  'Recipient Name': 'Acme Labs',
  'Active Wallet Address': '0xabc',
  'Event Date': '15/06/2026',
  Status: 'PENDING',
  'Token Amount': 123456.78,
  Notes: 'Ok',
};

describe('reading a custody export', () => {
  it('reads a valid row exactly', async () => {
    const r = await readCustodyExport(await buildExport([validRow]));
    expect(r.payments).toHaveLength(1);
    const p = r.payments[0];
    expect(p.grantRef).toBe('ACM001');
    expect(p.recipient).toBe('Acme Labs');
    expect(tokensToString(p.amount)).toBe('123456.78');
    expect(formatDate(p.date!)).toBe('2026-06-15');
    expect(p.walletAddress).toBe('0xabc');
  });

  it('keeps a native date cell rather than stringifying and re-parsing it', async () => {
    const r = await readCustodyExport(await buildExport([
      { ...validRow, 'Event Date': new Date(Date.UTC(2026, 5, 15)) },
    ]));
    expect(formatDate(r.payments[0].date!)).toBe('2026-06-15');
  });

  it('gives identical rows stable but distinct identifiers', async () => {
    const r = await readCustodyExport(await buildExport([validRow, validRow]));
    expect(r.payments).toHaveLength(2);
    expect(r.payments[0].paymentId).not.toBe(r.payments[1].paymentId);
    const again = await readCustodyExport(await buildExport([validRow, validRow]));
    expect(again.payments.map((p) => p.paymentId)).toEqual(r.payments.map((p) => p.paymentId));
  });
});

describe('every row is accounted for', () => {
  it('lists a non-pending row as skipped, with the reason', async () => {
    const r = await readCustodyExport(await buildExport([
      validRow,
      { ...validRow, Status: 'UNLOCKED' },
    ]));
    expect(r.payments).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toContain('UNLOCKED');
    expect(r.totalDataRows).toBe(2);
  });

  it('lists a non-unlock event as skipped', async () => {
    const r = await readCustodyExport(await buildExport([
      { ...validRow, 'Event Type': 'Transfer' },
    ]));
    expect(r.payments).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/not an unlock/);
  });

  it('records an unreadable amount as a hole, never as zero', async () => {
    const r = await readCustodyExport(await buildExport([
      { ...validRow, 'Token Amount': 'n/a' },
    ]));
    expect(r.payments).toHaveLength(0);
    expect(r.unreadable).toHaveLength(1);
    expect(r.unreadable[0].reason).toMatch(/could not be read/);
  });

  it('carries an unreadable date through as null instead of dropping the row', async () => {
    const r = await readCustodyExport(await buildExport([
      { ...validRow, 'Event Date': 'whenever' },
    ]));
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0].date).toBeNull();
    expect(r.payments[0].rawDate).toBe('whenever');
  });

  it('keeps a paused row so it can be flagged, rather than discarding it', async () => {
    const r = await readCustodyExport(await buildExport([
      { ...validRow, Notes: 'PAUSE' },
    ]));
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0].notes).toBe('PAUSE');
  });
});

describe('amounts written as text', () => {
  it('reads a European-formatted amount correctly', async () => {
    const r = await readCustodyExport(await buildExport([
      { ...validRow, 'Token Amount': '123.456,78' },
    ]));
    expect(tokensToString(r.payments[0].amount)).toBe('123456.78');
  });

  it('does not inflate a sub-1000 comma decimal by a hundred', async () => {
    const r = await readCustodyExport(await buildExport([
      { ...validRow, 'Token Amount': '999,99' },
    ]));
    expect(tokensToString(r.payments[0].amount)).toBe('999.99');
  });
});

describe('malformed files', () => {
  it('names the missing columns', async () => {
    const buf = await buildExport([{ Foo: 1 }], { headers: ['Foo'] });
    await expect(readCustodyExport(buf)).rejects.toThrow(/Missing required columns/);
  });

  it('lists the sheets when the requested one is absent', async () => {
    const buf = await buildExport([validRow], { sheetName: 'CW24' });
    await expect(readCustodyExport(buf, 'CW99')).rejects.toThrow(/Available sheets: CW24/);
  });
});

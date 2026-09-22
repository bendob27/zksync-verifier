/**
 * Reading the weekly custody export.
 *
 * Differences from the original parser, all of them deliberate:
 *   - reads `cell.value`, not `cell.text`, so a native date or numeric cell keeps its type
 *     instead of being stringified and re-parsed
 *   - an amount or date that cannot be read is an ERROR on that row, not a zero
 *   - every row is accounted for: anything not verified is listed with a reason, so a
 *     silently dropped row can no longer look like a clean batch
 */

import ExcelJS from 'exceljs';
import { parseTokens, tokensToString } from './money';
import { parseDate } from './period';
import { mintPaymentId } from './engine';
import type { PaymentIdentity } from './model';

export interface SkippedRow {
  rowNumber: number;
  reason: string;
  grantRef?: string;
}

export interface CustodyExportResult {
  payments: PaymentIdentity[];
  /** Rows deliberately not verified (wrong event type, not pending), with the reason. */
  skipped: SkippedRow[];
  /** Rows that should have been verified but could not be read. These block a clean pass. */
  unreadable: SkippedRow[];
  sheetNames: string[];
  selectedSheet: string;
  /** Every row seen below the header, whatever became of it. */
  totalDataRows: number;
}

const COLUMNS = {
  grantRef: ['Grant Name', 'Grant ID', 'GrantID'],
  recipient: ['Recipient Name', 'Recipient', 'Grantee', 'Name'],
  amount: ['Token Amount', 'Amount', 'Tokens', 'Unlock Amount'],
  date: ['Event Date', 'Unlock Date', 'Date', 'Scheduled Date'],
  status: ['Status'],
  notes: ['Notes', 'Note'],
  eventType: ['Event Type'],
  wallet: ['Active Wallet Address', 'Wallet Address', 'Wallet'],
} as const;

function columnIndex(headers: string[], names: readonly string[]): number {
  for (const name of names) {
    const idx = headers.findIndex((h) => h?.trim().toLowerCase() === name.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

/** ExcelJS returns rich objects for formulas and hyperlinks; reduce to the underlying value. */
function cellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return o.result;      // formula
    if ('text' in o) return o.text;          // hyperlink / rich text
    if ('richText' in o && Array.isArray(o.richText)) {
      return (o.richText as Array<{ text: string }>).map((r) => r.text).join('');
    }
  }
  return v;
}

function asText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

export async function readCustodyExport(
  buffer: Buffer,
  sheetName?: string,
): Promise<CustodyExportResult> {
  const workbook = new ExcelJS.Workbook();
  // exceljs ships its own ambient Buffer declaration, unrelated to Node's.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const sheetNames = workbook.worksheets.map((ws) => ws.name);
  if (sheetNames.length === 0) throw new Error('No worksheets found in the uploaded file.');

  const selectedSheet = sheetName || sheetNames[0];
  const worksheet = workbook.getWorksheet(selectedSheet);
  if (!worksheet) {
    throw new Error(`Sheet "${selectedSheet}" not found. Available sheets: ${sheetNames.join(', ')}`);
  }

  const headers: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = asText(cellValue(cell));
  });

  const idx = {
    grantRef: columnIndex(headers, COLUMNS.grantRef),
    recipient: columnIndex(headers, COLUMNS.recipient),
    amount: columnIndex(headers, COLUMNS.amount),
    date: columnIndex(headers, COLUMNS.date),
    status: columnIndex(headers, COLUMNS.status),
    notes: columnIndex(headers, COLUMNS.notes),
    eventType: columnIndex(headers, COLUMNS.eventType),
    wallet: columnIndex(headers, COLUMNS.wallet),
  };

  const missing = (['grantRef', 'recipient', 'amount', 'date', 'status'] as const)
    .filter((k) => idx[k] === -1)
    .map((k) => COLUMNS[k][0]);
  if (missing.length > 0) {
    throw new Error(
      `This doesn't look like a custody export. Missing required columns: ${missing.join(', ')}. Found: ${headers.filter(Boolean).join(', ')}.`,
    );
  }

  const payments: PaymentIdentity[] = [];
  const skipped: SkippedRow[] = [];
  const unreadable: SkippedRow[] = [];
  let totalDataRows = 0;

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    totalDataRows++;

    const get = (i: number): unknown => (i === -1 ? undefined : cellValue(row.getCell(i + 1)));

    const grantRef = asText(get(idx.grantRef));
    if (grantRef === '') {
      skipped.push({ rowNumber, reason: 'no grant reference in this row' });
      return;
    }

    const eventType = asText(get(idx.eventType)).toLowerCase();
    if (eventType !== '' && eventType !== 'unlock') {
      skipped.push({ rowNumber, grantRef, reason: `event type is "${eventType}", not an unlock` });
      return;
    }

    const status = asText(get(idx.status)).toUpperCase();
    if (status !== '' && status !== 'PENDING') {
      skipped.push({ rowNumber, grantRef, reason: `status is "${status}", not PENDING` });
      return;
    }

    // From here the row SHOULD be verified. Anything unreadable is a hole, not a skip.
    const rawAmount = get(idx.amount);
    const amount = parseTokens(rawAmount);
    if (!amount.ok) {
      unreadable.push({
        rowNumber, grantRef,
        reason: `amount "${asText(rawAmount)}" could not be read (${amount.reason})`,
      });
      return;
    }

    const rawDateValue = get(idx.date);
    const rawDate = asText(rawDateValue);
    const parsed = parseDate(rawDateValue);

    payments.push({
      paymentId: mintPaymentId(rowNumber, grantRef, tokensToString(amount.value), rawDate),
      rowNumber,
      grantRef,
      recipient: asText(get(idx.recipient)),
      amount: amount.value,
      // A date we cannot read is carried as null; the engine turns that into a review item
      // rather than dropping the row.
      date: parsed.ok ? parsed.value : null,
      rawDate,
      walletAddress: asText(get(idx.wallet)) || undefined,
      status: status || undefined,
      notes: asText(get(idx.notes)) || undefined,
    });
  });

  return { payments, skipped, unreadable, sheetNames, selectedSheet, totalDataRows };
}

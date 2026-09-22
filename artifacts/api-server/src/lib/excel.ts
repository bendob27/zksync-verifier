import ExcelJS from 'exceljs';
import type { ExcelTransaction } from './types';

export interface ExcelParseResult {
  transactions: ExcelTransaction[];
  sheetNames: string[];
  selectedSheet: string;
}

function parseDateDDMMYYYY(dateStr: string): string {
  if (!dateStr) return '';
  const cleaned = dateStr.split(',')[0].trim();
  const parts = cleaned.split('/');
  if (parts.length === 3) {
    const [day, month, year] = parts;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return dateStr;
}

const WARNING_NOTES = ['pause', 'skip', 'no wallet', 'cancel'];

function isWarningNote(note: string): boolean {
  const lower = note.toLowerCase().trim();
  return WARNING_NOTES.some((w) => lower.includes(w));
}

function findColumnIndex(headers: string[], possibleNames: string[]): number {
  for (const name of possibleNames) {
    const idx = headers.findIndex(
      (h) => h?.toString().trim().toLowerCase() === name.toLowerCase()
    );
    if (idx !== -1) return idx;
  }
  return -1;
}

export async function getSheetNames(buffer: Buffer): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  // exceljs ships its own ambient `declare interface Buffer extends ArrayBuffer {}`,
  // which is unrelated to Node's Buffer, so its published signature doesn't accept
  // the Buffer it actually reads at runtime. Cast to exceljs's own parameter type.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook.worksheets.map((ws) => ws.name);
}

export async function parseExcelBuffer(
  buffer: Buffer,
  sheetName?: string
): Promise<ExcelParseResult> {
  const workbook = new ExcelJS.Workbook();
  // exceljs ships its own ambient `declare interface Buffer extends ArrayBuffer {}`,
  // which is unrelated to Node's Buffer, so its published signature doesn't accept
  // the Buffer it actually reads at runtime. Cast to exceljs's own parameter type.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const sheetNames = workbook.worksheets.map((ws) => ws.name);

  if (sheetNames.length === 0) {
    throw new Error('No worksheets found in the uploaded file.');
  }

  const selectedSheet = sheetName || sheetNames[0];
  const worksheet = workbook.getWorksheet(selectedSheet);
  if (!worksheet) {
    throw new Error(`Sheet "${selectedSheet}" not found. Available sheets: ${sheetNames.join(', ')}`);
  }

  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = cell.text?.trim() || '';
  });

  if (headers.length === 0) {
    throw new Error('Empty sheet. No headers found in row 1.');
  }

  const grantNameIdx = findColumnIndex(headers, ['Grant Name', 'Grant ID', 'GrantID']);
  const recipientIdx = findColumnIndex(headers, ['Recipient Name', 'Recipient', 'Grantee', 'Name']);
  const amountIdx = findColumnIndex(headers, ['Token Amount', 'Amount', 'Tokens', 'Unlock Amount']);
  const dateIdx = findColumnIndex(headers, ['Event Date', 'Unlock Date', 'Date', 'Scheduled Date']);
  const statusIdx = findColumnIndex(headers, ['Status']);
  const notesIdx = findColumnIndex(headers, ['Notes', 'Note']);
  const eventTypeIdx = findColumnIndex(headers, ['Event Type']);
  const walletIdx = findColumnIndex(headers, ['Active Wallet Address', 'Wallet Address', 'Wallet']);

  const requiredChecks = [
    { idx: grantNameIdx, name: 'Grant Name' },
    { idx: recipientIdx, name: 'Recipient Name' },
    { idx: amountIdx, name: 'Token Amount' },
    { idx: dateIdx, name: 'Event Date' },
    { idx: statusIdx, name: 'Status' },
  ];

  const missing = requiredChecks.filter((c) => c.idx === -1).map((c) => c.name);
  if (missing.length > 0) {
    const foundColumns = headers.filter((h) => h);
    throw new Error(
      `This doesn't look like a custody export. Missing required columns: ${missing.join(', ')}. Found: ${foundColumns.join(', ')}.`
    );
  }

  const transactions: ExcelTransaction[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;

    const grantId = row.getCell(grantNameIdx + 1).text?.trim();
    if (!grantId) return;

    if (eventTypeIdx !== -1) {
      const eventType = row.getCell(eventTypeIdx + 1).text?.trim().toLowerCase();
      if (eventType && eventType !== 'unlock') return;
    }

    const status = statusIdx !== -1 ? row.getCell(statusIdx + 1).text?.trim().toUpperCase() : '';
    if (statusIdx !== -1 && status !== 'PENDING') return;

    const notes = notesIdx !== -1 ? row.getCell(notesIdx + 1).text?.trim() || '' : '';
    const noteWarning = notes && isWarningNote(notes);

    const rawDate = dateIdx !== -1 ? row.getCell(dateIdx + 1).text?.trim() || '' : '';
    const parsedDate = parseDateDDMMYYYY(rawDate);

    const rawAmount = amountIdx !== -1 ? row.getCell(amountIdx + 1).text?.replace(/,/g, '') || '0' : '0';

    transactions.push({
      grantId,
      recipient: recipientIdx !== -1 ? row.getCell(recipientIdx + 1).text?.trim() || '' : '',
      amount: parseFloat(rawAmount) || 0,
      unlockDate: parsedDate,
      walletAddress: walletIdx !== -1 ? row.getCell(walletIdx + 1).text?.trim() || '' : undefined,
      status: status || 'PENDING',
      notes: notes || undefined,
      noteWarning: noteWarning || false,
    });
  });

  if (transactions.length === 0) {
    throw new Error(`No pending transactions found in sheet "${selectedSheet}". Only rows with Status = "PENDING" are processed.`);
  }

  return { transactions, sheetNames, selectedSheet };
}

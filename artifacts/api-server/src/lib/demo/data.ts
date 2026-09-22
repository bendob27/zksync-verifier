/**
 * The demo dataset.
 *
 * Entirely invented: the grantees, the grant references, the amounts and the dates are all
 * made up, and nothing here resembles any real distribution. It exists so a visitor can see
 * the verification engine work without any credentials, any spreadsheet, or any AI call.
 *
 * The batch is built so that each row demonstrates a different check:
 *
 *   Acme Labs          clean payment
 *   Northwind Systems  clean payment
 *   Belvedere Research already paid in May — duplicate
 *   Calderon Group     each row looks fine, but the batch takes the grant past its cap
 *   Quillfeather       the schedule gives no cap, so the check cannot complete
 *   Halden Partners    right amount for a different month, wrong for this one
 *   Marlowe Ventures   paused, yet still sitting in the custody queue
 *
 * plus one transaction in the queue that no payment accounts for.
 */

export const DEMO_PERIOD_HEADERS = ['Apr 2026', 'May 2026', 'Jun 2026'] as const;

/** The unlock schedule, laid out wide exactly as the real sheet is. */
export const DEMO_SCHEDULE_GRID: string[][] = [
  ['ZKsync token model — DEMONSTRATION DATA, not a real schedule', '', '', '', '', ''],
  ['', '', '', '', '', ''],
  ['Name', 'Grant ID', 'Total Tokens', 'Apr 2026', 'May 2026', 'Jun 2026'],
  ['Acme Labs', 'ACM001', '1200000', '100000', '100000', '100000'],
  ['Northwind Systems', 'NWD014', '500000', '50000', '50000', '50000'],
  ['Belvedere Research', 'BLV007', '240000', '20000', '20000', '20000'],
  // Cap deliberately lower than the sum of its own instalments — a schedule inconsistency
  // the cap check is there to catch.
  ['Calderon Group', 'CLD002', '80000', '30000', '30000', '30000'],
  // No total: the cap check cannot be completed, so this cannot be a clean pass.
  ['Quillfeather Studio', 'QLF031', '', '15000', '15000', '15000'],
  ['Halden Partners', 'HLD022', '300000', '10000', '10000', '60000'],
  ['Marlowe Ventures', 'MRL009', '600000', '25000', '25000', '25000'],
];

/** What has already been paid. */
export const DEMO_HISTORY_GRID: string[][] = [
  ['Cash flows — DEMONSTRATION DATA', '', ''],
  ['Grant ID', 'Amount', 'Date'],
  ['ACM001', '100000', '15/04/2026'],
  ['ACM001', '100000', '15/05/2026'],
  ['NWD014', '50000', '15/04/2026'],
  ['NWD014', '50000', '15/05/2026'],
  ['BLV007', '20000', '15/05/2026'],
  ['CLD002', '30000', '15/04/2026'],
  ['CLD002', '30000', '15/05/2026'],
  ['HLD022', '10000', '15/04/2026'],
  ['HLD022', '10000', '15/05/2026'],
  ['MRL009', '25000', '15/05/2026'],
];

export interface DemoExportRow {
  eventType: string;
  grantName: string;
  recipient: string;
  wallet: string;
  eventDate: string;
  status: string;
  amount: number;
  notes: string;
  /** What this row is here to demonstrate. Asserted in the tests. */
  expected: 'PASS' | 'FAIL' | 'NEEDS_REVIEW' | 'EXCLUDED';
  demonstrates: string;
}

/** The weekly batch awaiting approval. */
export const DEMO_EXPORT_ROWS: DemoExportRow[] = [
  {
    eventType: 'Unlock', grantName: 'ACM001', recipient: 'Acme Labs',
    wallet: '0xdem0000000000000000000000000000000000a1', eventDate: '15/06/2026',
    status: 'PENDING', amount: 100000, notes: 'Ok',
    expected: 'PASS', demonstrates: 'A payment that matches the schedule in every respect.',
  },
  {
    eventType: 'Unlock', grantName: 'NWD014', recipient: 'Northwind Systems',
    wallet: '0xdem0000000000000000000000000000000000b2', eventDate: '15/06/2026',
    status: 'PENDING', amount: 50000, notes: 'Ok',
    expected: 'PASS', demonstrates: 'A second clean payment, to show what a pass looks like.',
  },
  {
    eventType: 'Unlock', grantName: 'BLV007', recipient: 'Belvedere Research',
    wallet: '0xdem0000000000000000000000000000000000c3', eventDate: '15/05/2026',
    status: 'PENDING', amount: 20000, notes: 'Ok',
    expected: 'FAIL', demonstrates: 'This instalment was already paid in May — a duplicate.',
  },
  {
    eventType: 'Unlock', grantName: 'CLD002', recipient: 'Calderon Group',
    wallet: '0xdem0000000000000000000000000000000000d4', eventDate: '15/06/2026',
    status: 'PENDING', amount: 30000, notes: 'Ok',
    expected: 'FAIL', demonstrates: 'On its own this row looks fine; with what is already paid it takes the grant past its cap.',
  },
  {
    eventType: 'Unlock', grantName: 'QLF031', recipient: 'Quillfeather Studio',
    wallet: '0xdem0000000000000000000000000000000000e5', eventDate: '15/06/2026',
    status: 'PENDING', amount: 15000, notes: 'Ok',
    expected: 'NEEDS_REVIEW', demonstrates: 'The schedule gives no total for this grant, so overpayment cannot be ruled out. Not a pass.',
  },
  {
    eventType: 'Unlock', grantName: 'HLD022', recipient: 'Halden Partners',
    wallet: '0xdem0000000000000000000000000000000000f6', eventDate: '15/06/2026',
    status: 'PENDING', amount: 10000, notes: 'Ok',
    expected: 'FAIL', demonstrates: 'The right amount for April and May, but June schedules 60,000 — the classic wrong-month error.',
  },
  {
    eventType: 'Unlock', grantName: 'MRL009', recipient: 'Marlowe Ventures',
    wallet: '0xdem000000000000000000000000000000000017', eventDate: '15/06/2026',
    status: 'PENDING', amount: 25000, notes: 'PAUSE',
    expected: 'EXCLUDED', demonstrates: 'Deliberately parked — but it is still sitting in the custody queue, which is reported.',
  },
];

/** What the custody queue shows. */
export const DEMO_QUEUE_LINES: Array<{ recipient: string; amount: string; date: string }> = [
  { recipient: 'Acme Labs', amount: '100000', date: '15/06/2026' },
  { recipient: 'Northwind Systems', amount: '50000', date: '15/06/2026' },
  { recipient: 'Belvedere Research', amount: '20000', date: '15/05/2026' },
  { recipient: 'Calderon Group', amount: '30000', date: '15/06/2026' },
  { recipient: 'Quillfeather Studio', amount: '15000', date: '15/06/2026' },
  { recipient: 'Halden Partners', amount: '10000', date: '15/06/2026' },
  // Parked, yet queued.
  { recipient: 'Marlowe Ventures', amount: '25000', date: '15/06/2026' },
  // Accounted for by nothing in the batch.
  { recipient: 'Ferrograph Ltd', amount: '45000', date: '15/06/2026' },
];

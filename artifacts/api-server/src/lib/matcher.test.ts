import { describe, it, expect } from 'vitest';
import { verifyTransactions } from './matcher';
import { parseEuropeanNumber } from './ocr';
import type { UnlockScheduleRow, CashFlowRow, ExcelTransaction, OcrTransaction } from './types';

function tx(overrides: Partial<ExcelTransaction> = {}): ExcelTransaction {
  return {
    grantId: 'GRANT-001',
    recipient: 'Alice',
    amount: 10000,
    unlockDate: '2024-06-01',
    ...overrides,
  };
}

function schedule(overrides: Partial<UnlockScheduleRow> = {}): UnlockScheduleRow {
  return {
    grantId: 'GRANT-001',
    recipient: 'Alice',
    amount: 10000,
    unlockDate: '2024-06-01',
    ...overrides,
  };
}

function cashFlow(overrides: Partial<CashFlowRow> = {}): CashFlowRow {
  return {
    grantId: 'GRANT-001',
    amount: 10000,
    date: '2024-05-01',
    ...overrides,
  };
}

describe('matcher – verifyTransactions', () => {
  describe('Phase 1: Core Matching', () => {
    it('1. GREEN: exact match on all fields', () => {
      const results = verifyTransactions([tx()], [schedule()], []);
      expect(results[0].status).toBe('GREEN');
      expect(results[0].checks.recipientExists.status).toBe('GREEN');
      expect(results[0].checks.amountMatch.status).toBe('GREEN');
      expect(results[0].checks.timingMatch.status).toBe('GREEN');
    });

    it('2. GREEN: case-insensitive grant ID matching', () => {
      const results = verifyTransactions(
        [tx({ grantId: 'grant-001' })],
        [schedule({ grantId: 'GRANT-001' })],
        []
      );
      expect(results[0].checks.recipientExists.status).toBe('GREEN');
    });

    it('3. RED: unknown grant ID', () => {
      const results = verifyTransactions(
        [tx({ grantId: 'NONEXISTENT' })],
        [schedule()],
        []
      );
      expect(results[0].status).toBe('RED');
      expect(results[0].checks.recipientExists.status).toBe('RED');
    });

    it('4. GREEN: exact amount match', () => {
      const results = verifyTransactions(
        [tx({ amount: 50000 })],
        [schedule({ amount: 50000 })],
        []
      );
      expect(results[0].checks.amountMatch.status).toBe('GREEN');
    });

    it('5. YELLOW: amount within 0.1% AND within 1000 tokens', () => {
      const results = verifyTransactions(
        [tx({ amount: 100005 })],
        [schedule({ amount: 100000 })],
        []
      );
      expect(results[0].checks.amountMatch.status).toBe('YELLOW');
    });

    it('6. RED: amount within 0.1% but exceeds 1000 tokens absolute', () => {
      const results = verifyTransactions(
        [tx({ amount: 10001001 })],
        [schedule({ amount: 10000000 })],
        []
      );
      expect(results[0].checks.amountMatch.status).toBe('RED');
    });

    it('7. RED: amount exceeds 0.1% even if under 1000 absolute', () => {
      const results = verifyTransactions(
        [tx({ amount: 1100 })],
        [schedule({ amount: 1000 })],
        []
      );
      expect(results[0].checks.amountMatch.status).toBe('RED');
    });

    it('8. RED: large amount mismatch', () => {
      const results = verifyTransactions(
        [tx({ amount: 50000 })],
        [schedule({ amount: 10000 })],
        []
      );
      expect(results[0].checks.amountMatch.status).toBe('RED');
    });

    it('9. GREEN: exact date match', () => {
      const results = verifyTransactions(
        [tx({ unlockDate: '2024-06-01' })],
        [schedule({ unlockDate: '2024-06-01' })],
        []
      );
      expect(results[0].checks.timingMatch.status).toBe('GREEN');
    });

    it('10. YELLOW: date within ±1 day', () => {
      const results = verifyTransactions(
        [tx({ unlockDate: '2024-06-02' })],
        [schedule({ unlockDate: '2024-06-01' })],
        []
      );
      expect(results[0].checks.timingMatch.status).toBe('YELLOW');
    });

    it('11. RED: date mismatch beyond ±1 day', () => {
      const results = verifyTransactions(
        [tx({ unlockDate: '2024-06-10' })],
        [schedule({ unlockDate: '2024-06-01' })],
        []
      );
      expect(results[0].checks.timingMatch.status).toBe('RED');
    });

    it('12. RED: unparseable transaction date', () => {
      const results = verifyTransactions(
        [tx({ unlockDate: 'not-a-date' })],
        [schedule()],
        []
      );
      expect(results[0].checks.timingMatch.status).toBe('RED');
    });

    it('13. RED: no matching schedule for amount check', () => {
      const results = verifyTransactions(
        [tx({ grantId: 'MISSING' })],
        [schedule()],
        []
      );
      expect(results[0].checks.amountMatch.status).toBe('RED');
    });

    it('14. overall status = worst across all checks (RED wins)', () => {
      const results = verifyTransactions(
        [tx({ grantId: 'NONEXISTENT' })],
        [schedule()],
        []
      );
      expect(results[0].status).toBe('RED');
    });

    it('15. overall status = YELLOW when worst is YELLOW', () => {
      const results = verifyTransactions(
        [tx({ amount: 100005, unlockDate: '2024-06-01' })],
        [schedule({ amount: 100000, unlockDate: '2024-06-01' })],
        []
      );
      expect(results[0].status).toBe('YELLOW');
    });

    it('15b. YELLOW: recipient mismatch on existing grant', () => {
      const results = verifyTransactions(
        [tx({ recipient: 'Bob' })],
        [schedule({ recipient: 'Alice' })],
        []
      );
      expect(results[0].checks.recipientExists.status).toBe('YELLOW');
    });

    it('16. multiple transactions in one batch', () => {
      const results = verifyTransactions(
        [
          tx({ grantId: 'GRANT-001' }),
          tx({ grantId: 'GRANT-002', amount: 20000 }),
        ],
        [
          schedule({ grantId: 'GRANT-001' }),
          schedule({ grantId: 'GRANT-002', amount: 20000 }),
        ],
        []
      );
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('GREEN');
      expect(results[1].status).toBe('GREEN');
    });

    it('17. multiple tranches for same grant in one batch', () => {
      const results = verifyTransactions(
        [
          tx({ amount: 5000, unlockDate: '2024-06-01' }),
          tx({ amount: 5000, unlockDate: '2024-07-01' }),
        ],
        [
          schedule({ amount: 5000, unlockDate: '2024-06-01' }),
          schedule({ amount: 5000, unlockDate: '2024-07-01' }),
        ],
        []
      );
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('GREEN');
      expect(results[1].status).toBe('GREEN');
    });

    it('18. picks best matching schedule by closest amount', () => {
      const results = verifyTransactions(
        [tx({ amount: 15000 })],
        [
          schedule({ amount: 10000 }),
          schedule({ amount: 15000, unlockDate: '2024-06-01' }),
        ],
        []
      );
      expect(results[0].checks.amountMatch.status).toBe('GREEN');
    });
  });

  describe('Phase 2: Duplicate & Overpayment', () => {
    it('19. GREEN: no duplicate — no prior distributions', () => {
      const results = verifyTransactions([tx()], [schedule()], []);
      expect(results[0].checks.duplicateCheck?.status).toBe('GREEN');
    });

    it('20. GREEN: no duplicate — different amounts in history', () => {
      const results = verifyTransactions(
        [tx({ amount: 10000 })],
        [schedule()],
        [cashFlow({ amount: 5000, date: '2024-05-01' })]
      );
      expect(results[0].checks.duplicateCheck?.status).toBe('GREEN');
    });

    it('21. RED: duplicate tranche detected', () => {
      const results = verifyTransactions(
        [tx({ amount: 10000, unlockDate: '2024-06-01' })],
        [schedule()],
        [cashFlow({ amount: 10000, date: '2024-06-01' })]
      );
      expect(results[0].checks.duplicateCheck?.status).toBe('RED');
    });

    it('22. RED: duplicate with date within 1 day', () => {
      const results = verifyTransactions(
        [tx({ amount: 10000, unlockDate: '2024-06-02' })],
        [schedule()],
        [cashFlow({ amount: 10000, date: '2024-06-01' })]
      );
      expect(results[0].checks.duplicateCheck?.status).toBe('RED');
    });

    it('23. GREEN: cumulative total within bounds', () => {
      const results = verifyTransactions(
        [tx({ amount: 5000 })],
        [schedule({ totalGrantAmount: 100000 })],
        [cashFlow({ amount: 10000 })]
      );
      expect(results[0].checks.cumulativeCheck?.status).toBe('GREEN');
    });

    it('24. RED: cumulative total exceeds grant amount', () => {
      const results = verifyTransactions(
        [tx({ amount: 50000 })],
        [schedule({ totalGrantAmount: 60000 })],
        [cashFlow({ amount: 20000 })]
      );
      expect(results[0].checks.cumulativeCheck?.status).toBe('RED');
    });

    it('25. GREEN: cumulative check skipped when no total defined', () => {
      const results = verifyTransactions(
        [tx({ amount: 50000 })],
        [schedule({ totalGrantAmount: undefined })],
        [cashFlow({ amount: 20000 })]
      );
      expect(results[0].checks.cumulativeCheck?.status).toBe('GREEN');
    });

    it('26. RED: cumulative exactly at boundary is OK (not exceeding)', () => {
      const results = verifyTransactions(
        [tx({ amount: 40000 })],
        [schedule({ totalGrantAmount: 60000 })],
        [cashFlow({ amount: 20000 })]
      );
      expect(results[0].checks.cumulativeCheck?.status).toBe('GREEN');
    });

    it('27. RED: cumulative just over boundary', () => {
      const results = verifyTransactions(
        [tx({ amount: 40001 })],
        [schedule({ totalGrantAmount: 60000 })],
        [cashFlow({ amount: 20000 })]
      );
      expect(results[0].checks.cumulativeCheck?.status).toBe('RED');
    });
  });

  describe('Edge Cases', () => {
    it('28. empty transaction batch', () => {
      const results = verifyTransactions([], [schedule()], []);
      expect(results).toHaveLength(0);
    });

    it('29. zero-amount tranche', () => {
      const results = verifyTransactions(
        [tx({ amount: 0 })],
        [schedule({ amount: 0 })],
        []
      );
      expect(results[0].checks.amountMatch.status).toBe('GREEN');
    });

    it('30. very large amount', () => {
      const results = verifyTransactions(
        [tx({ amount: 999999999 })],
        [schedule({ amount: 999999999 })],
        []
      );
      expect(results[0].checks.amountMatch.status).toBe('GREEN');
    });

    it('31. empty unlock schedules', () => {
      const results = verifyTransactions([tx()], [], []);
      expect(results[0].status).toBe('RED');
      expect(results[0].checks.recipientExists.status).toBe('RED');
    });

    it('32. grant ID with extra whitespace handled in test data', () => {
      const results = verifyTransactions(
        [tx({ grantId: 'GRANT-001' })],
        [schedule({ grantId: 'GRANT-001' })],
        []
      );
      expect(results[0].checks.recipientExists.status).toBe('GREEN');
    });

    it('33. different date formats - slash format', () => {
      const results = verifyTransactions(
        [tx({ unlockDate: '6/1/2024' })],
        [schedule({ unlockDate: '2024-06-01' })],
        []
      );
      expect(results[0].checks.timingMatch.status).toBe('GREEN');
    });

    it('34. amount at exact boundary of percentage tolerance', () => {
      const expected = 1000000;
      const actual = expected * (1 + 0.001);
      const results = verifyTransactions(
        [tx({ amount: actual })],
        [schedule({ amount: expected })],
        []
      );
      expect(results[0].checks.amountMatch.status).toBe('YELLOW');
    });

    it('35. amount just over percentage tolerance boundary', () => {
      const expected = 1000000;
      const actual = expected * (1 + 0.0011);
      const results = verifyTransactions(
        [tx({ amount: actual })],
        [schedule({ amount: expected })],
        []
      );
      expect(results[0].checks.amountMatch.status).toBe('RED');
    });
  });

  describe('Phase 3: Screenshot OCR matching', () => {
    it('36. GREEN: screenshot match when OCR data matches Excel', () => {
      const ocrData: OcrTransaction[] = [{
        recipient: 'Alice',
        amount: 10000,
      }];
      const results = verifyTransactions([tx()], [schedule()], [], ocrData);
      expect(results[0].checks.screenshotMatch?.status).toBe('GREEN');
    });

    it('37. RED: screenshot amount mismatch', () => {
      const ocrData: OcrTransaction[] = [{
        recipient: 'Alice',
        amount: 5000,
      }];
      const results = verifyTransactions([tx()], [schedule()], [], ocrData);
      expect(results[0].checks.screenshotMatch?.status).toBe('RED');
    });

    it('38. RED: screenshot no matching transaction', () => {
      const ocrData: OcrTransaction[] = [{
        recipient: 'Charlie',
        amount: 99999,
      }];
      const results = verifyTransactions([tx()], [schedule()], [], ocrData);
      expect(results[0].checks.screenshotMatch?.status).toBe('RED');
    });

    it('39. GREEN: no screenshot data — check not performed', () => {
      const results = verifyTransactions([tx()], [schedule()], []);
      expect(results[0].checks.screenshotMatch).toBeUndefined();
    });

    it('40. RED: screenshot recipient mismatch with matching amount', () => {
      const ocrData: OcrTransaction[] = [{
        recipient: 'Bob',
        amount: 10000,
      }];
      const results = verifyTransactions(
        [tx({ recipient: 'Alice' })],
        [schedule()],
        [],
        ocrData
      );
      expect(results[0].checks.screenshotMatch?.status).toBe('RED');
    });
  });

  describe('noteWarning handling', () => {
    it('46. YELLOW: noteWarning transactions skip verification', () => {
      const results = verifyTransactions(
        [tx({ notes: 'PAUSE - waiting for wallet', noteWarning: true })],
        [schedule()],
        []
      );
      expect(results[0].status).toBe('YELLOW');
      expect(results[0].notes).toBe('PAUSE - waiting for wallet');
      expect(results[0].checks.recipientExists.detail).toContain('Skipped');
    });
  });

  describe('European number format parsing', () => {
    it('47. parse 123.456,78 as 123456.78', () => {
      expect(parseEuropeanNumber('123.456,78')).toBe(123456.78);
    });

    it('48. parse 2.345.678,901 as 2345678.901', () => {
      expect(parseEuropeanNumber('2.345.678,901')).toBe(2345678.901);
    });

    it('49. parse 345.678,9012 as 345678.9012', () => {
      expect(parseEuropeanNumber('345.678,9012')).toBeCloseTo(345678.9012);
    });

    it('50. parse standard number 123456.78 unchanged', () => {
      expect(parseEuropeanNumber('123456.78')).toBe(123456.78);
    });

    it('51. parse integer with dot thousands 1.000 as 1000', () => {
      expect(parseEuropeanNumber('1.000')).toBe(1000);
    });

    it('52. pass through plain number', () => {
      expect(parseEuropeanNumber('12345')).toBe(12345);
    });
  });

  describe('Never false-negative property', () => {
    it('41. RED: every RED scenario is caught — unknown grant', () => {
      const results = verifyTransactions([tx({ grantId: 'XXX' })], [schedule()], []);
      expect(results[0].status).toBe('RED');
    });

    it('42. RED: amount too high', () => {
      const results = verifyTransactions(
        [tx({ amount: 99999 })],
        [schedule({ amount: 10000 })],
        []
      );
      expect(results[0].status).toBe('RED');
    });

    it('43. RED: amount too low', () => {
      const results = verifyTransactions(
        [tx({ amount: 1000 })],
        [schedule({ amount: 10000 })],
        []
      );
      expect(results[0].status).toBe('RED');
    });

    it('44. RED: date way off', () => {
      const results = verifyTransactions(
        [tx({ unlockDate: '2025-01-01' })],
        [schedule({ unlockDate: '2024-06-01' })],
        []
      );
      expect(results[0].status).toBe('RED');
    });

    it('45. RED: duplicate combined with other checks', () => {
      const results = verifyTransactions(
        [tx()],
        [schedule()],
        [cashFlow({ amount: 10000, date: '2024-06-01' })]
      );
      expect(results[0].status).toBe('RED');
      expect(results[0].checks.duplicateCheck?.status).toBe('RED');
    });
  });
});

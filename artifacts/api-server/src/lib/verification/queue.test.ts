import { describe, it, expect } from 'vitest';
import { reconcileQueue } from './queue';
import { parseTokens, type Tokens } from './money';
import { parseDate } from './period';
import type { CustodyQueue, QueueLine } from './sources';
import type { PaymentIdentity } from './model';

const tok = (v: string | number): Tokens => {
  const r = parseTokens(v);
  if (!r.ok) throw new Error('bad amount');
  return r.value;
};

let seq = 0;
function pay(recipient: string, amount: number, date = '15/06/2026'): PaymentIdentity {
  const d = parseDate(date);
  seq++;
  return {
    paymentId: `p${seq}`, rowNumber: seq + 1, grantRef: `G${seq}`, recipient,
    amount: tok(amount), date: d.ok ? d.value : null, rawDate: date,
  };
}

function line(recipient: string, amount: number, date = '15/06/2026', sourceRef = 'screenshot 1'): QueueLine {
  const d = parseDate(date);
  return { lineId: `${recipient}-${amount}-${sourceRef}`, recipient, amount: tok(amount), date: d.ok ? d.value : null, sourceRef };
}

function queue(lines: QueueLine[], opts: Partial<CustodyQueue> = {}): CustodyQueue {
  return { lines, incomplete: false, issues: [], ...opts };
}

describe('14. one observed transaction cannot satisfy two expected payments', () => {
  it('fails when two payments of 100 are matched by a single queued 100', () => {
    const a = pay('Acme Labs', 100);
    const b = pay('Acme Labs', 100);
    const r = reconcileQueue([a, b], [], queue([line('Acme Labs', 100)]));
    expect(r.perPayment.get(a.paymentId)!.outcome).toBe('FAIL');
    expect(r.perPayment.get(b.paymentId)!.outcome).toBe('FAIL');
    expect(r.perPayment.get(a.paymentId)!.detail).toContain('200');
  });

  it('passes when the queue genuinely covers both', () => {
    const a = pay('Acme Labs', 100);
    const b = pay('Acme Labs', 100);
    const r = reconcileQueue([a, b], [], queue([line('Acme Labs', 200)]));
    expect(r.perPayment.get(a.paymentId)!.outcome).toBe('PASS');
  });
});

describe('bundled withdrawals', () => {
  it('compares a recipient\'s payments against one bundled queue line', () => {
    const a = pay('Acme Labs', 100);
    const b = pay('Acme Labs', 250);
    const r = reconcileQueue([a, b], [], queue([line('Acme Labs', 350)]));
    expect(r.perPayment.get(a.paymentId)!.outcome).toBe('PASS');
    expect(r.perPayment.get(a.paymentId)!.detail).toContain('bundled');
  });
});

describe('15. unexpected transactions in the queue are detected', () => {
  it('reports a queued recipient that no payment accounts for', () => {
    const a = pay('Acme Labs', 100);
    const r = reconcileQueue([a], [], queue([line('Acme Labs', 100), line('Northwind', 9999)]));
    const extra = r.queueFindings.find((f) => f.detail.includes('Northwind'));
    expect(extra?.outcome).toBe('FAIL');
    expect(extra?.detail).toMatch(/no payment in this batch accounts for/i);
  });
});

describe('16. overlapping screenshots are not double-counted', () => {
  it('flags repeated lines instead of silently summing or discarding them', () => {
    const a = pay('Acme Labs', 100);
    const r = reconcileQueue([a], [], queue([
      line('Acme Labs', 100, '15/06/2026', 'screenshot 1'),
      line('Acme Labs', 100, '15/06/2026', 'screenshot 2'),
    ]));
    expect(r.perPayment.get(a.paymentId)!.outcome).toBe('NEEDS_REVIEW');
    const overlap = r.queueFindings.find((f) => /more than once/i.test(f.detail));
    expect(overlap?.outcome).toBe('NEEDS_REVIEW');
    expect(overlap?.detail).toMatch(/neither discarded nor counted twice/i);
  });
});

describe('17. an unreadable image does not yield an apparently complete check', () => {
  it('reports the reconciliation as incomplete rather than agreeing', () => {
    const a = pay('Acme Labs', 100);
    const r = reconcileQueue([a], [], queue([line('Acme Labs', 100)], {
      incomplete: true, incompleteReason: '1 of 3 images could not be read',
    }));
    expect(r.perPayment.get(a.paymentId)!.outcome).toBe('NEEDS_REVIEW');
    expect(r.perPayment.get(a.paymentId)!.detail).toContain('could not be read');
  });

  it('does not silently pass when no queue evidence was supplied at all', () => {
    const a = pay('Acme Labs', 100);
    const r = reconcileQueue([a], [], null);
    expect(r.perPayment.get(a.paymentId)!.outcome).toBe('NEEDS_REVIEW');
  });
});

describe('18. a parked payment still sitting in the queue is flagged', () => {
  it('fails the queue reconciliation rather than ignoring it', () => {
    const parked = pay('Paused Co', 500);
    const r = reconcileQueue([], [parked], queue([line('Paused Co', 500)]));
    const f = r.queueFindings.find((x) => x.detail.includes('Paused Co'));
    expect(f?.outcome).toBe('FAIL');
    expect(f?.detail).toMatch(/paused or cancelled/i);
  });
});

describe('missing payments', () => {
  it('fails a payment with nothing for that recipient in the queue', () => {
    const a = pay('Acme Labs', 100);
    const r = reconcileQueue([a], [], queue([line('Northwind', 100)]));
    expect(r.perPayment.get(a.paymentId)!.outcome).toBe('FAIL');
    expect(r.perPayment.get(a.paymentId)!.detail).toMatch(/Nothing for "Acme Labs"/);
  });
});

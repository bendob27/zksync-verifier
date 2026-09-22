import { describe, it, expect } from 'vitest';
import { resolveGrants, type ProposeFn } from './resolve';
import { buildScheduleIndex } from './sources';
import { parseTokens } from './money';
import type { PaymentIdentity } from './model';

const schedule = buildScheduleIndex(
  [
    { grantId: 'ACM001', granteeName: 'Acme Labs', totalTokens: 1000, instalments: [], sourceRef: 'schedule row 2' },
    { grantId: 'NWD014', granteeName: 'Northwind', totalTokens: 2000, instalments: [], sourceRef: 'schedule row 3' },
  ],
  [],
);

function payment(grantRef: string, recipient = 'Acme Labs', id = 'p1'): PaymentIdentity {
  const amount = parseTokens(100);
  return {
    paymentId: id, rowNumber: 2, grantRef, recipient,
    amount: amount.ok ? amount.value : 0n, date: null, rawDate: '15/06/2026',
  };
}

describe('deterministic resolution happens without consulting a model', () => {
  it('matches an exact grant reference and never calls the proposer', async () => {
    let called = false;
    const propose: ProposeFn = async () => { called = true; return []; };
    const out = await resolveGrants([payment('ACM001')], schedule, propose);
    expect(out.get('p1')!.status).toBe('resolved');
    expect(out.get('p1')!.row!.grantId).toBe('ACM001');
    expect(called).toBe(false);
  });

  it('matches through punctuation and case differences', async () => {
    const out = await resolveGrants([payment('acm-001')], schedule);
    expect(out.get('p1')!.status).toBe('resolved');
  });

  it('reports a reference in no schedule row as not found, not as a guess', async () => {
    const out = await resolveGrants([payment('GHOST9', 'Nobody')], schedule);
    expect(out.get('p1')!.status).toBe('not-found');
  });
});

describe('10. malformed, missing or duplicate proposals are handled explicitly', () => {
  const unknown = [payment('MYSTERY1', 'Someone')];

  it('treats a missing entry as unresolved', async () => {
    const propose: ProposeFn = async () => [];
    const out = await resolveGrants(unknown, schedule, propose);
    expect(out.get('p1')!.status).toBe('not-found');
    expect(out.get('p1')!.basis).toMatch(/no result/i);
  });

  it('treats conflicting duplicate entries as ambiguous', async () => {
    const propose: ProposeFn = async () => [
      { paymentId: 'p1', rowId: 'row-0' },
      { paymentId: 'p1', rowId: 'row-1' },
    ];
    const out = await resolveGrants(unknown, schedule, propose);
    expect(out.get('p1')!.status).toBe('ambiguous');
  });

  it('rejects a row id that was never offered', async () => {
    const propose: ProposeFn = async () => [{ paymentId: 'p1', rowId: 'row-999' }];
    const out = await resolveGrants(unknown, schedule, propose);
    expect(out.get('p1')!.status).toBe('not-found');
    expect(out.get('p1')!.basis).toMatch(/does not exist/i);
  });

  it('accepts an explicit decline', async () => {
    const propose: ProposeFn = async () => [{ paymentId: 'p1', rowId: null, reason: 'no plausible match' }];
    const out = await resolveGrants(unknown, schedule, propose);
    expect(out.get('p1')!.status).toBe('not-found');
    expect(out.get('p1')!.basis).toContain('no plausible match');
  });

  it('does not let a proposer failure turn into a pass', async () => {
    const propose: ProposeFn = async () => { throw new Error('upstream 503'); };
    const out = await resolveGrants(unknown, schedule, propose);
    expect(out.get('p1')!.status).toBe('not-found');
    expect(out.get('p1')!.basis).toContain('upstream 503');
  });

  it('ignores entries for payments it was not asked about', async () => {
    const propose: ProposeFn = async () => [
      { paymentId: 'not-a-real-payment', rowId: 'row-0' },
    ];
    const out = await resolveGrants(unknown, schedule, propose);
    expect(out.get('p1')!.status).toBe('not-found');
  });
});

describe('ambiguity between several rows sharing a reference', () => {
  const duplicated = buildScheduleIndex(
    [
      { grantId: 'ACM001', granteeName: 'Acme Labs', totalTokens: 1000, instalments: [], sourceRef: 'schedule row 2' },
      { grantId: 'ACM001', granteeName: 'Acme Holdings', totalTokens: 1000, instalments: [], sourceRef: 'schedule row 3' },
    ],
    [],
  );

  it('uses the grantee name when it is decisive', async () => {
    const out = await resolveGrants([payment('ACM001', 'Acme Holdings')], duplicated);
    expect(out.get('p1')!.status).toBe('resolved');
    expect(out.get('p1')!.row!.granteeName).toBe('Acme Holdings');
  });

  it('reports ambiguity when the name does not distinguish them', async () => {
    const out = await resolveGrants([payment('ACM001', 'Unrelated Co')], duplicated);
    expect(out.get('p1')!.status).toBe('ambiguous');
    expect(out.get('p1')!.candidates).toHaveLength(2);
  });
});

/**
 * Mapping a custody-export row onto a schedule row.
 *
 * This is the ONLY place a model is consulted during verification, and it is deliberately
 * boxed in. It is asked one question — "which schedule row is this payment referring to?" —
 * and may answer only with a row identifier we gave it. It never supplies an amount, a date
 * or a cap; those are read from the row afterwards, in code.
 *
 * Most rows never reach the model at all: a grant reference that matches exactly one row
 * after normalisation is resolved deterministically.
 *
 * Every response is validated before use:
 *   - each requested payment must be accounted for exactly once
 *   - each proposed row id must be one we offered
 *   - a payment the model declines, duplicates or invents becomes NEEDS_REVIEW, never a pass
 */

import type { GrantResolution } from './checks';
import type { PaymentIdentity } from './model';
import { normaliseGrantId, type ScheduleIndex, type ScheduleRow } from './sources';

/** A candidate offered to the model, addressed by an opaque id. */
export interface RowOffer {
  rowId: string;
  grantId: string;
  granteeName: string;
}

export interface ResolverProposal {
  paymentId: string;
  /** A rowId from the offers, or null to decline. */
  rowId: string | null;
  reason?: string;
}

/** Injected so the engine can be tested without a network call. */
export type ProposeFn = (args: {
  payments: Array<{ paymentId: string; grantRef: string; recipient: string }>;
  offers: RowOffer[];
}) => Promise<ResolverProposal[]>;

function offerIdFor(row: ScheduleRow, index: number): string {
  return `row-${index}`;
}

/**
 * Resolve every payment, using the model only for what deterministic matching could not settle.
 */
export async function resolveGrants(
  payments: PaymentIdentity[],
  schedule: ScheduleIndex,
  propose?: ProposeFn,
): Promise<Map<string, GrantResolution>> {
  const out = new Map<string, GrantResolution>();
  const rowIds = new Map<ScheduleRow, string>();
  schedule.rows.forEach((row, i) => rowIds.set(row, offerIdFor(row, i)));

  const unresolved: PaymentIdentity[] = [];

  for (const p of payments) {
    const matches = schedule.byGrantId.get(normaliseGrantId(p.grantRef)) ?? [];
    if (matches.length === 1) {
      out.set(p.paymentId, {
        paymentId: p.paymentId,
        status: 'resolved',
        row: matches[0],
        basis: 'grant reference matched exactly one schedule row',
      });
    } else if (matches.length > 1) {
      // Several rows share the identifier. Narrow by grantee name if that is decisive.
      const byName = matches.filter(
        (m) => m.granteeName.trim().toLowerCase() === p.recipient.trim().toLowerCase(),
      );
      if (byName.length === 1) {
        out.set(p.paymentId, {
          paymentId: p.paymentId,
          status: 'resolved',
          row: byName[0],
          basis: 'grant reference matched several rows; the grantee name was decisive',
        });
      } else {
        out.set(p.paymentId, {
          paymentId: p.paymentId,
          status: 'ambiguous',
          candidates: matches,
          basis: 'the grant reference matches several schedule rows and the grantee name did not distinguish them',
        });
      }
    } else {
      unresolved.push(p);
    }
  }

  if (unresolved.length === 0 || !propose) {
    for (const p of unresolved) {
      out.set(p.paymentId, {
        paymentId: p.paymentId,
        status: 'not-found',
        basis: 'no schedule row carries that grant reference',
      });
    }
    return out;
  }

  const offers: RowOffer[] = schedule.rows.map((row) => ({
    rowId: rowIds.get(row)!,
    grantId: row.grantId,
    granteeName: row.granteeName,
  }));

  let proposals: ResolverProposal[];
  try {
    proposals = await propose({
      payments: unresolved.map((p) => ({
        paymentId: p.paymentId,
        grantRef: p.grantRef,
        recipient: p.recipient,
      })),
      offers,
    });
  } catch (err) {
    // A failed proposer leaves these rows unresolved. It must never let them through.
    const reason = err instanceof Error ? err.message : 'unknown error';
    for (const p of unresolved) {
      out.set(p.paymentId, {
        paymentId: p.paymentId,
        status: 'not-found',
        basis: `automated matching was unavailable (${reason}), and no exact schedule row was found`,
      });
    }
    return out;
  }

  // Validate the response: exactly one entry per requested payment, no invented ids.
  const byPayment = new Map<string, ResolverProposal[]>();
  for (const prop of proposals ?? []) {
    const list = byPayment.get(prop.paymentId);
    if (list) list.push(prop);
    else byPayment.set(prop.paymentId, [prop]);
  }

  const offerById = new Map(offers.map((o) => [o.rowId, o]));
  const rowByOfferId = new Map(schedule.rows.map((row) => [rowIds.get(row)!, row]));

  for (const p of unresolved) {
    const got = byPayment.get(p.paymentId) ?? [];

    if (got.length === 0) {
      out.set(p.paymentId, {
        paymentId: p.paymentId,
        status: 'not-found',
        basis: 'automated matching returned no result for this row',
      });
      continue;
    }

    if (got.length > 1) {
      out.set(p.paymentId, {
        paymentId: p.paymentId,
        status: 'ambiguous',
        basis: `automated matching returned ${got.length} conflicting results for this row`,
      });
      continue;
    }

    const [prop] = got;
    if (prop.rowId === null) {
      out.set(p.paymentId, {
        paymentId: p.paymentId,
        status: 'not-found',
        basis: prop.reason
          ? `no schedule row was identified (${prop.reason})`
          : 'no schedule row was identified',
      });
      continue;
    }

    if (!offerById.has(prop.rowId)) {
      // An id we never offered. Treat as unresolved rather than trusting it.
      out.set(p.paymentId, {
        paymentId: p.paymentId,
        status: 'not-found',
        basis: 'automated matching referred to a schedule row that does not exist',
      });
      continue;
    }

    out.set(p.paymentId, {
      paymentId: p.paymentId,
      status: 'resolved',
      row: rowByOfferId.get(prop.rowId)!,
      basis: prop.reason
        ? `matched by automated lookup (${prop.reason})`
        : 'matched by automated lookup',
    });
  }

  return out;
}

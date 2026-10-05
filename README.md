# Payment Batch Verifier

[![CI](https://github.com/bendob27/zksync-verifier/actions/workflows/ci.yml/badge.svg)](https://github.com/bendob27/zksync-verifier/actions/workflows/ci.yml)

Checks a batch of scheduled token payments before anyone approves it. Approved payments
cannot be reversed, so every payment gets a verdict with the arithmetic behind it, and
the approver signs on evidence instead of by eye.

A live demo running on invented data is available on request.

## How it works

```
 batch export (.xlsx) ──┐
 queue screenshots ─────┤                                       PASS / FAIL / NEEDS REVIEW /
                        ├──►  read → match → check → reconcile ──►  EXCLUDED per payment,
 payment schedule ──────┤                                       plus a batch verdict
 payment history ───────┘
```

Each payment must be:

- due in the month of its own date
- an exact match for that month's scheduled amount
- not already paid, and not repeated in the batch
- within the recipient's lifetime cap and the total scheduled to date

The approval queue is then reconciled both ways: every expected payment must be queued,
and every queued transaction must be explained by a payment.

## Design rules

- **Missing evidence is never a pass.** An unreadable amount, a missing cap or a cut-off
  screenshot gives NEEDS REVIEW. A batch is clean only when every check on every payment
  ran and passed.
- **The model only picks a row.** A language model matches a payment to its schedule
  row, choosing only from ids it is given. It never supplies an amount, date or limit.
- **Exact arithmetic.** Amounts are stored as integer micro-units. No floating point, no
  rounding.
- **The batch is checked as a whole.** A payment can match its monthly amount exactly and
  still take the recipient past their total cap.

## Project structure

```
artifacts/   Express API with the verification engine, and the React dashboard
lib/         OpenAPI contract, plus the Zod schemas and React client generated from it
docs/        How the checks work
.claude/     Claude Code setup: project rules and a skill that runs a check end to end
```

## Credits

Built with [Claude Code](https://claude.com/claude-code) by Benjamin Furlong. MIT licence,
see [LICENSE](LICENSE).

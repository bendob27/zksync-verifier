# Replaying historical batches privately

The automated suite is entirely synthetic. It proves the engine applies the rules as
written; it does not prove the rules match what your team decided on a real week.

This procedure replays real batches against answers a human already produced. **Keep the
inputs and outputs out of this repository** — everything below stays on a machine you
control, in a directory that is not a git checkout.

## What you need per batch

1. The custody export as uploaded that week (`.xlsx`).
2. The verification answer a human reached at the time: which rows were approved, which
   were queried, and why.
3. Read access to the unlock schedule and payment history **as they were then**. Google
   Sheets version history can restore a prior state; note the revision you used.

## Procedure

1. Create a working directory outside any git checkout, e.g. `~/zk-replay/`.
2. For each batch, create `~/zk-replay/<week>/` containing the export and a
   `expected.json` recording the human answer, one entry per row:
   ```json
   [{ "grantRef": "…", "amount": "…", "date": "…", "humanOutcome": "approved|queried", "note": "…" }]
   ```
3. Point the tool at the schedule and history revisions for that week, and run the batch
   through the dashboard exactly as an operator would.
4. Export the run as CSV and save it beside `expected.json`.
5. Compare row by row. Record every disagreement in one of three buckets:
   - **tool stricter** — the tool queried something a human approved. Usually correct
     behaviour (a check the human did by eye), but confirm.
   - **tool weaker** — the tool passed something a human queried. **This is the serious
     one.** Every instance is a missing or wrong rule and should become a regression test
     in `artifacts/api-server/src/lib/verification/` with synthetic data.
   - **same answer, different reason** — worth reading; often a sign a check is passing
     for the wrong reason.

## What counts as a successful replay

A replay run is only meaningful if it covers weeks with known problems, not just clean
ones. Aim for at least: one clean week, one week with a genuine discrepancy caught at the
time, one week spanning a month boundary, and one week containing a paused or cancelled row.

Record the result as a table of batch, rows, agreements, and each disagreement with its
bucket. Until that table exists, the README's statement that no historical validation has
been performed stays as it is.

## Turning a disagreement into a test

Reduce the real case to synthetic data that reproduces the same shape — same structure,
invented names and round numbers — and add it to the relevant `*.test.ts`. Never commit
the real figures.

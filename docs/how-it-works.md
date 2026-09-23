# How it works

The detail behind the summary in the [README](../README.md). File paths are relative to the repository root.

## The pipeline

**1. Read the custody export** (`artifacts/api-server/src/lib/verification/custodyExport.ts`). Cell *values* are read, not their rendered text, so a native date or numeric cell keeps its type. Every row below the header is accounted for: rows that are not unlock events, or not `PENDING`, are listed as skipped with a reason; an amount that cannot be read is recorded as unreadable rather than becoming zero. Each row is given a stable payment id derived from its position and contents, so a re-run can be compared with an earlier one.

**2. Work out which schedule columns the batch needs** (`artifacts/api-server/src/lib/verification/period.ts`). The schedule is laid out wide — one row per grant, one column per month — so an instalment is a single cell. A payment's *own* event date selects its column, which means a batch straddling a month end has each row judged against its own month, and re-running last quarter's batch reads the columns it read at the time. Nothing consults the server clock.

**3. Load the sources for exactly those periods** (`artifacts/api-server/src/lib/verification/loadSources.ts`), plus every earlier column so "scheduled to date" can be totalled. Truncation is detected: if a sheet fills the read window, the run says so. An empty payment history is treated as a failure to load, not as "nothing has ever been paid".

**4. Resolve each payment to one schedule row** (`artifacts/api-server/src/lib/verification/resolve.ts`). Most rows resolve deterministically. Only the leftovers go to a model, and it is asked one question — *which row?* — answerable only with a row id supplied to it. It is never asked for, and never shown a slot for, an amount, a date or a cap. Its answer is validated: every requested payment must be accounted for exactly once, and an id we did not offer is rejected. A missing, duplicated, invented or declined answer becomes NEEDS REVIEW.

**5. Apply the deterministic checks** (`artifacts/api-server/src/lib/verification/checks.ts`). Every compared value is read from a fetched record.

| Check | Passes when | Rule |
|---|---|---|
| `grantResolved` | the payment maps to exactly one schedule row | an ambiguous match is never a match |
| `recipientMatches` | the recipient equals the scheduled grantee | a partial name match needs review, it is not accepted |
| `instalmentScheduled` | an instalment exists for the payment's own month | R1 |
| `amountMatches` | rows sharing a grant and month sum exactly to that month's cell | R2, R3 |
| `notDuplicated` | no matching payment in the history, and no unexplained repeat in the upload | — |
| `withinGrantCap` | paid to date + the whole batch ≤ the grant's total | R4a |
| `withinScheduledToDate` | paid to date + the whole batch ≤ everything scheduled by that month | R4b |
| `custodyQueueReconciled` | expected and observed totals agree, both directions | — |

**6. Reconcile the custody queue** (`artifacts/api-server/src/lib/verification/queue.ts`), in both directions: every expected payment must appear, and every queued transaction must be explained. Totals are compared per recipient, which handles the platform bundling several grants for one counterparty into a single withdrawal — and means one observed transaction cannot satisfy two obligations. Transactions appearing in more than one screenshot are flagged rather than silently deduplicated or double-counted. **Unlike the previous version, this check affects the result.**

## The rules being applied

- **R1 — timing.** A payment's own event date selects the instalment it pays.
- **R2 — amount.** Exact matches pass. A difference within both 0.1% and 1,000 tokens needs review. Anything else fails. A near miss is never a silent pass.
- **R3 — splitting.** One instalment may be paid across several rows, so amounts are compared as a per-(grant, month) group total. Identical repeated rows are surfaced for review rather than failed.
- **R4 — exposure.** Checked against both the grant's lifetime cap and the amount scheduled up to that month, counting the whole batch rather than one row at a time.

## What each outcome means

- **PASS** — the check ran and the payment satisfied it.
- **FAIL** — the check ran and found a definite discrepancy.
- **NEEDS REVIEW** — the check could not be completed, or its evidence is ambiguous, stale or unreadable.
- **EXCLUDED** — deliberately not being paid (paused, cancelled). Never an implicit pass, and still reported if it is sitting in the queue.

A batch reports **all required checks passed** only when every required check on every non-excluded payment actually ran and passed, no queue finding is outstanding, and no source was degraded. Absence of evidence never counts as a pass: an unreadable amount, a truncated read, an empty payment history, a missing cap, or an unreadable screenshot each produce NEEDS REVIEW and block a clean result.

Amounts are held as integer micro-units (`artifacts/api-server/src/lib/verification/money.ts`), so comparisons are exact and a value carrying more precision than can be represented is rejected rather than rounded.

## Evidence kept for each run

Each run records a run id, the time, the app version, the schedule periods loaded, content fingerprints of every source, and the degradations encountered. A later change to the schedule or history produces a different fingerprint, so an earlier result can be shown to be stale. Re-run before approving.

## Stack

pnpm workspace monorepo, TypeScript 5.9 throughout. Express 5 + pino on the server, bundled to a single ESM file with esbuild. React 19 + Vite 7 + Tailwind 4 + Radix on the client. `lib/api-spec/openapi.yaml` is the contract: Orval generates the Zod schemas (`lib/api-zod`) and the React Query client (`lib/api-client-react`) from it, so both sides are generated from one description. Nothing enforces it at runtime, and the spec does not yet cover `/verify/sheets` or `/ocr/status`. ExcelJS for the upload, `googleapis` for the sheets, the `openai` SDK pointed at OpenRouter for both matching and OCR, Vitest for the tests. No database — the service is stateless and holds nothing between requests beyond the 5-minute sheet cache.

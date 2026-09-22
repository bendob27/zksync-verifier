# ZK Unlock Verifier

[![CI](https://github.com/bendob27/zksync-verifier/actions/workflows/ci.yml/badge.svg)](https://github.com/bendob27/zksync-verifier/actions/workflows/ci.yml)

**Live demo: https://zksync-verifier.vercel.app** — password `demo`, then "Load the sample
batch". It runs the real verification engine against invented data and contacts nothing
external: no spreadsheet, no AI provider, no credentials. Seven payments, each showing a
different check — two clean, plus a duplicate, a breached cap, a wrong-month amount, a
missing limit, and a paused payment still sitting in the custody queue.

## What it does

Each week a batch of ZK token unlocks is queued for approval on a custody platform. This tool reconciles that queue against the sources of truth — the unlock schedule and the payment history — before anyone signs. It parses the custody export, matches every line to the unlock scheduled for that grant in that month, confirms the payment has not already gone out, and returns a per-transaction PASS / FYI / FAIL verdict with the arithmetic behind each check.

## Inputs

| Input | Source | Required |
|---|---|---|
| Unlock schedule | Google Sheet tab, read-only service account (`TOKEN_MODEL_SHEET_ID`) | yes |
| Payment history | Google Sheet tab (`FINANCE_WORKBOOK_SHEET_ID`) | yes |
| Weekly custody export | `.xlsx` upload, ≤10 MB, sheet selectable | yes |
| Custody queue screenshots | up to 10 PNG/JPG, ≤10 MB each, read by a vision model | optional |

## How the check works

**1. Read the custody export** (`lib/verification/custodyExport.ts`). Cell *values* are read, not their rendered text, so a native date or numeric cell keeps its type. Every row below the header is accounted for: rows that are not unlock events, or not `PENDING`, are listed as skipped with a reason; an amount that cannot be read is recorded as unreadable rather than becoming zero. Each row is given a stable payment id derived from its position and contents, so a re-run can be compared with an earlier one.

**2. Work out which schedule columns the batch needs** (`lib/verification/period.ts`). The schedule is laid out wide — one row per grant, one column per month — so an instalment is a single cell. A payment's *own* event date selects its column, which means a batch straddling a month end has each row judged against its own month, and re-running last quarter's batch reads the columns it read at the time. Nothing consults the server clock.

**3. Load the sources for exactly those periods** (`lib/verification/loadSources.ts`), plus every earlier column so "scheduled to date" can be totalled. Truncation is detected: if a sheet fills the read window, the run says so. An empty payment history is treated as a failure to load, not as "nothing has ever been paid".

**4. Resolve each payment to one schedule row** (`lib/verification/resolve.ts`). Most rows resolve deterministically. Only the leftovers go to a model, and it is asked one question — *which row?* — answerable only with a row id supplied to it. It is never asked for, and never shown a slot for, an amount, a date or a cap. Its answer is validated: every requested payment must be accounted for exactly once, and an id we did not offer is rejected. A missing, duplicated, invented or declined answer becomes NEEDS REVIEW.

**5. Apply the deterministic checks** (`lib/verification/checks.ts`). Every compared value is read from a fetched record.

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

**6. Reconcile the custody queue** (`lib/verification/queue.ts`), in both directions: every expected payment must appear, and every queued transaction must be explained. Totals are compared per recipient, which handles the platform bundling several grants for one counterparty into a single withdrawal — and means one observed transaction cannot satisfy two obligations. Transactions appearing in more than one screenshot are flagged rather than silently deduplicated or double-counted. **Unlike the previous version, this check affects the result.**

### The rules being applied

- **R1 — timing.** A payment's own event date selects the instalment it pays.
- **R2 — amount.** Exact matches pass. A difference within both 0.1% and 1,000 tokens needs review. Anything else fails. A near miss is never a silent pass.
- **R3 — splitting.** One instalment may be paid across several rows, so amounts are compared as a per-(grant, month) group total. Identical repeated rows are surfaced for review rather than failed.
- **R4 — exposure.** Checked against both the grant's lifetime cap and the amount scheduled up to that month, counting the whole batch rather than one row at a time.

### What each outcome means

- **PASS** — the check ran and the payment satisfied it.
- **FAIL** — the check ran and found a definite discrepancy.
- **NEEDS REVIEW** — the check could not be completed, or its evidence is ambiguous, stale or unreadable.
- **EXCLUDED** — deliberately not being paid (paused, cancelled). Never an implicit pass, and still reported if it is sitting in the queue.

A batch reports **all required checks passed** only when every required check on every non-excluded payment actually ran and passed, no queue finding is outstanding, and no source was degraded. Absence of evidence never counts as a pass: an unreadable amount, a truncated read, an empty payment history, a missing cap, or an unreadable screenshot each produce NEEDS REVIEW and block a clean result.

Amounts are held as integer micro-units (`lib/verification/money.ts`), so comparisons are exact and a value carrying more precision than can be represented is rejected rather than rounded.

### Evidence kept for each run

Each run records a run id, the time, the app version, the schedule periods loaded, content fingerprints of every source, and the degradations encountered. A later change to the schedule or history produces a different fingerprint, so an earlier result can be shown to be stale. Re-run before approving.

### Known limitations

- **Other pending batches are not visible.** Exposure counts the payment history plus the batch being checked. No source in this system records payments approved elsewhere but not yet settled, so cross-batch duplication is *not* checked. Do not read a pass as ruling it out.
- **Payment destinations are not verified.** The wallet address is carried through and displayed, but there is no authoritative destination record to check it against, so a payment to the wrong address for the right grantee would not be caught.
- **A grant with several schedule rows for one month resolves to NEEDS REVIEW** rather than being summed. Summing would be a business rule that has not been approved; the conservative reading cannot produce a false pass.
- **Screenshots are candidate evidence.** A structured custody export would be stronger. Reading is per-image, and a failed image is reported rather than hidden, but a queue check resting on screenshots is only as good as the images supplied.
- **No historical validation has been performed.** The suite below is synthetic. See `docs/historical-replay.md` for replaying real batches privately against human-checked answers.

## Stack

pnpm workspace monorepo, TypeScript 5.9 throughout. Express 5 + pino on the server, bundled to a single ESM file with esbuild. React 19 + Vite 7 + Tailwind 4 + Radix on the client. `lib/api-spec/openapi.yaml` is the contract: Orval generates the Zod schemas (`lib/api-zod`) and the React Query client (`lib/api-client-react`) from it, so both sides are generated from one description. Nothing enforces it at runtime, and the spec does not yet cover `/verify/sheets` or `/ocr/status`. ExcelJS for the upload, `googleapis` for the sheets, the `openai` SDK pointed at OpenRouter for both matching and OCR, Vitest for the tests. No database — the service is stateless and holds nothing between requests beyond the 5-minute sheet cache.

## Running locally

```bash
pnpm install
cp .env.example .env     # then fill in the required values
pnpm dev                 # API on :8080, Vite on :5173 proxying /api to it

pnpm test                # Vitest — 123 cases, all against the live verification path
pnpm typecheck
pnpm build
pnpm --filter @workspace/api-spec codegen   # regenerate client + Zod schemas from openapi.yaml
```

The API refuses to start unless every required variable below is present, and unless `CORS_ORIGIN` is set when `NODE_ENV=production` (`lib/config.ts`). Failing at boot beats failing halfway through a distribution review.

| Variable | Used by | Notes |
|---|---|---|
| `SESSION_SECRET` | server | required; HMAC key for the session cookie |
| `DASHBOARD_PASSWORD` | server | required; the single shared login |
| `GOOGLE_CREDENTIALS` | server | required; service-account JSON on one line, read access to both sheets |
| `OPENROUTER_API_KEY` | server | required; grant matching and screenshot OCR |
| `TOKEN_MODEL_SHEET_ID` | server | required; unlock schedule workbook |
| `FINANCE_WORKBOOK_SHEET_ID` | server | required; payment history workbook |
| `CORS_ORIGIN` | server | required in production; unset means CORS reflects any origin |
| `PORT` | server | API port, defaults to 8080 |
| `WEB_PORT` | frontend | Vite dev and preview port, defaults to 5173 (deliberately not `PORT`, to avoid colliding in a shared `.env`) |
| `NODE_ENV` | both | `production` enables `secure` cookies and plain JSON logs |
| `LOG_LEVEL` | server | defaults to `info` |
| `GRANT_ID_HEADER` | server | header text of the grant ID column; defaults to `Grant ID` |
| `UNLOCK_SCHEDULES_TAB`, `VESTING_SCHEDULES_TAB`, `CASH_FLOWS_TAB` | server | override the sheet tab names |
| `BASE_PATH` | frontend | defaults to `/`; set it when hosting under a sub-path |
| `API_PROXY_TARGET` | frontend | dev and preview proxy target, defaults to `http://localhost:8080` |

## Project layout

```
artifacts/
  api-server/                    Express 5 API
    src/routes/                  /healthz /auth /verify /sheets /ocr
    src/lib/verification/        the verification engine (123 Vitest cases)
      money.ts                   exact token arithmetic in integer micro-units
      period.ts                  dates, schedule periods, batch period selection
      sources.ts                 validated schedule and payment-history records
      custodyExport.ts           .xlsx reader with full row accounting
      loadSources.ts             period-aware sheet loading, truncation detection
      resolve.ts                 grant identity resolution; the model's only role
      checks.ts                  the deterministic checks (R1-R4)
      queue.ts                   two-directional custody queue reconciliation
      engine.ts                  orchestration, provenance, run summary
      present.ts                 one result shape for UI, CSV and PDF
      run.ts                     the service the endpoint calls
    src/lib/sheets.ts            Google Sheets client, retry
    src/lib/session.ts           signed session cookie, requireAuth
    src/lib/config.ts            boot-time environment validation
    src/lib/constants.ts         tolerances, tab names, retry policy
  zksync-unlock-parser/          React + Vite dashboard, CSV and PDF export
docs/
  historical-replay.md           replaying real batches privately against human answers
lib/
  api-spec/                      openapi.yaml + Orval config (the contract)
  api-zod/                       generated Zod schemas and types
  api-client-react/              generated React Query client
```

## License

MIT — see [LICENSE](LICENSE).

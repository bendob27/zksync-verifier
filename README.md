# ZK Unlock Verifier

[![CI](https://github.com/bendob27/zksync-verifier/actions/workflows/ci.yml/badge.svg)](https://github.com/bendob27/zksync-verifier/actions/workflows/ci.yml)

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

**1. Parse the custody export** (`lib/excel.ts`). Headers are read from row 1 and resolved through alias lists, so `Grant Name` / `Grant ID`, `Token Amount` / `Amount` / `Tokens`, and `Event Date` / `Unlock Date` all work. A missing required column aborts with the list of headers actually found. A row is kept only if `Event Type` is absent or `unlock` **and** `Status` is `PENDING`. Dates are converted `DD/MM/YYYY` → `YYYY-MM-DD`; thousands separators are stripped from amounts. A `Notes` value containing `pause`, `skip`, `no wallet` or `cancel` marks the row as excluded rather than failed.

**2. Load the reference data** (`lib/sheets.ts`), in parallel, behind a 5-minute in-process cache. Neither sheet has a fixed layout, so the header row is discovered by scanning the first 50 rows for the grant-ID header, falling back to a `Total Tokens` marker and then to the first row with ≥5 non-empty cells. Month columns are matched against both the current and the next month label (`Mar 2026`), so a batch straddling a month boundary still resolves. If header discovery fails outright, a raw 100×10 grid is passed downstream instead of throwing. Sheets 429s retry three times with exponential backoff from 1 s; a 403 raises an explicit "share the sheet with the service account" error.

**3. Extract the screenshots** (`lib/ocr.ts`), if supplied. A vision model returns `{recipient, amount, date}` per queued withdrawal. Amounts arrive in European notation, so `parseEuropeanNumber` disambiguates dot-vs-comma decimals before anything numeric happens.

**4. Run the checks** (`lib/ai-matcher.ts`). Rows flagged in step 1 skip verification entirely and come back YELLOW / `FYI`. For the rest:

| Check | GREEN | YELLOW | RED |
|---|---|---|---|
| `recipientExists` | grant located in the schedule, by ID or by name | — | not located |
| `amountMatch` | `\|Δ\| / expected ≤ 0.001` **and** `\|Δ\| ≤ 1000` tokens | — | anything else, or no match |
| `timingMatch` | matched row has a non-zero amount in the resolved month column | matched row is 0 or blank for that month | no match |
| `duplicateCheck` | no prior payment, or none that collides | payment-history fetch failed | prior payment within <1 token **and** ≤1 day |
| `screenshotMatch` | recipient's screenshot total within `max(0.1%, 1 token)`, or an individual line matches | no screenshot row for that recipient | amounts disagree |

Grant IDs in the export and in the schedule are not reliably the same string (`ACM001` vs `ACM-001`, or a row reachable only through the name column), so ID-to-row resolution is delegated to a model. **Its amount assertion is not trusted.** The model returns an `amountMatches` boolean, but that field feeds only a summary counter — never a verdict. `amountMatch` is recomputed server-side from the model's `expectedAmount` and the export amount against `AMOUNT_TOLERANCE_PERCENT = 0.001` and `AMOUNT_TOLERANCE_ABSOLUTE = 1000` (`lib/constants.ts`), both of which must hold. The model's prose survives only as commentary appended to the detail string. Recipient grouping is deterministic too: the custody platform bundles several grants to one counterparty into a single withdrawal, so transactions are grouped by recipient and the group total is compared against the summed screenshot lines, with fuzzy recipient matching (lowercased, non-alphanumerics stripped, equality or containment either way).

**Aggregation.** A transaction's overall status is the worst of `recipientExists`, `amountMatch`, `timingMatch` and `duplicateCheck`. `screenshotMatch` is shown in the detail panel but deliberately excluded from the roll-up, since OCR noise should not block an otherwise clean batch. GREEN → PASS, YELLOW → FYI, RED → FAIL. A failed payment-history fetch degrades `duplicateCheck` to YELLOW rather than reporting a GREEN it cannot justify, and if the model call throws, every transaction is forced RED with the error in the detail — the check fails closed, never open. The response also carries a counts summary and a three-line plain-text summary (safe to sign / needs investigation / excluded), which the dashboard exports as CSV and PDF.

**The deterministic reference engine.** `lib/matcher.ts` implements the same verification with no model in the loop: exact case-insensitive grant-ID matching, nearest-amount selection when a grant has several tranche rows, a ±1 day (`DATE_TOLERANCE_DAYS`) timing window, its own duplicate check, and a cumulative check that prior payments plus this one must not exceed the grant total. Its amount grading is three-way — exact is GREEN, inside both tolerances is YELLOW, outside is RED — and it is where the tolerance values are pinned down. `matcher.test.ts` holds 53 Vitest cases against it, including a "never false-negative" group asserting that every genuinely wrong transaction surfaces as RED.

Known gap, stated plainly: the live route calls the model-assisted path, because real-world ID formatting defeats string equality. The two paths import the same tolerance constants but implement the duplicate check separately, and **the cumulative overpayment check exists only in `matcher.ts`, so it does not run in production.** Consolidating the two onto one engine — with the model used solely for ID resolution — is the obvious next change.

**Access control.** `/verify`, `/verify/sheets`, `/sheets`, `/ocr` and `/ocr/status` sit behind `requireAuth`. Sessions are an HMAC-SHA256 signed, `httpOnly` cookie with a server-side 24-hour expiry, verified with a constant-time comparison (`lib/session.ts`); login uses a timing-safe password compare and is rate-limited to 5 attempts per minute per IP. `/healthz` and `/auth` are open by design. The logger redacts `authorization`, `cookie` and `set-cookie`.

## Stack

pnpm workspace monorepo, TypeScript 5.9 throughout. Express 5 + pino on the server, bundled to a single ESM file with esbuild. React 19 + Vite 7 + Tailwind 4 + Radix on the client. `lib/api-spec/openapi.yaml` is the contract: Orval generates the Zod schemas (`lib/api-zod`) and the React Query client (`lib/api-client-react`) from it, so request and response shapes stay in step across the two sides. ExcelJS for the upload, `googleapis` for the sheets, the `openai` SDK pointed at OpenRouter for both matching and OCR, Vitest for the tests. No database — the service is stateless and holds nothing between requests beyond the 5-minute sheet cache.

## Running locally

```bash
pnpm install
cp .env.example .env     # then fill in the required values
pnpm dev                 # API on :8080, Vite on :5173 proxying /api to it

pnpm test                # Vitest
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
    src/lib/matcher.ts           deterministic verification engine
    src/lib/matcher.test.ts      53 Vitest cases pinning the tolerances
    src/lib/ai-matcher.ts        model-assisted matching + server-side amount gate
    src/lib/sheets.ts            Sheets fetch, header discovery, retry, cache
    src/lib/excel.ts             custody export parser
    src/lib/ocr.ts               screenshot extraction, European number parsing
    src/lib/session.ts           signed session cookie, requireAuth
    src/lib/config.ts            boot-time environment validation
    src/lib/constants.ts         tolerances, tab names, retry policy
  zksync-unlock-parser/          React + Vite dashboard, CSV and PDF export
lib/
  api-spec/                      openapi.yaml + Orval config (the contract)
  api-zod/                       generated Zod schemas and types
  api-client-react/              generated React Query client
```

## License

MIT — see [LICENSE](LICENSE).

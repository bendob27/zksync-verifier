# ZK Unlock Verifier

[![CI](https://github.com/bendob27/zksync-verifier/actions/workflows/ci.yml/badge.svg)](https://github.com/bendob27/zksync-verifier/actions/workflows/ci.yml)

A foundation pays tokens to grant recipients on monthly schedules set in their contracts.
Each week a batch of these payments waits on a custody platform for someone to approve
it. Once approved, a payment cannot be reversed. This tool checks every payment in the
batch before sign-off. Is it owed this month? Is the amount exactly right? Has it already
been paid? Would it take the grant past its contractual total? Does the queue contain
anything that should not be there? It returns a verdict per payment, with the arithmetic
behind each one, so the approver signs on evidence instead of by eye.

**Live demo:** https://zksync-verifier.vercel.app (password `demo`, then "Load the sample
batch"). It runs the real engine on invented data and contacts nothing external.

## How it works

```
 custody export (.xlsx) ─┐
 queue screenshots ──────┤      ┌──────────────────────────┐
                         ├────► │ 1. read every row        │
 unlock schedule ────────┤      │ 2. match each to a grant │ ───► PASS / FAIL /
 (Google Sheet)          │      │ 3. run the checks        │      NEEDS REVIEW / EXCLUDED
 payment history ────────┘      │ 4. reconcile the queue   │      per payment, plus a
 (Google Sheet)                 └──────────────────────────┘      batch verdict
```

1. **Read the export.** Every row is accounted for. Rows that are not pending unlocks
   are listed as skipped, with a reason. An amount that cannot be read is never treated
   as zero.
2. **Match each payment to one grant** in the schedule. Most match on grant id. For the
   rest, a language model picks a row, but only from ids it is given. It never supplies
   an amount, date or limit. An unclear match becomes NEEDS REVIEW.
3. **Run the checks.** Each payment must be:
   - scheduled for the month of its own date
   - an exact match for that month's scheduled amount (split payments are summed first)
   - not already paid, and not repeated in the batch
   - within the grant's lifetime cap
   - within the total scheduled up to that month
4. **Reconcile the custody queue** in both directions. Every expected payment must be in
   the queue, and every queued transaction must be explained by one.

A batch is only reported clean when every check on every payment ran and passed. Missing
or unreadable evidence is NEEDS REVIEW, never a pass. The rules and edge cases are in
[docs/how-it-works.md](docs/how-it-works.md).

## Example

A run on the demo data. All names, amounts and addresses are invented. The export is
`/api/demo/sample.xlsx` on a demo instance; "Load the sample batch" in the dashboard gives
the same result.

```
$ .claude/skills/unlock-check/scripts/run-check.sh sample.xlsx
run 359ac090-b5ac-4229-a502-7c661ca62ec2  sheet CW25  periods 2026-04, 2026-05, 2026-06
7 payments: 2 pass, 3 fail, 1 review, 1 excluded
all required checks passed: false

PASS         ACM001   Acme Labs                     100,000  0xdem0000000000000000000000000000000000a1
PASS         NWD014   Northwind Systems              50,000  0xdem0000000000000000000000000000000000b2
FAIL         BLV007   Belvedere Research             20,000  0xdem0000000000000000000000000000000000c3
             - notDuplicated: A payment of 20,000 for this grant was already recorded on 15/05/2026 (payment history row 7).
FAIL         CLD002   Calderon Group                 30,000  0xdem0000000000000000000000000000000000d4
             - withinGrantCap: This batch would take CLD002 past its total cap: 60,000 already paid plus 30,000 proposed is 90,000, against a cap of 80,000.
NEEDS_REVIEW QLF031   Quillfeather Studio            15,000  0xdem0000000000000000000000000000000000e5
             - withinGrantCap: The schedule gives no total cap for QLF031, so overpayment against the grant could not be ruled out.
FAIL         HLD022   Halden Partners                10,000  0xdem0000000000000000000000000000000000f6
             - amountMatches: Amount does not match the scheduled instalment: scheduled 60,000, proposed 10,000 (difference 50,000).
EXCLUDED     MRL009   Marlowe Ventures               25,000  0xdem000000000000000000000000000000000017
             - grantResolved: Not verified — marked "PAUSE" in the custody export. It is still present in the custody queue and must be removed or approved deliberately.

custody queue:
  FAIL: "Marlowe Ventures" is queued for 25,000 but its payment is marked as paused or cancelled. It must be removed from the queue or approved deliberately.
  FAIL: The custody queue contains 45,000 for "Ferrograph Ltd", which no payment in this batch accounts for.
```

Calderon Group shows why the checks look at the whole batch. The payment matches its
monthly amount exactly, so a row-by-row check would pass it. Added to what has already
been paid, it takes the grant 10,000 past its contractual total.

## Weekly workflow

The weekly review runs through Claude Code. The repository carries the setup:

- **`CLAUDE.md`** gives Claude the project context and the rules that must not be
  weakened: missing evidence is never a pass, the model only picks a row, amounts are
  exact, and no real data is committed.
- **`/unlock-check`**, a custom skill in `.claude/skills/unlock-check/`, runs the review:
  1. The reviewer shares the week's custody export and queue screenshots.
  2. Claude checks that both are present, current and complete. A cut-off screenshot
     gets a request for the missing lines, not a partial check.
  3. Claude runs the verifier through `scripts/run-check.sh` and reads the result.
  4. Claude does the checks the verifier cannot: each destination against the wallet
     register and past payments, source wallet balances, and batches still pending
     elsewhere.
  5. Claude reads each FAIL against `references/failure-modes.md`. These are known
     false alarms (catch-up payments, consolidated withdrawals, USD-priced grants) and
     the few patterns that are real red flags.
  6. The reviewer gets a table with one row per queue line and a verdict. Anything
     unresolved comes as a question for whoever owns the answer. Open questions hold
     single lines, not the whole batch.

The dashboard does the same verification in a browser, with CSV and PDF export.

## Setup and run

Requires Node 22 or later (CI uses 24) and pnpm 10.

**Demo, no credentials:**

```bash
pnpm install
printf 'DEMO_MODE=true\nDASHBOARD_PASSWORD=demo\nSESSION_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
pnpm dev        # API on http://localhost:8080, dashboard on http://localhost:5173
```

**Against real sheets:** copy [.env.example](.env.example) to `.env` and fill in the
required values. The server refuses to start if any are missing.

| Variable | Required | Purpose |
|---|---|---|
| `DASHBOARD_PASSWORD` | yes | Shared login for the dashboard and API |
| `SESSION_SECRET` | yes | Signs the session cookie |
| `GOOGLE_CREDENTIALS` | yes | Service-account JSON, one line, read access to both sheets |
| `OPENROUTER_API_KEY` | yes | Grant matching and screenshot reading |
| `TOKEN_MODEL_SHEET_ID` | yes | Sheet holding the unlock schedule |
| `FINANCE_WORKBOOK_SHEET_ID` | yes | Sheet holding the payment history |
| `CORS_ORIGIN` | in production | Allowed browser origin |
| `DEMO_MODE` | no | `true` serves invented data and needs only the first two variables |

Tab names, the grant id header, ports, the model and log level can also be set. See
`.env.example`.

**Checks:**

```bash
pnpm test         # Vitest suite for the verification engine
pnpm typecheck
pnpm build
```

## Project structure

```
.claude/        Claude Code skill for the weekly review: instructions, failure modes, run script
.github/        CI: install, typecheck, test, build on every push
api/            Serverless entry point for the demo deployment
artifacts/      The applications: api-server (Express API and verification engine) and the React dashboard
docs/           How the checks work, and how to replay past batches privately
lib/            OpenAPI contract and the Zod schemas and React Query client generated from it
CLAUDE.md       Project context and rules for Claude Code
.env.example    Configuration template
vercel.json     Demo deployment settings
```

## Limitations and next steps

- **Destinations are not verified by the tool.** It shows each wallet address but has no
  authoritative register to check it against. The Claude Code skill covers this by hand.
  Next step: read the wallet register as a third source.
- **Other pending batches are invisible.** Duplicates are checked against paid history
  and the current batch only.
- **Several schedule rows for one grant in one month** give NEEDS REVIEW rather than a
  sum, until that rule is approved.
- **Screenshots are weaker evidence than a structured export.** Next step: read the
  custody queue from the platform's API.
- **Tests use synthetic data only.** The procedure for replaying real past batches
  privately is in [docs/historical-replay.md](docs/historical-replay.md).

## Credits

Built with [Claude Code](https://claude.com/claude-code) by Benjamin Furlong. MIT licence,
see [LICENSE](LICENSE).

# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A verifier for weekly token-unlock batches. It reconciles a custody export (and optional
queue screenshots) against the unlock schedule and payment history, and returns PASS /
FAIL / NEEDS REVIEW / EXCLUDED per payment. See `README.md` for the summary and
`docs/how-it-works.md` for the rules.

Two kinds of work happen here:

- **Running the weekly check.** Use the `unlock-check` skill
  (`.claude/skills/unlock-check/`). It runs the verifier and covers what the verifier
  does not: destinations, source wallets, and known false alarms.
- **Changing the verifier.** The rest of this file.

## Commands

```bash
pnpm install
pnpm dev          # API on :8080, dashboard on :5173
pnpm test         # Vitest, verification engine
pnpm typecheck
pnpm build
pnpm --filter @workspace/api-spec codegen   # after editing lib/api-spec/openapi.yaml
```

Demo mode needs no credentials: `DEMO_MODE=true`, plus `SESSION_SECRET` and
`DASHBOARD_PASSWORD`.

## Rules that must hold

These are the reasons the tool can be trusted. Do not weaken them to make a test pass.

1. **Absence of evidence is never a pass.** Missing cap, unreadable amount, truncated
   read, empty history, unreadable screenshot: each is NEEDS REVIEW and blocks a clean
   result.
2. **The model only picks a row.** In `resolve.ts` and `propose.ts` the model chooses a
   schedule row id from ids it was given. It never supplies or sees a slot for an amount,
   date or cap. Every compared value comes from a fetched record.
3. **Exact arithmetic.** Amounts are integer micro-units (`money.ts`). No floats in
   comparisons. Reject precision that cannot be represented; never round it.
4. **A payment's own date picks its month** (R1). Never the server clock.
5. **Business rules are approved, not invented.** R1-R4 are documented in
   `docs/how-it-works.md`. A new rule, such as summing several schedule rows for one
   grant and month, needs sign-off first. Until then the conservative outcome is NEEDS
   REVIEW.

## Data

- **Never commit real data.** No real grantee names, grant ids, amounts, wallet
  addresses, sheet ids or tab names, in code, tests, fixtures or commit messages.
  Sheet ids and tab names come from environment variables.
- Tests use invented data (Acme Labs, `ACM001`, round numbers). When a real case exposes
  a bug, reduce it to synthetic data with the same shape before writing the test. See
  `docs/historical-replay.md`.
- `demo/data.ts` is public. `demo.test.ts` asserts it contains only invented grantees.

## Where things are

- `artifacts/api-server/src/lib/verification/`: the engine. One file per stage; each
  has a `*.test.ts` beside it.
- `artifacts/api-server/src/routes/`: HTTP routes. `verify.ts` wires the engine to real
  or demo sources.
- `artifacts/zksync-unlock-parser/`: the dashboard.
- `lib/api-spec/openapi.yaml`: the API contract. The Zod and React Query clients are
  generated from it; do not edit `generated/` by hand.

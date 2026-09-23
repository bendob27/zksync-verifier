---
name: unlock-check
description: Run the weekly review of a pending token-unlock batch before it is approved on the custody platform. Use when someone shares a custody export (.xlsx), approval-queue screenshots, or asks to check this week's unlocks, "can I approve these", "does this batch check out", or "anything odd in this queue". Also use for one-off treasury movements that appear in the same queue (internal vault funding, settlements, top-ups), since those follow different rules from routine unlocks.
---

# Weekly unlock batch review

A batch of withdrawals sits in the custody approval queue and someone has to decide
whether signing it is safe. The verifier does the arithmetic. This skill runs it, reads
the result, and adds the judgement the verifier cannot make.

Mechanical reconciliation first, judgement second. Amounts that look wrong are often
fine; amounts that look fine are occasionally the problem.

## Inputs

Ask for both before starting. Do not start with one and offer to check the rest later:
a partial pass reads as a clean bill of health.

| Input | What it is | Why |
|---|---|---|
| Custody export `.xlsx` | This week's export of pending unlock events | What is due |
| Queue screenshot(s) | The approval queue as it appears on the custody platform | What is actually being signed |

On receipt, confirm:

- **The export is this week's.** Exports are regenerated often; an old one disagrees with
  the queue for boring reasons. If several copies were shared, say which one you used.
- **The screenshots show the whole queue.** Queues scroll and the last line is often cut
  off. If the header says "6 of 6" but five lines are legible, ask for the rest.

The unlock schedule and payment history are read by the verifier from its configured
sheets. Do not ask the reviewer for them.

## Run it

The verifier must be running (`pnpm dev`, or a deployed instance). Then:

```bash
VERIFIER_URL=http://localhost:8080 DASHBOARD_PASSWORD=... \
  .claude/skills/unlock-check/scripts/run-check.sh CW25-export.xlsx queue-1.png queue-2.png
```

Add `--sheet NAME` if the export has several tabs. The script prints one line per payment
with every check that did not pass, then the custody-queue findings, and saves the full
JSON beside the export. Read the JSON when you need the arithmetic behind a check.

If `degraded sources` is printed, stop: a truncated or empty source means the checks did
not run on complete data. Re-run before saying anything about the batch.

## What the verifier does not check

These are yours to do on every line, because the verifier cannot:

1. **Destination address.** It displays the wallet but has no authoritative record to
   check it against. Compare each destination with the team's wallet register and the
   recipient's previous payments. A destination with no history is the single most
   important thing to catch.
2. **Source wallet.** Confirm the source vault holds enough and that its tokens are not
   reserved for another purpose.
3. **Other pending batches.** Duplicates are checked against paid history and this upload
   only. Ask whether anything for the same grants is approved but not yet settled.

## Before flagging anything

Read `references/failure-modes.md` whenever a FAIL or NEEDS REVIEW is not obviously
explained. Most apparent discrepancies are one of these, and calling them problems
erodes trust in the check:

- A. Consolidated tranches: one queue line, several payments
- B. Catch-up payments: looks like a duplicate, is not
- C. Internal funding transfers: not payouts, sized to the remaining schedule
- D. USD-denominated grants: token quantity moves with price
- E. New destination address: the one that genuinely matters
- F. Stale rate in the schedule: payments right, sheet wrong
- G. Terminated but still vesting
- H. Reserved or escrowed source wallets

Read the export's `Notes` column. It often explains an anomaly before you go looking.

## Reporting

Match the depth to the question. "Can I approve these?" wants a verdict, not a tour of
the method. Default to one compact table, one row per queue line:

| Line | Verifier result | Destination and source | Verdict |

Then, only if needed, a short list of things to confirm before signing, phrased as
questions the reviewer can forward to whoever owns the answer.

- **State the arithmetic.** "45,000 = 3 × 15,000, May and June paused, resubmitted with
  July" is more convincing than "reconciles".
- **Separate hold from worth knowing.** Sheet hygiene and stale rates are useful but are
  not reasons to block a signature. Say which is which.
- **Hold one line, not the batch.** When one line has an open question, the rest can
  usually proceed.

## Where judgement matters

The verifier cannot tell a legitimate wallet rotation from a compromised payout
instruction, or a deliberate exhaust-the-wallet transfer from an overpayment. When a
line turns on intent rather than arithmetic, say so plainly and name who should confirm
it. Unlock payments are irreversible, so an unresolved address question is worth holding
a line for even when everything else is clean.

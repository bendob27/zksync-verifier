# Failure modes

Patterns that come up in weekly batches. Read this whenever a number does not match on
first pass. Most apparent discrepancies are A-D or F-H and are not problems. E is the one
that is.

All names and figures below are invented to illustrate the shape of each case.

## A. Consolidated tranches

**Symptom:** a queue line matches no single payment in the export.

The custody platform rolls several payments to the same recipient into one withdrawal.
The verifier already compares queue totals per recipient, so a consolidated line passes
when the parts add up. When it does not pass, group the export by recipient and sum
before concluding anything.

- Queue shows 23,750 to Acme Labs. Export has ACM001 20,000 and ACM002 3,750. One line,
  two grants.

Odd trailing decimals on a queue line are a tell that it is a sum. Consolidated lines can
mix months.

## B. Catch-up payments

**Symptom:** the same recipient appears twice, or an amount is an exact multiple of the
monthly rate. The verifier may report a duplicate or an amount mismatch.

Unlocks get paused (renegotiation, a compliance hold, an ops backlog) and resubmitted
later. The `Notes` column usually says so.

- Northwind Systems queued 30,000 and 15,000. The export has three rows: May and June
  marked "paused, resubmitting", plus July. 45,000 = 3 × 15,000. Correct.

Confirm that, after payment, total paid equals months elapsed × monthly rate. If it does,
the catch-up is real.

## C. Internal funding transfers

**Symptom:** a very large queue line between two internal wallets that no payment
explains. The verifier reports it as an unexplained queue transaction.

These move tokens into a grantee vault so later payouts can settle. They are sized to the
remaining obligation, not a monthly amount.

- 500,000 from a treasury vault to a grantee vault. The vault holds 100,000; the grant has
  600,000 left to pay. Gap = 500,000. A final top-up.

Method: remaining scheduled total minus current vault holdings, compared with the
transfer. Also confirm the destination is an internal vault under the expected legal
entity. A large transfer to a plausibly named external address is exactly what a
compromised instruction looks like.

## D. USD-denominated grants

**Symptom:** token quantity is far from the schedule's figure for the month, often by
2-3x. The verifier fails the amount check.

Some grants are denominated in USD. The token quantity is set at payment time, so a
falling token price raises the count while the obligation is unchanged.

- Grant owes $100,000 per quarter. At $0.05 that is 2,000,000 tokens; the schedule's
  placeholder assumed $0.10 and shows 1,000,000.

Verify the USD amount against the agreement and the reference price against the
contract. The token number is an output. Checking it against a stale sheet figure proves
nothing. Report the amount FAIL as explained, and say how.

## E. New or unregistered destination

**This is the one that matters.** Amounts are recoverable errors. Addresses are not. The
verifier does not check destinations, so this is always a manual check.

**Symptom:** a destination with no prior payment history or no register entry,
especially when the amount is exactly right.

- Halden Partners, amount correct to the token, but the destination has never been used.
  Every prior payment went to a different address. Hold pending verification.

Legitimate rotations happen, so a new address is a question, not proof. Ask: is there a
written payout-address change, verified out of band? Does the vesting platform's record
agree with the wallet register? If the two disagree, say so.

When the approval screen shows only a wallet name and not the address, the check has not
been done. Names are easy to spoof. Expand the address.

## F. Stale rate in the schedule

**Symptom:** the verifier fails the amount check by a small, steady amount every month,
and the queue follows the vesting platform rather than the schedule.

- Schedule says 29,000 per month. The platform and every past payment use 31,000. The
  payments were right; the schedule row is stale.

Resolve with payment history: whichever rate matches months of actual payments is the real
one. Report it as sheet hygiene for whoever maintains the schedule, not a reason to hold.

## G. Terminated but still vesting

**Symptom:** a grant marked terminated still produces unlocks.

Termination often does not stop vesting at once. There may be a notice period, a
settlement, or an unwind schedule. A single large payment may be the whole remaining
balance released as a settlement. Confirm it against the signed figure.

Check the other direction too: a terminated grant that should have stopped but is still
queued. The verifier reports a paused or cancelled row that is still in the queue. Flag
it so it is cancelled at source and does not resurface next week.

## H. Reserved or escrowed source wallets

**Symptom:** an unusual source wallet, or a source whose balance exactly equals the
withdrawal.

Exact-balance draws are often deliberate ("empty the wallet so ops need not track it").
The same signature appears when tokens earmarked for one purpose are spent on another.
Read the register's purpose and entity fields for the source, not just the balance.

## What a genuine red flag looks like

Short list. Everything else is usually A-D or F-H.

1. A destination with no payment history and no register entry, particularly when the
   amount is exactly right.
2. A queue line that no combination of payments explains, after grouping and summing.
3. A payment for a grant that has ended, or a second payment for a period already paid.
4. An approval screen showing a name where the address cannot be expanded.
5. An internal transfer to an external address, or to a vault under a different legal
   entity than expected.
6. A source wallet the register marks reserved, locked or allocated elsewhere.

When one appears, hold that line only. Name what needs confirming and who owns the answer.

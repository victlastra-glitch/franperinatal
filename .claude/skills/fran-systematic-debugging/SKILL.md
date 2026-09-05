---
name: fran-systematic-debugging
description: Method for investigating a defect in this repo — reproduce deterministically in the VM harness under the frozen clock, prove the root cause, then prove the fix with an adversarial mutation. Use when something is wrong: a failing test, a bad booking or refund state, a spurious email, drifting reconciliation, or a browser-only bug. Not for designing a test suite or authorizing a release.
---

# Systematic debugging

A guess that makes a symptom disappear is not a fix. In a repository that moves
money and emails patients, ship only causes you can demonstrate.

## Order of work

1. **Write down the observed behaviour and the expected behaviour** before reading
   code, including which surface saw it — browser, Worker, Apps Script, outbox,
   Calendar, Flow.
2. **Reproduce deterministically, offline.** The VM harnesses load the runtime files
   with stubbed `PropertiesService`, `SpreadsheetApp`, `CalendarApp`, Advanced
   Calendar, `LockService`, `ScriptApp`, `UrlFetchApp` and mail. They read no `.env`,
   no real booking data, and contact nothing. Anything time-dependent uses the frozen
   clock from `test/helpers/fixed-date.mjs`:

   ```
   FIXED_TEST_NOW=2026-08-25T13:00:00.000Z   # Tue 2026-08-25 09:00 America/Santiago
   ```

   A bug you can only see against the wall clock is not yet reproduced.
3. **Locate the authority.** Most defects here are a *second* implementation of a
   decision that already has a canonical owner — a cutoff recomputed, a price
   re-declared, a refund eligibility re-derived, a cadence re-read. Before patching a
   call site, ask which function owns the decision and whether this code should have
   been consuming it.
4. **State the mechanism in one sentence** — inputs, the wrong branch, the resulting
   state — and check it against the canonical doc for that domain. If you cannot
   write that sentence, keep investigating.
5. **Fix at the authority**, not at the symptom. Do not add a compensating branch
   downstream of a wrong decision.
6. **Prove it.** Add or extend a regression case, then break the fix deliberately and
   require the suite to detect it. The policy suites already work this way
   (`MUTATION_* = DETECTED`); match that standard for anything load-bearing.

## Repo-specific traps

- **Never diagnose against Production, Flow, Calendar or real email.** No live probe,
  no test charge, no trigger install. If a question seems to need one, it is a
  runbook operation needing authorization, not a debugging step.
- **A green worker run is not delivery.** Separate "ran" from "the patient received".
- **`etag`/`updated`/Meet materialization changes are not a reschedule** — see
  `fran-reconciliation-integrity` before concluding Calendar "moved" an event.
- **Duplicates are usually identity bugs**, not lock bugs: check
  `source_operation_id` and the deterministic order id before touching locking.
- **Beware green tests that assert nothing.** This repo has already withdrawn one
  false-positive gate that read a property only its own mock defined. When a test
  passes unexpectedly, verify it fails against a broken build.
- **Fail-closed paths look like bugs and are not.** A refusal on an invalid clock,
  environment or record is the contract.

## Finishing

Report the root cause, the fix, the regression that now covers it, and anything you
could not prove. Do not describe an unreproduced hypothesis as fixed. Test selection
for the change belongs to `fran-testing-contract`.

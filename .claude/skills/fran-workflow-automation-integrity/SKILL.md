---
name: fran-workflow-automation-integrity
description: Correctness of the asynchronous machinery — the notification outbox worker, Apps Script time triggers, retries, supersession, occurrence identity, at-least-once delivery and partial failure. Use when touching processLifecycleNotificationOutbox_, TriggerInstallGuard.js, the outbox sheet, or any retry/idempotency path. Not for the business rules that decide whether an event should exist.
---

# Workflow and automation integrity

Two time-triggered workers, both at **5 minutes**:
`processLifecycleNotificationOutbox_` and `processCalendarReconciliation_`.
Installed and verified only through
`backend/appsscript/booking/TriggerInstallGuard.js`.

## Execution completed ≠ business outcome confirmed

A worker returning cleanly means it ran. It does not mean the patient received
anything. Report the two separately; never let a green run stand in for delivery
evidence.

## Invariants

- **Occurrence identity is `source_operation_id`** — the source mutation. Replay of
  the same mutation is one row. The same `snapshot_start_at` reached by a different
  mutation is **not** a replay: a clinician move to B, another mutation, then back to
  B are three distinct occurrences.
- **Bounded batch.** At most 10 retryable rows (`pending` / `failed` / `claimed`) per
  invocation. Never drain-on-demand; emptying the outbox between mutations is not a
  correctness requirement.
- **Attempt ceiling.** `MAX_NOTIFICATION_ATTEMPTS = 5`, then terminal
  `reconciliation_state=notification_max_attempts`, marked in the same cycle. A
  poisoned event must not block a later logical event.
- **Supersession is explicit.** An unsent non-cancel event superseded by a newer
  mutation is marked, not silently dropped. Cancellation still sends.
- **Lock ownership is explicit.** The worker already holds the lock; nested callers
  use `lockAlreadyHeld` and must not release a lock they did not acquire.
- **Delivery is at-least-once.** The send-then-crash window is accepted and
  documented. Downstream guards, not the worker, prevent duplicate patient effects —
  e.g. `enqueuePatientCancellationNotificationOnce_` caps a booking at **one** final
  cancellation email (`FINAL_CANCELLATION_PATIENT_EMAIL_COUNT_MAX=1`).
- **Capability rotation happens per retry**, under the already-owned lock, hash-at-
  rest; the bearer is returned only to the dispatcher and the previous bearer is
  invalidated. Never log or persist a raw bearer.
- **Recipient allowlist** guards delivery. In non-production only `+nonprod`
  addresses are deliverable.
- **A retry must not duplicate an external side effect.** If a step can reach a
  provider, it needs a deterministic identity so the retry resolves the same object
  rather than creating a second one — for payments see `fran-payment-integrity`.

## Trigger cadence is proven by construction, not introspection

An installed Apps Script `Trigger` exposes **no** cadence getter. Any code that
reads back `everyMinutes` is asserting nothing — this repo already withdrew one
false-positive gate for exactly that. Cadence is proven by:

1. the installer creating triggers with `.timeBased().everyMinutes(5).create()`;
2. non-secret install metadata in
   `PRODUCTION_LIFECYCLE_TRIGGER_INSTALL_META_V1`;
3. verification matching each current `Trigger.getUniqueId()` to that metadata and
   requiring `ScriptApp.TriggerSource.CLOCK`.

Unknown cadence is never valid. Missing, stale or invalid metadata, an ID mismatch,
a non-CLOCK source, a missing trigger, duplicates, or any nonprod/fixture/test
handler must all fail closed. Never reintroduce a `.minutes` property or a
`getEveryMinutes()` fallback: those exist only in test mocks.

## Evidence

```
node backend/appsscript/booking/test/notification-outbox-worker.test.mjs
node backend/appsscript/booking/test/notification-outbox-sheet.test.mjs
node backend/appsscript/booking/test/sequential-notification-harness.test.mjs
node backend/appsscript/booking/test/no-drain-notification-harness.test.mjs
node backend/appsscript/booking/test/production-trigger-contract.test.mjs
```

Trigger tests must never create a real trigger. Installing triggers against a live
Apps Script project is a runbook operation requiring authorization.

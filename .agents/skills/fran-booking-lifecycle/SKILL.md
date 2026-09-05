---
name: fran-booking-lifecycle
description: Booking state semantics for the Apps Script engine — statuses, transitions, the 24-hour patient self-management cutoff, capability-link lifetime, slot holds and lead time. Use when changing Lifecycle.js, Code.js booking paths, manage.html behaviour, or anything that decides whether a patient may cancel or reschedule. Not for payment/refund money rules, Calendar sync, or release authorization.
---

# Booking lifecycle

Canonical tracked source of record: `docs/production/CANCELLATION_RESCHEDULE_POLICY_V2.md`.
Port scope: `docs/production/PRODUCTION_BOOKING_LIFECYCLE_V2.md`.
Read the canonical doc before editing. Do not restate its rules in code comments as a second authority.

`docs/booking/` is gitignored — local workstation notes only. Never cite it as the
authority in a commit, PR, or skill; it does not exist in a fresh clone.

## One decision function

`getBookingManagementPolicy_` in `backend/appsscript/booking/Lifecycle.js` is the
**only** place the 24-hour cutoff is derived. Consumers —
`patientCancellationRefundPolicy_`, `patientCancelFullRefundEligible_`,
`publicManagementRecord_`, both patient transactions, `_worker.js`, `manage.html` —
consume its verdict. Adding a second cutoff derivation anywhere is a defect, even
if it computes the same number today.

## Invariants

- **Remaining time is measured from `current_start_at`**, never `original_start_at`.
  After a reschedule the cutoff is recomputed against the new start.
- **The browser is never authority.** Client-supplied clock, verdict, policy or
  target fields must not change a server decision. A stale tab, a doctored page and
  a direct endpoint call must all reach the same server verdict.
- **Fail closed.** Invalid booking, unparseable schedule, or unreadable clock →
  refuse the mutation. Never default to "allowed".
- **Capability lifetime is derived, not fixed**: `current_start_at + one slot
  interval (60 min)`, ceilinged by the canonical booking horizon
  (`AVAILABILITY_HORIZON_DAYS`). `CAPABILITY_TTL_MS` survives only as a fallback for
  callers with no schedule context. `CAPABILITY_UNBOUNDED=NO`.
- **Token validity is not business authorization.** At `current_start - 23h59m` the
  bearer is still cryptographically valid and the policy still refuses reschedule
  and refund. Keep the two checks separate.
- **Reschedule target floor**: `target_start_at >= server_now + BOOKING_LEAD_MINUTES
  (120)`, enforced inside `patientRescheduleTransaction_` under the lock, using the
  same constant and comparison as `assertBookableSlot_`. Availability must withhold
  slots inside the lead time, and a withheld slot must be unbookable.
- **Cancellation does not depend on refund.** The slot is released immediately;
  `cancellation_requested` is not in `ACTIVE_SLOT_STATES`.
- **Transactions run under LockService** with a fresh reload inside the lock. A
  second concurrent attempt is rejected, not merged.

## Policy matrix (do not re-derive)

| remaining to current start | reschedule | cancel | refund |
| --- | --- | --- | --- |
| `>= 24h` | yes | yes | 100% automatic |
| `0 < r < 24h` | no | yes | none, `refund_status=not_required` |
| started / past | `RESCHEDULE_WINDOW_CLOSED` / `MANAGEMENT_WINDOW_CLOSED` | | |

`not_required` records a decision already taken. `manual_review` means a human still
has to look. Never collapse them.

## Schema

Append-only V7 compatibility: the reservation sheet keeps **57 columns**. Never
delete, reorder or rename a column; append. Legacy v7 statuses stay readable.

## Before you finish

Run, and require the mutation lines:

```
node backend/appsscript/booking/test/management-policy-24h.test.mjs
node backend/appsscript/booking/test/capability-reachability.test.mjs
node backend/appsscript/booking/test/lifecycle.test.mjs
```

Both policy suites share `test/helpers/policy-harness.mjs`. If you change policy,
change it there once — divergence between the two suites is itself the bug.

A behaviour change with no new adversarial mutation case is incomplete: the suites
prove the contract by requiring deliberately broken builds to be **detected**.

Hand off money questions to `fran-payment-integrity`, Calendar drift to
`fran-reconciliation-integrity`, delivery to `fran-workflow-automation-integrity`.

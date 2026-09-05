---
name: fran-reconciliation-integrity
description: Google Calendar reconciliation correctness — incremental sync, syncToken/410 recovery, ETag and If-Match, and the rule that a technical refresh must never be read as a business change. Use when touching Reconciliation.js, CalendarGateway.js, or the processCalendarReconciliation_ path. Not for patient-initiated transitions, payment, or notification delivery.
---

# Reconciliation integrity

Owner file: `backend/appsscript/booking/Reconciliation.js`, with the Calendar
primitives in `CalendarGateway.js`.

## The central rule

**A metadata-only refresh must never become a business event.**

`etag` change, `updated` bump, Meet link materialization, an ISO offset written a
different but equivalent way, or a system-driven re-write — none of these are
`CLINICIAN_RESCHEDULED`. Only a genuine change of the start/end interval is.
Getting this wrong emails a patient that her appointment moved when it did not, so
treat any relaxation of this check as a patient-facing defect.

Conversely a real interval change **must** still be classified, and a patient's own
move must not be re-reported as a clinician move on the following incremental pass.

## Invariants

- **Loop protection** is by ETag / content hash / operation identity. A write the
  system itself just made must not feed back as an external change.
- **`syncToken` expiry (HTTP 410)** forces a full-sync reset, not a silent skip.
  Cursor persistence **fails closed**: if `syncState.set` does not complete, the
  pass is not treated as advanced.
- **`If-Match` / ETag with 412** is the concurrency contract for updates. A 412 is a
  real conflict — reload and re-decide, never blind-retry the same body.
- **Pagination is exhaustive.** A partially consumed page must not advance the
  cursor.
- **Booking is the source of truth for money and status; Calendar is the source of
  truth for the interval.** Reconciliation may move schedule fields. It may not
  change `payment_status`, refund state, or reclassify a decided cancellation —
  see `fran-payment-integrity`.
- **Clinician cancellation economics remain `BUSINESS_POLICY_TBD`.** Do not invent
  a refund rule for it.
- Reconciliation runs on a 5-minute time trigger; its retry and duplicate-execution
  semantics belong to `fran-workflow-automation-integrity`.

## Evidence

```
node backend/appsscript/booking/test/calendar-metadata-reconciliation.test.mjs
node backend/appsscript/booking/test/lifecycle-harness.test.mjs
node backend/appsscript/booking/test/calendar-manifest-contract.test.mjs
```

The provider fakes deliberately reject `Events.update(calendarId, eventId, resource)`,
`Events.delete`, and `refund/getStatus` by POST. If a change makes those fakes pass,
the change is calling Calendar wrongly — fix the caller, not the fake.

Calendar access requires the Advanced Service in `appsscript.json`
(`userSymbol=Calendar`, `serviceId=calendar`, `version=v3`). Do not add unrelated
OAuth scopes.

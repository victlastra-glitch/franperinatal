# Production booking lifecycle V2 — selective port

This branch ports validated NONPROD lifecycle behavior onto the live
Production Apps Script **v7** Git baseline. It is not a wholesale merge of
`feat/flow-lifecycle-email-v2`.

> **Superseded in part.** This page records the original 19-row port. Patient
> cancellation economics have since moved twice on this branch and the sections
> below marked ⚠ no longer describe current behaviour:
>
> - `PATIENT_CANCEL_FULL_AUTOMATIC_REFUND` shipped in RC `bf62852`.
> - The 24-hour patient management policy replaced the "any future session"
>   condition; see `docs/production/CANCELLATION_RESCHEDULE_POLICY_V2.md`, which
>   is the document of record for cancellation, reschedule and refund.
>
> Everything not marked ⚠ still holds. Clinician cancellation economics remain
> `BUSINESS_POLICY_TBD`.

## Provenance

- Live Production project: `franciscabustos booking backend PRODUCTION`
- Live Web App version at recovery: **7**
- Git baseline: `baseline/production-v7-20260831`
- Baseline commit: see `docs/production/PRODUCTION_V7_BASELINE.md`
- Reference behavior only: `feat/flow-lifecycle-email-v2` @ `f1bf6c0`

## Ported capabilities

See `docs/production/PORT_REQUIREMENTS_19.md` for the exact 19-row matrix.
All 19 are PORT_COMPLETE.

1. Server-side Flow `payment/getStatus` is authoritative; urlReturn cannot confirm.
2. Flow status 1 pending, 2 paid, 3 rejected, 4 annulled; unknown stays verifying.
3. 15-minute slot hold from initial payment-order creation.
4. Flow `timeout` / `checkout_timeout` = remaining hold, capped at 900 seconds.
5. Retry never resets or extends the original hold; remaining time only.
6. Late PAID after expiry: preserve PAID, never reclaim the slot, never confirm, manual review, no Flow refund.
7. Exactly one confirmed booking, Calendar event, and Meet; duplicate callbacks are idempotent.
8. Patient reschedule persists before notification; payment stays PAID; same-event update; stale second reschedule rejected.
9. Clinician Calendar reconciliation.
10. Durable outbox emails: `BOOKING_CONFIRMED`, `PATIENT_RESCHEDULED`, `CLINICIAN_RESCHEDULED` via GmailApp.
11. No confirmation email before verified PAID; no failed-payment email.
12. ⚠ *(superseded)* `BUSINESS_POLICY_TBD` cancellation: release capacity, preserve paid history, zero automatic Flow refund, one internal manual-review notification, patient copy “Si corresponde un reembolso, te contactaremos.” — still the shape for out-of-policy and clinician cancellations, but a normal patient cancellation is now governed by the 24-hour policy.
13. Payment-result and manage UX for pending / paid / rejected / annulled / verifying / hold-expired.
14. Same-origin Worker privacy proxy with fail-closed `APP_ENV` + `APPS_SCRIPT_WEB_APP_URL`.

## Explicitly not enabled

- ⚠ *(superseded)* Automatic `FULL_REFUND` — now enabled for a normal patient
  cancellation at 24 hours or more before the current session start, and
  explicitly NOT enabled inside that cutoff.
- ⚠ *(superseded)* `PATIENT_CANCELLED` refund-success email on normal cancel —
  now the single final email, emitted only after the provider confirms REFUNDED.
- NONPROD sandbox, fixtures, 500 CLP test amount, or `fran-nonprod` namespace

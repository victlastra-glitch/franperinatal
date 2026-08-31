# Production booking lifecycle V2 — selective port

This branch ports validated NONPROD lifecycle behavior onto the live
Production Apps Script **v7** Git baseline. It is not a wholesale merge of
`feat/flow-lifecycle-email-v2`.

## Provenance

- Live Production project: `franciscabustos booking backend PRODUCTION`
- Live Web App version at recovery: **7**
- Git baseline: `baseline/production-v7-20260831`
- Baseline commit: see `docs/production/PRODUCTION_V7_BASELINE.md`
- Reference behavior only: `feat/flow-lifecycle-email-v2` @ `f1bf6c0`

## Ported capabilities

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
12. `BUSINESS_POLICY_TBD` cancellation: release capacity, preserve paid history, zero automatic Flow refund, one internal manual-review notification, patient copy “Si corresponde un reembolso, te contactaremos.”
13. Payment-result and manage UX for pending / paid / rejected / annulled / verifying / hold-expired.
14. Same-origin Worker privacy proxy with fail-closed `APP_ENV` + `APPS_SCRIPT_WEB_APP_URL`.

## Explicitly not enabled

- Automatic `FULL_REFUND`
- `PATIENT_CANCELLED` refund-success email on normal cancel
- NONPROD sandbox, fixtures, 500 CLP test amount, or `fran-nonprod` namespace

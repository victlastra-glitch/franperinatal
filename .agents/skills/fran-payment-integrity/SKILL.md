---
name: fran-payment-integrity
description: Flow.cl payment and refund correctness — create/confirm/refund contracts, webhook idempotency, amount and currency authority, redirect-is-not-truth, slot holds, and refund call budgets. Use when touching RefundGateway.js, the payment paths in Code.js, /api/create-flow-payment, /api/flow-confirmation, /api/payment-status, /api/refund-confirmation, pago.html or pago-resultado.html. Not for scheduling rules or Calendar sync.
---

# Payment integrity

Provider: **Flow.cl** (Chile, CLP). Production host is `www.flow.cl`; the sandbox
host is `sandbox.flow.cl`. Read the actual integration in
`backend/appsscript/booking/RefundGateway.js`, the Flow paths in `Code.js`, and the
proxies in `_worker.js`. Do not assume Stripe/MercadoPago semantics — the verbs,
signature scheme and callback shape are Flow's.

Money contract of record: `docs/production/CANCELLATION_RESCHEDULE_POLICY_V2.md`
(sections **Money**, **Why a callback cannot resurrect a refund**).

## Non-negotiable rules

1. **The server is the only financial authority.** Nothing the browser sends —
   amount, currency, status, order, verdict — may be trusted as payment truth.
2. **A return URL is not a payment.** `/pago-resultado` receiving `success` in the
   URL means the patient came back from checkout, nothing more. Confirmation comes
   from the Flow webhook at `/api/flow-confirmation` reaching the Apps Script
   upstream. Never confirm a booking, send a confirmation email, or mark
   `payment_status=paid` from the redirect. The result page may only *display*
   server-read status via `/api/payment-status`.
3. **Webhook processing is idempotent.** A duplicate Flow POST must produce zero
   additional business effects: no second booking confirmation, no second email, no
   second refund. Idempotency is enforced server-side under `LockService` plus
   persisted flags, keyed in the `fran-booking` namespace — not by request arrival
   order.
4. **Amount and currency are reconciled server-side** against the expected value
   (`consultationAmountClp_`). `INITIAL_PRICE_CLP` / `FOLLOWUP_PRICE_CLP` = 50000.
   A legacy or overridden price in a Production path is a release blocker —
   `scripts/assert-production-legacy-price-scan.mjs` exists for exactly this.
5. **Refund call budget is part of the contract**, not an implementation detail:
   - patient cancel `>= 24h`, paid → `refund/create` **exactly once**
     (`REFUND_CREATE_EFFECTIVE_MAX=1`), replay-safe.
   - patient cancel `< 24h` → `refund/create` **zero times**
     (`LT24_REFUND_CREATE_COUNT=0`); persist `refund_status=not_required` with
     `refund_last_error_code=PATIENT_CANCEL_LATE_NON_REFUNDABLE`.
   - late-paid `paid_after_hold_expiry` → system-consistency refund exactly once;
     this is **not** the patient-cancellation refund and never sends a booking
     confirmation.
6. **A callback cannot resurrect a refund.** The persisted `refund_status` is what
   authorizes `beginRefundForPaidCancellation_`. No replay, provider callback or
   reconciliation pass may reclassify a decided non-refundable cancellation as
   refundable.
7. **Ambiguous provider outcome → `manual_review`, never a retry that could create a
   second order.** A create that times out with an unknown result must not be
   re-created; the internal order id is deterministic so a retry resolves the same
   order.
8. **Secrets never leave the server.** `FLOW_API_KEY` / `FLOW_SECRET_KEY` live in
   Script Properties. They must not appear in the repo, in logs, in Worker
   responses, or in any error string. The Worker forwards Flow's raw webhook body
   upstream and returns only Flow-expected text.
9. **`/api/payment-status` returns a no-PII allowlist.** Never forward
   `publicStatusToken`, the Flow token, contact details or clinical fields.

## Test safety — fail closed

Never execute a real payment or refund write for a development task.
`PAYMENT_TEST_TARGET_VERIFIED_NONPROD=YES` must be established from repository
configuration **before** running anything capable of a provider write. If it cannot
be proven, stop.

The offline contract suite is the default and uses mocked network:

```
node backend/appsscript/booking/test/flow-contract.test.mjs
node backend/appsscript/booking/test/pre-transaction-contract.test.mjs
node backend/appsscript/booking/test/lifecycle.test.mjs
node scripts/test-production-payment-status-privacy.mjs
node scripts/assert-production-legacy-price-scan.mjs
```

Provider E2E is a runbook operation, not a coding step, and is split on purpose:
`FLOW_PROVIDER_MICRO_E2E` may use a provider-minimum amount and proves **nothing**
about application pricing; `BOOKING_APPLICATION_E2E` must run at 50000 with no
Production test-price override. See `docs/production/PRODUCTION_RC_RUNBOOK.md`.
Executing either needs explicit human authorization — see `fran-release-quality-gate`.

Report money-touching work with the counters the repo already uses:
`PRODUCTION_PAYMENT_CREATE_CALLS`, `PRODUCTION_REFUND_CREATE_CALLS`,
`REAL_MONETARY_FLOW_CALLS`. Zero is the expected value for a code change.

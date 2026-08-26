# Remaining lifecycle E2E readiness — Cursor → Codex handoff

Machine-readable handoff after NONPROD lifecycle source closure, including the
Flow Sandbox minimum-amount surgical correction.

SOURCE / TESTS / DOCS only. No runtime activation in this Cursor pass.

## Identity

Codex must independently read the actual Git HEAD during preflight.
Do not require this document to contain the SHA of the commit that contains it.

```
AUDIT_START_HEAD=f80e05a253620de61802e2a3f35a5b524e1aeb2b
SOURCE_CLOSURE_HEAD=9332b2b1adacf6cdefaa875d64d0c45a4fcb8ba8
HANDOFF_BASE_HEAD=d9b62b677c99167b65ad12b825dc095a99ef1011
BRANCH=feat/nonprod-booking-lifecycle-20260823
PRODUCTION_FINGERPRINT_BASELINE=5699a590f8ec9175129130fc5124b6c1af3ed99ffb8235b22979d338efa0fdb1
SCHEMA_HEADERS=57
SCHEMA_DELTA=none
NONPROD_FLOW_TEST_AMOUNT_CLP=500
```

## FLOW_ROOT_CAUSE_CLASSIFICATION

```
PREVIOUS_FLOW_CREATE_FAILURE_ROOT_CAUSE=MULTIPLE_PROVIDER_CONTRACT_VIOLATIONS_IDENTIFIED
```

Confirmed source issues include:

1. NONPROD amount `1` CLP was below the official Flow Chile FAQ minimum
   ("The amount to pay must be greater than 350 CLP.").
2. `commerceOrder` was previously 52 chars and was shortened defensively to 44
   (`npo-<40 hex>`).

```
COMMERCE_ORDER_FIX_CLASSIFICATION=DEFENSIVE_PROVIDER_COMPATIBILITY_FIX
```

The public Flow OpenAPI reference does not document a 45-character
`commerceOrder` maximum. The shortening remains a defensive compatibility fix
unless stronger primary provider evidence appears in-repo.

Do not claim the earlier runtime failure was caused solely by commerceOrder length.

## FLOW_CREATE

PASS (source contract closed for amount + create shape).

Canonical synthetic amount:

```
NONPROD_FLOW_TEST_AMOUNT_CLP=500
```

- `payment/create` sends `amount=500` / `currency=CLP`
- public `payment_status` returns `amount=500`
- refund synthetic amount derives from `nonprodRefundAmountClp_()` → `'500'`
- production clinical prices (`65000` / `60000`) are untouched
- Flow production host remains impossible under NONPROD config

## FLOW_FAILURE_RECOVERY

PASS (source).

On create failure:

- `payment_status=failed`
- `booking_status=manual_review`
- `schedule_status=cancelled` (explicit capacity release; not an active hold)
- `reconciliation_state=flow_create_<safe_class>`
- same idempotency key cannot create a second Flow order
- new legitimate retry = **new idempotency key**
- `abandonFailedNonprodCheckout_(reservationId)` is operator-safe and non-deleting
- no public delete route

### Failed CLP 1 row from prior runtime attempt

Codex must:

1. Prove any retained failed/manual-review row does **not** block availability.
2. Use `abandonFailedNonprodCheckout_` only if that synthetic failed row is
   unambiguously identifiable.
3. Never manually delete Sheet rows.

## RUNTIME_ONLY_GATES

Live NONPROD only. Production = ABSOLUTE NO-TOUCH.

1. Force-sync current Apps Script source to dedicated NONPROD.
2. Prove remote parity with branch tip.
3. Fresh free slot (new idempotency UUID).
4. Flow Sandbox create at **500 CLP**.
5. Payment URL on `sandbox.flow.cl` + public status token.
6. Continue one long lifecycle E2E:
   confirm → Calendar/Meet → outbox email → reschedule ×1 → clinician move →
   cancel → refund independence → cleanup/abandon of any prior failed CLP 1 row
   if unambiguously identifiable.
7. Production fingerprint baseline still matches
   `5699a590f8ec9175129130fc5124b6c1af3ed99ffb8235b22979d338efa0fdb1`.

## OTHER DOMAINS (unchanged local PASS / RUNTIME_ONLY)

- CALENDAR_MEET
- EMAIL_OUTBOX
- PATIENT_RESCHEDULE
- CLINICIAN_RECONCILIATION
- PATIENT_CANCEL
- REFUND (policy still `BUSINESS_POLICY_TBD`)
- CAPABILITY_SECURITY
- CLEANUP

## P0 / P1 / P2 / P3

```
P0=none
P1=none
P2=none material remaining in source
P3=none material remaining in source
```

## READY_FOR_SINGLE_PASS_RUNTIME_E2E

```
READY_FOR_SINGLE_PASS_RUNTIME_E2E=YES
```

Conditional on Codex executing the RUNTIME_ONLY_GATES above against Apps Script
NONPROD + Preview, without Production touch.

# Remaining lifecycle E2E readiness — Cursor → Codex handoff

Machine-readable handoff after the one-pass NONPROD lifecycle closure pass.
SOURCE / TESTS / DOCS only. No runtime activation in this pass.

## Identity

```
START_HEAD=f80e05a253620de61802e2a3f35a5b524e1aeb2b
END_HEAD=9332b2b1adacf6cdefaa875d64d0c45a4fcb8ba8
BRANCH=feat/nonprod-booking-lifecycle-20260823
PRODUCTION_FINGERPRINT_BASELINE=5699a590f8ec9175129130fc5124b6c1af3ed99ffb8235b22979d338efa0fdb1
SCHEMA_HEADERS=57
SCHEMA_DELTA=none
```

## FILES_CHANGED

- backend/appsscript/booking/Code.js
- backend/appsscript/booking/Lifecycle.js
- backend/appsscript/booking/RefundGateway.js
- backend/appsscript/booking/test/flow-contract.test.mjs (new)
- backend/appsscript/booking/test/lifecycle-harness.test.mjs (new)
- backend/appsscript/booking/test/phase-a.test.mjs
- backend/appsscript/booking/test/pre-transaction-contract.test.mjs
- backend/appsscript/booking/test/preview-host-validation.test.mjs
- assets/booking.js
- _worker.js
- docs/booking/remaining-lifecycle-e2e-readiness.md (this file)
- docs/booking/testing-contract.md

## TESTS

Local no-network suites executed in this pass:

- syntax (`node --check` on touched JS)
- Phase A
- lifecycle adversarial + provider contracts
- pre-transaction
- Flow contract (new)
- preview host validation
- notification/outbox worker
- lifecycle harness (new)
- manage contract
- Worker routes / structure / payment-status privacy
- public artifact / NONPROD boundary
- `git diff --check`

## FLOW_CREATE

PASS (source contract closed).

Root cause closed in source:

1. `commerceOrder` previously used `makeOpaqueId_('order')` → **52 chars**, above the practical Flow Sandbox limit of **45** used by Flow client integrations.
2. New `makeFlowCommerceOrder_` emits `npo-<40 hex>` (**44 chars**), deterministic from the idempotency key.
3. Request params are stringified; form body keys sorted; HMAC remains sorted `key+value` SHA-256 hex.
4. `optional` payload removed from create (no reservation id in Flow optional).
5. `amount` sent as `'1'` string with `currency=CLP`.
6. Frontend now sends modality **value** (`online|presencial`), not label; Worker + Apps Script validate the same.

Public patient response remains `FLOW_CREATE_FAILED`.

## FLOW_FAILURE_RECOVERY

PASS (source).

On create failure:

- `payment_status=failed`
- `booking_status=manual_review`
- `schedule_status=cancelled` (explicit capacity release; not an active hold)
- `reconciliation_state=flow_create_<safe_class>`
- bounded provider code may be stored as `refund_last_error_code=flow_<code>` without secrets/raw payload
- same idempotency key cannot create a second Flow order (`FLOW_CREATE_FAILED` replay)
- new legitimate retry = **new idempotency key**
- `abandonFailedNonprodCheckout_(reservationId)` operator helper marks terminal abandoned state without deletion, Flow, Calendar, or email
- no public delete route

Safe diagnostic classes (NOT public patient payload):

- `FLOW_PROVIDER_REJECTED` (HTTP 4xx)
- `FLOW_PROVIDER_UNAVAILABLE` (HTTP 5xx)
- `FLOW_NETWORK`
- `FLOW_BAD_RESPONSE`
- `FLOW_RESPONSE_SHAPE`
- `FLOW_ORDER_INVALID`

## CALENDAR_MEET

PASS local / RUNTIME_ONLY for live Meet persistence.

Already wired: `requestMeet=true`, `conferenceDataVersion=1`, opaque extendedProperties, same-event update preserves Meet, duplicate confirmation uses `findLinkedEvent`, create failure → `calendar_create_retry`.

## EMAIL_OUTBOX

PASS local / RUNTIME_ONLY for real MailApp + installed trigger execution.

Worker, allowlist, CTA matrix, max attempts=5, rotation, no raw bearer persistence remain in place.

## PATIENT_RESCHEDULE

PASS local / RUNTIME_ONLY for live E2E.

Count 0→1, same event, Meet/payment preserved, CANCEL remains, second attempt rejected.

## CLINICIAN_RECONCILIATION

PASS local / RUNTIME_ONLY for live sync token + Calendar edits.

Installed handler `processCalendarReconciliation_` → `reconcileCalendarSync_`; pagination/cursor/410/ETag loop protection covered by existing suites.

## PATIENT_CANCEL

PASS local / RUNTIME_ONLY for live cancel path.

Idempotent cancel, capacity release independent of refund, stale capability rejected.

## REFUND

PASS local / RUNTIME_ONLY for Flow Sandbox refund + callback.

Business policy remains `BUSINESS_POLICY_TBD` (no invented 24/48h window).
Refund callback URL validator now accepts branch Preview origins (`label.project.pages.dev`), matching payment confirmation config.

## CAPABILITY_SECURITY

PASS local.

Opaque tokens, HMAC-at-rest, expiry, revocation, type separation, rotation; raw bearer not persisted in Sheet/logs/safe worker results.

## CLEANUP

PASS source contract.

Failed Flow create no longer leaves an active hold. Operator abandon helper is NONPROD-guarded and non-deleting. External 10:00 synthetic Calendar busy fixture is out of scope.

## RUNTIME_ONLY_GATES

Codex must prove next (live NONPROD only; Production no-touch):

1. **FLOW_SANDBOX_PAYMENT_CREATE** with a fresh free slot + new idempotency UUID → payment URL on `sandbox.flow.cl` + public status token.
2. Safe diagnostic row after any failure still contains no secrets/raw provider body.
3. Paid confirmation → exactly one Calendar event + Meet fields persisted.
4. Outbox email to allowlisted `+nonprod` mailbox with Meet + Reagendar + Cancelar.
5. Patient reschedule once; second rejected; Meet preserved.
6. Clinician move via reconciliation trigger; patient count unchanged.
7. Cancel releases capacity; refund path remains independent.
8. Abandoned/failed checkout rows do not block availability.
9. Production fingerprint baseline still matches `5699a590f8ec9175129130fc5124b6c1af3ed99ffb8235b22979d338efa0fdb1`.

## KNOWN_LIMITATIONS

- Refund eligibility policy is intentionally `BUSINESS_POLICY_TBD`.
- Meet conference creation still depends on live Advanced Calendar authorization.
- Trigger installers already exist; this pass did not execute them.
- Failed checkout rows are retained for audit until operator abandon; no Sheet row deletion API.

## Findings closed this pass

| Severity | Finding | Fix |
|---|---|---|
| P1 | Flow create collapsed; commerceOrder 52 chars | `makeFlowCommerceOrder_` ≤45 + contract tests |
| P1 | No safe Flow failure diagnostics | classified persist + public `FLOW_CREATE_FAILED` unchanged |
| P2 | Failed create left schedule `hold` | explicit `schedule_status=cancelled` |
| P2 | No operator cleanup without unsafe Sheet edit | `abandonFailedNonprodCheckout_` |
| P2 | Refund callback rejected branch Preview hosts | shared Preview host matcher |
| P3 | Browser sent modality label not value | `assets/booking.js` + Worker/backend validation |
| P3 | `safeCode_` rejected digits in codes | allow `A-Z0-9_` |

## P0 / P1 / P2 / P3

```
P0=none
P1=none (Flow create source root cause closed; runtime re-proof required)
P2=none material remaining in source
P3=none material remaining in source
```

## READY_FOR_SINGLE_PASS_RUNTIME_E2E

```
READY_FOR_SINGLE_PASS_RUNTIME_E2E=YES
```

Conditional on Codex executing the RUNTIME_ONLY_GATES above against Apps Script NONPROD + Preview, without Production touch.

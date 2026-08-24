# NONPROD Apps Script property-entry gate

## Purpose

This is the owner-controlled UI procedure required because the authorized
command-line tooling has no safe Script Properties write command. It does not
use the retired Apps Script Execution API and does not require a Google Cloud
project.

Apply it only in the standalone NONPROD Apps Script project identified by the
private local project fingerprint. Do not open Candidate A or any production
project.

## Owner UI checklist

1. Sign in as the approved institutional owner and open the existing standalone
   NONPROD project. Confirm the project fingerprint through the private change
   record before editing.
2. Open **Project Settings → Script properties**. Do not use User properties.
3. Enter the values below from approved private sources; do not paste them into
   chat, source files, Git, screenshots, terminal output, or issue trackers.
4. Save once, then verify only property *names* and the public/safe constants
   listed below. Do not read values back into logs.
5. Review the Web App sharing setting in **Deploy → Manage deployments**. It
   must allow the intended Sandbox callback and Preview traffic while executing
   only as the NONPROD owner. If organizational policy prevents that scope,
   stop and record the policy result; do not broaden production access.

| Property | Required NONPROD value rule |
| --- | --- |
| `APP_ENV` | exactly `nonprod` |
| `FLOW_API_KEY` | approved Flow SANDBOX Keychain value |
| `FLOW_SECRET_KEY` | approved Flow SANDBOX Keychain value |
| `FLOW_BASE_URL` | exactly `https://sandbox.flow.cl/api` |
| `BOOKING_STORE_ID` | approved private NONPROD datastore identifier |
| `CALENDAR_ID` | approved private NONPROD Calendar identifier |
| `IDEMPOTENCY_NAMESPACE` | exactly `fran-nonprod-20260821` |
| `STATUS_TOKEN_SECRET` | new unique NONPROD-only random value |
| `INTERNAL_NOTIFICATION_EMAIL` | approved test-only mailbox |
| `PATIENT_EMAIL_RECIPIENT_ALLOWLIST` | that same approved test-only mailbox only |
| `FLOW_RETURN_URL` | defer until a Preview URL is known; then Preview route only |
| `FLOW_CONFIRMATION_URL` | defer until a Preview URL is known; then Preview route only |
| `CAPABILITY_TOKEN_SECRET` | lazy-scoped, unique NONPROD-only strong secret; required only for RESCHEDULE/CANCEL issue or verify |
| `FLOW_REFUND_CALLBACK_URL` | lazy-scoped Preview route only; required only for refund callback |

The deployed derivative must continue to return `CONFIGURATION_INCOMPLETE`
without side effects until every required property is present and valid. Do not
execute a booking, payment, Calendar, or email test at this gate.

The base configuration intentionally does not require `CAPABILITY_TOKEN_SECRET`
or `FLOW_REFUND_CALLBACK_URL`. Their absence must not break availability,
payment create, payment confirmation or payment status. Capability operations
fail closed with `CAPABILITY_SECRET_INVALID`; refund operations fail closed with
their own refund-configuration code.

## Pre-UI lifecycle contract

The NONPROD derivative is deliberately fail-closed and uses the following
state model: `booking_started` → `payment_pending` →
`payment_confirmed`/`payment_rejected`/`payment_failed`; only a confirmed
payment can later be cancelled. Backward transitions are rejected.

- The browser creates one opaque namespace-prefixed idempotency key per submit
  attempt and retains it only for network retry. It is not derived from PII.
- A repeated key returns the original Sandbox checkout handoff and cannot
  create a second datastore row or Flow order.
- A Flow confirmation accepts only a bounded callback token, then queries
  signed `payment/getStatus` on `sandbox.flow.cl`; callback content alone is
  never accepted as proof of payment.
- Calendar and test-email effects are claimed before execution and marked
  afterward under the Apps Script lock. A failure may omit an effect, but a
  retry cannot duplicate it.
- Status polling reads an opaque, expiring status-token hash only and returns
  a defined public allowlist. It never writes state or returns booking/contact
  data.

The `reservations_nonprod` schema is an exact, named-header contract. A
guarded, idempotent bootstrap function exists but was not executed. It may run
only after complete NONPROD properties are present and only against the
fingerprinted NONPROD store.

## Evidence to return

Return only: project fingerprint match, property-name set match, Web App access
result, and whether external availability is an HTTP fail-closed response. Do
not return values, URLs, identifiers, recipient addresses, credentials, or
screenshots containing them.

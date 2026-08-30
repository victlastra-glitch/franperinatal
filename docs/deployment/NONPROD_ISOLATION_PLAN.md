# NONPROD booking and payment isolation plan

## Goal

Create a future test stack that can reproduce the booking lifecycle without a
single shared production payment credential, datastore, calendar, notification
recipient, reservation namespace, webhook destination, or patient record.
This document designs the stack only. It creates no external resource.

## Required architecture

```text
Cloudflare Pages Preview
  -> Preview-only Worker routes
  -> NONPROD Google Apps Script Web App deployment
  -> Flow SANDBOX
  -> NONPROD booking datastore
  -> NONPROD Calendar
  -> NONPROD allowlisted test mailboxes
```

Production and NONPROD may share reviewed source code, but no runtime state or
credential.

## Required resources

| Layer | Required isolated resource | Separation requirement |
| --- | --- | --- |
| Cloudflare Pages | Preview environment configuration | Must not inherit production upstream settings |
| Cloudflare Worker | Preview routes for availability, booking start, Flow confirmation, and payment status | Browser must never know an Apps Script URL |
| Google Apps Script | Separate NONPROD project and Web App deployment, preferably under a dedicated test identity | Different deployment URL and Script Properties from Production |
| Payment | Flow SANDBOX merchant/configuration | Separate keys, base URL, return URL and confirmation URL |
| Datastore | Separate Google Sheet or governed test datastore | No production spreadsheet ID, tab, records, or reservation counter |
| Calendar | Separate NONPROD calendar | No shared calendar ID or events |
| Email | Separate allowlisted internal/test recipients | No patient or production internal notifications |
| Webhook endpoint | Preview-only confirmation route | No shared Flow confirmation destination |

## Variable names and secret locations

Values are intentionally omitted.

### Cloudflare Pages / Worker

| Name | Type/location | Preview rule |
| --- | --- | --- |
| `APP_ENV` | Plain variable | Set to `nonprod`; never rely on branch-name inference |
| `APPS_SCRIPT_WEB_APP_URL` | Pages Preview secret | Points only to NONPROD Apps Script deployment; absent from browser bundles |
| `BOOKING_API_BASE_URL` | Public/plain variable if needed by client | Use relative `/api`; never an Apps Script URL |
| `FLOW_CONFIRMATION_ROUTE` | Plain variable if needed | Preview-only worker route |
| `SENTRY_ENVIRONMENT` | Plain variable if present | `nonprod`, with PII disabled |

### NONPROD Apps Script Script Properties

| Name | Purpose |
| --- | --- |
| `APP_ENV` | Hard guard: must equal `nonprod` |
| `FLOW_API_KEY` | Flow SANDBOX credential |
| `FLOW_SECRET_KEY` | Flow SANDBOX signing credential |
| `FLOW_BASE_URL` | Flow SANDBOX endpoint |
| `FLOW_RETURN_URL` | Preview result URL only |
| `FLOW_CONFIRMATION_URL` | Preview worker confirmation URL only |
| `BOOKING_STORE_ID` | NONPROD datastore identifier |
| `CALENDAR_ID` | NONPROD calendar identifier |
| `INTERNAL_NOTIFICATION_EMAIL` | Dedicated test mailbox only |
| `PATIENT_EMAIL_RECIPIENT_ALLOWLIST` | Test-only recipient allowlist |
| `IDEMPOTENCY_NAMESPACE` | NONPROD-only reservation/idempotency prefix |
| `STATUS_TOKEN_SECRET` | Non-production status-token signing/validation secret |

Store Flow and token values only in Apps Script Script Properties (or an
approved secret manager feeding them), not source control, browser JavaScript,
Pages plain variables, screenshots, logs, or documentation. Store the Apps
Script deployment URL only as a Pages environment secret for each environment.

## Cloudflare Preview bindings: exact policy

1. Remove any project-level or inherited Preview value that resolves to the
   production Apps Script endpoint.
2. Add `APPS_SCRIPT_WEB_APP_URL` as a Preview-only secret whose value is the
   NONPROD deployment URL.
3. Set `APP_ENV=nonprod` explicitly in Preview.
4. Keep Production's `APPS_SCRIPT_WEB_APP_URL` only in Production secrets.
5. Refactor `assets/booking.js` so availability and booking start call relative
   worker routes, not an embedded `WEBAPP_URL`.
6. Worker must reject a request unless `APP_ENV` is the expected environment;
   Apps Script must independently reject a mismatch.

## Apps Script deployment approach

1. Create a dedicated NONPROD Apps Script project from the reviewed canonical
   source only after its provenance is identified.
2. Configure the listed NONPROD Script Properties through a controlled owner
   session; never commit them.
3. Deploy a distinct Web App version under the NONPROD identity. Record only
   redacted URL fingerprint, project/deployment IDs, version, and timestamp in
   a private change record.
4. Enforce an `APP_ENV` guard before every data write, Calendar call, email,
   Flow call, or webhook acceptance.
5. Use separate permission grants for the NONPROD datastore/calendar/mail.

## Flow SANDBOX requirements

- Use a sandbox merchant and sandbox-only credentials.
- Configure return and confirmation URLs to Preview, not Production.
- Confirm Flow signature validation uses the sandbox secret in NONPROD only.
- Test happy and rejected paths only with approved provider sandbox fixtures.
- Do not use any production merchant key, order number sequence, or webhook.

## Test-data and idempotency policy

- Use synthetic data created solely for test use; no real name, email, phone,
  RUT, clinical text, pregnancy/reproductive information, or patient record.
- Test mail must go only to allowlisted test mailboxes.
- Prefix all reservation/order/idempotency identifiers with the isolated
  `IDEMPOTENCY_NAMESPACE` and reject identifiers outside it.
- Exercise duplicate booking-start, duplicate webhook, repeated payment-status,
  and concurrent confirmation attempts. Assert exactly one NONPROD reservation,
  one calendar event, one patient-test message, and one internal-test message.
- Capture only redacted request IDs, response statuses, and non-PII state
  transitions in QA evidence.

## Rollback and cleanup

1. Disable or delete the Preview deployment and remove its Preview secret.
2. Revoke or rotate NONPROD Flow sandbox credentials if exposed.
3. Delete only NONPROD test reservations/events/messages using the namespace.
4. Remove NONPROD Script Properties and deployment access as required.
5. Preserve a redacted audit log of test IDs and cleanup confirmation.

No rollback action may affect the production Pages project, Apps Script
deployment, Flow merchant, datastore, calendar, or mail recipients.

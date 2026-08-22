# NONPROD implementation package

## Status and authority

This package extends [the isolation plan](NONPROD_ISOLATION_PLAN.md). It is an
implementation specification, not authorization to create resources, deploy,
or set a value. All placeholders below are intentional.

`NONPROD_READINESS = BLOCKED` until every creation and verification gate below
is approved and evidenced.

## Target architecture

```text
Browser Preview
  -> relative /api/availability and /api/create-flow-payment only
  -> Cloudflare Pages Preview Worker, APP_ENV=nonprod
  -> secret APPS_SCRIPT_WEB_APP_URL (NONPROD deployment only)
  -> NONPROD Apps Script, APP_ENV=nonprod
  -> Flow SANDBOX + separate booking store + separate Calendar
  -> allowlisted test recipients only
```

The browser must never receive an Apps Script URL. Production and NONPROD may
share reviewed code but never a credential, deployment, datastore, Calendar,
recipient, webhook, order/idempotency namespace, or reservation record.

## Resource manifest and naming convention

Use `<slug>-nonprod-20260821` exactly; replace `<slug>` only through a recorded
human decision. Names and IDs must be recorded in a private change record, not
this repository.

| Layer | Required resource | Required name/prefix | Gate |
| --- | --- | --- | --- |
| Cloudflare Pages | Preview configuration | existing `franciscabustos` Preview only | human config gate |
| Worker | Preview-only API behavior | `APP_ENV=nonprod` | code-review gate |
| Apps Script | Separate project and Web App deployment | `fran-booking-nonprod-20260821` | owner creation gate |
| Datastore | Separate Sheet/store and tabs | `fran-booking-nonprod-20260821-*` | data isolation gate |
| Calendar | Existing isolated secondary calendar | `Francisca Sandbox Test` | calendar metadata gate |
| Flow | Sandbox merchant/configuration | `NONPROD` namespace only | payment-owner gate |
| Email | Test mailbox allowlist | `*@example.test` or approved controlled domain | privacy gate |

## Cloudflare Preview variables and secrets

| Name | Preview type | Required value rule | Production rule |
| --- | --- | --- | --- |
| `APP_ENV` | Plain variable | exactly `nonprod` | exactly `production`; never inferred from branch |
| `APPS_SCRIPT_WEB_APP_URL` | Preview secret | distinct NONPROD deployment only | production secret remains isolated |
| `BOOKING_API_BASE_URL` | Plain variable, if retained | relative `/api` only | no Apps Script URL |
| `FLOW_CONFIRMATION_ROUTE` | Plain variable, if retained | Preview Worker path only | environment-specific route |
| `SENTRY_ENVIRONMENT` | Plain variable, if used | `nonprod`, PII disabled | production policy separately governed |

Required Cloudflare guards:

1. Worker returns fail-closed `503` when the upstream secret is absent.
2. Every booking/payment route rejects any `APP_ENV` other than its intended
   environment.
3. Preview must prove a non-PII sentinel/failure response if pointed at any
   production endpoint.
4. The Pages dashboard/API owner must verify that Preview does not inherit a
   project-level production upstream. CLI secret-name metadata alone is not
   sufficient evidence.

## NONPROD Apps Script properties

Set only through the owner-controlled Script Properties UI or approved secret
manager. Do not put values in source, Git, logs, commands, or screenshots.

| Property | NONPROD rule |
| --- | --- |
| `APP_ENV` | exactly `nonprod`; required before every side effect |
| `FLOW_API_KEY`, `FLOW_SECRET_KEY`, `FLOW_BASE_URL` | Flow SANDBOX only |
| `FLOW_RETURN_URL`, `FLOW_CONFIRMATION_URL` | Preview URLs only |
| `BOOKING_STORE_ID` | separate NONPROD store only |
| `CALENDAR_ID` | separate NONPROD calendar only |
| `INTERNAL_NOTIFICATION_EMAIL` | dedicated test mailbox only |
| `PATIENT_EMAIL_RECIPIENT_ALLOWLIST` | test-only allowlist; fail closed otherwise |
| `IDEMPOTENCY_NAMESPACE` | `fran-nonprod-20260821` or approved immutable equivalent |
| `STATUS_TOKEN_SECRET` | unique NONPROD-only secret |

Before every write, Calendar call, email, Flow request, or webhook acceptance,
Apps Script must assert `APP_ENV === 'nonprod'`, validate the namespace, and
reject non-allowlisted recipients.

## Flow SANDBOX and state isolation

- Use a separate sandbox merchant, keys, base URL, return URL, and confirmation
  URL. Never reuse production order sequences or webhooks.
- Use one datastore with a distinct ID and tab namespace; it must contain only
  synthetic records.
- Use only the existing `Francisca Sandbox Test` secondary calendar and assert
  its configured calendar ID before event creation/cancellation.
- Use only synthetic names/contact details and no clinical information,
  production payment data, or identity numbers.
- Prefix reservation ID, commerce order, status token, and idempotency key with
  the immutable NONPROD namespace. Reject an input outside that namespace.

## Browser and Worker refactor contract

1. Remove the executable Apps Script URL from `assets/booking.js`.
2. Change availability to `GET /api/availability` and booking start to
   `POST /api/create-flow-payment` using same-origin relative requests.
3. Worker owns both new routes plus flow confirmation and payment status.
4. Worker forwards only validated, minimal fields to Apps Script and never
   returns PII, credentials, raw provider payloads, or upstream URLs.
5. The existing management page is out of scope until separately audited; it
   must not preserve a direct production upstream in Preview.

## E2E matrix

| Case | Expected evidence | Side-effect assertion |
| --- | --- | --- |
| Missing/incorrect `APP_ENV` | fail-closed response | no upstream request |
| Availability | synthetic slots only | no production URL contacted |
| Booking start | sandbox order in NONPROD namespace | one store record only |
| Duplicate booking start | deterministic idempotent result | no second record/event/message |
| Valid sandbox confirmation | confirmed state | exactly one record, event, patient-test and internal-test mail |
| Duplicate/concurrent confirmation | idempotent result | no duplicate side effects |
| Invalid signature/status | rejection | no state change |
| Payment status repeat | allowlisted non-PII response | no state change |
| Cancellation/reschedule | allowed synthetic transition | scoped event/mail updates only |
| Preview sentinel test | production target rejected/unreachable | no production side effect |

Capture only redacted request IDs, HTTP statuses, route names, and state labels.

## Creation order — human-gated

1. Approve this package, naming decision, and test-mail ownership.
2. Create Flow SANDBOX configuration and record private fingerprints.
3. Discover and verify the pre-provisioned Shared Drive datastore and the
   `Francisca Sandbox Test` Calendar through an authorized Workspace surface;
   record private IDs and redacted fingerprints.
4. Create a reviewed redacted derivative of the canonical source in the
   existing NONPROD Apps Script project.
5. Set NONPROD Script Properties through the approved owner session.
6. Create a distinct Apps Script Web App deployment and record its private
   fingerprint.
7. Implement and review browser-relative routes, Worker guards, and source
   sanitization.
8. Set Cloudflare Preview variables/secrets only after code review.
9. Deploy Preview and run the verification order below.

`GCP_BOOTSTRAP_REQUIREMENT = NOT_REQUIRED` for datastore and Calendar
provisioning through Workspace. Do not create or attach a Google Cloud project
solely to satisfy the retired bootstrap path.

## Verification order — no production mutation

1. Confirm branch, review approval, and no production configuration change.
2. Verify Cloudflare Preview metadata and secret *names*, then private endpoint
   fingerprint equality to the NONPROD deployment.
3. Verify Apps Script `APP_ENV`, store, Calendar, allowlist, and namespace by
   private metadata only.
4. Run no-side-effect guard and sentinel tests.
5. Run availability and booking-start tests with synthetic data.
6. Run Flow SANDBOX confirmation, duplicate, invalid-signature, and status
   tests.
7. Reconcile store, Calendar, and test-mail counts for each test ID.
8. Run browser desktop/mobile, console/network, redirect, canonical, robots,
   sitemap, and privacy QA.
9. Produce redacted evidence and obtain a separate production-release decision.

## Rollback and cleanup

1. Disable/remove only the Preview deployment and its Preview secret.
2. Revoke/rotate only exposed NONPROD sandbox credentials.
3. Delete only namespace-prefixed NONPROD reservations, events, and test mail.
4. Remove NONPROD deployment access and Script Properties as approved.
5. Preserve a redacted cleanup record.

No rollback or cleanup action may alter production Pages, Apps Script, Flow,
datastore, Calendar, or recipients.

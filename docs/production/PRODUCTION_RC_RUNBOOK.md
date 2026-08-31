# Production release candidate runbook

**DO NOT EXECUTE THIS RUNBOOK IN THIS REVIEW.** It is the next approval
step after the draft PR is reviewed.

## Identifiers

| Item | Value |
|---|---|
| Release candidate branch | `feat/production-booking-lifecycle-v2-port` |
| Apps Script runtime | modular files under `backend/appsscript/booking/` (`Code.js` + siblings) |
| Rollback Apps Script | live Production **version 7** (`docs/production/v7/Código.js`) |
| Git rollback branch | `baseline/production-v7-20260831` |
| Public site rollback | current live Cloudflare Production artifact (unchanged by this PR) |
| Canonical refund policy | `BUSINESS_POLICY_TBD` |
| Prices | `INITIAL_PRICE_CLP=50000`, `FOLLOWUP_PRICE_CLP=50000` |
| Hold | 15 minutes; Flow timeout/checkout_timeout ≤ 900; retry does not extend hold |

Fill the RC commit SHA at deploy time from `git rev-parse HEAD` on the
integration branch after review.

## A. PRE-DEPLOY

1. Confirm the draft PR is approved and **not** merged to `main` unless that
   is a separate explicit authorization.
2. Diff Apps Script against `baseline/production-v7-20260831` and confirm only
   lifecycle V2 files are clasp-bound (`Code.js` and siblings). Never clasp
   `docs/production/v7/Código.js` together with `Code.js`.
3. Diff `_worker.js`, `assets/booking.js`, `pago-resultado.html`, `manage.html`.
4. Confirm **binding/property names exist** (do not print values):

   Apps Script Script Properties (names only):
   - `APP_ENV` must equal `production`
   - `FLOW_API_KEY`, `FLOW_SECRET_KEY`, `FLOW_BASE_URL`
   - `FLOW_RETURN_URL`, `FLOW_CONFIRMATION_URL`
   - `CALENDAR_ID`
   - `INTERNAL_NOTIFICATION_EMAIL`
   - `IDEMPOTENCY_NAMESPACE` must equal `fran-booking`
   - `STATUS_TOKEN_SECRET`
   - `BOOKING_STORE_ID` or alias `SHEET_ID`
   - `CAPABILITY_TOKEN_SECRET` (lazy; required before manage/reschedule/cancel)
   - `FLOW_REFUND_CALLBACK_URL` (required only if a provider-confirmed refund
     path is later enabled; normal cancel does not call Flow refund)

   Cloudflare Pages Production environment (names only):
   - `APP_ENV` must equal `production`
   - `APPS_SCRIPT_WEB_APP_URL` must be present, https, host `script.google.com`
   - no hardcoded fallback in `_worker.js`

5. Missing binding/property must fail closed (`CONFIGURATION_INCOMPLETE` or
   Worker 503). Do not invent defaults.
6. Re-run local gates: contamination firewall, secret scan, legacy price scan,
   production-derived integration tests. `NEW_GITHUB_ACTIONS` must remain 0.
7. Authorization required before any Production mutation.

## B. DEPLOY ORDER

Safest order:

1. **Apps Script first** (new version from the modular bundle). Keep the live
   Web App pointed at version 7 until the new version is verified in the
   script editor. Then update the **existing** Web App deployment to the new
   version. Do not create a second public Web App URL.
2. **Cloudflare Pages Worker/web second**, only if `_worker.js` / booking UI
   must change with the backend. Use the existing Pages project. Do not
   create new CI.

If only Apps Script is required for a given SHA, skip the Pages deploy.

Rollback:

1. Point the Production Web App deployment back to Apps Script **version 7**.
2. If Pages was updated, restore the previous Production Pages deployment.
3. Do not “fix forward” by mutating Script Properties or Flow keys.

## C. POST-DEPLOY NO-CHARGE SMOKE

Do **not** create a booking, Calendar event, Sheet row, or Flow charge.

- Site availability: `/`, `/reserva`, `/pago-resultado`, `/manage`
- Worker fail-closed: `/api/payment-status` without `st` returns 4xx, not 200
  with PII
- `/api/payment-status` response allowlist only: `ok`, `status`, `amount`,
  `currency`, `serviceType`, `modality`, `backendVersion`, `retryAvailable`,
  `holdValid`
- No `script.google.com` URL in HTML or `assets/booking.js`
- Console/network: no secret material, no patient fields on status endpoints

## D. FLOW PRODUCTION MICRO-E2E PLAN — DO NOT RUN NOW

Use this only after no-charge smoke and explicit authorization.

Provider documentation checked 2026-08-31 (Flow help):
minimum accepted amount is **higher than 350 CLP**. Re-verify
https://web.flow.cl/en-cl/ayuda/ at execution time. Use that current minimum,
not 50,000 CLP, for the micro-E2E.

Constraints:

- Controlled internal test email only; no patient data
- Ideally **two** minimum-value payments first
- If Flow merchant balance is still insufficient for `refund/create` after
  two payments, decide whether a **third** minimum payment is justified
  before any additional charge
- No automatic refund of a real patient booking

Sequence (authorized operator only):

1. Create payment 1 at the current Flow minimum; complete checkout.
2. `payment/getStatus` must return status **2 (PAID)**.
3. Create payment 2 at the same minimum; complete checkout; `getStatus` = 2.
4. While sufficient Flow balance remains, `refund/create` on payment 1.
5. Confirm provider acceptance workflow, refund callback, `refund/getStatus`.
6. Replay the refund callback; must be idempotent.
7. Accounting cleanup of the two (or three) test charges.
8. If provider returns 501 / insufficient funds, treat as external provider
   status, not an application defect. Do not retry against patient bookings.

This RC already contains refund **code** against `https://www.flow.cl/api`.
Normal cancellation still does **not** call it (`BUSINESS_POLICY_TBD`).

## E. FINAL RELEASE CRITERIA

`READY_FOR_PRODUCTION_SMOKE_TEST=YES` when this draft PR exists, tests pass,
and no Production mutation has occurred.

`READY_FOR_PRODUCTION_RELEASE=YES` only when **all** of the following are true:

- Human review of this draft PR is complete
- Pre-deploy binding/property **name** checks pass
- Authorized deploy of Apps Script (and Pages if required) succeeded
- No-charge smoke passed
- Flow Production micro-E2E passed **or** was explicitly waived with a
  recorded provider-funds blocker
- Rollback to v7 was restated and remains executable

Until then: `READY_FOR_PRODUCTION_RELEASE=NO`.

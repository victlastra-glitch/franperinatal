# Backend routing map — 2026-08-21

## Scope and safety boundary

This is a read-only trace of the recovery preview. No booking, payment, webhook,
calendar, email, or Apps Script mutation was performed. Upstream URLs and all
credential values are intentionally omitted.

## Provenance update

The direct booking Web App URL is now verified against the production-served
asset: it maps exactly to Candidate A, deployed version 6. This establishes
direct booking backend provenance only. The Worker obtains its upstream from
`env.APPS_SCRIPT_WEB_APP_URL`; that runtime secret remains **LIKELY** correlated
until an authorized name/fingerprint-only environment check is available.

## Routing chain

| Browser entrypoint | Cloudflare route | Worker / client code | Variable or baked value | Upstream type | Downstream operation | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `reserva.html` | Static asset `/assets/booking.js` | Client-side `fetchBookedSlots()` | Baked `WEBAPP_URL` in `assets/booking.js` | Google Apps Script Web App | `GET` of booking availability | VERIFIED — `assets/booking.js:34,61-74` |
| Reservation submit | None: browser posts directly | `assets/booking.js` | Same baked `WEBAPP_URL` | Google Apps Script Web App | `POST action=create_flow_payment`; source payload includes booking/contact fields | VERIFIED — `assets/booking.js:513-527`; **not executed** |
| Flow confirmation | `/api/flow-confirmation` | `_worker.js` handler | `APPS_SCRIPT_WEB_APP_URL` | Google Apps Script Web App | Proxies `POST` as `action=flow_confirmation`; Apps Script is expected to make the confirmation/idempotency decision | VERIFIED — `_worker.js:32-79` |
| Flow return | `POST /pago-resultado` | `_worker.js` handler | No upstream on this hop | 303 redirect to static result page | Moves `st` to a GET query string | VERIFIED — `_worker.js:152-187` |
| Payment-result status | `/api/payment-status?st=…` | `_worker.js` handler | `APPS_SCRIPT_WEB_APP_URL` | Google Apps Script Web App | Proxies `GET action=payment_status`; worker returns only a defined no-PII allowlist | VERIFIED — `_worker.js:79-150` |
| `pago.html` | Static | HTML CTA | None | None until user enters reservation UI | Navigation only | VERIFIED |
| `/backend` and `/backend/*` | `_worker.js` | Explicit deny | None | None | `404 not_found` | VERIFIED — `_worker.js:191-195` |
| Analytics | Static `assets/analytics.js` and result-page script | Browser analytics calls | Analytics configuration, not an Apps Script binding | Analytics providers | CTA/purchase event emission | VERIFIED from static source; runtime payload was not inspected |

`_redirects` contains canonical and legacy redirects only. It does not route an
`/api/*` request to a backend; the worker owns the API paths above.

## Why the preview reaches an upstream

### Direct reservation path

**Cause: 1 — upstream URL hard-coded/baked into client code (VERIFIED).**

`assets/booking.js` embeds a Google Apps Script Web App URL and calls it during
page load for availability. A reservation submission would post directly to that
same upstream. This bypasses Cloudflare Pages bindings altogether. For that
reason `/reserva` was deliberately not opened during browser QA: merely loading
it would make a live upstream request.

### Worker proxy paths

**Cause: 2 — plaintext Pages environment variable inherited or shared with
preview (INFERRED, high confidence).**

Evidence collected before this document:

1. `_worker.js` has no hard-coded fallback: it returns `503` when
   `APPS_SCRIPT_WEB_APP_URL` is absent.
2. A non-PII synthetic request to preview `/api/payment-status` returned `200`,
   proving that preview resolved an upstream through that variable.
3. Wrangler listed no Preview **secret** entries, while Production listed the
   variable name as a secret.

The available Wrangler read-only interface cannot disclose whether the preview
value is a project-level plain variable, a Preview-environment variable, or an
inherited configuration entry. Therefore the precise Cloudflare configuration
scope remains **UNKNOWN**; it must be checked in Pages dashboard/API metadata by
an account holder. The conclusion is not based on a guessed URL or a secret
value.

## Binding and isolation conclusion

There is no worker-service binding referenced by `_worker.js`; the relevant
runtime bindings are `ASSETS` and `APPS_SCRIPT_WEB_APP_URL`. The latter is
therefore sufficient to reach an active upstream from preview. Separately, the
baked browser URL creates an independent production-coupling path.

**Current status: NOT ISOLATED.** Preview must not be used for booking, payment,
or webhook QA until both paths are replaced or separately configured. Verified
direct provenance does not authorize use of that production backend from
Preview.

## Required verification to close this finding

1. Inspect Pages environment metadata, by environment, for the variable name
   `APPS_SCRIPT_WEB_APP_URL` only; do not reveal its value.
2. Remove the baked Apps Script URL from browser code and proxy the availability
   and booking-start actions through a worker route.
3. Bind Preview only to a distinct NONPROD Apps Script deployment.
4. Prove with a non-PII failing/sentinel response that Preview cannot reach the
   production deployment before any mutation-capable test.

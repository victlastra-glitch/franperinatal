---
name: fran-worker-api-contract
description: The Cloudflare Pages Worker as same-origin API boundary — route allowlist, upstream binding, no-PII response allowlists, and offline route/privacy verification. Use when adding or changing an /api/* route, editing _worker.js, or auditing what the browser can reach. Not for the business logic behind a route, which lives in Apps Script.
---

# Worker / API contract

`_worker.js` is a **same-origin proxy**, not a place for business logic. It routes
the browser to the private Apps Script upstream and shapes what comes back. Every
decision that matters must already have been made server-side upstream.

## Allowlisted routes — this is the whole surface

```
/api/availability            /api/create-flow-payment
/api/retry-flow-payment      /api/payment-status
/api/flow-confirmation       /api/refund-confirmation
/api/manage                  /api/manage-availability
/api/manage-cancel           /api/manage-reschedule
/api/leadmagnet              /pago-resultado (POST → 303 GET)
```

`/backend` and `/backend/*` are blocked, and the published artifact excludes
`backend/`. Adding a route means adding it to the allowlist **and** to
`scripts/test-production-worker-routes.mjs`; an unlisted route is a defect, not a
feature.

## Invariants

- **Upstream comes from `env.APPS_SCRIPT_WEB_APP_URL`.** Never hardcode an Apps
  Script `/exec` URL or a fallback default in the repo —
  `scripts/assert-production-contamination-firewall.mjs` rejects it.
- **Production is gated on `env.APP_ENV === 'production'`.** Do not weaken that check.
- **Flow checkout redirects are host-validated**: `https:` + `www.flow.cl` only.
  A checkout URL from upstream that fails validation is rejected, not followed.
- **Responses use a defensive no-PII allowlist.** Never forward
  `publicStatusToken`, a Flow token, a raw capability bearer, contact details, or
  clinical fields to the browser. Add a field to a response only by adding it to the
  allowlist deliberately, and extend the privacy test in the same change.
- **The webhook proxy is transparent**: forward Flow's
  `application/x-www-form-urlencoded` body upstream and return the plain text Flow
  expects. Do not interpret payment outcome in the Worker.
- **`/manage` carries no client-side policy arithmetic.** The server verdict is
  projected as-is: `MANAGE_SERVER_POLICY_AUTHORITY=PASS`,
  `MANAGE_CLIENT_SIDE_CUTOFF_ARITHMETIC=NONE`.
- **Log nothing sensitive.** Existing handlers log a bare tag such as
  `[create-flow-payment] upstream unavailable` — keep that shape.

## Verification (offline, no network)

```
node scripts/assert-production-worker-structure.mjs _worker.js
node scripts/test-production-worker-routes.mjs
node scripts/test-production-payment-status-privacy.mjs
node scripts/test-manage-contract.mjs
node backend/appsscript/booking/test/preview-host-validation.test.mjs
```

These run without a deployed Worker. Do not reach for `wrangler dev`, a Preview URL,
or a live curl to answer a question these already answer. Probing a real endpoint
is a Preview/runbook activity, and any probe that could create a booking or a
payment is forbidden without explicit authorization.

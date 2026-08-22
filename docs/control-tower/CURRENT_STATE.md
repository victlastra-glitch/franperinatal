# Current engineering state — 2026-08-21

## Verified environment

- Repository: `franperinatal`; branch: `recovery/production-source-20260821`.
- Origin: `github.com/victlastra-glitch/franperinatal.git`.
- Cloudflare Pages project: `franciscabustos`, Direct Upload; production remains protected.
- Authorized read-only Apps Script identity: `hola@franciscabustos.cl`.

## Production backend provenance

The direct booking asset served by production and the executable recovery
assignment resolve to the same concrete Apps Script deployment. That deployment
is under **Candidate A** and is deployed from version **6**.

`PRODUCTION_BACKEND_MATCH = VERIFIED` for the direct booking path. The matching
version was exported read-only to a temporary directory and inspected. It is not
in this repository and must not be committed without a separate security review.

The Worker is intentionally separate: `_worker.js` reads
`env.APPS_SCRIPT_WEB_APP_URL`; its runtime value was not read. Worker-to-active
backend correlation is therefore **LIKELY**, not VERIFIED.

## Current routing

```text
Browser booking asset (currently direct Apps Script URL)
  -> active Apps Script version 6 (direct availability and booking start)

Cloudflare Worker /api/flow-confirmation and /api/payment-status
  -> env.APPS_SCRIPT_WEB_APP_URL (runtime value not disclosed)
```

Preview is **NOT ISOLATED**. The direct browser route and the Worker binding
must both be replaced with a dedicated NONPROD path before booking, payment,
Calendar, email, or webhook QA.

## Current mission

Prepare and review the NONPROD implementation package only. No external
resource may be created until the designated human gate is approved.

## Open blockers

1. Preview scope of `APPS_SCRIPT_WEB_APP_URL` cannot be proven with the
   available read-only CLI metadata.
2. The browser still carries a direct Apps Script URL; it must be refactored to
   relative `/api` routes in a reviewed NONPROD change.
3. Dedicated Flow SANDBOX, datastore, Calendar, test-mail allowlist, and Apps
   Script project/deployment do not exist yet.
4. The exported source has configuration and PII-handling surfaces that require
   sanitization before any source is copied into Git.

## Hard prohibitions

- Do not operate on `main` or `/Users/vic/Documents/Claude`.
- Do not push/deploy Apps Script, create versions, alter Script Properties, or
  execute booking, payment, Calendar, email, or Flow actions.
- Do not change Cloudflare bindings, variables, secrets, deployments, domains,
  or production configuration.
- Do not create NONPROD resources before the explicit creation gate.
- Do not commit Apps Script source, credentials, recipient data, reservations,
  payment data, or exported runtime configuration.

## Stop conditions

Stop with one of: `HUMAN_GATE_REQUIRED`, `BLOCKED_BY_MISSING_CREDENTIAL`,
`PRODUCTION_MUTATION_REQUIRED`, or `DECISION_REQUIRED` before any operation
that can mutate an external resource. Complete the current documentation-only
mission with `MISSION_COMPLETE`.

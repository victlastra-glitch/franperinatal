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

Execute the approved NONPROD isolation plan. Production remains no-touch and
every external operation must prove its NONPROD scope before it runs.

## NONPROD provisioning checkpoint

- Flow SANDBOX credentials were retrieved only from Keychain and passed a
  signed, read-only validation against `sandbox.flow.cl`; no payment or order
  was created.
- A standalone NONPROD Apps Script project was created under the approved
  institutional identity. Redacted project fingerprint: `53d963e98306`.
- A temporary `MYSELF`-only API-executable deployment was created solely to
  provision isolated Google resources, then removed after its fingerprint was
  matched to the NONPROD project. Redacted deployment fingerprint:
  `01869b5b4dc8`.
- The NONPROD datastore and the `Francisca Sandbox Test` Calendar were
  provisioned directly in Workspace. Their actual IDs remain private and have
  not yet been independently read by this session.
- No NONPROD Web App deployment, email configuration, Cloudflare Preview
  configuration, or browser/Worker refactor exists yet.

`GCP_BOOTSTRAP_REQUIREMENT = NOT_REQUIRED` for this Workspace provisioning
path. This is not a claim that GCP will never be needed for a separate feature.

## Open blockers

1. Preview scope of `APPS_SCRIPT_WEB_APP_URL` cannot be proven with the
   available read-only CLI metadata.
2. The browser still carries a direct Apps Script URL; it must be refactored to
   relative `/api` routes in a reviewed NONPROD change.
3. The actual datastore and Calendar IDs/metadata must be read through an
   authorized Workspace surface and verified before Script Properties can be
   set; this session cannot access the Shared Drive or Calendar metadata.
4. Dedicated NONPROD Web App, test-mail allowlist, and Cloudflare Preview
   configuration do not exist yet.
5. The exported source has configuration and PII-handling surfaces that require
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

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
Recovery branch browser booking asset (same-origin only)
  -> /api/availability and /api/create-flow-payment
  -> Worker Preview binding (not yet configured)
  -> dedicated NONPROD Apps Script Web App

Cloudflare Worker /api/flow-confirmation and /api/payment-status
  -> env.APPS_SCRIPT_WEB_APP_URL (runtime value not disclosed)
```

Production remains unchanged. Preview is **NOT ISOLATED** until its binding is
proven Preview-only, but the recovery source no longer embeds an executable
Apps Script URL.

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
  provisioned directly in Workspace. Approved private identifiers were stored
  only in ignored local state (mode 600) and match fingerprints
  `390f55363168` and `6c0535f4450c`, respectively.
- A sanitized derivative was pushed only to the standalone NONPROD Apps Script
  project. It reads environment values only from Script Properties, validates
  NONPROD fingerprints/namespace/Flow host before external effects, and has no
  production identifiers, recipient literals, or source export in Git.
- A distinct NONPROD Web App deployment was created. Its redacted fingerprint
  is `d9722d8abf60`. Its anonymous HTTP accessibility is **not verified**:
  an unauthenticated availability request returned 403 before Apps Script code
  executed, so its fail-closed runtime response was not observable.
- `assets/booking.js` now calls same-origin `/api/availability` and
  `/api/create-flow-payment`. `_worker.js` owns those routes plus confirmation
  and status, rejects `APP_ENV !== nonprod`, validates bounded input, and does
  not expose an Apps Script upstream.
- No Script Properties, email configuration, Cloudflare Preview configuration,
  Preview deployment, or transactional E2E has been performed.

`GCP_BOOTSTRAP_REQUIREMENT = NOT_REQUIRED` for this Workspace provisioning
path. This is not a claim that GCP will never be needed for a separate feature.

## Open blockers

1. The currently authorized tooling has no Script Properties write operation;
   completing the private owner-controlled UI checklist is required before the
   backend can run. The retired Execution API/GCP bootstrap is prohibited.
2. The Web App returned 403 to an unauthenticated no-side-effect check. Its
   sharing/access setting requires owner review in the Apps Script UI before
   Flow callbacks or external Preview traffic can be tested.
3. Preview scope of `APPS_SCRIPT_WEB_APP_URL` cannot be proven with the
   available CLI metadata. Do not change project-wide or Production settings.
4. Confirmation/status remain deliberately disabled in the derivative pending
   a reviewed signature/state-transition implementation and isolated E2E.

## Hard prohibitions

- Do not operate on `main` or `/Users/vic/Documents/Claude`.
- Do not modify Candidate A, its version 6, or any production Script Property.
- Do not use the retired Execution API/GCP bootstrap to set NONPROD properties.
- Do not change Cloudflare bindings, variables, secrets, deployments, domains,
  or production configuration.
- Do not commit Apps Script source, credentials, recipient data, reservations,
  payment data, or exported runtime configuration.

## Stop conditions

Stop with one of: `HUMAN_GATE_REQUIRED`, `BLOCKED_BY_MISSING_CREDENTIAL`,
`PRODUCTION_MUTATION_REQUIRED`, or `DECISION_REQUIRED` before an unscoped or
production-affecting external operation. The next gate is private Apps Script
UI configuration, followed by proof that Cloudflare configuration is Preview
only.

# Apps Script source reconciliation — 2026-08-21

## Result

**Active Apps Script project identified: NO.**

**Active Apps Script deployment identified: NO.**

**Canonical backend source identified: NO.**

The local environment has neither `clasp` nor `gcloud`, no local clasp project
metadata, and no authenticated Google tooling configuration available for a
safe read-only enumeration. Local Google Apps Script filenames and comments are
evidence candidates only; none establishes the live project, deployment, or
version that the current Web App URL resolves to.

No Apps Script source was exported and no candidate was copied into
`backend/apps-script/`.

## Local tooling and metadata inventory

| Check | Result |
| --- | --- |
| `clasp` executable/version | Not installed or not available on `PATH` |
| `gcloud` executable/version | Not installed or not available on `PATH` |
| `clasp.json` / `.clasp.json` in the Francisca project scope | Not found |
| Local script/deployment ID metadata | Not found |
| Auth configuration inspected | Presence/absence only; no token files were read or printed |

## Structural comparison of historical candidates

Counts below are code-structure indicators (function names and terms related to
Flow, Calendar, email, and idempotency). They are not proof of deployed source.

| Candidate | Structural observation | Classification | Basis |
| --- | --- | --- | --- |
| `AppsScript_active.gs` | Largest active-style candidate; Flow, Calendar and idempotency handlers present | UNKNOWN | No live project/deployment readback |
| `AppsScript_active_FLOW_PRODUCTION.gs` | Same active-style structural profile as above | UNKNOWN | Filename is not production proof |
| `AppsScript_PRODUCTION_v5_BASELINE_20260612.gs` | Earlier production-labelled profile; fewer Calendar/idempotency references | UNKNOWN | Historical baseline only |
| `AppsScript_PRODUCTION_v5_ONLINE_ONLY_CANDIDATE.gs` | Near-baseline profile with online-only wording | UNKNOWN | Candidate only; service policy requires human decision |
| `AppsScript_active_FLOW_SANDBOX.gs` | Explicit sandbox-era Flow candidate | SANDBOX | Explicit sandbox marker; excluded from production recovery |
| `AppsScript_flow_v04_PATCH.gs` | Narrow Flow patch with fewer endpoint handlers | PARTIAL_ANCESTOR | Partial integration surface only |
| `booking_v04_PATCH.js` | Narrow client booking/Flow patch | PARTIAL_ANCESTOR | Not a standalone Apps Script deployment source |
| `AppsScript_LEGACY_BEFORE_FLOW.gs` and backup copies | Pre-Flow / backup implementation | LEGACY | Explicit historical role |
| `leadmagnet` Apps Script candidate | Lead-magnet functions rather than reservation lifecycle | UNRELATED | Different business function |
| `DEPLOY_v19.bat` and sandbox deployment artefacts | Deployment helper/test artefacts | SANDBOX | Sandbox marker and not executable source of truth |

No candidate is classified `MATCHES_ACTIVE`, because matching requires a
read-only export of the active project/version plus a deployment URL/version
correlation.

## Safe procedure to identify the active source

1. Use an owner-authorized, read-only Google Apps Script identity.
2. Enumerate only Francisca candidate projects and their web-app deployments.
3. Match the deployment URL fingerprint to the two current routing paths
   (the values must remain redacted in records).
4. Record project ID, deployment ID, version number, and modification timestamp
   in a private access log; do not commit credential data.
5. Export the matching source to a temporary non-production directory.
6. Scan it for secrets and PII; compare structural fingerprints.
7. Only then prepare a sanitized canonical source under `backend/apps-script/`
   for review. Do not commit it until its provenance is confirmed.

## Security constraints retained

The following were deliberately neither read nor exported: Script Properties,
Flow keys/secrets, OAuth/auth tokens, patient data, reservations, test cards,
test RUTs, or private recipient data.

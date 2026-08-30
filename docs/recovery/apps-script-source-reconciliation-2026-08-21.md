# Apps Script source reconciliation — 2026-08-21

## Result

**Active Apps Script project identified: YES — Candidate A.**

**Active Apps Script deployment identified: YES — version 6.**

**Canonical backend source identified: YES for the direct booking route.**

The executable assignment in the recovery booking asset was compared with the
production-served booking asset, ignoring illustrative comments. The values
matched exactly and the matching deployment was found under Candidate A at
version 6. The source was cloned read-only to a temporary directory and was not
copied into `backend/apps-script/` or committed.

`PRODUCTION_BACKEND_MATCH = VERIFIED` for direct booking. The Worker uses a
separate runtime secret, so Worker-to-active-backend correlation is **LIKELY**
until an authorized metadata/fingerprint check can verify it without exposing a
value.

## Local tooling and metadata inventory

| Check | Result |
| --- | --- |
| `clasp` executable/version | Available; authorized read-only identity verified |
| `gcloud` executable/version | Not installed or not available on `PATH` |
| `clasp.json` / `.clasp.json` in the Francisca project scope | Not found |
| Local script/deployment ID metadata | Not required; deployment list queried read-only |
| Auth configuration inspected | Identity command only; no token files were read or printed |

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

Candidate A is classified `MATCHES_ACTIVE` for the direct booking route: exact
production-asset deployment match plus read-only export of version 6. All other
historical labels remain structural evidence only and are not deployment proof.

## Safe procedure to identify the active source

1. Preserve the redacted provenance record and source sanitization report.
2. Verify the separate Worker runtime binding by metadata/fingerprint only.
3. Create no source copy until a NONPROD source-import review is approved.
4. Use the NONPROD implementation package before executing any booking flow.

## Security constraints retained

The following were deliberately neither read nor exported: Script Properties,
Flow keys/secrets, OAuth/auth tokens, patient data, reservations, test cards,
test RUTs, or private recipient data.

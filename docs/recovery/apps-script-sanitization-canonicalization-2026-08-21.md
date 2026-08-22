# Apps Script sanitization and canonicalization — 2026-08-21

## Provenance result

The executable `WEBAPP_URL` from the recovery asset was compared with the
production-served booking asset. The values matched exactly. The matching
deployment belongs to **Candidate A**, version **6**.

`PRODUCTION_BACKEND_MATCH = VERIFIED` for the direct booking route.

The matched version was cloned read-only to a temporary directory outside this
repository. The export is canonical deployment evidence, not an approved Git
source import.

## Sanitized inventory

| Exported file | Disposition |
| --- | --- |
| `Código.js` | Review-only; do not copy into Git yet. |
| `appsscript.json` | Review-only; do not copy into Git yet. |

No Script Properties, runtime configuration, reservations, Sheets, Calendar
records, payment records, or mailboxes were exported.

## Sanitization findings

| Surface | Result | Required treatment before any Git import |
| --- | --- | --- |
| Hard-coded credential/auth literal scan | No credential or authorization literal detected | Re-run scan on the proposed sanitized copy. |
| Script Properties access | Present | Retain property *names* only when necessary; never export values, screenshots, or logs. |
| URL literals | Present | Remove or replace private endpoints with named placeholders. |
| Personal-data field handling | Present | Keep schemas abstract; never commit example reservations or clinical/contact data. |
| Literal email-like values | Present | Remove or replace all recipients with clearly non-deliverable placeholders. |
| RUT/card literal patterns | Not detected in the exported source scan | Keep the scan as a release gate; absence in this snapshot is not permission to add test data. |

## Structural canonicalization result

The exported version contains a web-app action surface for availability,
booking/payment initiation, payment confirmation and status, reservation
persistence, Calendar operations, lifecycle email, cancellation, rescheduling,
and reminders. It has Flow configuration/signing helpers and structural
idempotency/order lookup controls.

This is structurally consistent with the previously documented active-style
historical candidates and supersedes filename-based inference. It does not
prove runtime configuration, Flow signature correctness, transactional
atomicity, or external side effects; none were executed.

## Git boundary

Do not add `Código.js`, `appsscript.json`, clasp metadata, Script Properties,
Flow values, recipients, test identities, or a Web App URL to this repository.
A future NONPROD implementation may begin from a reviewed, redacted derivative
only after human approval and a separate source-import review.

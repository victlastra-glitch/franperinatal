# Francisca Bustos — Psicología Perinatal

Shared operating contract for every coding agent on this repository (Claude Code,
Codex, and any other). It is the single authority. `CLAUDE.md` adds no rules of its
own.

## Alcance

Fuente de código del sitio franciscabustos.cl y de su motor de reservas. Trabajar
únicamente en este proyecto. `main` es la línea base protegida de producción y todo
cambio va por rama, preview y PR.

## What this system actually is

Static hand-authored HTML (14 root pages + 12 posts in `blog/`, plus `guia/` and `recursos/`) with vanilla ES modules
and CSS in `assets/`; a Cloudflare Pages Worker (`_worker.js`) as the same-origin
`/api/*` boundary; a Google Apps Script booking engine in
`backend/appsscript/booking/` (7 modular files) over Google Sheets, Google Calendar
and Meet; payments and refunds through **Flow.cl**; asynchronous work in a
notification outbox and a Calendar reconciliation pass, both on 5-minute triggers.

There is **no** `package.json`, lockfile, `node_modules`, bundler, TypeScript,
React, or build step, and **no CI** — GitHub Actions hosted minutes are unavailable
and `NEW_GITHUB_ACTIONS=0` is a standing constraint. Tests are plain
`node <file>.test.mjs`. Do not introduce a package manager, dependency, framework or
build; do not treat "it builds" as evidence.

## Sources of truth — one per domain, all tracked in Git

| Domain | Canonical file |
| --- | --- |
| Cancellation / reschedule / refund policy, and the gate list | `docs/production/CANCELLATION_RESCHEDULE_POLICY_V2.md` |
| Booking lifecycle port scope | `docs/production/PRODUCTION_BOOKING_LIFECYCLE_V2.md` |
| Release, deploy order, rollback | `docs/production/PRODUCTION_RC_RUNBOOK.md` |
| Production baseline / provenance | `docs/production/PRODUCTION_V7_FULL_BASELINE.md`, `docs/production/PRODUCTION_V7_BASELINE.md` |
| Port requirements | `docs/production/PORT_REQUIREMENTS_19.md` |
| Backend provenance | `backend/README.md` |
| Runtime policy decision | `getBookingManagementPolicy_` in `backend/appsscript/booking/Lifecycle.js` |
| Agent/skill system itself | `docs/engineering/agent-system.md` |

`docs/booking/`, `docs/control-tower/`, `docs/deployment/` and `docs/recovery/` are
**gitignored**: local workstation notes that do not exist in a fresh clone. Read them
if present, never cite them as authority in code, a commit, a PR or a skill.

## Repository invariants

1. The server is the only authority. The browser never decides policy, price,
   payment truth or eligibility, and a client-supplied verdict is ignored.
2. A payment redirect is not a payment. Only the Flow webhook confirms.
3. Every decision has exactly one derivation. A second implementation of the same
   rule is a defect even when it agrees today.
4. Fail closed. An unverifiable record, clock, environment or identity refuses the
   operation.
5. Never commit secrets, `.clasp.json`, a script id, a deployment id, or a concrete
   `/macros/s/<id>/exec` URL. Never log patient data or a raw capability bearer.
6. Non-production artefacts never enter a Production runtime file.
7. The reservation schema is append-only; 57 columns, never reordered or renamed.
8. No deploy, clasp push, trigger install, `wrangler` publish, provider E2E,
   real charge, real refund, real email or Production write without explicit human
   authorization **for that specific action**. Approval of one step never carries to
   the next.
9. No push, PR open/merge, or work committed onto an unrelated in-flight branch
   (PR #2 is the Production lifecycle RC) unless asked.
10. Mantener el tono clínico, ético y no alarmista en todo contenido público.

## Skills — one owner per concern

Project skills are in `.claude/skills/<name>/SKILL.md` (Claude Code) and
`.agents/skills/<name>/SKILL.md` (Codex and any other agent). The two trees are
byte-identical and `scripts/assert-agent-skills-parity.mjs` enforces it.

**How to load one.** Claude Code discovers `.claude/skills/` automatically. Codex
does **not** auto-discover skills: it loads this file and nothing else, so when a
row below matches your task, open `.agents/skills/<name>/SKILL.md` and read it
before editing. Treat that read as mandatory, not optional context. The tables in
this file are the router; the skill body is the contract.

| Concern | Primary owner |
| --- | --- |
| Booking states, 24 h cutoff, capability lifetime, lead time | `fran-booking-lifecycle` |
| Flow payments, refunds, webhook idempotency, amount authority | `fran-payment-integrity` |
| Calendar sync, metadata-only vs genuine move | `fran-reconciliation-integrity` |
| Outbox, triggers, retries, duplicate execution, supersession | `fran-workflow-automation-integrity` |
| Worker routes, `/api/*` contract, no-PII response allowlists | `fran-worker-api-contract` |
| HTML / vanilla JS / CSS implementation, forms, a11y, perf | `fran-frontend-web` |
| PII, secrets, least privilege, prod/nonprod separation | `fran-security-privacy` |
| Public perinatal copy, disclaimers, credentials, crisis routing | `fran-content-claims` |
| Defect investigation and root-cause proof | `fran-systematic-debugging` |
| Test selection, writing tests, browser verification | `fran-testing-contract` |
| Candidate identity, gates, release state, deploy readiness | `fran-release-quality-gate` |

If two skills appear to own the same decision, that is a bug in this table — fix the
boundary, do not add a third skill.

## Task routing

Load the skill **and** read the canonical document in the same row before editing.

| Task | Load | Read first |
| --- | --- | --- |
| Add or edit a page / section / styling | `fran-frontend-web` (+ `fran-content-claims` if the copy is clinical) | the page itself |
| Change a form | `fran-frontend-web` + `fran-testing-contract`; add `fran-booking-lifecycle` if it is the booking form | `CANCELLATION_RESCHEDULE_POLICY_V2.md` if booking |
| Cancellation, reschedule, cutoff, management link | `fran-booking-lifecycle` | `CANCELLATION_RESCHEDULE_POLICY_V2.md` |
| Payment, refund, checkout return, webhook | `fran-payment-integrity` (+ `fran-worker-api-contract` for the route) | `CANCELLATION_RESCHEDULE_POLICY_V2.md` (Money) |
| Reconciliation or Calendar drift | `fran-reconciliation-integrity` | `PRODUCTION_BOOKING_LIFECYCLE_V2.md` |
| Outbox, retries, emails not arriving, triggers | `fran-workflow-automation-integrity` | `PRODUCTION_RC_RUNBOOK.md` (triggers) |
| Transactional email wording | `fran-content-claims` + `fran-workflow-automation-integrity` | `CANCELLATION_RESCHEDULE_POLICY_V2.md` (approved copy) |
| Add or change an `/api/*` route | `fran-worker-api-contract` + `fran-security-privacy` | `_worker.js` route allowlist |
| Anything is broken | `fran-systematic-debugging` first, then the owning domain skill | the owning domain's document |
| Decide what to run / add a regression test | `fran-testing-contract` | `CANCELLATION_RESCHEDULE_POLICY_V2.md` (Running the gates) |
| Handling patient data, secrets, logs, scopes | `fran-security-privacy` | `privacidad.html`, `appsscript.json` |
| Public health claim, blog, service or FAQ copy | `fran-content-claims` | the sibling page that already carries the disclaimer |
| "Is this done?", PR, preview, deploy readiness | `fran-release-quality-gate` | `PRODUCTION_RC_RUNBOOK.md` |
| Agent instructions or skills | `fran-release-quality-gate` | `docs/engineering/agent-system.md` |
| Docs-only change | none; still run the secret scan and `git diff --check` | the doc's own domain owner |

## Testing

Risk-based, never all-or-nothing: run the rows your diff touches, per the table in
`fran-testing-contract`, and quote the counters the suites print. Every change runs
`node scripts/assert-production-secret-scan.mjs` and `git diff --check`. A bug fix
carries a regression test unless you state why it cannot. Load-bearing contracts
require an adversarial mutation that the suite must detect. Anything a user can see
requires browser verification, or an explicit
`BROWSER_VERIFICATION=BLOCKED_BY_ENVIRONMENT`.

Changing `AGENTS.md`, `CLAUDE.md`, `.claude/skills/**` or `.agents/skills/**` also
requires:

```
node scripts/assert-agent-skills-parity.mjs
```

## Release gate

Report the highest state you can evidence and name what is missing for the next:
`IMPLEMENTED` → `TESTED` → `PREVIEW_VERIFIED` → `RELEASE_READY` → `DEPLOYED`. Always
with the exact HEAD SHA. Never collapse them. `fran-release-quality-gate` owns this.

## Documentation requirement

A change that alters a rule updates that rule's canonical file in the same change.
Do not restate a rule in a second place — link to the owner instead.

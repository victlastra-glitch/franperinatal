---
name: fran-testing-contract
description: Which tests a change must run and how to write one here — plain node .test.mjs files with no package manager, the shared VM harness, the frozen clock, and the adversarial-mutation standard. Use when selecting validation for a change, adding a regression test, or judging whether a change is sufficiently proven. Not for release authorization or deployment.
---

# Testing contract

Tracked source of record for the gate list: the **Running the gates** section of
`docs/production/CANCELLATION_RESCHEDULE_POLICY_V2.md`.
(`docs/booking/testing-contract.md` is richer but **gitignored** — local notes only,
never cite it as authority.)

## How tests run here

Plain Node, no runner, no dependencies, no `package.json`:

```
node backend/appsscript/booking/test/<name>.test.mjs
```

Each file is an ES module using `node:assert/strict`, loading the Apps Script
sources into a `node:vm` context with stubbed Google services. There is **nothing to
install**; never add a dependency, a runner, or an `npm test` script. Validation is
**local only** — GitHub Actions hosted minutes are unavailable and
`NEW_GITHUB_ACTIONS=0` is a standing constraint.

Time-dependent tests inject `createFixedDate()` from `test/helpers/fixed-date.mjs`
(`FIXED_TEST_NOW=2026-08-25T13:00:00.000Z`). Never write a test that depends on the
workstation clock or that needs dates bumped each week. The two policy suites share
`test/helpers/policy-harness.mjs` — extend the shared harness rather than forking it.

## Risk-based selection — run what your change can break

| Change touches | Run |
| --- | --- |
| Any change at all | `node scripts/assert-production-secret-scan.mjs`, `git diff --check` |
| `Lifecycle.js`, policy, capabilities | `management-policy-24h`, `capability-reachability`, `lifecycle` |
| Payment / Flow / refund | `flow-contract`, `pre-transaction-contract`, `lifecycle`, `scripts/test-production-payment-status-privacy.mjs`, `scripts/assert-production-legacy-price-scan.mjs` |
| `Reconciliation.js` / `CalendarGateway.js` | `calendar-metadata-reconciliation`, `lifecycle-harness`, `calendar-manifest-contract` |
| Outbox / triggers / retries | `notification-outbox-worker`, `notification-outbox-sheet`, `sequential-notification-harness`, `no-drain-notification-harness`, `production-trigger-contract` |
| Email content or templates | `email-design-system-v3`, `lifecycle-email-v2` |
| `_worker.js` or any `/api/*` route | `scripts/assert-production-worker-structure.mjs _worker.js`, `scripts/test-production-worker-routes.mjs`, `scripts/test-production-payment-status-privacy.mjs`, `scripts/test-manage-contract.mjs`, `preview-host-validation` |
| Schema / properties / v7 compatibility | `v7-schema-compatibility`, `property-compatibility`, `session-duration-contract`, `production-derived-integration` |
| Deployable fileset / clasp | `clasp-fileset-release-gate`, `clasp-staging-release-gate`, `scripts/assert-production-clasp-staging-gate.mjs` |
| Runtime files or nonprod risk | `scripts/assert-production-contamination-firewall.mjs` |
| `.html` / `assets/**` | contamination firewall, `test-manage-contract` if `manage.html`, plus browser verification |
| Agent instructions or skills | `node scripts/assert-agent-skills-parity.mjs` |
| Release candidate | the full list in the canonical doc |

Do not run every suite for every change, and do not skip a row your diff touches.
`*-nonprod-*` scripts and `scripts/validate-nonprod-boundary.sh` validate an artefact
that does not exist on this Production-derived branch; they fail identically at the
accepted baseline and are not gates.

## Standards for a new test

- **A bug fix requires a regression test** whenever it is technically reasonable. If
  it is not, say so explicitly and why.
- **Load-bearing contracts require adversarial mutations.** Break the fix on purpose
  and require detection, in the style of `MUTATION_* = DETECTED`. A suite that
  cannot fail proves nothing.
- **Never let a test assert a value only its own mock defines.** That is exactly how
  this repo produced a false-positive trigger-cadence gate. Synthetic objects must
  expose only what the real API exposes.
- **No network, no real Google service, no real Flow, no email, no booking.** Fakes
  should reject the wrong call shape rather than tolerate it.
- **Report the counters the suites print** (`NO_NETWORK_TESTS=PASS count=…`,
  `MUTATION_… =DETECTED`) as evidence, not a bare "tests pass".

Browser verification is a separate obligation — see below and
`fran-release-quality-gate`.

## Browser verification

Required for any change a user can see or interact with; a passing static gate is
not a substitute, and there is no build whose success could stand in for it.

Available tooling: local Chrome driven headless over the DevTools Protocol, used by
`node scripts/render-email-v3-previews.mjs` (offline, deterministic, 22 full-page
screenshots at 600/430/390/375/320 plus a dark-scheme reference). Reuse this
approach for page verification; do not introduce a new E2E framework or dependency
to satisfy a routine check.

Minimum for a visible change: the page loads at the real route, the affected section
renders at desktop and mobile widths, forms validate and submit through `/api/*`,
the console is free of new errors, no request 4xx/5xx unexpectedly, and the primary
interaction completes.

If Chrome is unavailable the script prints `SCREENSHOT_TOOLING=UNAVAILABLE`. In that
case report exactly:

```
BROWSER_VERIFICATION=BLOCKED_BY_ENVIRONMENT
```

Never report a visible change as verified on the strength of a diff or a green
static gate.

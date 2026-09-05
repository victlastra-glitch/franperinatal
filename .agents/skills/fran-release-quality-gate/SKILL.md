---
name: fran-release-quality-gate
description: Establishes what state a change is actually in — IMPLEMENTED, TESTED, PREVIEW_VERIFIED, RELEASE_READY, DEPLOYED — with the exact SHA, diff, gates and evidence behind each. Use before claiming work is done, opening or updating a PR, or preparing a deploy. It never authorizes a deploy and never pushes.
---

# Release quality gate

## The five states are separate

| State | Means | Earned by |
| --- | --- | --- |
| `IMPLEMENTED` | code exists at a known SHA | the diff, reviewed by you |
| `TESTED` | the gates for this diff pass locally | named suites with their printed counters |
| `PREVIEW_VERIFIED` | observed running outside your editor | browser evidence on a real route |
| `RELEASE_READY` | a human could deploy it now | all of the above + rollback identified + risks stated |
| `DEPLOYED` | live in Production | a runbook execution, by a person |

Never collapse them. "Tests pass" is `TESTED`, not `RELEASE_READY`. "It builds" is
nothing here — there is no build. Report the highest state you can **evidence**, and
name what is missing for the next one.

## Candidate identity — always concrete

```
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD          # full SHA, quoted in any status you report
git status --porcelain
git diff --stat <base>...HEAD
git diff --check
```

A status without an exact SHA is not a status. A dirty tree is not a candidate.
Review the **whole** diff before claiming anything about it, including files you did
not intend to touch.

## Gates

Select with `fran-testing-contract`; run them; quote what they print. For a release
candidate run the full list in the **Running the gates** section of
`docs/production/CANCELLATION_RESCHEDULE_POLICY_V2.md`, plus:

```
node scripts/assert-agent-skills-parity.mjs
```

Financial safety counters belong in any report on money-touching work, and for a
code change they are all zero:

```
PRODUCTION_PAYMENT_CREATE_CALLS=0
PRODUCTION_REFUND_CREATE_CALLS=0
PRODUCTION_EMAILS_SENT=0
REAL_MONETARY_FLOW_CALLS=0
REAL_BOOKINGS_CREATED=0
```

## Git boundaries

- Work on a branch off `production`, the canonical default. Neither `production`
  nor the legacy `main` is a working branch.
- **Do not push, open, merge or retarget a PR unless asked.** Committing locally is
  the normal endpoint of a task.
- Do not commit onto an unrelated in-flight branch. PR #2 is the Production
  lifecycle RC — keep separate work off it.
- Never commit `.clasp.json`, a script id, a deployment id, or a concrete
  `/macros/s/<id>/exec` URL.
- `git stash`, `git reset --hard` and `git clean` are destructive: inspect first,
  and stop rather than discard work you did not create.

## Deployment is a human runbook operation

`docs/production/PRODUCTION_RC_RUNBOOK.md` is authoritative and its order must not
be reordered. Read-only summary of what that implies for an agent:

- Apps Script is pushed **only** from the generated exact-allowlist staging artefact
  built outside the repo — never from `backend/appsscript/booking/`, which holds 12
  clasp-visible files against a deployable set of 8. Validate recursively before any
  push (`STAGING_FILESET_GATE=PASS`, `RECURSIVE_FILESET_GATE=PASS`), then again
  remotely after push and before creating a version (8/8).
- Production runs an **immutable version on an existing versioned deployment**, so
  the `/exec` URL is preserved. Production must never be bound to `@HEAD`.
- Rollback targets are identified **before** deploying: Apps Script → the previously
  verified immutable version; Cloudflare → the recorded baseline-binding deployment.
- Triggers are installed and verified only through `TriggerInstallGuard.js`, after
  the schema step.
- Provider E2E (`FLOW_PROVIDER_MICRO_E2E`, `BOOKING_APPLICATION_E2E`) is money and
  requires explicit authorization; `BOOKING_APPLICATION_E2E` runs at 50000 with no
  Production test-price override.

**No deploy, no clasp push, no trigger install, no wrangler publish, no provider
E2E, and no Production write without explicit human authorization for that specific
action.** Prior approval of one step never carries to the next.

## Report shape

State, exact SHA, diff scope, gates with their printed evidence, browser evidence or
`BROWSER_VERIFICATION=BLOCKED_BY_ENVIRONMENT`, rollback target, unresolved risks,
and what was deliberately not done. Separate current-scope blockers from follow-ups.

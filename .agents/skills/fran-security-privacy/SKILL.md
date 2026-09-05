---
name: fran-security-privacy
description: Handling of patient identity, contact and perinatal health data, secrets, capability bearers, and production/non-production separation. Use before logging, persisting, returning, exporting or committing anything derived from a booking, and when touching Script Properties, tokens or environment gating. Not a legal-compliance advisor.
---

# Security and privacy

This repository handles **perinatal mental-health** bookings. A row joins a named
person to a psychology session. Treat every reservation field as sensitive personal
data and behave as if any leak is permanent.

## Data that must never leave the server

Name, RUT, email, phone, session notes, service/modality selection, calendar event
linkage, Flow tokens, `publicStatusToken`, raw capability bearers, upstream Apps
Script URLs, script ids, deployment ids.

- **Responses are allowlists, not denylists.** `/api/payment-status`, `/api/manage`
  and the management endpoints return only explicitly permitted fields. Widening a
  response is a deliberate, tested change — see `fran-worker-api-contract`.
- **Logs carry tags, not data.** Never `console.log` a request body, a record, an
  email address or a token. The existing `[handler] short message` shape is the
  pattern.
- **Bearers are hashed at rest** and returned only to the dispatcher at send time;
  rotation invalidates the previous bearer. Never persist or print a raw bearer.
- **Calendar linkage is stored without PII.**

## Secrets

Secrets live in Apps Script Script Properties and Cloudflare bindings — never in
Git, never in a doc, never in a test fixture. Tests use `synthetic-` prefixed
values, which is what the scanner allows.

`.gitignore` already blocks `.env*`, keys, certificates and any path containing
`token` or `credential`; `.clasp.json` and the concrete `/exec` URL must never be
committed. Before any commit:

```
node scripts/assert-production-secret-scan.mjs
```

## Least privilege and server authority

- Add no OAuth scope that a change does not require; `appsscript.json` is reviewed.
- Every authorization decision is server-side. A capability bearer proves *who is
  asking*, never *what is permitted* — the policy decides that separately
  (`fran-booking-lifecycle`).
- The Flow webhook is treated as untrusted input: parse defensively, verify
  server-side, and never let its payload widen what a caller may do.
- Fail closed. An unverifiable identity, environment or clock refuses the operation.

## Production / non-production separation

`APP_ENV` gates behaviour in both the Worker and Apps Script. Non-production
artefacts — `TargetedFixture.js`, `reservations_nonprod`,
`notification_outbox_nonprod`, `NONPROD_FLOW_TEST_AMOUNT_CLP`, `sandbox.flow.cl`,
`fran-nonprod` — must never appear in a Production runtime file:

```
node scripts/assert-production-contamination-firewall.mjs
```

Deployable Apps Script content is an exact 8-file allowlist built outside the repo;
never push from the source directory, and never let tests, fixtures or credentials
into the artefact (`scripts/assert-production-clasp-staging-gate.mjs`).

## Scope

State security facts from what is in the repo. Do not assert what a specific law
requires — flag the question for a human instead.

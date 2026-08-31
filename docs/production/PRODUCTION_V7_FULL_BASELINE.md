# Full Production baseline — Apps Script v7 + public website

Immutable historical Apps Script-only baseline remains:

`baseline/production-v7-20260831` @ `a616c43`

This branch adds the recovered canonical public website so a lifecycle PR
does not show unchanged pages as false additions.

## A. Apps Script v7

Copied unchanged from `baseline/production-v7-20260831`:

- `backend/appsscript/booking/Código.js` (live v7, sha256 `36719d5eaf75c19670948c94b8949b64996f4ee807770a2428047b1702a02828`)
- `backend/appsscript/booking/appsscript.json`
- `docs/production/PRODUCTION_V7_BASELINE.md`

Live project: `franciscabustos booking backend PRODUCTION`, Web App version 7.

## B. Public website

Taken from Git snapshot `feat/p0-unified-price-50000-local-20260830` (`28b1b8e`)
**public tree only** (HTML, assets, Worker source, redirects). No Apps Script
backend, no NONPROD docs, no NONPROD scripts.

Parity checks on 2026-08-31 (read-only fetch of franciscabustos.cl):

- Live `servicios` / `index` / `reserva` already show **$50.000** (not $55.000).
- Live `sitemap.xml` is byte-identical to this snapshot.
- Live `assets/booking.js` still contains a Production Apps Script Web App URL.
  That URL is **not** imported into Git. The snapshot `booking.js` is the
  recovered same-origin source the RC actually modifies (`/api/availability`,
  idempotency prefix `fran-nonprod-20260821-` in this baseline).
- Snapshot `_worker.js` is the recovered same-origin Worker the RC Production-
  adapts. Live Pages is Direct Upload; this file is the reviewable source, not
  a secret dump.

This branch is not `main`, not a deploy authorization, and does not replace
`baseline/production-v7-20260831`.

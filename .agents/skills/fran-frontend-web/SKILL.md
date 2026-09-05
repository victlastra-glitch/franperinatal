---
name: fran-frontend-web
description: How web code is written in this repo — hand-authored static HTML pages plus vanilla ES modules and CSS in assets/, with no framework, no bundler and no package manager. Use when editing any .html page, assets/*.js or assets/*.css, adding a section, or changing a form. Not the owner of booking semantics, payment rules, approved copy, or release authorization.
---

# Frontend engineering

## The stack, as it actually is

Static, hand-authored HTML served by Cloudflare Pages, with `_worker.js` in front
and `_redirects` for routing. Shared behaviour lives in `assets/app.js`,
`booking.js`, `forms.js`, `analytics.js`, `tweaks.js`; styling in
`assets/styles.css` plus per-area sheets (`home`, `pages`, `booking`, `blog`,
`landing`).

There is **no** `package.json`, no lockfile, no `node_modules`, no bundler, no
TypeScript, no React, no JSX, no build step. Do not introduce one, do not add a
dependency, and do not run `npm`/`pnpm`/`yarn` install commands. Do not suggest
React/Vercel patterns — they do not apply here. "Build succeeds" is not a
meaningful signal in this repo because there is nothing to build.

Write browser-native ES: plain functions, `fetch`, `addEventListener`,
`document.getElementById`. Match the surrounding file's idiom rather than
modernizing it.

## Rules

- **Progressive enhancement.** A page must render and read correctly before its
  script runs. Content lives in HTML, not in JS template strings.
- **The client is never authority.** Client-side validation is a courtesy for the
  patient; every rule is re-decided server-side. Never compute a policy verdict, a
  cutoff, a price or a refund eligibility in the browser and never send one to the
  server expecting it to be honoured.
- **Guard against stale responses.** Availability, payment status and management
  lookups are async and re-entrant: a late reply from an abandoned request must not
  overwrite fresher state. Track the in-flight request and ignore superseded ones.
- **Every async path needs three visible states** — loading, error, success — plus a
  disabled/idempotent submit so a double click cannot create two bookings or two
  payments.
- **Same-origin only.** Call `/api/*`; never call Apps Script or Flow directly from
  the browser, and never embed an upstream URL, script id or key in a page.
- **No PII to third parties.** `analytics.js` may record events; it must not carry
  name, RUT, email, phone, or clinical content.
- **Accessibility basics**: real `<label>` associations, keyboard-reachable
  controls, visible focus, meaningful `alt`, sensible heading order. The booking
  calendar is interactive — keep it operable without a pointer.
- **Performance basics**: keep the responsive `.webp`/`.jpg` variants already in
  `assets/`, keep images sized, do not add web fonts or third-party scripts.
- Editing `reserva.html`, `manage.html`, `pago.html` or `pago-resultado.html` means
  you are touching a governed surface — load `fran-booking-lifecycle` or
  `fran-payment-integrity` too. Editing clinical or service copy loads
  `fran-content-claims`.

## Verification

Static gates that apply to frontend changes:

```
node scripts/assert-production-contamination-firewall.mjs   # covers assets/booking.js, reserva/manage/pago-resultado
node scripts/assert-production-secret-scan.mjs
node scripts/test-manage-contract.mjs
git diff --check
```

For anything visually or behaviourally observable, browser verification is required
and is defined in `fran-testing-contract`. Reading the diff is not verification.

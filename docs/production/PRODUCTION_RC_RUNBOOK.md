# Production release candidate runbook

**DO NOT EXECUTE THIS RUNBOOK UNTIL THE DRAFT PR IS APPROVED.**

After that approval, follow the sections in order. No extra planning prompt
is required.

## Identifiers

| Item | Value |
|---|---|
| Draft PR | retarget to `baseline/production-v7-full-20260831` |
| RC branch | `feat/production-booking-lifecycle-v2-port` |
| Full baseline | `baseline/production-v7-full-20260831` |
| Historical Apps Script-only baseline | `baseline/production-v7-20260831` @ `a616c43` (immutable) |
| Apps Script runtime | `backend/appsscript/booking/{Code,Lifecycle,EmailTemplates,CalendarGateway,Reconciliation,RefundGateway}.js` |
| Rollback Apps Script | live version **7** (`docs/production/v7/Código.js`) |
| Rollback web | previous Cloudflare Pages Production deployment |
| Prices | 50000 / 50000 |
| Hold | 15 minutes; timeout/checkout_timeout ≤ 900; retry does not extend hold |
| Refund policy | `BUSINESS_POLICY_TBD` |
| Patient cancel email | `SESSION_CANCELLED` (neutral copy). `PATIENT_CANCELLED` only after provider-confirmed refund |

Fill RC SHA at deploy time: `git rev-parse --short HEAD`

---

## 1. Pre-deploy binding check / configuration

Do **not** print secret values.

### Cloudflare Pages Production (project `franciscabustos`)

Dashboard: Workers & Pages → `franciscabustos` → Settings → Environment variables → **Production**.

Required **names**:

- `APP_ENV` — value must be exactly `production`
- `APPS_SCRIPT_WEB_APP_URL` — https URL, host `script.google.com`, Production Web App `/exec`

If a name is missing, add it in that Production environment (paste the value from the existing private store; do not commit it). Then save. Do not create a Preview binding that points at Production.

Worker contract (`_worker.js`): consumes those names; no hardcoded fallback; missing/`APP_ENV` not `production` → HTTP 503.

Optional CLI (names only; do not dump values):

```bash
npx wrangler whoami
npx wrangler pages project list
# Confirm the Production environment in the dashboard. Do not run pages deploy.
```

### Apps Script Production project

Script Properties **names** (Project Settings → Script properties):

- `APP_ENV` = `production`
- `FLOW_API_KEY`, `FLOW_SECRET_KEY`, `FLOW_BASE_URL` (`https://www.flow.cl/api`)
- `FLOW_RETURN_URL`, `FLOW_CONFIRMATION_URL`
- `CALENDAR_ID`
- `INTERNAL_NOTIFICATION_EMAIL`
- `IDEMPOTENCY_NAMESPACE` = `fran-booking`
- `STATUS_TOKEN_SECRET`
- `BOOKING_STORE_ID` or alias `SHEET_ID`
- `CAPABILITY_TOKEN_SECRET` (required before manage/reschedule/cancel)
- `FLOW_REFUND_CALLBACK_URL` (not used on normal TBD cancel)

Missing required names fail closed (`CONFIGURATION_INCOMPLETE`).

Pass this section when both Cloudflare names exist (or were just added) and Apps Script names exist. Do not proceed if either side is unknown.

---

## 2. Exact Apps Script deployment

1. Clasp **only** the modular files in `backend/appsscript/booking/` (`Code.js` and siblings + `appsscript.json`).
2. Never push `docs/production/v7/Código.js` in the same project as `Code.js`.
3. In the Apps Script editor, create a **new version** from that push. Do not yet change the live Web App.
4. Smoke-read the version source in the editor (no live booking).
5. Update the **existing** Production Web App deployment to the new version. Do not create a second `/exec` URL.

---

## 3. Exact Worker / web deployment (required with this RC)

This RC changes `_worker.js`, `assets/booking.js`, `pago-resultado.html`, and `manage.html`. Pages Direct Upload is the existing mechanism. Do **not** add GitHub Actions.

1. Build a Direct Upload artifact from the RC public tree (`_worker.js`, HTML, `assets/`). Exclude `backend/`, `docs/`, `scripts/`, `.git`.
2. Upload to Cloudflare Pages project `franciscabustos` **Production** only after Apps Script Web App points at the new version.
3. Do not point Preview at Production secrets.

---

## 4. Immediate no-charge smoke

Do not create a booking, Sheet row, Calendar event, or Flow charge.

- `GET /` `GET /reserva` `GET /pago-resultado` `GET /manage` → 200
- `GET /api/payment-status` without `st` → 4xx, no PII
- `GET /api/payment-status?st=not-a-token` → 4xx
- Worker 503 if you temporarily cannot see bindings (do not remove them)
- `assets/booking.js` uses `/api/availability` and `/api/create-flow-payment` only — no `script.google.com`
- Status JSON allowlist: `ok,status,amount,currency,serviceType,modality,backendVersion,retryAvailable,holdValid`

---

## 5. Production Flow payment micro-E2E

Only after section 4 and explicit authorization.

Re-verify minimum amount at https://web.flow.cl/en-cl/ayuda/ (2026-08-31: **> 350 CLP**).

Use a controlled internal email. No patient data. Ideally two minimum payments.

1. Create payment 1 at current Flow minimum; complete checkout.
2. `payment/getStatus` = **2 (PAID)**.
3. Repeat for payment 2.
4. Confirm booking side effects for these test rows only (Calendar/Meet/email) then cancel under TBD (no automatic refund).

---

## 6. Refund micro-E2E

Separate from normal TBD cancel.

1. While Flow merchant balance is sufficient, `refund/create` on payment 1 only.
2. Provider acceptance, callback, `refund/getStatus`.
3. Duplicate callback must be idempotent.
4. If provider returns 501 / insufficient funds after two minimum payments, decide whether a third minimum payment is justified. Treat 501 as external status, not an app defect.
5. Cleanup test charges in Flow accounting.

Normal patient cancel still must show **zero** automatic `refund/create`.

---

## 7. Pass / fail criteria

`READY_FOR_PRODUCTION_RELEASE=YES` only if:

- Draft PR reviewed against `baseline/production-v7-full-20260831`
- Binding **name** checks passed
- Apps Script + Pages deployed as above
- No-charge smoke passed
- Payment micro-E2E passed
- Refund micro-E2E passed **or** waived with recorded provider-funds blocker
- Rollback to v7 restated and still executable

Otherwise `READY_FOR_PRODUCTION_RELEASE=NO`.

---

## 8. Exact rollback

1. Apps Script: point the existing Web App deployment back to **version 7**.
2. Pages: restore the previous Production deployment in Cloudflare (Deployments → previous Production → Rollback).
3. Do not change Script Properties or Flow keys as rollback.
4. Git: do not merge this RC to `main` during rollback.

---

## 9. Cleanup

- Delete the two (or three) Flow micro-E2E test payments/refunds in Flow.
- Delete corresponding test Sheet rows / Calendar events if any were created in section 5.
- Do not leave test emails in the patient-facing mailbox narrative.

---

## 10. Git merge / main canonicalization after Production verification

Only after `READY_FOR_PRODUCTION_RELEASE=YES` and a separate merge authorization:

1. Merge the RC into `main` via GitHub (not force-push).
2. Do not delete `baseline/production-v7-20260831` or `baseline/production-v7-full-20260831`.
3. Tag the merged SHA `production-lifecycle-v2-<date>` after the live smoke stays green.

Until that authorization: leave this PR **draft**, unmerged.

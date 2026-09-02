# Production release candidate runbook

**DO NOT EXECUTE THIS RUNBOOK UNTIL THE DRAFT PR IS APPROVED.**

After that approval, follow the sections in order. No extra planning prompt
is required.

This runbook is a Production **compatibility** release sequence. It does not
authorize execution during the local RC mission.

## Identifiers

| Item | Value |
|---|---|
| Draft PR | `#2` (keep draft; base `baseline/production-v7-full-20260831`) |
| RC branch | `feat/production-booking-lifecycle-v2-port` |
| Full baseline | `baseline/production-v7-full-20260831` |
| Historical Apps Script-only baseline | `baseline/production-v7-20260831` @ `a616c43` (immutable) |
| Apps Script runtime | `backend/appsscript/booking/{Code,Lifecycle,EmailTemplates,CalendarGateway,Reconciliation,RefundGateway,TriggerInstallGuard}.js` + `appsscript.json` (7 JS files + `appsscript.json` = 8 deployable files) |
| Rollback Apps Script | live version **7** (`docs/production/v7/Código.js`) |
| Rollback web | previous Cloudflare Pages Production deployment |
| Prices | `INITIAL_PRICE_CLP=50000` / `FOLLOWUP_PRICE_CLP=50000` |
| Session | `SESSION_DURATION_MINUTES=50` (clinical event) |
| Slot grid | `SLOT_INTERVAL_MINUTES=60` (hourly starts) |
| Hold | `PRODUCTION_PAYMENT_SLOT_HOLD_MINUTES=15`; timeout/checkout_timeout ≤ 900; retry does not extend hold |
| Schema | `SCHEMA_MIGRATION_STRATEGY=APPEND_ONLY_V7_COMPATIBILITY` |
| Refund policy | `CANONICAL_REFUND_POLICY=BUSINESS_POLICY_TBD` for **normal** cancel |
| Late PAID after hold expiry | system-consistency refund attempt **once**; never reclaim the slot; never confirm |
| Patient cancel email | `SESSION_CANCELLED` (neutral copy). `PATIENT_CANCELLED` only after provider-confirmed refund |

Fill RC SHA at deploy time: `git rev-parse --short HEAD`

---

## Trigger / deploy order (do not reorder)

1. Pre-deploy binding / Script Property **name** checks
2. Apps Script clasp push of the modular fileset only
3. Remote fileset verification (`clasp list` / editor) — **before** version creation
4. Schema dry-run (`productionSchemaMigrationDryRun_`) — metadata only, no row PII
5. Explicit schema migration (`migrateProductionV7SchemaToLifecycleV2_`) once
6. Verify schema (second migration is a no-op; headers/rows preserved)
7. Install/verify triggers (`installProductionLifecycleTriggersDeterministic_` / `verifyProductionLifecycleTriggersDeterministic_`)
8. Create a new Apps Script version
9. Deploy the existing Web App to that version (do not mint a second `/exec`)
10. Configure/verify Worker binding **names**
11. Deploy website/Worker only when required by this RC
12. Immediate no-charge smoke, then authorized Flow tests

Do **not** install triggers before schema migration. Do **not** clasp-push
`docs/production/v7/Código.js`, `TargetedFixture.js`, tests, or NONPROD
operators into the Production project.

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

### Apps Script Production project

Recovered v7 names remain valid aliases where semantically identical:

- `BOOKING_STORE_ID` ← `SHEET_ID`
- `FLOW_RETURN_URL` ← `PUBLIC_RETURN_URL`
- `IDEMPOTENCY_NAMESPACE` defaults to `fran-booking` if unset

Do **not** alias `FLOW_ENV` to `APP_ENV`.
Do **not** alias `FLOW_WEBHOOK_URL` / `WEB_APP_URL` to `FLOW_CONFIRMATION_URL`
(those are the Apps Script callback, not the public Worker path).

**New Production property names required at deploy time:**

- `APP_ENV`
- `FLOW_CONFIRMATION_URL`
- `INTERNAL_NOTIFICATION_EMAIL`
- `STATUS_TOKEN_SECRET`
- `CAPABILITY_TOKEN_SECRET` (lazy; required before manage/reschedule/cancel)
- `FLOW_REFUND_CALLBACK_URL` (required for late-paid system-consistency refund)

Also required, already present in v7 or aliased:

- `FLOW_API_KEY`, `FLOW_SECRET_KEY`, `FLOW_BASE_URL` (`https://www.flow.cl/api`)
- `CALENDAR_ID`
- `BOOKING_STORE_ID` or `SHEET_ID`
- `FLOW_RETURN_URL` or `PUBLIC_RETURN_URL`

Missing required concepts fail closed (`CONFIGURATION_INCOMPLETE`). Never print values.

Pass this section when both Cloudflare names exist (or were just added) and Apps Script names exist. Do not proceed if either side is unknown.

---

## 2. Exact Apps Script deployment

### 2.1 Clasp push (modular fileset only)

Push **exactly**:

- `Code.js`
- `Lifecycle.js`
- `EmailTemplates.js`
- `CalendarGateway.js`
- `Reconciliation.js`
- `RefundGateway.js`
- `TriggerInstallGuard.js`
- `appsscript.json`

That is **7 JS files + `appsscript.json` = 8 deployable files**, nothing else.
`TriggerInstallGuard.js` is Apps Script JS source, so it needs **no**
`appsscript.json` manifest entry. Do not add one.

`appsscript.json` must enable Advanced Calendar:

- `userSymbol: Calendar`
- `serviceId: calendar`
- `version: v3`

Never push `docs/production/v7/Código.js` in the same project as `Code.js`.

### 2.2 CLASP_REMOTE_FILESET_RELEASE_GATE (after push, before version)

In the Apps Script editor or via `clasp list`, the remote project must contain
exactly the eight files above as deployable runtime (7 JS + the manifest).

Must **not** coexist as deployable runtime:

- `Código.js`
- `TargetedFixture.js`
- NONPROD operators
- `test/` files
- temporary transform scripts

If the remote fileset is wrong: stop. Do not create a version. Do not switch
the Web App. Fix the fileset and re-push.

### 2.3 Schema dry-run then migration

Operator-only. Never from `doGet` / `doPost`.

1. `productionSchemaMigrationDryRun_()` — header fingerprint, counts, missing
   V2 columns, outbox presence. No row values. No writes.
2. `migrateProductionV7SchemaToLifecycleV2_()` — append-only. Never delete,
   reorder, or rename existing columns. Preserve every historical row. Create
   or recognize `notification_outbox` independently.
3. Run the migrator a second time — `idempotent=true`, zero appended columns.
4. Confirm legacy v7 statuses remain readable via the adapter.

Live sheet name stays `Respuestas de formulario 1` unless an equivalent
existing sheet (`reservations`) is explicitly resolved.

### 2.4 Triggers (after schema verify)

Do **not** run the installer during the local RC mission.

Use **only** these two deterministic operators, in this order:

1. `installProductionLifecycleTriggersDeterministic_()`
2. `verifyProductionLifecycleTriggersDeterministic_()`

Expected handlers, exactly one current trigger each, 5-minute cadence,
`TriggerSource.CLOCK`, no duplicates, no NONPROD/fixture/test names:

- `processLifecycleNotificationOutbox_`
- `processCalendarReconciliation_`

#### Why cadence is not read back

An Apps Script `Trigger` object **does not expose its clock cadence for
runtime read-back**. There is no public `everyMinutes` getter on an installed
trigger. A previous revision of this runbook accepted a cadence PASS that had
been derived from a synthetic test-only property, so the PASS was a false
positive. It is withdrawn. Nothing in the release may claim runtime cadence
introspection, and an unknown cadence is **never** treated as valid.

Cadence proof is install-time and metadata-bound instead:

- the installer called `.timeBased().everyMinutes(5).create()`
- it persisted non-secret install metadata in Script Property
  `PRODUCTION_LIFECYCLE_TRIGGER_INSTALL_META_V1`
  (`version`, `installedAt`, `cadenceVerification`,
  `runtimeCadenceIntrospection`, and per trigger `handler`,
  `intervalMinutes`, `uniqueId`)
- each **current** `Trigger.getUniqueId()` equals the metadata `uniqueId` for
  that handler
- each current trigger source is `ScriptApp.TriggerSource.CLOCK`

That metadata is non-secret. It carries no Flow key, token, store ID, Calendar
ID, or patient data. Never add any.

#### Required trigger evidence

```
cadenceVerification=INSTALL_METADATA_PLUS_TRIGGER_ID
runtimeCadenceIntrospection=false
```

Record `expectedHandlers`, `cadenceMinutes=5`, `metadataPresent=true`, and
empty `missing`, `duplicates`, `wrongSource`, `idMismatch`,
`metadataMismatch`, `unexpectedNonprod`.

Any of the following is a **FAIL**: stop, do not create a version, do not
switch the Web App.

- missing or stale install metadata (including invalid JSON, an unexpected
  `version`, or metadata claiming `runtimeCadenceIntrospection=true`)
- a current trigger unique ID that does not match the metadata
- a non-CLOCK trigger source
- a missing target trigger
- duplicate triggers for a target handler
- any unexpected NONPROD/fixture/test handler

#### Rerunning the installer

Rerunning is **convergent, not identity-preserving idempotency**. Each run
recreates both target triggers, so the target trigger unique IDs change every
run, and the install metadata is rewritten to the new IDs. It converges on
exactly one current trigger per target handler. Unrelated project triggers are
never modified. Always rerun
`verifyProductionLifecycleTriggersDeterministic_()` after any install run: a
stale ID from an earlier run must fail, not pass.

The installer is fail-closed on configuration (`readConfig_`) and rolls back
its own newly created triggers plus any incomplete metadata if creation fails.

### 2.5 Version then Web App

1. Create a **new version** from that push. Do not yet change the live Web App.
2. Smoke-read the version source in the editor (no live booking).
3. Update the **existing** Production Web App deployment to the new version. Do not create a second `/exec` URL.

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

## 5. FLOW test-plan separation

These are different tests. Do not treat a provider-minimum charge as proof of
the booking application path. No Production test-price override is allowed.

Prior NONPROD evidence (do not re-interpret):

- `FLOW_PAYMENT_E2E=PASS`
- `FLOW_REFUND_E2E=BLOCKED_PROVIDER_FUNDS_501` — provider funds status, not an application defect

### A. FLOW_PROVIDER_MICRO_E2E

Purpose: provider credentials, endpoints, `payment/getStatus`, and
`refund/create` mechanics.

May use a provider-valid **minimum test amount** if required. It does **not**
prove `INITIAL_PRICE_CLP=50000` / `FOLLOWUP_PRICE_CLP=50000` or the real
booking application path.

Only after section 4 and explicit authorization.

Re-verify minimum amount at https://web.flow.cl/en-cl/ayuda/.

Use a controlled internal email. No patient data.

1. Create payment 1 at current Flow minimum; complete checkout.
2. `payment/getStatus` = **2 (PAID)**.
3. Repeat for payment 2 if a refund sample is required.
4. These rows are provider samples, not booking-application proof.

### B. BOOKING_APPLICATION_E2E

Purpose: the real booking application path.

Must use:

- `INITIAL_PRICE_CLP=50000`
- `FOLLOWUP_PRICE_CLP=50000`

Must exercise create → hold 15 minutes → Flow confirmation → Calendar/Meet →
email. No Production test-price override.

Only after explicit authorization. Strong vs low-cost options may be chosen
at deploy time; both still use 50000 on the booking path.

### Refund micro-E2E (provider)

Separate from normal TBD cancel.

1. While Flow merchant balance is sufficient, `refund/create` on a provider
   sample only.
2. Provider acceptance, callback, `refund/getStatus`.
3. Duplicate callback must be idempotent.
4. If provider returns 501 / insufficient funds, record
   `FLOW_REFUND_E2E=BLOCKED_PROVIDER_FUNDS_501`. That is external status, not
   an application defect.

Normal patient cancel still must show **zero** automatic `refund/create`
(`AUTOMATIC_FLOW_REFUND_CALLS_UNDER_TBD=0`).

Late PAID after the original 15-minute hold is **not** TBD cancel: attempt
system-consistency `refund/create` exactly once, never reclaim the slot,
never send booking confirmation.

---

## 6. Pass / fail criteria

`READY_FOR_PRODUCTION_DEPLOY_APPROVAL=YES` after this RC is merged locally,
pushed, and the draft PR documents the compatibility gates.

`READY_FOR_PRODUCTION_RELEASE=YES` only if:

- Draft PR reviewed against `baseline/production-v7-full-20260831`
- Binding **name** checks passed
- Remote fileset gate passed
- Schema dry-run + append-only migration + idempotent second run passed
- Triggers installed/verified with the deterministic operators, evidencing
  `cadenceVerification=INSTALL_METADATA_PLUS_TRIGGER_ID` and
  `runtimeCadenceIntrospection=false`
- Apps Script + Pages deployed as above
- No-charge smoke passed
- `FLOW_PROVIDER_MICRO_E2E` passed
- `BOOKING_APPLICATION_E2E` passed at 50000
- Refund micro-E2E passed **or** waived with recorded provider-funds blocker
- Rollback to v7 restated and still executable

Until those live steps run: `READY_FOR_PRODUCTION_RELEASE=NO`.

---

## 7. Exact rollback

1. Apps Script: point the existing Web App deployment back to **version 7**.
2. Pages: restore the previous Production deployment in Cloudflare (Deployments → previous Production → Rollback).
3. Do not change Script Properties or Flow keys as rollback.
4. Git: do not merge this RC to `main` during rollback.
5. Never redeploy artifact `28b1b8e` as Production baseline.

---

## 8. Cleanup

- Delete Flow micro-E2E test payments/refunds in Flow.
- Delete corresponding test Sheet rows / Calendar events if any were created.
- Do not leave test emails in the patient-facing mailbox narrative.

---

## 9. Git merge / main canonicalization after Production verification

Only after `READY_FOR_PRODUCTION_RELEASE=YES` and a separate merge authorization:

1. Merge the RC into `main` via GitHub (not force-push).
2. Do not delete `baseline/production-v7-20260831` or `baseline/production-v7-full-20260831`.
3. Tag the merged SHA `production-lifecycle-v2-<date>` after the live smoke stays green.

Until that authorization: leave this PR **draft**, unmerged.

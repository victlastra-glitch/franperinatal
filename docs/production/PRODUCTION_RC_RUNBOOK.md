# Production release candidate runbook

**DO NOT EXECUTE THIS RUNBOOK UNTIL THE DRAFT PR IS APPROVED.**

After that approval, follow the sections in order. No extra planning prompt
is required.

This runbook is a Production **compatibility** release sequence. It does not
authorize execution during the local RC mission.

## Identifiers

| Item | Value |
|---|---|
| Canonical branch (current) | `production` — the only branch Production is maintained and deployed from; every change goes branch → preview → PR against `production` (`AGENTS.md`). `main` is legacy lineage, preserved in `legacy/main-pre-production-lineage-20260905`, never a merge target for new work. |
| Historical draft PR | `#2` (base `baseline/production-v7-full-20260831`) — the original Production lifecycle RC. Historical/in-flight: remains draft and unmerged; no merge, retarget or closure is authorized by this runbook or by FRA-5; any future decision on it needs separate authorization. Not a prerequisite for anything below. |
| Historical RC branch | `feat/production-booking-lifecycle-v2-port` — provenance of the lifecycle port; current work does not branch from it. |
| Full baseline | `baseline/production-v7-full-20260831` |
| Historical Apps Script-only baseline | `baseline/production-v7-20260831` @ `a616c43` (immutable) |
| Apps Script runtime | `backend/appsscript/booking/{Code,Lifecycle,EmailTemplates,CalendarGateway,Reconciliation,RefundGateway,TriggerInstallGuard}.js` + `appsscript.json` (7 JS files + `appsscript.json` = 8 deployable files) |
| Rollback Apps Script | the immediately previous **verified immutable** Production version (never a fixed number; for the Policy V2 release that was **v9**; for the current permanent runtime **v20** from `8455f3b` it is **v18** from `3d5a9a8`). `docs/production/v7/Código.js` is the historical v7 recovery baseline only. TEMP lane versions v19, v21 and v22 were each briefly live on the existing Web App during FRA-4 (2026-09-07/08) and were restored to the permanent version each time; at closure none is referenced, and none may be repointed to again. |
| Rollback web | previous Cloudflare Pages Production deployment |
| Prices | `INITIAL_PRICE_CLP=50000` / `FOLLOWUP_PRICE_CLP=50000` |
| Session | `SESSION_DURATION_MINUTES=50` (clinical event) |
| Slot grid | `SLOT_INTERVAL_MINUTES=60` (hourly starts) |
| Hold | `PRODUCTION_PAYMENT_SLOT_HOLD_MINUTES=15`; timeout/checkout_timeout ≤ 900; retry does not extend hold |
| Schema | `SCHEMA_MIGRATION_STRATEGY=APPEND_ONLY_V7_COMPATIBILITY` |
| Refund policy | Patient management policy V2 (deployed 2026-09-04): normal patient cancel `>=24h` before the current start → full automatic refund (`PATIENT_CANCEL_FULL_AUTOMATIC_REFUND`, `REFUND_CREATE_EFFECTIVE_MAX=1`); `<24h` → cancel allowed, no refund, zero refund calls. Clinician cancellation remains `BUSINESS_POLICY_TBD`. Contract: `docs/production/CANCELLATION_RESCHEDULE_POLICY_V2.md` |
| Late PAID after hold expiry | system-consistency refund attempt **once**; never reclaim the slot; never confirm |
| Patient cancel email | `SESSION_CANCELLED` (neutral copy). `PATIENT_CANCELLED` only after provider-confirmed refund |

Fill RC SHA at deploy time: `git rev-parse --short HEAD`

---

## Trigger / deploy order (do not reorder)

1. Pre-deploy binding / Script Property **name** checks
2. Apps Script clasp push of the **staged allowlist artifact only** (never from `backend/appsscript/booking/`; build with `scripts/build-production-appsscript-staging.mjs`, validate with `scripts/assert-production-clasp-staging-gate.mjs`)
3. Remote fileset verification (`clasp list` / editor) — **before** version creation
4. Schema dry-run (`productionSchemaMigrationDryRun_`) — metadata only, no row PII
5. Explicit schema migration (`migrateProductionV7SchemaToLifecycleV2_`) once
6. Verify schema (second migration is a no-op; headers/rows preserved)
   — **if this release ADDS a reservation column, follow the two-stage bridge in
   §2.3a instead of this single pass**
7. Install/verify triggers (`installProductionLifecycleTriggersDeterministic_` / `verifyProductionLifecycleTriggersDeterministic_`)
8. Create a new Apps Script version
9. Deploy the existing Web App to that version (do not mint a second `/exec`)
10. Configure/verify Worker binding **names**
11. Deploy website/Worker only when required by this RC
12. Immediate no-charge smoke, then authorized Flow tests

Do **not** install triggers before schema migration. Do **not** clasp-push
`docs/production/v7/Código.js`, `TargetedFixture.js`, tests, fixtures, or
NONPROD operators into the Production project. Do **not** push from the
runtime source directory: push only the staged allowlist artifact.

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

### 2.1 Clasp push (staged allowlist artifact only)

**Never run `clasp push` from `backend/appsscript/booking/`.** That directory
is the runtime *source* tree and it also contains `test/`, including pushable
`test/fixtures/email-preview/*.html`. clasp uploads `.js`, `.gs`, `.html` and
the manifest **recursively** from its root, so a push from the source
directory would upload 12 files instead of 8 and fail the remote fileset gate
in §2.2 — or worse, quietly install HTML fixtures as Production project files.

Deploy from a generated, ephemeral staging artifact instead
(`DEPLOY_STAGING_STRATEGY=EXACT_ALLOWLIST_EPHEMERAL`):

```sh
# 1. Build the artifact. Prints STAGING_DIR / STAGING_FINGERPRINT.
node scripts/build-production-appsscript-staging.mjs

# 2. Validate it recursively BEFORE any push. Must print
#    STAGING_FILESET_GATE=PASS and RECURSIVE_FILESET_GATE=PASS.
node scripts/assert-production-clasp-staging-gate.mjs <STAGING_DIR>

# 3. Inject the private Production .clasp.json into STAGING_DIR only.
#    Never copy it, or the script ID, back into the repository.

# 4. Push from STAGING_DIR (authorized deploy only).
cd <STAGING_DIR> && clasp push
```

The builder copies only the explicit allowlist, flat, into a directory
**outside** the repository, and is generated — never hand-maintained. The gate
walks the staged tree recursively and fails on a wrong file count, any
unexpected or missing file, any `.html`, `Código.js` (NFC or NFD spelling),
`TargetedFixture.js`, any path containing `test`/`fixture`/`nonprod`/`sandbox`,
any credential file, any subdirectory, or an artifact located inside the repo.

The staged artifact must contain **exactly**:

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

A private `.clasp.json` inside the staging directory is expected at deploy
time and is not a deployable file. It must never be committed to Git, and no
script ID, deployment ID, or Web App URL may be committed either.

`appsscript.json` must enable Advanced Calendar:

- `userSymbol: Calendar`
- `serviceId: calendar`
- `version: v3`

Never push `docs/production/v7/Código.js` in the same project as `Code.js`.

### 2.2 CLASP_REMOTE_FILESET_RELEASE_GATE (after push, before version)

In the Apps Script editor or via `clasp list`, the remote project must contain
exactly the eight files above as deployable runtime (7 JS + the manifest), and
nothing else. Compare against the `STAGING_FINGERPRINT` recorded in §2.1.

If any `.html` file, `Código.js`, `TargetedFixture.js`, a test/fixture path, or
a ninth JS file appears remotely, the push came from the wrong directory:
stop, do not create a version, delete the stray remote files, and re-push from
a freshly built staging artifact.

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

### 2.3a Releases that ADD a reservation column — two-stage bridge

Applies when `RESERVATION_HEADERS` in the release is wider than the live sheet.
The append itself is safe; what is not safe is running a version that disagrees
with the sheet about how wide it is.

Every runtime from the BRIDGE release onward carries both halves of the
append-only contract, so it tolerates a sheet one approved column wider **or**
narrower than its own header list:

Two different counts, never interchangeable:

| Term | What it means | Value today |
| --- | --- | --- |
| **physical sheet columns** | header cells on the live sheet: the legacy v7 block plus the appended V2 block | 90, becoming 91 |
| **V2 lifecycle columns** | `RESERVATION_HEADERS`, what the runtime addresses by name | 57 in BRIDGE, 58 in FINAL |

The live sheet is `v7_compat`, not `v2_native`: its base columns kept the Spanish
names of the Google Form it grew from, the Flow columns were appended in English,
and the 57 V2 lifecycle columns were appended after that. The runtime resolves
V2 columns by name, so the physical width is not something it depends on. Never
report the physical width as the schema width.

| V2 columns on the sheet | Runtime | Result |
| --- | --- | --- |
| 57 present | BRIDGE (57 headers) | healthy |
| 57 present | FINAL (58 headers) | `SCHEMA_NOT_READY` — inspectable and migratable, no business write |
| 58 present | FINAL (58 headers) | healthy |
| 58 present | **BRIDGE (57 headers)** | healthy — the extra column is read-through |

That last row is the point. It is what makes rollback non-destructive, and it is
why the bridge must be deployed **before** the sheet is widened. For a
`v7_compat` sheet the tolerance comes for free, because columns resolve by name;
the explicit allowlist is what extends the same guarantee to a `v2_native`
sheet, where width is exact.

**Stage 1 — BRIDGE.**

1. Build staging from the bridge commit and push (steps 2–3).
2. Create the version and repoint the existing Web App (steps 8–9).
3. Confirm Production is healthy on the sheet as it stands, before any append.
   Money behaviour
   is unchanged by design, so the no-charge smoke must look exactly as before.
4. Record this version. **It is the rollback target for stage 2.**

**Stage 2 — widen the sheet, then FINAL.**

1. `productionSchemaMigrationDryRun_()` — read-only. It reports the append plan
   and the backfill counters. No cell values, no row PII.
2. Read `amountUnknownActiveRows`. It counts reservations that are paid, not
   cancelled and still ahead of the clock, and that cannot prove their own amount
   from stored history. **If it is not zero, stop.** Those bookings would lose
   their automated refund path, and a patient's refund must not silently become a
   manual-review ticket. Resolve them before continuing.
3. `migrateProductionV7SchemaToLifecycleV2_()` — appends the column and backfills
   `transaction_amount_clp` from the amount each row already stored in
   `priceClp`. Deterministic, idempotent, never from the catalog price. A row
   that cannot prove an amount keeps none.
4. Run it again: `idempotent=true`, `appendedCount=0`,
   `deterministicAmountBackfilled=0`.
5. Verify the BRIDGE is still healthy on the widened sheet. It must be, and
   confirming it is what proves the rollback target is live.
6. Build staging from the final commit, create the version, repoint.

**Rollback.** FINAL → BRIDGE, by repointing the Web App. No sheet edit, at any
point, in either stage. Do not delete, reorder or rename a live column.

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

## 3b. Availability: the local day must exist

Confirmed in Production on 2026-09-06 and fixed the same day.

Chile moves the clock forward at 24:00 on a Saturday, so on that Sunday the
local day begins at 01:00 and **00:00 never happens**. `startAt_` refuses a
local time that does not exist, which is correct for a booking. The availability
window was anchored at local midnight, so on that one day every availability
request threw and the endpoint returned `REQUEST_REJECTED`.

The browser swallowed the failure, kept an empty occupied-list, and offered
every hour of every day as free. Selecting one produced `SLOT_TAKEN` on submit,
correctly, after the picker had already promised it. Nothing was charged and no
reservation row was written: the server revalidates under the lock before any
Flow call.

Three surfaces now hold the contract:

| Surface | Guarantee |
| --- | --- |
| `availabilityBounds_` | the window starts at the first instant of that local day that exists, still on that date |
| `_worker.js` | an upstream that answers but not with a slot list returns `ok:false` at 200, so the code survives instead of becoming an opaque edge 502 |
| `assets/booking.js` | an hour is selectable only for a date the server confirmed; any failure offers nothing and says so |

The date-less horizon read is a visual convenience for dimming full days. It
must never make an hour selectable.

**Holidays are the server's decision.** The list lived only in
`assets/booking.js` and `manage.html`, so the picker hid 18 September while the
server would have accepted a direct booking for it. `BOOKING_HOLIDAYS_CL` is now
in `CalendarGateway.js`: availability reports every working hour of a holiday as
occupied, and `assertBookableSlot_` refuses one outright. A client that
subtracts the occupied hours therefore needs no holiday list of its own; the
copies still shipped in the page are advisory, only for dimming a day before the
server has been asked, and a test fails if they ever drift from the server's.
Chile moves several of these by decree, so the list is explicit dates and has to
be updated by hand.

After any deploy that touches availability, check a spring-forward date
explicitly. `availability-dst-bounds.test.mjs` discovers the transitions from
the runtime's own timezone data rather than hardcoding them.

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

Production provider evidence, 2026-09-06 (§5A only; do not re-interpret as §5B):

- `FLOW_PAYMENT_E2E=PASS` — provider sample CLP 500, `payment/getStatus` status 2 (PAID)
- `FLOW_REFUND_E2E=BLOCKED_PROVIDER_FUNDS_501` — signed `refund/create` accepted and
  refused on merchant balance; 0 effective refunds. Flow requires available funds
  covering the refund amount **plus** the refund service fee (CLP 202 + IVA = CLP 240
  at the time of this run). The second authorized CLP 500 payment was not created;
  whether it would have cleared the condition is unverified.
- `BOOKING_APPLICATION_E2E=NOT_RUN` at that date — see the 2026-09-08 result next

Production booking-application evidence, 2026-09-08 (§5B, measured):

- `BOOKING_APPLICATION_E2E=PASS` — real public booking path on the Production
  runtime; one reservation bound to CLP 500 by a temporary, since-retired lane
  (public/catalog price 50000 untouched); `payment/create` 200; one real charge
  PAID and reconciled; booking confirmed once; Calendar + Meet; confirmation and
  reschedule emails once each; one reschedule (same event, Meet preserved);
  cancellation ≥ 24 h with slot released.
- `FLOW_REFUND_E2E=BLOCKED_WITH_PROVIDER_EVIDENCE` — exactly one `refund/create`
  for the bound 500, rejected by Flow; backend `PROVIDER_REFUND_REJECTED` →
  manual review; no refund-confirmation email; no automatic retry; no second
  attempt. The provider's response for this attempt was not retained, so no
  cause (funds, fee or otherwise) is asserted.
- Money: new charges 1 · gross 500 · refunded 0; one mistaken catalog-priced order
  created by a crossed Script Property in an earlier lane variant, never paid,
  expired at its 15-minute hold.
- Contract of record and details: `CANCELLATION_RESCHEDULE_POLICY_V2.md`,
  **Production booking E2E — 2026-09-08**.

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

Vocabulary note. `READY_FOR_PRODUCTION_DEPLOY_APPROVAL` and
`READY_FOR_PRODUCTION_RELEASE` are the pass/fail flags of the original RC
workflow (the PR #2 era). They describe Production readiness only; neither flag
authorizes or implies any Git merge, and Git canonicality is governed solely by
`AGENTS.md` (`production` canonical, `main` legacy).

`READY_FOR_PRODUCTION_DEPLOY_APPROVAL=YES` once the RC is complete locally, pushed,
and its PR documents the compatibility gates.

`READY_FOR_PRODUCTION_RELEASE=YES` only if:

- RC reviewed against `baseline/production-v7-full-20260831` (historical criterion,
  satisfied for the Policy V2 release)
- Binding **name** checks passed
- Remote fileset gate passed
- Schema dry-run + append-only migration + idempotent second run passed
- Triggers installed/verified with the deterministic operators, evidencing
  `cadenceVerification=INSTALL_METADATA_PLUS_TRIGGER_ID` and
  `runtimeCadenceIntrospection=false`
- Apps Script + Pages deployed as above
- No-charge smoke passed
- `FLOW_PROVIDER_MICRO_E2E` passed
- `BOOKING_APPLICATION_E2E` passed on the real booking path (measured 2026-09-08
  at a bounded CLP 500 with the public price at 50000; see §5)
- Refund micro-E2E passed **or** waived with recorded provider-side blocker
- Rollback to the **immediately previous verified immutable** Production version
  restated and still executable (for the current permanent runtime **v20** from
  `8455f3b` that is **v18** from `3d5a9a8`); `docs/production/v7/Código.js`
  remains the historical v7 recovery baseline only, not the immediate rollback

Measured status, 2026-09-08: every criterion above has Production evidence —
binding and fileset gates, schema migration and triggers (Policy V2 release),
Apps Script v20 + Pages deployed, no-charge smoke, `FLOW_PROVIDER_MICRO_E2E`
(2026-09-06), `BOOKING_APPLICATION_E2E` (2026-09-08), refund waived with the
recorded provider-side blocker, rollback v18 present and repointable. Declaring
`READY_FOR_PRODUCTION_RELEASE=YES` remains the release owner's decision; this
document does not make it. Three things are deliberately kept apart: the
measured Production state above; the current canonical Git state (`production`
at `8455f3b`, the source of the live v20); and the historical RC state (PR #2
draft and unmerged, separately governed). None depends on the others.

---

## 7. Exact rollback

1. Apps Script: point the existing versioned Web App deployment back to the **immediately previous verified immutable version** (read it from the deployment list before acting — do not assume a number; for the Policy V2 release it was **v9**; for the current permanent **v20** it is **v18**). Never repoint to `@HEAD`, and never to a TEMP lane version (v19, v21, v22). For a release that appended a reservation column, the rollback target is the BRIDGE version from §2.3a, and no sheet edit is required.
2. Pages: restore the previous Production deployment in Cloudflare (Deployments → previous Production → Rollback).
3. Do not change Script Properties or Flow keys as rollback.
4. Git: do not merge or canonicalize any in-flight release while a rollback is
   underway. `production` stays canonical; `main` (legacy lineage) is untouched.
5. Never redeploy artifact `28b1b8e` as Production baseline.

---

## 8. Cleanup

- Delete Flow micro-E2E test payments/refunds in Flow.
- Delete corresponding test Sheet rows / Calendar events if any were created.
- Do not leave test emails in the patient-facing mailbox narrative.

---

## 9. Git canonicality after Production verification

Governed by `AGENTS.md`; restated here only so this runbook cannot be read
against it:

1. Work is canonical only once merged through an authorized PR into
   `production`. The live v20 runtime is canonical `8455f3b`, merged that way
   (PR #11). Docs-only PRs against `production` never authorize a runtime deploy.
2. `main` is legacy lineage (`legacy/main-pre-production-lineage-20260905`). It
   receives no new merges and is not a canonicalization target.
3. PR #2 (`feat/production-booking-lifecycle-v2-port`) is the historical
   lifecycle RC: draft, unmerged, separately governed. Merging, retargeting or
   closing it needs its own authorization and is not part of any release gate.
4. Do not delete `baseline/production-v7-20260831`,
   `baseline/production-v7-full-20260831` or the legacy lineage branch.
5. Tagging a verified Production SHA (for example `production-lifecycle-v2-<date>`
   on the canonical merge commit) is optional and happens after the live smoke
   stays green.

# Production booking backend

Runtime source for this branch is the modular Apps Script bundle:

- `backend/appsscript/booking/Code.js`
- `backend/appsscript/booking/Lifecycle.js`
- `backend/appsscript/booking/EmailTemplates.js`
- `backend/appsscript/booking/CalendarGateway.js`
- `backend/appsscript/booking/Reconciliation.js`
- `backend/appsscript/booking/RefundGateway.js`
- `backend/appsscript/booking/TriggerInstallGuard.js`

Do not clasp-push `docs/production/v7/Código.js` together with this bundle.
That file is the recovered live Production v7 monolith, kept only as provenance.

## Datastore

Production sheets:

- `Respuestas de formulario 1` — preferred live reservation sheet
- `reservations` — the only supported equivalent existing-sheet alias, resolved
  solely when the preferred sheet is absent
- `notification_outbox`

Store ID is `BOOKING_STORE_ID`, with `SHEET_ID` accepted as an alias.
Runtime values (Flow keys, store ID, Calendar ID, Web App URL, token secrets)
stay in Script Properties. They are not in Git.

## Product contracts

- Initial and follow-up price: CLP 50,000
- Slot hold: 15 minutes from initial payment-order creation
- Flow `timeout` and `checkout_timeout`: remaining hold, capped at 900 seconds
- Retry never resets or extends the original hold
- Refund policy: `BUSINESS_POLICY_TBD` (no automatic Flow refund)

## Lifecycle triggers

`TriggerInstallGuard.js` owns lifecycle trigger installation and verification
(`installProductionLifecycleTriggersDeterministic_` /
`verifyProductionLifecycleTriggersDeterministic_`).

An installed Apps Script `Trigger` does not expose its clock cadence, so
cadence is never read back at runtime (`runtimeCadenceIntrospection=false`).
Cadence proof is `cadenceVerification=INSTALL_METADATA_PLUS_TRIGGER_ID`: the
installer calls `everyMinutes(5)`, persists non-secret install metadata in
`PRODUCTION_LIFECYCLE_TRIGGER_INSTALL_META_V1`, and verification requires each
current trigger unique ID and `TriggerSource.CLOCK` to match that metadata.

Rerunning the installer is convergent, not identity-preserving: it recreates
both target trigger IDs and leaves exactly one current trigger per handler.

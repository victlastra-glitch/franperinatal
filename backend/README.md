# Production booking backend

Runtime source for this branch is the modular Apps Script bundle:

- `backend/appsscript/booking/Code.js`
- `backend/appsscript/booking/Lifecycle.js`
- `backend/appsscript/booking/EmailTemplates.js`
- `backend/appsscript/booking/CalendarGateway.js`
- `backend/appsscript/booking/Reconciliation.js`
- `backend/appsscript/booking/RefundGateway.js`

Do not clasp-push `docs/production/v7/Código.js` together with this bundle.
That file is the recovered live Production v7 monolith, kept only as provenance.

## Datastore

Production sheets:

- `reservations`
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

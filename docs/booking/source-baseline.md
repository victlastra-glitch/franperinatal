# Source baseline y delta de BUILD & REVIEW

## Identidad

- Rama de trabajo: feat/nonprod-booking-lifecycle-20260823.
- HEAD inicial esperado: 55d63bf61fdc03550f4f5effe01a813f0f783791.
- Fuente local sanitizada: backend/appsscript/booking/.
- No se versionan .clasp.json, IDs, deployment IDs, URLs privadas, Script Properties, recipients reales, reservas ni datos clínicos.

## Schema

RESERVATION_HEADERS mantiene 57 columnas y no usa status ni flow_status como truth. Incluye booking/payment/refund/schedule separados, Calendar event id/etag/updated/hash/link key, Meet fields, capabilities y outbox/reconciliation fields. La sync token de Calendar pertenece a un estado de reconciliación global (syncState adapter), no a una reserva individual.

No se ejecutó bootstrapNonprodSchema_() ni se modificó un datastore.

## Delta implementado

| Área | Archivos | Funciones principales |
|---|---|---|
| Lazy config | Code.js | readConfig_, readCapabilityConfig_, requireCapabilitySecret_, readRefundConfig_ |
| Atomicidad | Lifecycle.js, Code.js | withLifecycleLock_, patientRescheduleTransaction_, patientCancelTransaction_ |
| Calendar | CalendarGateway.js, Code.js | createCalendarGateway_, availability_, applyConfirmedSideEffects_ |
| Reconciliation | Reconciliation.js | reconcileCalendarChange_, reconcileCalendarSync_ |
| Refund | RefundGateway.js, Code.js | createFlowRefundGateway_, refundCreateOnce_, refundCallbackOnce_ |
| Notifications | Lifecycle.js, Code.js | makeLifecycleNotification_, enqueueLifecycleNotification_ |
| Public boundary | _worker.js, manage.html, assets/booking.js | management proxies, allowlists, date/time contract |

## Seguridad y side effects

Todos los adapters reciben dependencias inyectables. Los tests usan stubs synthetic/no-network. No hubo llamadas a Calendar, Flow, MailApp/GmailApp, Apps Script remoto, Cloudflare, Preview ni producción.

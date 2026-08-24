# Source baseline y delta de BUILD & REVIEW

## Identidad

- Rama de trabajo: feat/nonprod-booking-lifecycle-20260823.
- HEAD esperado por la orden: 77052a87f670f341f290979a1b868989476a6e0f.
- HEAD observado al inicio: 9d52ba109cba78f91fb7610257761b6a60bfcc6d9; el remoto de la misma rama también apuntaba a ese SHA. No se hizo reset ni reescritura, por lo que el gate de identidad de entrada queda NOT_VERIFIED.
- Fuente local sanitizada: backend/appsscript/booking/.
- No se versionan .clasp.json, IDs, deployment IDs, URLs privadas, Script Properties, recipients reales, reservas ni datos clínicos.

## Schema

RESERVATION_HEADERS mantiene 57 columnas y no usa status ni flow_status como truth. No hubo delta de schema. Incluye booking/payment/refund/schedule separados, Calendar event id/etag/updated/hash/link key, Meet fields, capabilities y outbox/reconciliation fields. La sync token de Calendar pertenece a un estado de reconciliación global (syncState adapter), no a una reserva individual.

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
| Remediación consolidada | CalendarGateway.js, Reconciliation.js, RefundGateway.js, Lifecycle.js, Code.js, manage.html, _worker.js | provider contracts, ETag/412 saga, pagination/cursor safety, refund manual review, durable CTA rotation |

## Seguridad y side effects

Todos los adapters reciben dependencias inyectables. Los tests usan stubs synthetic/no-network. No hubo llamadas a Calendar, Flow, MailApp/GmailApp, Apps Script remoto, Cloudflare, Preview ni producción.

Validación local adicional: Phase A 108 assertions; lifecycle adversarial 49 casos y 51 assertions, incluyendo los casos explícitos de remediación/provider-contract; provider-contract tests 13; Worker structure/routes/payment-status privacy, boundary, artifact y documentación en PASS. La autorización/availability real del Advanced Service, Meet persistence, Flow Sandbox, outbox delivery y E2E siguen sin verificarse.

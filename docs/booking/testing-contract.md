# Testing contract — BUILD & REVIEW

## Tests locales no-network

node backend/appsscript/booking/test/phase-a.test.mjs
NO_NETWORK_TESTS=PASS count=108

node backend/appsscript/booking/test/lifecycle.test.mjs
ADVERSARIAL_LIFECYCLE_TESTS=PASS count=25

El harness carga Code.js, Lifecycle.js, CalendarGateway.js, Reconciliation.js y RefundGateway.js en VM. Stubbea PropertiesService, SpreadsheetApp, CalendarApp, Advanced Calendar, LockService, UrlFetchApp y mail; no lee .env, no usa datos de reserva ni contacta servicios externos.

## Matriz cubierta

1. FreeBusy manual, overlap parcial, back-to-back y all-day.
2. Unión Calendar + datastore sin doble ocupación.
3. Calendar failure sin fallback de disponibilidad.
4. Evento idempotente, retry, update mismo evento, ETag y Meet preservation.
5. syncToken expirado/410 y full-sync reset.
6. Clinician move/cancel, quota intacta, stale event y loop protection.
7. Patient reschedule x1, lock/fresh reload y segundo intento rechazado.
8. Patient cancel idempotente y agenda libre independiente de refund.
9. Refund order determinista, duplicate callback y timeout status-only.
10. Outbox/CTA inicial y CANCEL-only post-reschedule.
11. Linkage privado sin PII y Worker management response sin PII.

## Worker y artefacto

node scripts/assert-nonprod-worker-structure.mjs _worker.js
node scripts/test-nonprod-worker-routes.mjs
node scripts/test-nonprod-payment-status-privacy.mjs

Los handlers permitidos para upstream son availability, payment create, flow confirmation, payment status, manage lookup/cancel/reschedule y refund confirmation. /backend/* sigue bloqueado y el artefacto público excluye backend/.

## Gates no ejecutables

No se declara PASS para Calendar real, Meet persistence, Flow Sandbox, email, schema bootstrap, Preview, Web App runtime, Browser E2E ni producción. Esos son requisitos del NONPROD ACTIVATION & E2E posterior a la revisión Claude.

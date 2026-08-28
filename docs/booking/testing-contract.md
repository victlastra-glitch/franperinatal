# Testing contract — BUILD & REVIEW

## Reloj de prueba determinista

Los harness VM que ejercen lead-time / horizonte (`createFlowPayment_`, `assertBookableSlot_` sin `nowMs`) inyectan `createFixedDate()` desde `backend/appsscript/booking/test/helpers/fixed-date.mjs`.

Contrato congelado:

```
FIXED_TEST_NOW=2026-08-25T13:00:00.000Z
```

Ese instante es martes 2026-08-25 09:00 America/Santiago (CLT, UTC-4). `Date.now()` y `new Date()` sin argumentos dentro del VM usan ese valor. `new Date(value)`, `Date.parse` y `Date.UTC` conservan semántica nativa.

La suite no depende del reloj del workstation. No hay que avanzar fechas de reserva cada semana. El fixture canónico bookeable es jueves `2026-08-27`; los harness de lifecycle sintético pueden seguir usando `2026-09-03` porque también queda dentro de lead-time y horizonte respecto del reloj congelado.

Producción no cambia: `assertBookableSlot_(date, time)` sigue usando `Date.now()` cuando `nowMs` se omite. `CREATE_FLOW_FIELDS` no incluye `now` / `nowMs` / `testNow` / `clock`. Ningún payload público controla el tiempo del servidor.

Prueba de independencia:

```
node backend/appsscript/booking/test/booking-clock-contract.test.mjs
TEST_CLOCK_HOST_INDEPENDENCE=PASS
```

## Validación local only

GitHub Actions hosted minutes no están disponibles. Toda la validación de este gate corre en local: tests Node del árbol booking, scripts `scripts/test-*.mjs` / `scripts/assert-*.mjs`, `bash scripts/validate-nonprod-boundary.sh` y `bash scripts/validate-recovery-docs.sh`. No se declara un nuevo NONPROD runtime PASS.

Los scripts de validación fallan cerrado si falta la herramienta de búsqueda. Prefieren `rg` y, si no está, un fallback `grep` con la misma semántica de match. Un `rg` ausente nunca imprime `VALIDATION_PASS` salvo que el fallback equivalente se haya ejecutado. Si faltan `rg` y `grep`, el exit es `TOOL_MISSING` ≠ 0.

## Tests locales no-network

node backend/appsscript/booking/test/phase-a.test.mjs
NO_NETWORK_TESTS=PASS count=127

node backend/appsscript/booking/test/booking-clock-contract.test.mjs
BOOKING_CLOCK_CONTRACT_TESTS=PASS
TEST_CLOCK_HOST_INDEPENDENCE=PASS

node backend/appsscript/booking/test/lifecycle.test.mjs
ADVERSARIAL_LIFECYCLE_TESTS=PASS cases=49 assertions=62
PROVIDER_CONTRACT_TESTS=PASS count=13

node backend/appsscript/booking/test/notification-outbox-worker.test.mjs
OUTBOX_TRIGGER_TESTS=PASS assertions=92

node backend/appsscript/booking/test/notification-outbox-sheet.test.mjs
SHEET_BACKED_OUTBOX_WORKER=PASS
EXISTING_NONPROD_SCHEMA_COMPATIBILITY=PASS

node backend/appsscript/booking/test/sequential-notification-harness.test.mjs
SEQUENTIAL_NOTIFICATION_HARNESS_TESTS=PASS

node backend/appsscript/booking/test/no-drain-notification-harness.test.mjs
NO_DRAIN_NOTIFICATION_HARNESS_TESTS=PASS

node backend/appsscript/booking/test/pre-transaction-contract.test.mjs
PRE_TRANSACTION_CONTRACT_TESTS=PASS

node backend/appsscript/booking/test/flow-contract.test.mjs
FLOW_CONTRACT_TESTS=PASS

node backend/appsscript/booking/test/lifecycle-harness.test.mjs
LIFECYCLE_HARNESS_TESTS=PASS

node backend/appsscript/booking/test/calendar-metadata-reconciliation.test.mjs
CALENDAR_METADATA_RECONCILIATION_TESTS=PASS

El harness carga Code.js, Lifecycle.js, CalendarGateway.js, Reconciliation.js y RefundGateway.js en VM. Stubbea PropertiesService, SpreadsheetApp, CalendarApp, Advanced Calendar, LockService, ScriptApp, UrlFetchApp y mail; no lee .env, no usa datos de reserva ni contacta servicios externos.

## Matriz cubierta

1. FreeBusy manual, overlap parcial, back-to-back y all-day.
2. Unión Calendar + datastore sin doble ocupación.
3. Calendar failure sin fallback de disponibilidad.
4. Evento idempotente, retry, update mismo evento, ETag y Meet preservation.
5. syncToken expirado/410 y full-sync reset.
6. Clinician move/cancel, quota intacta, stale event y loop protection.
6b. Metadata-only Calendar evolution (etag/updated/Meet materialization, ISO offset equivalent) is not CLINICIAN_RESCHEDULED; genuine start/end change still is; patient-move incremental follow-up stays non-clinician; cancellation and stale handling unchanged.
7. Patient reschedule x1, lock/fresh reload y segundo intento rechazado.
8. Patient cancel idempotente y agenda libre independiente de refund.
9. Refund order determinista, duplicate callback y timeout manual_review.
10. Outbox/CTA inicial y CANCEL-only post-reschedule.
11. Calendar exact signatures, ETag/If-Match/412, saga failures con snapshot de reconciliación, pagination/cursor, linkage, FreeBusy self-event y DST.
12. Flow refund verb/signature fidelity, ambiguous create manual review y callback replay.
13. Durable CTA retry por rotación de capability y contrato frontend `code`.
14. Linkage privado sin PII y Worker management response sin PII.
15. Outbox worker: batch acotado sobre `notification_outbox_nonprod`, allowlist, CTA matrix, rotación, max attempts, lock ownership (`lockAlreadyHeld`), installer/removal idempotente sin crear triggers reales, supersession explícita, reclaim de `claimed`, occurrence identity por `source_operation_id`, y marking terminal `max_attempts` en el mismo ciclo.
16. Pre-transaction: runtime Meet request, preservación de conferencia en reschedule, validación server-side de slot, FreeBusy bajo lock, `SLOT_TAKEN` sin fila ni Flow.
17. Flow create: commerceOrder defensive bound, amount=500 (≥ Flow FAQ minimum >350), signature/form contract, safe failure classes, hold release, idempotent replay, operator abandon.
18. High-level lifecycle harness: create → confirm → Meet/outbox → reschedule → clinician move → cancel → refund → notification retry.
19. Sequential notification harness: confirmed+paid → confirmation send/replay → patient reschedule send/replay (CANCEL-only) → clinician reschedule send/replay (CANCEL-only) → cancel send/replay (no Meet, no CTA) → max-attempt event does not poison a later logical event. Patient-facing times are America/Santiago and independent of machine timezone.
20. No-drain notification harness: confirm → reschedule → clinician move → cancel without a worker run between mutations; four durable identities survive; unsent non-cancel events are explicitly superseded; cancellation still sends. Snapshot render keeps the patient-reschedule local time after a later clinician move.
21. Sheet-backed outbox worker: `ensureNotificationOutboxSheet_` on an existing `reservations_nonprod` spreadsheet with absent `notification_outbox_nonprod` creates the current header schema without changing reservation rows, then enqueue/process reaches terminal `sent`.
22. Occurrence identity: same source mutation → one row; `CLINICIAN_RESCHEDULED` to B, another clinician mutation, then back to B are distinct; same snapshot_start_at is not replay. Strict lock fake tracks acquire/release ownership and fails nested caller-lock release.
23. Deterministic VM test clock: lead-time, 90-day horizon and weekend rejection are independent of host `Date.now()`; no public payload field can override server time.

## Worker y artefacto

node scripts/assert-nonprod-worker-structure.mjs _worker.js
node scripts/test-nonprod-worker-routes.mjs
node scripts/test-nonprod-payment-status-privacy.mjs

Los handlers permitidos para upstream son availability, payment create, flow confirmation, payment status, manage lookup/cancel/reschedule y refund confirmation. /backend/* sigue bloqueado y el artefacto público excluye backend/.

## Gates no ejecutables

No se declara PASS para Calendar real, Meet persistence, Flow Sandbox, email runtime, schema bootstrap, Preview, Web App runtime, Browser E2E, instalación real del trigger de outbox ni producción. Esos son requisitos del NONPROD ACTIVATION & E2E posterior.

La suite de provider contract usa fakes que rechazan `Events.update(calendarId, eventId, resource)`, `Events.delete` y `refund/getStatus` por POST. El schema de reserva conserva 57 headers y no agregó campos; la cola durable vive en `notification_outbox_nonprod` (20 columnas, incluyendo `source_operation_id`, sin bearers ni PII). Replay identity is source mutation, not `snapshot_start_at`. Cada retry rota la capability hash-at-rest bajo el lock ya owned por el worker (`lockAlreadyHeld`) y retorna el bearer sólo al dispatcher. MailApp delivery remains at-least-once in the send-then-crash window. Vaciar el outbox entre mutaciones no es requisito de corrección. La persistencia de cursor también falla cerrado si `syncState.set` no completa. El installer `installNonprodNotificationRetryTrigger_` queda en source only (`everyMinutes(5)` → `processLifecycleNotificationOutbox_`) y no se ejecutó.

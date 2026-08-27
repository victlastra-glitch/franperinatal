# Booking lifecycle — BUILD & REVIEW local bundle

Este directorio describe la implementación local sanitizada de la macro-fase BUILD & REVIEW. No es autorización para bootstrap, Script Properties, deploy, Preview, Calendar, Flow, email, Cloudflare, producción ni datos reales.

## Estado

BUILD_AND_REVIEW_LOCAL_IMPLEMENTATION = PASS queda condicionado a los gates locales de testing-contract.md.

READY_FOR_FINAL_CLAUDE_BUILD_REVIEW = YES.

READY_FOR_NONPROD_ACTIVATION = NO: Meet persistence, Advanced Calendar activation, exact NONPROD runtime linkage, schema bootstrap, Flow Sandbox, email/outbox trigger install y E2E requieren el gate operativo siguiente.

## Arquitectura local

- Code.js: entrypoints Apps Script, configuración base/lazy, schema, payment existente, disponibilidad ocupada, side effects idempotentes, management, outbox worker y delivery adapter NONPROD.
- Lifecycle.js: estados separados, capabilities opacas, LockService transaction boundaries, outbox primitives, CTA matrix y reconstrucción segura de event type.
- CalendarGateway.js: FreeBusy, evento enlazado, mismo-evento update/remove, ETag/If-Match/412, syncToken/410 paginado, linkage privado y Meet primitives.
- Reconciliation.js: sync incremental, clinician move/cancel y loop protection por ETag/hash/operation.
- RefundGateway.js: Flow Sandbox adapter, contratos create/getStatus/cancel, deterministic internal order, manual review ante timeout ambiguo, callback y retry sin segundo create.
- _worker.js: same-origin availability, payment, management y refund callback proxies; upstream privado, APP_ENV nonprod y response allowlists.

## Notification outbox retry (source-only)

- Worker: `processLifecycleNotificationOutbox_`
- Delivery adapter: `deliverLifecycleNotification_` (MailApp; allowlist + `+nonprod` only)
- Max attempts: `MAX_NOTIFICATION_ATTEMPTS = 5`; after that → `reconciliation_state=notification_max_attempts`
- Batch: max 10 pending/failed rows per invocation
- Capability rotation: each retry calls `retryLifecycleNotification_` under lock; prior bearer of that CTA type becomes invalid; raw bearer never persisted
- Trigger handler: `processLifecycleNotificationOutbox_`
- Installer: `installNonprodNotificationRetryTrigger_` (idempotent, `everyMinutes(5)`)
- Removal: `removeNonprodNotificationRetryTrigger_`
- Trigger is NOT installed yet; runtime E2E still required
- Schema delta: none (57 headers)

## Reglas

Booking, payment, schedule y refund son dominios independientes. Cancelar libera agenda antes de que termine refund. La política permanece BUSINESS_POLICY_TBD; no hay ventana 24/48h hardcodeada.

RESCHEDULE y CANCEL son capabilities distintas, opacas, HMAC-at-rest, expirables y revocables. RESCHEDULE se consume como máximo una vez. El límite de autorización es la transacción bajo LockService, que recarga el record autoritativo dentro del lock.

Calendar es la fuente de busy/free; datastore es la fuente de lifecycle. La disponibilidad pública conserva el shape { ok, slots: [{ date, time }] } y representa slots ocupados para compatibilidad con el browser existente. Cada slot se bloquea por la unión deduplicada de FreeBusy y reservas activas; una falla Calendar no devuelve disponibilidad.

El extendedProperties.private sólo contiene source=fran_booking, un link_key opaco y schema=fran_booking:v1. No contiene nombre, email, RUT, teléfono, motivo, diagnóstico ni texto clínico.

## BK traceability

| BK | Implementación local | Estado |
|---|---|---|
| BK-001 | CalendarGateway.js, computeOccupiedSlots_, availability_ | PASS local / Sandbox pendiente |
| BK-002 | createLinkedBookingEvent, calendar_link_key, idempotent lookup | PASS local / Sandbox pendiente |
| BK-003 | Reconciliation.js, clinician move, outbox | PASS local / Calendar E2E pendiente |
| BK-004 | clinician cancel + separate refund policy boundary | PASS local / policy+Sandbox pendiente |
| BK-005 | same-event update + Meet fields | PASS foundation / persistence pendiente |
| BK-006 | makeLifecycleNotification_, outbox worker + delivery adapter | PASS local / trigger install+E2E pendiente |
| BK-007 | patientRescheduleTransaction_, count x1 | PASS local / E2E pendiente |
| BK-008 | revocation + CANCEL-only follow-up | PASS local / E2E pendiente |
| BK-009 | clinician operation does not touch patient quota | PASS local |
| BK-010 | patientCancelTransaction_, idempotency and schedule release | PASS local / E2E pendiente |
| BK-011 | RefundGateway.js, separate refund state | PASS local / Flow Sandbox pendiente |
| BK-012 | independent opaque capabilities and lazy secret | PASS local |
| BK-013 | gateway/datastore boundary | PASS local / integration pendiente |
| BK-014 | reconciliation states, outbox worker, manual review | PASS local / trigger runtime pendiente |
| BK-015 | linkage/Worker/artifact privacy tests | PASS local |

## Propiedades nuevas

Sólo nombres, nunca valores versionados:

- CAPABILITY_TOKEN_SECRET — lazy, requerido únicamente para issue/verify.
- FLOW_REFUND_CALLBACK_URL — lazy, requerido únicamente por refund callback.

Calendar Advanced Service queda declarado en appsscript.json, pero no ha sido activado ni invocado en este repositorio.

## Delta consolidado

- Provider signatures: `Freebusy.query(resource)`, `Events.get(calendarId,eventId,optionalArgs)`, `Events.list(calendarId,optionalArgs)`, `Events.insert(resource,calendarId,optionalArgs)`, `Events.update(resource,calendarId,eventId,optionalArgs,optionalHeaders)`, `Events.remove(calendarId,eventId,optionalArgs)`.
- Calendar saga: fresh ETag compare, `If-Match`, HTTP 412 and explicit reconciliation; Calendar/Sheet are not treated as one atomic transaction.
- Sync: all pages and event processing complete before cursor advance; unresolved outcomes retain the old cursor.
- CTA retry: no new schema field; one active hash-at-rest per CTA/type/version is rotated under LockService, replacing the previous hash so the old bearer stops validating. Raw bearers are returned only to the immediate dispatcher and never written to outbox/logs.
- Outbox worker: `processLifecycleNotificationOutbox_` processes a bounded pending/failed batch (max 10), reconstructs event type from the lifecycle outbox key, rotates CTAs when needed, delivers via `deliverLifecycleNotification_`, and stops after `MAX_NOTIFICATION_ATTEMPTS=5`. Enqueue idempotency is scoped to that logical key so a later lifecycle event can queue after a prior `sent` patient notification. Installer `installNonprodNotificationRetryTrigger_` / `removeNonprodNotificationRetryTrigger_` prepare a 5-minute NONPROD time-driven trigger; not installed yet.
- Partial failure: every cross-provider boundary returns an explicit reconciliation/manual-review code and an operation-bound snapshot; a retry must reconcile the recorded Calendar outcome before another destructive action.
- Timezone: Chile slot labels use `America/Santiago` timezone-aware conversion across DST transitions; no permanent UTC-04 offset is assumed.
- Final schema header count: 57; schema fields added: none.
- Runtime authorization, Meet persistence, Flow Sandbox, trigger install, Preview and E2E remain intentionally unverified.

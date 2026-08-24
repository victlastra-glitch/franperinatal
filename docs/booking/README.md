# Booking lifecycle — BUILD & REVIEW local bundle

Este directorio describe la implementación local sanitizada de la macro-fase BUILD & REVIEW. No es autorización para bootstrap, Script Properties, deploy, Preview, Calendar, Flow, email, Cloudflare, producción ni datos reales.

## Estado

BUILD_AND_REVIEW_LOCAL_IMPLEMENTATION = PASS queda condicionado a los gates locales de testing-contract.md.

READY_FOR_FINAL_CLAUDE_BUILD_REVIEW = YES.

READY_FOR_NONPROD_ACTIVATION = NO: Meet persistence, Advanced Calendar activation, exact NONPROD runtime linkage, schema bootstrap, Flow Sandbox, email/outbox delivery y E2E requieren la revisión independiente y el gate operativo siguiente.

## Arquitectura local

- Code.js: entrypoints Apps Script, configuración base/lazy, schema, payment existente, disponibilidad ocupada, side effects idempotentes y management.
- Lifecycle.js: estados separados, capabilities opacas, LockService transaction boundaries, outbox y CTA matrix.
- CalendarGateway.js: FreeBusy, evento enlazado, mismo-evento update, delete, ETag/hash, syncToken/410, linkage privado y Meet primitives.
- Reconciliation.js: sync incremental, clinician move/cancel y loop protection por ETag/hash/operation.
- RefundGateway.js: Flow 3.0.1 Sandbox adapter, deterministic order, status/callback/cancel y retry sin segundo create.
- _worker.js: same-origin availability, payment, management y refund callback proxies; upstream privado, APP_ENV nonprod y response allowlists.

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
| BK-006 | makeLifecycleNotification_, initial CTA matrix | PASS local / delivery pendiente |
| BK-007 | patientRescheduleTransaction_, count x1 | PASS local / E2E pendiente |
| BK-008 | revocation + CANCEL-only follow-up | PASS local / E2E pendiente |
| BK-009 | clinician operation does not touch patient quota | PASS local |
| BK-010 | patientCancelTransaction_, idempotency and schedule release | PASS local / E2E pendiente |
| BK-011 | RefundGateway.js, separate refund state | PASS local / Flow Sandbox pendiente |
| BK-012 | independent opaque capabilities and lazy secret | PASS local |
| BK-013 | gateway/datastore boundary | PASS local / integration pendiente |
| BK-014 | reconciliation states, outbox, manual review | PASS local / retry runtime pendiente |
| BK-015 | linkage/Worker/artifact privacy tests | PASS local |

## Propiedades nuevas

Sólo nombres, nunca valores versionados:

- CAPABILITY_TOKEN_SECRET — lazy, requerido únicamente para issue/verify.
- FLOW_REFUND_CALLBACK_URL — lazy, requerido únicamente por refund callback.

Calendar Advanced Service queda declarado en appsscript.json, pero no ha sido activado ni invocado en este repositorio.

# Booking lifecycle — Phase A

Phase A establece la canonicalización Git del backend Apps Script NONPROD y
los contratos locales de estado, schema, capabilities, outbox e idempotencia.
No ejecuta bootstrap de schema ni habilita Calendar, Meet, Flow refund, email,
Preview, producción o endpoints públicos de gestión.

## Índice BK-001..BK-015

| Requisito | Fundación de esta fase | Gate posterior |
|---|---|---|
| BK-001 | estados de agenda separados de booking/payment | Calendar FreeBusy |
| BK-002 | `calendar_event_id` en schema | creación idempotente verificada |
| BK-003 | `calendar_change_source` y reconciliación en contrato | Calendar Sandbox |
| BK-004 | `refund_status` independiente | cancelación/refund Sandbox |
| BK-005 | campos Meet en schema | evento Calendar Sandbox |
| BK-006 | capacidades RESCHEDULE/CANCEL y outbox | email lifecycle |
| BK-007 | contador `patient_reschedule_count` y helper one-shot | endpoint autenticado |
| BK-008 | revocación/versionado de capability | endpoint + email |
| BK-009 | operación clinician separada | reconciliación Calendar |
| BK-010 | transición booking/schedule separada de refund | cancelación Sandbox |
| BK-011 | dominio refund independiente e idempotente | Flow refund |
| BK-012 | token opaco, expirable, revocable, hash-at-rest | endpoint público |
| BK-013 | Calendar y Datastore separados por contrato | integración Sandbox |
| BK-014 | outbox claim/retry/manual-review primitives | workers/reconciliación |
| BK-015 | privacy scan, metadata opaca y fixtures sintéticos | QA Sandbox |

## División de source of truth

- El Brain de Google Drive conserva los requisitos de producto y decisiones
  ratificadas BK-001..BK-015.
- Este repositorio conserva el source técnico sanitizado, el schema nominal,
  los estados, interfaces locales y pruebas reproducibles.
- Apps Script remoto, Script Properties, Sheets, Calendar, Flow y los aliases
  de Preview siguen siendo estado operativo externo. Esta fase no los modifica.

Documentos técnicos relacionados:

- [source-baseline.md](source-baseline.md)
- [state-model.md](state-model.md)
- [testing-contract.md](testing-contract.md)
- [backend/appsscript/booking/Code.js](../../backend/appsscript/booking/Code.js)
- [backend/appsscript/booking/Lifecycle.js](../../backend/appsscript/booking/Lifecycle.js)
- [backend/appsscript/booking/test/phase-a.test.mjs](../../backend/appsscript/booking/test/phase-a.test.mjs)

## Fases

1. Phase A: source, schema y contratos locales — este cambio.
2. Phase B: Calendar FreeBusy, metadata privada, ETag, update/delete y
   reconciliación en Sandbox.
3. Phase C: Meet, cancel/reschedule autenticado y lifecycle de notificaciones.
4. Phase D: Flow refund y reconciliación de pagos.
5. Phase E: UAT NONPROD y release gate humano.

## Seguridad y no-touch

El source Git está sanitizado: no incluye `.clasp.json`, IDs, deployment IDs,
URLs de Web App, credenciales, recipients reales, reservas ni datos clínicos.
El build público de Preview usa una lista explícita de archivos y no incluye
`backend/`. No se ejecutó `bootstrapNonprodSchema_`.

Producción, Candidate A, Apps Script remoto, Calendar, Flow, email, Cloudflare
y Preview permanecen fuera del alcance y sin mutaciones.

## Traceability delta

Phase A afecta BK-001..BK-015 en calidad de foundation y no declara readiness
de integración. El commit de implementación es `5afb27d` y se mantiene
separado de cualquier despliegue.

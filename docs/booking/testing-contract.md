# Testing contract — Phase A

## Harness

El harness es local y no-network:

- `backend/appsscript/booking/test/phase-a.test.mjs`
- carga `Code.js` y `Lifecycle.js` en un VM aislado;
- stubbea `PropertiesService`, `SpreadsheetApp`, `CalendarApp`, `MailApp`,
  `GmailApp`, `LockService`, `UrlFetchApp`, `Utilities`, `Session` y
  `ContentService`;
- no lee `.env`, no usa Apps Script, no contacta Calendar, Flow, Sheets ni
  email, y no escribe datos de reserva.

## Invariant-to-test mapping

| Área | Invariantes cubiertos |
|---|---|
| State | transiciones válidas, backwards/illegal fail-closed, independencia de dominios, booking cancelado con refund pendiente |
| Schema | 55 headers exactos, sin duplicados, campos lifecycle presentes, ausencia de `status`/`flow_status` como columnas |
| Capabilities | entropy, hash-at-rest, tipo, expiración, revocación, versión, malformed, comparación y no PII |
| Reschedule | count 0 permite, claim consume a 1, count 1 y capability stale rechazan |
| Outbox | key estable, claim determinista, retry de fallo, no duplicación tras sent, log sin detalles clínicos |
| Idempotency | `operation_id` repetido devuelve replay sin ejecutar dos veces |
| Privacy | token/capability/operation opacos; no nombres, RUT, teléfono, email clínico o texto clínico en metadata |

## Comando y resultado esperado

```text
node backend/appsscript/booking/test/phase-a.test.mjs
NO_NETWORK_TESTS=PASS count=64
```

También se ejecuta `node --check` sobre ambos archivos Apps Script.

## Gates futuros

Antes de Phase B deben existir tests Sandbox independientes para:

- FreeBusy contra eventos busy creados fuera del booking;
- un único evento por booking y metadata privada opaca;
- move/delete con ETag y `syncToken`, incluyendo 410 y reconciliación;
- Meet en el mismo evento;
- cancel/reschedule one-shot con datos sintéticos;
- Flow refund create/getStatus y callbacks idempotentes;
- outbox real con retry/manual review sin rollback de la operación primaria.

Ninguno de esos gates se ejecuta en Phase A.

## Privacidad y artefacto

El scan de source debe reportar exactamente:

```text
EMBEDDED_SECRET_FINDINGS=0
PII_VALUE_FINDINGS=0
PRIVATE_RESOURCE_ID_VALUE_FINDINGS=0
```

Los nombres estructurales de campos no cuentan como valores PII. Los fixtures
son sintéticos y no contienen recipients reales ni información clínica.

## Trazabilidad

Phase A afecta BK-001..BK-015 como foundation. Las funciones principales son
`transitionBooking_`, `transitionPayment_`, `transitionRefund_`,
`transitionSchedule_`, `createCapability_`, `verifyCapability_`,
`claimPatientReschedule_`, `createNotificationOutbox_`,
`claimNotificationOutbox_`, `completeNotificationOutbox_`,
`makeOperationId_` y `applyOperationOnce_`.

El SHA del commit de implementación queda registrado en el cierre técnico de
Git; no se interpreta como autorización de runtime o despliegue.

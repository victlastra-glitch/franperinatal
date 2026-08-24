# Source baseline y canonicalización

## Baseline aprobado

- Rama base: `recovery/production-source-20260821`
- Base HEAD: `5c46deb4998fe21fec751838344dd1269da0300a`
- Snapshot source file count: `2`
- Snapshot files: `Code.js`, `appsscript.json`
- Source fingerprint: `dac94ac07c5163dabc7128fc320f5781e53608231ec8c998dd6793ab0910a4c8`
- Function count informado por el snapshot: `44`
- Security scan del snapshot aprobado: secretos `0`, valores PII `0`, resource IDs privados literales `0`

El fingerprint es una referencia de procedencia del snapshot antes de la
implementación. Los archivos Git nuevos contienen la derivación local y no
pretenden ser una copia del estado remoto posterior.

## Canonicalización Git

La fuente sanitizada se conserva en:

- `backend/appsscript/booking/Code.js`
- `backend/appsscript/booking/appsscript.json`
- `backend/appsscript/booking/Lifecycle.js`

`Lifecycle.js` contiene únicamente primitives locales sin efectos externos.
El manifest no contiene identificadores privados. `.clasp.json`, Script IDs,
deployment IDs, URLs, properties, recipients y credenciales no se versionan.

El artefacto público se arma mediante
`scripts/build-nonprod-preview-artifact.sh`, cuya lista de copia no incluye
`backend/`; `scripts/validate-nonprod-boundary.sh` rechaza además la presencia
de `backend` en el artefacto construido.

## Schema observado antes de Phase A

El snapshot tenía `20` columnas:

```text
idempotency_key
booking_date
booking_time
reservation_id
service_type
modality
patient_email
payment_url
status
flow_token
commerce_order
status_token_hash
status_token_expires_at
calendar_event_id
calendar_effect_state
patient_email_state
internal_email_state
created_at
updated_at
flow_status
```

## Clasificación de funciones

| Clasificación | Funciones |
|---|---|
| KEEP | `doGet`, `doPost`, `readConfig_`, `flowRequest_`, `flowConfirmation_`, `paymentStatus_`, `reserveOnce_`, `sendOnce_` |
| EXTEND | `RESERVATION_HEADERS`, `assertSchema_`, `availability_`, `applyConfirmedSideEffects_`, `updateRecord_`, `validStatusToken_` |
| REFACTOR | `transition_` hacia `transitionBooking_`/`transitionPayment_`; `status` y `flow_status` hacia dominios explícitos; Calendar/email claim fields hacia schedule/outbox fields |
| ADD | `Lifecycle.js`: validators, capability primitives, one-reschedule invariant, operation IDs y outbox primitives |
| FUTURE, no Phase A | FreeBusy, ETag/syncToken reconciliation, Meet, public management routes, cancel/reschedule handlers y Flow refund |

## Legacy disposition

`status` y `flow_status` se eliminan del target schema. No son lifecycle truth
ni se usa una migración automática: el schema NONPROD aún no fue bootstrappeado.
La respuesta pública de payment status se deriva localmente desde
`booking_status` + `payment_status` para compatibilidad; no se persiste como
fuente primaria. No se ejecutó ninguna migración.

## Commit técnico

El commit de implementación Phase A se debe registrar aquí en el cierre Git
de la fase, junto con el SHA final informado por Codex. No existe autorización
para merge, push, deploy o mutación remota en este documento.

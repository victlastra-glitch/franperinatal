# State model — Phase A

Los cuatro dominios son independientes. Un cambio en uno no implica un cambio
automático en los otros; los adaptadores futuros deben coordinar operaciones
con `last_operation_id` y reconciliación explícita.

## BOOKING_STATUS

Valores canónicos:

```text
initiated
payment_pending
confirmed
cancellation_requested
cancelled
reconciliation_required
manual_review
```

Transiciones permitidas:

```text
initiated -> payment_pending | cancellation_requested | manual_review
payment_pending -> confirmed | cancellation_requested | reconciliation_required | manual_review
confirmed -> cancellation_requested | reconciliation_required | manual_review
cancellation_requested -> cancelled | reconciliation_required | manual_review
reconciliation_required -> manual_review
```

`cancelled` y `manual_review` son terminales en Phase A. Las transiciones
desconocidas, hacia atrás o no listadas fallan cerrado.

## PAYMENT_STATUS

```text
not_started -> pending | failed | unknown
pending -> paid | rejected | failed | unknown
unknown -> pending | paid | rejected | failed
```

`paid`, `rejected` y `failed` no mutan hacia atrás. Payment permanece separado
de booking: un booking cancelado puede conservar `paid` mientras refund sigue
su propio lifecycle.

## REFUND_STATUS

```text
not_required -> refund_requested | manual_review
refund_requested -> refund_pending | refund_failed | manual_review
refund_pending -> refunded | refund_failed | manual_review
refund_failed -> refund_requested | refund_pending | manual_review
```

Refund es idempotente y separado de la cancelación. La capacidad del slot no
debe depender de `refunded`.

## SCHEDULE_STATUS

```text
hold -> sync_pending | cancelled | reconciliation_required | manual_review
sync_pending -> scheduled | cancelled | reconciliation_required | manual_review
scheduled -> sync_pending | cancelled | reconciliation_required | manual_review
reconciliation_required -> sync_pending | manual_review
```

Calendar es la futura verdad busy/free; Datastore conserva el estado de
booking, schedule, pago, refund y capabilities. Phase A sólo prepara los
campos y validators; no llama Calendar.

## Capabilities

`RESCHEDULE` y `CANCEL` son tipos distintos. Cada capability tiene token opaco
de al menos 256 bits, hash HMAC-at-rest, expiración, versión y revocación. El
token no contiene reservation ID ni PII. La verificación responde de forma
uniforme ante tipo, versión, formato, expiración o revocación inválidos.

`patient_reschedule_count` parte en `0`. El helper de reschedule requiere
booking activo, count `0` y capability RESCHEDULE válida. Un claim exitoso
devuelve count `1` y una capability revocada; un segundo claim falla.

## Operaciones y outbox

`makeOperationId_` produce IDs opacos con tipo explícito entre:
`patient_reschedule`, `patient_cancel`, `clinician_reconcile_move`,
`clinician_reconcile_cancel`, `refund_create` y `notification`.
`applyOperationOnce_` hace replay seguro.

Cada notification outbox tiene key lógico estable, versión, `pending`/`claimed`/
`sent`/`failed`, contador de intentos, timestamps y resultado. Un error de
email no revierte booking, payment, refund ni schedule.

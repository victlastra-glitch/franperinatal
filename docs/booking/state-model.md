# State model — booking lifecycle local

## Dominios separados

booking_status, payment_status, schedule_status y refund_status no se infieren entre sí. Un booking cancelado puede seguir paid mientras refund está pendiente o en manual_review.

## Patient RESCHEDULE

LockService -> fresh load -> confirmed/paid/scheduled/count=0 -> reconstruct capability -> verify -> FreeBusy + datastore target recheck -> same-event Calendar update -> current start/end -> count=1 -> persistent revoke -> CANCEL-only notification.

El record entregado antes del lock nunca autoriza. Un segundo intento con el token antiguo o count 1 falla cerrado.

## Patient CANCEL

LockService -> fresh load -> already cancelled replay o verify CANCEL -> idempotent Calendar cancel -> booking/schedule cancelled -> capacity free -> policy evaluator -> refund requested/manual_review -> notification.

Refund no bloquea la liberación de agenda. Repetir la acción devuelve replay y no repite Calendar, refund ni notificación destructiva.

## Clinician reconciliation

Un cambio del mismo event id con ETag/hash nuevo actualiza current_start_at/current_end_at, marca calendar_change_source=clinician y conserva patient_reschedule_count. Delete/cancel marca booking/schedule cancelled y encola el flujo de refund según BUSINESS_POLICY_TBD.

El mismo ETag/hash es no-op. syncToken se guarda mediante syncState; HTTP 410 borra la confianza del token y ejecuta full sync antes de persistir el nuevo nextSyncToken.

## Capabilities

RESCHEDULE y CANCEL tienen tokens distintos de alta entropía, hash HMAC con dominio separado, expiración, versión y revoked_at. El raw token nunca se guarda en el record ni aparece en logs. CAPABILITY_TOKEN_SECRET no es parte de la configuración base.

## Refund

Refund es un estado propio: not_required -> refund_requested -> refund_pending -> refunded/refund_failed/manual_review. Timeout deja una orden determinista y fuerza status-only; no crea una segunda orden. La decisión comercial se delega a policyEvaluator y no se hardcodea.

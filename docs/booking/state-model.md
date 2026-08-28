# State model — booking lifecycle local

## Dominios separados

booking_status, payment_status, schedule_status y refund_status no se infieren entre sí. Un booking cancelado puede seguir paid mientras refund está pendiente o en manual_review.

## Patient RESCHEDULE

LockService -> fresh load -> confirmed/paid/scheduled/count=0 -> reconstruct capability -> verify -> FreeBusy + datastore target recheck -> fresh Calendar GET/ETag compare -> same-event Calendar update with If-Match -> current start/end -> count=1 -> persistent revoke -> CANCEL-only notification. A mismatch or 412 enters reconciliation and never increments count or revokes the capability.

El record entregado antes del lock nunca autoriza. Un segundo intento con el token antiguo o count 1 falla cerrado.

## Patient CANCEL

LockService -> fresh load -> already cancelled replay o verify CANCEL -> idempotent Calendar cancel -> booking/schedule cancelled -> capacity free -> policy evaluator -> refund requested/manual_review -> notification.

Refund no bloquea la liberación de agenda. Repetir la acción devuelve replay y no repite Calendar, refund ni notificación destructiva.

## Notifications

Cada evento lógico (`BOOKING_CONFIRMED`, `PATIENT_RESCHEDULED`, `CLINICIAN_RESCHEDULED`, `PATIENT_CANCELLED`, …) tiene una fila durable propia en `notification_outbox_nonprod`. El worker procesa esas filas, no el puntero de 57 columnas de la reserva. Un `sent` de un evento anterior no suprime el siguiente.

Replay identity is the source mutation, not the appointment snapshot. `source_operation_id` is derived from `last_operation_id` when present, otherwise from a deterministic non-PII operation id (payment identity for confirmation; Calendar event id/ETag/updated for clinician changes; reservation-scoped cancel/refund identifiers). Same source occurrence → one durable row. A later same-type mutation with the same `snapshot_start_at` is a new occurrence.

Un evento no enviado se marca `superseded` con motivo explícito; no se pierde por overwrite. La cancelación terminal no incluye Meet ni CTA. Vaciar el outbox entre mutaciones no es requisito de corrección.

The outbox worker owns one ScriptLock for its batch. Inner capability rotation receives `lockAlreadyHeld` and does not acquire or release that lock. MailApp delivery is at-least-once: if send succeeds and the process dies before the row is persisted `sent`, a later reclaim may send again. Concurrent workers cannot independently claim/send the same row.

## Clinician reconciliation

Un cambio de intervalo del mismo event id (start o end con instante distinto a `current_start_at`/`current_end_at`) actualiza current_start_at/current_end_at, marca calendar_change_source=clinician y conserva patient_reschedule_count. Delete/cancel marca booking/schedule cancelled y encola el flujo de refund según BUSINESS_POLICY_TBD.

El mismo ETag/hash es no-op. Una evolución metadata-only del mismo evento enlazado (etag, updated, Meet/conferenceId u otro hash) con start/end semánticamente iguales persiste metadata Calendar y **no** encola `CLINICIAN_RESCHEDULED`, **no** marca `calendar_change_source=clinician` y **no** toca `patient_reschedule_count`. La comparación de horario es por instante (`Date.parse`), no por el string ISO crudo. syncToken se guarda mediante syncState; HTTP 410 borra la confianza del token y ejecuta full sync antes de persistir el nuevo nextSyncToken.

## Capabilities

RESCHEDULE y CANCEL tienen tokens distintos de alta entropía, hash HMAC con dominio separado, expiración, versión y revoked_at. El raw token nunca se guarda en el record ni aparece en logs. CAPABILITY_TOKEN_SECRET no es parte de la configuración base.

## Refund

Refund es un estado propio: not_required -> refund_requested -> refund_pending -> refunded/refund_failed/manual_review. Timeout deja una orden determinista sólo como idempotencia interna y fuerza `manual_review` con `REFUND_CREATE_OUTCOME_UNKNOWN`; no afirma `status_only` ni crea una segunda orden sin evidencia provider-side. Un callback con token provider puede resolver manual_review y su replay es seguro. La decisión comercial se delega a policyEvaluator y no se hardcodea.

## Cancellation atomic transition

Patient y clinician usan `atomicCancellationTransitionFields_`: valida `confirmed -> cancellation_requested -> cancelled` y construye el único write final atómico del datastore, sin bypass directo del state machine. Si Calendar ya fue liberado y la escritura falla, el resultado es `RECONCILIATION_REQUIRED` con operation id/snapshot de reconciliación; no se emiten refund ni notification duplicados.

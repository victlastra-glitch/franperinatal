# Calendar reconciliation

La reconciliación es un proceso incremental bajo LockService con syncState para el nextSyncToken. Cada página conserva los parámetros legales de la consulta; el cursor sólo se persiste después de procesar todas las páginas y todos los eventos. Un error/stale unresolved conserva el cursor anterior; HTTP 410 obliga a full sync paginado.

Un move clinician del mismo evento actualiza datastore y encola CLINICIAN_RESCHEDULED sin escribir Calendar. Un delete/cancel encola CLINICIAN_CANCELLED y refund sólo según policyEvaluator.

Loop protection: event id + ETag + calendar_sync_hash + last_operation_id. Si el hash/ETag persistido coincide, la reconciliación es no-op. Un evento más antiguo que el último updated produce STALE_CALENDAR_EVENT y retry state. La resolución busca primero `calendar_event_id` y, si es necesario, `loadByCalendarLinkKey`; `calendar_link_key` nunca se trata como `reservation_id`.

Clinician cancellation exige la transición explícita `confirmed -> cancellation_requested -> cancelled`, validada como una operación atómica de datastore. La política de refund permanece separada y `BUSINESS_POLICY_TBD`.

# Calendar reconciliation

La reconciliación es un proceso incremental bajo LockService con syncState para el nextSyncToken. Sync-token requests no mezclan filtros de linkage; los eventos se filtran localmente por extendedProperties.private.

Un move clinician del mismo evento actualiza datastore y encola CLINICIAN_RESCHEDULED sin escribir Calendar. Un delete/cancel encola CLINICIAN_CANCELLED y refund sólo según policyEvaluator.

Loop protection: event id + ETag + calendar_sync_hash + last_operation_id. Si el hash/ETag persistido coincide, la reconciliación es no-op. Un evento más antiguo que el último updated produce STALE_CALENDAR_EVENT y retry state.

# Calendar gateway

createCalendarGateway_ encapsula Advanced Calendar Service v3:

- Freebusy.query en un rango acotado;
- Events.get(calendarId, eventId, optionalArgs?), list(calendarId, optionalArgs), insert(resource, calendarId, optionalArgs), update(resource, calendarId, eventId, optionalArgs, optionalHeaders) y remove(calendarId, eventId, optionalArgs);
- ETag, updated y hash canónico. El hash incluye etag/updated/Meet conferenceId para idempotencia de sync; un cambio de hash sin cambio de start/end no es un move clinician. Reconciliation clasifica CLINICIAN_RESCHEDULED por instantes de intervalo;
- extendedProperties.private opacas: source, link_key, schema;
- Events.list incremental paginado con nextPageToken, nextSyncToken sólo al completar todas las páginas y recuperación HTTP 410 mediante full sync paginado;
- conferenceDataVersion=1 para request/preservación de Meet; el gateway de recursos de booking se crea con requestMeet=true.

`updateSameEvent` recarga el evento y compara su ETag con `calendar_event_etag`. Sólo si coincide envía `If-Match`; un conflicto previo o HTTP 412 no muta el datastore como éxito y devuelve `CALENDAR_ETAG_CONFLICT` para reconciliación. La mutación se hace sobre una copia del recurso, conserva `conferenceData` y usa el mismo event id, de modo que un 412 tampoco contamina el objeto local observado.

La disponibilidad devuelve slots ocupados, porque ese es el contrato vigente del browser: working slots minus Calendar busy minus reservas activas se materializa como la lista de bloqueos. El mismo booking presente en Calendar y datastore se deduplica por clave de slot.

Antes de crear la reserva o llamar a Flow, `createFlowPayment_` valida server-side el día laboral, la hora canónica, el horizonte de 90 días y el lead time de 120 minutos. Bajo `ScriptLock`, hace un FreeBusy de la hora solicitada; un busy event externo devuelve `SLOT_TAKEN` sin fila de Sheet ni llamada Flow.

El manifest declara el Advanced Service localmente. No se hizo clasp push, no se activó el servicio y no se hizo ninguna llamada Google.

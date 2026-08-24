# Calendar gateway

createCalendarGateway_ encapsula Advanced Calendar Service v3:

- Freebusy.query en un rango acotado;
- Events.get(calendarId, eventId, optionalArgs?), list(calendarId, optionalArgs), insert(resource, calendarId, optionalArgs), update(resource, calendarId, eventId, optionalArgs, optionalHeaders) y remove(calendarId, eventId, optionalArgs);
- ETag, updated y hash canónico;
- extendedProperties.private opacas: source, link_key, schema;
- Events.list incremental paginado con nextPageToken, nextSyncToken sólo al completar todas las páginas y recuperación HTTP 410 mediante full sync paginado;
- conferenceDataVersion=1 para request/preservación de Meet.

`updateSameEvent` recarga el evento y compara su ETag con `calendar_event_etag`. Sólo si coincide envía `If-Match`; un conflicto previo o HTTP 412 no muta el datastore como éxito y devuelve `CALENDAR_ETAG_CONFLICT` para reconciliación. La mutación conserva `conferenceData` y usa el mismo event id.

La disponibilidad devuelve slots ocupados, porque ese es el contrato vigente del browser: working slots minus Calendar busy minus reservas activas se materializa como la lista de bloqueos. El mismo booking presente en Calendar y datastore se deduplica por clave de slot.

El manifest declara el Advanced Service localmente. No se hizo clasp push, no se activó el servicio y no se hizo ninguna llamada Google.

# Calendar gateway

createCalendarGateway_ encapsula Advanced Calendar Service v3:

- Freebusy.query en un rango acotado;
- Events.get, insert, update del mismo event y delete idempotente;
- ETag, updated y hash canónico;
- extendedProperties.private opacas: source, link_key, schema;
- Events.list incremental con nextSyncToken y recuperación HTTP 410;
- conferenceDataVersion=1 para request/preservación de Meet.

La disponibilidad devuelve slots ocupados, porque ese es el contrato vigente del browser: working slots minus Calendar busy minus reservas activas se materializa como la lista de bloqueos. El mismo booking presente en Calendar y datastore se deduplica por clave de slot.

El manifest declara el Advanced Service localmente. No se hizo clasp push, no se activó el servicio y no se hizo ninguna llamada Google.

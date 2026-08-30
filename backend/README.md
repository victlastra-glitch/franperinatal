# Backend: procedencia canónica verificada, importación bloqueada

El flujo directo de reservas de producción fue verificado contra el asset live:
su deployment Apps Script corresponde a **Candidate A**, versión **6**. La
fuente de esa versión fue exportada sólo lectura a un directorio temporal y no
forma parte de este repositorio.

La correlación del Worker es separada: `_worker.js` usa el secret runtime
`APPS_SCRIPT_WEB_APP_URL`, cuyo valor no fue leído. Esa relación es **LIKELY**
hasta una verificación autorizada por metadata/fingerprint, sin revelar valores.

Por seguridad, este repositorio no incluye los exports históricos, sandbox,
legacy ni el export canónico. Antes de agregar una fuente backend se requiere:

1. Aprobar una revisión de importación de fuente sanitizada.
2. Eliminar o reemplazar recipients, endpoints privados y toda configuración
   runtime antes de cualquier copia.
3. Crear una derivación NONPROD aislada; no reutilizar producción.
4. Probar idempotencia, webhook y retornos Flow exclusivamente en sandbox.

`PRODUCTION_BACKEND_MATCH = VERIFIED` para la ruta directa. La implementación
operable sigue bloqueada hasta completar el paquete de aislamiento NONPROD.

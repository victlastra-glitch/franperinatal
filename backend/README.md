# Backend pendiente de recuperación canónica

El sitio Pages en producción delega el flujo de reservas a una URL de Apps
Script configurada como secreto de Cloudflare Pages. No se ha verificado cuál
de los exports locales de Apps Script corresponde al deployment activo.

Por seguridad, este repositorio no incluye los exports históricos, sandbox,
legacy ni candidatos. Antes de agregar una fuente backend se requiere:

1. Identificar en Apps Script el proyecto y deployment activos.
2. Exportar sólo el código canónico, sin Script Properties ni valores de
   credenciales.
3. Revisar que no contenga PII, tarjetas de prueba, secretos Flow ni URLs
   privadas.
4. Probar idempotencia, webhook y los retornos Flow en sandbox.

Hasta completar esa evidencia, la reproducibilidad del backend es BLOQUEADA.

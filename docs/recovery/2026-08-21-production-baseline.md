# Baseline de producción — 2026-08-21

## Evidencia verificada

- Cloudflare Pages project: franciscabustos.
- Deployment de producción: 8b49b343-71e4-4b42-8b8c-19250afbb8c7.
- URL de artefacto: https://8b49b343.franciscabustos.pages.dev.
- Modelo: Direct Upload; sin proveedor Git conectado.
- Etiqueta de branch del deployment: main.
- Source informado por Pages: f1e72ea.
- Se compararon 65 archivos públicos descargables contra el árbol local
  06_website/Web: 63 idénticos byte a byte.

El artefacto público tiene precedencia sobre cualquier snapshot local o Git.

## Exclusiones deliberadas

- .wrangler/ y todos los archivos de entorno.
- assets/booking_FLOW_SANDBOX.js.
- guia/10-senales-simple.html y guia/10-senales-v2.html: son variantes
  heredadas redirigidas al recurso canónico.
- Todo export local de Apps Script y artefactos legacy/sandbox.
- El ZIP histórico de GitHub y sus screenshots.

## Límite material

Pages no tiene integración Git y la fuente de Apps Script activa no se puede
deducir desde el secreto de entorno ni desde exports históricos. La réplica
del frontend es verificable; la recuperación completa del backend requiere la
identificación humana del Apps Script/deployment activo.

## Próximo gate

Crear un Preview desde esta rama sin secretos ni backend, comparar la web
estática y luego completar el inventario/protocolo de recuperación backend.

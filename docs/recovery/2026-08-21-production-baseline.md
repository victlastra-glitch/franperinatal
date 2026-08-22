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

## Actualización de procedencia backend

La procedencia del backend de reservas directo fue verificada posteriormente:
el asset live de booking coincide de forma exacta con un deployment de Candidate
A, versión 6, exportado sólo lectura a un directorio temporal. No se incorporó
fuente Apps Script al repositorio. La correlación del secret runtime del Worker
permanece separada y sólo es LIKELY.

## Próximo gate

Aplicar el paquete de aislamiento NONPROD únicamente después de aprobación
humana; no crear Preview con backend, secretos o recursos externos antes de
esa puerta.

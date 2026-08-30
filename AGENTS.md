# Francisca Bustos — Psicología Perinatal

## Alcance

Este repositorio es la fuente de código del sitio franciscabustos.cl.
Trabajar únicamente en este proyecto. main es la línea base protegida de
producción y todo cambio debe ir por rama, preview y PR.

## Reglas de seguridad

- No desplegar a producción sin autorización explícita posterior a QA.
- No versionar .wrangler/, .env*, credenciales Flow, Script Properties,
  tarjetas de prueba, datos de reserva ni información clínica.
- No promover artefactos SANDBOX, legacy o candidatos sin evidencia del
  deployment actual y revisión humana.
- Antes de cambios de reserva o pago, usar ambiente seguro y nunca generar
  cargos reales sin autorización explícita.

## QA mínimo

Validar desktop y mobile, navegación, redirects, consola, red, formularios,
reserva, retorno de pago, canonical, robots, sitemap, exposición de secretos
y datos personales. Mantener el tono clínico, ético y no alarmista.

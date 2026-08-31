# Francisca Bustos — Psicología Perinatal

Código del sitio franciscabustos.cl.

## Estado de esta rama

`feat/production-booking-lifecycle-v2-port` is a **review-only** release
candidate. It selectively ports the booking lifecycle onto the live
Production Apps Script v7 Git baseline.

- Baseline: `baseline/production-v7-20260831`
- Runbook (do not execute): `docs/production/PRODUCTION_RC_RUNBOOK.md`
- This branch does **not** authorize Production deploy.

## Flujo

1. Cambiar sólo mediante rama y PR.
2. Revisar el draft PR contra el baseline v7.
3. Ejecutar el runbook de producción únicamente con autorización explícita.

# Static P0 findings — 2026-08-21

Scope: recovered static frontend only. This is an audit, not a copy or code
change. Line references are from branch `recovery/production-source-20260821`.

## 1. Crisis line *4141

`*4141` is the MINSAL suicide-prevention line. It must not be represented as
Salud Responde. Several current blocks correctly distinguish it from Salud
Responde 600 360 7777, but the terminology and crisis wording are inconsistent.
Every *4141 occurrence needs a clinically reviewed, consistent official label.

| File | Line | Current copy/code | Classification | Disposition |
| --- | ---: | --- | --- | --- |
| `index.html` | 219 | `*4141 (Salud Responde, Ministerio de Salud)` | Incorrect naming | FIX |
| `contacto.html` | 277 | `Salud Responde (*4141)` | Incorrect naming | FIX |
| `lp.html` | 518 | `*4141 (Salud Responde, MINSAL)` | Incorrect naming | FIX |
| `guia/10-senales.html` | 988 | `Salud Responde 600 360 7777` and `*4141 desde tu celular` | Crisis copy requires consistent official naming | FIX |
| `recursos/test-edimburgo.html` | 493 | `*4141 desde tu celular` | Crisis copy requires consistent official naming | FIX |
| `blog/acompanar-perdida-gestacional.html` | 262, 300 | `*4141` crisis wording | Crisis copy requires consistent official naming | FIX |
| `blog/ansiedad-en-el-embarazo.html` | 496 | `Desde celular: *4141` | Crisis copy requires consistent official naming | FIX |
| `blog/ansiedad-postparto.html` | 532, 544 | `*4141` crisis wording | Crisis copy requires consistent official naming | FIX |
| `blog/duelo-gestacional-apoyo-psicologico.html` | 508 | `Fono Salud Mental: *4141` | Crisis copy requires consistent official naming | FIX |
| `blog/fertilidad-y-salud-mental.html` | 249, 283 | `*4141` crisis wording | Crisis copy requires consistent official naming | FIX |
| `blog/trauma-de-parto.html` | 256, 292 | `*4141` crisis wording | Crisis copy requires consistent official naming | FIX |
| `blog/vinculo-madre-bebe.html` | 534, 546 | `*4141` crisis wording | Crisis copy requires consistent official naming | FIX |

## 2. Quantified public claims

| File | Line | Current copy/code | Classification | Disposition |
| --- | ---: | --- | --- | --- |
| `index.html` | 472 | `+140` | Public quantified outcome/activity claim; no documented methodology was located in the Francisca project scope | REMOVE_UNLESS_EVIDENCED |
| Recovered public static source | — | No `9/10` claim found | Not present in current recovered source | KEEP |
| Recovered public static source | — | No `14 weeks` / `14 semanas` claim found | Not present in current recovered source | KEEP |

Internal marketing notes mentioning these figures are not evidence of a public
methodology. No support was invented.

## 3. Modality and Las Condes

| File | Line | Current copy/code | Classification | Disposition |
| --- | ---: | --- | --- | --- |
| Recovered service pages | — | Online-only wording found; no public `presencial` service claim found | Current static source supports online-only, but it conflicts with older artifacts | FRANCISCA_DECISION_REQUIRED |
| `privacidad.html` | 92, 172 | Professional address in Las Condes | Privacy/contact address, not a service-modality claim | KEEP |

The current recovered public copy does not settle whether the professional
policy is intentionally online-only. Francisca must ratify the policy before a
future copy change.

## 4. Current analytics event names

| File | Line(s) | Current copy/code | Classification | Disposition |
| --- | ---: | --- | --- | --- |
| `assets/analytics.js` | 19-20, 70-78, 164-172 | `reserva_click`, `whatsapp_click` | Existing CTA tracking; payload review not performed in this static audit | REFACTOR_LATER |
| `lp.html` | 26, 47, 55 | `reserva_click`, `whatsapp_click` | Landing-page duplicate/event-specific tracking | REFACTOR_LATER |
| `pago-resultado.html` | 214-215 | `purchase`, `reserva_pagada_confirmada` | Payment-return event names; no live payment was run | REFACTOR_LATER |

The prescribed privacy-safe funnel names (`booking_cta_click`, `booking_start`,
`booking_step`, `payment_start`, `payment_confirmed`, `booking_confirmed`, and
`booking_error`) are absent from the recovered static code. Any future change
must keep PII and clinical fields out of analytics payloads.

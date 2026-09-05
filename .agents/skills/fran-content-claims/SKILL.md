---
name: fran-content-claims
description: Governance of public perinatal mental-health copy — separating marketing, education, opinion and clinical claim, and preserving the site's disclaimer, crisis-resource and professional-credential conventions. Use when writing or editing blog posts, service, landing, FAQ or resource pages, meta descriptions, or approved transactional email copy. Never a source of clinical advice.
---

# Content and claims governance

This site publishes perinatal mental-health content to the public: twelve posts in
`blog/`, condition pages (`depresion-postparto.html`, `ansiedad-perinatal.html`),
`servicios.html`, `faq.html`, `lp.html`, `sobre-mi.html`, and screening material in
`recursos/` and `guia/`.

**This skill governs how claims are framed. It does not generate clinical advice,
diagnose, interpret a score, or recommend treatment.** Anything requiring clinical
judgement goes to Francisca, not to a model.

## Classify before you write

| Type | Example | Requirement |
| --- | --- | --- |
| Marketing | "acompañamiento cercano" | Must stay non-alarmist; no implied outcome |
| Educational | what the postpartum period involves | Grounded in the existing corpus; general, not personalised |
| Opinion / experience | how a first session tends to feel | Framed as approach, not as fact |
| Factual claim | prevalence, what an instrument measures | Only if already supported on the site or by a source Francisca approves |
| Clinical claim | diagnosis, prognosis, treatment, medication | **Do not author.** Escalate to a human |
| Unsupported claim | efficacy or cure rates, "elimina la ansiedad" | Never publish |

## Conventions the site already keeps — preserve them

- **Every educational page carries the disclaimer**, in the site's own wording:
  *no reemplaza una evaluación clínica profesional*. Do not remove it, weaken it, or
  move it below the fold when editing a page.
- **Crisis routing stays reachable** where distress content appears: nearest
  Urgencia / urgencia psiquiátrica, and Salud Responde **600 360 7777**. Never
  delete a crisis resource while restructuring. Never invent a hotline.
- **Screening ≠ diagnosis.** EPDS/Edinburgh material describes what the instrument
  measures and must keep saying it does not diagnose and does not replace clinical
  evaluation. Do not add score-to-diagnosis mappings or personalised
  interpretations.
- **Credentials are load-bearing facts, not copy.** The professional name,
  *Reg. Col. Psicólogos de Chile* and *Reg. Superint. Salud* numbers, and years of
  experience must be reproduced exactly as already published, or left untouched.
  Never adjust, round, upgrade or infer a credential.
- **Tone: clinical, ethical, non-alarmist**, second person, warm without promising.
  No urgency pressure, no fear framing, no guarantee of results.
- **Prices and policy in copy are derived, not written.** The 24-hour cancellation
  window and the CLP 50.000 price have canonical sources
  (`fran-booking-lifecycle`, `fran-payment-integrity`); public copy must match them
  and never introduce a second version.

## Transactional email copy is frozen

Patient email wording is contract-tested, including the rule that a
non-refundable cancellation email must contain **no** economic vocabulary
(`pago`, `cobro`, `valor`, `devolución`, `reembolso`, `$50.000`, `50000`).
Changing that copy means changing
`backend/appsscript/booking/test/email-design-system-v3.test.mjs` and
`lifecycle-email-v2.test.mjs` deliberately — see `fran-workflow-automation-integrity`.

## Before finishing

Keep `sitemap.xml`, canonical tags and meta descriptions consistent with any new or
renamed page, and re-read the change as a patient in distress would.

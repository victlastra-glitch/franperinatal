# Francisca Bustos M. — Brand & Design System

**Version:** 3.1-final
**Date:** 2026-09-17
**Decision status:** APPROVED DESIGN DIRECTION / CANONICAL TARGET
**Implementation status:** NOT IMPLEMENTED as a complete web system
**Production authorization:** NOT GRANTED by this document
**Production baseline reviewed:** `15ab429`
**Visual implementation owner:** `fran-frontend-web`
**Clinical/public copy owner:** `fran-content-claims` + Francisca Bustos M.

This file is the canonical source of truth for **brand identity and visual design** in the repository. It defines the target that Web and Production-facing implementation work must follow. It does not authorize a deploy and it does not replace domain authorities for booking, payments, privacy, clinical claims, credentials, prices, policies or patient communications.

The direction is **evolution, not rebranding**: preserve the implemented editorial equity — cream paper, warm ink, malva, Fraunces, Inter, fine rules, negative space and Francisca's photography — while making the identity consistent, accessible and portable across web, social and operational surfaces.

---

## 1. Governance and source boundaries

### This document owns

- Brand naming and visual lockups.
- Corporate / brand palette.
- Supporting UI palette and visual semantic tokens.
- Typography roles and scale.
- Logo responsive behavior.
- Photography and graphic language.
- Visual component rules.
- Social identity rules.
- Visual implementation target and acceptance criteria.

### This document does not own

- Clinical claims, symptoms, treatment claims, testimonials or crisis copy.
- Professional credentials or registration wording.
- Prices, availability truth, booking policy, cancellation/refund logic or payment truth.
- Transactional-email lifecycle behavior.
- Patient data or operational state.

For those domains, follow `AGENTS.md` and the owning canonical source. **Design placeholders never become approved public copy by being shown in a mockup.**

### State vocabulary

- **IMPLEMENTED:** exists in current runtime/repository.
- **APPROVED:** explicitly selected as the target design decision.
- **CANONICAL TARGET:** this document is the source agents must implement toward.
- **NOT IMPLEMENTED:** approved target not yet reflected everywhere in runtime.
- **SCOPED EXCEPTION / KNOWN DEBT:** deliberate divergence with a bounded owner and follow-up.

Never collapse `APPROVED` into `IMPLEMENTED`, or `IMPLEMENTED` into `DEPLOYED` without evidence.

---

## 2. Brand architecture

### Primary name

**Francisca Bustos M.**

Rules:

- Use the final `M.` with the period.
- The `M.` is **roman**, same style/weight as the rest of the wordmark.
- Do not add `Ps.` to the primary identity.
- Do not substitute the public name with `FB` or `fb` in headings, signatures or running text.
- The full formal surname may still be used where legal, schema, author, credential or other content-governance requirements need it.

### Primary descriptor

**Psicóloga Clínica · Perinatal**

Use when the surface needs to identify Francisca's professional role.

### Secondary descriptor

**Psicología Perinatal**

Use when the context names the discipline rather than the professional role, including appropriate metadata, compact contexts and the current transactional-email exception.

### Voice of the identity

Editorial clinical, warm through precision rather than decoration. The brand should read as a specialist professional practice, not generic wellness, maternity lifestyle, influencer, coaching, cosmetic or infantilized maternal branding.

Avoid visual clichés such as uterus icons, hearts, hands, flowers, butterflies, moons, baby silhouettes and generic maternity stock photography.

---

## 3. Logo system

The canonical identity is **typographic, without an isotipo**.

### Primary wordmark

`Francisca Bustos M.`

- Family: Fraunces.
- Weight: 300 at display sizes `>=32px`; 400 at smaller UI sizes.
- Tracking: approximately `-0.02em` display; nav uses `-0.018em`.
- The `M.` remains roman.
- Canonical colors: warm ink on cream/paper, or cream on warm ink.
- Never use malva as the wordmark color.

### Primary lockup

Wordmark + `Psicóloga Clínica · Perinatal`.

Descriptor:

- Inter 500.
- Uppercase.
- Tracking `0.18em`.
- Minimum `11px`.

### Secondary lockup

Wordmark + `Psicología Perinatal` when the discipline is the required descriptor.

### Compact identifier

`fb` in Fraunces italic is a **micro-identifier**, not a brand-name abbreviation.

Allowed only for:

- favicon;
- apple-touch icon.

Rules:

- Malva flat background, no gradient.
- Minimum functional icon size: `16px`.
- Do not use `fb` as Instagram/LinkedIn avatar, signature, title, card mark or substitute for the name.

### Social avatar

Instagram and LinkedIn use a **portrait of Francisca**, not `fb`.

Target crop:

- circular platform crop;
- eyes near upper third;
- head approximately 65% of diameter;
- cream background from the existing portrait set;
- same photographic language as the website to build cross-channel recognition.

---

## 4. Responsive brand measurements

The following thresholds come from rendered measurements with Fraunces/Inter loaded; they replace prior estimated minima.

| Element | Target |
| --- | ---: |
| Primary wordmark at 14px / Fraunces 400 | `125.1px` wide |
| Primary wordmark at 17px / Fraunces 400 | `151.4px` wide |
| Primary wordmark at 20px / Fraunces 400 | `177.6px` wide |
| Secondary descriptor at 11px / Inter 500 / `.18em` | `168.8px` wide |
| Primary descriptor at 11px / Inter 500 / `.18em` | `236.8px` wide |
| Primary lockup 20/11 | `236.8 × 39px` |

### Degradation rule

- Available width `>=236.8px`: primary lockup.
- `>=168.8px` and `<236.8px`: secondary lockup when a descriptor is required.
- `>=125.1px` and `<168.8px`: wordmark only.
- `<125.1px`: omit the wordmark in normal UI; do **not** introduce `fb` outside favicon/apple-touch contexts.

### Navigation

- Desktop wordmark target: Fraunces 400 / 20px.
- Mobile target: Fraunces 400 / 17px with deliberate two-line markup where needed.
- At `<=767px`, hide the descriptor rather than shrinking below the minimum.
- Do not use viewport-dependent `word-spacing` hacks to force wrapping.

---

## 5. Corporate / Brand Palette

This is the **corporate palette**. These colors create brand recognition and should remain stable across brand surfaces.

| Role | Token | Hex | Primary use |
| --- | --- | --- | --- |
| Warm ink | `--ink` | `#231F1C` | Primary text, primary button, footer, inverted surfaces |
| Cream | `--bg` | `#FAF6F0` | Default page background |
| Paper | `--paper` | `#FDFBF7` | Cards, forms, elevated paper surfaces |
| Malva | `--malva` | `#8A5A6B` | Core clinical accent |
| Malva deep | `--malva-deep` | `#6D4454` | Links, focus, hover, numbered accents |
| Malva soft | `--malva-soft` | `#C9A8B3` | Decorative highlight on dark surfaces |
| Sand light | `--bg-2` | `#EFE7DB` | Alternate paper/background section |
| Sand mid | `--bg-3` | `#E2D8C9` | Placeholder/frame/disabled background |

### Corporate color rules

- Cream is the default canvas; do not normalize the brand to pure white.
- Warm ink replaces pure black for brand surfaces.
- Malva is the principal accent and should normally appear **once per view** as underline, filete, numbering, dot, focus or a single accent action.
- Do not use malva as a full section background.
- The only solid-malva background exception is the `fb` micro-identifier at favicon/apple-touch scale.
- Sand is a neutral/background family, not the primary accent.
- Do not introduce new brand colors ad hoc.

### Key contrast references

- `--ink` / `--bg`: about `15.2:1`.
- `--ink-2` / `--bg`: about `7.0:1`.
- target `--ink-3` / `--bg`: about `4.8:1`.
- `--malva-deep` / `--bg`: about `7.5:1`.
- `--malva` / `--bg`: about `5.2:1`.

---

## 6. Support / UI Palette

These colors support interface state. They are **not additional corporate colors** and must not become independent brand accents.

| Role | Token | Hex | Rule |
| --- | --- | --- | --- |
| Secondary text | `--ink-2` | `#5A534D` | Lede, descriptor, secondary body |
| Muted accessible text | `--ink-3` | `#756C63` | Target replacement for current `#8A8178`; labels/meta |
| Success | `--success` | `#4F5E48` | Accessible success/status text |
| Success soft | `--success-soft` | `#E8EEE6` | Success background |
| Warning | `--warning` | `#7A5A2E` | Operational warning, never scarcity copy |
| Warning soft | `--warning-soft` | `#F3E9DA` | Warning background |
| Danger | `--danger` | `#8C4F4B` | Errors/cancel destructive state |
| Danger soft | `--danger-soft` | `#F6E6E6` | Error/destructive background |
| Info / focus | `--info`, `--focus` | `#6D4454` | Informational/focus treatment |
| Availability partial | `--availability-partial` | `#C69D6E` | Non-text availability indicator only, with text label |

### Sage

`#94A38C` and `#72826A` belong to the photographic/support family, not the corporate UI accent system.

`--sage-deep: #72826A` has about `3.81:1` contrast on cream. Therefore:

- allowed for non-text graphic/icon use when non-text contrast requirements are met;
- text only at WCAG large scale: approximately `>=24px` regular or `>=18.67px` with weight `>=700`;
- never use it for normal-size labels, badges or body text;
- normal-size success text uses `--success #4F5E48` instead.

---

## 7. Typography

### Families

- **Fraunces:** wordmark, display, headings, quotes and selected italic emphasis.
- **Inter:** body, UI, labels, forms and navigation descriptors.
- **JetBrains Mono:** editorial numbering/references only.

### Canonical web stacks

```css
--serif: "Fraunces", Georgia, "Times New Roman", serif;
--sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--mono: "JetBrains Mono", ui-monospace, monospace;
```

Cormorant Garamond is **not** a target fallback for the web brand system. Email V4 is a scoped exception described later.

### Type scale

| Style | Desktop | Mobile <=640 | Weight / line-height |
| --- | ---: | ---: | --- |
| Display | 108 | 60 | Fraunces 300 / 1.02 |
| H1 | 76 | 44 | Fraunces 300 / 1.08 |
| H2 | 46 | 32 | Fraunces 300 / 1.12 |
| H3 | 30 | 22 | Fraunces 300 / 1.22 |
| H4 / summary | 23 | 21 | Fraunces 400 / 1.28 |
| Wordmark nav | 20 | 17 | Fraunces 400 / 1.05 |
| Lede | 20 | 17 | Inter 400 / 1.55 |
| Body | 17.5 | 17 | Inter 400 / 1.55 |
| Body small | 15.5 | 15 | Inter 400 / 1.6 |
| Button | 15 | 15 | Inter 500 |
| Eyebrow | 12.5 | 12 | Inter 500 uppercase / `.18em` |
| Label/descriptor | 11–12 | 11 | Inter 500 uppercase / `.14–.18em` |
| Mono index | 11.5 | 11.5 | JetBrains Mono 400 / `.14em` |

Rules:

- Inputs stay at least 16px to avoid iOS zoom.
- Long-form reading target: maximum about 58ch.
- Use one italic emphasis per headline, normally no more than three words.
- Do not italicize the `M.` in the wordmark.

---

## 8. Layout and spacing

Canonical container targets:

- `--container: 1240px`
- `--container-narrow: 920px`
- `--container-reading: 680px`
- lateral padding: `clamp(20px, 4vw, 48px)`

Grid and rhythm:

- 12-column fluid grid, typical gap 32px.
- Editorial asymmetry is allowed; collapse complex grids to one column around 1040px.
- Navigation collapses around 960px; brand descriptor hides at `<=767px`; mobile type scale switches at `<=640px`.
- Default section rhythm: `clamp(40px, 6.5vw, 96px)`.
- Do not stack two `--bg-2` sections consecutively without a visual reset/divider.

Density is selected deterministically by page type, not by a user/runtime tweak:

- editorial: home and campaign/editorial landing surfaces;
- compact: blog, FAQ, booking and long operational content.

---

## 9. Graphic language

Distinctive assets are compositional rather than illustrative:

1. Eyebrow + thin 22×1 filete.
2. One selected italic phrase per headline.
3. Malva underline/highlight at controlled opacity.
4. Editorial mono numbering (`01`, `02`, ...).
5. Fine rules and side notes.
6. Sparse dots/diamond only as decorative micro-elements.

Functional SVGs use approximately 1.5px warm-ink strokes. Do not introduce decorative illustration systems or generic maternal iconography.

---

## 10. Photography

The current Francisca portrait set defines the photographic direction.

### Direction

- Natural, lateral, diffused warm light.
- Consultation/living environment in cream/light wood, with restrained living elements such as a plant or books.
- Professional portrait, not influencer/lifestyle posing.
- Wardrobe: earth, sage, olive, cream and restrained texture.
- Vertical crops 4:5 and 3:4 with breathing room and eyes near the upper third.
- Warm balance, open blacks, restrained saturation; avoid pink cast, vignette and excessive blur.

### Do not use

- stock pregnant people or babies as category shorthand;
- bellies/hands-on-belly/newborn-feet clichés;
- cold-white clinical studio aesthetic;
- circular portrait crops in authored layouts (platform avatars are the explicit exception);
- text over Francisca's face.

---

## 11. Components

### Buttons

- Primary: warm-ink pill, cream text, minimum 48px target height.
- Ghost: transparent + warm-ink border/text.
- Accent malva: reserved for a single appropriate lead-capture action; do not pair it with a competing filled primary in the same view.
- Disabled: `--bg-3` + accessible muted text.
- Focus: visible `--malva-deep` / `--focus` outline, 2px with about 3px offset.

### Links

Body links use malva-deep with a persistent underline. Hover may move toward warm ink; focus remains visible without relying on color alone.

### Inputs

- Label at least 12–13px where practical; canonical descriptor floor 11px.
- Input text at least 16px.
- Error state uses `--danger`, not generic Tailwind red.
- Error communication cannot rely on color alone.

### Notices

Use semantic soft backgrounds for operational states. Never turn availability into urgency or scarcity marketing.

Availability wording is factual, e.g.:

- `Horarios disponibles`
- `1–2 horarios`
- `Sin horarios`

Only use counts/states derived from real availability. Do not use `pocas horas`, `últimos cupos`, countdowns or equivalent pressure mechanisms.

Crisis and clinical wording is governed by `fran-content-claims`; this document does not freeze those strings.

---

## 12. Social system

### Avatar

Use Francisca's portrait as defined in the logo section.

### Carousel

Target canvas: `1080×1350`.

- generous margins around 104px;
- headline in Fraunces;
- footer carries the full name/lockup, not `fb`;
- maximum text density is intentionally low; roughly 30 words/slide is a design guardrail, not a content rule.

### Story / Reel cover

Target canvas: `1080×1920`.

- preserve platform safe zones;
- when placing text over photography, use a sufficiently strong warm-ink veil and never cover the face;
- keep the identity recognizable in the central crop used by platform previews.

Clinical/social copy still requires Content Governance review before publication.

---

## 13. Email V4 — scoped production exception

**Current repository truth:** Email V4 is implemented in the Production baseline `15ab429`.

It remains a **SCOPED EXCEPTION / KNOWN VISUAL DEBT** relative to the web design system. Do not reopen Email V4 as part of the initial web-brand implementation PR.

Current Email V4 intentionally has its own compatibility-oriented system, including:

- cream `#FFF7F2`;
- paper `#FFFCF9`;
- charcoal `#2F3236`;
- sand `#DCCBB9`;
- link `#8C6B52`;
- cancellation accent `#8C4F4B`;
- text-first brand header;
- no remote fonts; compatibility fallbacks;
- full brand-name content `FRANCISCA BUSTOS M.`;
- secondary descriptor `PSICOLOGÍA PERINATAL`.

The descriptor is the **approved secondary descriptor**, not the primary web descriptor. The name content is consistent while the typography and palette remain different.

Email convergence, if later desired, requires its own PR, contract tests and explicit authorization. Do not couple that work to the web Design System rollout.

---

## 14. Current Production → canonical target

This table is an implementation map, not proof that the target is already live.

| Concern | Current Production baseline | Canonical target |
| --- | --- | --- |
| Public wordmark | Multiple surfaces still use `Francisca Bustos` | `Francisca Bustos M.` |
| Primary professional descriptor | Often `Psicología Perinatal`, including nav/footer variants | `Psicóloga Clínica · Perinatal` where role is identified |
| Descriptor minimum | Some nav treatment around 10px | 11px minimum |
| `--ink-3` | `#8A8178` | `#756C63` |
| Serif fallback | Fraunces → Cormorant → Georgia | Fraunces → Georgia → Times |
| Responsive logo minimum | Legacy/estimated behavior | measured thresholds in §4 |
| Social avatar | Not governed here by current web runtime | Francisca portrait |
| `fb` | favicon/legacy uses | favicon/apple-touch only; flat malva target |
| Semantic state colors | mixed/local values in some surfaces | canonical semantic tokens in §6 |
| Focus | partial/local | global visible focus |
| Availability language | may contain legacy `pocas horas` semantics | factual count/state only |
| Email V4 | implemented, visually divergent | keep as scoped exception for initial rollout |

Runtime code remains the truth of **what is implemented today**; this document is the truth of **what brand/UI changes must implement toward**.

---

## 15. Implementation plan and guardrails

### Initial web implementation scope

A focused implementation branch/PR should:

1. Update visual tokens in `assets/styles.css` to the canonical target.
2. Update public web wordmarks/descriptors consistently across root pages and posts.
3. Replace fragile mobile wordmark wrapping with deliberate markup/CSS.
4. Add/normalize semantic UI tokens and global focus-visible treatment.
5. Correct accessibility problems such as old `--ink-3` usage and white text on non-compliant external-brand green backgrounds.
6. Implement the responsive lockup rules from the measured thresholds.
7. Update favicon/apple-touch treatment to the canonical `fb` micro-identifier after verifying all current references.
8. Remove or retire historical/experimental brand assets/runtime variants only after proving they are unreferenced and behavior is preserved.

### Explicitly outside the initial web PR

- Email V4 redesign/convergence.
- Clinical/commercial copy rewrites.
- Credential wording changes.
- Booking/payment/refund behavior.
- Calendar/Meet behavior.
- Patient communications.
- Any Production deploy.

### Copy firewall

When a visual implementation touches a string with clinical, credential, crisis, testimonial, availability, price or policy meaning, load `fran-content-claims` and the owning source before changing it. If the task is purely visual, preserve governed copy.

### Runtime-variant cleanup

The target system is deterministic. Experimental runtime brand switching (for example alternate accent/type/density controls) is not part of the canonical target. Before removing any existing runtime mechanism, audit references and verify no required behavior depends on it.

---

## 16. Verification required before release

The implementation is not complete until evidence exists for the surfaces it changes.

At minimum:

- verify representative desktop and mobile widths, including 320/375/390/430 and standard desktop;
- verify nav/wordmark wrapping and lockup degradation;
- verify focus-visible with keyboard navigation;
- verify text/background contrast for all touched token pairs;
- verify no unintended horizontal overflow;
- verify public pages do not mix old/new brand names within the same visual identity context;
- verify the secondary descriptor remains allowed where discipline, metadata or the scoped email exception requires it;
- verify no clinical/content claims changed accidentally;
- verify booking/payment behavior is untouched by the visual-only diff;
- run repository-required gates from `AGENTS.md`;
- record browser verification or explicitly state `BROWSER_VERIFICATION=BLOCKED_BY_ENVIRONMENT`.

A preview is not Production. Do not deploy without explicit human authorization for the deploy itself.

---

## 17. Canonical Do / Don't

### Do

- Use `Francisca Bustos M.` with roman `M.` and period.
- Use `Psicóloga Clínica · Perinatal` as the primary role descriptor.
- Use `Psicología Perinatal` when naming the discipline or in an approved secondary context.
- Use cream, warm ink and malva as the stable identity anchors.
- Use Francisca's portrait as the social avatar.
- Use `fb` only for favicon/apple-touch.
- Keep the system editorial, calm, precise and human.
- Keep public copy under Content Governance.

### Don't

- Add `Ps.` to the primary visual identity.
- Use `FB`/`fb` as a public name substitute.
- Italicize the `M.` in the canonical wordmark.
- Use full-section malva backgrounds in authored brand surfaces.
- Introduce generic wellness/maternity symbols.
- Use urgency or artificial scarcity to drive booking.
- Treat semantic UI colors as new corporate colors.
- Change Email V4 in the initial web Design System PR.
- Claim this target is live until implementation and verification prove it.

---

## 18. Decision record

The v3.1-final closure established the following material decisions:

- preserve the existing visual equity rather than rebrand;
- canonical public identity: `Francisca Bustos M.`;
- primary descriptor: `Psicóloga Clínica · Perinatal`;
- secondary descriptor: `Psicología Perinatal`;
- roman `M.`;
- portrait for Instagram/LinkedIn avatar;
- `fb` restricted to favicon/apple-touch;
- corporate palette explicitly separated from Support/UI colors;
- Fraunces + Inter remain the core type system;
- responsive lockups use measured minimums rather than estimates;
- availability is factual and neutral;
- Design System and Content/Clinical Claims Governance are separate domains;
- Email V4 is a bounded Production visual exception, not a blocker to the web system.

Any material change to these rules must update this file in the same change and explain why the canonical decision changed.

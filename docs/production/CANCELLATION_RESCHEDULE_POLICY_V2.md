# Cancellation & Reschedule Policy V2 — patient self-management

Status: **deployed to Production on 2026-09-04** from `7eaf034` — Apps Script immutable
**v10** on the existing versioned Web App deployment (`AKfycbyfioG2bs…`, same `/exec`),
Cloudflare Pages Production deployment `f1626b71…`. Previous immutable version **v9**
and the baseline-binding Pages deployment `34bc77bd…` remain as rollback targets.
Monetary E2E not yet run. Baseline it builds on: `bf62852`.

## The rule

```
PATIENT_MANAGEMENT_CUTOFF_HOURS=24
cutoff_at = current_start_at - 24 chronological hours
```

| remaining time to the CURRENT session start | reschedule | cancel | refund | refund % |
| --- | --- | --- | --- | --- |
| `>= 24h` | YES | YES | YES | 100 |
| `0 < r < 24h` | NO | YES | NO | 0 |
| `<= 0` (started / past) | NO | NO | NO | 0 |

Cancellation stays available right up to the session start so a patient can
always tell us they will not attend. Only the money and the reschedule change.

### Boundary contract

Session start Friday 15:00 (America/Santiago):

| clock | remaining | reschedule | cancel | refund |
| --- | --- | --- | --- | --- |
| Thursday 14:59 | 24h01m | YES | YES | YES |
| Thursday 15:00 | exactly 24h | **YES** | YES | **YES** |
| Thursday 15:00:01 | 23h59m59s | **NO** | YES | **NO** |
| Friday 14:30 | 30m | NO | YES | NO |
| Friday 15:00 or later | — | NO | NO | NO |

Exactly 24 hours is **inclusive**. The boundary is asserted to millisecond
precision in `test/management-policy-24h.test.mjs`.

## Canonical source

```
getBookingManagementPolicy_(reservation, serverNow)
  backend/appsscript/booking/Lifecycle.js
```

Returns a frozen decision:

```
can_reschedule  can_cancel  refund_eligible  refund_percent
cutoff_at  cutoff_hours  remaining_ms  session_start_at
window  reason
```

Nothing else in the repository derives a 24-hour window. Every consumer reads
this function:

| consumer | what it reads |
| --- | --- |
| `patientRescheduleTransaction_` | `can_reschedule`, re-evaluated under the lock |
| `patientCancelTransaction_` | `can_cancel`, and `refund_eligible` ANDed over the evaluator |
| `patientCancellationRefundPolicy_` | `refund_eligible`, `refund_percent` |
| `patientCancelFullRefundEligible_` | `refund_eligible` |
| `publicManagementRecord_` (`/manage` lookup) | the whole decision, projected |
| `_worker.js` | forwards the upstream projection; clamps unknown values CLOSED |
| `manage.html` | renders the projection; computes nothing |
| `EmailTemplates.js` | reads `PATIENT_MANAGEMENT_CUTOFF_HOURS` for the copy |

There is exactly one expression that can make a cancellation refundable:

```js
const refundEligible = beforeCutoff && paid;
```

Every branch of the policy reads it rather than restating a literal, so a
mutation there is detected by the suite.

## Authority rules

**Server time.** `serverNow` defaults to the server clock. A value that is not a
real instant (a numeric string, a boolean, `NaN`) is refused, not coerced —
coercion is how a garbage clock quietly becomes epoch 0, an instant from which
every window looks open. No public payload field carries a clock: neither
`CREATE_FLOW_FIELDS` nor the management token parsers accept one, and the Worker
forwards only `token` / `fecha` / `hora`.

**Current schedule.** Only `current_start_at` is read. `original_start_at` is the
pre-reschedule appointment and never drives the cutoff, so after a valid
reschedule the window recomputes from the newly persisted start.

**Stale pages and direct calls.** Both mutations re-read the reservation from the
store inside the lock and re-evaluate the policy there, immediately before
writing. A page that rendered REAGENDAR with 26 hours left and is submitted four
hours later is rejected with `RESCHEDULE_WINDOW_CLOSED`. Links in
already-delivered emails still resolve to `/manage`; the server refuses the
action. `manage.html` contains no 24-hour arithmetic at all, which the
`test-manage-contract` gate asserts.

**DST.** The cutoff is absolute-instant subtraction, never "previous calendar
day" or "same date minus one". The suite locates both real America/Santiago
transitions and asserts that a window straddling one stays exactly 24
chronological hours — and that the Santiago wall-clock hour of the cutoff
therefore *differs* from the session hour, which a calendar-based implementation
would not produce.

**Fail closed.** Missing reservation, unusable `current_start_at`, unusable
policy timestamp, or a booking that is no longer self-manageable all authorize
nothing. Refund eligibility additionally requires `payment_status === 'paid'`.

## Management link lifetime

A management capability lives as long as the business policy leaves management
open, and not one moment longer:

```
capability_expires_at = current_start_at + one slot interval (60 min)
```

It is **not** a fixed TTL. A fixed 24-hour TTL — what this branch shipped before
`43a55bb` was hardened — handed a patient who booked three weeks out a link that
died while REAGENDAR and the full refund were still legitimately available,
making the `>=24h` branch unreachable in practice for normal future bookings.

The grace is what keeps the POLICY the authority that speaks at the boundary. A
patient who opens `/manage` a minute before the session gets a neutral closed
state from `getBookingManagementPolicy_` rather than a broken link, and a
mutation attempted seconds after the start is refused as
`MANAGEMENT_WINDOW_CLOSED` — a policy decision — not as a bad token.

**Where it is minted.** Every outbox delivery calls
`retryLifecycleNotification_`, which mints the CTA capabilities from the record
it just read under the lock. So each lifecycle email — confirmation, patient
reschedule, clinician reschedule — carries a capability scoped to the session
start current *at send time*, and rotation invalidates the previous bearer.
`ensureManagementCapabilities_` pre-provisions on confirmation using the same
horizon. `original_start_at` is never consulted.

**When the schedule moves.** `alignedCapabilityExpiryFields_` re-scopes the live
stored capabilities onto the new horizon on both a patient reschedule and a
clinician move: extended when the session moves later, contracted when it moves
earlier. It never resurrects a capability that is already revoked or expired — a
schedule change must not give a dead bearer a second life.

**Bounded.** `CAPABILITY_UNBOUNDED=NO`. The lifetime is pinned to one concrete
instant, and clamped to the canonical `AVAILABILITY_HORIZON_DAYS` (90) so a
corrupted far-future `current_start_at` cannot mint a capability that outlives
the window such a booking could have come from. An unusable or already-passed
horizon mints nothing: the email still sends, simply without management buttons
it could not honour.

**Token validity is never authorization.** A cryptographically valid capability
is necessary and never sufficient. At `current_start - 23h59m` the bearer is
still valid and the policy still refuses the reschedule and the refund. Every
action is authorized by `getBookingManagementPolicy_`, re-evaluated under the
lock at action time, and a valid capability alone bypasses none of: the 24-hour
reschedule cutoff, the 24-hour refund cutoff, the one-move reschedule cap, the
cancellation state, or a session that has already started.

`CAPABILITY_TTL_MS` (24h) survives only as the fallback for a primitive caller
with no schedule context. Every production mint passes an explicit
schedule-derived `expiresAt`; falling back to that fixed TTL is the defect this
design exists to prevent, which is why a mutation restoring it must fail the
suite.

## Booking lead time — 120 minutes, one constant, three surfaces

```
bookable  iff  slot_start >= server_now + BOOKING_LEAD_MINUTES (120)
```

The same canonical constant and the same comparison govern all three places a
slot can be chosen, so they cannot disagree:

| surface | behaviour |
| --- | --- |
| `assertBookableSlot_` (new booking) | refuses a too-soon slot |
| `patientRescheduleTransaction_` (target) | refuses with `TARGET_LEAD_TIME_TOO_SHORT` |
| `availability_` (both pickers) | reports a too-soon slot as occupied, so it is never offered |

`availability_` returns the **occupied** slots and the client subtracts them, so
withholding a slot means reporting it occupied. Passing `leadCutoffMs` into
`computeOccupiedSlots_` is what does it; the parameter is optional, so every
other caller keeps its original behaviour. The filter is exact rather than
conservative: the hour exactly 120 minutes away is still offered *and* is
genuinely bookable, and one millisecond nearer is withheld. The picker's own
browser-time filter remains as defence in depth — it can only narrow further,
never widen.

### Reschedule target

```
target_start_at >= server_now + BOOKING_LEAD_MINUTES (120)
```

Enforced inside `patientRescheduleTransaction_`, under the lock, using the same
canonical `BOOKING_LEAD_MINUTES` and the same comparison that
`assertBookableSlot_` applies to a new booking — one number, one meaning, no
duplicate constant. The picker enforces it client-side too, but a browser is not
authority: a hand-rolled payload, a tampered page and a stale tab are all
refused here with `TARGET_LEAD_TIME_TOO_SHORT`. Exactly `+120m` is allowed;
`+119m59s`, `now`, and any past instant are refused. Availability and
slot-collision behaviour is unchanged — a taken slot still reports `SLOT_TAKEN`.

## Money

### `>= 24h` cancellation

```
schedule_status=cancelled            (slot released immediately)
booking_status=cancellation_requested
refund_status=refund_requested   -> refund/create ×1 -> refund_pending
                                 -> provider acceptance in Flow
                                 -> callback REFUNDED
                                 -> booking_status=cancelled + ONE final email
```

`REFUND_CREATE_EFFECTIVE_MAX=1` and `FINAL_PATIENT_CANCELLATION_EMAIL_MAX=1`.
Amount is the full `consultationAmountClp_` against the original confirmed
transaction. No patient email claims a refund before the provider confirms; a
refund failure parks the reservation for manual review and still claims nothing.
A replayed cancellation, a double click and a replayed provider callback each
add neither a refund nor a second email.

### `< 24h` cancellation

```
schedule_status=cancelled            (slot released immediately)
booking_status=cancelled             (terminal at once)
refund_status=not_required
refund_last_error_code=PATIENT_CANCEL_LATE_NON_REFUNDABLE
Flow refund/create calls = 0
patient emails = exactly 1, economically silent
operator manual-review notices = 0
```

`not_required` is the durable record that this cancellation was **decided**
non-refundable, as opposed to `manual_review`, which means "a human still has to
look". That distinction is what keeps a normal late cancellation out of
Francisca's operational queue.

### Why a callback cannot resurrect a refund

`beginRefundForPaidCancellation_` authorizes a Flow call only when the persisted
`refund_status` is one of `refund_requested / refund_pending / refunded /
refund_failed` — all of which are reachable only downstream of a policy-approved
`refund_requested`. A late cancellation persists `not_required`, so any replay,
reconciliation pass or callback attempt is refused with `REFUND_NOT_AUTHORIZED`
before a request is built. The refusal reads stored state; it does not recompute
a window and does not trust its caller. A spoofed refund callback additionally
cannot find the row, because no `refund_provider_reference` was ever stored.

## Patient-facing copy (approved)

**Before payment** — `reserva.html`, review step, above "Continuar al pago":

> Puedes reagendar o cancelar tu sesión sin costo con al menos 24 horas de
> anticipación. Si cancelas con menos de 24 horas, puedes igualmente avisarnos
> que no asistirás, pero la sesión no será reembolsable ni podrá reagendarse.

**Confirmation email** — under the REAGENDAR / CANCELAR actions it explains:

> Puedes reagendar o cancelar tu sesión hasta 24 horas antes del horario agendado.

Confirmation only. After a patient reschedule the state machine has spent the
single allowed move, so the reminder would be untrue and is not rendered.

**`/manage`, reschedule closed:**

> Ya no es posible reagendar esta sesión porque faltan menos de 24 horas para el
> horario agendado.

**`/manage`, cancellation with a refund:**

> Puedes cancelar esta sesión y recibir el reembolso completo al mismo medio de
> pago utilizado.

**`/manage`, cancellation without a refund:**

> Esta sesión comienza en menos de 24 horas. Puedes cancelarla para informarnos
> que no asistirás, pero de acuerdo con la política de cancelación no corresponde
> reembolso.

**Refund confirmed** (unchanged from V3):

> El reembolso fue procesado al mismo medio de pago utilizado. Dependiendo de tu
> banco o emisor, puede tardar hasta 10 días hábiles en verse reflejado.

`faq.html` previously claimed late cancellations "se cobran en un 50%". That
contradicted the approved policy and was corrected in both the visible FAQ and
its JSON-LD.

## Public `/manage` contract

`manage_lookup` returns, in addition to the existing fields:

```
managementWindow : 'open' | 'cancel_only' | 'closed'
canReschedule    : boolean   (policy AND one-move-remaining)
canCancel        : boolean
refundEligible   : boolean
refundPercent    : 100 | 0
cutoffAt         : ISO instant
cutoffHours      : 24
```

`managementWindow` is a deliberately public vocabulary: no internal lifecycle
state name is exposed. The Worker clamps an unrecognised window to `closed`, so a
degraded upstream response cannot render an action the server did not authorize.

The explanatory note on the page must name the **true** reason an action is
missing, so it is evaluated most-restrictive-first:

1. window `closed` — the session no longer accepts online changes
2. status `rescheduled` — the one-move cap is spent; this is the binding reason
   in *any* window, so attributing it to the 24-hour cutoff would be false
3. window `cancel_only` — here the cutoff genuinely is the reason

A cancelled reservation carries no note; its own state says it.

New rejection codes, all mapped to non-alarmist copy in `manage.html`:

```
RESCHEDULE_WINDOW_CLOSED   — reschedule requested inside the cutoff, or past session
MANAGEMENT_WINDOW_CLOSED   — cancel requested on a started/past or undeterminable session
TARGET_LEAD_TIME_TOO_SHORT — reschedule target inside the 120-minute lead time
```

## Residual decisions at deploy-readiness

Audited and closed before deployment:

| # | residual | decision |
| --- | --- | --- |
| 1 | A management capability can live up to the 90-day booking horizon | **Accepted by design.** Shortening it reintroduces the reachability defect. Mitigated by: one reservation, one purpose, an opaque 96-hex-character bearer (three UUIDv4s, ~366 bits of entropy), HMAC-at-rest with constant-time compare, rotation on every lifecycle send retiring the previous bearer, revocation on use for reschedule, a hard clamp to the booking horizon, and every action re-authorized by policy under the lock. No PII in the response. |
| 2 | Capability may stay valid one slot interval past the session start | **Accepted by design.** Read-only only: `/manage` resolves so the patient sees a neutral closed state instead of a broken link, while reschedule, cancel and refund are all refused as policy decisions. |
| 3 | Availability could list a slot inside the 120-minute lead time | **Fixed.** `availability_` now withholds them at source; see the lead-time section above. |
| 4 | A patient may reschedule once into the `<24h` band | **Accepted by design**, plus accurate copy. Behaviour unchanged: `current_start_at` becomes authoritative, the one-move cap blocks a second move, and cancellation/refund follow the new schedule. The page now states the true reason ("ya usaste el cambio de horario disponible") instead of misattributing it to the cutoff. |
| 5 | `docs/booking/` is gitignored | **Governance only.** The ignore rule is unchanged; this page is the tracked document of record and is self-contained. |
| 6 | An anonymous `@HEAD` Web App deployment exists on the Production project (`AKfycbx36YM9SZ…`, access `ANYONE_ANONYMOUS`) | **Residual hardening item — not closed.** Production is bound to the versioned deployment and never to `@HEAD` (verified 2026-09-04: pushing Policy V2 to HEAD did not change Production until the versioned deployment was repointed). No safe deterministic closure exists today: the `@HEAD` entry is the implicit head deployment, which the Apps Script API/clasp do not delete, and `webapp.access` lives in the manifest, so restricting it would also restrict the canonical deployment. Recommended future action: keep HEAD free of anything not yet release-gated; revisit if Apps Script exposes per-deployment access control. |

## Out of scope, unchanged

```
CLINICIAN_CANCELLATION=BUSINESS_POLICY_TBD
```

Clinician cancellation economics are a separate, still-open product decision.
`reconcileClinicianCancellation_` keeps evaluating through
`refundPolicy_` / `activeRefundPolicy_` and keeps parking paid clinician
cancellations in `manual_review`. Also unchanged: `paid_after_hold_expiry`
remediation, chargebacks, administrative refunds, Flow signing and endpoints,
`payment/create`, status mapping. There is no no-show workflow and none was added.

## Regression coverage

`node backend/appsscript/booking/test/management-policy-24h.test.mjs`

Covers the boundary to the millisecond, both DST transitions, current-start
authority, the stale-page and direct-call races, browser-clock spoofing, the
fail-closed inputs, refund counts on both sides of the cutoff, email counts,
replay/double-click, the callback guard, and the `/manage` projection. It then
re-runs the load-bearing subset against seven deliberately broken builds and
requires each mutation to be detected.

`node backend/appsscript/booking/test/capability-reachability.test.mjs`

Covers the horizon primitive, a real emailed link surviving 24h and remaining
valid at the policy boundary for bookings 7 and 30 days out, the
token-validity-vs-authorization separation at 23h59m, re-scoping on both patient
and clinician reschedules, the refusal to resurrect a dead bearer, the bounded
ceiling, the fail-closed reads of both canonical constants, and the 120-minute
target floor to the millisecond through both the transaction and the endpoint,
and the availability lead filter at the boundary — including that a withheld
slot cannot be booked while an offered boundary slot can.
Seven further mutations must each be detected.

Both suites share one VM harness, `test/helpers/policy-harness.mjs`, so the
fake gateways and the mutation machinery cannot drift between them.

Note: `docs/booking/` is gitignored in this repository, so the operational
notes there are local only. This page is the tracked document of record.

### Running the gates

Local only; no Production call, no Flow call, no email, no booking.

```
# the two policy suites
node backend/appsscript/booking/test/management-policy-24h.test.mjs
node backend/appsscript/booking/test/capability-reachability.test.mjs

# the rest of the booking suite
for t in phase-a booking-clock-contract lifecycle notification-outbox-worker \
         notification-outbox-sheet sequential-notification-harness \
         no-drain-notification-harness pre-transaction-contract flow-contract \
         lifecycle-harness calendar-metadata-reconciliation \
         email-design-system-v3 lifecycle-email-v2 \
         production-derived-integration session-duration-contract \
         property-compatibility calendar-manifest-contract \
         production-trigger-contract v7-schema-compatibility \
         preview-host-validation clasp-fileset-release-gate \
         clasp-staging-release-gate; do
  node backend/appsscript/booking/test/$t.test.mjs || echo "FAIL $t"
done

# static and privacy gates
node scripts/assert-production-secret-scan.mjs
node scripts/assert-production-legacy-price-scan.mjs
node scripts/assert-production-contamination-firewall.mjs
node scripts/assert-production-clasp-staging-gate.mjs
node scripts/assert-production-worker-structure.mjs _worker.js
node scripts/test-production-worker-routes.mjs
node scripts/test-production-payment-status-privacy.mjs
node scripts/test-manage-contract.mjs
git diff --check

# email previews (needs local Chrome; deterministic, offline)
node scripts/render-email-v3-previews.mjs
```

The `*-nonprod-*` scripts and `scripts/validate-nonprod-boundary.sh` /
`scripts/validate-recovery-docs.sh` validate the NONPROD artifact, which does
not exist on this Production-derived branch. They fail identically at the
accepted baseline and are not gates for this work.

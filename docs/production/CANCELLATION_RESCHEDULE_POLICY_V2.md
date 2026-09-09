# Cancellation & Reschedule Policy V2 — patient self-management

Status: **deployed to Production**. Current permanent runtime is Apps Script immutable
**v20**, built from canonical `8455f3b` (PR #11, explicit UTF-8 Flow signatures) on the
existing versioned Web App deployment (same `/exec`); rollback target **v18**
(`3d5a9a8`). Policy V2 itself first shipped on 2026-09-04 from `7eaf034` as v10 on the
same deployment, Cloudflare Pages Production `f1626b71…`. The Production booking E2E
was measured on 2026-09-08 at a bounded CLP 500 through the real public booking path
(see **Production booking E2E — 2026-09-08** below); the public/catalog price stayed
50000 throughout. Baseline it builds on: `bf62852`.

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

### Catalog price vs transaction amount

Two different numbers. Conflating them was a defect: every money-bearing read
used to re-derive the amount from the live catalog, so changing the commercial
price would silently rewrite the money of orders that had already been paid.

| | What it is | Where it comes from | Authoritative for |
| --- | --- | --- | --- |
| **Catalog price** | what a new order costs today | `consultationAmountClp_`, from `INITIAL_PRICE_CLP` / `FOLLOWUP_PRICE_CLP` = 50000 | choosing the amount of a **new** payment order, and nothing else |
| **Transaction amount** | what this reservation committed to | `transaction_amount_clp`, column 58, frozen at order creation | payment status, the confirmation email, refund authority |

The catalog is read exactly once per reservation, in `reserveOnce_`, and the
result is persisted. `transactionAmountClp_` is the only reader of that column
for money. `displayAmountClp_` falls back to the catalog for a row created
before the column existed; that fallback renders a status page or an email and
is **never** refund authority.

**Charging.** `payment/create` is priced from the reservation and from nothing
else. There is deliberately no catalog fallback: a reservation with no bound
amount refuses to be charged with `PAYMENT_AMOUNT_UNAUTHORIZED`, before any Flow
call. A retry after a rejected or failed payment therefore charges the amount the
reservation has always carried, whatever the catalog says by then.

**Provider reconciliation.** On a Flow `PAID` webhook the server compares what
Flow says it charged against the bound amount before any state changes
(`providerAmountMatchesTransaction_`). Five ways to fail, all closed:

| Condition | Code |
| --- | --- |
| reservation has no bound amount | `TRANSACTION_AMOUNT_UNKNOWN` |
| provider amount absent, non-positive, or not a whole number | `PROVIDER_AMOUNT_UNREADABLE` |
| provider amount differs from the bound amount | `PROVIDER_AMOUNT_MISMATCH` |
| provider currency absent or blank | `PROVIDER_CURRENCY_UNREADABLE` |
| provider currency is not CLP | `PROVIDER_CURRENCY_MISMATCH` |

CLP has no minor unit, so a fractional provider amount is not a CLP amount: it is
refused rather than rounded into agreement, because rounding is how a real
discrepancy would be hidden. The currency must be stated — inferring CLP from
silence is how a wrong-currency settlement would be waved through. Case and
surrounding whitespace are normalized, because those are presentation; absence is
not.

Any of them sets `booking_status=manual_review`, records the code in
`reconciliation_state`, and stops: no payment transition, no Calendar or Meet
artefact, no patient email. The refusal is idempotent across webhook retries,
and a later callback that *does* agree cannot auto-confirm a parked reservation
— clearing manual review is a human decision.

**Provider signature encoding.** Every Flow API signature (`signFlowParams_` for
`payment/create` and `payment/getStatus`, `refundSign_` for `refund/*`) is an
HMAC-SHA256 over the sorted `key+value` concatenation, computed with
`Utilities.Charset.UTF_8` **explicitly**. This is a contract, not a style
choice. On 2026-09-07 every booking-path `payment/create` was being rejected by
Flow at CLP 500 and CLP 50000 alike, while standalone provider probes with
ASCII-only subjects succeeded. The proven cause, measured on the real Apps
Script V8 runtime with synthetic inputs: the two-argument String overload of
`Utilities.computeHmacSha256Signature` is **not** UTF-8 — it encodes as
US-ASCII and maps every non-ASCII character to `?`, so the subject
`Sesión Francisca Bustos` was signed as `Sesi?n Francisca Bustos` while the body
carried the UTF-8 bytes Flow verifies against. The provider's error code alone
was not diagnostic (it is only documented for another endpoint); the runtime
probe was. Prevention: the test stub for `Utilities` models the implicit
overload as US-ASCII, exactly as measured, and the signature suite verifies the
transmitted `s` against an independent Node HMAC over UTF-8 bytes rather than
against the signer under test. Removing the explicit charset from either signer
fails the suite.

Release evidence, 2026-09-07: PR #11 merged as canonical `8455f3b`; staged
8-file artefact byte-identical to canonical; pushed, immutable Apps Script
**v20** created and the existing versioned Web App repointed to it; v20 pulled
back and verified byte-identical to canonical, both Flow signers explicit UTF-8,
no temporary lane symbols, catalog 50000, holiday 2026-09-18 fully occupied,
availability healthy. Rollback target: **v18**. Production proof followed on
2026-09-08: the first booking-path `payment/create` accepted by Flow since the
port (see **Production booking E2E — 2026-09-08**).

**Refund authority.** `createProviderRefundOnce_` refunds the bound amount. An
unknown bound amount is not a licence to guess: it records
`refund_status=manual_review` with `refund_last_error_code=REFUND_AMOUNT_UNKNOWN`,
raises the internal manual-review notification, and makes **zero** Flow calls.

**Rows created before the column existed.** They are backfilled from `priceClp`,
the amount the v7 runtime wrote onto each reservation when it was created. That
is a stored per-row fact, which is what makes the backfill deterministic rather
than a guess; the catalog price is never a source, because it says what a booking
would cost today and not what this one cost. The backfill runs inside the schema
migration, only ever writes a cell that currently holds no readable amount, and
leaves a row that cannot prove an amount with none. `PRODUCTION_RC_RUNBOOK.md`
§2.3a makes a live paid booking that would be left without a provable amount a
release blocker rather than a silent downgrade to manual review.

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
Amount is the full transaction amount bound to this reservation at order
creation, not the catalog price, which may have moved since. No patient email claims a refund before the provider confirms; a
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

## Provider micro-E2E evidence — 2026-09-06

Runbook §5A, `FLOW_PROVIDER_MICRO_E2E`. **Provider scope only.** Executed against
Flow Production with synthetic, non-clinical data and an operator-controlled
mailbox. It did not touch the booking application path: no reservation, no Sheet
row, no Calendar/Meet, no lifecycle email, and no Production runtime or
deployment change (canonical stayed on immutable v10, HEAD canonical).

| item | result |
| --- | --- |
| provider sample | `commerceOrder=micro-e2e-20260906032639-1`, `flowOrder=180481275` |
| amount | CLP 500 (provider minimum sample — **not** the commercial price) |
| `payment/getStatus` | `status=2` (PAID), amount 500, currency CLP |
| `refund/create` | **HTTP 501 insufficient funds** — provider-side rejection |
| effective refunds | 0 |
| real charges | 1 · gross CLP 500 · refunded CLP 0 · net test cost CLP 500 |

The 501 is a **provider-funds condition, not an application defect**: Flow
authenticated and accepted the signed `refund/create` request and refused it on
merchant balance. Refund credentials, endpoint, signature and parameter contract
are therefore exercised; refund *completion* is not.

A second CLP 500 payment was authorized but deliberately **not** created. Flow's
current guidance requires available funds sufficient to cover the refund amount
**plus the refund service fee** (CLP 202 + IVA = CLP 240 at the time of this
run), drawn from payments not yet transferred to the merchant bank account. The
observed account state returned HTTP 501 insufficient funds for the CLP 500
refund. A second CLP 500 payment might have increased the available balance
enough to clear it, but this was **not verified** and was intentionally not
attempted, because the runbook permits recording the provider-funds blocker
without additional spend. No claim is made here about settlement timing or
availability mechanics beyond what Flow documents.

Recorded per runbook §6 as `FLOW_REFUND_E2E=BLOCKED_PROVIDER_FUNDS_501`, the
"waived with recorded provider-funds blocker" branch. It did **not** substitute
for the booking-application E2E, which is recorded next.

## Production booking E2E — 2026-09-08

The real public booking path, end to end, on the Production runtime, with a
synthetic operator identity (`hola@franciscabustos.cl`), no patient data, and a
bounded charge of CLP 500. The public/catalog price was 50000 before, during and
after; the 500 was bound to one reservation as its immutable
`transaction_amount_clp` by a **temporary, since-retired test mechanism** (below),
and every downstream read — payment status, reconciliation, email, refund — used
that bound amount, exactly as the Money section requires.

Why the E2E was needed at all: every booking-path `payment/create` had been
rejected by Flow at any amount. The proven cause and the permanent fix are in
**Money → Provider signature encoding** (implicit Apps Script HMAC charset,
`Sesión` signed as `Sesi?n`; fixed in canonical `8455f3b`, immutable v20). The
first Production `payment/create` accepted by Flow since the port was the
2026-09-08 create below.

| step | result |
| --- | --- |
| runtime serving the create | TEMP immutable v22 (canonical v20 + bounded lane), repointed back to **v20 before payment**, both transitions positively verified in the deployment listing |
| `payment/create` | HTTP 200, order/token/URL persisted, `amount=500`, `currency=CLP` |
| payment | one real charge, CLP 500, `payment/getStatus` PAID (status 2), reconciled by `providerAmountMatchesTransaction_`; public status `payment_confirmed`, amount 500 |
| booking | confirmed exactly once; slot 2026-09-16 11:00 occupied |
| Calendar / Meet | one event, Meet conference created |
| confirmation email | one, via the outbox |
| reschedule | exactly one, 11:00 → 15:00 same day, `patient_reschedule_count=1`, same Calendar event id, Meet preserved, one reschedule email (delivered on the next 5-minute outbox tick) |
| cancellation | ≥ 24 h before the current start, accepted once; slot released (availability for 2026-09-16 shows no occupancy) |
| refund | exactly one `refund/create` for the bound 500; Flow **rejected** it; backend recorded `PROVIDER_REFUND_REJECTED` → manual review; **no** refund-confirmation email to the patient; no second attempt |
| money | total new charges 1 · gross CLP 500 · refunded 0 · plus one earlier catalog-priced order that was created by mistake (see below), never paid, expired at its 15-minute hold |

Terminal classification: `BOOKING_APPLICATION_E2E=PASS` for the application path;
`FLOW_REFUND_E2E=BLOCKED_WITH_PROVIDER_EVIDENCE` after the single authorized
attempt: the provider rejected the request and the reservation sits in manual
review. No cause beyond "provider rejected" is asserted for this attempt, because
the provider's response body for it was not retained; nothing here should be read
as a funds or fee diagnosis.

**The temporary lane, retired.** A `DO NOT MERGE` branch
(`temp/fra4-e2e-lane-20260907`) compiled four constants into a TEMP-only Apps
Script version: the enrolled synthetic mailbox, amount 500 (compiled ceiling 500),
an absolute expiry (2026-09-12T02:59:59Z), and the deterministic commerce
identifier of one earlier failed row that a read-only
`payment/getStatusByCommerceId` had proven absent at Flow (`1700 Transaction not
found`). At most one lane order per enrolled address, counted from the sheet
under the reservation lock; a sanitized read-only preflight had to report
`ok=true` before the single create. It never entered `production` and it read no
Script Property.

Transitory deployment history, kept on purpose. Three TEMP versions existed.
**v19** (Script-Property-driven lane on the pre-fix runtime) was the live
version when the original outage was diagnosed and was replaced by permanent v20
on 2026-09-07. **v21** (Script-Property-driven lane on v20) was repointed live on
the existing Web App three times on 2026-09-08, each for minutes, and restored to
v20 each time with the restore positively confirmed in the deployment listing;
during its third window one create was made and priced at the catalog because a
Script Property had been crossed — the fail-closed behaviour worked as designed
and produced the one mistaken, unpaid CLP 50000 order that expired at its
15-minute hold. **v22** (the self-contained lane) was repointed live once on
2026-09-08, served the single CLP 500 create, and was restored to v20 before any
payment, again positively confirmed. How that window is evidenced without
operational identifiers: the one-shot runner's transcript shows, in order, the
deployment listing bound to `@22`, a `200` from the sanitized
`e2e_lane_preflight` action (which exists only in v22 — v20 answers `NOT_FOUND`),
the create with public payment status `payment_pending` / amount **500** (v20 can
only price a new order at 50000, so a 500-priced order is itself proof of v22
serving it), and then the listing bound to `@20` before the payment was made.
At closure no Production deployment
references v19, v21 or v22; they remain only as immutable version history. None
of this is architecture: the permanent runtime prices every new order from the
catalog only.

Cleanup verified (FRA-5): existing Web App at **v20** (canonical
`8455f3bfcef3546fab5d9b169805f35244b8c3e1`, permanent rollback **v18**); no TEMP
lane version referenced by any deployment; canonical `8455f3b` and v20 contain
no lane symbols; no `E2E_LANE_*` Script
Property is read by v20 (the four were deleted); public price 50000; availability
healthy, holiday 2026-09-18 fully occupied, the cancelled E2E slot free; no
browser-facing `script.google.com` reference; local checkout/token artefacts
destroyed.

Follow-up (FRA-6, non-blocking): the cancellation UI can show a duplicated state
while cancelling ("Cancelar sesión" and "Cancelando…") and its final copy can say
the refund is "en proceso" although the backend recorded a terminal
`PROVIDER_REFUND_REJECTED`. The fix must map the page deterministically to the
persisted backend/provider state and never imply a confirmed or still-processing
refund after a terminal rejection.

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

`node backend/appsscript/booking/test/transaction-amount-integrity.test.mjs`

Covers the catalog / transaction separation end to end: a booking paid at one
price keeps its money after the catalog moves the other way, in payment status,
in both email renderings and in the refund request; the provider-amount
reconciliation on the PAID webhook, including that a mismatch produces no
Calendar artefact and no patient email, that webhook retries are idempotent, and
that a parked reservation is never auto-confirmed; a pre-migration row with no
bound amount refusing to guess a refund while still releasing the slot; refund
replay staying at one effective call; and an ordinary 50000 booking flowing
green through reschedule and cancellation with its bound amount intact. Seven
further mutations must each be detected.

`node backend/appsscript/booking/test/flow-signature-charset.test.mjs`

Covers the Flow signature encoding contract: the `Utilities` stub is first
proven faithful to the digests measured on the real Apps Script runtime
(implicit overload equals US-ASCII, `Sesión` signed as `Sesi?n`), then the
production signers are checked against an independent UTF-8 oracle — the
non-ASCII subject, the ASCII control, `payment/create` at CLP 500 and CLP 50000
with the signed string equal to the transmitted body minus `s`, and
`payment/getStatus` and `refund/create` with a non-ASCII value. Two mutations,
each removing the explicit `Utilities.Charset.UTF_8` from one signer, must be
detected.

Both policy suites share one VM harness, `test/helpers/policy-harness.mjs`, so
the fake gateways and the mutation machinery cannot drift between them. Its Flow
`payment/getStatus` fake echoes the settled amount and currency, as the real
provider does, and exposes an override so the reconciliation gate can be driven
from a real webhook call rather than a unit stub. Its `Utilities` stub comes from
`test/helpers/apps-script-utilities.mjs`, which reproduces the measured runtime
charset behaviour; a suite that models the implicit HMAC overload as UTF-8 is
the reason the 2026-09-07 signing defect passed every test.

Note: `docs/booking/` is gitignored in this repository, so the operational
notes there are local only. This page is the tracked document of record.

### Running the gates

Local only; no Production call, no Flow call, no email, no booking.

```
# the two policy suites
node backend/appsscript/booking/test/management-policy-24h.test.mjs
node backend/appsscript/booking/test/capability-reachability.test.mjs
node backend/appsscript/booking/test/transaction-amount-integrity.test.mjs
node backend/appsscript/booking/test/availability-dst-bounds.test.mjs

# the rest of the booking suite
for t in phase-a booking-clock-contract lifecycle notification-outbox-worker \
         notification-outbox-sheet sequential-notification-harness \
         no-drain-notification-harness pre-transaction-contract flow-contract \
         flow-signature-charset lifecycle-harness calendar-metadata-reconciliation \
         email-design-system-v4 lifecycle-email-v2 \
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
node scripts/test-booking-availability-contract.mjs
git diff --check

# email previews (needs local Chrome; deterministic, offline)
node scripts/render-email-v4-previews.mjs
```

The `*-nonprod-*` scripts and `scripts/validate-nonprod-boundary.sh` /
`scripts/validate-recovery-docs.sh` validate the NONPROD artifact, which does
not exist on this Production-derived branch. They fail identically at the
accepted baseline and are not gates for this work.

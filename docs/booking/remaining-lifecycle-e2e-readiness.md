# Remaining lifecycle E2E readiness — post-runtime notification + terminal closeout

SOURCE / TESTS / DOCS only. No runtime activation in this Cursor pass.
Production is ABSOLUTE NO-TOUCH.

Codex must independently read the actual Git HEAD during preflight.
Do not require this document to contain the SHA of the commit that contains it.

## POST_RUNTIME_NOTIFICATION_AND_TERMINAL_CLOSEOUT

```
AUDIT_START_HEAD=4c2b4c974db2b1276c552b6821390ca0413c8987
SOURCE_END_HEAD=see Git HEAD of feat/nonprod-booking-lifecycle-20260823 after this closeout commit
BRANCH=feat/nonprod-booking-lifecycle-20260823
PRODUCTION_FINGERPRINT_BASELINE=5699a590f8ec9175129130fc5124b6c1af3ed99ffb8235b22979d338efa0fdb1
SCHEMA_HEADERS=57
SCHEMA_DELTA=none
NONPROD_FLOW_TEST_AMOUNT_CLP=500
FINAL_RUNTIME_REQUIRES_FRESH_SINGLE_MACRO_RUN=YES
REFUND_RUNTIME_REQUIRED_FOR_CLOSEOUT=NO
READY_FOR_FINAL_RUNTIME_CLOSEOUT=YES
```

## RUNTIME_ALREADY_PROVEN

Treat as established NONPROD runtime evidence. Do not redesign these flows.

```
FLOW Sandbox 500 CLP=PASS
FLOW payment=PAID
booking confirmation=PASS
one Calendar event=PASS
Google Meet creation/persistence=PASS
full-sync reconciliation recovery=PASS
patient self-reschedule=PASS
patient_reschedule_count=1
second/stale patient reschedule=REJECTED
same-event clinician Calendar move=PASS
clinician datastore reconciliation=PASS
payment preserved after clinician move=PASS
Meet preserved after clinician move=PASS
patient_reschedule_count after clinician move=1
patient cancellation=PASS
cancel replay/idempotency=PASS
capacity release=PASS
stale capability rejection=PASS
refund_status=manual_review
refund policy classification=EXPECTED_CURRENT_POLICY_STATE
business refund policy=BUSINESS_POLICY_TBD
CANCELLATION_EMAIL delivery=PASS
Production fingerprint=UNCHANGED
```

Independent Gmail evidence for `hola@franciscabustos.cl` on that synthetic lifecycle:

1. exactly the synthetic initial confirmation email
2. the synthetic cancellation email (delivered; no management CTA)
3. no email with subject `Tu sesión fue reagendada`

Cancellation mail is no longer an evidence gap. Reschedule / clinician-move mail was a real runtime gap and is fixed in source below. The already-cancelled booking cannot prove that source fix.

## NOTIFICATION_SEQUENCE_ROOT_CAUSE

CONFIRMED from source.

`enqueueLifecycleNotification_` used a booking-global channel latch:

- CTA notifications wrote `notification_patient_state`
- no-CTA notifications wrote `notification_internal_state`
- enqueue returned early when that field was `sent` or `claimed`

CTA matrix:

- `BOOKING_CONFIRMED` → RESCHEDULE + CANCEL → patient channel
- `PATIENT_RESCHEDULED` / `CLINICIAN_RESCHEDULED` → CANCEL only → same patient channel
- `PATIENT_CANCELLED` / `CLINICIAN_CANCELLED` → no CTA → internal channel

Observed runtime follows that latch exactly:

1. confirmation sent → `notification_patient_state=sent`
2. patient reschedule enqueue saw patient=`sent` and skipped
3. clinician reschedule enqueue skipped the same way
4. cancellation used the unused internal channel and still sent

Logical keys already included event type
(`lifecycle_<reservation_id>_<EVENT_TYPE>_<version>`). Idempotency was
incorrectly applied to the channel field instead of that key.

## NOTIFICATION_SEQUENCE_FIX

Event-scoped outbox idempotency. No schema expansion (still 57 headers).

- Replay of the same logical key (`sent` / `claimed` / `pending` / `failed`) does not enqueue again
- A different event type gets a new logical key, `pending`, and `notification_attempt_count=0`
- `notification_version` increments only when the event type changes
- Prior `sent` / `claimed` / max-attempt state cannot suppress a later logical event
- Unused pending/failed/claimed channel state is cleared so the worker selects the new event
- `notification_max_attempts` reconciliation is cleared for the new event only

Single active outbox slot per booking is unchanged. If a later lifecycle
mutation happens before the worker drains a pending different event, the newer
event supersedes the unsent previous one. The final macro-E2E must drain the
outbox after each mutation.

## CONFIRMATION_EMAIL

```
CONFIRMATION_EMAIL_CONTRACT=PASS
```

Subject: `Confirmación de tu sesión`. Chile local time, Meet, Reagendar + Cancelar,
localized `initial` / `online` labels. Replay does not resend.

## PATIENT_RESCHEDULE_EMAIL

```
PATIENT_RESCHEDULE_EMAIL_CONTRACT=PASS
```

Subject: `Tu sesión fue reagendada`. New canonical Chile local time, current Meet,
CANCEL CTA only, no Reagendar after quota=1. Worker rotates a surviving CANCEL
capability without resurrecting RESCHEDULE.

## CLINICIAN_RESCHEDULE_EMAIL

```
CLINICIAN_RESCHEDULE_EMAIL_CONTRACT=PASS
```

Same subject and CANCEL-only CTA matrix. Clinician-updated Chile local time,
current Meet, patient_reschedule_count unchanged, no RESCHEDULE CTA.

## CANCELLATION_EMAIL

```
CANCELLATION_EMAIL_CONTRACT=PASS
```

Delivery was already proven at runtime and is preserved. Content now:

- explicit cancellation confirmation
- Chile local appointment context
- no Meet / no stale Meet URL
- no Reagendar / no Cancelar / no usable capability

## PATIENT_EMAIL_TIMEZONE_FORMAT

```
PATIENT_EMAIL_TIMEZONE_FORMAT=PASS
```

Canonical formatter: `formatPatientFacingDateTime_`

- timezone = `America/Santiago`
- Chilean Spanish civil presentation, e.g. `jueves 27 de agosto de 2026, 13:00`
- no raw `Z` / UTC ISO in lifecycle email
- DST-safe via `Intl` + explicit timezone
- used for confirmation, both reschedules, cancellation, and any refund
  patient message that shows a date
- datastore canonical ISO timestamps are unchanged

## CANCEL_REGRESSION / CAPACITY_RELEASE_REGRESSION

```
CANCEL_REGRESSION=PASS
CAPACITY_RELEASE_REGRESSION=PASS
```

Notification/outbox changes do not alter atomic terminal cancellation, Calendar
removal, immediate capacity release, capability revocation, cancel replay, or
historical `payment_status=paid` / `patient_reschedule_count=1`. Failed mail
cannot roll back booking/reschedule/cancel.

## REFUND_POLICY_STATE

```
REFUND_POLICY_STATE=PASS
REFUND_RUNTIME_REQUIRED_FOR_CLOSEOUT=NO
```

Canonical policy remains `BUSINESS_POLICY_TBD`. Cancel → capacity released →
booking cancelled → payment remains paid historical truth → `refund_status=manual_review`.
No Production Flow refund is created from this policy. Gateway/idempotency code
stays a dormant capability. Do not require a fake provider refund to close out.

## OUTBOX_RETRY

```
OUTBOX_RETRY=PASS
CAPABILITY_ROTATION_AFTER_TERMINAL_CANCEL=NOT_APPLICABLE
```

Attempts start at 0 for each new logical event and increment monotonically
within that event. Max attempts remain 5 and are event-scoped. A successful
event never resends. A later different event can still send. Capability
rotation happens only while a live CTA exists. Terminal cancellation has no
CTAs, so retry does not rotate or resurrect capabilities.

## CAPABILITY_TERMINAL_STATE / TERMINAL_CLEANUP

MUST BE ABSENT after a completed cancelled lifecycle:

- active booking state
- active slot hold
- live booking Calendar event
- usable RESCHEDULE or CANCEL capability
- duplicate Calendar event or Flow order
- retry item incorrectly stuck as actionable for a sent event
- temporary clasp source artifact

MAY REMAIN:

- cancelled audit row
- historical paid transaction metadata
- cancellation source/timestamp
- `manual_review` refund state
- notification audit metadata (`sent`, outbox key, attempt count)
- provider references
- reconciliation history where safe

Cleanup is not deletion of audit history. The separate old 10:00 ChatGPT-owned
busy fixture remains OUT OF SCOPE.

## NONPROD_CLOSEOUT_CRITERIA

READY_FOR_NONPROD_CLOSEOUT does **not** require:

- deciding Production refund policy
- live destructive Calendar 410/412 reproduction
- deleting legitimate audit rows
- automatic refund while `BUSINESS_POLICY_TBD`

It **does** require:

- zero P0 / zero P1
- notification sequencing fixed (this source pass)
- one-time confirmation / patient reschedule / clinician reschedule /
  cancellation mail (prove on a fresh macro run)
- correct CTA matrix
- no stale Meet in cancellation
- America/Santiago patient-facing times
- no raw bearer persistence
- terminal capability revocation
- capacity remains free
- `manual_review` refund classification
- no orphan runtime resources
- Production fingerprint unchanged
- Git clean
- Apps Script remote parity after the final deployment

## FINAL_RUNTIME_STRATEGY

The existing real NONPROD booking is already terminal CANCELLED. It cannot prove
`PATIENT_RESCHEDULED` or `CLINICIAN_RESCHEDULED` mail after this source fix.

```
FINAL_RUNTIME_REQUIRES_FRESH_SINGLE_MACRO_RUN=YES
```

One new synthetic end-to-end lifecycle only. One new Flow Sandbox transaction
at 500 CLP. No separate runs per feature. Production remains NO-TOUCH.

Required sequence after forcing Apps Script remote parity with branch tip:

1. fresh free slot (new idempotency UUID)
2. Flow Sandbox create 500 CLP → PAID
3. confirmation email
4. **drain notification outbox**
5. patient reschedule → reschedule email (`Tu sesión fue reagendada`, CANCEL only)
6. **drain notification outbox**
7. clinician same-event move → clinician reschedule email
8. **drain notification outbox**
9. patient cancel → cancellation email (no Meet, no CTA)
10. **drain notification outbox**
11. terminal policy: cancelled, capacity free, payment paid, `manual_review`
12. cleanup of orphan runtime resources only; keep audit row
13. Production fingerprint still
    `5699a590f8ec9175129130fc5124b6c1af3ed99ffb8235b22979d338efa0fdb1`

Drain the outbox after each mutation so the single-slot worker cannot supersede
an unsent previous logical event.

## P0 / P1 / P2 / P3

```
P0=none
P1=none
P2=single-slot outbox can supersede an unsent previous logical event if the worker is not drained between mutations; operational drain is required in the final macro-E2E
P3=presencial patient-facing modality label left as stored `presencial`; no in-person positioning invented
```

## READY_FOR_FINAL_RUNTIME_CLOSEOUT

```
READY_FOR_FINAL_RUNTIME_CLOSEOUT=YES
```

Conditional on Codex executing FINAL_RUNTIME_STRATEGY against dedicated
NONPROD Apps Script + Preview, without Production touch, Candidate A touch,
or merge to main.

/**
 * MANAGEMENT LINK REACHABILITY + RESCHEDULE TARGET LEAD TIME.
 *
 * Two invariants that Policy V2 depends on but did not itself establish:
 *
 *  1. A management capability lives as long as the business policy leaves
 *     management open — derived from the CURRENT persisted session start, not
 *     from a fixed TTL. A booking made weeks ahead must still have a working
 *     link when its 24-hour window is finally the thing that decides.
 *
 *  2. The reschedule TARGET must clear the canonical 120-minute lead time
 *     server-side. The picker enforces it too, but a browser is not authority.
 *
 * Throughout: TOKEN VALIDITY != BUSINESS ACTION AUTHORIZATION. A cryptographically
 * valid capability is necessary and never sufficient; getBookingManagementPolicy_
 * decides, re-evaluated under the lock at action time.
 *
 * Deterministic, no network, no mail, no Flow.
 */
import assert from 'node:assert/strict';
import {
  buildHarness, CAPABILITY_SECRET, DAY_MS, HOUR_MS, PATIENT_EMAIL,
} from './helpers/policy-harness.mjs';

const MINUTE_MS = 60 * 1000;

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

const clean = buildHarness(null);
const { context, phase } = clean;
const horizonOf = context.capabilityManagementHorizonIso_;

// ===========================================================================
// PART 1 — the horizon primitive
// ===========================================================================
const scheduled = (startMs, extra) => Object.assign({
  reservation_id: 'fran-booking-reservation-horizon',
  booking_status: 'confirmed', payment_status: 'paid', schedule_status: 'scheduled',
  patient_reschedule_count: '0',
  current_start_at: new Date(startMs).toISOString(),
  current_end_at: new Date(startMs + 50 * MINUTE_MS).toISOString(),
  original_start_at: new Date(startMs - 14 * DAY_MS).toISOString(),
}, extra || {});

const GRACE = phase.CAPABILITY_POST_SESSION_GRACE_MS;
check(GRACE === phase.SLOT_INTERVAL_MS && GRACE === 60 * MINUTE_MS,
  'the post-session grace is one canonical slot interval, not an invented number');
check(phase.CAPABILITY_TTL_MS === DAY_MS,
  'the fixed 24h TTL survives only as the primitive fallback for callers with no schedule');

const START_7D = Date.parse('2026-09-08T13:00:00.000Z');
check(Date.parse(horizonOf(scheduled(START_7D), START_7D - 7 * DAY_MS)) === START_7D + GRACE,
  'CAPABILITY_EXPIRY_AUTHORITY: the horizon is current_start_at plus one slot interval');

// The horizon does not depend on when the capability is minted — only on the
// session. That is the whole difference from a TTL.
[1, 2, 6, 24, 72, 24 * 30].forEach((hoursBefore) => {
  const mintAt = START_7D - hoursBefore * HOUR_MS;
  check(Date.parse(horizonOf(scheduled(START_7D), mintAt)) === START_7D + GRACE,
    'the horizon is independent of mint time (' + hoursBefore + 'h before the session)');
});

// original_start_at can never influence it.
const movedLater = scheduled(START_7D, { original_start_at: new Date(START_7D - 30 * DAY_MS).toISOString() });
const movedEarlier = scheduled(START_7D, { original_start_at: new Date(START_7D + 30 * DAY_MS).toISOString() });
check(Date.parse(horizonOf(movedLater, START_7D - DAY_MS)) === START_7D + GRACE
  && Date.parse(horizonOf(movedEarlier, START_7D - DAY_MS)) === START_7D + GRACE,
  'CAPABILITY_CURRENT_START_AUTHORITY: original_start_at never moves the horizon');

// Fail closed, never a fallback.
['', 'not-a-time', undefined, null].forEach((value) => {
  check(horizonOf(scheduled(START_7D, { current_start_at: value }), START_7D - DAY_MS) === '',
    'FAIL_CLOSED: no horizon from an unusable current_start_at (' + String(value) + ')');
});
check(horizonOf(scheduled(START_7D), START_7D + GRACE) === ''
  && horizonOf(scheduled(START_7D), START_7D + GRACE + 1) === '',
  'FAIL_CLOSED: no horizon once the grace has elapsed');
check(horizonOf(scheduled(START_7D), START_7D + GRACE - 1) !== '',
  'the horizon is live right up to the end of the grace');

// Bounded: a corrupted far-future start cannot mint a capability that outlives
// the booking horizon such a reservation could have come from.
const CORRUPT_START = Date.parse('2031-01-01T00:00:00.000Z');
const mintNow = Date.parse('2026-09-01T13:00:00.000Z');
const ceiling = phase.capabilityHorizonCeilingMs_(mintNow);
check(Date.parse(horizonOf(scheduled(CORRUPT_START), mintNow)) === ceiling
  && ceiling < CORRUPT_START,
  'CAPABILITY_UNBOUNDED=NO: a corrupted far-future start clamps to the booking horizon');
check((ceiling - mintNow - GRACE) / DAY_MS === 90,
  'the ceiling is the canonical 90-day booking horizon, read from its owner');

// Both canonical constants are read from their owner at call time. If that
// owner is not loaded, the read fails closed with a diagnosable code rather
// than silently dropping a bound or throwing a bare ReferenceError.
// Rename the identifiers throughout their owning file (declaration and its own
// exports alike) so the cross-file reads in Lifecycle.js find nothing.
const unowned = buildHarness({
  'CalendarGateway.js': [
    ['AVAILABILITY_HORIZON_DAYS', 'AVAILABILITY_HORIZON_DAYS_UNOWNED'],
    ['BOOKING_LEAD_MINUTES', 'BOOKING_LEAD_MINUTES_UNOWNED'],
  ],
});
assert.throws(() => unowned.context.capabilityHorizonCeilingMs_(mintNow),
  /BOOKING_HORIZON_CONFIGURATION_MISSING/);
assertions += 1;
assert.throws(() => unowned.context.rescheduleTargetMinLeadMinutes_(),
  /BOOKING_LEAD_CONFIGURATION_MISSING/);
assertions += 1;
check(unowned.context.capabilityManagementHorizonIso_ !== undefined,
  'the horizon primitive still loads without the calendar constants; only the bounded read fails');

// ===========================================================================
// PART 2 — reachability of a real emailed link
// ===========================================================================
/** Is the bearer from a delivered email still cryptographically valid at `atMs`? */
const tokenValid = (record, type, token, atMs) => phase.verifyCapability_(
  token, type, phase.capabilityFromRecord_(record, type), { secret: CAPABILITY_SECRET, now: atMs });

/**
 * Book `daysAhead` out, confirm, deliver the confirmation, and report when its
 * emailed bearers stop working.
 */
function bookAndMeasure(harness, n, date, time, createLeadMs) {
  const booking = harness.paidBooking(n, date, time, createLeadMs);
  const row = harness.rowFor(n);
  return { booking, row: () => harness.rowFor(n), startMs: Date.parse(row.current_start_at) };
}

// --- booked 7 days ahead -----------------------------------------------------
const week = bookAndMeasure(clean, 1, '2026-09-10', '15:00', 7 * DAY_MS);
check(week.booking.reschedule && week.booking.cancel,
  'BOOKED_7D: the confirmation email carries both management bearers');
check(Date.parse(week.row().reschedule_capability_expires_at) === week.startMs + GRACE
  && Date.parse(week.row().cancel_capability_expires_at) === week.startMs + GRACE,
  'BOOKED_7D: both stored expiries are the schedule horizon');
// The old defect: dead at +24h. The contract: alive.
check(tokenValid(week.row(), 'RESCHEDULE', week.booking.reschedule, week.startMs - 7 * DAY_MS + DAY_MS + MINUTE_MS)
  && tokenValid(week.row(), 'CANCEL', week.booking.cancel, week.startMs - 7 * DAY_MS + DAY_MS + MINUTE_MS),
  'BOOKED_7D_LINK_REACHABILITY: both bearers are still valid 24h after issuance');
check(tokenValid(week.row(), 'RESCHEDULE', week.booking.reschedule, week.startMs - DAY_MS - MINUTE_MS),
  'BOOKED_7D: the reschedule bearer is valid while reschedule is still open');
check(tokenValid(week.row(), 'CANCEL', week.booking.cancel, week.startMs - MINUTE_MS),
  'BOOKED_7D: the cancel bearer is valid right up to the session start');
check(!tokenValid(week.row(), 'CANCEL', week.booking.cancel, week.startMs + GRACE + MINUTE_MS),
  'BOOKED_7D: the cancel bearer is dead once the grace has elapsed');

// --- booked 30 days ahead ----------------------------------------------------
const month = bookAndMeasure(clean, 2, '2026-10-06', '11:00', 30 * DAY_MS);
check(month.booking.reschedule && month.booking.cancel
  && Date.parse(month.row().cancel_capability_expires_at) === month.startMs + GRACE,
  'BOOKED_30D: the horizon spans the whole 30-day wait');
[DAY_MS + MINUTE_MS, 7 * DAY_MS, 20 * DAY_MS, 29 * DAY_MS].forEach((elapsed) => {
  const at = month.startMs - 30 * DAY_MS + elapsed;
  check(tokenValid(month.row(), 'RESCHEDULE', month.booking.reschedule, at)
    && tokenValid(month.row(), 'CANCEL', month.booking.cancel, at),
    'BOOKED_30D_LINK_REACHABILITY: bearers valid ' + Math.round(elapsed / DAY_MS) + ' days after issuance');
});

// --- the boundary: token validity vs business authorization -------------------
const GE24_AT = month.startMs - DAY_MS - MINUTE_MS;          // 24h01m
const EXACT_AT = month.startMs - DAY_MS;                     // exactly 24h
const LT24_AT = month.startMs - DAY_MS + MINUTE_MS;          // 23h59m

clean.setNow(GE24_AT);
const ge24Lookup = clean.context.manageLookup_({ postData: { contents: JSON.stringify({ token: month.booking.cancel }) } });
check(ge24Lookup.ok && ge24Lookup.managementWindow === 'open' && ge24Lookup.canReschedule === true
  && ge24Lookup.refundEligible === true,
  'GE24_LINK_VALID: at 24h01m the link resolves and the policy allows reschedule + refund');

clean.setNow(EXACT_AT);
const exactLookup = clean.context.manageLookup_({ postData: { contents: JSON.stringify({ token: month.booking.cancel }) } });
check(exactLookup.ok && exactLookup.canReschedule === true && exactLookup.refundEligible === true
  && exactLookup.refundPercent === 100,
  'GE24_LINK_VALID: at exactly 24h the link resolves and reschedule + 100% refund are allowed');

clean.setNow(LT24_AT);
check(tokenValid(month.row(), 'RESCHEDULE', month.booking.reschedule, LT24_AT)
  && tokenValid(month.row(), 'CANCEL', month.booking.cancel, LT24_AT),
  'LT24: the bearers remain cryptographically VALID at 23h59m');
const lt24Lookup = clean.context.manageLookup_({ postData: { contents: JSON.stringify({ token: month.booking.cancel }) } });
check(lt24Lookup.ok && lt24Lookup.managementWindow === 'cancel_only' && lt24Lookup.canReschedule === false
  && lt24Lookup.refundEligible === false && lt24Lookup.canCancel === true,
  'LT24_TOKEN_VS_POLICY_SEPARATION: a valid bearer yields cancel_only, no reschedule, no refund');
const lt24Reschedule = clean.context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: month.booking.reschedule, fecha: '2026-10-20', hora: '11:00' }) },
});
check(lt24Reschedule.ok === false && lt24Reschedule.code === 'RESCHEDULE_WINDOW_CLOSED',
  'LT24_TOKEN_VS_POLICY_SEPARATION: the valid bearer is refused by POLICY, not by token expiry');
check(lt24Reschedule.code !== 'CAPABILITY_INVALID',
  'the refusal is a policy decision and is reported as one');

// ===========================================================================
// PART 3 — a schedule change re-scopes the capability
// ===========================================================================

// --- patient reschedule to a LATER session ----------------------------------
const moved = bookAndMeasure(clean, 3, '2026-09-11', '12:00', 3 * DAY_MS);
const movedOldStart = moved.startMs;
const movedOldCancelExpiry = Date.parse(moved.row().cancel_capability_expires_at);
clean.setNow(movedOldStart - 3 * DAY_MS + HOUR_MS);
clean.state.mail.length = 0;
const movedResult = clean.context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: moved.booking.reschedule, fecha: '2026-10-08', hora: '12:00' }) },
});
check(movedResult.ok && movedResult.status === 'rescheduled', 'a legitimate reschedule to a later session succeeds');
const movedNewStart = Date.parse(moved.row().current_start_at);
check(movedNewStart > movedOldStart, 'the reschedule persisted a later current_start_at');
check(Date.parse(moved.row().cancel_capability_expires_at) === movedNewStart + GRACE
  && Date.parse(moved.row().cancel_capability_expires_at) > movedOldCancelExpiry,
  'PATIENT_RESCHEDULE: the surviving cancel capability is re-scoped onto the NEW start');
check(moved.row().reschedule_capability_revoked_at
  && !tokenValid(moved.row(), 'RESCHEDULE', moved.booking.reschedule, movedNewStart - DAY_MS),
  'PATIENT_RESCHEDULE: the one-move cap still revokes the reschedule capability');
clean.drain();
const movedMail = clean.tokensFromMail('Tu sesión fue reagendada');
check(movedMail.cancel && !movedMail.reschedule,
  'PATIENT_RESCHEDULE_NEW_CAPABILITY: the new email offers cancel only, per the one-move cap');
check(Date.parse(moved.row().cancel_capability_expires_at) === movedNewStart + GRACE,
  'PATIENT_RESCHEDULE_NEW_CAPABILITY: the freshly minted bearer is scoped to the new start');
check(tokenValid(moved.row(), 'CANCEL', movedMail.cancel, movedNewStart - MINUTE_MS),
  'PATIENT_RESCHEDULE_NEW_CAPABILITY: valid right up to the new session start');
check(!tokenValid(moved.row(), 'CANCEL', moved.booking.cancel, movedNewStart - MINUTE_MS),
  'OLD_TOKEN_POLICY_BYPASS=NONE: the superseded bearer is rotated out and no longer authenticates');

// --- clinician reschedule ----------------------------------------------------
const clin = bookAndMeasure(clean, 4, '2026-09-14', '16:00', 5 * DAY_MS);
const clinOldStart = clin.startMs;
clean.setNow(clinOldStart - 5 * DAY_MS + HOUR_MS);
const clinNewStartIso = '2026-10-13T19:00:00.000Z';
const clinEvent = {
  id: clin.row().calendar_event_id, etag: 'etag-clinician-move', updated: new Date(clean.state.nowMs).toISOString(),
  status: 'confirmed',
  start: { dateTime: clinNewStartIso }, end: { dateTime: '2026-10-13T20:00:00.000Z' },
  extendedProperties: { private: { source: 'fran_booking', link_key: clin.row().calendar_link_key, schema: 'fran_booking:v1' } },
};
const clinStore = {
  records: () => clean.currentRows(),
  loadByReservationId: (id) => clean.currentRows().find((row) => row.reservation_id === String(id)) || null,
  loadByCalendarEventId: (id) => clean.currentRows().find((row) => row.calendar_event_id === String(id)) || null,
  loadByCalendarLinkKey: (key) => clean.currentRows().find((row) => row.calendar_link_key === String(key)) || null,
  update: (current, fields) => {
    clean.context.updateRecord_(clean.sheet, clean.schema(), current.rowNumber, fields);
    return clean.rowFor(4);
  },
};
clean.state.mail.length = 0;
const clinOutcome = clean.context.__RECONCILIATION_TEST_EXPORTS__.reconcileCalendarChange_({
  store: clinStore, event: clinEvent,
  enqueueNotification: (updated) => {
    clean.context.enqueueLifecycleNotification_(clean.sheet, clean.schema(), updated, 'CLINICIAN_RESCHEDULED');
  },
});
check(clinOutcome.changed && clinOutcome.source === 'clinician', 'the clinician move reconciled');
const clinNewStart = Date.parse(clin.row().current_start_at);
check(clinNewStart === Date.parse(clinNewStartIso), 'the clinician move persisted the new current_start_at');
check(Date.parse(clin.row().cancel_capability_expires_at) === clinNewStart + GRACE,
  'CLINICIAN_RESCHEDULE: the live capability is re-scoped onto the clinician-set start');
clean.drain();
const clinMail = clean.tokensFromMail('Hubo un cambio en tu próxima sesión');
check(clinMail.cancel && tokenValid(clin.row(), 'CANCEL', clinMail.cancel, clinNewStart - MINUTE_MS),
  'CLINICIAN_RESCHEDULE_NEW_CAPABILITY: the new email bearer is valid against the new start');
check(!tokenValid(clin.row(), 'CANCEL', clin.booking.cancel, clinNewStart - MINUTE_MS),
  'OLD_TOKEN_POLICY_BYPASS=NONE: the pre-move bearer is rotated out');

// --- a schedule change never resurrects a dead capability --------------------
const deadRecord = scheduled(Date.parse('2026-09-20T13:00:00.000Z'), {
  reschedule_capability_hash: 'a'.repeat(64), reschedule_capability_version: '1',
  reschedule_capability_expires_at: '2026-09-01T00:00:00.000Z', reschedule_capability_revoked_at: '',
  cancel_capability_hash: 'b'.repeat(64), cancel_capability_version: '1',
  cancel_capability_expires_at: '2026-09-20T14:00:00.000Z', cancel_capability_revoked_at: '2026-09-02T00:00:00.000Z',
});
const alignedDead = phase.alignedCapabilityExpiryFields_(deadRecord, Date.parse('2026-09-05T00:00:00.000Z'));
check(alignedDead.reschedule_capability_expires_at === undefined,
  'an already-expired capability is not resurrected by a schedule change');
check(alignedDead.cancel_capability_expires_at === undefined,
  'a revoked capability is not resurrected by a schedule change');
const liveRecord = scheduled(Date.parse('2026-09-20T13:00:00.000Z'), {
  cancel_capability_hash: 'b'.repeat(64), cancel_capability_version: '1',
  cancel_capability_expires_at: '2026-09-25T00:00:00.000Z', cancel_capability_revoked_at: '',
});
const alignedLive = phase.alignedCapabilityExpiryFields_(liveRecord, Date.parse('2026-09-05T00:00:00.000Z'));
check(Date.parse(alignedLive.cancel_capability_expires_at) === Date.parse('2026-09-20T13:00:00.000Z') + GRACE,
  'a live capability is contracted when the session moves earlier than its old expiry');
check(Object.keys(phase.alignedCapabilityExpiryFields_(scheduled(START_7D), START_7D - DAY_MS)).length === 0,
  'a record with no minted capability gets no expiry writes');

// ===========================================================================
// PART 4 — reschedule target minimum lead time
// ===========================================================================
check(phase.rescheduleTargetMinLeadMinutes_() === 120,
  'TARGET_MIN_LEAD_MINUTES=120, read from the canonical BOOKING_LEAD_MINUTES');
check(clean.context.BOOKING_LEAD_MINUTES === phase.rescheduleTargetMinLeadMinutes_(),
  'the reschedule floor is the same canonical constant assertBookableSlot_ uses, not a duplicate');

const target = bookAndMeasure(clean, 5, '2026-09-15', '17:00', 6 * DAY_MS);
const targetStore = {
  loadByReservationId: (id) => clean.currentRows().find((row) => row.reservation_id === String(id)) || null,
  records: () => clean.currentRows(),
  update: (current, fields) => {
    clean.context.updateRecord_(clean.sheet, clean.schema(), current.rowNumber, fields);
    return clean.rowFor(5);
  },
};
/** Drive the transaction directly so the target instant can be set to the millisecond. */
const attempt = (targetStartMs, nowMs) => phase.patientRescheduleTransaction_({
  reservationId: target.row().reservation_id,
  token: target.booking.reschedule,
  targetStartAt: new Date(targetStartMs).toISOString(),
  now: nowMs,
  deps: {
    store: targetStore,
    calendar: {
      isSlotAvailable: () => true,
      updateSameEvent: () => ({ id: target.row().calendar_event_id, etag: 'etag-t', updated: new Date(nowMs).toISOString(),
        syncHash: 'hash-t', meetUrl: 'https://meet.google.com/opaque-t', meetConferenceId: 'meet-t', meetStatus: 'available' }),
    },
    requireCapabilitySecret_: () => CAPABILITY_SECRET,
    enqueueNotification: () => {},
  },
});

const AT = target.startMs - 6 * DAY_MS + HOUR_MS; // comfortably inside the >=24h window
const LEAD_MS = 120 * MINUTE_MS;
const tooSoon = attempt(AT + LEAD_MS - 1000, AT);
check(tooSoon.ok === false && tooSoon.code === 'TARGET_LEAD_TIME_TOO_SHORT' && tooSoon.minLeadMinutes === 120,
  'TARGET_119M59S: a target 119m59s out is rejected');
check(Date.parse(target.row().current_start_at) === target.startMs
  && target.row().patient_reschedule_count === '0',
  'a rejected target mutates nothing');
check(attempt(AT + LEAD_MS - 1, AT).code === 'TARGET_LEAD_TIME_TOO_SHORT',
  'the floor is enforced to the millisecond');
check(attempt(AT - HOUR_MS, AT).code === 'TARGET_LEAD_TIME_TOO_SHORT',
  'TARGET_IN_PAST: a target in the past is rejected');
check(attempt(AT, AT).code === 'TARGET_LEAD_TIME_TOO_SHORT',
  'a target at exactly "now" is rejected');
['', 'not-a-time', 'tomorrow'].forEach((value) => {
  const bad = phase.patientRescheduleTransaction_({
    reservationId: target.row().reservation_id, token: target.booking.reschedule,
    targetStartAt: value || '0', now: AT,
    deps: { store: targetStore, calendar: { isSlotAvailable: () => true, updateSameEvent: () => { throw new Error('must not reach calendar'); } },
      requireCapabilitySecret_: () => CAPABILITY_SECRET, enqueueNotification: () => {} },
  });
  check(bad.ok === false, 'FAIL_CLOSED: an unparseable target is rejected (' + (value || 'empty') + ')');
});
// Exactly +120m is allowed, and it is the same reservation that just refused 119m59s.
const exactLead = attempt(AT + LEAD_MS, AT);
check(exactLead.ok === true && exactLead.status === 'rescheduled',
  'TARGET_120M_EXACT: a target exactly 120 minutes out is allowed when otherwise valid');
check(Date.parse(target.row().current_start_at) === AT + LEAD_MS,
  'the accepted target is what got persisted');

// The endpoint, not just the transaction. The session sits 10 days out, so the
// 24-hour policy is wide OPEN here and the ONLY thing that can refuse a target
// 30 minutes away is the lead-time floor. That isolation is what makes these
// assertions about the floor rather than about the cutoff.
const direct = bookAndMeasure(clean, 6, '2026-09-25', '15:00', 10 * DAY_MS + 5 * HOUR_MS);
const SOON_NOW = Date.parse('2026-09-15T13:30:00.000Z');
const soonDate = '2026-09-15';
const soonHour = '11:00'; // 14:00Z — thirty minutes after SOON_NOW
clean.setNow(SOON_NOW);
check(clean.context.getBookingManagementPolicy_(direct.row(), SOON_NOW).can_reschedule === true,
  'the isolation holds: at this clock the 24-hour policy still allows a reschedule');
const directResult = clean.context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: direct.booking.reschedule, fecha: soonDate, hora: soonHour }) },
});
check(directResult.ok === false && directResult.code === 'TARGET_LEAD_TIME_TOO_SHORT',
  'TARGET_DIRECT_ENDPOINT_GUARD: a direct endpoint call cannot place a too-soon target');

// A payload that asserts its own verdict changes nothing.
const spoofFields = ['now', 'nowMs', 'serverNow', 'clock', 'minLeadMinutes', 'leadOk', 'targetValidated', 'canReschedule'];
spoofFields.forEach((field) => {
  const payload = { token: direct.booking.reschedule, fecha: soonDate, hora: soonHour };
  payload[field] = field === 'minLeadMinutes' ? 0 : true;
  const spoofed = clean.context.patientReschedule_({ postData: { contents: JSON.stringify(payload) } });
  check(spoofed.ok === false && spoofed.code === 'TARGET_LEAD_TIME_TOO_SHORT',
    'TARGET_BROWSER_BYPASS=NONE: payload field "' + field + '" cannot lower the floor');
});
check(Date.parse(direct.row().current_start_at) === direct.startMs
  && direct.row().patient_reschedule_count === '0',
  'TARGET_BROWSER_BYPASS=NONE: nothing was persisted by any bypass attempt');

// Normal slot-collision behaviour is untouched by the new floor.
const collide = bookAndMeasure(clean, 7, '2026-09-17', '11:00', 5 * DAY_MS);
clean.setNow(collide.startMs - 5 * DAY_MS + HOUR_MS);
const collideResult = phase.patientRescheduleTransaction_({
  reservationId: collide.row().reservation_id, token: collide.booking.reschedule,
  targetStartAt: new Date(collide.startMs).toISOString(), now: clean.state.nowMs,
  deps: {
    store: { loadByReservationId: () => collide.row(), records: () => clean.currentRows(), update: () => { throw new Error('must not write'); } },
    calendar: { isSlotAvailable: () => false, updateSameEvent: () => { throw new Error('must not reach calendar'); } },
    requireCapabilitySecret_: () => CAPABILITY_SECRET, enqueueNotification: () => {},
  },
});
check(collideResult.ok === false && collideResult.code === 'SLOT_TAKEN',
  'a taken slot still reports SLOT_TAKEN, unchanged by the lead-time floor');

// ===========================================================================
// PART 5 — Policy V2 is not regressed
// ===========================================================================
const policyProbe = (startMs, nowMs) => clean.context.getBookingManagementPolicy_(scheduled(startMs), nowMs);
const PV2 = Date.parse('2026-09-25T18:00:00.000Z');
check(policyProbe(PV2, PV2 - DAY_MS).can_reschedule === true
  && policyProbe(PV2, PV2 - DAY_MS).can_cancel === true
  && policyProbe(PV2, PV2 - DAY_MS).refund_percent === 100,
  'POLICY_V2 preserved: exactly 24h still allows reschedule, cancel and a 100% refund');
check(policyProbe(PV2, PV2 - DAY_MS + 1).can_reschedule === false
  && policyProbe(PV2, PV2 - DAY_MS + 1).can_cancel === true
  && policyProbe(PV2, PV2 - DAY_MS + 1).refund_percent === 0,
  'POLICY_V2 preserved: inside the cutoff, cancel only and no refund');
check(policyProbe(PV2, PV2).can_cancel === false && policyProbe(PV2, PV2).can_reschedule === false,
  'POLICY_V2 preserved: a started session closes normal self-management');
check(phase.PATIENT_MANAGEMENT_CUTOFF_HOURS === 24, 'POLICY_V2 preserved: the cutoff is still 24 hours');

// ===========================================================================
// PART 6 — mutation / adversarial testing
// ===========================================================================
function probes(h) {
  const results = [];
  const probe = (name, fn) => {
    try { results.push({ name, ok: fn() === true }); }
    catch (error) { results.push({ name, ok: false, error: String(error && error.message || error) }); }
  };
  const valid = (record, type, token, atMs) => h.phase.verifyCapability_(
    token, type, h.phase.capabilityFromRecord_(record, type), { secret: CAPABILITY_SECRET, now: atMs });

  probe('horizon_from_current_start', () => {
    const start = Date.parse('2026-09-08T13:00:00.000Z');
    const record = scheduled(start, { original_start_at: new Date(start + 30 * DAY_MS).toISOString() });
    return Date.parse(h.context.capabilityManagementHorizonIso_(record, start - 7 * DAY_MS)) === start + GRACE;
  });

  probe('link_alive_after_24h_when_booked_7d', () => {
    const b = h.paidBooking(61, '2026-09-10', '15:00', 7 * DAY_MS);
    const row = h.rowFor(61);
    const startMs = Date.parse(row.current_start_at);
    const at = startMs - 7 * DAY_MS + DAY_MS + MINUTE_MS;
    return Boolean(b.reschedule) && Boolean(b.cancel)
      && valid(row, 'RESCHEDULE', b.reschedule, at) && valid(row, 'CANCEL', b.cancel, at);
  });

  probe('link_alive_at_policy_boundary_when_booked_30d', () => {
    const b = h.paidBooking(62, '2026-10-06', '11:00', 30 * DAY_MS);
    const row = h.rowFor(62);
    const startMs = Date.parse(row.current_start_at);
    return valid(row, 'RESCHEDULE', b.reschedule, startMs - DAY_MS)
      && valid(row, 'CANCEL', b.cancel, startMs - DAY_MS);
  });

  probe('reschedule_rescopes_capability', () => {
    const b = h.paidBooking(63, '2026-09-11', '12:00', 3 * DAY_MS);
    const oldStart = Date.parse(h.rowFor(63).current_start_at);
    h.setNow(oldStart - 3 * DAY_MS + HOUR_MS);
    h.state.mail.length = 0;
    const moveResult = h.context.patientReschedule_({
      postData: { contents: JSON.stringify({ token: b.reschedule, fecha: '2026-10-08', hora: '12:00' }) },
    });
    if (!moveResult.ok) return false;
    const newStart = Date.parse(h.rowFor(63).current_start_at);
    if (newStart <= oldStart) return false;
    h.drain();
    const mail = h.tokensFromMail('Tu sesión fue reagendada');
    // The new bearer must reach the new session start; the old one must not survive.
    return Boolean(mail.cancel)
      && valid(h.rowFor(63), 'CANCEL', mail.cancel, newStart - MINUTE_MS)
      && !valid(h.rowFor(63), 'CANCEL', b.cancel, newStart - MINUTE_MS);
  });

  probe('token_validity_never_authorizes', () => {
    const b = h.paidBooking(64, '2026-10-06', '13:00', 30 * DAY_MS);
    const row = h.rowFor(64);
    const startMs = Date.parse(row.current_start_at);
    const at = startMs - DAY_MS + MINUTE_MS; // 23h59m
    if (!valid(row, 'RESCHEDULE', b.reschedule, at)) return false; // token must still be valid
    h.setNow(at);
    const refused = h.context.patientReschedule_({
      postData: { contents: JSON.stringify({ token: b.reschedule, fecha: '2026-10-20', hora: '13:00' }) },
    });
    const lookup = h.context.manageLookup_({ postData: { contents: JSON.stringify({ token: b.cancel }) } });
    return refused.ok === false && refused.code === 'RESCHEDULE_WINDOW_CLOSED'
      && lookup.canReschedule === false && lookup.refundEligible === false;
  });

  probe('target_lead_floor_server_side', () => {
    const b = h.paidBooking(65, '2026-09-15', '17:00', 6 * DAY_MS);
    const row = h.rowFor(65);
    const startMs = Date.parse(row.current_start_at);
    const at = startMs - 6 * DAY_MS + HOUR_MS;
    const store = {
      loadByReservationId: () => h.rowFor(65), records: () => h.currentRows(),
      update: (current, fields) => { h.context.updateRecord_(h.sheet, h.schema(), current.rowNumber, fields); return h.rowFor(65); },
    };
    const run = (targetMs) => h.phase.patientRescheduleTransaction_({
      reservationId: row.reservation_id, token: b.reschedule,
      targetStartAt: new Date(targetMs).toISOString(), now: at,
      deps: { store: store,
        calendar: { isSlotAvailable: () => true,
          updateSameEvent: () => ({ id: row.calendar_event_id, etag: 'e', updated: new Date(at).toISOString(), syncHash: 'h' }) },
        requireCapabilitySecret_: () => CAPABILITY_SECRET, enqueueNotification: () => {} },
    });
    const short = run(at + 120 * MINUTE_MS - 1000);
    return short.ok === false && short.code === 'TARGET_LEAD_TIME_TOO_SHORT'
      && h.rowFor(65).patient_reschedule_count === '0';
  });

  // The session is 10 days out, so the 24-hour policy is OPEN and only the
  // lead-time floor can refuse this target. Without that isolation the probe
  // would be satisfied by the cutoff guard and could not see the floor at all.
  probe('target_endpoint_ignores_client_claims', () => {
    const b = h.paidBooking(66, '2026-09-25', '15:00', 10 * DAY_MS + 5 * HOUR_MS);
    const at = Date.parse('2026-09-15T13:30:00.000Z');
    h.setNow(at);
    if (h.context.getBookingManagementPolicy_(h.rowFor(66), at).can_reschedule !== true) return false;
    const before = h.rowFor(66).current_start_at;
    const spoofed = h.context.patientReschedule_({
      postData: { contents: JSON.stringify({
        token: b.reschedule, fecha: '2026-09-15', hora: '11:00',
        minLeadMinutes: 0, leadOk: true, targetValidated: true,
      }) },
    });
    return spoofed.ok === false && spoofed.code === 'TARGET_LEAD_TIME_TOO_SHORT'
      && h.rowFor(66).current_start_at === before;
  });

  return results;
}

const baseline = probes(buildHarness(null));
baseline.forEach((result) => {
  check(result.ok === true, 'MUTATION BASELINE probe passes on clean source: ' + result.name
    + (result.error ? ' — ' + result.error : ''));
});

const MUTATIONS = [
  {
    key: 'MUTATION_FIXED_24H_TTL',
    label: 'A. restore a fixed 24-hour capability lifetime at the mint site',
    patches: {
      'Lifecycle.js': [[
        'const fresh = createCapability_(type, { secret: secret, now: now, expiresAt: horizon });',
        'const fresh = createCapability_(type, { secret: secret, now: now });',
      ]],
    },
    mustFail: ['link_alive_after_24h_when_booked_7d', 'link_alive_at_policy_boundary_when_booked_30d'],
  },
  {
    key: 'MUTATION_ORIGINAL_START_CAPABILITY',
    label: 'B. derive the capability horizon from original_start_at',
    patches: {
      'Lifecycle.js': [[
        "  const startMs = Date.parse(String(record && record.current_start_at || ''));\n  if (!Number.isFinite(startMs)) return '';",
        "  const startMs = Date.parse(String((record && (record.original_start_at || record.current_start_at)) || ''));\n  if (!Number.isFinite(startMs)) return '';",
      ]],
    },
    mustFail: ['horizon_from_current_start'],
  },
  {
    key: 'MUTATION_RESCHEDULE_CAPABILITY_REFRESH',
    label: 'C. stop re-scoping / re-minting the capability after a reschedule',
    patches: {
      'Lifecycle.js': [
        ['Object.assign(updates, alignedCapabilityExpiryFields_(Object.assign({}, record, updates), now));', ''],
        [
          'const horizon = capabilityManagementHorizonIso_(record, now);',
          'const horizon = capabilityManagementHorizonIso_({ current_start_at: record.original_start_at }, now);',
        ],
      ],
    },
    mustFail: ['reschedule_rescopes_capability'],
  },
  {
    key: 'MUTATION_TOKEN_POLICY_BYPASS',
    label: 'D. let a cryptographically valid capability bypass the 24-hour policy',
    patches: {
      'Lifecycle.js': [['if (!policy.can_reschedule) {', 'if (false) {']],
    },
    mustFail: ['token_validity_never_authorizes'],
  },
  {
    key: 'MUTATION_TARGET_LEAD_SERVER_GUARD',
    label: 'E. remove the server-side 120-minute target floor',
    patches: {
      'Lifecycle.js': [['if (targetStartMs < now + rescheduleTargetMinLeadMs_()) {', 'if (false) {']],
    },
    mustFail: ['target_lead_floor_server_side', 'target_endpoint_ignores_client_claims'],
  },
  {
    key: 'MUTATION_TARGET_CLIENT_AUTHORITY',
    label: 'F. trust a client-supplied target validation flag instead of the server floor',
    patches: {
      'Lifecycle.js': [[
        'if (targetStartMs < now + rescheduleTargetMinLeadMs_()) {',
        'if (!input.targetValidated && targetStartMs < now + rescheduleTargetMinLeadMs_()) {',
      ]],
      'Code.js': [[
        "return patientRescheduleTransaction_({ reservationId: record.reservation_id, token: token, targetStartAt: startAt_(payload.fecha, payload.hora),",
        "return patientRescheduleTransaction_({ targetValidated: payload.targetValidated, reservationId: record.reservation_id, token: token, targetStartAt: startAt_(payload.fecha, payload.hora),",
      ]],
    },
    mustFail: ['target_endpoint_ignores_client_claims'],
  },
];

const mutationReport = [];
MUTATIONS.forEach((mutation) => {
  let results;
  try { results = probes(buildHarness(mutation.patches)); }
  catch (error) {
    results = [{ name: 'build', ok: false, error: String(error && error.message || error) }];
  }
  const failed = results.filter((item) => item.ok !== true).map((item) => item.name);
  check(failed.length > 0, mutation.label + ' — MUST be detected, but every probe passed');
  mutation.mustFail.forEach((name) => {
    check(failed.indexOf(name) !== -1 || failed.indexOf('build') !== -1,
      mutation.label + ' — probe "' + name + '" must fail under this mutation');
  });
  mutationReport.push(mutation.key + '=DETECTED_BY[' + failed.join(',') + ']');
});

// ===========================================================================
console.log('CAPABILITY_REACHABILITY_TESTS=PASS assertions=' + assertions);
console.log('CAPABILITY_LIFETIME_POLICY=CURRENT_SESSION_START_PLUS_ONE_SLOT_INTERVAL');
console.log('CAPABILITY_EXPIRY_AUTHORITY=SERVER_ABSOLUTE_TIMESTAMP');
console.log('CAPABILITY_CURRENT_START_AUTHORITY=current_start_at');
console.log('CAPABILITY_UNBOUNDED=NO (clamped to the 90-day booking horizon)');
console.log('BOOKED_7D_LINK_REACHABILITY=PASS');
console.log('BOOKED_30D_LINK_REACHABILITY=PASS');
console.log('LT24_TOKEN_VS_POLICY_SEPARATION=PASS');
console.log('TARGET_MIN_LEAD_MINUTES=' + phase.rescheduleTargetMinLeadMinutes_());
mutationReport.forEach((line) => console.log(line));
console.log('PRODUCTION_EMAILS_SENT=0');
console.log('REAL_FLOW_CALLS=0');
console.log('REAL_NETWORK_SIDE_EFFECTS=0');
void PATIENT_EMAIL;

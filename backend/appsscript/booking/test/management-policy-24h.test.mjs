/**
 * CANCELLATION & RESCHEDULE POLICY V2 — the 24-hour patient management contract.
 *
 * Deterministic, no-network, no-mail, no-Flow. Every assertion is driven from a
 * controllable server clock inside the VM; nothing here reads the host clock and
 * nothing here can reach a real service.
 *
 * Two halves:
 *   1. the contract  — the regression matrix the policy must satisfy
 *   2. the mutations — the same contract re-run against deliberately broken
 *                      source, proving each guard is actually load-bearing
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  buildHarness, findTransition, santiagoHour, santiagoOffsetMinutes,
  DAY_MS, HOUR_MS, OPS_EMAIL, T0,
} from './helpers/policy-harness.mjs';

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

// ===========================================================================
// PART 1 — the canonical policy in isolation
// ===========================================================================
const clean = buildHarness(null);
const policy = clean.context.getBookingManagementPolicy_;
const WINDOW = clean.phase.MANAGEMENT_WINDOW;
const REASON = clean.phase.BOOKING_MANAGEMENT_REASON;

check(clean.phase.PATIENT_MANAGEMENT_CUTOFF_HOURS === 24, 'PATIENT_MANAGEMENT_CUTOFF_HOURS=24');
check(clean.phase.PATIENT_MANAGEMENT_CUTOFF_MS === DAY_MS, 'the cutoff is 24 chronological hours in milliseconds');
check(clean.phase.PATIENT_MANAGEMENT_REFUND_PERCENT_FULL === 100
  && clean.phase.PATIENT_MANAGEMENT_REFUND_PERCENT_NONE === 0, 'refund percentages are 100 / 0 only');
check(typeof policy === 'function', 'getBookingManagementPolicy_ is the canonical entry point');
// The published refund constants and the policy constants are two names for the
// same number; the load order of Apps Script files rules out deriving one from
// the other at evaluation time, so the equality is asserted instead.
check(clean.context.PATIENT_CANCEL_REFUND_PERCENT === clean.phase.PATIENT_MANAGEMENT_REFUND_PERCENT_FULL,
  'PATIENT_CANCEL_REFUND_PERCENT cannot drift from the policy refund percentage');
check(clean.context.CANONICAL_REFUND_POLICY === 'PATIENT_CANCEL_FULL_AUTOMATIC_REFUND',
  'CANONICAL_REFUND_POLICY is unchanged');

// The mission's exact boundary contract. Session start Friday 15:00 (Chile).
const FRIDAY_15 = Date.parse('2026-09-04T19:00:00.000Z');
const confirmedPaid = (startMs) => ({
  booking_status: 'confirmed', payment_status: 'paid', schedule_status: 'scheduled',
  patient_reschedule_count: '0', current_start_at: new Date(startMs).toISOString(),
  current_end_at: new Date(startMs + 50 * 60000).toISOString(),
  original_start_at: new Date(startMs - 7 * DAY_MS).toISOString(),
});
const at = (startMs, nowMs) => policy(confirmedPaid(startMs), nowMs);

// 1 · Thursday 14:59 — 24h01m remaining
const t1 = at(FRIDAY_15, FRIDAY_15 - DAY_MS - 60000);
check(t1.can_reschedule === true && t1.can_cancel === true && t1.refund_eligible === true
  && t1.refund_percent === 100 && t1.window === WINDOW.OPEN && t1.remaining_ms === DAY_MS + 60000,
  'BOUNDARY 24h01m: reschedule YES, cancel YES, refund YES 100%');

// 2 · Thursday 15:00 — exactly 24h
const t24 = at(FRIDAY_15, FRIDAY_15 - DAY_MS);
check(t24.can_reschedule === true, 'BOUNDARY exactly 24h: reschedule ALLOWED');
check(t24.can_cancel === true, 'BOUNDARY exactly 24h: cancel ALLOWED');
check(t24.refund_eligible === true && t24.refund_percent === 100, 'BOUNDARY exactly 24h: refund ELIGIBLE at 100%');
check(t24.remaining_ms === DAY_MS && t24.reason === REASON.OPEN_FULL, 'BOUNDARY exactly 24h is inclusive');
check(Date.parse(t24.cutoff_at) === FRIDAY_15 - DAY_MS, 'cutoff_at is exactly session start minus 24h');

// 3 · Thursday 15:00:01 — one second inside the cutoff
const t23h59m59s = at(FRIDAY_15, FRIDAY_15 - DAY_MS + 1000);
check(t23h59m59s.can_reschedule === false, 'BOUNDARY 23h59m59s: reschedule BLOCKED');
check(t23h59m59s.refund_eligible === false && t23h59m59s.refund_percent === 0,
  'BOUNDARY 23h59m59s: refund BLOCKED at 0%');
check(t23h59m59s.can_cancel === true && t23h59m59s.window === WINDOW.CANCEL_ONLY,
  'BOUNDARY 23h59m59s: cancel STILL ALLOWED');

// Sub-second precision: the boundary is the millisecond, not the second.
check(at(FRIDAY_15, FRIDAY_15 - DAY_MS - 1).can_reschedule === true
  && at(FRIDAY_15, FRIDAY_15 - DAY_MS + 1).can_reschedule === false,
  'BOUNDARY is asserted to millisecond precision');

// 4 · Friday 14:30 — 30 minutes remaining
const t30m = at(FRIDAY_15, FRIDAY_15 - 30 * 60000);
check(t30m.can_cancel === true && t30m.can_reschedule === false && t30m.refund_eligible === false
  && t30m.refund_percent === 0 && t30m.window === WINDOW.CANCEL_ONLY,
  'BOUNDARY 30m: cancel allowed, reschedule blocked, refund blocked');

// 5 · Friday 15:00 and later — normal self-management closed
const tStart = at(FRIDAY_15, FRIDAY_15);
const tPast = at(FRIDAY_15, FRIDAY_15 + HOUR_MS);
check(tStart.can_cancel === false && tStart.can_reschedule === false && tStart.refund_eligible === false
  && tStart.window === WINDOW.CLOSED && tStart.reason === REASON.SESSION_STARTED,
  'PAST_SESSION_POLICY: at the session start normal management is closed');
check(tPast.can_cancel === false && tPast.can_reschedule === false && tPast.refund_eligible === false,
  'PAST_SESSION_POLICY: after the session start normal management stays closed');

// 7 + 8 · Current persisted start drives the cutoff; original_start_at never does.
const moved = confirmedPaid(FRIDAY_15 + 7 * DAY_MS);
moved.original_start_at = new Date(FRIDAY_15).toISOString();
const movedPolicy = policy(moved, FRIDAY_15 - HOUR_MS);
check(Date.parse(movedPolicy.cutoff_at) === FRIDAY_15 + 7 * DAY_MS - DAY_MS,
  'CURRENT_START_AUTHORITY: cutoff derives from current_start_at');
check(movedPolicy.can_reschedule === true && movedPolicy.window === WINDOW.OPEN,
  'a pre-reschedule original_start_at inside the cutoff does not close the window');
const stillOriginal = confirmedPaid(FRIDAY_15);
stillOriginal.original_start_at = new Date(FRIDAY_15 + 30 * DAY_MS).toISOString();
check(policy(stillOriginal, FRIDAY_15 - HOUR_MS).can_reschedule === false,
  'a far-future original_start_at cannot reopen a window the current start has closed');

// 13 · Fail closed on anything undeterminable.
[
  [undefined, REASON.RESERVATION_UNKNOWN, 'missing reservation'],
  [null, REASON.RESERVATION_UNKNOWN, 'null reservation'],
  ['not-a-record', REASON.RESERVATION_UNKNOWN, 'non-object reservation'],
].forEach(([value, reason, label]) => {
  const decision = policy(value, T0);
  check(decision.can_reschedule === false && decision.can_cancel === false && decision.refund_eligible === false
    && decision.refund_percent === 0 && decision.reason === reason, 'FAIL_CLOSED: ' + label);
});
['', 'not-a-time', undefined, null, '2026-13-45T99:99:99Z'].forEach((value) => {
  const record = confirmedPaid(FRIDAY_15);
  record.current_start_at = value;
  const decision = policy(record, T0);
  check(decision.can_reschedule === false && decision.can_cancel === false && decision.refund_eligible === false
    && decision.reason === REASON.SCHEDULE_UNKNOWN && decision.cutoff_at === '',
    'FAIL_CLOSED: unusable current_start_at (' + String(value) + ')');
});
['not-a-clock', NaN, Infinity, -Infinity, {}, [], true, false, String(FRIDAY_15)].forEach((value) => {
  const decision = policy(confirmedPaid(FRIDAY_15), value);
  check(decision.can_reschedule === false && decision.can_cancel === false && decision.refund_eligible === false
    && decision.reason === REASON.CLOCK_UNKNOWN, 'FAIL_CLOSED: unusable policy timestamp (' + String(value) + ')');
});
check(policy(confirmedPaid(FRIDAY_15), new Date(FRIDAY_15 - DAY_MS)).can_reschedule === true,
  'a Date instance is an acceptable server instant');
check(policy(confirmedPaid(FRIDAY_15), 0).reason === REASON.SESSION_STARTED
  || policy(confirmedPaid(FRIDAY_15), 0).window === WINDOW.OPEN,
  'epoch 0 is treated as a real instant, not as a missing clock');

// Non-self-manageable bookings expose no actions.
['cancelled', 'cancellation_requested', 'expired', 'manual_review', 'reconciliation_required', ''].forEach((status) => {
  const record = Object.assign(confirmedPaid(FRIDAY_15), { booking_status: status });
  const decision = policy(record, FRIDAY_15 - 2 * DAY_MS);
  check(decision.can_reschedule === false && decision.can_cancel === false && decision.reason === REASON.NOT_ACTIVE,
    'no self-management actions for booking_status=' + (status || '(empty)'));
});
clean.phase.PATIENT_MANAGEABLE_BOOKING_STATUSES.forEach((status) => {
  const record = Object.assign(confirmedPaid(FRIDAY_15), { booking_status: status });
  check(policy(record, FRIDAY_15 - 2 * DAY_MS).can_cancel === true,
    'self-manageable booking_status=' + status + ' can cancel');
});

// Refund eligibility needs a confirmed payment as well as the window.
['not_started', 'pending', 'rejected', 'failed', 'unknown', 'expired', 'annulled', ''].forEach((paymentStatus) => {
  const record = Object.assign(confirmedPaid(FRIDAY_15), { payment_status: paymentStatus });
  const decision = policy(record, FRIDAY_15 - 2 * DAY_MS);
  check(decision.refund_eligible === false && decision.refund_percent === 0,
    'no refund without a confirmed payment (payment_status=' + (paymentStatus || '(empty)') + ')');
});

// 25 · Chile DST does not alter the chronological 24-hour rule.
const dstSpring = findTransition(Date.parse('2026-08-15T00:00:00Z'), Date.parse('2026-10-15T00:00:00Z'));
const dstAutumn = findTransition(Date.parse('2027-03-01T00:00:00Z'), Date.parse('2027-05-01T00:00:00Z'));
check(dstSpring !== null && dstAutumn !== null, 'both America/Santiago DST transitions were located');
[dstSpring, dstAutumn].forEach((transition, index) => {
  const label = index === 0 ? 'spring-forward' : 'fall-back';
  // A session whose 24-hour window straddles the transition instant.
  const startMs = transition + 6 * HOUR_MS;
  const decision = policy(confirmedPaid(startMs), startMs - DAY_MS);
  check(Date.parse(decision.cutoff_at) === startMs - DAY_MS,
    'DST_CONTRACT ' + label + ': cutoff stays exactly 24 chronological hours before the start');
  check(decision.can_reschedule === true && decision.refund_eligible === true,
    'DST_CONTRACT ' + label + ': exactly 24h remains inclusive across the transition');
  check(policy(confirmedPaid(startMs), startMs - DAY_MS + 1000).can_reschedule === false,
    'DST_CONTRACT ' + label + ': one second inside the cutoff still blocks');
  // The rule is chronological, so the Santiago wall-clock hour of the cutoff
  // differs from the session hour when a transition falls inside the window.
  // A "same time on the previous calendar day" implementation would not.
  check(santiagoHour(startMs) !== santiagoHour(startMs - DAY_MS),
    'DST_CONTRACT ' + label + ': the window is not "same wall-clock time, previous day"');
  check(santiagoOffsetMinutes(startMs) !== santiagoOffsetMinutes(startMs - DAY_MS),
    'DST_CONTRACT ' + label + ': the fixture genuinely straddles the offset change');
});

// ===========================================================================
// PART 2 — the policy as enforced by the endpoints
// ===========================================================================

// 1/2 · Exactly 24h: reschedule and cancel both authorized end to end.
const b1 = clean.paidBooking(1, '2026-09-04', '15:00', 26 * HOUR_MS);
const b1Row = () => clean.rowFor(1);
check(Date.parse(b1Row().current_start_at) === FRIDAY_15, 'fixture session start is Friday 15:00 Chile');
clean.setNow(FRIDAY_15 - DAY_MS);
const b1Lookup = clean.context.manageLookup_({ postData: { contents: JSON.stringify({ token: b1.cancel }) } });
check(b1Lookup.ok && b1Lookup.managementWindow === 'open' && b1Lookup.canReschedule === true
  && b1Lookup.canCancel === true && b1Lookup.refundEligible === true && b1Lookup.refundPercent === 100
  && b1Lookup.cutoffHours === 24 && Date.parse(b1Lookup.cutoffAt) === FRIDAY_15 - DAY_MS,
  'MANAGE_UX at exactly 24h reports open / reschedule / cancel / 100% refund');
const b1Reschedule = clean.context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: b1.reschedule, fecha: '2026-09-11', hora: '15:00' }) },
});
check(b1Reschedule.ok && b1Reschedule.status === 'rescheduled', 'exactly 24h: reschedule is accepted by the endpoint');

// 9 · The rescheduled session gets a new cutoff from its new persisted start.
const b1NewStart = Date.parse(b1Row().current_start_at);
check(b1NewStart > FRIDAY_15, 'the reschedule persisted a later current_start_at');
const b1After = clean.context.getBookingManagementPolicy_(b1Row(), FRIDAY_15 - DAY_MS + 5000);
check(Date.parse(b1After.cutoff_at) === b1NewStart - DAY_MS,
  'RESCHEDULED_CUTOFF: the new cutoff is the new start minus 24h');
check(b1After.can_cancel === true && b1After.window === WINDOW.OPEN,
  'a clock past the OLD cutoff does not close a session that moved later');
check(clean.context.getBookingManagementPolicy_(b1Row(), b1NewStart - DAY_MS).can_cancel === true
  && clean.context.getBookingManagementPolicy_(b1Row(), b1NewStart - DAY_MS + 1).can_reschedule === false,
  'RESCHEDULED_CUTOFF: the new boundary is enforced at the new instant');

// 3/4/10/11/12 · Inside the cutoff: reschedule refused however it is requested.
const b2 = clean.paidBooking(2, '2026-09-04', '16:00', 26 * HOUR_MS);
const b2Start = Date.parse(clean.rowFor(2).current_start_at);
clean.setNow(b2Start - DAY_MS + 1000); // 23h59m59s
const b2Lookup = clean.context.manageLookup_({ postData: { contents: JSON.stringify({ token: b2.cancel }) } });
check(b2Lookup.ok && b2Lookup.managementWindow === 'cancel_only' && b2Lookup.canReschedule === false
  && b2Lookup.canCancel === true && b2Lookup.refundEligible === false && b2Lookup.refundPercent === 0,
  'MANAGE_UX at 23h59m59s reports cancel_only / no reschedule / no refund');
const b2Reschedule = clean.context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: b2.reschedule, fecha: '2026-09-11', hora: '16:00' }) },
});
check(b2Reschedule.ok === false && b2Reschedule.code === 'RESCHEDULE_WINDOW_CLOSED',
  'STALE_PAGE_GUARD: a reschedule submitted inside the cutoff is refused server-side');
check(Date.parse(clean.rowFor(2).current_start_at) === b2Start
  && clean.rowFor(2).patient_reschedule_count === '0',
  'a refused reschedule mutates nothing');

// 12 · No client-supplied time field can influence the decision.
const timeSpoofFields = ['now', 'nowMs', 'serverNow', 'clock', 'testNow', 'remaining_ms', 'cutoff_at',
  'canReschedule', 'managementWindow', 'refundEligible'];
timeSpoofFields.forEach((field) => {
  const payload = { token: b2.reschedule, fecha: '2026-09-11', hora: '16:00' };
  payload[field] = field === 'managementWindow' ? 'open' : (field === 'cutoff_at' ? '1970-01-01T00:00:00.000Z' : 1);
  const spoofed = clean.context.patientReschedule_({ postData: { contents: JSON.stringify(payload) } });
  check(spoofed.ok === false && spoofed.code === 'RESCHEDULE_WINDOW_CLOSED',
    'BROWSER_CLOCK_NOT_AUTHORITATIVE: payload field "' + field + '" cannot open the window');
});
// `date` and `time` are the requested SLOT, not a clock. What must never appear
// is a server instant or a policy verdict the caller could supply.
check(vm.runInContext('CREATE_FLOW_FIELDS.slice()', clean.context)
  .every((field) => !/^(now|nowms|servernow|clock|testnow)$|cutoff|window|remaining|refundeligible|canreschedule|cancancel/i
    .test(field)),
  'no create payload field carries a clock or a policy verdict');

// 10 · The stale-page scenario end to end: a page rendered at 26h, submitted at 22h.
const b3 = clean.paidBooking(3, '2026-09-09', '11:00', 27 * HOUR_MS);
const b3Start = Date.parse(clean.rowFor(3).current_start_at);
clean.setNow(b3Start - 26 * HOUR_MS);
const b3Rendered = clean.context.manageLookup_({ postData: { contents: JSON.stringify({ token: b3.cancel }) } });
check(b3Rendered.canReschedule === true && b3Rendered.managementWindow === 'open',
  'STALE_PAGE_GUARD: the page legitimately rendered REAGENDAR at 26h');
clean.setNow(b3Start - 22 * HOUR_MS); // the browser sat open for four hours
const b3Stale = clean.context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: b3.reschedule, fecha: '2026-09-11', hora: '11:00' }) },
});
check(b3Stale.ok === false && b3Stale.code === 'RESCHEDULE_WINDOW_CLOSED',
  'STALE_PAGE_GUARD: the same button, clicked four hours later, is rejected');
const b3Restale = clean.context.manageLookup_({ postData: { contents: JSON.stringify({ token: b3.cancel }) } });
check(b3Restale.canReschedule === false && b3Restale.managementWindow === 'cancel_only'
  && b3Restale.canCancel === true,
  'STALE_PAGE_GUARD: a reload now reports cancel_only, and cancel remains available');

// 14-18 · >=24h cancellation: slot released, exactly one refund, one final email.
const b4 = clean.paidBooking(4, '2026-09-10', '12:00', 26 * HOUR_MS);
const b4Start = Date.parse(clean.rowFor(4).current_start_at);
clean.setNow(b4Start - DAY_MS); // exactly 24h
clean.state.mail.length = 0;
const refundsBeforeB4 = clean.state.refundCreateCalls;
const b4Cancel = clean.context.patientCancel_({ postData: { contents: JSON.stringify({ token: b4.cancel }) } });
check(b4Cancel.ok && b4Cancel.refund === 'requested' && b4Cancel.refundPercent === 100,
  'GE24_CANCEL: a cancellation at exactly 24h is refundable at 100%');
check(clean.rowFor(4).schedule_status === 'cancelled'
  && clean.context.ACTIVE_SLOT_STATES.indexOf(clean.rowFor(4).booking_status) === -1
  && clean.phase.reservationOccupiesSlot_(clean.rowFor(4)) === false,
  'GE24 cancellation releases the slot immediately, before any refund outcome');
check(clean.state.refundCreateCalls === refundsBeforeB4 + 1,
  'GE24_REFUND_CREATE_MAX=1: exactly one provider refund is created');
check(clean.state.lastRefundPayload.amount === '50000'
  && clean.state.lastRefundPayload.commerceTrxId === clean.rowFor(4).commerce_order,
  'GE24 refund is 100% of the confirmed payment on the original transaction');
check(clean.rowFor(4).refund_status === 'refund_pending'
  && clean.rowFor(4).booking_status === 'cancellation_requested',
  'GE24 cancellation waits for provider confirmation before completing');
clean.drain();
check(clean.state.mail.filter((item) => item.subject === 'Tu sesión fue cancelada').length === 0,
  'GE24 pending refund sends NO patient cancellation email and makes no refund claim');
// 24 · double click / replay
const b4Replay = clean.context.patientCancel_({ postData: { contents: JSON.stringify({ token: b4.cancel }) } });
clean.drain();
check(b4Replay.ok && b4Replay.replay === true && clean.state.refundCreateCalls === refundsBeforeB4 + 1,
  'DOUBLE_CLICK: a second cancel creates no second refund');
check(clean.state.mail.filter((item) => item.subject === 'Tu sesión fue cancelada').length === 0,
  'DOUBLE_CLICK: a second cancel sends no patient email either');
// 18 · provider-confirmed REFUNDED => exactly one final patient email
clean.state.refundStatusOverride = 'refunded';
clean.context.refundConfirmation_({ parameter: { token: clean.rowFor(4).refund_provider_reference } });
clean.state.refundStatusOverride = 'accepted';
check(clean.rowFor(4).refund_status === 'refunded' && clean.rowFor(4).booking_status === 'cancelled',
  'GE24 provider confirmation completes both the refund and the cancellation');
clean.drain();
const b4Final = clean.state.mail.filter((item) => item.subject === 'Tu sesión fue cancelada');
check(b4Final.length === 1, 'FINAL_PATIENT_CANCELLATION_EMAIL_MAX=1 after provider confirmation');
check(/El reembolso fue procesado al mismo medio de pago utilizado\./.test(b4Final[0].body)
  && /hasta 10 días hábiles/.test(b4Final[0].body),
  'GE24 final email carries the approved refund copy verbatim');
clean.context.refundConfirmation_({ parameter: { token: clean.rowFor(4).refund_provider_reference } });
clean.drain();
check(clean.state.mail.filter((item) => item.subject === 'Tu sesión fue cancelada').length === 1,
  'a replayed provider callback does not produce a second final email');

// 19-23 · <24h cancellation: released, silent, and permanently non-refundable.
const b5 = clean.paidBooking(5, '2026-09-10', '13:00', 24 * HOUR_MS);
const b5Start = Date.parse(clean.rowFor(5).current_start_at);
clean.setNow(b5Start - 30 * 60000); // 30 minutes out
clean.state.mail.length = 0;
const refundsBeforeB5 = clean.state.refundCreateCalls;
const b5Cancel = clean.context.patientCancel_({ postData: { contents: JSON.stringify({ token: b5.cancel }) } });
check(b5Cancel.ok && b5Cancel.status === 'cancelled' && b5Cancel.refund === 'not_required'
  && b5Cancel.refundPercent === 0,
  'LT24_CANCEL: a cancellation inside the cutoff succeeds and is not refundable');
check(clean.rowFor(5).schedule_status === 'cancelled' && clean.rowFor(5).booking_status === 'cancelled'
  && clean.phase.reservationOccupiesSlot_(clean.rowFor(5)) === false,
  'LT24 cancellation releases the slot');
check(clean.state.refundCreateCalls === refundsBeforeB5,
  'LT24_REFUND_CREATE_COUNT=0: no Flow refund is created');
check(clean.rowFor(5).refund_status === 'not_required'
  && clean.rowFor(5).refund_last_error_code === 'PATIENT_CANCEL_LATE_NON_REFUNDABLE'
  && !clean.rowFor(5).refund_commerce_order && !clean.rowFor(5).refund_provider_reference,
  'LT24 persists a decided non-refundable outcome, not a pending refund');
check(clean.rowFor(5).payment_status === 'paid' && clean.rowFor(5).cancelled_at
  && clean.rowFor(5).cancellation_source === 'patient',
  'LT24 preserves the payment history and records the patient cancellation');
clean.drain();
const b5Mail = clean.state.mail.filter((item) => item.subject === 'Tu sesión fue cancelada');
check(b5Mail.length === 1, 'LT24 patient cancellation confirmation count = exactly 1');
check(!/(pago|cobro|valor|devoluci[oó]n|reembolso|\$50\.000|50000)/i.test(b5Mail[0].body)
  && !/(pago|cobro|valor|devoluci[oó]n|reembolso|\$50\.000|50000)/i.test(b5Mail[0].htmlBody || ''),
  'LT24 confirmation is economically silent: no refund claim, no amount, no charge');
check(clean.state.mail.filter((item) => item.to === OPS_EMAIL).length === 0,
  'LT24 is a decided outcome and raises no operational manual-review notice');
// 22 · replay cannot reclassify
const b5Replay = clean.context.patientCancel_({ postData: { contents: JSON.stringify({ token: b5.cancel }) } });
clean.drain();
check(b5Replay.ok && b5Replay.replay === true && clean.state.refundCreateCalls === refundsBeforeB5,
  'REPLAY cannot convert an LT24 cancellation into a refundable one');
check(clean.rowFor(5).refund_status === 'not_required',
  'REPLAY leaves the durable non-refundable classification intact');
check(clean.state.mail.filter((item) => item.subject === 'Tu sesión fue cancelada').length === 1,
  'REPLAY produces no second patient cancellation email');
// 23 · a direct refund attempt on that record is refused before any Flow call
const b5Direct = clean.context.beginRefundForPaidCancellation_(
  { sheet: clean.sheet, calendarGateway: null }, clean.schema(), clean.rowFor(5));
check(b5Direct.ok === false && b5Direct.code === 'REFUND_NOT_AUTHORIZED'
  && clean.state.refundCreateCalls === refundsBeforeB5,
  'NONREFUNDABLE_CALLBACK_GUARD: a reconciliation/callback refund attempt is refused with zero Flow calls');
check(clean.context.patientCancellationRefundAuthorized_(clean.rowFor(5)) === false
  && clean.context.patientCancellationRefundAuthorized_({ refund_status: 'refund_requested' }) === true,
  'refund authorization reads the persisted classification, not a recomputed window');
// A callback cannot even find the record: no provider reference was ever stored.
assert.throws(() => clean.context.refundConfirmation_({ parameter: { token: 'REFUNDTOKENPOLICY000000000001' } }),
  /REFUND_CALLBACK_INVALID/);
assertions += 1;
check(clean.state.refundCreateCalls === refundsBeforeB5,
  'a spoofed refund callback creates no refund for a non-refundable cancellation');
// A replayed Flow payment callback on the cancelled row must not resurrect the
// booking or reach the paid-after-hold-expiry remediation, which is the one
// other route in the file that can reach refund/create.
const b5FlowReplay = clean.context.doPost({
  parameter: { action: 'flow_confirmation', token: clean.rowFor(5).flow_token },
});
const b5FlowReplayBody = JSON.parse(b5FlowReplay.value);
check(b5FlowReplayBody.ok === false && b5FlowReplayBody.code === 'INVALID_STATE_TRANSITION',
  'a replayed Flow payment callback on a cancelled reservation fails closed');
check(clean.state.refundCreateCalls === refundsBeforeB5
  && clean.rowFor(5).booking_status === 'cancelled'
  && clean.rowFor(5).refund_status === 'not_required'
  && clean.rowFor(5).schedule_status === 'cancelled',
  'the replayed payment callback creates no refund and does not resurrect the booking');

// 6 · Started / past sessions: normal management is closed.
const b6 = clean.paidBooking(6, '2026-09-11', '14:00', 5 * HOUR_MS);
const b6Start = Date.parse(clean.rowFor(6).current_start_at);
clean.setNow(b6Start + 5 * 60000);
clean.state.mail.length = 0;
const refundsBeforeB6 = clean.state.refundCreateCalls;
const b6Lookup = clean.context.manageLookup_({ postData: { contents: JSON.stringify({ token: b6.cancel }) } });
check(b6Lookup.ok && b6Lookup.managementWindow === 'closed' && b6Lookup.canCancel === false
  && b6Lookup.canReschedule === false && b6Lookup.refundEligible === false,
  'PAST_SESSION_POLICY: /manage reports a neutral closed state');
const b6Cancel = clean.context.patientCancel_({ postData: { contents: JSON.stringify({ token: b6.cancel }) } });
check(b6Cancel.ok === false && b6Cancel.code === 'MANAGEMENT_WINDOW_CLOSED',
  'PAST_SESSION_POLICY: the cancel endpoint refuses a started session');
const b6Reschedule = clean.context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: b6.reschedule, fecha: '2026-09-25', hora: '14:00' }) },
});
check(b6Reschedule.ok === false && b6Reschedule.code === 'RESCHEDULE_WINDOW_CLOSED',
  'PAST_SESSION_POLICY: the reschedule endpoint refuses a started session');
check(clean.rowFor(6).booking_status === 'confirmed' && clean.rowFor(6).schedule_status === 'scheduled'
  && clean.state.refundCreateCalls === refundsBeforeB6,
  'a refused past-session request mutates nothing and calls no provider');
clean.drain();
check(clean.state.mail.length === 0, 'a refused past-session request sends no email');

// 13 · Fail closed at the endpoint when the persisted schedule is unusable.
const b7 = clean.paidBooking(7, '2026-09-08', '10:00', 26 * HOUR_MS);
clean.setNow(Date.parse(clean.rowFor(7).current_start_at) - 25 * HOUR_MS);
const b7Row = clean.rowFor(7);
const b7GoodStart = b7Row.current_start_at;
b7Row.current_start_at = 'not-a-time';
const refundsBeforeB7 = clean.state.refundCreateCalls;
const b7Lookup = clean.context.manageLookup_({ postData: { contents: JSON.stringify({ token: b7.cancel }) } });
check(b7Lookup.ok && b7Lookup.managementWindow === 'closed' && b7Lookup.canCancel === false
  && b7Lookup.canReschedule === false && b7Lookup.cutoffAt === '',
  'FAIL_CLOSED: an unusable persisted start authorizes nothing on /manage');
const b7Cancel = clean.context.patientCancel_({ postData: { contents: JSON.stringify({ token: b7.cancel }) } });
const b7Reschedule = clean.context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: b7.reschedule, fecha: '2026-09-11', hora: '10:00' }) },
});
check(b7Cancel.ok === false && b7Reschedule.ok === false && clean.state.refundCreateCalls === refundsBeforeB7,
  'FAIL_CLOSED: neither mutation is authorized and no refund is attempted');
b7Row.current_start_at = b7GoodStart;

// 17 · A failing provider refund preserves the manual-review path and claims nothing.
const b8 = clean.paidBooking(8, '2026-09-09', '17:00', 26 * HOUR_MS);
const b8Start = Date.parse(clean.rowFor(8).current_start_at);
clean.setNow(b8Start - 25 * HOUR_MS);
clean.state.mail.length = 0;
clean.state.refundCreateShouldFail = true;
const refundsBeforeB8 = clean.state.refundCreateCalls;
const b8Cancel = clean.context.patientCancel_({ postData: { contents: JSON.stringify({ token: b8.cancel }) } });
clean.state.refundCreateShouldFail = false;
check(b8Cancel.ok && b8Cancel.refund === 'requested' && clean.state.refundCreateCalls === refundsBeforeB8 + 1,
  'GE24 refund failure still attempted the provider exactly once');
check(['manual_review', 'refund_failed'].indexOf(clean.rowFor(8).refund_status) !== -1
  && clean.rowFor(8).booking_status === 'cancellation_requested',
  'GE24 refund failure parks the reservation for manual review');
clean.drain();
check(clean.state.mail.filter((item) => item.subject === 'Tu sesión fue cancelada').length === 0,
  'GE24 refund failure sends NO patient email claiming a refund');
check(clean.state.mail.filter((item) => item.to === OPS_EMAIL
  && /Revisión operativa/.test(item.subject + item.body)).length >= 1,
  'GE24 refund failure raises the internal manual-review notice');

// 26 · /manage capability rendering is exactly the backend decision.
[
  [FRIDAY_15 - 2 * DAY_MS, 'open', true, true, true],
  [FRIDAY_15 - DAY_MS, 'open', true, true, true],
  [FRIDAY_15 - DAY_MS + 1, 'cancel_only', false, true, false],
  [FRIDAY_15 - 30 * 60000, 'cancel_only', false, true, false],
  [FRIDAY_15, 'closed', false, false, false],
  [FRIDAY_15 + HOUR_MS, 'closed', false, false, false],
].forEach(([nowMs, window, canReschedule, canCancel, refundEligible]) => {
  const record = confirmedPaid(FRIDAY_15);
  const view = clean.context.publicManagementRecord_(record, 'CANCEL', nowMs);
  const decision = policy(record, nowMs);
  check(view.managementWindow === window && view.canReschedule === canReschedule
    && view.canCancel === canCancel && view.refundEligible === refundEligible,
    'MANAGE_UX_POLICY matches the backend at ' + new Date(nowMs).toISOString());
  check(view.managementWindow === decision.window && view.canCancel === decision.can_cancel
    && view.refundEligible === decision.refund_eligible
    && view.refundPercent === decision.refund_percent,
    'MANAGE_UX_POLICY is a projection of getBookingManagementPolicy_, not a second implementation');
});
const rescheduledView = clean.context.publicManagementRecord_(
  Object.assign(confirmedPaid(FRIDAY_15), { patient_reschedule_count: '1' }), 'RESCHEDULE', FRIDAY_15 - 2 * DAY_MS);
check(rescheduledView.canReschedule === false && rescheduledView.canCancel === true,
  'a patient who already moved once keeps cancel but not a second reschedule');
const publicKeys = Object.keys(clean.context.publicManagementRecord_(confirmedPaid(FRIDAY_15), 'CANCEL', T0));
check(!publicKeys.some((key) => /reason|booking_status|refund_status|schedule_status|capability_hash/.test(key)),
  'the /manage contract exposes no internal state names');

// 27/28/29 · Copy contracts.
const templates = clean.context.__EMAIL_TEMPLATE_TEST_EXPORTS__;
const POLICY_REMINDER = 'Puedes reagendar o cancelar tu sesión hasta 24 horas antes del horario agendado.';
check(templates.emailV3ManagementPolicyCopy_() === POLICY_REMINDER,
  'CONFIRMATION_EMAIL_POLICY_REMINDER is the approved copy and reads 24 from the policy constant');
const confirmationRecord = Object.assign(confirmedPaid(FRIDAY_15), { service_type: 'initial', modality: 'online' });
const confirmationEmail = clean.context.renderLifecycleNotificationEmail_({
  notification: { eventType: 'BOOKING_CONFIRMED', meet: { meetUrl: 'https://meet.google.com/opaque-meet' } },
  record: confirmationRecord,
  capabilityTokens: { RESCHEDULE: 'r'.repeat(64), CANCEL: 'c'.repeat(64) },
  previewOrigin: 'https://franciscabustos.cl',
});
check(confirmationEmail.htmlBody.includes(POLICY_REMINDER),
  'CONFIRMATION_EMAIL_POLICY_REMINDER present in the HTML confirmation');
check(confirmationEmail.body.includes(POLICY_REMINDER),
  'CONFIRMATION_EMAIL_POLICY_REMINDER present in the text/plain confirmation');
const reminderIndex = confirmationEmail.htmlBody.indexOf(POLICY_REMINDER);
check(reminderIndex > confirmationEmail.htmlBody.indexOf('CANCELAR SESIÓN')
  && reminderIndex < confirmationEmail.htmlBody.indexOf('¿Necesitas ayuda?'),
  'the reminder sits under the management CTAs it explains, above the footer');
['PATIENT_RESCHEDULED', 'CLINICIAN_RESCHEDULED', 'SESSION_CANCELLED', 'PATIENT_CANCELLED'].forEach((eventType) => {
  const other = clean.context.renderLifecycleNotificationEmail_({
    notification: { eventType, meet: null },
    record: Object.assign(confirmedPaid(FRIDAY_15), { refund_status: 'refunded' }),
    capabilityTokens: {}, previewOrigin: 'https://franciscabustos.cl',
  });
  check(!other.htmlBody.includes(POLICY_REMINDER) && !other.body.includes(POLICY_REMINDER),
    'the reminder is confirmation-only and does not leak into ' + eventType);
});

const [reservaHtml, faqHtml, manageHtml, workerSource] = await Promise.all([
  readFile(new URL('../../../../reserva.html', import.meta.url), 'utf8'),
  readFile(new URL('../../../../faq.html', import.meta.url), 'utf8'),
  readFile(new URL('../../../../manage.html', import.meta.url), 'utf8'),
  readFile(new URL('../../../../_worker.js', import.meta.url), 'utf8'),
]);
const PREPAYMENT_COPY = 'Puedes reagendar o cancelar tu sesión sin costo con al menos 24 horas de anticipación. '
  + 'Si cancelas con menos de 24 horas, puedes igualmente avisarnos que no asistirás, pero la '
  + 'sesión no será reembolsable ni podrá reagendarse.';
check(reservaHtml.includes(PREPAYMENT_COPY),
  'PREPAYMENT_POLICY_COPY is present on the reservation review step, before payment');
const reviewNote = reservaHtml.slice(reservaHtml.indexOf('bk-review-note'), reservaHtml.indexOf('data-action="confirm"'));
check(reviewNote.includes(PREPAYMENT_COPY),
  'PREPAYMENT_POLICY_COPY appears above the "Continuar al pago" action, not after it');
check(!/se cobran en un 50%/i.test(faqHtml) && !/cobran un 50/i.test(faqHtml),
  'the contradictory 50% cancellation charge is gone from the FAQ');
check((faqHtml.match(/al menos 24 horas de anticipación/g) || []).length >= 2,
  'the FAQ states the same 24-hour rule in both its JSON-LD and its visible copy');
check(!/escríbenos por WhatsApp o email\./.test(reviewNote),
  'the pre-payment surface no longer sends self-service management to WhatsApp');

// Client-side policy arithmetic must not exist.
const manageScript = manageHtml.slice(manageHtml.indexOf('<script'));
check(/reserva\.canReschedule === true/.test(manageScript) && /reserva\.canCancel === true/.test(manageScript)
  && /reserva\.managementWindow === 'cancel_only'/.test(manageScript)
  && /reserva\.refundEligible === true/.test(manageScript),
  'manage.html renders capabilities from the server decision');
check(!/24\s*\*\s*60\s*\*\s*60|86400000|cutoffAt\s*[<>]|Date\.parse\([^)]*cutoff/i.test(manageScript),
  'manage.html contains no client-side cutoff arithmetic');
check(manageScript.includes('Ya no es posible reagendar esta sesión porque faltan menos de 24 horas para el horario agendado.'),
  'MANAGE_UX_POLICY: the non-alarmist reschedule-closed copy is present');
check(manageScript.includes('Puedes cancelar esta sesión y recibir el reembolso completo al mismo medio de pago utilizado.'),
  'MANAGE_UX_POLICY: the refundable cancellation copy is present');
check(manageScript.includes('Esta sesión comienza en menos de 24 horas. Puedes cancelarla para informarnos que no asistirás, pero de acuerdo con la política de cancelación no corresponde reembolso.'),
  'MANAGE_UX_POLICY: the non-refundable cancellation copy is present');
check(/managementWindow: MANAGEMENT_WINDOWS\.includes\(data\.managementWindow\) \? data\.managementWindow : 'closed'/.test(workerSource),
  'the Worker clamps an unknown management window to closed');
['patient_cancel', 'patient_reschedule'].forEach((action) => {
  const call = workerSource.slice(workerSource.indexOf("?action=" + action));
  const body = call.slice(call.indexOf('body: JSON.stringify('), call.indexOf('redirect:'));
  check(!/now|clock|cutoff|window|Reschedule|Cancel:/i.test(body.replace(/action: '[^']*'/, '')),
    'the Worker forwards no clock or capability field on ' + action);
});

// ===========================================================================
// PART 3 — mutation / adversarial testing
//
// Each mutation breaks exactly one guard. `probes` re-runs the load-bearing
// contract against the mutated build; a mutation that leaves every probe
// passing means this file does not really test that guard, and fails the run.
// ===========================================================================
function probes(h) {
  const results = [];
  const probe = (name, fn) => {
    try { results.push({ name, ok: fn() === true }); }
    catch (error) { results.push({ name, ok: false, error: String(error && error.message || error) }); }
  };

  probe('policy_boundary_reschedule', () => {
    const p = h.context.getBookingManagementPolicy_(confirmedPaid(FRIDAY_15), FRIDAY_15 - DAY_MS + 1000);
    return p.can_reschedule === false && p.can_cancel === true;
  });
  probe('policy_boundary_refund', () => {
    const p = h.context.getBookingManagementPolicy_(confirmedPaid(FRIDAY_15), FRIDAY_15 - DAY_MS + 1000);
    return p.refund_eligible === false && p.refund_percent === 0;
  });
  probe('policy_exactly_24h_inclusive', () => {
    const p = h.context.getBookingManagementPolicy_(confirmedPaid(FRIDAY_15), FRIDAY_15 - DAY_MS);
    return p.can_reschedule === true && p.refund_eligible === true;
  });
  probe('policy_current_start_authority', () => {
    const record = confirmedPaid(FRIDAY_15);
    record.original_start_at = new Date(FRIDAY_15 + 30 * DAY_MS).toISOString();
    return h.context.getBookingManagementPolicy_(record, FRIDAY_15 - HOUR_MS).can_reschedule === false;
  });
  probe('manage_matches_backend', () => {
    const record = confirmedPaid(FRIDAY_15);
    const nowMs = FRIDAY_15 - DAY_MS + 1000;
    const view = h.context.publicManagementRecord_(record, 'RESCHEDULE', nowMs);
    return view.canReschedule === false && view.managementWindow === 'cancel_only' && view.refundEligible === false;
  });

  // Endpoint-level probes need their own bookings inside this build.
  probe('endpoint_reschedule_cutoff', () => {
    const booking = h.paidBooking(51, '2026-09-10', '15:00', 26 * HOUR_MS);
    const start = Date.parse(h.rowFor(51).current_start_at);
    h.setNow(start - DAY_MS + 1000);
    const result = h.context.patientReschedule_({
      postData: { contents: JSON.stringify({ token: booking.reschedule, fecha: '2026-09-11', hora: '15:00' }) },
    });
    return result.ok === false && result.code === 'RESCHEDULE_WINDOW_CLOSED'
      && h.rowFor(51).patient_reschedule_count === '0';
  });
  probe('endpoint_lt24_zero_refunds', () => {
    const booking = h.paidBooking(52, '2026-09-10', '16:00', 24 * HOUR_MS);
    const start = Date.parse(h.rowFor(52).current_start_at);
    h.setNow(start - 30 * 60000);
    const before = h.state.refundCreateCalls;
    const result = h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
    return result.ok === true && h.state.refundCreateCalls === before
      && h.rowFor(52).refund_status === 'not_required'
      && h.rowFor(52).booking_status === 'cancelled';
  });
  probe('endpoint_lt24_single_silent_email', () => {
    const booking = h.paidBooking(53, '2026-09-10', '17:00', 24 * HOUR_MS);
    const start = Date.parse(h.rowFor(53).current_start_at);
    h.setNow(start - 30 * 60000);
    h.state.mail.length = 0;
    h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
    h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
    h.drain();
    const patientMail = h.state.mail.filter((item) => item.subject === 'Tu sesión fue cancelada');
    return patientMail.length === 1
      && !/(reembolso|devoluci[oó]n|50000|\$50\.000)/i.test(patientMail[0].body);
  });
  probe('endpoint_nonrefundable_refund_refused', () => {
    const booking = h.paidBooking(54, '2026-09-11', '10:00', 24 * HOUR_MS);
    const start = Date.parse(h.rowFor(54).current_start_at);
    h.setNow(start - 30 * 60000);
    h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
    const before = h.state.refundCreateCalls;
    const direct = h.context.beginRefundForPaidCancellation_(
      { sheet: h.sheet, calendarGateway: null }, h.schema(), h.rowFor(54));
    return direct.ok === false && direct.code === 'REFUND_NOT_AUTHORIZED'
      && h.state.refundCreateCalls === before;
  });
  probe('endpoint_ge24_refund_create_max_1', () => {
    const booking = h.paidBooking(55, '2026-09-11', '11:00', 26 * HOUR_MS);
    const start = Date.parse(h.rowFor(55).current_start_at);
    h.setNow(start - 25 * HOUR_MS);
    const before = h.state.refundCreateCalls;
    h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
    h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
    h.context.beginRefundForPaidCancellation_(
      { sheet: h.sheet, calendarGateway: null }, h.schema(), h.rowFor(55));
    return h.state.refundCreateCalls === before + 1;
  });
  probe('endpoint_ge24_final_email_max_1', () => {
    const booking = h.paidBooking(56, '2026-09-11', '12:00', 26 * HOUR_MS);
    const start = Date.parse(h.rowFor(56).current_start_at);
    h.setNow(start - 25 * HOUR_MS);
    h.state.mail.length = 0;
    h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
    h.drain();
    if (h.state.mail.filter((item) => item.subject === 'Tu sesión fue cancelada').length !== 0) return false;
    h.state.refundStatusOverride = 'refunded';
    h.context.refundConfirmation_({ parameter: { token: h.rowFor(56).refund_provider_reference } });
    h.context.refundConfirmation_({ parameter: { token: h.rowFor(56).refund_provider_reference } });
    h.state.refundStatusOverride = 'accepted';
    h.drain();
    return h.state.mail.filter((item) => item.subject === 'Tu sesión fue cancelada').length === 1;
  });
  // The cross-type guard: a pre-confirmation SESSION_CANCELLED already sent must
  // block a later provider-confirmed PATIENT_CANCELLED from becoming a second
  // patient email. Same-type repeats are covered by the durable outbox replay,
  // so only this crossing exercises enqueuePatientCancellationNotificationOnce_.
  probe('cross_type_cancellation_email_once', () => {
    const booking = h.paidBooking(58, '2026-09-11', '14:00', 24 * HOUR_MS);
    const start = Date.parse(h.rowFor(58).current_start_at);
    h.setNow(start - 30 * 60000);
    h.state.mail.length = 0;
    h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
    h.drain();
    const first = h.state.mail.filter((item) => item.subject === 'Tu sesión fue cancelada').length;
    const second = h.context.enqueuePatientCancellationNotificationOnce_(
      h.sheet, h.schema(), h.rowFor(58), 'PATIENT_CANCELLED');
    h.drain();
    const total = h.state.mail.filter((item) => item.subject === 'Tu sesión fue cancelada').length;
    return first === 1 && second === null && total === 1;
  });
  probe('endpoint_past_session_closed', () => {
    const booking = h.paidBooking(57, '2026-09-11', '13:00', 5 * HOUR_MS);
    const start = Date.parse(h.rowFor(57).current_start_at);
    h.setNow(start + 60000);
    const cancel = h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
    return cancel.ok === false && cancel.code === 'MANAGEMENT_WINDOW_CLOSED'
      && h.rowFor(57).booking_status === 'confirmed';
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
    key: 'MUTATION_RESCHEDULE_CUTOFF',
    label: 'A. remove the server-side reschedule cutoff guard',
    patches: { 'Lifecycle.js': [['if (!policy.can_reschedule) {', 'if (false) {']] },
    mustFail: ['endpoint_reschedule_cutoff'],
  },
  {
    key: 'MUTATION_LT24_REFUND',
    label: 'B. allow a refund for a cancellation inside the cutoff',
    patches: { 'Lifecycle.js': [['const refundEligible = beforeCutoff && paid;', 'const refundEligible = paid;']] },
    mustFail: ['policy_boundary_refund', 'endpoint_lt24_zero_refunds', 'manage_matches_backend'],
  },
  {
    key: 'MUTATION_CLIENT_AUTHORITY',
    label: 'C. trust the client instead of the server policy for capabilities',
    patches: {
      'Code.js': [[
        'canReschedule: Boolean(policy.can_reschedule && lifecycleRecordReadyForReschedule_(record)),',
        'canReschedule: true,',
      ]],
    },
    mustFail: ['manage_matches_backend'],
  },
  {
    key: 'MUTATION_CURRENT_START',
    label: 'D. derive the cutoff from original_start_at instead of the current persisted start',
    patches: {
      'Lifecycle.js': [[
        "const startMs = Date.parse(String(reservation.current_start_at || ''));",
        "const startMs = Date.parse(String(reservation.original_start_at || reservation.current_start_at || ''));",
      ]],
    },
    mustFail: ['policy_current_start_authority'],
  },
  {
    key: 'MUTATION_REFUND_IDEMPOTENCY',
    label: 'E. remove refund/create idempotency',
    patches: { 'RefundGateway.js': [['if (existingOrder) {', 'if (false) {']] },
    mustFail: ['endpoint_ge24_refund_create_max_1'],
  },
  {
    key: 'MUTATION_EMAIL_IDEMPOTENCY',
    label: 'F. remove final patient cancellation email idempotency',
    patches: {
      'Code.js': [[
        'if (patientCancellationNotificationExists_(store, record && record.reservation_id)) return null;',
        '',
      ]],
    },
    mustFail: ['cross_type_cancellation_email_once'],
  },
  {
    key: 'MUTATION_NONREFUNDABLE_CALLBACK',
    label: 'G. let a callback/reconciliation refund a non-refundable cancellation',
    patches: { 'Code.js': [['if (!patientCancellationRefundAuthorized_(record)) {', 'if (false) {']] },
    mustFail: ['endpoint_nonrefundable_refund_refused'],
  },
];

const mutationReport = [];
MUTATIONS.forEach((mutation) => {
  let results;
  try { results = probes(buildHarness(mutation.patches)); }
  catch (error) {
    // A mutation that cannot even build is a detected mutation.
    results = [{ name: 'build', ok: false, error: String(error && error.message || error) }];
  }
  const failed = results.filter((item) => item.ok !== true).map((item) => item.name);
  check(failed.length > 0, mutation.label + ' — MUST be detected by the contract, but every probe passed');
  mutation.mustFail.forEach((name) => {
    check(failed.indexOf(name) !== -1 || failed.indexOf('build') !== -1,
      mutation.label + ' — probe "' + name + '" must fail under this mutation');
  });
  mutationReport.push(mutation.key + '=DETECTED_BY[' + failed.join(',') + ']');
});

// ===========================================================================
console.log('MANAGEMENT_POLICY_24H_TESTS=PASS assertions=' + assertions);
console.log('POLICY_CANONICAL_SOURCE=getBookingManagementPolicy_ (backend/appsscript/booking/Lifecycle.js)');
console.log('PATIENT_MANAGEMENT_CUTOFF_HOURS=' + clean.phase.PATIENT_MANAGEMENT_CUTOFF_HOURS);
console.log('BOUNDARY_24H_EXACT=RESCHEDULE_YES_CANCEL_YES_REFUND_100');
console.log('BOUNDARY_23H59M59S=RESCHEDULE_NO_CANCEL_YES_REFUND_0');
console.log('PAST_SESSION_POLICY=NORMAL_SELF_MANAGEMENT_CLOSED');
console.log('GE24_REFUND_CREATE_MAX=1');
console.log('LT24_REFUND_CREATE_COUNT=0');
console.log('FINAL_PATIENT_CANCELLATION_EMAIL_MAX=1');
console.log('DST_TRANSITIONS_COVERED=' + new Date(dstSpring).toISOString() + ',' + new Date(dstAutumn).toISOString());
mutationReport.forEach((line) => console.log(line));
console.log('PRODUCTION_EMAILS_SENT=0');
console.log('REAL_FLOW_CALLS=0');
console.log('REAL_NETWORK_SIDE_EFFECTS=0');

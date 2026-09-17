/**
 * Immediate lifecycle-notification dispatch.
 *
 * The durable outbox and its 5-minute worker are unchanged. What this suite
 * pins is the accelerator layered on top: after the authoritative state is
 * persisted and the outbox row written, the same execution makes ONE
 * best-effort delivery attempt for that new row.
 *
 * The properties that matter are not "it is fast". They are:
 *
 *   1. the patient can never receive the same message twice;
 *   2. an immediate attempt that fails leaves the row exactly where the
 *      periodic worker expects it, and the worker then delivers it once;
 *   3. no part of the booking, payment, reschedule, cancellation or refund
 *      lifecycle depends on a send succeeding;
 *   4. nothing is announced before it is true — Calendar/Meet, the moved
 *      schedule and the cancellation are all persisted before the message
 *      leaves, which is checked at the instant of the send, not afterwards;
 *   5. the refund communication policy is untouched.
 *
 * Synthetic fixtures only: no network, no Google service, no Flow, no email.
 */
import assert from 'node:assert/strict';
import { buildHarness, CAPABILITY_SECRET, DAY_MS, OPS_EMAIL, PATIENT_EMAIL } from './helpers/policy-harness.mjs';

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const detected = [];

const CONFIRMED = 'Tu sesión está confirmada';
const RESCHEDULED = 'Tu sesión fue reagendada';
const REFUND_REQUESTED = 'Tu solicitud de reembolso fue gestionada';
const CANCELLED = 'Tu sesión fue cancelada';
const INTERNAL = 'Acción requerida';

const patientMail = (h) => h.state.mail.filter((item) => item.to === PATIENT_EMAIL);
const withSubject = (h, prefix) => h.state.mail.filter((item) => String(item.subject).startsWith(prefix));
const outboxFor = (h, id) => h.state.outboxRows.filter((row) => row.reservation_id === id);

/**
 * Create + confirm a paid booking WITHOUT the policy harness's own drain, so
 * the confirmation observed here is the one the immediate attempt produced.
 */
function confirmBooking(h, n, date, time, leadMs) {
  const startMs = Date.parse(h.phase.startAt_(date, time));
  h.setNow(startMs - Number(leadMs));
  const created = h.context.createFlowPayment_({
    postData: { contents: JSON.stringify({
      action: 'create_flow_payment', idempotencyKey: idem(n), serviceType: 'initial', modality: 'online',
      date, time, name: 'Synthetic', email: PATIENT_EMAIL, phone: '', patientRut: '', reason: '', message: '',
    }) },
  });
  if (!created.ok) throw new Error('fixture booking rejected: ' + JSON.stringify(created));
  const row = h.rowFor(n);
  h.state.flowByToken.get(row.flow_token).status = 2;
  h.state.mail.length = 0;
  const confirmed = h.context.flowConfirmation_({ parameter: { token: row.flow_token } });
  return { confirmed, startMs };
}
const idem = (n) => 'fran-booking-bbbbbb' + String(n).padStart(2, '0') + '-e89b-12d3-a456-426614174000';
const ctaToken = (body, label) => {
  const found = String(body).match(new RegExp(label + ':.*token=([A-Za-z0-9_-]{64,256})'));
  return found ? found[1] : null;
};

// ===========================================================================
// 1. Immediate success: exactly one confirmation, sent inside the callback,
//    and only after Calendar/Meet and the confirmed state are authoritative.
// ===========================================================================
{
  const h = buildHarness(null);
  const snapshots = [];
  h.state.onMail = (mail) => {
    const row = h.rowFor(31);
    snapshots.push({
      subject: mail.subject,
      booking_status: row && row.booking_status,
      payment_status: row && row.payment_status,
      schedule_status: row && row.schedule_status,
      calendar_event_id: row && row.calendar_event_id,
      meet_url: row && row.meet_url,
      calendarEvents: [...h.state.eventsById.values()].filter((event) => event.status !== 'cancelled').length,
    });
  };
  const { confirmed } = confirmBooking(h, 31, '2026-09-24', '11:00', 10 * DAY_MS);
  check(confirmed.ok && confirmed.status === 'payment_confirmed', 'the confirmation callback still succeeds');

  const confirmations = withSubject(h, CONFIRMED);
  check(confirmations.length === 1 && h.state.mail.length === 1,
    'IMMEDIATE_SUCCESS_EMAIL_COUNT=1 — the confirmation is delivered inside the callback');

  const row = h.rowFor(31);
  const durable = outboxFor(h, row.reservation_id);
  check(durable.length === 1 && durable[0].event_type === 'BOOKING_CONFIRMED'
    && durable[0].state === 'sent' && durable[0].last_result === 'sent' && durable[0].attempt_count === '1',
    'the durable row is written first and then marked sent by the same execution');

  // Ordering, checked at the instant of the send rather than after the fact.
  check(snapshots.length === 1 && snapshots[0].booking_status === 'confirmed'
    && snapshots[0].payment_status === 'paid' && snapshots[0].schedule_status === 'scheduled'
    && Boolean(snapshots[0].calendar_event_id) && Boolean(snapshots[0].meet_url)
    && snapshots[0].calendarEvents === 1,
    'CALENDAR_AUTHORITATIVE_BEFORE_CONFIRMATION_EMAIL — the state was already persisted when the message left');
  check(confirmations[0].body.includes(row.meet_url) && row.meet_url.startsWith('https://meet.google.com/'),
    'the delivered confirmation carries the Meet link the Calendar insert produced');

  // Exactly once: the periodic worker must find nothing to do.
  const after = h.drain();
  check(after.ok && after.processed === 0 && withSubject(h, CONFIRMED).length === 1,
    'FALLBACK_WORKER_DOES_NOT_RESEND — the worker skips a row the immediate attempt sent');

  // Replay of the same mutation reuses the row and dispatches nothing.
  const replay = h.context.flowConfirmation_({ parameter: { token: h.rowFor(31).flow_token } });
  check(replay.status === 'payment_confirmed'
    && outboxFor(h, row.reservation_id).length === 1
    && withSubject(h, CONFIRMED).length === 1,
    'REPLAY_EMAIL_COUNT=0 — a replayed mutation appends no row and sends nothing');
  h.drain();
  check(withSubject(h, CONFIRMED).length === 1, 'and a later worker pass still sends nothing for the replay');
}

// ===========================================================================
// 2. Concurrency: two executors holding independent, equally stale views of
//    the same pending row. Exactly one of them may deliver.
// ===========================================================================
{
  const h = buildHarness(null);
  h.context.IMMEDIATE_NOTIFICATION_DISPATCH_ENABLED = false;
  confirmBooking(h, 32, '2026-09-24', '12:00', 10 * DAY_MS);
  h.context.IMMEDIATE_NOTIFICATION_DISPATCH_ENABLED = true;
  const row = h.rowFor(32);
  const pending = outboxFor(h, row.reservation_id)[0];
  check(pending.state === 'pending' && h.state.mail.length === 0,
    'with the accelerator off the row is left pending and nothing is sent');

  // Two callers, each with its own snapshot taken while the row was pending.
  const viewA = Object.assign({}, pending);
  const viewB = Object.assign({}, pending);
  const dispatch = (view) => h.worker.dispatchLifecycleNotificationImmediateBestEffort_(
    h.sheet, h.schema(), h.worker.sheetNotificationOutboxStore_(h.sheet.getParent().getSheetByName('notification_outbox')), view);
  const first = dispatch(viewA);
  const second = dispatch(viewB);
  check(first && first.ok && first.code === 'SENT', 'the first caller delivers');
  check(second && second.code === 'SENT' && h.state.mail.length === 1,
    'CONCURRENT_DISPATCH_EMAIL_COUNT=1 — the second caller finds the row terminal and sends nothing');
  h.drain();
  check(h.state.mail.length === 1, 'and the worker afterwards adds nothing either');
}

// ===========================================================================
// 3. Immediate failure: the lifecycle stands, the row stays retryable, and the
//    periodic worker is still the recovery path — for confirmation, reschedule
//    and cancellation alike.
// ===========================================================================
{
  const h = buildHarness(null);

  // --- confirmation --------------------------------------------------------
  h.state.mailShouldFail = true;
  const { confirmed } = confirmBooking(h, 33, '2026-09-24', '13:00', 10 * DAY_MS);
  h.state.mailShouldFail = false;
  const row33 = h.rowFor(33);
  check(confirmed.ok && confirmed.status === 'payment_confirmed'
    && row33.booking_status === 'confirmed' && row33.payment_status === 'paid'
    && row33.schedule_status === 'scheduled',
    'BOOKING_CONFIRMATION_SURVIVES_SEND_FAILURE — payment and booking do not depend on email');
  const failedRow = outboxFor(h, row33.reservation_id)[0];
  check(h.state.mail.length === 0 && h.state.mailAttempts === 1
    && failedRow.state === 'failed' && failedRow.last_result === 'failed' && failedRow.attempt_count === '1',
    'IMMEDIATE_FAILURE_LEAVES_ROW_RETRYABLE — one attempt consumed, state still retryable');

  const recovered = h.drain();
  check(recovered.ok && recovered.processed === 1 && withSubject(h, CONFIRMED).length === 1
    && outboxFor(h, row33.reservation_id)[0].state === 'sent',
    'FALLBACK_WORKER_EMAIL_COUNT=1 — the worker recovers the failed immediate attempt exactly once');
  h.drain();
  check(withSubject(h, CONFIRMED).length === 1, 'and never sends it a second time');

  const tokens = { reschedule: ctaToken(withSubject(h, CONFIRMED)[0].body, 'Reagendar') };
  check(Boolean(tokens.reschedule), 'the recovered confirmation still carries its management bearers');

  // --- reschedule ----------------------------------------------------------
  h.setNow(Date.parse(h.rowFor(33).current_start_at) - 5 * DAY_MS);
  h.state.mail.length = 0;
  h.state.mailShouldFail = true;
  const moved = h.context.patientReschedule_({ postData: { contents: JSON.stringify({
    token: tokens.reschedule, fecha: '2026-09-25', hora: '15:00' }) } });
  h.state.mailShouldFail = false;
  check(moved.ok === true && h.rowFor(33).patient_reschedule_count === '1'
    && h.rowFor(33).current_start_at === '2026-09-25T18:00:00.000Z',
    'RESCHEDULE_SURVIVES_SEND_FAILURE — the move persists although the send threw');
  const rescheduleRow = outboxFor(h, row33.reservation_id).find((r) => r.event_type === 'PATIENT_RESCHEDULED');
  check(Boolean(rescheduleRow) && rescheduleRow.state === 'failed' && h.state.mail.length === 0,
    'the reschedule notice is left for the worker');
  h.drain();
  check(withSubject(h, RESCHEDULED).length === 1, 'the worker delivers the reschedule notice exactly once');

  // The reschedule email cannot predate the move it announces.
  check(withSubject(h, RESCHEDULED)[0].body.includes('15:00')
    && [...h.state.eventsById.values()].some((event) => event.status !== 'cancelled'
      && String(event.start.dateTime) === '2026-09-25T18:00:00.000Z'),
    'RESCHEDULE_STATE_AND_CALENDAR_AUTHORITATIVE_BEFORE_EMAIL');

  // --- cancellation --------------------------------------------------------
  const cancelToken = ctaToken(withSubject(h, RESCHEDULED)[0].body, 'Cancelar');
  check(Boolean(cancelToken), 'the reschedule notice carries the rotated cancel bearer');
  h.setNow(Date.parse(h.rowFor(33).current_start_at) - 5 * DAY_MS);
  h.state.mail.length = 0;
  const refundsBefore = h.state.refundCreateCalls;
  h.state.mailShouldFail = true;
  const cancelled = h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: cancelToken }) } });
  h.state.mailShouldFail = false;
  check(cancelled.ok === true && cancelled.refund === 'requested'
    && h.rowFor(33).schedule_status === 'cancelled'
    && h.rowFor(33).refund_status === 'refund_pending'
    && h.state.refundCreateCalls === refundsBefore + 1,
    'CANCELLATION_SURVIVES_SEND_FAILURE — cancellation, slot release and the single refund all stand');
  check(h.state.mail.length === 0, 'nothing was delivered while the transport was down');
  h.drain();
  check(withSubject(h, REFUND_REQUESTED).length === 1 && patientMail(h).length === 1,
    'REFUND_REQUEST_PATIENT_EMAIL_COUNT=1 after recovery, and it is the only patient message');
  h.drain();
  check(withSubject(h, REFUND_REQUESTED).length === 1, 'and the worker does not repeat it');
}

// ===========================================================================
// 4. Cancellation on the happy path: authoritative before the message leaves,
//    exactly one patient communication, refund economics untouched.
// ===========================================================================
{
  const h = buildHarness(null);
  const booking = h.paidBooking(34, '2026-09-24', '16:00', 10 * DAY_MS);
  h.setNow(booking.startMs - 5 * DAY_MS);
  const row = h.rowFor(34);
  const snapshots = [];
  h.state.onMail = (mail) => {
    const current = h.rowFor(34);
    snapshots.push({ subject: mail.subject, booking_status: current.booking_status,
      schedule_status: current.schedule_status, refund_status: current.refund_status });
  };
  h.state.mail.length = 0;
  const refundsBefore = h.state.refundCreateCalls;
  const cancelled = h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
  check(cancelled.ok && cancelled.refund === 'requested', 'a ≥24h paid cancellation still requests the full refund');
  check(h.state.refundCreateCalls === refundsBefore + 1
    && h.state.lastRefundPayload.amount === '50000'
    && h.state.lastRefundPayload.commerceTrxId === row.commerce_order,
    'REFUND_CREATE_CALLS=1 at the bound amount on the original transaction — economics unchanged');
  check(withSubject(h, REFUND_REQUESTED).length === 1 && patientMail(h).length === 1,
    'the single refund communication is delivered immediately');
  check(snapshots.length === 1 && snapshots[0].schedule_status === 'cancelled'
    && snapshots[0].refund_status === 'refund_pending',
    'CANCELLATION_STATE_AUTHORITATIVE_BEFORE_EMAIL — persisted provider outcome, not intent');
  check(withSubject(h, CANCELLED).length === 0,
    'no neutral cancellation email accompanies a refundable cancellation');

  // Later provider confirmation adds nothing, immediately or on any tick.
  h.state.refundStatusOverride = 'refunded';
  h.context.refundConfirmation_({ parameter: { token: h.rowFor(34).refund_provider_reference } });
  h.state.refundStatusOverride = 'accepted';
  h.drain();
  check(h.rowFor(34).refund_status === 'refunded' && h.rowFor(34).booking_status === 'cancelled'
    && patientMail(h).length === 1
    && outboxFor(h, row.reservation_id).filter((r) => r.event_type === 'REFUND_REQUESTED').length === 1,
    'LATER_REFUNDED_ADDITIONAL_PATIENT_EMAIL_COUNT=0');
}

// ===========================================================================
// 5. Synchronous provider rejection: zero refund-related patient email, on the
//    immediate path as much as on the worker path.
// ===========================================================================
{
  const h = buildHarness(null);
  const booking = h.paidBooking(35, '2026-09-24', '17:00', 10 * DAY_MS);
  h.setNow(booking.startMs - 5 * DAY_MS);
  h.state.mail.length = 0;
  h.state.refundCreateShouldFail = true;
  const cancelled = h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
  h.state.refundCreateShouldFail = false;
  const row = h.rowFor(35);
  check(cancelled.ok && row.schedule_status === 'cancelled'
    && (row.refund_status === 'manual_review' || row.refund_status === 'refund_failed'),
    'a rejected refund/create still cancels and releases the slot');
  check(patientMail(h).length === 0,
    'SYNC_REFUND_REJECTION_PATIENT_EMAIL_COUNT=0 on the immediate path');
  check(withSubject(h, INTERNAL).length === 1 && h.state.mail.every((item) => item.to === OPS_EMAIL),
    'only the internal manual-review alert is delivered, and it goes to operations');
  h.drain();
  check(patientMail(h).length === 0 && withSubject(h, INTERNAL).length === 1,
    'and the worker adds no patient message and no second alert');
  check(outboxFor(h, row.reservation_id).filter((r) => ['REFUND_REQUESTED', 'SESSION_CANCELLED',
    'PATIENT_CANCELLED', 'CLINICIAN_CANCELLED'].includes(r.event_type)).length === 0,
    'no patient notification of any type is queued for a rejected refund');
}

// ===========================================================================
// 6. Non-refundable cancellation inside the cutoff: one silent cancellation
//    email, still no Flow refund call.
// ===========================================================================
{
  const h = buildHarness(null);
  const booking = h.paidBooking(36, '2026-09-24', '18:00', 10 * DAY_MS);
  h.setNow(booking.startMs - 6 * 60 * 60 * 1000);
  h.state.mail.length = 0;
  const refundsBefore = h.state.refundCreateCalls;
  const cancelled = h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
  check(cancelled.ok && cancelled.refund === 'not_required'
    && h.state.refundCreateCalls === refundsBefore,
    'LT24_REFUND_CREATE_COUNT=0 — the cutoff decision is unchanged');
  check(withSubject(h, CANCELLED).length === 1 && patientMail(h).length === 1,
    'exactly one silent cancellation email, delivered immediately');
  h.drain();
  check(patientMail(h).length === 1, 'and the worker does not repeat it');
}

// ===========================================================================
// Adversarial mutations. Each breaks one guard the design leans on; the suite
// must notice.
// ===========================================================================
function mutation(name, patches, scenario) {
  // The harness refuses a patch whose anchor has moved. That refusal must never
  // be mistaken for detection, or a stale mutation would silently prove nothing.
  const harness = buildHarness(patches);
  let caught = null;
  try { scenario(harness); } catch (error) { caught = error; }
  assert.ok(caught, 'MUTATION NOT DETECTED: ' + name);
  detected.push(name);
  assertions += 1;
}

// A. The terminal-state guard in persistDurableOutbox_ is what stops a second
//    executor with a stale view from re-delivering a row that is already sent.
mutation('MUTATION_TERMINAL_PERSIST_GUARD_REMOVED', {
  'Code.js': [[
    "if (current && (current.state === 'superseded' || current.state === 'sent')) {",
    "if (current && current.state === 'superseded') {",
  ]],
}, (h) => {
  h.context.IMMEDIATE_NOTIFICATION_DISPATCH_ENABLED = false;
  confirmBooking(h, 37, '2026-09-24', '11:00', 10 * DAY_MS);
  h.context.IMMEDIATE_NOTIFICATION_DISPATCH_ENABLED = true;
  const pending = outboxFor(h, h.rowFor(37).reservation_id)[0];
  // Both views are captured while the row is still pending — that is what makes
  // them concurrent rather than sequential.
  const viewA = Object.assign({}, pending);
  const viewB = Object.assign({}, pending);
  const outboxStore = () => h.worker.sheetNotificationOutboxStore_(
    h.sheet.getParent().getSheetByName('notification_outbox'));
  h.worker.dispatchLifecycleNotificationImmediateBestEffort_(h.sheet, h.schema(), outboxStore(), viewA);
  h.worker.dispatchLifecycleNotificationImmediateBestEffort_(h.sheet, h.schema(), outboxStore(), viewB);
  assert.equal(h.state.mail.length, 1, 'concurrent stale dispatch must not duplicate');
});

// B. A failed immediate attempt must stay ordinary retryable work. Marking it
//    terminal would make the accelerator a way to LOSE messages.
mutation('MUTATION_FAILED_IMMEDIATE_ATTEMPT_MARKED_TERMINAL', {
  'Code.js': [[
    "last_result: atMax ? 'max_attempts' : 'failed',",
    "last_result: 'max_attempts',",
  ]],
}, (h) => {
  h.state.mailShouldFail = true;
  confirmBooking(h, 38, '2026-09-24', '11:00', 10 * DAY_MS);
  h.state.mailShouldFail = false;
  h.drain();
  assert.equal(withSubject(h, CONFIRMED).length, 1, 'the worker must recover a failed immediate attempt');
});

// C. The whole point of "best effort": a send that fails must never fail the
//    mutation that produced it.
mutation('MUTATION_LIFECYCLE_COUPLED_TO_IMMEDIATE_SEND', {
  'Code.js': [[
    '  dispatchLifecycleNotificationImmediateBestEffort_(sheet, schema, store, appended);',
    "  const immediate = dispatchLifecycleNotificationImmediateBestEffort_(sheet, schema, store, appended);\n"
    + "  if (!immediate || !immediate.ok) fail_('NOTIFICATION_RETRY_REQUIRED');",
  ]],
}, (h) => {
  h.state.mailShouldFail = true;
  const { confirmed } = confirmBooking(h, 39, '2026-09-24', '11:00', 10 * DAY_MS);
  h.state.mailShouldFail = false;
  assert.equal(confirmed.status, 'payment_confirmed', 'payment confirmation must not depend on the send');
  assert.equal(h.rowFor(39).booking_status, 'confirmed', 'the booking must be confirmed regardless');
});

console.log(`IMMEDIATE_DISPATCH_TESTS=PASS assertions=${assertions}`);
detected.forEach((name) => console.log(`${name}=DETECTED`));
console.log('IMMEDIATE_SUCCESS_EMAIL_COUNT=1');
console.log('CONCURRENT_DISPATCH_EMAIL_COUNT=1');
console.log('REPLAY_EMAIL_COUNT=0');
console.log('FALLBACK_WORKER_EMAIL_COUNT=1');
console.log('SYNC_REFUND_REJECTION_PATIENT_EMAIL_COUNT=0');
console.log('LATER_REFUNDED_ADDITIONAL_PATIENT_EMAIL_COUNT=0');
console.log('LT24_REFUND_CREATE_COUNT=0');
console.log('PRODUCTION_EMAILS_SENT=0');
console.log('REAL_FLOW_CALLS=0');
console.log('REAL_NETWORK_SIDE_EFFECTS=0');

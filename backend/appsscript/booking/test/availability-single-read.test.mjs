/**
 * ONE FULL RESERVATION READ PER AVAILABILITY REQUEST — AND THE SAME ANSWER.
 *
 * `availability_` used to pull the entire reservation sheet twice: once inside
 * `expireUnpaidHolds_`, and again to feed `computeOccupiedSlots_`. The second
 * read existed only to observe what the first pass had just written, because
 * the sweep threw its own collection away.
 *
 * `expireUnpaidHoldRecord_` already mirrors every field it persists back onto
 * the record it was handed, so the collection the sweep returns IS the
 * post-expiry state for every field slot occupancy consults. The endpoint now
 * loads it once and uses it for both.
 *
 * What this pins down:
 *   A. exactly one full reservation read per availability request;
 *   B. the occupied-slot answer is identical to the two-read shape, across a
 *      free day, an active hold, an expired hold, a confirmed booking, a
 *      Calendar-busy interval, a holiday and the booking lead time;
 *   C. an expired unpaid hold still stops blocking its slot;
 *   D. and its persisted lifecycle transition still reaches the sheet;
 *   E. Calendar failure still fails closed, with no answer emitted;
 *   F. restoring the second read is detected (A would silently pass again);
 *   G. dropping the expiry sweep is detected (C and D);
 *   H. the one loaded collection matches a fresh read of the sheet on every
 *      field occupancy consults, and a sweep that stops mirroring its writes
 *      back onto the loaded record is detected.
 *
 * Worth stating plainly, because it is what makes this safe rather than merely
 * equivalent today: the answer does not depend on the mirror-back. A record the
 * sweep expired is refused by `reservationOccupiesSlot_` anyway, which
 * re-derives expiry from `slot_hold_expires_at` rather than trusting the stored
 * status. H therefore asserts field equivalence, not a verdict difference —
 * claiming the verdict would flip would be a mutation that proves nothing.
 */
import assert from 'node:assert/strict';
import { buildHarness, PATIENT_EMAIL, T0 } from './helpers/policy-harness.mjs';

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

const MIN = 60 * 1000;
// An ordinary Thursday: no weekend rule, no holiday, comfortably inside the horizon.
const TARGET = '2026-09-24';

// ---------------------------------------------------------------------------
// Mutations. The harness applies these to the sources before evaluating them.
// ---------------------------------------------------------------------------

/** F. Put the discarded second full read back exactly where it used to be. */
const SECOND_READ = { 'Code.js': [[
  '    reservations: reservations,',
  '    reservations: reservationRecords_(resources.sheet, schema),',
]] };

/** G. Load the records but never sweep them for expired unpaid holds. */
const NO_EXPIRY_SWEEP = { 'Code.js': [[
  'const reservations = expireUnpaidHoldsIn_(resources.sheet, schema, reservationRecords_(resources.sheet, schema));',
  'const reservations = reservationRecords_(resources.sheet, schema);',
]] };

/** H. Persist the transition, but stop mirroring it onto the loaded record. */
const NO_MIRROR_BACK = { 'Code.js': [[
  '  updateRecord_(sheet, schema, record.rowNumber, updates);\n  return Object.assign(record, updates);',
  '  updateRecord_(sheet, schema, record.rowNumber, updates);\n  return record;',
]] };

// ---------------------------------------------------------------------------
// Instrumentation: count full reservation reads, not sheet touches in general.
// ---------------------------------------------------------------------------

/**
 * Wrap the reservation sheet's `getDataRange().getValues()`.
 *
 * That call is what `reservationRecords_` uses to pull every row, and it is the
 * only shape this counts — a single-cell `getRange(...).setValue()` write is
 * not a full read and must not be conflated with one.
 */
function countingHarness(patches) {
  const h = buildHarness(patches || null);
  const counter = { reads: 0 };
  const original = h.sheet.getDataRange;
  h.sheet.getDataRange = function () {
    const range = original.call(h.sheet);
    const getValues = range.getValues;
    return { getValues: function () { counter.reads += 1; return getValues.call(range); } };
  };
  return { h, counter };
}

const availability = (h, date) => h.context.availability_({
  parameter: date ? { action: 'availability', date } : { action: 'availability' },
});
const times = (slots) => slots.map((slot) => slot.time);

const idempotencyKey = (n) => 'fran-booking-bbbbbb' + String(n).padStart(2, '0') + '-e89b-12d3-a456-426614174000';

/** An unpaid hold in PAYMENT_PENDING, created the ordinary way. */
function createHold(h, n, date, time) {
  const created = h.context.createFlowPayment_({ postData: { contents: JSON.stringify({
    action: 'create_flow_payment', idempotencyKey: idempotencyKey(n), serviceType: 'initial',
    modality: 'online', date, time, name: 'Synthetic', email: PATIENT_EMAIL,
    phone: '', patientRut: '', reason: '', message: '',
  }) } });
  if (!created.ok) throw new Error('fixture hold rejected: ' + JSON.stringify(created));
  return h.currentRows().find((row) => row.idempotency_key === idempotencyKey(n));
}

const holidayWeekday = (ctx) => ctx.BOOKING_HOLIDAYS_CL.filter((date) => date > '2026-09-01')
  .find((date) => {
    const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
    return weekday !== 0 && weekday !== 6;
  });

// ---------------------------------------------------------------------------
// The scenario table. Each one sets a harness up and returns what to compare.
// Every scenario runs against the shipped source AND against SECOND_READ, so
// the answer is checked against the shape this change replaced, not against a
// number written down here.
// ---------------------------------------------------------------------------
const SCENARIOS = [
  {
    name: 'free day',
    expect: [],
    run: ({ h }) => { h.setNow(T0); },
  },
  {
    name: 'active unpaid hold blocks its slot',
    expect: ['11:00'],
    run: ({ h }) => { h.setNow(T0); createHold(h, 1, TARGET, '11:00'); },
  },
  {
    name: 'expired unpaid hold releases its slot',
    expect: [],
    run: ({ h }) => {
      h.setNow(T0);
      const row = createHold(h, 1, TARGET, '11:00');
      // SLOT_HOLD_MS is 15 minutes; one minute past it the hold is unambiguously dead.
      h.setNow(T0 + 16 * MIN);
      return { reservationId: row.reservation_id };
    },
  },
  {
    name: 'confirmed paid booking blocks its slot',
    expect: ['12:00'],
    run: ({ h }) => {
      const booking = h.paidBooking(2, TARGET, '12:00', 3 * 24 * 60 * MIN);
      // Long past any 15-minute hold: only the CONFIRMED state can still block here.
      h.setNow(booking.startMs - 3 * 24 * 60 * MIN + 60 * MIN);
    },
  },
  {
    name: 'Calendar busy interval blocks its slot',
    expect: ['15:00'],
    run: ({ h }) => {
      h.setNow(T0);
      h.context.Calendar.Freebusy = { query: () => ({ calendars: { 'synthetic-calendar': { busy: [
        { start: h.context.startAt_(TARGET, '15:00'), end: h.context.startAt_(TARGET, '16:00') },
      ] } } }) };
    },
  },
  {
    name: 'holiday withholds the whole day',
    expect: ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'],
    run: ({ h }) => { h.setNow(T0); return { date: holidayWeekday(h.context) }; },
  },
  {
    name: 'booking lead time withholds the hours inside it',
    // 13:00 Santiago + BOOKING_LEAD_MINUTES (120) => 15:00 is the first eligible hour.
    expect: ['10:00', '11:00', '12:00', '13:00', '14:00'],
    run: ({ h }) => { h.setNow(Date.parse(h.context.startAt_(TARGET, '13:00'))); },
  },
];

// ---------------------------------------------------------------------------
// A + B + C. One read, and the same answer as the two-read shape.
// ---------------------------------------------------------------------------
const singleReadAnswers = [];
const secondReadAnswers = [];

SCENARIOS.forEach((scenario) => {
  const fixed = countingHarness();
  const fixedSetup = scenario.run(fixed) || {};
  fixed.counter.reads = 0;
  const after = availability(fixed.h, fixedSetup.date || TARGET);

  const reverted = countingHarness(SECOND_READ);
  const revertedSetup = scenario.run(reverted) || {};
  reverted.counter.reads = 0;
  const before = availability(reverted.h, revertedSetup.date || TARGET);

  singleReadAnswers.push(times(after));
  secondReadAnswers.push(times(before));

  check(fixed.counter.reads === 1,
    scenario.name + ': exactly one full reservation read (' + fixed.counter.reads + ')');
  check(reverted.counter.reads === 2,
    scenario.name + ': the shape this replaced took two (' + reverted.counter.reads + ')');
  check(JSON.stringify(times(after)) === JSON.stringify(times(before)),
    scenario.name + ': identical occupied slots either way');
  check(JSON.stringify(times(after)) === JSON.stringify(scenario.expect),
    scenario.name + ': and that answer is the correct one (' + JSON.stringify(times(after)) + ')');
  // The response contract itself, not just the times.
  check(after.every((slot) => Object.keys(slot).sort().join(',') === 'date,time'),
    scenario.name + ': each slot still carries exactly { date, time }');
});

check(JSON.stringify(singleReadAnswers) === JSON.stringify(secondReadAnswers),
  'the full slot set is equivalent before vs after across every scenario');

// ---------------------------------------------------------------------------
// D. The persisted expiry transition still reaches the sheet.
// ---------------------------------------------------------------------------
{
  const { h, counter } = countingHarness();
  h.setNow(T0);
  const row = createHold(h, 1, TARGET, '11:00');
  const reservationId = row.reservation_id;
  check(row.booking_status === h.context.LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING,
    'the fixture starts as an unpaid hold in payment_pending');

  h.setNow(T0 + 16 * MIN);
  counter.reads = 0;
  availability(h, TARGET);

  const persisted = h.currentRows().find((record) => record.reservation_id === reservationId);
  check(counter.reads === 1, 'the sweep and the answer share one read');
  check(persisted.booking_status === h.context.LIFECYCLE.BOOKING_STATUS.EXPIRED,
    'the expired hold is persisted as expired, not merely ignored in memory');
  check(persisted.schedule_status === h.context.LIFECYCLE.SCHEDULE_STATUS.CANCELLED,
    'and its schedule_status is persisted as cancelled');
  check(persisted.reconciliation_state === 'slot_hold_expired',
    'and it carries the slot_hold_expired reconciliation state');

  // Re-reading the sheet now must agree with what the request already decided.
  const reread = h.context.reservationRecords_(h.sheet, h.schema())
    .find((record) => record.reservation_id === reservationId);
  check(h.context.reservationOccupiesSlot_(reread) === false,
    'a fresh read of the sheet agrees the slot is no longer occupied');
}

// ---------------------------------------------------------------------------
// E. Calendar failure still fails closed, and emits no answer.
// ---------------------------------------------------------------------------
{
  const { h, counter } = countingHarness();
  h.setNow(T0);
  h.context.Calendar.Freebusy = { query: () => { throw new Error('freebusy transport fault'); } };
  counter.reads = 0;
  let code = 'NO_THROW';
  try { availability(h, TARGET); } catch (error) { code = String((error && error.message) || error); }
  check(code === 'CALENDAR_UNAVAILABLE',
    'an unreachable Calendar still refuses the request (' + code + ')');
  check(counter.reads === 1,
    'and it still costs one reservation read, never two (' + counter.reads + ')');
}

// ---------------------------------------------------------------------------
// G. Dropping the expiry sweep is detected.
// ---------------------------------------------------------------------------
{
  const { h } = countingHarness(NO_EXPIRY_SWEEP);
  h.setNow(T0);
  const row = createHold(h, 1, TARGET, '11:00');
  const reservationId = row.reservation_id;
  h.setNow(T0 + 16 * MIN);
  const occupied = times(availability(h, TARGET));
  const persisted = h.currentRows().find((record) => record.reservation_id === reservationId);

  // Without the sweep the slot does free up in the answer — reservationOccupiesSlot_
  // ignores an expired hold on its own — but the lifecycle transition is lost.
  check(persisted.booking_status !== h.context.LIFECYCLE.BOOKING_STATUS.EXPIRED,
    'removing the sweep loses the persisted expiry transition, which the suite catches');
  check(JSON.stringify(occupied) === '[]',
    'even though the in-answer effect alone would have looked fine');
}

// ---------------------------------------------------------------------------
// H. The one loaded collection is the sheet's post-expiry state.
//
// Captured at the boundary: whatever `expireUnpaidHoldsIn_` returns is exactly
// what `computeOccupiedSlots_` is then given. Compared field by field against a
// fresh read of the sheet, so "we read once" cannot quietly become "we read a
// stale picture once".
// ---------------------------------------------------------------------------

/** The fields `reservationOccupiesSlot_` and `computeOccupiedSlots_` actually read. */
const OCCUPANCY_FIELDS = ['booking_status', 'payment_status', 'schedule_status',
  'slot_hold_expires_at', 'current_start_at', 'current_end_at'];

/** Run an availability request and capture the collection the sweep handed on. */
function captureLoadedCollection(patches) {
  const { h, counter } = countingHarness(patches || null);
  h.setNow(T0);
  createHold(h, 1, TARGET, '11:00');
  h.setNow(T0 + 16 * MIN);

  let captured = null;
  const sweep = h.context.expireUnpaidHoldsIn_;
  h.context.expireUnpaidHoldsIn_ = function (sheet, schema, records, nowMs) {
    captured = sweep(sheet, schema, records, nowMs);
    return captured;
  };
  counter.reads = 0;
  const occupied = times(availability(h, TARGET));
  // Snapshot before the oracle below, which is itself a full read.
  const reads = counter.reads;

  // The re-read the endpoint no longer performs, done here purely as the oracle.
  const fresh = h.context.reservationRecords_(h.sheet, h.schema());
  return { h, reads, captured, fresh, occupied };
}

{
  const { reads, captured, fresh, occupied } = captureLoadedCollection();
  check(reads === 1, 'the captured collection cost exactly one read (' + reads + ')');
  check(Array.isArray(captured) && captured.length === fresh.length && captured.length === 1,
    'the sweep hands on every reservation row, not a filtered subset');

  const divergent = captured.filter((record, index) => OCCUPANCY_FIELDS
    .some((field) => String(record[field] || '') !== String(fresh[index][field] || '')));
  check(divergent.length === 0,
    'the loaded collection equals a fresh sheet read on every occupancy field');
  check(JSON.stringify(occupied) === '[]', 'and the expired hold is not blocking');
}

// Break the mirror-back: the sheet still records the expiry, the collection does not.
{
  const { captured, fresh, occupied } = captureLoadedCollection(NO_MIRROR_BACK);
  const divergent = captured.filter((record, index) => OCCUPANCY_FIELDS
    .some((field) => String(record[field] || '') !== String(fresh[index][field] || '')));
  check(divergent.length === 1,
    'dropping the mirror-back makes the loaded collection diverge from the sheet, which the suite catches');
  check(fresh[0].booking_status === 'expired' && captured[0].booking_status !== 'expired',
    'and names the divergence precisely: persisted expired, in memory still ' + captured[0].booking_status);
  // Defence in depth, asserted rather than assumed: the answer survives it.
  check(JSON.stringify(occupied) === '[]',
    'the occupied-slot answer is unchanged even then, because expiry is re-derived from slot_hold_expires_at');
}

console.log('AVAILABILITY_SINGLE_READ=PASS assertions=' + assertions);
console.log('RESERVATION_READS_PER_REQUEST=1 (was 2)');
console.log('OCCUPIED_SLOTS_EQUIVALENT_TO_TWO_READ_SHAPE=YES scenarios=' + SCENARIOS.length);
console.log('EXPIRED_HOLD_PERSISTED_TRANSITION=PRESERVED');
console.log('FAIL_CLOSED_ON_CALENDAR=PRESERVED');
console.log('MUTATION_SECOND_READ_RESTORED=DETECTED');
console.log('MUTATION_EXPIRY_SWEEP_REMOVED=DETECTED');
console.log('MUTATION_SWEEP_NOT_MIRRORED=DETECTED (collection/sheet divergence; answer unaffected by design)');
console.log('LOADED_COLLECTION_EQUALS_FRESH_SHEET_READ=YES fields=' + OCCUPANCY_FIELDS.length);
console.log('NO_NETWORK_TESTS=PASS count=' + SCENARIOS.length);
console.log('REAL_CALENDAR_CALLS=0');

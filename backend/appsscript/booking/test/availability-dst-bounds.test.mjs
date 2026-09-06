/**
 * AVAILABILITY WINDOW BOUNDS ACROSS A DST TRANSITION.
 *
 * A spring-forward transition deletes an interval of local time. Chile moves at
 * 24:00 on a Saturday, so on that Sunday the local day starts at 01:00 and
 * 00:00 never exists. `startAt_` refuses a time that does not exist, which is
 * right for a booking and fatal for a window boundary.
 *
 * On 2026-09-06 that took the whole availability endpoint down: every request
 * whose window began that day threw REQUEST_REJECTED, the browser's date-less
 * read failed, and the picker — which swallowed the failure — offered every
 * hour of every day as free. A patient selecting one got SLOT_TAKEN at submit.
 *
 * The transitions are discovered from the runtime's own timezone data rather
 * than hardcoded, so this keeps testing the real thing after 2026.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildHarness, findTransition, santiagoOffsetMinutes } from './helpers/policy-harness.mjs';

// The advisory copy the booking page ships, read from the page itself.
const bookingSource = await readFile(new URL('../../../../assets/booking.js', import.meta.url), 'utf8');
const clientHolidayList = (bookingSource.match(/holidays: \[([\s\S]*?)\]/) || [null, ''])[1]
  .match(/\d{4}-\d{2}-\d{2}/g) || [];

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

const h = buildHarness(null);
const ctx = h.context;
const DAY_MS = 24 * 60 * 60 * 1000;
const label = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

// ---------------------------------------------------------------------------
// Find every Santiago transition over several years and classify it.
// ---------------------------------------------------------------------------
const transitions = [];
for (let year = 2026; year <= 2030; year += 1) {
  for (const [fromIso, toIso] of [[year + '-03-01', year + '-05-01'], [year + '-08-01', year + '-10-01']]) {
    const at = findTransition(Date.parse(fromIso + 'T00:00:00Z'), Date.parse(toIso + 'T00:00:00Z'));
    if (at === null) continue;
    const before = santiagoOffsetMinutes(at - 60000);
    const after = santiagoOffsetMinutes(at + 60000);
    transitions.push({ at, date: label(at), springForward: after > before });
  }
}
check(transitions.length >= 8, 'the runtime knows about several Santiago transitions');
const springForward = transitions.filter((t) => t.springForward);
const fallBack = transitions.filter((t) => !t.springForward);
check(springForward.length >= 4, 'including spring-forward days, where local time is deleted');
check(fallBack.length >= 4, 'and fall-back days, where local time repeats');

// The defect's own date must be among them, so this suite provably covers it.
check(springForward.some((t) => t.date === '2026-09-06'),
  'the 2026-09-06 transition that broke Production is one of the discovered cases');

// ---------------------------------------------------------------------------
// The gap is real: local midnight does not exist on a spring-forward day, and
// startAt_ must keep refusing it. That refusal is correct and stays.
// ---------------------------------------------------------------------------
let refusedMidnights = 0;
springForward.forEach((t) => {
  let threw = null;
  try { ctx.startAt_(t.date, '00:00'); } catch (error) { threw = error && error.code; }
  if (threw === 'REQUEST_REJECTED') refusedMidnights += 1;
});
check(refusedMidnights >= 1,
  'at least one spring-forward day has no local midnight, and startAt_ still refuses to invent one');

// ---------------------------------------------------------------------------
// The window must still open on every one of those days.
// ---------------------------------------------------------------------------
transitions.forEach((t) => {
  let bounds = null;
  try { bounds = ctx.availabilityBounds_(t.date); }
  catch (error) { bounds = { threw: error && error.code }; }
  check(bounds && !bounds.threw, 'availabilityBounds_ opens a window on ' + t.date);
  check(bounds && typeof bounds.start === 'string' && !Number.isNaN(Date.parse(bounds.start)),
    'the window start on ' + t.date + ' is a real instant');
  // The start must belong to the requested day in Santiago, never the day before.
  check(label(Date.parse(bounds.start)) === t.date,
    'the window on ' + t.date + ' starts on that day, not the previous one');
  check(Date.parse(bounds.end) > Date.parse(bounds.start), 'and ends after it');
});

// The ordinary day is unchanged: still exactly local midnight.
['2026-09-07', '2026-10-15', '2026-11-30'].forEach((date) => {
  const bounds = ctx.availabilityBounds_(date);
  check(bounds.start === ctx.startAt_(date, '00:00'),
    'an ordinary day still anchors at local midnight (' + date + ')');
});

// The date-less form is what the browser calls, and it anchors on today.
// It must not depend on today having a midnight.
const dstNoonMs = Date.parse('2026-09-06T16:00:00.000Z');
h.setNow(dstNoonMs);
let datelessBounds = null;
try { datelessBounds = ctx.availabilityBounds_(''); }
catch (error) { datelessBounds = { threw: error && error.code }; }
check(datelessBounds && !datelessBounds.threw,
  'the date-less window opens even when today is a spring-forward day');
check(label(Date.parse(datelessBounds.start)) === '2026-09-06',
  'and it starts today, not tomorrow');

// ---------------------------------------------------------------------------
// End to end through the endpoint the Worker actually calls.
// ---------------------------------------------------------------------------
const callAvailability = (parameter) => {
  try { return { ok: true, slots: ctx.availability_({ parameter }) }; }
  catch (error) { return { ok: false, code: error && error.code }; }
};
h.setNow(dstNoonMs);
const datelessCall = callAvailability({ action: 'availability' });
check(datelessCall.ok === true, 'the date-less availability call succeeds on a spring-forward day');
const datedCall = callAvailability({ action: 'availability', date: '2026-09-06' });
check(datedCall.ok === true, 'and so does the dated call for that day');
const nextDay = callAvailability({ action: 'availability', date: '2026-09-07' });
check(nextDay.ok === true, 'the day after is unaffected');

// A malformed date is still refused: this fix widens nothing.
const malformed = callAvailability({ action: 'availability', date: '06-09-2026' });
check(malformed.ok === false && malformed.code === 'REQUEST_REJECTED',
  'a malformed date is still refused');

// ---------------------------------------------------------------------------
// Lead time, Calendar busy and reservation busy are untouched by this change.
// ---------------------------------------------------------------------------
const occupied = ctx.computeOccupiedSlots_;
const slot = { date: '2026-10-15', time: '11:00',
  start: ctx.startAt_('2026-10-15', '11:00'), end: ctx.slotIntervalEndAt_(ctx.startAt_('2026-10-15', '11:00')) };
check(occupied({ workingSlots: [slot], busyIntervals: [], reservations: [] }).length === 0,
  'a free slot with nothing against it stays free');
check(occupied({ workingSlots: [slot], busyIntervals: [{ start: slot.start, end: slot.end }], reservations: [] }).length === 1,
  'a Calendar-busy slot is withheld');
check(occupied({ workingSlots: [slot], busyIntervals: [], reservations: [
  { booking_status: 'confirmed', payment_status: 'paid', schedule_status: 'scheduled',
    current_start_at: slot.start, current_end_at: slot.end } ] }).length === 1,
  'a reservation-busy slot is withheld');
check(occupied({ workingSlots: [slot], busyIntervals: [], reservations: [],
  leadCutoffMs: Date.parse(slot.start) + 1 }).length === 1,
  'a slot inside the lead time is withheld');
check(occupied({ workingSlots: [slot], busyIntervals: [], reservations: [],
  leadCutoffMs: Date.parse(slot.start) }).length === 0,
  'and a slot exactly at the lead boundary is offered');

// Back-to-back sessions: the session is 50 minutes inside a 60-minute slot, so
// an 11:00 booking must not withhold 12:00.
const nextSlotStart = ctx.startAt_('2026-10-15', '12:00');
const back = occupied({
  workingSlots: [{ date: '2026-10-15', time: '12:00', start: nextSlotStart, end: ctx.slotIntervalEndAt_(nextSlotStart) }],
  busyIntervals: [], reservations: [{ booking_status: 'confirmed', payment_status: 'paid', schedule_status: 'scheduled',
    current_start_at: slot.start, current_end_at: ctx.sessionEndAt_(slot.start) }] });
check(back.length === 0, 'an 11:00 session does not withhold the 12:00 slot');

// ---------------------------------------------------------------------------
// Holidays are the server's decision, not the browser's.
//
// The list used to live only in assets/booking.js and manage.html, so the
// picker hid 18 September while the server would happily have booked it. The
// browser deciding policy is the thing this repository does not do.
// ---------------------------------------------------------------------------
const HOLIDAY = '2026-09-18';          // Independencia, a Friday
const WORKDAY = '2026-09-16';          // ordinary Wednesday, same week
check(ctx.isBookingHoliday_(HOLIDAY) === true, 'the server knows 18 September is a holiday');
check(ctx.isBookingHoliday_(WORKDAY) === false, 'and that the Wednesday before is not');
check(ctx.isBookingHoliday_('') === false && ctx.isBookingHoliday_(null) === false,
  'an empty date is not a holiday');

h.setNow(Date.parse('2026-09-07T13:00:00.000Z'));
const holidayCall = callAvailability({ action: 'availability', date: HOLIDAY });
check(holidayCall.ok === true, 'availability answers for a holiday');
check(holidayCall.slots.length === ctx.WORKING_HOURS.length,
  'and reports every working hour of it as occupied, so no client needs its own list');
const workdayCall = callAvailability({ action: 'availability', date: WORKDAY });
check(workdayCall.ok === true && workdayCall.slots.length === 0,
  'while the ordinary Wednesday has none occupied');

// A caller that ignores the picker must still be refused.
let holidayBooking = null;
try { ctx.assertBookableSlot_(HOLIDAY, '11:00', Date.parse('2026-09-07T13:00:00.000Z')); }
catch (error) { holidayBooking = error && error.code; }
check(holidayBooking === 'REQUEST_REJECTED',
  'booking a holiday directly is refused, not merely hidden');
check(typeof ctx.assertBookableSlot_(WORKDAY, '11:00', Date.parse('2026-09-07T13:00:00.000Z')) === 'string',
  'and the ordinary Wednesday is still bookable');

// Weekends were already refused; holidays now behave the same way.
let weekend = null;
try { ctx.assertBookableSlot_('2026-09-12', '11:00', Date.parse('2026-09-07T13:00:00.000Z')); }
catch (error) { weekend = error && error.code; }
check(weekend === 'REQUEST_REJECTED', 'a Saturday is still refused');

// The client lists must not drift from the server's. They are advisory copies.
const clientList = clientHolidayList;
check(clientList.length > 0, 'the booking page carries a holiday list for dimming');
check(clientList.every((date) => ctx.BOOKING_HOLIDAYS_CL.indexOf(date) !== -1),
  'and every date in it is one the server also refuses');
check(ctx.BOOKING_HOLIDAYS_CL.every((date) => clientList.indexOf(date) !== -1),
  'with nothing the server refuses that the page would still offer');

console.log('AVAILABILITY_DST_BOUNDS=PASS assertions=' + assertions);
console.log('TRANSITIONS_DISCOVERED=' + transitions.length + ' spring_forward=' + springForward.length);
console.log('DST_GAP_STILL_REFUSED_FOR_BOOKINGS=YES');
console.log('AVAILABILITY_WINDOW_OPENS_ON_EVERY_TRANSITION=YES');
console.log('LEAD_TIME_AND_BUSY_SEMANTICS=UNCHANGED');
console.log('HOLIDAY_AUTHORITY=SERVER');
console.log('CLIENT_HOLIDAY_LIST_MATCHES_SERVER=YES (' + clientHolidayList.length + ' dates)');
console.log('REAL_MONETARY_FLOW_CALLS=0');

/**
 * A DATED AVAILABILITY READ QUERIES ONE DAY OF CALENDAR, NOT NINETY.
 *
 * `availabilityBounds_` anchored the window on the requested date and then
 * extended it by AVAILABILITY_HORIZON_DAYS regardless. `workingSlots_` throws
 * every other day away, so a read of one date pulled ~90 days of Calendar to
 * produce at most nine slots.
 *
 * In Production on 2026-09-18 that dated read measured 3-12s and exceeded 20s
 * on roughly a third of attempts. The picker fails closed on an unanswered
 * date, so 2026-09-24 — a completely free Thursday — showed "No pudimos
 * comprobar los horarios de esta fecha".
 *
 * What this pins down:
 *   A. a dated read bounds the window to that local Chile date, both ends;
 *   B. it is not extended by the horizon;
 *   C. the date-less overview still spans the horizon exactly as before;
 *   D. a busy interval crossing midnight into the requested date is still
 *      detected and its slot still withheld;
 *   E. the America/Santiago DST semantics are unchanged, including the
 *      spring-forward day that has no local midnight;
 *   F. restoring the old unconditional horizon makes A and B fail.
 */
import assert from 'node:assert/strict';
import { buildHarness, findTransition, santiagoOffsetMinutes } from './helpers/policy-harness.mjs';

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

const label = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

// The incident's own date: an ordinary, entirely free Thursday.
const TARGET = '2026-09-24';
// Tuesday 2026-09-01 09:00 Santiago, inside the harness's horizon.
const NOW_MS = Date.parse('2026-09-01T13:00:00.000Z');

/**
 * A harness whose Freebusy records every window it is asked about and answers
 * with the busy intervals a scenario injects, clipped to the window the way
 * Google's freebusy clips them.
 */
function harnessWithRecordedFreebusy(patches) {
  const h = buildHarness(patches || null);
  const calls = [];
  let busy = [];
  h.context.Calendar.Freebusy = {
    query: (request) => {
      calls.push({ timeMin: String(request.timeMin), timeMax: String(request.timeMax) });
      const min = Date.parse(String(request.timeMin));
      const max = Date.parse(String(request.timeMax));
      const clipped = busy
        .filter((interval) => Date.parse(interval.end) > min && Date.parse(interval.start) < max)
        .map((interval) => ({
          start: new Date(Math.max(Date.parse(interval.start), min)).toISOString(),
          end: new Date(Math.min(Date.parse(interval.end), max)).toISOString(),
        }));
      return { calendars: { 'synthetic-calendar': { busy: clipped } } };
    },
  };
  return { h, calls, setBusy: (value) => { busy = value; } };
}

const spanDays = (call) => (Date.parse(call.timeMax) - Date.parse(call.timeMin)) / (24 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// A + B. The dated read asks Calendar about exactly the requested local day.
// ---------------------------------------------------------------------------
{
  const { h, calls } = harnessWithRecordedFreebusy();
  h.setNow(NOW_MS);
  const result = h.context.availability_({ parameter: { action: 'availability', date: TARGET } });

  check(calls.length === 1, 'a dated availability read issues exactly one Freebusy query');
  const call = calls[0];
  check(label(Date.parse(call.timeMin)) === TARGET,
    'timeMin falls on the requested local Chile date');
  check(label(Date.parse(call.timeMax)) === TARGET,
    'and so does timeMax — the window does not spill into another day');
  check(call.timeMin === h.context.startAt_(TARGET, '00:00'),
    'timeMin is the local day start of the requested date');
  check(call.timeMax === h.context.startAt_(TARGET, '23:59'),
    'timeMax is the local day end of the requested date');
  check(spanDays(call) < 1,
    'the dated window is under a day wide (' + spanDays(call).toFixed(4) + 'd)');
  check(spanDays(call) < h.context.AVAILABILITY_HORIZON_DAYS / 2,
    'and nowhere near the horizon it used to use');

  // The bounds helper agrees with what the endpoint actually asked for.
  const bounds = h.context.availabilityBounds_(TARGET);
  check(bounds.start === call.timeMin && bounds.end === call.timeMax,
    'availabilityBounds_ is the single source of that window');

  // The answer itself is unchanged: a free Thursday has nothing occupied.
  check(Array.isArray(result) && result.length === 0,
    'the free Thursday still reports zero occupied slots');
}

// ---------------------------------------------------------------------------
// C. The date-less overview still spans AVAILABILITY_HORIZON_DAYS.
// ---------------------------------------------------------------------------
{
  const { h, calls } = harnessWithRecordedFreebusy();
  h.setNow(NOW_MS);
  h.context.availability_({ parameter: { action: 'availability' } });

  check(calls.length === 1, 'the overview issues one Freebusy query too');
  const horizon = h.context.AVAILABILITY_HORIZON_DAYS;
  const span = spanDays(calls[0]);
  check(span > horizon - 1 && span <= horizon + 1,
    'the overview window is still the ' + horizon + '-day horizon (' + span.toFixed(2) + 'd)');

  // Byte-for-byte the pre-fix bounds for the date-less form.
  const today = h.context.localDateLabel_(new Date(NOW_MS).toISOString());
  const bounds = h.context.availabilityBounds_('');
  check(bounds.start === h.context.localDayStart_(today),
    'the overview still anchors on today');
  check(bounds.end === h.context.startAt_(h.context.addCalendarDays_(today, horizon), '23:59'),
    'and still ends at the horizon, unchanged');
}

// ---------------------------------------------------------------------------
// D. A session running past midnight into the requested date is still caught.
// ---------------------------------------------------------------------------
{
  const { h, calls, setBusy } = harnessWithRecordedFreebusy();
  h.setNow(NOW_MS);
  // 22:00 the previous evening through 10:30 on the requested date: it starts
  // outside the narrowed window and ends inside it, over the 10:00 slot.
  setBusy([{
    start: h.context.startAt_('2026-09-23', '22:00'),
    end: h.context.startAt_(TARGET, '10:30'),
  }]);
  const occupied = h.context.availability_({ parameter: { action: 'availability', date: TARGET } });

  check(spanDays(calls[0]) < 1, 'the window is still the narrow one');
  check(occupied.some((slot) => slot.date === TARGET && slot.time === '10:00'),
    'the 10:00 slot the overnight session covers is still withheld');
  check(!occupied.some((slot) => slot.time === '11:00'),
    'while 11:00, which it does not reach, stays free');

  // The clipped interval really did start at the window edge, so this is the
  // clipping behaviour being exercised and not an interval that fit anyway.
  const clippedStart = Date.parse(h.context.startAt_('2026-09-23', '22:00'));
  check(clippedStart < Date.parse(calls[0].timeMin),
    'and the session genuinely began before the window opened');
}

// ---------------------------------------------------------------------------
// E. DST is unchanged. Every Santiago transition still opens a usable window,
//    and a dated read on one is still one day wide.
// ---------------------------------------------------------------------------
{
  const { h, calls } = harnessWithRecordedFreebusy();
  const transitions = [];
  for (let year = 2026; year <= 2029; year += 1) {
    for (const [fromIso, toIso] of [[year + '-03-01', year + '-05-01'], [year + '-08-01', year + '-10-01']]) {
      const at = findTransition(Date.parse(fromIso + 'T00:00:00Z'), Date.parse(toIso + 'T00:00:00Z'));
      if (at === null) continue;
      const springForward = santiagoOffsetMinutes(at + 60000) > santiagoOffsetMinutes(at - 60000);
      transitions.push({ date: label(at), springForward });
    }
  }
  check(transitions.length >= 6, 'the runtime still knows about the Santiago transitions');
  check(transitions.some((t) => t.springForward && t.date === '2026-09-06'),
    'including the spring-forward day that has no local midnight');

  transitions.forEach((t) => {
    const bounds = h.context.availabilityBounds_(t.date);
    check(label(Date.parse(bounds.start)) === t.date,
      'the window on ' + t.date + ' still starts on that day');
    check(label(Date.parse(bounds.end)) === t.date,
      'and now also ends on it');
    check(Date.parse(bounds.end) > Date.parse(bounds.start),
      'the window on ' + t.date + ' is still non-empty');
    const hours = (Date.parse(bounds.end) - Date.parse(bounds.start)) / (60 * 60 * 1000);
    // 23h on spring-forward, 25h on fall-back, 24h otherwise — never 90 days.
    check(hours > 22 && hours < 26,
      'and is one real local day on ' + t.date + ' (' + hours.toFixed(2) + 'h), DST length included');
  });

  // The endpoint still answers on the day local midnight does not exist.
  calls.length = 0;
  h.setNow(Date.parse('2026-09-06T16:00:00.000Z'));
  let threw = null;
  try { h.context.availability_({ parameter: { action: 'availability', date: '2026-09-06' } }); }
  catch (error) { threw = error && error.code; }
  check(threw === null, 'a dated read on the spring-forward day still succeeds');
  check(calls.length === 1 && spanDays(calls[0]) < 1.1,
    'and it too is bounded to that single day');

  // A malformed date is still refused: this narrowing widens nothing.
  let malformed = null;
  try { h.context.availability_({ parameter: { action: 'availability', date: '24-09-2026' } }); }
  catch (error) { malformed = error && error.code; }
  check(malformed === 'REQUEST_REJECTED', 'a malformed date is still refused');
}

// ---------------------------------------------------------------------------
// F. Adversarial mutation: restore the unconditional horizon and the dated
//    contract above must break. A test that passes either way proves nothing.
// ---------------------------------------------------------------------------
{
  const reverted = harnessWithRecordedFreebusy({
    'CalendarGateway.js': [[
      "const endDate = requestedDate ? startDate : addCalendarDays_(startDate, AVAILABILITY_HORIZON_DAYS);",
      "const endDate = addCalendarDays_(startDate, AVAILABILITY_HORIZON_DAYS);",
    ]],
  });
  reverted.h.setNow(NOW_MS);
  reverted.h.context.availability_({ parameter: { action: 'availability', date: TARGET } });

  check(reverted.calls.length === 1, 'the reverted build still issues one query');
  const span = spanDays(reverted.calls[0]);
  check(span > reverted.h.context.AVAILABILITY_HORIZON_DAYS - 1,
    'and the old behaviour really is ~90 days wide (' + span.toFixed(2) + 'd), so the fix is load-bearing');
  check(label(Date.parse(reverted.calls[0].timeMax)) !== TARGET,
    'its timeMax lands on a different date, which is exactly what assertion A forbids');

  // The dated slot set is identical either way: this change is a narrowing of
  // the query, never of the answer.
  const fixed = harnessWithRecordedFreebusy();
  fixed.h.setNow(NOW_MS);
  const busy = [{ start: fixed.h.context.startAt_(TARGET, '14:00'), end: fixed.h.context.startAt_(TARGET, '15:00') }];
  fixed.setBusy(busy);
  reverted.setBusy(busy);
  const after = fixed.h.context.availability_({ parameter: { action: 'availability', date: TARGET } });
  const before = reverted.h.context.availability_({ parameter: { action: 'availability', date: TARGET } });
  check(JSON.stringify(after) === JSON.stringify(before),
    'narrowing the window returns the same occupied slots as the 90-day query');
  check(after.length === 1 && after[0].time === '14:00',
    'and that answer is the correct one');
}

console.log('AVAILABILITY_TARGET_DATE_BOUNDS=PASS assertions=' + assertions);
console.log('DATED_READ_WINDOW=SINGLE_LOCAL_DAY');
console.log('OVERVIEW_HORIZON=UNCHANGED');
console.log('MIDNIGHT_SPANNING_BUSY=DETECTED');
console.log('DST_SEMANTICS=UNCHANGED');
console.log('ADVERSARIAL_REVERT=DETECTED');
console.log('OCCUPIED_SLOTS_EQUIVALENT_TO_PRE_FIX=YES');
console.log('REAL_CALENDAR_CALLS=0');

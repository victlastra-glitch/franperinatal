import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const files = ['../Code.js', '../Lifecycle.js', '../EmailTemplates.js', '../CalendarGateway.js'];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const context = {
  console, Date, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math,
  encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
    computeDigest: (_algorithm, value) => bytes(createHash('sha256').update(String(value)).digest()),
    computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
  },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({}) }) },
  Calendar: { Events: { insert() {}, list() {}, get() {}, update() {}, remove() {} }, Freebusy: { query() {} } },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);
const phase = context.__PHASE_A_TEST_EXPORTS__;
const calendar = context.__CALENDAR_TEST_EXPORTS__;
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

check(phase.SESSION_DURATION_MINUTES === 50, 'SESSION_DURATION_MINUTES=50');
check(phase.SLOT_INTERVAL_MINUTES === 60, 'SLOT_INTERVAL_MINUTES=60');
check(phase.SLOT_HOLD_MS === 15 * 60 * 1000, 'PRODUCTION_PAYMENT_SLOT_HOLD_MINUTES=15');
check(phase.SESSION_DURATION_MS === 50 * 60 * 1000 && phase.SLOT_INTERVAL_MS === 60 * 60 * 1000,
  'session duration and slot interval stay independent');

const start = phase.startAt_('2026-09-07', '10:00');
const end = phase.sessionEndAt_(start);
check((Date.parse(end) - Date.parse(start)) === 50 * 60 * 1000, '10:00 appointment ends at +50 minutes');
const localEnd = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .formatToParts(new Date(end)).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
check(localEnd.hour === '10' && localEnd.minute === '50', '10:00 appointment -> 10:50 event end');

const eleven = phase.startAt_('2026-09-07', '11:00');
check((Date.parse(eleven) - Date.parse(start)) === 60 * 60 * 1000, '10:00 and 11:00 remain adjacent start slots');
check(calendar.intervalOverlap_(start, end, eleven, phase.sessionEndAt_(eleven)) === false,
  '50-minute 10:00 session does not occupy the 11:00 start');

const slots = calendar.workingSlots_(new Date(start), new Date(phase.startAt_('2026-09-07', '12:00')), '2026-09-07');
check(slots.some((slot) => slot.time === '10:00') && slots.some((slot) => slot.time === '11:00'),
  'availability grid keeps hourly starts');
check((Date.parse(slots.find((slot) => slot.time === '10:00').end) - Date.parse(slots.find((slot) => slot.time === '10:00').start)) === 60 * 60 * 1000,
  'grid occupancy window stays the 60-minute slot interval');

const bounds = context.bookingBounds_(start);
check((bounds.end.getTime() - bounds.start.getTime()) === 50 * 60 * 1000, 'bookingBounds_ uses clinical session duration');

console.log(`SESSION_DURATION_REGRESSION=PASS assertions=${assertions}`);
console.log('SESSION_DURATION_MINUTES=50');
console.log('SLOT_INTERVAL_MINUTES=60');
console.log('PRODUCTION_PAYMENT_SLOT_HOLD_MINUTES=15');

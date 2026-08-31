import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createFixedDate, FIXED_TEST_NOW_ISO, FIXED_TEST_NOW_MS } from './helpers/fixed-date.mjs';

const sourceFiles = ['../Code.js', '../Lifecycle.js', '../EmailTemplates.js', '../CalendarGateway.js'];
const sources = sourceFiles.map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'));
const codeSource = sources[0];
const FixedDate = createFixedDate();

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

function digestBytes(value) {
  const text = String(value);
  const bytes = (buffer) => [...buffer].map((byte) => (byte > 127 ? byte - 256 : byte));
  if (text === 'synthetic-store') return bytes(Buffer.from('390f55363168', 'hex'));
  if (text === 'synthetic-calendar') return bytes(Buffer.from('6c0535f4450c', 'hex'));
  return bytes(createHash('sha256').update(text).digest());
}

function loadBookingContext(DateImpl) {
  let headers = [];
  const rows = [];
  const sheet = {
    getLastRow: () => 1 + rows.length,
    getLastColumn: () => headers.length,
    getRange: (row, col) => ({
      getDisplayValues: () => [headers],
      setValue: (value) => {
        if (row < 2) return;
        const record = rows[row - 2];
        if (!record) return;
        record[headers[col - 1]] = value;
      },
      setValues: () => {},
    }),
    getDataRange: () => ({
      getValues: () => [headers, ...rows.map((record) => headers.map((header) => record[header] ?? ''))],
    }),
    appendRow: (row) => {
      const record = {};
      headers.forEach((header, index) => { record[header] = row[index] == null ? '' : String(row[index]); });
      rows.push(record);
    },
  };
  const context = {
    console, Date: DateImpl, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math,
    encodeURIComponent, decodeURIComponent,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => digestBytes(value),
      computeHmacSha256Signature: () => digestBytes('hmac'),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({
      APP_ENV: 'production', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
      FLOW_BASE_URL: 'https://www.flow.cl/api', FLOW_RETURN_URL: 'https://franciscabustos.cl/pago-resultado',
      FLOW_CONFIRMATION_URL: 'https://franciscabustos.cl/api/flow-confirmation', BOOKING_STORE_ID: 'synthetic-store',
      CALENDAR_ID: 'synthetic-calendar', INTERNAL_NOTIFICATION_EMAIL: 'ops@example.test',
      IDEMPOTENCY_NAMESPACE: 'fran-booking',
      STATUS_TOKEN_SECRET: 'synthetic-status-secret',
    }) }) },
    SpreadsheetApp: { openById: () => ({ getId: () => 'synthetic-store', getSheetByName: () => sheet }) },
    CalendarApp: { getCalendarById: (id) => ({ getId: () => id }) },
    Calendar: {
      Freebusy: { query: () => ({ calendars: { 'synthetic-calendar': { busy: [] } } }) },
      Events: { list: () => ({ items: [] }), insert: () => ({ id: 'event-1', etag: 'e1', updated: FIXED_TEST_NOW_ISO }) },
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetch: () => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ url: 'https://www.flow.cl/app/web/pay', token: 'FLOWTOKENOPAQUE1234567890' }),
      }),
    },
    MailApp: { sendEmail: () => { throw new Error('mail must not be called'); } },
    GmailApp: { sendEmail: () => { throw new Error('mail must not be called'); } }, MailApp: { sendEmail: () => { throw new Error('MailApp must not be called'); } },
  };
  vm.createContext(context);
  for (const source of sources) vm.runInContext(source, context);
  headers = [...context.RESERVATION_HEADERS];
  return { context, rows };
}

const validPayload = {
  action: 'create_flow_payment',
  idempotencyKey: 'fran-booking-123e4567-e89b-12d3-a456-426614174000',
  serviceType: 'initial', modality: 'online', date: '2026-08-27', time: '10:00',
  name: 'Synthetic Patient', email: 'ops@example.test', phone: '', patientRut: '', reason: '', message: '',
};
const createEvent = (payload) => ({ postData: { contents: JSON.stringify(payload) } });

check(FixedDate.now() === FIXED_TEST_NOW_MS, 'FixedDate.now() is the frozen test instant');
check(new FixedDate().toISOString() === FIXED_TEST_NOW_ISO, 'zero-arg new Date() is the frozen test instant');
check(new FixedDate().getTime() === FIXED_TEST_NOW_MS, 'zero-arg Date instance epoch matches FIXED_TEST_NOW_MS');
check(FixedDate.parse(FIXED_TEST_NOW_ISO) === FIXED_TEST_NOW_MS, 'Date.parse keeps native semantics');
check(new FixedDate(FIXED_TEST_NOW_MS + 3600000).toISOString() === '2026-08-25T14:00:00.000Z',
  'explicit Date constructor is not frozen');
check(Number.isFinite(FixedDate.UTC(2026, 7, 27, 14, 0, 0)), 'Date.UTC keeps native semantics');
check(FixedDate.now() !== Date.now(), 'host Date.now() is not the VM test clock');
check(new Date().toISOString() !== FIXED_TEST_NOW_ISO, 'host zero-arg Date is not the frozen test instant');

const { context } = loadBookingContext(FixedDate);
check(context.Date.now() === FIXED_TEST_NOW_MS, 'VM Date.now() is the frozen test instant');
check(vm.runInContext('new Date().toISOString()', context) === FIXED_TEST_NOW_ISO,
  'VM zero-arg new Date() is independent of host wall clock');
check(vm.runInContext('Date.parse("2026-08-27T14:00:00.000Z")', context) === Date.parse('2026-08-27T14:00:00.000Z'),
  'VM Date.parse remains native for explicit timestamps');

const fields = vm.runInContext('CREATE_FLOW_FIELDS.slice()', context);
check(JSON.stringify(fields) === JSON.stringify([
  'idempotencyKey', 'serviceType', 'modality', 'date', 'time', 'name', 'email', 'phone',
  'patientRut', 'reason', 'message',
]), 'CREATE_FLOW_FIELDS public contract is unchanged');
['now', 'nowMs', 'testNow', 'clock'].forEach((key) => {
  check(fields.indexOf(key) === -1, 'CREATE_FLOW_FIELDS does not include ' + key);
});

check(/nowMs === undefined \? Date\.now\(\) : Number\(nowMs\)/.test(codeSource),
  'production assertBookableSlot_ defaults to Date.now() when nowMs is omitted');
check(/assertBookableSlot_\(payload\.date, payload\.time\)/.test(codeSource),
  'reserveOnce_ does not accept a caller-supplied now');

const created = context.createFlowPayment_(createEvent(validPayload));
check(created.ok === true && created.paymentUrl.startsWith('https://www.flow.cl/app/web/pay'),
  'createFlowPayment_ accepts 2026-08-27 10:00 relative to FIXED test time');

assert.throws(() => context.assertBookableSlot_('2026-08-25', '10:00'), /REQUEST_REJECTED/); assertions += 1;
assert.throws(() => context.assertBookableSlot_('2026-08-24', '10:00'), /REQUEST_REJECTED/); assertions += 1;
assert.throws(
  () => context.assertBookableSlot_(context.addCalendarDays_(context.localDateLabel_(new FixedDate()), 91), '10:00'),
  /REQUEST_REJECTED/,
); assertions += 1;
assert.throws(() => context.assertBookableSlot_('2026-08-30', '10:00'), /REQUEST_REJECTED/); assertions += 1;
check(context.assertBookableSlot_('2026-08-27', '10:00').endsWith('T14:00:00.000Z'),
  'canonical Thursday 10:00 America/Santiago is bookable against the frozen clock');

check(context.localDateLabel_(new FixedDate()) === '2026-08-25',
  'frozen clock local date is Tuesday 2026-08-25 America/Santiago');
check(new Date(String('2026-08-27') + 'T00:00:00Z').getUTCDay() === 4, 'canonical fixture weekday is Thursday');
check(new Date(String('2026-08-30') + 'T00:00:00Z').getUTCDay() === 0, 'weekend fixture weekday is Sunday');

['now', 'nowMs', 'testNow', 'clock'].forEach((key, index) => {
  const poisoned = {
    ...validPayload,
    idempotencyKey: `fran-booking-123e4567-e89b-12d3-a456-42661417400${index}`,
    [key]: String(FIXED_TEST_NOW_MS),
  };
  assert.throws(() => context.createFlowPayment_(createEvent(poisoned)), /REQUEST_REJECTED/);
  assertions += 1;
});

const futureHost = createFixedDate(Date.parse('2027-08-25T13:00:00.000Z'));
const other = loadBookingContext(futureHost);
assert.throws(() => other.context.assertBookableSlot_('2026-08-27', '10:00'), /REQUEST_REJECTED/); assertions += 1;
check(other.context.Date.now() === Date.parse('2027-08-25T13:00:00.000Z'),
  'production default follows the environment Date.now() when nowMs is omitted');

const realDateContext = loadBookingContext(Date);
check(typeof realDateContext.context.Date.now === 'function'
  && realDateContext.context.Date.now === Date.now,
  'without a test VM clock, production Date.now remains the host Date.now');

console.log(`BOOKING_CLOCK_CONTRACT_TESTS=PASS assertions=${assertions}`);
console.log(`FIXED_TEST_NOW=${FIXED_TEST_NOW_ISO}`);
console.log('TEST_CLOCK_HOST_INDEPENDENCE=PASS');
console.log('PUBLIC_TIME_OVERRIDE_SURFACE=NONE');

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

function loadBookingContext(DateImpl, overrideSources) {
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
  for (const source of (overrideSources || sources)) vm.runInContext(source, context);
  headers = [...context.RESERVATION_HEADERS];
  return { context, rows };
}

const validPayload = {
  action: 'create_flow_payment',
  idempotencyKey: 'fran-booking-123e4567-e89b-12d3-a456-426614174000',
  serviceType: 'initial', modality: 'online', date: '2026-08-27', time: '10:00',
  name: 'Synthetic Patient', email: 'ops@example.test', phone: '', patientRut: '11.111.111-1', address: 'Calle Sintetica 123', comuna: 'Providencia', reason: '', message: '',
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

const { context, rows } = loadBookingContext(FixedDate);
const headers = [...context.RESERVATION_HEADERS];
check(context.Date.now() === FIXED_TEST_NOW_MS, 'VM Date.now() is the frozen test instant');
check(vm.runInContext('new Date().toISOString()', context) === FIXED_TEST_NOW_ISO,
  'VM zero-arg new Date() is independent of host wall clock');
check(vm.runInContext('Date.parse("2026-08-27T14:00:00.000Z")', context) === Date.parse('2026-08-27T14:00:00.000Z'),
  'VM Date.parse remains native for explicit timestamps');

const fields = vm.runInContext('CREATE_FLOW_FIELDS.slice()', context);
check(JSON.stringify(fields) === JSON.stringify([
  'idempotencyKey', 'serviceType', 'modality', 'date', 'time', 'name', 'email', 'phone',
  'patientRut', 'address', 'comuna', 'reason', 'message',
]), 'CREATE_FLOW_FIELDS public contract is unchanged');
['now', 'nowMs', 'testNow', 'clock'].forEach((key) => {
  check(fields.indexOf(key) === -1, 'CREATE_FLOW_FIELDS does not include ' + key);
});

// --- Billing data: the boleta trio is required and decided HERE -------------
// The reservation is the record a post-session boleta de honorarios is issued
// from, so a row that cannot name a payer is a row that cannot serve the
// purpose it was created for. The browser checks the same RUT as a courtesy;
// these assertions are about the server refusing on its own.
const retiredFields = vm.runInContext('CREATE_FLOW_RETIRED_FIELDS.slice()', context);
check(JSON.stringify(retiredFields) === JSON.stringify([]),
  'no input key is currently retired, and the tolerance mechanism still exists');

const parsed = context.parseCreatePayload_(createEvent(validPayload));
check(parsed.patientRut === '11.111.111-1' && parsed.address === 'Calle Sintetica 123'
  && parsed.comuna === 'Providencia',
  'a valid create payload carries the billing trio through to the parsed payload');

// Canonical form is decided server-side, not trusted from the browser.
const parsedRaw = context.parseCreatePayload_(createEvent({ ...validPayload, patientRut: '11111111-1' }));
check(parsedRaw.patientRut === '11.111.111-1',
  'an unformatted RUT is normalised to canonical form by the server');
const parsedSpaced = context.parseCreatePayload_(createEvent({ ...validPayload, patientRut: ' 11.111.111-1 ' }));
check(parsedSpaced.patientRut === '11.111.111-1', 'surrounding whitespace does not change the verdict');

[['', 'PATIENT_RUT_REQUIRED'], ['11.111.111-2', 'INVALID_PATIENT_RUT'],
 ['12345-6', 'INVALID_PATIENT_RUT'], ['not-a-rut', 'INVALID_PATIENT_RUT']].forEach(([value, code]) => {
  assert.throws(() => context.parseCreatePayload_(createEvent({ ...validPayload, patientRut: value })),
    new RegExp(code), 'RUT "' + value + '" is refused as ' + code);
  assertions += 1;
});
[['address', 'BILLING_ADDRESS_REQUIRED'], ['comuna', 'BILLING_COMUNA_REQUIRED']].forEach(([field, code]) => {
  assert.throws(() => context.parseCreatePayload_(createEvent({ ...validPayload, [field]: '   ' })),
    new RegExp(code), 'a blank ' + field + ' is refused as ' + code);
  assertions += 1;
});

// The billing trio reaches the stored row, and only the stored row.
const createdWithBilling = context.createFlowPayment_(createEvent({
  ...validPayload,
  idempotencyKey: 'fran-booking-123e4567-e89b-12d3-a456-4266141740aa',
  time: '11:00',
}));
check(createdWithBilling.ok === true && createdWithBilling.paymentUrl.startsWith('https://www.flow.cl/app/web/pay'),
  'createFlowPayment_ creates a payment order for a booking that supplies billing data');
const storedRow = rows[rows.length - 1];
check(storedRow.billing_rut === '11.111.111-1'
  && storedRow.billing_address === 'Calle Sintetica 123'
  && storedRow.billing_comuna === 'Providencia',
  'the billing trio is persisted on the reservation row');
check(storedRow.patient_name === 'Synthetic Patient'
  && storedRow.patient_email === 'ops@example.test',
  'the administrative record keeps the name beside the email it already kept');
check(headers.indexOf('billing_rut') > headers.indexOf('transaction_amount_clp'),
  'the billing columns were appended, not inserted');

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

// --- Adversarial mutations on the billing contract --------------------------
const mutateCode = (from, to) => {
  assert.ok(codeSource.includes(from), 'mutation target present: ' + from);
  return sources.map((source, index) => (index === 0 ? source.replace(from, to) : source));
};

// 1. Drop the address requirement: a blank dirección must then sail through.
//    Unlike the RUT, which the checksum would still catch, the address has a
//    single guard, so removing it is the whole difference.
const unrequiredContext = loadBookingContext(createFixedDate(), mutateCode(
  "  if (!payload.address) fail_('BILLING_ADDRESS_REQUIRED');\n",
  '',
)).context;
check(unrequiredContext.parseCreatePayload_(createEvent({ ...validPayload, address: '   ' })).address === '',
  'dropping the required-address check must let a blank dirección through');
console.log('MUTATION_BILLING_ADDRESS_NOT_REQUIRED=DETECTED');

// Defence in depth, asserted as a property rather than a mutation: even without
// the explicit required check, a blank RUT never passes, because an empty
// string is not a valid RUT either.
const noRequiredCheck = loadBookingContext(createFixedDate(), mutateCode(
  "  if (!payload.patientRut) fail_('PATIENT_RUT_REQUIRED');\n",
  '',
)).context;
assert.throws(() => noRequiredCheck.parseCreatePayload_(createEvent({ ...validPayload, patientRut: '' })),
  /INVALID_PATIENT_RUT/, 'a blank RUT is refused by the checksum even with the required check gone');
assertions += 1;

// 2. Neuter the checksum: a RUT with a wrong verifier digit must then be
//    accepted. A field that is merely non-empty is not a RUT.
const uncheckedContext = loadBookingContext(createFixedDate(), mutateCode(
  'function validChileanRut_(value) {\n  const clean = cleanChileanRut_(value);',
  'function validChileanRut_(value) {\n  if (value) return true;\n  const clean = cleanChileanRut_(value);',
)).context;
check(uncheckedContext.parseCreatePayload_(createEvent({ ...validPayload, patientRut: '11.111.111-2' })).patientRut
  === '11.111.111-2',
  'neutering the modulo-11 check must accept a wrong verifier digit');
console.log('MUTATION_RUT_CHECKSUM_IGNORED=DETECTED');

// 3. Stop persisting it: the create still succeeds, and the stored row silently
//    loses the only reason the field was collected. This is the failure mode a
//    green "the payload parsed fine" suite would never notice.
const unpersistedHarness = loadBookingContext(createFixedDate(), mutateCode(
  '    billing_rut: payload.patientRut, billing_address: payload.address,\n',
  '    billing_address: payload.address,\n',
));
const unpersistedCreate = unpersistedHarness.context.createFlowPayment_(createEvent({
  ...validPayload, idempotencyKey: 'fran-booking-123e4567-e89b-12d3-a456-4266141740bb', time: '12:00',
}));
check(unpersistedCreate.ok === true
  && unpersistedHarness.rows[unpersistedHarness.rows.length - 1].billing_rut === '',
  'dropping the persistence must leave billing_rut empty on an otherwise successful booking');
console.log('MUTATION_BILLING_RUT_NOT_PERSISTED=DETECTED');

console.log(`BOOKING_CLOCK_CONTRACT_TESTS=PASS assertions=${assertions}`);
console.log(`FIXED_TEST_NOW=${FIXED_TEST_NOW_ISO}`);
console.log('TEST_CLOCK_HOST_INDEPENDENCE=PASS');
console.log('PUBLIC_TIME_OVERRIDE_SURFACE=NONE');

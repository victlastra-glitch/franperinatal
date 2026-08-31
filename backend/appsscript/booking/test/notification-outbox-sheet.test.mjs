import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const files = ['../Code.js', '../Lifecycle.js', '../EmailTemplates.js'];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const secret = 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz';
const allowlisted = 'ops@example.test';
const propertyValues = {
  APP_ENV: 'production', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://www.flow.cl/api', FLOW_RETURN_URL: 'https://franciscabustos.cl/pago-resultado',
  FLOW_CONFIRMATION_URL: 'https://franciscabustos.cl/api/flow-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: allowlisted,
  IDEMPOTENCY_NAMESPACE: 'fran-booking', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
  CAPABILITY_TOKEN_SECRET: secret,
};
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const digestBytes = (value) => {
  const text = String(value);
  if (text === 'synthetic-store') return bytes(Buffer.from('390f55363168', 'hex'));
  if (text === 'synthetic-calendar') return bytes(Buffer.from('6c0535f4450c', 'hex'));
  return bytes(createHash('sha256').update(text).digest());
};

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

let headers = [];
const reservationRows = [];
const outboxRows = [];
let outboxHeaders = [];
let spreadsheet = null;
let networkCalls = 0;
let mailCalls = 0;

function makeRange(targetHeaders, setCell) {
  return function(row, col) {
    return {
      getDisplayValues: () => [targetHeaders.slice()],
      setValue: (value) => setCell(row, col, value),
      setValues: (values) => {
        if (row === 1 && values && values[0] && targetHeaders === outboxHeaders) {
          outboxHeaders.splice(0, outboxHeaders.length, ...values[0].map(String));
        }
      },
    };
  };
}

const reservationSheet = {
  getLastRow: () => 1 + reservationRows.length,
  getLastColumn: () => headers.length,
  getRange: makeRange(headers, (row, col, value) => {
    if (row < 2) return;
    const record = reservationRows[row - 2];
    if (!record) return;
    record[headers[col - 1]] = String(value == null ? '' : value);
  }),
  getDataRange: () => ({
    getValues: () => [headers, ...reservationRows.map((record) => headers.map((header) => record[header] ?? ''))],
  }),
  appendRow: (row) => {
    const record = { rowNumber: reservationRows.length + 2 };
    headers.forEach((header, index) => { record[header] = row[index] == null ? '' : String(row[index]); });
    reservationRows.push(record);
  },
  getParent: () => spreadsheet,
};
const outboxSheet = {
  getLastRow: () => (outboxHeaders.length ? 1 + outboxRows.length : 0),
  getLastColumn: () => outboxHeaders.length,
  getRange: makeRange(outboxHeaders, (row, col, value) => {
    if (row === 1) {
      outboxHeaders[col - 1] = String(value == null ? '' : value);
      return;
    }
    const record = outboxRows[row - 2];
    if (!record) return;
    record[outboxHeaders[col - 1]] = String(value == null ? '' : value);
  }),
  getDataRange: () => ({
    getValues: () => [outboxHeaders, ...outboxRows.map((record) => outboxHeaders.map((header) => record[header] ?? ''))],
  }),
  appendRow: (row) => {
    const record = { rowNumber: outboxRows.length + 2 };
    outboxHeaders.forEach((header, index) => { record[header] = row[index] == null ? '' : String(row[index]); });
    outboxRows.push(record);
  },
  getParent: () => spreadsheet,
};
spreadsheet = {
  getId: () => 'synthetic-store',
  getSheetByName: (name) => {
    if (name === 'reservations') return reservationSheet;
    if (name === 'notification_outbox') return outboxHeaders.length || outboxRows.length ? outboxSheet : null;
    return null;
  },
  insertSheet: (name) => {
    if (name !== 'notification_outbox') return reservationSheet;
    return outboxSheet;
  },
};

const context = {
  console, Date, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math, encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
    computeDigest: (_algorithm, value) => digestBytes(value),
    computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
  },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...propertyValues }) }) },
  SpreadsheetApp: { openById: () => spreadsheet },
  CalendarApp: { getCalendarById: (id) => ({ getId: () => id }) },
  GmailApp: { sendEmail: () => { mailCalls += 1; return true; } },
  MailApp: { sendEmail: () => { throw new Error('MailApp must not be called'); } },
  LockService: {
    getScriptLock: () => {
      const lock = {
        held: false,
        acquireCount: 0,
        releaseCount: 0,
        tryLock: () => {
          if (lock.held) return true;
          lock.held = true;
          lock.acquireCount += 1;
          return true;
        },
        releaseLock: () => {
          lock.releaseCount += 1;
          lock.held = false;
        },
      };
      return lock;
    },
  },
  UrlFetchApp: { fetch: () => { networkCalls += 1; throw new Error('network must not be called'); } },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }), deleteTrigger: () => {} },
  Session: { getActiveUser: () => ({ getEmail: () => '' }) },
  ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (value) => ({ value, setMimeType() { return this; } }) },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);
headers.push(...context.RESERVATION_HEADERS);
const phase = context.__PHASE_A_TEST_EXPORTS__;
const worker = context.__NOTIFICATION_OUTBOX_TEST_EXPORTS__;

const reschedule = phase.createCapability_('RESCHEDULE', { secret, now: Date.parse('2026-08-23T12:00:00Z') });
const cancel = phase.createCapability_('CANCEL', { secret, now: Date.parse('2026-08-23T12:00:00Z') });
const booking = {
  rowNumber: 2,
  reservation_id: 'fran-booking-reservation-sheet',
  idempotency_key: 'fran-booking-sheet-key-0001',
  commerce_order: 'fp-dddddddddddddddddddddddddddddddddddddddd',
  service_type: 'initial',
  modality: 'online',
  patient_email: allowlisted,
  original_start_at: '2026-08-25T15:00:00.000Z',
  current_start_at: '2026-08-25T15:00:00.000Z',
  current_end_at: '2026-08-25T16:00:00.000Z',
  booking_status: 'confirmed',
  payment_status: 'paid',
  refund_status: 'not_required',
  schedule_status: 'scheduled',
  patient_reschedule_count: '0',
  meet_url: 'https://meet.google.com/opaque-meet',
  meet_status: 'available',
  notification_version: '1',
  notification_patient_state: '',
  notification_internal_state: '',
  last_operation_id: '',
};
Object.assign(booking, phase.capabilityFields_(reschedule), phase.capabilityFields_(cancel));
headers.forEach((header) => {
  if (booking[header] == null) booking[header] = '';
});
reservationRows.push(booking);
const reservationSnapshot = JSON.stringify(reservationRows.map((row) => headers.map((header) => row[header] ?? '')));

check(spreadsheet.getSheetByName('reservations') === reservationSheet, 'reservations exists');
check(spreadsheet.getSheetByName('notification_outbox') === null, 'notification_outbox is initially absent');

const created = worker.ensureNotificationOutboxSheet_(spreadsheet);
check(created === outboxSheet && outboxHeaders.length === phase.OUTBOX_HEADERS.length
  && outboxHeaders.join('\u0001') === phase.OUTBOX_HEADERS.join('\u0001')
  && phase.OUTBOX_HEADERS.includes('source_operation_id'),
  'ensure creates the current outbox header schema');
check(JSON.stringify(reservationRows.map((row) => headers.map((header) => row[header] ?? ''))) === reservationSnapshot
  && headers.length === 57,
  'creating the outbox does not change reservation data or the 57-column booking schema');

const schema = { headers, columns: Object.fromEntries(headers.map((header, index) => [header, index + 1])) };
const store = {
  records: () => reservationRows.slice(),
  loadByReservationId: (id) => reservationRows.find((row) => row.reservation_id === String(id)) || null,
  update: (record, fields) => Object.assign(record, fields),
};
worker.enqueueLifecycleNotification_(reservationSheet, schema, booking, 'BOOKING_CONFIRMED');
check(outboxRows.length === 1 && outboxRows[0].event_type === 'BOOKING_CONFIRMED'
  && outboxRows[0].state === 'pending' && outboxRows[0].source_operation_id
  && outboxRows[0].logical_key.includes('BOOKING_CONFIRMED'),
  'first sheet-backed enqueue writes a durable outbox row');

const sheetStore = worker.sheetNotificationOutboxStore_(outboxSheet);
check(sheetStore.records().length === 1 && sheetStore.records()[0].logical_key === outboxRows[0].logical_key,
  'sheetNotificationOutboxStore_ reads the appended row');

mailCalls = 0;
const processed = worker.processLifecycleNotificationOutbox_({
  config: phase.readCapabilityConfig_(),
  store,
  resources: { sheet: reservationSheet, spreadsheet },
  schema,
  requireCapabilitySecret_: () => secret,
  now: Date.parse('2026-08-23T12:10:00Z'),
});
check(processed.ok && processed.results[0].ok && processed.results[0].code === 'SENT',
  'sheet-backed worker processes the durable row');
check(outboxRows[0].state === 'sent' && outboxRows[0].last_result === 'sent' && mailCalls === 1,
  'sheet-backed worker updates the outbox row to a terminal sent state');
check(networkCalls === 0, 'sheet-backed outbox test makes no network calls');

console.log('SHEET_BACKED_OUTBOX_WORKER=PASS');
console.log('EXISTING_PRODUCTION_SCHEMA_COMPATIBILITY=PASS');
console.log(`SHEET_OUTBOX_TESTS=PASS assertions=${assertions}`);

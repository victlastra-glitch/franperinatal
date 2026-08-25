import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sourceFiles = ['../Code.js', '../Lifecycle.js', '../CalendarGateway.js'];
const sources = sourceFiles.map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'));
const fixedNow = Date.parse('2026-08-25T13:00:00.000Z');
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const utilities = {
  DigestAlgorithm: { SHA_256: 'sha256' },
  Charset: { UTF_8: 'utf8' },
  computeDigest: (_algorithm, value) => {
    if (String(value) === 'synthetic-store') return bytes(Buffer.from('390f55363168', 'hex'));
    if (String(value) === 'synthetic-calendar') return bytes(Buffer.from('6c0535f4450c', 'hex'));
    return bytes(createHash('sha256').update(String(value)).digest());
  },
  computeHmacSha256Signature: () => bytes(Buffer.alloc(32)),
};

let headers = [];
let rows = [];
let appendCount = 0;
let flowCalls = 0;
let freeBusyCalls = 0;
let calendarMode = 'busy';
let insertedOptions;
let insertedResource;
let updatedResource;
const sheet = {
  getLastRow: () => 1 + rows.length,
  getLastColumn: () => headers.length,
  getRange: () => ({ getDisplayValues: () => [headers], setValue: () => {}, setValues: () => {} }),
  getDataRange: () => ({ getValues: () => [headers, ...rows] }),
  appendRow: (row) => { rows.push(row); appendCount += 1; },
};
const calendarApp = { getCalendarById: (id) => ({ getId: () => id }) };
const calendarApi = {
  Freebusy: {
    query: (resource) => {
      freeBusyCalls += 1;
      return { calendars: { 'synthetic-calendar': { busy: calendarMode === 'busy' ? [{ start: resource.timeMin, end: resource.timeMax }] : [] } } };
    },
  },
  Events: {
    list: () => ({ items: [] }),
    insert: (resource, calendarId, optionalArgs) => {
      insertedResource = resource;
      insertedOptions = optionalArgs;
      return { id: 'event-opaque', etag: 'etag-1', updated: '2026-08-25T13:00:00.000Z', status: 'confirmed',
        start: resource.start, end: resource.end, extendedProperties: resource.extendedProperties,
        conferenceData: { conferenceId: 'meet-opaque', entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque' }] } };
    },
    get: () => ({ id: 'event-opaque', etag: 'etag-1', updated: '2026-08-25T13:00:00.000Z', status: 'confirmed',
      start: insertedResource.start, end: insertedResource.end, extendedProperties: insertedResource.extendedProperties,
      conferenceData: { conferenceId: 'meet-opaque', entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque' }] } }),
    update: (resource, calendarId, eventId, optionalArgs) => {
      updatedResource = resource;
      return { ...resource, etag: 'etag-2', updated: '2026-08-25T14:00:00.000Z' };
    },
  },
};
const context = {
  console, Date, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math, encodeURIComponent, decodeURIComponent,
  Utilities: utilities,
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({
    APP_ENV: 'nonprod', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
    FLOW_BASE_URL: 'https://sandbox.flow.cl/api', FLOW_RETURN_URL: 'https://preview-example.pages.dev/pago-resultado',
    FLOW_CONFIRMATION_URL: 'https://preview-example.pages.dev/api/flow-confirmation', BOOKING_STORE_ID: 'synthetic-store',
    CALENDAR_ID: 'synthetic-calendar', INTERNAL_NOTIFICATION_EMAIL: 'qa+nonprod@example.test',
    PATIENT_EMAIL_RECIPIENT_ALLOWLIST: 'qa+nonprod@example.test', IDEMPOTENCY_NAMESPACE: 'fran-nonprod-20260821',
    STATUS_TOKEN_SECRET: 'synthetic-status-secret',
  }) }) },
  SpreadsheetApp: { openById: () => ({ getId: () => 'synthetic-store', getSheetByName: () => sheet }) },
  CalendarApp: calendarApp,
  Calendar: calendarApi,
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  UrlFetchApp: { fetch: () => { flowCalls += 1; throw new Error('Flow must not be called'); } },
  MailApp: { sendEmail: () => { throw new Error('mail must not be called'); } },
  GmailApp: { sendEmail: () => { throw new Error('mail must not be called'); } },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);
headers = context.RESERVATION_HEADERS;

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const payload = {
  idempotencyKey: 'fran-nonprod-20260821-123e4567-e89b-12d3-a456-426614174000',
  serviceType: 'initial', modality: 'online', date: '2026-08-27', time: '10:00',
  name: 'Synthetic Patient', email: 'qa+nonprod@example.test', phone: '999999999', patientRut: '11.111.111-1', reason: 'synthetic', message: '',
};

assert.throws(() => context.assertBookableSlot_('2026-08-30', '10:00', fixedNow), /REQUEST_REJECTED/); assertions += 1;
assert.throws(() => context.assertBookableSlot_('2026-08-27', '09:00', fixedNow), /REQUEST_REJECTED/); assertions += 1;
assert.throws(() => context.assertBookableSlot_('2026-08-24', '10:00', fixedNow), /REQUEST_REJECTED/); assertions += 1;
assert.throws(() => context.assertBookableSlot_(context.addCalendarDays_(context.localDateLabel_(new Date(fixedNow)), 91), '10:00', fixedNow), /REQUEST_REJECTED/); assertions += 1;
assert.throws(() => context.assertBookableSlot_('2026-08-25', '10:00', fixedNow), /REQUEST_REJECTED/); assertions += 1;
check(context.assertBookableSlot_('2026-08-27', '10:00', fixedNow).endsWith('T14:00:00.000Z'), 'valid weekday/hour passes server-side bookable validation');

const resources = context.assertResources_(context.readConfig_());
calendarMode = 'free';
resources.calendarGateway.createLinkedBookingEvent({
  calendar_link_key: 'fran-nonprod-20260821-calendar-link-synthetic',
  current_start_at: '2026-08-27T14:00:00.000Z', current_end_at: '2026-08-27T15:00:00.000Z',
});
check(insertedOptions.conferenceDataVersion === 1, 'runtime resource gateway requests conferenceDataVersion=1');
check(insertedResource.conferenceData.createRequest.conferenceSolutionKey.type === 'hangoutsMeet', 'runtime resource gateway requests Google Meet');
check(!JSON.stringify(insertedResource.conferenceData).match(/patient|email|rut|phone|clinical|reason/i), 'Meet request metadata contains no PII');
resources.calendarGateway.updateSameEvent({ calendar_event_id: 'event-opaque', calendar_event_etag: 'etag-1', calendar_link_key: 'fran-nonprod-20260821-calendar-link-synthetic' },
  '2026-08-27T15:00:00.000Z', '2026-08-27T16:00:00.000Z');
check(Boolean(updatedResource.conferenceData) && updatedResource.conferenceData.conferenceId === 'meet-opaque', 'same-event reschedule preserves conference data');

calendarMode = 'busy';
rows = [];
appendCount = 0;
freeBusyCalls = 0;
flowCalls = 0;
const busyResult = context.createFlowPayment_({ postData: { contents: JSON.stringify({ action: 'create_flow_payment', ...payload }) } });
check(busyResult.ok === false && busyResult.code === 'SLOT_TAKEN', 'Calendar-busy checkout returns SLOT_TAKEN');
check(freeBusyCalls === 1 && appendCount === 0 && rows.length === 0 && flowCalls === 0, 'busy checkout has one Calendar check, no row, and zero Flow calls');

const invalidPayload = { ...payload, idempotencyKey: 'fran-nonprod-20260821-123e4567-e89b-12d3-a456-426614174001', date: '2026-08-30' };
assert.throws(() => context.createFlowPayment_({ postData: { contents: JSON.stringify({ action: 'create_flow_payment', ...invalidPayload }) } }), /REQUEST_REJECTED/);
check(appendCount === 0 && flowCalls === 0, 'invalid public slot is rejected before reservation and Flow');

console.log(`PRE_TRANSACTION_CONTRACT_TESTS=PASS assertions=${assertions}`);

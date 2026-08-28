import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createFixedDate } from './helpers/fixed-date.mjs';

const FixedDate = createFixedDate();
const files = [
  '../Code.js', '../Lifecycle.js', '../CalendarGateway.js',
  '../Reconciliation.js', '../RefundGateway.js', '../TargetedFixture.js',
];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const fixtureSource = sources[5];
const codeSource = sources[0];
const appsscript = JSON.parse(readFileSync(new URL('../appsscript.json', import.meta.url), 'utf8'));

const allowlisted = 'qa+nonprod@example.test';
const secret = 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz';
const baseProperties = {
  APP_ENV: 'nonprod', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://sandbox.flow.cl/api', FLOW_RETURN_URL: 'https://preview-example.pages.dev/pago-resultado',
  FLOW_CONFIRMATION_URL: 'https://preview-example.pages.dev/api/flow-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: allowlisted, PATIENT_EMAIL_RECIPIENT_ALLOWLIST: allowlisted,
  IDEMPOTENCY_NAMESPACE: 'fran-nonprod-20260821', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
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
const rejects = (fn, pattern, message) => { assert.throws(fn, pattern, message); assertions += 1; };

let propertyValues = { ...baseProperties };
let headers = [];
const reservationRows = [];
const outboxRows = [];
let outboxHeaders = [];
let spreadsheet = null;
let calendarEvents = [];
let nextSyncToken = 'sync-targeted-1';
let networkCalls = 0;
let mailCalls = 0;
let insertCalls = 0;
let removeCalls = 0;
let lastInsert = null;
let openByIdCalls = [];
let getCalendarByIdCalls = [];

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
    if (row < 2) return;
    const current = outboxRows[row - 2];
    if (!current) return;
    current[outboxHeaders[col - 1]] = String(value == null ? '' : value);
  }),
  getDataRange: () => ({
    getValues: () => [outboxHeaders, ...outboxRows.map((row) => outboxHeaders.map((header) => row[header] ?? ''))],
  }),
  appendRow: (row) => {
    const created = { rowNumber: outboxRows.length + 2 };
    outboxHeaders.forEach((header, index) => { created[header] = row[index] == null ? '' : String(row[index]); });
    outboxRows.push(created);
  },
  getParent: () => spreadsheet,
};

spreadsheet = {
  getId: () => propertyValues.BOOKING_STORE_ID,
  getSheetByName: (name) => {
    if (name === 'reservations_nonprod') return reservationSheet;
    if (name === 'notification_outbox_nonprod') return outboxHeaders.length || outboxRows.length ? outboxSheet : null;
    return null;
  },
  insertSheet: (name) => {
    if (name !== 'notification_outbox_nonprod') return reservationSheet;
    return outboxSheet;
  },
};

function parseLinkKey(request) {
  const props = request && request.privateExtendedProperty;
  if (!Array.isArray(props)) return '';
  const match = props.map(String).find((value) => value.startsWith('link_key='));
  return match ? match.slice('link_key='.length) : '';
}

const calendarApi = {
  Freebusy: {
    query: () => ({ calendars: { [propertyValues.CALENDAR_ID]: { busy: [] } } }),
  },
  Events: {
    list: (_calendarId, request) => {
      if (request && request.privateExtendedProperty) {
        const linkKey = parseLinkKey(request);
        return { items: calendarEvents.filter((event) => event.extendedProperties?.private?.link_key === linkKey) };
      }
      return { items: calendarEvents.slice(), nextSyncToken };
    },
    get: (_calendarId, eventId) => {
      const found = calendarEvents.find((event) => event.id === String(eventId));
      if (!found) {
        const error = new Error('HTTP 404');
        error.status = 404;
        throw error;
      }
      return found;
    },
    insert: (resource, calendarId, optionalArgs) => {
      insertCalls += 1;
      lastInsert = { resource, calendarId, optionalArgs };
      const event = {
        id: 'event-targeted-opaque-1',
        etag: 'etag-insert',
        updated: '2026-08-25T15:00:00.000Z',
        status: 'confirmed',
        start: resource.start,
        end: resource.end,
        extendedProperties: resource.extendedProperties,
        conferenceData: resource.conferenceData,
      };
      calendarEvents.push(event);
      return event;
    },
    remove: (_calendarId, eventId, optionalArgs) => {
      removeCalls += 1;
      lastInsert = lastInsert || {};
      lastInsert.removeArgs = optionalArgs;
      calendarEvents = calendarEvents.filter((event) => event.id !== String(eventId));
    },
  },
};

const context = {
  console, Date: FixedDate, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math,
  encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
    computeDigest: (_algorithm, value) => digestBytes(value),
    computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperties: () => ({ ...propertyValues }),
      getProperty: (key) => propertyValues[key] || '',
      setProperty: (key, value) => { propertyValues[key] = String(value); },
    }),
  },
  SpreadsheetApp: {
    openById: (id) => {
      openByIdCalls.push(String(id));
      if (String(id) !== String(propertyValues.BOOKING_STORE_ID)) {
        throw new Error('arbitrary spreadsheet id rejected');
      }
      return spreadsheet;
    },
  },
  CalendarApp: {
    getCalendarById: (id) => {
      getCalendarByIdCalls.push(String(id));
      if (String(id) !== String(propertyValues.CALENDAR_ID)) {
        throw new Error('arbitrary calendar id rejected');
      }
      return { getId: () => id };
    },
  },
  Calendar: calendarApi,
  MailApp: { sendEmail: () => { mailCalls += 1; return true; } },
  GmailApp: { sendEmail: () => { throw new Error('GmailApp must not be called'); } },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  UrlFetchApp: { fetch: () => { networkCalls += 1; throw new Error('Flow transport must not be called'); } },
  ScriptApp: {
    getProjectTriggers: () => [],
    newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }),
    deleteTrigger: () => {},
  },
  Session: { getActiveUser: () => ({ getEmail: () => '' }) },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (value) => ({ value, setMimeType() { return this; } }),
  },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);
headers.push(...context.RESERVATION_HEADERS);

const fixture = context.__TARGETED_FIXTURE_TEST_EXPORTS__;
const phase = context.__PHASE_A_TEST_EXPORTS__;
const reconciliation = context.__RECONCILIATION_TEST_EXPORTS__;

function jsonResult(output) {
  return JSON.parse(output.value);
}

function currentRecord() {
  return reservationRows.find((row) => fixture.isTargetedCalendarFixtureRecord_(row)) || null;
}

function seedHistoricalRow() {
  const row = { rowNumber: reservationRows.length + 2 };
  headers.forEach((header) => { row[header] = ''; });
  Object.assign(row, {
    idempotency_key: 'fran-nonprod-20260821-123e4567-e89b-12d3-a456-426614174000',
    reservation_id: 'fran-nonprod-20260821-reservation-abcdef0123456789abcdef01',
    service_type: 'initial',
    modality: 'online',
    patient_email: allowlisted,
    original_start_at: '2026-09-03T15:00:00.000Z',
    current_start_at: '2026-09-03T15:00:00.000Z',
    current_end_at: '2026-09-03T16:00:00.000Z',
    booking_status: 'confirmed',
    payment_status: 'paid',
    refund_status: 'not_required',
    schedule_status: 'scheduled',
    calendar_event_id: 'event-historical-opaque',
    calendar_link_key: 'fran-nonprod-20260821-calendar-link-historical01ab',
    patient_reschedule_count: '1',
    notification_outbox_key: 'lifecycle_fran-nonprod-20260821-reservation-abcdef0123456789abcdef01_BOOKING_CONFIRMED_1',
    notification_patient_state: 'sent',
  });
  reservationRows.push(row);
  return row;
}

check(typeof fixture.nonprodCreateTargetedCalendarFixture === 'function'
  && fixture.nonprodCreateTargetedCalendarFixture.length === 0
  && context.createTargetedCalendarFixture_.length === 0
  && context.nonprodCleanupTargetedCalendarFixture.length === 0,
  'operator wrappers and internals take zero arguments');
check(!Object.prototype.hasOwnProperty.call(appsscript, 'executionApi')
  && !JSON.stringify(appsscript).includes('executionApi'),
  'appsscript.json does not declare executionApi');
check(!/function reconcileCalendarChange_/.test(fixtureSource)
  && !/function processCalendarReconciliation_/.test(fixtureSource)
  && !/function persistCalendarMetadataRefresh_/.test(fixtureSource),
  'fixture harness does not redefine reconciliation functions');
check(!/flowRequest_|createSandboxFlowPayment_|UrlFetchApp|createCapability_|randomOpaqueCapabilityToken_/.test(fixtureSource),
  'fixture harness never calls Flow transport or capability issuance');
check(!/function doGet[\s\S]*targeted|function doPost[\s\S]*targeted/i.test(codeSource)
  && !/create_targeted|targeted_calendar_fixture|nonprodCreateTargeted/.test(
    codeSource.slice(codeSource.indexOf('function doGet'), codeSource.indexOf('function fail_'))),
  'public doGet/doPost has no fixture route');

propertyValues.APP_ENV = 'production';
rejects(() => context.nonprodCreateTargetedCalendarFixture(), /CONFIGURATION_INCOMPLETE/, 'production env rejected');
rejects(() => context.nonprodCleanupTargetedCalendarFixture(), /CONFIGURATION_INCOMPLETE/, 'cleanup production env rejected');
propertyValues.APP_ENV = 'nonprod';

propertyValues.BOOKING_STORE_ID = 'production-store';
rejects(() => context.nonprodCreateTargetedCalendarFixture(), /CONFIGURATION_INCOMPLETE/, 'wrong store fingerprint rejected');
propertyValues.BOOKING_STORE_ID = 'synthetic-store';

propertyValues.CALENDAR_ID = 'production-calendar';
rejects(() => context.nonprodCreateTargetedCalendarFixture(), /CONFIGURATION_INCOMPLETE/, 'wrong Calendar fingerprint rejected');
propertyValues.CALENDAR_ID = 'synthetic-calendar';

propertyValues.INTERNAL_NOTIFICATION_EMAIL = 'patient@example.test';
propertyValues.PATIENT_EMAIL_RECIPIENT_ALLOWLIST = 'patient@example.test';
rejects(() => context.nonprodCreateTargetedCalendarFixture(), /CONFIGURATION_INCOMPLETE/, 'non-allowlisted recipient rejected');
propertyValues.INTERNAL_NOTIFICATION_EMAIL = allowlisted;
propertyValues.PATIENT_EMAIL_RECIPIENT_ALLOWLIST = allowlisted;

check(jsonResult(context.doGet({ parameter: { action: 'create_targeted_fixture' } })).code === 'NOT_FOUND',
  'doGet fixture action is NOT_FOUND');
check(jsonResult(context.doPost({ parameter: { action: 'nonprodCreateTargetedCalendarFixture' } })).code === 'NOT_FOUND',
  'doPost operator wrapper name is NOT_FOUND');
check(jsonResult(context.doPost({
  parameter: { action: 'create_flow_payment' },
  postData: { contents: JSON.stringify({ action: 'create_targeted_fixture' }) },
})).code === 'REQUEST_REJECTED', 'create payload cannot address the fixture harness');

const historical = seedHistoricalRow();
const historicalSnapshot = JSON.stringify(historical);
networkCalls = 0;
openByIdCalls = [];
getCalendarByIdCalls = [];
const created = context.nonprodCreateTargetedCalendarFixture.call(null, {
  bookingStoreId: 'attacker-store', calendarId: 'attacker-calendar', email: 'attacker@example.test',
});
check(created.ok === true && created.fixtureKey === fixture.TARGETED_CALENDAR_FIXTURE_KEY, 'create returns sanitized fixture evidence');
check(networkCalls === 0, 'Flow transport never called on create');
check(openByIdCalls.every((id) => id === 'synthetic-store') && getCalendarByIdCalls.every((id) => id === 'synthetic-calendar'),
  'arbitrary spreadsheet/calendar IDs cannot be supplied');
check(insertCalls === 1 && lastInsert.calendarId === 'synthetic-calendar'
  && lastInsert.optionalArgs.conferenceDataVersion === 1
  && lastInsert.optionalArgs.sendUpdates === 'none'
  && lastInsert.resource.conferenceData.createRequest.conferenceSolutionKey.type === 'hangoutsMeet',
  'create uses createLinkedBookingEvent Meet contract');
check(lastInsert.resource.summary === 'NONPROD confirmed booking'
  && lastInsert.resource.extendedProperties.private.source === 'fran_booking'
  && !JSON.stringify(lastInsert.resource).match(/@|rut|phone|clinical|reason|patient_email/i),
  'Calendar event has no patient PII');

const record = currentRecord();
check(headers.length === 57 && record && headers.every((header) => Object.prototype.hasOwnProperty.call(record, header)),
  'generated datastore record is 57-column compatible');
check(record.booking_status === 'confirmed' && record.payment_status === 'paid'
  && record.schedule_status === 'scheduled' && record.patient_reschedule_count === '0'
  && record.slot_hold_expires_at === '',
  'synthetic booking is confirmed/scheduled/paid with count 0 and no hold');
check(record.idempotency_key === fixture.TARGETED_CALENDAR_FIXTURE_KEY
  && record.reservation_id === fixture.targetedCalendarFixtureReservationId_()
  && record.calendar_link_key === fixture.targetedCalendarFixtureLinkKey_()
  && !phase.validIdempotencyKey_(record.idempotency_key),
  'fixture identifiers use the explicit synthetic namespace');
check(record.patient_email === allowlisted && /\+nonprod@/i.test(record.patient_email),
  'synthetic recipient is the approved +nonprod allowlist address');
check(!record.commerce_order && !record.flow_token && !record.payment_url && !record.status_token_hash,
  'fixture does not persist Flow or status-token material');
check(!record.reschedule_capability_hash && !record.cancel_capability_hash
  && !record.reschedule_capability_version && !record.cancel_capability_version
  && !JSON.stringify(record).match(/[a-f0-9]{96}/i),
  'no raw capability bearer exists');
check(outboxRows.length === 0 && !record.notification_outbox_key && !record.notification_patient_state
  && created.ok && !String(JSON.stringify(created)).includes('BOOKING_CONFIRMED'),
  'create does not enqueue BOOKING_CONFIRMED');
check(JSON.stringify(historical) === historicalSnapshot
  && !fixture.isTargetedCalendarFixtureRecord_(historical),
  'historical E2E row cannot match the fixture selector');
check(!JSON.stringify(created).includes(allowlisted)
  && !/token|secret|bearer|rut|phone/i.test(JSON.stringify(created)),
  'operator evidence is sanitized');

const duplicate = context.nonprodCreateTargetedCalendarFixture();
check(duplicate.ok === false && duplicate.code === 'FIXTURE_ALREADY_EXISTS' && duplicate.replay === true
  && insertCalls === 1 && reservationRows.filter((row) => fixture.isTargetedCalendarFixtureRecord_(row)).length === 1,
  'duplicate fixture creation is rejected without a second event or row');

const insertEvent = calendarEvents[0];
const originalStart = record.current_start_at;
const originalEnd = record.current_end_at;
const meetReady = {
  ...insertEvent,
  etag: 'etag-meet-ready',
  updated: '2026-08-25T15:00:05.000Z',
  conferenceData: { conferenceId: 'meet-opaque-1', entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque' }] },
};
calendarEvents[0] = meetReady;
const metadataRun = context.processCalendarReconciliation_();
const afterMetadata = currentRecord();
check(metadataRun.ok === true && metadataRun.changed === 1,
  'real processCalendarReconciliation_ observes the fixture');
check(afterMetadata.calendar_event_id === 'event-targeted-opaque-1'
  && afterMetadata.current_start_at === originalStart && afterMetadata.current_end_at === originalEnd
  && afterMetadata.calendar_event_etag === 'etag-meet-ready'
  && afterMetadata.meet_status === 'available'
  && afterMetadata.calendar_change_source !== 'clinician'
  && afterMetadata.patient_reschedule_count === '0'
  && outboxRows.length === 0,
  'metadata-only change is classified by unchanged reconciliation as system refresh');

const movedStart = new Date(Date.parse(originalStart) + 3600000).toISOString();
const movedEnd = new Date(Date.parse(originalEnd) + 3600000).toISOString();
calendarEvents[0] = {
  ...meetReady,
  etag: 'etag-moved',
  updated: '2026-08-25T16:00:00.000Z',
  start: { dateTime: movedStart, timeZone: 'America/Santiago' },
  end: { dateTime: movedEnd, timeZone: 'America/Santiago' },
};
const moveRun = context.processCalendarReconciliation_();
const afterMove = currentRecord();
check(moveRun.ok === true && moveRun.changed === 1
  && afterMove.calendar_change_source === 'clinician'
  && afterMove.current_start_at === new Date(movedStart).toISOString()
  && afterMove.patient_reschedule_count === '0'
  && outboxRows.some((row) => row.event_type === 'CLINICIAN_RESCHEDULED' && row.state === 'pending'),
  'genuine same-event move uses unchanged reconcileCalendarChange_');
check(typeof reconciliation.reconcileCalendarChange_ === 'function'
  && typeof context.processCalendarReconciliation_ === 'function'
  && fixtureSource.includes('createLinkedBookingEvent')
  && !fixtureSource.includes('function reconcileCalendarChange_')
  && !fixtureSource.includes('function persistCalendarMetadataRefresh_'),
  'real reconciliation functions are used unchanged');

if (!outboxHeaders.length) outboxHeaders.splice(0, outboxHeaders.length, ...phase.OUTBOX_HEADERS);
outboxRows.push({
  rowNumber: outboxRows.length + 2,
  logical_key: 'lifecycle_historical_BOOKING_CONFIRMED_1',
  reservation_id: historical.reservation_id,
  event_type: 'BOOKING_CONFIRMED',
  notification_version: '1',
  state: 'pending',
  attempt_count: '0',
  created_at: '2026-08-23T12:00:00.000Z',
  last_attempt_at: '',
  last_result: '',
  disposition_reason: '',
  snapshot_service_type: 'initial',
  snapshot_modality: 'online',
  snapshot_start_at: historical.current_start_at,
  snapshot_end_at: historical.current_end_at,
  snapshot_meet_url: '',
  snapshot_meet_status: '',
  snapshot_booking_status: 'confirmed',
  snapshot_schedule_status: 'scheduled',
  snapshot_patient_reschedule_count: '1',
  source_operation_id: 'op_notification_historical001',
});
const clinicianOutbox = outboxRows.find((row) => row.event_type === 'CLINICIAN_RESCHEDULED');

networkCalls = 0;
removeCalls = 0;
const cleaned = context.nonprodCleanupTargetedCalendarFixture();
check(cleaned.ok === true && cleaned.cleaned === true && cleaned.alreadyClean !== true, 'cleanup terminalizes the active fixture');
check(networkCalls === 0, 'Flow transport never called on cleanup');
const cleanedRecord = currentRecord();
check(cleanedRecord.booking_status === 'cancelled' && cleanedRecord.schedule_status === 'cancelled'
  && cleanedRecord.slot_hold_expires_at === ''
  && cleanedRecord.cancellation_source === 'operator_nonprod'
  && cleanedRecord.reconciliation_state === fixture.TARGETED_CALENDAR_FIXTURE_CLEANUP_STATE
  && reservationRows.some((row) => row.reservation_id === cleanedRecord.reservation_id),
  'cleanup retains sanitized fixture audit and releases hold');
check(calendarEvents.length === 0 && removeCalls === 1, 'cleanup removes the synthetic Calendar event');
check(clinicianOutbox.state === 'superseded'
  && clinicianOutbox.disposition_reason === fixture.TARGETED_CALENDAR_FIXTURE_OUTBOX_DISPOSITION,
  'cleanup leaves no retryable targeted notification');
check(outboxRows.find((row) => row.reservation_id === historical.reservation_id).state === 'pending'
  && JSON.stringify(historical) === historicalSnapshot
  && historical.booking_status === 'confirmed',
  'historical rows cannot match cleanup selector');
check(mailCalls === 0, 'cleanup does not generate a clinician cancellation mail');

calendarEvents = [{
  id: 'event-targeted-opaque-1',
  etag: 'etag-deleted',
  updated: '2026-08-25T16:05:00.000Z',
  status: 'cancelled',
  deleted: true,
  start: { dateTime: movedStart },
  end: { dateTime: movedEnd },
  extendedProperties: { private: { source: 'fran_booking', link_key: fixture.targetedCalendarFixtureLinkKey_(), schema: 'fran_booking:v1' } },
}];
const afterCleanupReconcile = context.processCalendarReconciliation_();
check(afterCleanupReconcile.ok === true, 'reconciliation after cleanup stays fail-closed and succeeds');
check(currentRecord().booking_status === 'cancelled'
  && !outboxRows.some((row) => row.event_type === 'CLINICIAN_CANCELLED'),
  'cleanup avoids a misleading clinician cancellation notification');

removeCalls = 0;
const cleanedAgain = context.nonprodCleanupTargetedCalendarFixture();
check(cleanedAgain.ok === true && cleanedAgain.alreadyClean === true && cleanedAgain.cleaned === true
  && reservationRows.filter((row) => fixture.isTargetedCalendarFixtureRecord_(row)).length === 1,
  'cleanup is idempotent and never deletes the fixture audit row');

const recreated = context.nonprodCreateTargetedCalendarFixture();
check(recreated.ok === true && currentRecord().booking_status === 'confirmed'
  && currentRecord().schedule_status === 'scheduled'
  && currentRecord().patient_reschedule_count === '0'
  && reservationRows.filter((row) => fixture.isTargetedCalendarFixtureRecord_(row)).length === 1,
  'after cleanup the same synthetic identity can be reused');

const readback = context.nonprodReadTargetedCalendarFixture();
check(readback.ok === true && readback.reservationId === currentRecord().reservation_id
  && readback.calendarEventPresent === true,
  'read returns sanitized evidence for the active fixture');

console.log(`TARGETED_CALENDAR_FIXTURE_TESTS=PASS assertions=${assertions}`);

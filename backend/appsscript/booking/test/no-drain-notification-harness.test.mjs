import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createFixedDate } from './helpers/fixed-date.mjs';

const FixedDate = createFixedDate();

/**
 * No-drain multi-event notification harness.
 * Proves durable per-event outbox identity when the worker does not run
 * between lifecycle mutations.
 */
const files = ['../Code.js', '../Lifecycle.js', '../CalendarGateway.js', '../Reconciliation.js', '../RefundGateway.js'];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const allowlisted = 'qa+nonprod@example.test';
const capabilitySecret = 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz';
const propertyValues = {
  APP_ENV: 'nonprod', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://sandbox.flow.cl/api', FLOW_RETURN_URL: 'https://preview-example.pages.dev/pago-resultado',
  FLOW_CONFIRMATION_URL: 'https://preview-example.pages.dev/api/flow-confirmation',
  FLOW_REFUND_CALLBACK_URL: 'https://preview-example.pages.dev/api/refund-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: allowlisted, PATIENT_EMAIL_RECIPIENT_ALLOWLIST: allowlisted,
  IDEMPOTENCY_NAMESPACE: 'fran-nonprod-20260821', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
  CAPABILITY_TOKEN_SECRET: capabilitySecret,
};
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const digestBytes = (value) => {
  const text = String(value);
  if (text === 'synthetic-store') return bytes(Buffer.from('390f55363168', 'hex'));
  if (text === 'synthetic-calendar') return bytes(Buffer.from('6c0535f4450c', 'hex'));
  return bytes(createHash('sha256').update(text).digest());
};

let headers = [];
const byReservation = new Map();
let mailBodies = [];
let flowCreateCalls = 0;
let networkCalls = 0;
let eventStore = null;

function currentRows() { return [...byReservation.values()]; }
const outboxRows = [];
let outboxHeaders = [];
let spreadsheet = null;
function makeRange(targetHeaders, getRow, setCell) {
  return function(row, col, numRows, numCols) {
    return {
      getDisplayValues: () => [targetHeaders],
      setValue: (value) => setCell(row, col, value),
      setValues: (values) => {
        if (row === 1 && values && values[0]) {
          if (targetHeaders === outboxHeaders) {
            outboxHeaders.splice(0, outboxHeaders.length, ...values[0].map(String));
          }
        }
      },
    };
  };
}
const sheet = {
  getLastRow: () => 1 + byReservation.size,
  getLastColumn: () => headers.length,
  getRange: makeRange(headers, () => currentRows(), (row, col, value) => {
    if (row < 2) return;
    const current = currentRows()[row - 2];
    if (!current) return;
    current[headers[col - 1]] = String(value == null ? '' : value);
    byReservation.set(current.reservation_id, current);
  }),
  getDataRange: () => ({
    getValues: () => [headers, ...currentRows().map((row) => headers.map((header) => row[header] ?? ''))],
  }),
  appendRow: (row) => {
    const created = { rowNumber: byReservation.size + 2 };
    headers.forEach((header, index) => { created[header] = row[index] == null ? '' : String(row[index]); });
    byReservation.set(created.reservation_id, created);
  },
  getParent: () => spreadsheet,
};
const outboxSheet = {
  getLastRow: () => (outboxHeaders.length && (outboxRows.length || true) ? 1 + outboxRows.length : 0),
  getLastColumn: () => outboxHeaders.length,
  getRange: makeRange(outboxHeaders, () => outboxRows, (row, col, value) => {
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
  getId: () => 'synthetic-store',
  getSheetByName: (name) => {
    if (name === 'reservations_nonprod') return sheet;
    if (name === 'notification_outbox_nonprod') return outboxHeaders.length || outboxRows.length ? outboxSheet : null;
    return null;
  },
  insertSheet: (name) => {
    if (name === 'notification_outbox_nonprod') return outboxSheet;
    return sheet;
  },
};
outboxSheet.getLastRow = () => outboxHeaders.length ? 1 + outboxRows.length : 0;

const context = {
  console, Date: FixedDate, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math, encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
    computeDigest: (_a, value) => digestBytes(value),
    computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperties: () => ({ ...propertyValues }),
      getProperty: (key) => propertyValues[key] || '',
      setProperty: (key, value) => { propertyValues[key] = String(value); },
    }),
  },
  SpreadsheetApp: { openById: () => spreadsheet },
  CalendarApp: { getCalendarById: (id) => ({ getId: () => id }) },
  Calendar: {
    Freebusy: { query: () => ({ calendars: { 'synthetic-calendar': { busy: [] } } }) },
    Events: {
      list: (_id, request) => {
        if (request && request.privateExtendedProperty) {
          return { items: eventStore && eventStore.extendedProperties ? [eventStore] : [] };
        }
        return { items: eventStore ? [eventStore] : [], nextSyncToken: 'sync-1' };
      },
      get: () => eventStore,
      insert: (resource) => {
        eventStore = {
          id: 'event-sequential-1', etag: 'etag-1', updated: '2026-09-03T15:00:00.000Z', status: 'confirmed',
          start: resource.start, end: resource.end, extendedProperties: resource.extendedProperties,
          conferenceData: { conferenceId: 'meet-1', entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque-meet' }] },
        };
        return eventStore;
      },
      update: (resource) => {
        eventStore = Object.assign({}, eventStore, resource, { etag: 'etag-2', updated: '2026-09-03T16:00:00.000Z',
          conferenceData: eventStore.conferenceData });
        return eventStore;
      },
      remove: () => { eventStore = Object.assign({}, eventStore, { status: 'cancelled', deleted: true, etag: 'etag-3' }); },
    },
  },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  UrlFetchApp: {
    fetch: (url) => {
      networkCalls += 1;
      if (String(url).includes('/payment/create')) {
        flowCreateCalls += 1;
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ url: 'https://sandbox.flow.cl/app/web/pay', token: 'FLOWTOKENOPAQUE1234567890ABCD' }),
        };
      }
      if (String(url).includes('/payment/getStatus')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ status: 2, commerceOrder: currentRows()[0].commerce_order }),
        };
      }
      throw new Error('unexpected url ' + url);
    },
  },
  MailApp: { sendEmail: (payload) => { mailBodies.push(payload); return true; } },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }), deleteTrigger: () => {} },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);
headers = [...context.RESERVATION_HEADERS];
const phase = context.__PHASE_A_TEST_EXPORTS__;
outboxHeaders.splice(0, outboxHeaders.length, ...phase.OUTBOX_HEADERS);
const worker = context.__NOTIFICATION_OUTBOX_TEST_EXPORTS__;
const reconciliation = context.__RECONCILIATION_TEST_EXPORTS__;

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const record = () => currentRows()[0];
const schema = () => ({ headers, columns: Object.fromEntries(headers.map((h, i) => [h, i + 1])) });
const store = {
  records: () => currentRows(),
  loadByReservationId: (id) => byReservation.get(String(id)) || null,
  loadByCalendarEventId: (id) => currentRows().find((row) => row.calendar_event_id === String(id)) || null,
  loadByCalendarLinkKey: (key) => currentRows().find((row) => row.calendar_link_key === String(key)) || null,
  update: (current, fields) => {
    Object.assign(current, fields);
    byReservation.set(current.reservation_id, current);
    return current;
  },
};

function drainOutbox(now) {
  return worker.processLifecycleNotificationOutbox_({
    config: phase.readCapabilityConfig_(), store, resources: { sheet }, schema: schema(),
    requireCapabilitySecret_: () => capabilitySecret, now: now,
  });
}

function tokenFrom(body, label) {
  const match = String(body).match(new RegExp(label + ':.*token=([A-Za-z0-9_-]{64,256})'));
  return match && match[1];
}

function assertChileTime(body, localHm, message) {
  check(body.includes('Fecha y hora: ') && body.includes(localHm)
    && !body.includes('.000Z') && !/\d{4}-\d{2}-\d{2}T/.test(body), message);
}


const idempotencyKey = 'fran-nonprod-20260821-cccccccc-e89b-12d3-a456-4266141740cc';
const created = context.createFlowPayment_({
  postData: { contents: JSON.stringify({
    action: 'create_flow_payment', idempotencyKey, serviceType: 'initial', modality: 'online',
    date: '2026-09-03', time: '13:00', name: 'Synthetic', email: allowlisted, phone: '', patientRut: '', reason: '', message: '',
  }) },
});
check(created.ok, 'Flow create accepted');
const confirmed = context.flowConfirmation_({ parameter: { token: 'FLOWTOKENOPAQUE1234567890ABCD' } });
check(confirmed.ok && record().booking_status === 'confirmed', 'payment confirmed');
check(outboxRows.some((row) => row.event_type === 'BOOKING_CONFIRMED' && row.state === 'pending'),
  'confirmation has a durable pending outbox row');

const issued = phase.retryLifecycleNotification_({
  store, reservationId: record().reservation_id, eventType: 'BOOKING_CONFIRMED',
  now: Date.parse('2026-09-03T16:05:00.000Z'), requireCapabilitySecret_: () => capabilitySecret,
  lock: { tryLock: () => true, releaseLock: () => {} },
});
check(issued.ok && issued.capabilityTokens.RESCHEDULE && issued.capabilityTokens.CANCEL, 'live capabilities issued without sending');

const reschedule = context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: issued.capabilityTokens.RESCHEDULE, fecha: '2026-09-03', hora: '14:00' }) },
});
check(reschedule.ok && record().patient_reschedule_count === '1', 'patient reschedule mutates booking without a worker drain');
const scenarioA = outboxRows.filter((row) => row.reservation_id === record().reservation_id);
check(scenarioA.some((row) => row.event_type === 'BOOKING_CONFIRMED')
  && scenarioA.some((row) => row.event_type === 'PATIENT_RESCHEDULED' && row.state === 'pending'),
  'scenario A keeps independent confirmation and reschedule identities');
check(new Set(scenarioA.map((row) => row.logical_key)).size === scenarioA.length, 'logical keys are unique');

eventStore = Object.assign({}, eventStore, {
  start: { dateTime: '2026-09-03T20:00:00.000Z' }, end: { dateTime: '2026-09-03T21:00:00.000Z' },
  etag: 'etag-clinician', updated: '2026-09-03T17:30:00.000Z',
});
const move = reconciliation.reconcileCalendarChange_({
  store, event: eventStore,
  enqueueNotification: (updated) => worker.enqueueLifecycleNotification_(sheet, schema(), updated, 'CLINICIAN_RESCHEDULED'),
});
check(move.ok && record().current_start_at === '2026-09-03T20:00:00.000Z', 'clinician move updates live booking time');

const cancel = context.patientCancel_({ postData: { contents: JSON.stringify({ token: issued.capabilityTokens.CANCEL }) } });
check(cancel.ok && record().booking_status === 'cancelled', 'patient cancel without draining prior outbox events');

const beforeWorker = outboxRows.filter((row) => row.reservation_id === record().reservation_id);
const types = beforeWorker.map((row) => row.event_type);
check(types.includes('BOOKING_CONFIRMED') && types.includes('PATIENT_RESCHEDULED')
  && types.includes('CLINICIAN_RESCHEDULED') && types.includes('PATIENT_CANCELLED'),
  'scenario B retains all four logical events before any worker run');
check(beforeWorker.every((row) => row.state === 'pending' || row.state === 'superseded'),
  'no pending event was silently overwritten off the outbox');

const patientSnap = beforeWorker.find((row) => row.event_type === 'PATIENT_RESCHEDULED');
const clinicianSnap = beforeWorker.find((row) => row.event_type === 'CLINICIAN_RESCHEDULED');
check(patientSnap.snapshot_start_at !== clinicianSnap.snapshot_start_at
  && patientSnap.snapshot_start_at.includes('2026-09-03T18:00:00'),
  'patient-reschedule snapshot keeps the 14:00 Chile slot, not the later clinician time');

mailBodies = [];
const drained = drainOutbox(Date.parse('2026-09-03T18:00:00.000Z'));
check(drained.ok && drained.processed >= 4, 'worker processes every durable event after the mutations');
const after = outboxRows.filter((row) => row.reservation_id === record().reservation_id);
const byType = Object.fromEntries(after.map((row) => [row.event_type, row]));
check(byType.BOOKING_CONFIRMED.state === 'superseded' && byType.BOOKING_CONFIRMED.disposition_reason !== '',
  'unsent confirmation is explicitly superseded, not lost');
check(byType.PATIENT_RESCHEDULED.state === 'superseded' && byType.PATIENT_RESCHEDULED.disposition_reason === 'booking_cancelled',
  'unsent patient reschedule is explicitly superseded after cancel');
check(byType.CLINICIAN_RESCHEDULED.state === 'superseded' && byType.CLINICIAN_RESCHEDULED.disposition_reason === 'booking_cancelled',
  'unsent clinician reschedule is explicitly superseded after cancel');
check(byType.PATIENT_CANCELLED.state === 'sent', 'cancellation remains independently deliverable');
check(mailBodies.length === 1 && mailBodies[0].subject === 'Tu sesión fue cancelada'
  && !mailBodies[0].body.includes('Meet:') && !mailBodies[0].body.includes('Cancelar:'),
  'only the still-applicable cancellation mail is sent');
assertChileTime(mailBodies[0].body, '16:00', 'cancellation renders the clinician-updated Chile-local time');

worker.enqueueLifecycleNotification_(sheet, schema(), record(), 'PATIENT_CANCELLED');
check(after.filter((row) => row.event_type === 'PATIENT_CANCELLED').length === 1
  && byType.PATIENT_CANCELLED.state === 'sent',
  'same logical cancellation enqueue does not duplicate');

const replay = context.patientCancel_({ postData: { contents: JSON.stringify({ token: issued.capabilityTokens.CANCEL }) } });
check(replay.ok && replay.replay === true, 'terminal cancel replay is a no-op');

const missing = worker.memoryNotificationOutboxStore_([{
  logical_key: 'lifecycle_missing_BOOKING_CONFIRMED_1', reservation_id: 'missing-reservation',
  event_type: 'BOOKING_CONFIRMED', notification_version: '1', state: 'pending', attempt_count: '0',
  created_at: '2026-09-03T16:00:00.000Z', snapshot_start_at: '2026-09-03T17:00:00.000Z',
}]);
const missingRun = worker.processLifecycleNotificationOutbox_({
  config: phase.readCapabilityConfig_(), store, outboxStore: missing, resources: { sheet }, schema: schema(),
  requireCapabilitySecret_: () => capabilitySecret, now: Date.parse('2026-09-03T18:10:00.000Z'),
});
check(missingRun.results[0].code === 'NOTIFICATION_RECORD_MISSING' && missing.records()[0].state === 'failed',
  'missing booking row fails closed without a send');

const claimed = worker.memoryNotificationOutboxStore_([{
  logical_key: 'lifecycle_claimed_BOOKING_CONFIRMED_1', reservation_id: record().reservation_id,
  event_type: 'BOOKING_CONFIRMED', notification_version: '9', state: 'claimed', attempt_count: '1',
  created_at: '2026-09-03T16:00:00.000Z', snapshot_start_at: '2026-09-03T17:00:00.000Z',
  snapshot_booking_status: 'confirmed', snapshot_schedule_status: 'scheduled', snapshot_patient_reschedule_count: '0',
}]);
worker.enqueueLifecycleNotification_(sheet, schema(), record(), 'CLINICIAN_RESCHEDULED', null, claimed);
check(claimed.records().some((row) => row.state === 'claimed')
  && claimed.records().some((row) => row.event_type === 'CLINICIAN_RESCHEDULED' && row.state === 'pending'),
  'claimed event plus a concurrent later enqueue remain distinct');

const snapBooking = {
  reservation_id: 'fran-nonprod-20260821-reservation-snap-harness',
  patient_email: allowlisted,
  booking_status: 'confirmed',
  payment_status: 'paid',
  schedule_status: 'scheduled',
  service_type: 'initial',
  modality: 'online',
  current_start_at: '2026-09-03T20:00:00.000Z',
  current_end_at: '2026-09-03T21:00:00.000Z',
  patient_reschedule_count: '1',
  meet_url: 'https://meet.google.com/opaque-meet',
  meet_status: 'ready',
  notification_version: '3',
  ...phase.capabilityFields_(phase.capabilityForStorage_(phase.createCapability_('CANCEL', {
    secret: capabilitySecret, now: Date.parse('2026-09-03T16:00:00.000Z'),
  }))),
};
snapBooking.reschedule_capability_revoked_at = '2026-09-03T16:10:00.000Z';
const snapStore = {
  records: () => [snapBooking],
  loadByReservationId: (id) => String(id) === snapBooking.reservation_id ? snapBooking : null,
  update: (current, fields) => Object.assign(current, fields),
};
const snapOutbox = worker.memoryNotificationOutboxStore_([
  {
    logical_key: 'lifecycle_fran-nonprod-20260821-reservation-snap-harness_BOOKING_CONFIRMED_1',
    reservation_id: snapBooking.reservation_id, event_type: 'BOOKING_CONFIRMED', notification_version: '1',
    state: 'pending', attempt_count: '0', created_at: '2026-09-03T16:00:00.000Z',
    snapshot_start_at: '2026-09-03T17:00:00.000Z', snapshot_service_type: 'initial', snapshot_modality: 'online',
    snapshot_booking_status: 'confirmed', snapshot_schedule_status: 'scheduled', snapshot_patient_reschedule_count: '0',
    snapshot_meet_url: snapBooking.meet_url, snapshot_meet_status: 'ready',
  },
  {
    logical_key: 'lifecycle_fran-nonprod-20260821-reservation-snap-harness_PATIENT_RESCHEDULED_2',
    reservation_id: snapBooking.reservation_id, event_type: 'PATIENT_RESCHEDULED', notification_version: '2',
    state: 'pending', attempt_count: '0', created_at: '2026-09-03T16:10:00.000Z',
    snapshot_start_at: '2026-09-03T18:00:00.000Z', snapshot_service_type: 'initial', snapshot_modality: 'online',
    snapshot_booking_status: 'confirmed', snapshot_schedule_status: 'scheduled', snapshot_patient_reschedule_count: '1',
    snapshot_meet_url: snapBooking.meet_url, snapshot_meet_status: 'ready',
  },
]);
mailBodies = [];
const snapRun = worker.processLifecycleNotificationOutbox_({
  config: phase.readCapabilityConfig_(), store: snapStore, outboxStore: snapOutbox, resources: { sheet },
  schema: schema(), requireCapabilitySecret_: () => capabilitySecret, now: Date.parse('2026-09-03T18:20:00.000Z'),
});
check(snapRun.ok && snapOutbox.records().find((row) => row.event_type === 'BOOKING_CONFIRMED').state === 'superseded'
  && snapOutbox.records().find((row) => row.event_type === 'BOOKING_CONFIRMED').disposition_reason === 'schedule_changed'
  && snapOutbox.records().find((row) => row.event_type === 'PATIENT_RESCHEDULED').state === 'sent',
  'no-drain confirmation is superseded for schedule change while the reschedule event still sends');
check(mailBodies.length === 1 && mailBodies[0].subject === 'Tu sesión fue reagendada'
  && mailBodies[0].body.includes('14:00') && !mailBodies[0].body.includes('16:00')
  && mailBodies[0].body.includes('Cancelar:') && !mailBodies[0].body.includes('Reagendar:'),
  'patient-reschedule mail uses the 14:00 snapshot, not the later live clinician time');

check(record().booking_status === 'cancelled' && record().payment_status === 'paid'
  && record().refund_status === 'manual_review',
  'no-drain mutations still reach terminal cancel/manual_review');
check(networkCalls > 0 && flowCreateCalls === 1, 'harness used stubbed Flow only');

console.log(`NO_DRAIN_NOTIFICATION_HARNESS_TESTS=PASS assertions=${assertions}`);
console.log('REAL_NETWORK_SIDE_EFFECTS=0');

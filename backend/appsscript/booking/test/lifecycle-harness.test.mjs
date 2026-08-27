import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

/**
 * One no-network integrated lifecycle harness.
 * Complements focused suites; does not replace them.
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
function makeRange(targetHeaders, setCell) {
  return function(row, col) {
    return {
      getDisplayValues: () => [targetHeaders],
      setValue: (value) => setCell(row, col, value),
      setValues: (values) => {
        if (row === 1 && values && values[0] && targetHeaders === outboxHeaders) {
          outboxHeaders.splice(0, outboxHeaders.length, ...values[0].map(String));
        }
      },
    };
  };
}
const sheet = {
  getLastRow: () => 1 + byReservation.size,
  getLastColumn: () => headers.length,
  getRange: makeRange(headers, (row, col, value) => {
    if (row < 2) return;
    const record = currentRows()[row - 2];
    if (!record) return;
    record[headers[col - 1]] = String(value == null ? '' : value);
    byReservation.set(record.reservation_id, record);
  }),
  getDataRange: () => ({
    getValues: () => [headers, ...currentRows().map((record) => headers.map((header) => record[header] ?? ''))],
  }),
  appendRow: (row) => {
    const record = { rowNumber: byReservation.size + 2 };
    headers.forEach((header, index) => { record[header] = row[index] == null ? '' : String(row[index]); });
    byReservation.set(record.reservation_id, record);
  },
  getParent: () => spreadsheet,
};
const outboxSheet = {
  getLastRow: () => outboxHeaders.length ? 1 + outboxRows.length : 0,
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
  getId: () => 'synthetic-store',
  getSheetByName: (name) => {
    if (name === 'reservations_nonprod') return sheet;
    if (name === 'notification_outbox_nonprod') return outboxHeaders.length ? outboxSheet : null;
    return null;
  },
  insertSheet: (name) => name === 'notification_outbox_nonprod' ? outboxSheet : sheet,
};

const context = {
  console, Date, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math, encodeURIComponent, decodeURIComponent,
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
          id: 'event-lifecycle-1', etag: 'etag-1', updated: '2026-08-27T16:00:00.000Z', status: 'confirmed',
          start: resource.start, end: resource.end, extendedProperties: resource.extendedProperties,
          conferenceData: { conferenceId: 'meet-1', entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque-meet' }] },
        };
        return eventStore;
      },
      update: (resource) => {
        eventStore = Object.assign({}, eventStore, resource, { etag: 'etag-2', updated: '2026-08-27T17:00:00.000Z',
          conferenceData: eventStore.conferenceData });
        return eventStore;
      },
      remove: () => { eventStore = Object.assign({}, eventStore, { status: 'cancelled', deleted: true, etag: 'etag-3' }); },
    },
  },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  UrlFetchApp: {
    fetch: (url, options) => {
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
const refund = context.__REFUND_TEST_EXPORTS__;

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const record = () => currentRows()[0];

const idempotencyKey = 'fran-nonprod-20260821-aaaaaaaa-e89b-12d3-a456-4266141740aa';
const createPayload = {
  action: 'create_flow_payment', idempotencyKey, serviceType: 'initial', modality: 'online',
  date: '2026-08-27', time: '11:00', name: 'Synthetic', email: allowlisted, phone: '', patientRut: '', reason: '', message: '',
};

// free slot -> Flow create accepted
const created = context.createFlowPayment_({ postData: { contents: JSON.stringify(createPayload) } });
check(created.ok && flowCreateCalls === 1 && record().payment_status === 'pending', 'Flow create accepted for free slot');

// payment callback confirmed + one Calendar event + Meet
const confirmed = context.flowConfirmation_({ parameter: { token: 'FLOWTOKENOPAQUE1234567890ABCD' } });
check(confirmed.ok && confirmed.status === 'payment_confirmed', 'payment callback confirmed');
check(record().booking_status === 'confirmed' && record().schedule_status === 'scheduled'
  && record().calendar_event_id === 'event-lifecycle-1'
  && record().meet_url === 'https://meet.google.com/opaque-meet'
  && record().meet_conference_id === 'meet-1', 'one Calendar event + Meet persisted');
check(record().notification_patient_state === 'pending'
  && String(record().notification_outbox_key).includes('BOOKING_CONFIRMED'), 'confirmation queues outbox');

// initial notification with CTAs / Meet / allowlist
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
mailBodies = [];
const notify = worker.processLifecycleNotificationOutbox_({
  config: phase.readCapabilityConfig_(), store, resources: { sheet }, schema: { headers, columns: Object.fromEntries(headers.map((h, i) => [h, i + 1])) },
  requireCapabilitySecret_: () => capabilitySecret, now: Date.parse('2026-08-27T16:10:00.000Z'),
});
check(notify.ok && notify.results[0].ok && mailBodies.length === 1, 'initial notification delivered');
check(mailBodies[0].to === allowlisted && mailBodies[0].body.includes('Meet:')
  && mailBodies[0].body.includes('Reagendar:') && mailBodies[0].body.includes('Cancelar:'),
  'confirmation email has Meet + Reagendar + Cancelar for allowlisted recipient');
check(record().notification_patient_state === 'sent', 'sent notification state');
const rescheduleToken = (mailBodies[0].body.match(/open=reschedule[^\n]*token=([A-Za-z0-9_-]{64,256})|token=([A-Za-z0-9_-]{64,256})[^\n]*open=reschedule/) || [])
  .filter(Boolean).pop()
  || (mailBodies[0].body.match(/Reagendar:.*token=([A-Za-z0-9_-]{64,256})/) || [])[1];
const cancelToken = (mailBodies[0].body.match(/Cancelar:.*token=([A-Za-z0-9_-]{64,256})/) || [])[1];
check(rescheduleToken && cancelToken && !JSON.stringify(record()).includes(rescheduleToken)
  && !JSON.stringify(record()).includes(cancelToken), 'raw bearer never persisted');

// management lookup
const lookup = context.manageLookup_({ postData: { contents: JSON.stringify({ token: cancelToken }) } });
check(lookup.ok && lookup.capabilityType === 'CANCEL', 'management lookup with CANCEL capability');

// patient reschedule once, second rejected
const reschedule = context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: rescheduleToken, fecha: '2026-08-27', hora: '12:00' }) },
});
check(reschedule.ok && record().patient_reschedule_count === '1'
  && record().calendar_event_id === 'event-lifecycle-1'
  && record().meet_url === 'https://meet.google.com/opaque-meet'
  && record().payment_status === 'paid', 'patient reschedule keeps same event/Meet/payment and count=1');
check(record().notification_patient_state === 'pending'
  && String(record().notification_outbox_key).includes('PATIENT_RESCHEDULED')
  && String(record().notification_attempt_count) === '0',
  'patient reschedule queues despite prior sent confirmation');
const secondReschedule = context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: rescheduleToken, fecha: '2026-08-27', hora: '13:00' }) },
});
check(secondReschedule && secondReschedule.ok === false, 'second patient reschedule rejected');

// clinician move/reconciliation preserves count and payment
eventStore = Object.assign({}, eventStore, {
  start: { dateTime: '2026-08-27T18:00:00.000Z' }, end: { dateTime: '2026-08-27T19:00:00.000Z' },
  etag: 'etag-clinician', updated: '2026-08-27T18:30:00.000Z',
});
const move = reconciliation.reconcileCalendarChange_({
  store, event: eventStore,
  enqueueNotification: (updated) => worker.enqueueLifecycleNotification_(sheet, { headers, columns: Object.fromEntries(headers.map((h, i) => [h, i + 1])) }, updated, 'CLINICIAN_RESCHEDULED'),
});
check(move.ok && move.changed && record().patient_reschedule_count === '1' && record().payment_status === 'paid',
  'clinician move preserves payment and patient reschedule count');
check(record().notification_patient_state === 'pending'
  && String(record().notification_outbox_key).includes('CLINICIAN_RESCHEDULED')
  && String(record().notification_attempt_count) === '0',
  'clinician reschedule queues despite prior patient-reschedule notification');

// cancel + capacity release
const cancel = context.patientCancel_({ postData: { contents: JSON.stringify({ token: cancelToken }) } });
check(cancel.ok && record().booking_status === 'cancelled' && record().schedule_status === 'cancelled',
  'patient cancel releases booking/schedule');
check(context.ACTIVE_SLOT_STATES.indexOf(record().booking_status) === -1, 'cancelled booking no longer consumes availability');

// refund transition remains independent
record().refund_status = 'refund_requested';
const gateway = refund.createFlowRefundGateway_({
  apiKey: 'synthetic-flow-key', secretKey: 'synthetic-flow-secret',
  fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ token: 'refund-token-opaque', status: 'pending' }) }),
});
const refunded = refund.refundCreateOnce_({
  store, record: record(), gateway, receiverEmail: allowlisted, amount: String(context.NONPROD_FLOW_TEST_AMOUNT_CLP || 500),
  urlCallBack: propertyValues.FLOW_REFUND_CALLBACK_URL, commerceTrxId: record().commerce_order,
});
check(refunded.ok && record().refund_status === 'refund_pending', 'refund transitions independently of capacity');

// retry/rotation path remains available for a fresh confirmation-style record
const rotateCap = phase.createCapability_('CANCEL', { secret: capabilitySecret, now: Date.now() });
const rotateRecord = {
  reservation_id: 'fran-nonprod-20260821-reservation-rotate-harness',
  booking_status: 'confirmed', schedule_status: 'scheduled', patient_reschedule_count: '0', notification_version: '2',
  notification_outbox_key: 'lifecycle_fran-nonprod-20260821-reservation-rotate-harness_BOOKING_CONFIRMED_2',
  notification_patient_state: 'failed', notification_attempt_count: '1', patient_email: allowlisted,
  service_type: 'initial', modality: 'online', current_start_at: '2026-08-28T15:00:00.000Z',
  meet_url: 'https://meet.google.com/opaque-meet-2',
  ...phase.capabilityFields_(phase.capabilityForStorage_(rotateCap)),
  ...phase.capabilityFields_(phase.capabilityForStorage_(phase.createCapability_('RESCHEDULE', { secret: capabilitySecret, now: Date.now() }))),
};
const rotateStore = {
  records: () => [rotateRecord],
  loadByReservationId: (id) => String(id) === rotateRecord.reservation_id ? rotateRecord : null,
  update: (current, fields) => Object.assign(current, fields),
};
mailBodies = [];
const rotateOutbox = worker.memoryNotificationOutboxStore_([{
  logical_key: rotateRecord.notification_outbox_key,
  reservation_id: rotateRecord.reservation_id,
  event_type: 'BOOKING_CONFIRMED',
  notification_version: '2',
  state: 'failed',
  attempt_count: '1',
  created_at: '2026-08-28T15:00:00.000Z',
  snapshot_service_type: 'initial',
  snapshot_modality: 'online',
  snapshot_start_at: rotateRecord.current_start_at,
  snapshot_end_at: '',
  snapshot_meet_url: rotateRecord.meet_url,
  snapshot_meet_status: '',
  snapshot_booking_status: 'confirmed',
  snapshot_schedule_status: 'scheduled',
  snapshot_patient_reschedule_count: '0',
}]);
const retry = worker.processLifecycleNotificationOutbox_({
  config: phase.readCapabilityConfig_(), store: rotateStore, outboxStore: rotateOutbox, resources: { sheet },
  schema: { headers, columns: Object.fromEntries(headers.map((h, i) => [h, i + 1])) },
  requireCapabilitySecret_: () => capabilitySecret, now: Date.now(),
});
check(retry.ok && rotateRecord.notification_patient_state === 'sent' && mailBodies.length === 1, 'notification retry/rotation reaches terminal sent');

check(networkCalls > 0 && flowCreateCalls === 1, 'harness used stubbed Flow only for create/getStatus');
const persisted = JSON.stringify(currentRows());
check(!persisted.includes('script.google.com') && !persisted.includes('script.googleusercontent.com')
  && !persisted.includes('synthetic-flow-secret') && !persisted.includes(capabilitySecret),
  'no private Apps Script URL or signing secrets in persisted rows');

console.log(`LIFECYCLE_HARNESS_TESTS=PASS assertions=${assertions}`);
console.log('REAL_NETWORK_SIDE_EFFECTS=0');

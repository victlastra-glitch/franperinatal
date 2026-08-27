import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

/**
 * Sequential lifecycle notification harness.
 * Proves multiple distinct patient emails on one booking, without network.
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
const sheet = {
  getLastRow: () => 1 + byReservation.size,
  getLastColumn: () => headers.length,
  getRange: (row, col) => ({
    getDisplayValues: () => [headers],
    setValue: (value) => {
      if (row < 2) return;
      const current = currentRows()[row - 2];
      if (!current) return;
      current[headers[col - 1]] = String(value == null ? '' : value);
      byReservation.set(current.reservation_id, current);
    },
  }),
  getDataRange: () => ({
    getValues: () => [headers, ...currentRows().map((row) => headers.map((header) => row[header] ?? ''))],
  }),
  appendRow: (row) => {
    const created = { rowNumber: byReservation.size + 2 };
    headers.forEach((header, index) => { created[header] = row[index] == null ? '' : String(row[index]); });
    byReservation.set(created.reservation_id, created);
  },
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
  SpreadsheetApp: { openById: () => ({ getId: () => 'synthetic-store', getSheetByName: () => sheet }) },
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
          id: 'event-sequential-1', etag: 'etag-1', updated: '2026-08-27T15:00:00.000Z', status: 'confirmed',
          start: resource.start, end: resource.end, extendedProperties: resource.extendedProperties,
          conferenceData: { conferenceId: 'meet-1', entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque-meet' }] },
        };
        return eventStore;
      },
      update: (resource) => {
        eventStore = Object.assign({}, eventStore, resource, { etag: 'etag-2', updated: '2026-08-27T16:00:00.000Z',
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

const idempotencyKey = 'fran-nonprod-20260821-bbbbbbbb-e89b-12d3-a456-4266141740bb';
const created = context.createFlowPayment_({
  postData: { contents: JSON.stringify({
    action: 'create_flow_payment', idempotencyKey, serviceType: 'initial', modality: 'online',
    date: '2026-08-27', time: '13:00', name: 'Synthetic', email: allowlisted, phone: '', patientRut: '', reason: '', message: '',
  }) },
});
check(created.ok && flowCreateCalls === 1, 'Flow create accepted');
const confirmed = context.flowConfirmation_({ parameter: { token: 'FLOWTOKENOPAQUE1234567890ABCD' } });
check(confirmed.ok && record().booking_status === 'confirmed' && record().meet_url === 'https://meet.google.com/opaque-meet',
  'payment confirmed with one Meet');
check(record().notification_patient_state === 'pending'
  && String(record().notification_outbox_key).includes('BOOKING_CONFIRMED'), 'confirmation queued');
const confirmationKey = String(record().notification_outbox_key);

mailBodies = [];
const sentConfirmation = drainOutbox(Date.parse('2026-08-27T16:10:00.000Z'));
check(sentConfirmation.ok && sentConfirmation.results[0].ok && mailBodies.length === 1, 'confirmation sent once');
check(mailBodies[0].subject === 'Confirmación de tu sesión', 'confirmation subject');
assertChileTime(mailBodies[0].body, '13:00', 'confirmation uses America/Santiago local time');
check(mailBodies[0].body.includes('Meet: https://meet.google.com/opaque-meet')
  && mailBodies[0].body.includes('Reagendar:') && mailBodies[0].body.includes('Cancelar:')
  && mailBodies[0].body.includes('Primera sesión / Evaluación')
  && mailBodies[0].body.includes('Modalidad: Online'),
  'confirmation has Meet + Reagendar + Cancelar + localized labels');
const confirmationRescheduleToken = tokenFrom(mailBodies[0].body, 'Reagendar');
const confirmationCancelToken = tokenFrom(mailBodies[0].body, 'Cancelar');
check(confirmationRescheduleToken && confirmationCancelToken, 'confirmation issues both capabilities');
mailBodies = [];
const replayConfirmation = drainOutbox(Date.parse('2026-08-27T16:11:00.000Z'));
check(replayConfirmation.processed === 0 && mailBodies.length === 0
  && record().notification_patient_state === 'sent', 'confirmation replay does not resend');

worker.enqueueLifecycleNotification_(sheet, schema(), record(), 'BOOKING_CONFIRMED');
check(record().notification_patient_state === 'sent' && record().notification_outbox_key === confirmationKey,
  'same logical confirmation enqueue is a no-op after sent');

const reschedule = context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: confirmationRescheduleToken, fecha: '2026-08-27', hora: '14:00' }) },
});
check(reschedule.ok && record().patient_reschedule_count === '1' && record().payment_status === 'paid',
  'patient reschedule succeeds and preserves payment');
check(record().notification_patient_state === 'pending'
  && String(record().notification_outbox_key).includes('PATIENT_RESCHEDULED')
  && String(record().notification_attempt_count) === '0'
  && record().notification_outbox_key !== confirmationKey,
  'patient reschedule queues a new logical notification despite prior sent confirmation');
const patientRescheduleKey = String(record().notification_outbox_key);
check(phase.reconstructLifecycleEventType_(record()) === 'PATIENT_RESCHEDULED', 'reschedule logical key reconstructs');

mailBodies = [];
const sentReschedule = drainOutbox(Date.parse('2026-08-27T16:20:00.000Z'));
check(sentReschedule.ok && sentReschedule.results[0].ok && mailBodies.length === 1, 'patient reschedule email sent once');
check(mailBodies[0].subject === 'Tu sesión fue reagendada', 'patient reschedule subject');
assertChileTime(mailBodies[0].body, '14:00', 'patient reschedule uses Chile local time');
check(mailBodies[0].body.includes('Meet: https://meet.google.com/opaque-meet')
  && mailBodies[0].body.includes('Cancelar:') && !mailBodies[0].body.includes('Reagendar:'),
  'patient reschedule is CANCEL-only with Meet');
const patientCancelToken = tokenFrom(mailBodies[0].body, 'Cancelar');
check(patientCancelToken && patientCancelToken !== confirmationCancelToken, 'reschedule rotates a surviving CANCEL capability');
check(!phase.verifyCapability_(confirmationRescheduleToken, 'RESCHEDULE', phase.capabilityFromRecord_(record(), 'RESCHEDULE'), {
  secret: capabilitySecret, now: Date.parse('2026-08-27T16:20:00.000Z'),
}), 'stale RESCHEDULE remains invalid');
mailBodies = [];
check(drainOutbox(Date.parse('2026-08-27T16:21:00.000Z')).processed === 0 && mailBodies.length === 0,
  'patient reschedule replay does not resend');
worker.enqueueLifecycleNotification_(sheet, schema(), record(), 'PATIENT_RESCHEDULED');
check(record().notification_outbox_key === patientRescheduleKey && record().notification_patient_state === 'sent',
  'same logical patient-reschedule enqueue does not duplicate');

eventStore = Object.assign({}, eventStore, {
  start: { dateTime: '2026-08-27T20:00:00.000Z' }, end: { dateTime: '2026-08-27T21:00:00.000Z' },
  etag: 'etag-clinician', updated: '2026-08-27T17:30:00.000Z',
});
const move = reconciliation.reconcileCalendarChange_({
  store, event: eventStore,
  enqueueNotification: (updated) => worker.enqueueLifecycleNotification_(sheet, schema(), updated, 'CLINICIAN_RESCHEDULED'),
});
check(move.ok && move.changed && record().patient_reschedule_count === '1' && record().payment_status === 'paid',
  'clinician move preserves payment and patient quota');
check(record().notification_patient_state === 'pending'
  && String(record().notification_outbox_key).includes('CLINICIAN_RESCHEDULED')
  && String(record().notification_attempt_count) === '0'
  && record().notification_outbox_key !== patientRescheduleKey,
  'clinician reschedule queues despite prior sent patient-reschedule notification');
const clinicianKey = String(record().notification_outbox_key);
check(clinicianKey !== confirmationKey && clinicianKey !== patientRescheduleKey, 'logical keys differ across event types');

mailBodies = [];
const sentClinician = drainOutbox(Date.parse('2026-08-27T17:40:00.000Z'));
check(sentClinician.ok && sentClinician.results[0].ok && mailBodies.length === 1, 'clinician reschedule email sent once');
check(mailBodies[0].subject === 'Tu sesión fue reagendada', 'clinician reschedule subject');
assertChileTime(mailBodies[0].body, '16:00', 'clinician reschedule uses Chile local time for 20:00Z');
check(mailBodies[0].body.includes('Meet: https://meet.google.com/opaque-meet')
  && mailBodies[0].body.includes('Cancelar:') && !mailBodies[0].body.includes('Reagendar:'),
  'clinician reschedule is CANCEL-only with Meet');
const clinicianCancelToken = tokenFrom(mailBodies[0].body, 'Cancelar');
check(clinicianCancelToken && clinicianCancelToken !== patientCancelToken, 'clinician email rotates CANCEL without resurrecting RESCHEDULE');
mailBodies = [];
check(drainOutbox(Date.parse('2026-08-27T17:41:00.000Z')).processed === 0 && mailBodies.length === 0,
  'clinician reschedule replay does not resend');

const cancel = context.patientCancel_({ postData: { contents: JSON.stringify({ token: clinicianCancelToken }) } });
check(cancel.ok && record().booking_status === 'cancelled' && record().schedule_status === 'cancelled',
  'patient cancel is terminal for booking/schedule');
check(context.ACTIVE_SLOT_STATES.indexOf(record().booking_status) === -1, 'capacity is released independently of mail');
check(record().payment_status === 'paid' && record().patient_reschedule_count === '1'
  && record().refund_status === 'manual_review'
  && record().refund_last_error_code === 'BUSINESS_POLICY_TBD',
  'cancel keeps historical payment, quota=1, and manual_review refund policy');
check(record().notification_internal_state === 'pending'
  && String(record().notification_outbox_key).includes('PATIENT_CANCELLED')
  && String(record().notification_attempt_count) === '0',
  'cancellation queues on the internal channel despite prior sent patient notifications');
const cancelKey = String(record().notification_outbox_key);

mailBodies = [];
const sentCancel = drainOutbox(Date.parse('2026-08-27T17:50:00.000Z'));
check(sentCancel.ok && sentCancel.results[0].ok && mailBodies.length === 1, 'cancellation email sent once');
check(mailBodies[0].subject === 'Tu sesión fue cancelada', 'cancellation subject');
assertChileTime(mailBodies[0].body, '16:00', 'cancellation shows Chile local appointment context');
check(mailBodies[0].body.includes('Confirmamos la cancelación')
  && !mailBodies[0].body.includes('Meet:')
  && !/meet\.google\.com/i.test(mailBodies[0].body)
  && !mailBodies[0].body.includes('Reagendar:')
  && !mailBodies[0].body.includes('Cancelar:'),
  'cancellation has no Meet, no Reagendar, and no Cancelar');
mailBodies = [];
check(drainOutbox(Date.parse('2026-08-27T17:51:00.000Z')).processed === 0 && mailBodies.length === 0,
  'cancellation notification replay does not resend');
const replayCancel = context.patientCancel_({ postData: { contents: JSON.stringify({ token: clinicianCancelToken }) } });
check(replayCancel.ok && replayCancel.replay === true && mailBodies.length === 0
  && record().notification_internal_state === 'sent'
  && record().notification_outbox_key === cancelKey,
  'cancel replay is a no-op for mail and terminal state');
worker.enqueueLifecycleNotification_(sheet, schema(), record(), 'PATIENT_CANCELLED');
check(record().notification_internal_state === 'sent' && mailBodies.length === 0,
  'same logical cancellation enqueue does not duplicate');

check(!phase.verifyCapability_(clinicianCancelToken, 'CANCEL', phase.capabilityFromRecord_(record(), 'CANCEL'), {
  secret: capabilitySecret, now: Date.parse('2026-08-27T17:52:00.000Z'),
}), 'terminal cancel revokes the live CANCEL capability');
check(String(record().reschedule_capability_revoked_at || '') !== ''
  || !phase.verifyCapability_(confirmationRescheduleToken, 'RESCHEDULE', phase.capabilityFromRecord_(record(), 'RESCHEDULE'), {
    secret: capabilitySecret, now: Date.parse('2026-08-27T17:52:00.000Z'),
  }), 'RESCHEDULE remains unusable after terminal cancel');

const formattedWinter = worker.formatPatientFacingDateTime_('2026-08-27T17:00:00.000Z');
check(formattedWinter === 'jueves 27 de agosto de 2026, 13:00', 'canonical Chile winter local format');
check(worker.PATIENT_EMAIL_TIME_ZONE === 'America/Santiago', 'patient email timezone is America/Santiago');
const dstBefore = phase.formatPatientFacingDateTime_(phase.startAt_('2026-04-04', '10:00'));
const dstAfter = phase.formatPatientFacingDateTime_(phase.startAt_('2026-04-05', '10:00'));
check(dstBefore.includes('10:00') && dstAfter.includes('10:00') && dstBefore !== dstAfter,
  'patient-facing formatter is DST-safe around the April transition');

const poison = {
  rowNumber: 99,
  reservation_id: 'fran-nonprod-20260821-reservation-poison',
  idempotency_key: 'fran-nonprod-20260821-poison-key-001',
  service_type: 'initial',
  modality: 'online',
  patient_email: allowlisted,
  current_start_at: '2026-08-27T17:00:00.000Z',
  booking_status: 'confirmed',
  payment_status: 'paid',
  schedule_status: 'scheduled',
  patient_reschedule_count: '1',
  notification_version: '1',
  notification_outbox_key: 'lifecycle_fran-nonprod-20260821-reservation-poison_BOOKING_CONFIRMED_1',
  notification_patient_state: 'failed',
  notification_internal_state: '',
  notification_attempt_count: String(phase.MAX_NOTIFICATION_ATTEMPTS),
  notification_last_result: 'max_attempts',
  reconciliation_state: 'notification_max_attempts',
  meet_url: 'https://meet.google.com/opaque-meet-poison',
  meet_status: 'ready',
  ...phase.capabilityFields_(phase.capabilityForStorage_(phase.createCapability_('CANCEL', {
    secret: capabilitySecret, now: Date.parse('2026-08-27T16:00:00.000Z'),
  }))),
  ...phase.capabilityFields_(phase.capabilityForStorage_(phase.createCapability_('RESCHEDULE', {
    secret: capabilitySecret, now: Date.parse('2026-08-27T16:00:00.000Z'),
  }))),
};
poison.reschedule_capability_revoked_at = '2026-08-27T16:05:00.000Z';
const poisonSheet = {
  getRange: (row, col) => ({
    setValue: (value) => { poison[headers[col - 1]] = String(value == null ? '' : value); },
  }),
};
const poisonStore = {
  records: () => [poison],
  loadByReservationId: (id) => String(id) === poison.reservation_id ? poison : null,
  update: (current, fields) => Object.assign(current, fields),
};
worker.enqueueLifecycleNotification_(poisonSheet, schema(), poison, 'PATIENT_RESCHEDULED');
check(String(poison.notification_outbox_key).includes('PATIENT_RESCHEDULED')
  && poison.notification_patient_state === 'pending'
  && String(poison.notification_attempt_count) === '0'
  && poison.reconciliation_state === '',
  'prior max-attempt event does not poison a later logical event');
mailBodies = [];
const poisonRun = worker.processLifecycleNotificationOutbox_({
  config: phase.readCapabilityConfig_(), store: poisonStore, resources: { sheet: poisonSheet }, schema: schema(),
  requireCapabilitySecret_: () => capabilitySecret, now: Date.parse('2026-08-27T16:30:00.000Z'),
});
check(poisonRun.ok && poisonRun.results[0].ok && poison.notification_patient_state === 'sent'
  && Number(poison.notification_attempt_count) === 1 && mailBodies.length === 1
  && mailBodies[0].subject === 'Tu sesión fue reagendada' && !mailBodies[0].body.includes('Reagendar:'),
  'later logical event starts a fresh attempt lifecycle and sends CANCEL-only');

check(record().booking_status === 'cancelled' && record().schedule_status === 'cancelled'
  && context.ACTIVE_SLOT_STATES.indexOf(record().booking_status) === -1
  && record().payment_status === 'paid' && record().refund_status === 'manual_review',
  'terminal booking remains cancelled with historical payment and manual_review');
check(networkCalls > 0 && flowCreateCalls === 1, 'harness used stubbed Flow only');
const persisted = JSON.stringify(currentRows());
check(!persisted.includes(confirmationRescheduleToken) && !persisted.includes(clinicianCancelToken)
  && !persisted.includes(capabilitySecret), 'raw bearers and secrets are not persisted');

console.log(`SEQUENTIAL_NOTIFICATION_HARNESS_TESTS=PASS assertions=${assertions}`);
console.log('REAL_NETWORK_SIDE_EFFECTS=0');

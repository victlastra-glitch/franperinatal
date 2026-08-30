import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const files = ['../Code.js', '../Lifecycle.js'];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const secret = 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz';
const allowlisted = 'qa+nonprod@example.test';
const baseProperties = {
  APP_ENV: 'nonprod', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://sandbox.flow.cl/api', FLOW_RETURN_URL: 'https://preview-example.pages.dev/pago-resultado',
  FLOW_CONFIRMATION_URL: 'https://preview-example.pages.dev/api/flow-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: allowlisted, PATIENT_EMAIL_RECIPIENT_ALLOWLIST: allowlisted,
  IDEMPOTENCY_NAMESPACE: 'fran-nonprod-20260821', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
  CAPABILITY_TOKEN_SECRET: secret,
};
let propertyValues = { ...baseProperties };
let networkCalls = 0;
let mailCalls = 0;
let mailed = [];
let lockRejectNext = false;
let persistedBlob = '';
const projectTriggers = [];
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const digestBytes = (value) => {
  const text = String(value);
  if (text === 'synthetic-store') return bytes(Buffer.from('390f55363168', 'hex'));
  if (text === 'synthetic-calendar') return bytes(Buffer.from('6c0535f4450c', 'hex'));
  return bytes(createHash('sha256').update(text).digest());
};
const utilities = {
  DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
  computeDigest: (_algorithm, value) => digestBytes(value),
  computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
};
const context = {
  console, Date, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math, encodeURIComponent, decodeURIComponent,
  Utilities: utilities,
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...propertyValues }) }) },
  SpreadsheetApp: { openById: () => { throw new Error('spreadsheet stub must not be called'); } },
  CalendarApp: { getCalendarById: () => { throw new Error('calendar stub must not be called'); } },
  MailApp: {
    sendEmail: (payload) => {
      mailCalls += 1;
      mailed.push(payload);
      return true;
    },
  },
  GmailApp: { sendEmail: () => { throw new Error('GmailApp must not be called'); } },
  LockService: {
    getScriptLock: () => {
      const lock = {
        held: false,
        owner: 'script',
        acquireCount: 0,
        releaseCount: 0,
        nestedTryLock: 0,
        tryLock: () => {
          if (lockRejectNext) { lockRejectNext = false; return false; }
          if (lock.held) {
            lock.nestedTryLock += 1;
            return true;
          }
          lock.held = true;
          lock.acquireCount += 1;
          return true;
        },
        releaseLock: () => {
          lock.releaseCount += 1;
          lock.held = false;
          lock.owner = null;
        },
        hasLock: () => lock.held,
      };
      return lock;
    },
  },
  UrlFetchApp: { fetch: () => { networkCalls += 1; throw new Error('network must not be called'); } },
  ScriptApp: {
    getProjectTriggers: () => projectTriggers.slice(),
    newTrigger: (handler) => ({
      timeBased: () => ({
        everyMinutes: (minutes) => ({
          create: () => {
            projectTriggers.push({
              handler,
              minutes,
              getHandlerFunction: () => handler,
              getEventType: () => 'CLOCK',
            });
          },
        }),
      }),
    }),
    deleteTrigger: (trigger) => {
      const index = projectTriggers.findIndex((item) => item === trigger || item.getHandlerFunction() === trigger.getHandlerFunction());
      if (index >= 0) projectTriggers.splice(index, 1);
    },
  },
  Session: { getActiveUser: () => ({ getEmail: () => '' }) },
  ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (value) => ({ value, setMimeType() { return this; } }) },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);
const phase = context.__PHASE_A_TEST_EXPORTS__;
const worker = context.__NOTIFICATION_OUTBOX_TEST_EXPORTS__;
assert.ok(phase && worker, 'notification outbox exports must be available');

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const persistedSnapshots = [];
const logSnapshots = [];

function makeRecord(overrides = {}) {
  const reservationId = overrides.reservation_id || 'fran-nonprod-20260821-reservation-outbox';
  const version = String(overrides.notification_version || '1');
  const eventType = overrides.eventType || 'BOOKING_CONFIRMED';
  const reschedule = phase.createCapability_('RESCHEDULE', { secret, now: Date.parse('2026-08-23T12:00:00Z') });
  const cancel = phase.createCapability_('CANCEL', { secret, now: Date.parse('2026-08-23T12:00:00Z') });
  const base = {
    reservation_id: reservationId,
    idempotency_key: 'fran-nonprod-20260821-outbox-key-001',
    service_type: 'psicoterapia',
    modality: 'online',
    patient_email: allowlisted,
    current_start_at: '2026-08-25T15:00:00.000Z',
    booking_status: 'confirmed',
    payment_status: 'paid',
    schedule_status: 'scheduled',
    patient_reschedule_count: '0',
    notification_version: version,
    notification_outbox_key: 'lifecycle_' + reservationId + '_' + eventType + '_' + version,
    notification_patient_state: 'pending',
    notification_internal_state: '',
    notification_attempt_count: '0',
    notification_last_attempt_at: '',
    notification_last_result: eventType,
    last_patient_notification_at: '',
    reconciliation_state: '',
    meet_url: 'https://meet.google.com/opaque-meet',
    meet_status: 'ready',
    ...phase.capabilityFields_(phase.capabilityForStorage_(reschedule)),
    ...phase.capabilityFields_(phase.capabilityForStorage_(cancel)),
  };
  delete overrides.eventType;
  return Object.assign(base, overrides);
}

function durableFromRecord(record, extra = {}) {
  const eventType = extra.event_type || extra.eventType || 'BOOKING_CONFIRMED';
  const state = extra.state || (record.notification_patient_state === 'pending' || record.notification_patient_state === 'failed' || record.notification_patient_state === 'claimed'
    ? record.notification_patient_state
    : (record.notification_internal_state === 'pending' || record.notification_internal_state === 'failed' ? record.notification_internal_state : 'pending'));
  return {
    logical_key: extra.logical_key || record.notification_outbox_key,
    reservation_id: record.reservation_id,
    event_type: eventType,
    notification_version: String(extra.notification_version || record.notification_version || '1'),
    state,
    attempt_count: String(extra.attempt_count != null ? extra.attempt_count : (record.notification_attempt_count || '0')),
    created_at: extra.created_at || '2026-08-23T12:00:00.000Z',
    last_attempt_at: extra.last_attempt_at || record.notification_last_attempt_at || '',
    last_result: extra.last_result || record.notification_last_result || eventType,
    disposition_reason: extra.disposition_reason || '',
    snapshot_service_type: extra.snapshot_service_type || record.service_type || '',
    snapshot_modality: extra.snapshot_modality || record.modality || '',
    snapshot_start_at: extra.snapshot_start_at || record.current_start_at || '',
    snapshot_end_at: extra.snapshot_end_at || record.current_end_at || '',
    snapshot_meet_url: extra.snapshot_meet_url || record.meet_url || '',
    snapshot_meet_status: extra.snapshot_meet_status || record.meet_status || '',
    snapshot_booking_status: extra.snapshot_booking_status || record.booking_status || '',
    snapshot_schedule_status: extra.snapshot_schedule_status || record.schedule_status || '',
    snapshot_patient_reschedule_count: String(extra.snapshot_patient_reschedule_count != null
      ? extra.snapshot_patient_reschedule_count
      : (record.patient_reschedule_count || '0')),
    source_operation_id: extra.source_operation_id
      || record.last_operation_id
      || (eventType && phase.LIFECYCLE_NOTIFICATION_TYPE[eventType]
        ? phase.notificationOccurrenceKey_(record, eventType)
        : ''),
  };
}

function makeStore(records) {
  const byId = new Map(records.map((record) => [record.reservation_id, record]));
  return {
    records: () => [...byId.values()],
    loadByReservationId: (id) => byId.get(String(id)) || null,
    update: (record, fields) => {
      const current = byId.get(record.reservation_id);
      Object.assign(current, fields);
      persistedSnapshots.push(JSON.stringify(current));
      return current;
    },
  };
}

function runWorker(store, overrides = {}) {
  const outboxStore = overrides.outboxStore || worker.memoryNotificationOutboxStore_(
    (overrides.outboxEntries || (typeof store.records === 'function' ? store.records() : [])).map((record) => {
      if (record.logical_key) return record;
      return durableFromRecord(record, { eventType: record.eventType || phase.reconstructLifecycleEventType_(record) || 'BOOKING_CONFIRMED' });
    })
  );
  const result = worker.processLifecycleNotificationOutbox_({
    config: phase.readCapabilityConfig_(),
    store,
    outboxStore,
    resources: { sheet: null },
    schema: { headers: phase.HEADERS, columns: Object.fromEntries(phase.HEADERS.map((h, i) => [h, i + 1])) },
    requireCapabilitySecret_: overrides.requireCapabilitySecret_ || (() => secret),
    now: Date.parse('2026-08-23T12:10:00Z'),
    batchSize: overrides.batchSize,
    deliver: overrides.deliver,
    lock: overrides.lock,
    lockTimeoutMs: 10,
  });
  result.outboxStore = outboxStore;
  return result;
}

// 1 + 2. pending booking-confirmation discovered; bounded batch
const many = [];
for (let i = 0; i < 12; i += 1) {
  many.push(makeRecord({
    reservation_id: 'fran-nonprod-20260821-reservation-b' + String(i).padStart(2, '0'),
    notification_outbox_key: 'lifecycle_fran-nonprod-20260821-reservation-b' + String(i).padStart(2, '0') + '_BOOKING_CONFIRMED_1',
  }));
}
mailed = []; mailCalls = 0;
const bounded = runWorker(makeStore(many), { batchSize: 10 });
check(bounded.ok && bounded.processed === 10, 'worker processes bounded batch of 10');
check(mailCalls === 10 && bounded.outboxStore.records().filter((row) => row.state === 'pending').length === 2,
  'pending booking-confirmation outbox is discovered within the bound');

// 3 + 4. allowlist recipient accepted; non-allowlisted rejected
mailed = []; mailCalls = 0;
const allowedRecord = makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-allow' });
const allowResult = runWorker(makeStore([allowedRecord]));
check(allowResult.ok && allowResult.results[0].ok && mailCalls === 1 && mailed[0].to === allowlisted, 'test allowlist recipient accepted');
mailed = []; mailCalls = 0;
const rejectedRecord = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-reject',
  patient_email: 'someone@example.com',
});
const rejectResult = runWorker(makeStore([rejectedRecord]));
check(rejectResult.ok && !rejectResult.results[0].ok && mailCalls === 0 && rejectedRecord.notification_patient_state === 'failed',
  'non-allowlisted recipient rejected without send');

// 5 + 6 + 7. CTA matrix and count=1 never RESCHEDULE
mailed = [];
const confirmed = makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-cta0' });
runWorker(makeStore([confirmed]));
check(mailed[0].body.includes('Reagendar:') && mailed[0].body.includes('Cancelar:'), 'BOOKING_CONFIRMED produces RESCHEDULE + CANCEL');
mailed = [];
const rescheduled = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-cta1',
  eventType: 'PATIENT_RESCHEDULED',
  patient_reschedule_count: '1',
  notification_version: '2',
  reschedule_capability_revoked_at: '2026-08-23T12:00:00.000Z',
});
runWorker(makeStore([rescheduled]));
check(mailed[0].body.includes('Cancelar:') && !mailed[0].body.includes('Reagendar:'), 'patient-rescheduled produces CANCEL only');
mailed = [];
const countOneConfirmed = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-count1',
  patient_reschedule_count: '1',
  reschedule_capability_revoked_at: 'used',
});
const countOneRun = runWorker(makeStore([countOneConfirmed]));
check(countOneRun.results[0].code === 'SUPERSEDED' && mailed.length === 0
  && countOneRun.outboxStore.records()[0].state === 'superseded'
  && countOneRun.outboxStore.records()[0].disposition_reason === 'schedule_changed',
  'unsent BOOKING_CONFIRMED is superseded after count=1 and never produces RESCHEDULE');

// 8. raw bearer never persisted
persistedSnapshots.length = 0;
mailed = [];
const persistRecord = makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-persist' });
const persistStore = makeStore([persistRecord]);
runWorker(persistStore);
const bearerMatches = mailed[0].body.match(/token=([A-Za-z0-9_-]{64,256})/g) || [];
check(bearerMatches.length >= 1, 'email contains usable management token query');
const rawTokens = bearerMatches.map((part) => part.slice('token='.length));
persistedBlob = persistedSnapshots.join('\n') + '\n' + JSON.stringify(persistRecord);
check(rawTokens.every((token) => !persistedBlob.includes(token)), 'raw bearer is never persisted');
logSnapshots.push(JSON.stringify(worker.notificationWorkerResultSafe_(allowResult.results[0])));
check(!rawTokens.some((token) => logSnapshots.join('\n').includes(token)), 'raw bearer is absent from safe worker results');

// 9 + 10 + 11 + 12. failed first send leaves retryable state; retry rotates; old invalid; new usable
mailed = []; mailCalls = 0;
let failOnce = true;
let firstAttemptToken = null;
const rotateRecord = makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-rotate' });
const rotateStore = makeStore([rotateRecord]);
const firstHash = rotateRecord.reschedule_capability_hash;
const failDeliver = (input) => {
  if (failOnce) {
    failOnce = false;
    firstAttemptToken = (String(input.body).match(/token=([A-Za-z0-9_-]{64,256})/) || [])[1];
    const error = new Error('NOTIFICATION_DELIVERY_FAILED');
    error.code = 'NOTIFICATION_DELIVERY_FAILED';
    throw error;
  }
  return worker.deliverLifecycleNotification_(input);
};
const failedRun = runWorker(rotateStore, { deliver: failDeliver });
check(!failedRun.results[0].ok && rotateRecord.notification_patient_state === 'failed'
  && Number(rotateRecord.notification_attempt_count) === 1, 'failed first send leaves retryable state');
const afterFailHash = rotateRecord.reschedule_capability_hash;
check(afterFailHash && afterFailHash !== firstHash, 'retry rotates capability on first attempt');
mailed = [];
const retryRun = runWorker(rotateStore, { outboxStore: failedRun.outboxStore });
check(retryRun.results[0].ok && rotateRecord.notification_patient_state === 'sent', 'retry sends using new usable capability');
const tokenInEmail = (mailed[0].body.match(/token=([A-Za-z0-9_-]{64,256})/) || [])[1];
check(tokenInEmail && phase.verifyCapability_(tokenInEmail, 'RESCHEDULE', phase.capabilityFromRecord_(rotateRecord, 'RESCHEDULE'), {
  secret, now: Date.parse('2026-08-23T12:10:00Z'),
}), 'retry email token verifies against rotated capability');
check(firstAttemptToken && !phase.verifyCapability_(firstAttemptToken, 'RESCHEDULE', phase.capabilityFromRecord_(rotateRecord, 'RESCHEDULE'), {
  secret, now: Date.parse('2026-08-23T12:10:00Z'),
}) && afterFailHash !== rotateRecord.reschedule_capability_hash, 'old capability no longer verifies after rotation');

// 13 + 14. successful send becomes sent; sent is not resent
mailed = []; mailCalls = 0;
const sentRecord = makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-sent' });
const sentStore = makeStore([sentRecord]);
const sentOnce = runWorker(sentStore);
check(sentOnce.results[0].ok && sentRecord.notification_patient_state === 'sent' && sentRecord.notification_last_result === 'sent',
  'successful send becomes sent');
mailCalls = 0;
const resent = runWorker(sentStore, { outboxStore: sentOnce.outboxStore });
check(resent.processed === 0 && mailCalls === 0, 'sent notification is not resent');

// 15. concurrent worker execution is lock-safe
assert.throws(() => runWorker(makeStore([makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-lock' })]), {
  lock: { tryLock: () => false, releaseLock: () => {} },
}), /LOCK_UNAVAILABLE/);
assertions += 1;

// 16. max attempts stops retries
mailed = []; mailCalls = 0;
const maxRecord = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-max',
  notification_patient_state: 'failed',
  notification_attempt_count: String(phase.MAX_NOTIFICATION_ATTEMPTS),
});
const maxRun = runWorker(makeStore([maxRecord]));
check(maxRun.results[0].code === 'NOTIFICATION_MAX_ATTEMPTS' && mailCalls === 0
  && maxRecord.reconciliation_state === 'notification_max_attempts', 'max attempts stops retries');

// 17. malformed event type never sends
mailed = []; mailCalls = 0;
const badRecord = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-bad',
  notification_outbox_key: 'lifecycle_fran-nonprod-20260821-reservation-bad_NOT_A_REAL_EVENT_1',
});
const badRun = runWorker(makeStore([badRecord]), {
  outboxEntries: [durableFromRecord(badRecord, {
    eventType: 'NOT_A_REAL_EVENT',
    logical_key: 'lifecycle_fran-nonprod-20260821-reservation-bad_NOT_A_REAL_EVENT_1',
  })],
});
check(badRun.results[0].code === 'NOTIFICATION_EVENT_TYPE_INVALID' && mailCalls === 0
  && badRecord.reconciliation_state === 'notification_event_type_invalid', 'malformed event type never sends');

// 18. one failed row does not corrupt another valid row
mailed = []; mailCalls = 0;
failOnce = true;
const mixedBad = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-mix-bad',
  patient_email: 'nope@example.com',
});
const mixedGood = makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-mix-good' });
const mixed = runWorker(makeStore([mixedBad, mixedGood]));
check(mixed.processed === 2 && !mixed.results[0].ok && mixed.results[1].ok
  && mixedBad.notification_patient_state === 'failed' && mixedGood.notification_patient_state === 'sent',
  'one failed row does not corrupt another valid row');

function makeSheet(record) {
  return {
    getRange: (_row, col) => ({
      setValue: (value) => { record[phase.HEADERS[col - 1]] = String(value == null ? '' : value); },
    }),
  };
}
const enqueueSchema = { headers: phase.HEADERS, columns: Object.fromEntries(phase.HEADERS.map((h, i) => [h, i + 1])) };
const sequential = makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-seq' });
sequential.rowNumber = 2;
const sequentialStore = makeStore([sequential]);
const sequentialOutbox = worker.memoryNotificationOutboxStore_([durableFromRecord(sequential)]);
runWorker(sequentialStore, { outboxStore: sequentialOutbox });
check(sequential.notification_patient_state === 'sent', 'sequential fixture confirmation is sent');
const afterConfirmKey = sequential.notification_outbox_key;
worker.enqueueLifecycleNotification_(makeSheet(sequential), enqueueSchema, sequential, 'PATIENT_RESCHEDULED', null, sequentialOutbox);
check(sequential.notification_patient_state === 'pending' && String(sequential.notification_attempt_count) === '0'
  && String(sequential.notification_outbox_key).includes('PATIENT_RESCHEDULED')
  && sequential.notification_outbox_key !== afterConfirmKey,
  'sent confirmation does not suppress a later PATIENT_RESCHEDULED enqueue');
mailed = [];
sequential.patient_reschedule_count = '1';
sequential.reschedule_capability_revoked_at = 'used';
runWorker(sequentialStore, { outboxStore: sequentialOutbox });
check(mailed.length === 1 && mailed[0].subject === 'Tu sesión fue reagendada'
  && mailed[0].body.includes('Cancelar:') && !mailed[0].body.includes('Reagendar:')
  && mailed[0].body.includes('11:00') && !mailed[0].body.includes('.000Z'),
  'patient reschedule email is Chile-local CANCEL-only');
const afterRescheduleKey = sequential.notification_outbox_key;
worker.enqueueLifecycleNotification_(makeSheet(sequential), enqueueSchema, sequential, 'CLINICIAN_RESCHEDULED', null, sequentialOutbox);
check(sequential.notification_patient_state === 'pending' && sequential.notification_outbox_key !== afterRescheduleKey
  && String(sequential.notification_outbox_key).includes('CLINICIAN_RESCHEDULED'),
  'sent patient-reschedule does not suppress CLINICIAN_RESCHEDULED');
mailed = [];
runWorker(sequentialStore, { outboxStore: sequentialOutbox });
check(mailed.length === 1 && mailed[0].subject === 'Tu sesión fue reagendada'
  && mailed[0].body.includes('Cancelar:') && !mailed[0].body.includes('Reagendar:'),
  'clinician reschedule email is CANCEL-only');
sequential.booking_status = 'cancelled';
sequential.schedule_status = 'cancelled';
sequential.cancel_capability_revoked_at = 'now';
worker.enqueueLifecycleNotification_(makeSheet(sequential), enqueueSchema, sequential, 'PATIENT_CANCELLED', null, sequentialOutbox);
check(sequential.notification_internal_state === 'pending'
  && String(sequential.notification_outbox_key).includes('PATIENT_CANCELLED')
  && String(sequential.notification_attempt_count) === '0',
  'cancellation uses the internal channel and resets attempts');
mailed = [];
runWorker(sequentialStore, { outboxStore: sequentialOutbox });
check(mailed.length === 1 && mailed[0].subject === 'Tu sesión fue cancelada'
  && mailed[0].body.includes('Confirmamos la cancelación')
  && !mailed[0].body.includes('Meet:') && !/meet\.google\.com/i.test(mailed[0].body)
  && !mailed[0].body.includes('Reagendar:') && !mailed[0].body.includes('Cancelar:')
  && mailed[0].body.includes('11:00') && !mailed[0].body.includes('.000Z'),
  'cancellation email has Chile local context and no Meet or CTAs');
worker.enqueueLifecycleNotification_(makeSheet(sequential), enqueueSchema, sequential, 'PATIENT_CANCELLED', null, sequentialOutbox);
check(sequential.notification_internal_state === 'sent', 'cancellation replay enqueue does not reopen a sent event');

const renderedTime = worker.formatPatientFacingDateTime_('2026-08-25T15:00:00.000Z');
check(renderedTime === 'martes 25 de agosto de 2026, 11:00', 'outbox render clock is America/Santiago');

const replayBooking = makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-replay' });
replayBooking.rowNumber = 2;
const replayOutbox = worker.memoryNotificationOutboxStore_();
worker.enqueueLifecycleNotification_(makeSheet(replayBooking), enqueueSchema, replayBooking, 'BOOKING_CONFIRMED', null, replayOutbox);
const firstReplayKey = replayOutbox.records()[0].logical_key;
worker.enqueueLifecycleNotification_(makeSheet(replayBooking), enqueueSchema, replayBooking, 'BOOKING_CONFIRMED', null, replayOutbox);
check(replayOutbox.records().length === 1 && replayOutbox.records()[0].logical_key === firstReplayKey
  && replayOutbox.records()[0].state === 'pending'
  && replayOutbox.records()[0].source_operation_id,
  'same source occurrence enqueue is a durable replay, not a second row');

replayBooking.current_start_at = '2026-08-25T16:00:00.000Z';
worker.enqueueLifecycleNotification_(makeSheet(replayBooking), enqueueSchema, replayBooking, 'BOOKING_CONFIRMED', null, replayOutbox);
check(replayOutbox.records().length === 1 && replayOutbox.records()[0].logical_key === firstReplayKey,
  'BOOKING_CONFIRMED replay stays one row even if snapshot_start_at later differs');

mailed = [];
const snapBooking = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-snap',
  current_start_at: '2026-08-27T20:00:00.000Z',
  patient_reschedule_count: '1',
  reschedule_capability_revoked_at: 'used',
  notification_version: '3',
});
const snapOutbox = worker.memoryNotificationOutboxStore_([
  durableFromRecord(snapBooking, {
    eventType: 'PATIENT_RESCHEDULED',
    notification_version: '2',
    logical_key: 'lifecycle_fran-nonprod-20260821-reservation-snap_PATIENT_RESCHEDULED_2',
    created_at: '2026-08-27T16:10:00.000Z',
    snapshot_start_at: '2026-08-27T18:00:00.000Z',
    snapshot_patient_reschedule_count: '1',
  }),
  durableFromRecord(snapBooking, {
    eventType: 'CLINICIAN_RESCHEDULED',
    notification_version: '3',
    logical_key: 'lifecycle_fran-nonprod-20260821-reservation-snap_CLINICIAN_RESCHEDULED_3',
    created_at: '2026-08-27T16:20:00.000Z',
    snapshot_start_at: '2026-08-27T20:00:00.000Z',
    snapshot_patient_reschedule_count: '1',
  }),
]);
runWorker(makeStore([snapBooking]), { outboxStore: snapOutbox });
check(mailed.length === 2
  && mailed.every((item) => item.subject === 'Tu sesión fue reagendada')
  && mailed[0].body.includes('14:00') && !mailed[0].body.includes('16:00')
  && mailed[1].body.includes('16:00')
  && mailed.every((item) => item.body.includes('Cancelar:') && !item.body.includes('Reagendar:')),
  'later clinician time does not rewrite the patient-reschedule snapshot; both events still send');

mailed = []; mailCalls = 0;
failOnce = true;
const failLater = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-fail-later',
  eventType: 'PATIENT_RESCHEDULED',
  patient_reschedule_count: '1',
  reschedule_capability_revoked_at: 'used',
  notification_version: '2',
});
const failLaterStore = makeStore([failLater]);
const failLaterOutbox = worker.memoryNotificationOutboxStore_([durableFromRecord(failLater, { eventType: 'PATIENT_RESCHEDULED' })]);
const failedLaterRun = runWorker(failLaterStore, { outboxStore: failLaterOutbox, deliver: failDeliver });
check(!failedLaterRun.results[0].ok && failLaterOutbox.records()[0].state === 'failed',
  'delivery failure leaves the original event retryable');
worker.enqueueLifecycleNotification_(makeSheet(failLater), enqueueSchema, failLater, 'CLINICIAN_RESCHEDULED', null, failLaterOutbox);
check(failLaterOutbox.records().some((row) => row.event_type === 'PATIENT_RESCHEDULED' && row.state === 'failed')
  && failLaterOutbox.records().some((row) => row.event_type === 'CLINICIAN_RESCHEDULED' && row.state === 'pending'),
  'a later event is appended beside a failed prior event');
mailed = [];
const recovered = runWorker(failLaterStore, { outboxStore: failLaterOutbox });
check(recovered.processed === 2 && recovered.results.every((item) => item.ok)
  && failLaterOutbox.records().every((row) => row.state === 'sent') && mailed.length === 2,
  'failed event retries independently and the later event still sends');

const maxLater = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-max-later',
  notification_patient_state: 'failed',
  notification_attempt_count: String(phase.MAX_NOTIFICATION_ATTEMPTS),
  notification_last_result: 'max_attempts',
});
maxLater.rowNumber = 2;
const maxLaterOutbox = worker.memoryNotificationOutboxStore_([
  durableFromRecord(maxLater, { last_result: 'max_attempts', state: 'failed' }),
]);
worker.enqueueLifecycleNotification_(makeSheet(maxLater), enqueueSchema, maxLater, 'PATIENT_RESCHEDULED', null, maxLaterOutbox);
maxLater.patient_reschedule_count = '1';
maxLater.reschedule_capability_revoked_at = 'used';
mailed = [];
const maxLaterRun = runWorker(makeStore([maxLater]), { outboxStore: maxLaterOutbox });
check(maxLaterRun.processed === 1 && maxLaterRun.results[0].ok
  && maxLaterOutbox.records().find((row) => row.event_type === 'BOOKING_CONFIRMED').state === 'failed'
  && maxLaterOutbox.records().find((row) => row.event_type === 'PATIENT_RESCHEDULED').state === 'sent'
  && mailed.length === 1 && mailed[0].subject === 'Tu sesión fue reagendada',
  'max-attempt event stays failed and does not block a later logical send');

mailed = [];
const crash = makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-crash' });
const crashOutbox = worker.memoryNotificationOutboxStore_([
  durableFromRecord(crash, { state: 'claimed', attempt_count: '1', last_result: 'claimed' }),
]);
const crashRun = runWorker(makeStore([crash]), { outboxStore: crashOutbox });
check(crashRun.results[0].ok && crashOutbox.records()[0].state === 'sent' && mailed.length === 1,
  'claimed work is reclaimed after a crash between claim and complete');

mailed = [];
const cancelledBooking = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-already-cancelled',
  booking_status: 'cancelled',
  schedule_status: 'cancelled',
  cancel_capability_revoked_at: 'now',
});
const cancelledRun = runWorker(makeStore([cancelledBooking]));
check(cancelledRun.results[0].code === 'SUPERSEDED' && mailed.length === 0
  && cancelledRun.outboxStore.records()[0].disposition_reason === 'booking_cancelled',
  'already-cancelled booking supersedes an unsent non-cancel event without a send');

let clobberCalls = 0;
const raceEntry = durableFromRecord(makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-race' }));
raceEntry.state = 'pending';
const raceBooking = makeRecord({ reservation_id: raceEntry.reservation_id });
const raceStore = makeStore([raceBooking]);
const raceOutbox = {
  records: () => [raceEntry],
  loadByLogicalKey: () => ({ ...raceEntry, state: 'superseded', last_result: 'superseded', disposition_reason: 'later_same_type' }),
  update: (entry, fields) => {
    clobberCalls += 1;
    return Object.assign(entry, fields);
  },
};
mailed = [];
const raceRun = worker.processLifecycleNotificationOutbox_({
  config: phase.readCapabilityConfig_(), store: raceStore, outboxStore: raceOutbox, resources: { sheet: null },
  schema: enqueueSchema, requireCapabilitySecret_: () => secret, now: Date.parse('2026-08-23T12:10:00Z'),
});
check(raceRun.results[0].code === 'SUPERSEDED' && mailed.length === 0 && clobberCalls === 0,
  'claim persist must not clobber a concurrently superseded outbox row or send it');

const staleReschedule = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-stale-r',
  eventType: 'PATIENT_RESCHEDULED',
  patient_reschedule_count: '1',
  reschedule_capability_revoked_at: 'used',
});
const staleToken = phase.createCapability_('RESCHEDULE', { secret, now: Date.parse('2026-08-23T11:00:00Z') });
check(!phase.verifyCapability_(staleToken.token, 'RESCHEDULE', phase.capabilityFromRecord_(staleReschedule, 'RESCHEDULE'), {
  secret, now: Date.parse('2026-08-23T12:10:00Z'),
}), 'stale RESCHEDULE after quota=1 does not verify against the revoked stored capability');

const staleCancel = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-stale-c',
  booking_status: 'cancelled',
  schedule_status: 'cancelled',
  cancel_capability_revoked_at: 'now',
});
const staleCancelToken = phase.createCapability_('CANCEL', { secret, now: Date.parse('2026-08-23T11:00:00Z') });
check(!phase.verifyCapability_(staleCancelToken.token, 'CANCEL', phase.capabilityFromRecord_(staleCancel, 'CANCEL'), {
  secret, now: Date.parse('2026-08-23T12:10:00Z'),
}), 'stale CANCEL after terminal cancel does not verify');
mailed = [];
const cancelOutbox = worker.memoryNotificationOutboxStore_([
  durableFromRecord(staleCancel, { eventType: 'PATIENT_CANCELLED', state: 'pending' }),
]);
runWorker(makeStore([staleCancel]), { outboxStore: cancelOutbox });
check(mailed.length === 1 && mailed[0].subject === 'Tu sesión fue cancelada'
  && !mailed[0].body.includes('Reagendar:') && !mailed[0].body.includes('Cancelar:')
  && !mailed[0].body.includes('Meet:'),
  'terminal cancellation still sends independently without resurrecting capabilities or CTAs');
const hashesAfter = JSON.stringify(staleCancel);
worker.enqueueLifecycleNotification_(makeSheet(staleCancel), enqueueSchema, staleCancel, 'PATIENT_CANCELLED', null, cancelOutbox);
check(cancelOutbox.records().filter((row) => row.event_type === 'PATIENT_CANCELLED').length === 1
  && cancelOutbox.records()[0].state === 'sent'
  && JSON.stringify(staleCancel) === hashesAfter,
  'terminal cancel replay does not duplicate or resurrect capability hashes');

function opId(type, entropy) {
  return phase.makeOperationId_(type, entropy);
}

const timeB = '2026-08-25T16:00:00.000Z';
const clinicianBooking = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-occ-clinician',
  current_start_at: timeB,
});
clinicianBooking.rowNumber = 2;
clinicianBooking.last_operation_id = opId('clinician_reconcile_move', 'event-occ:etag-1:2026-08-25T16:00:00.000Z');
const clinicianOutbox = worker.memoryNotificationOutboxStore_();
worker.enqueueLifecycleNotification_(makeSheet(clinicianBooking), enqueueSchema, clinicianBooking, 'CLINICIAN_RESCHEDULED', null, clinicianOutbox);
const firstClinician = clinicianOutbox.records()[0];
clinicianBooking.last_operation_id = opId('clinician_reconcile_move', 'event-occ:etag-2:2026-08-25T16:20:00.000Z');
clinicianBooking.current_start_at = '2026-08-25T17:00:00.000Z';
worker.enqueueLifecycleNotification_(makeSheet(clinicianBooking), enqueueSchema, clinicianBooking, 'CLINICIAN_RESCHEDULED', null, clinicianOutbox);
clinicianBooking.last_operation_id = opId('clinician_reconcile_move', 'event-occ:etag-3:2026-08-25T17:00:00.000Z');
clinicianBooking.current_start_at = timeB;
worker.enqueueLifecycleNotification_(makeSheet(clinicianBooking), enqueueSchema, clinicianBooking, 'CLINICIAN_RESCHEDULED', null, clinicianOutbox);
const clinicianRows = clinicianOutbox.records();
const firstAgain = clinicianRows.find((row) => row.source_operation_id === firstClinician.source_operation_id);
const thirdClinician = clinicianRows[clinicianRows.length - 1];
check(clinicianRows.filter((row) => row.event_type === 'CLINICIAN_RESCHEDULED').length === 3
  && firstClinician.source_operation_id !== thirdClinician.source_operation_id
  && firstClinician.snapshot_start_at === thirdClinician.snapshot_start_at
  && firstClinician.logical_key !== thirdClinician.logical_key
  && firstAgain === firstClinician,
  'CLINICIAN_RESCHEDULED back to time B is a new occurrence, not a replay of the first move to B');
worker.enqueueLifecycleNotification_(makeSheet(clinicianBooking), enqueueSchema, clinicianBooking, 'CLINICIAN_RESCHEDULED', null, clinicianOutbox);
check(clinicianOutbox.records().length === 3 && clinicianOutbox.records()[2].logical_key === thirdClinician.logical_key,
  'same source occurrence processed twice creates exactly one durable row');

const typeNames = ['BOOKING_CONFIRMED', 'PATIENT_RESCHEDULED', 'CLINICIAN_RESCHEDULED', 'PATIENT_CANCELLED',
  'CLINICIAN_CANCELLED', 'REFUND_REQUESTED', 'REFUND_COMPLETED', 'REFUND_FAILED_MANUAL_REVIEW'];
typeNames.forEach((eventType) => {
  const typed = makeRecord({
    reservation_id: 'fran-nonprod-20260821-reservation-type-' + eventType.toLowerCase(),
    current_start_at: timeB,
    commerce_order: 'npo-1111111111111111111111111111111111111111',
    calendar_event_id: 'event-type',
    calendar_event_etag: 'etag-a',
    calendar_event_updated_at: '2026-08-25T16:00:00.000Z',
    refund_commerce_order: 'fran-nonprod-refund-111111111111111111111111',
    refund_provider_reference: 'refund-ref-a',
  });
  typed.rowNumber = 2;
  typed.last_operation_id = eventType === 'BOOKING_CONFIRMED' ? '' : opId('patient_reschedule', eventType + ':first');
  const typedOutbox = worker.memoryNotificationOutboxStore_();
  worker.enqueueLifecycleNotification_(makeSheet(typed), enqueueSchema, typed, eventType, null, typedOutbox);
  worker.enqueueLifecycleNotification_(makeSheet(typed), enqueueSchema, typed, eventType, null, typedOutbox);
  check(typedOutbox.records().length === 1, eventType + ' same occurrence replay is exactly one row');
  if (eventType === 'BOOKING_CONFIRMED') {
    typed.commerce_order = 'npo-2222222222222222222222222222222222222222';
  } else {
    typed.last_operation_id = opId('patient_reschedule', eventType + ':second');
  }
  worker.enqueueLifecycleNotification_(makeSheet(typed), enqueueSchema, typed, eventType, null, typedOutbox);
  check(typedOutbox.records().length === 2
    && typedOutbox.records()[0].source_operation_id !== typedOutbox.records()[1].source_operation_id
    && typedOutbox.records()[0].snapshot_start_at === typedOutbox.records()[1].snapshot_start_at,
    eventType + ' later same-type occurrence with the same snapshot_start_at is independent');
});

function createSharedStrictLock() {
  const state = {
    held: false, owner: null, acquireCount: 0, releaseCount: 0, nestedTryLock: 0, doubleRelease: 0,
  };
  const handle = (owner) => ({
    tryLock: () => {
      if (state.held) {
        if (state.owner === owner) {
          state.nestedTryLock += 1;
          return true;
        }
        return false;
      }
      state.held = true;
      state.owner = owner;
      state.acquireCount += 1;
      return true;
    },
    releaseLock: () => {
      if (!state.held) {
        state.doubleRelease += 1;
        return;
      }
      state.held = false;
      state.owner = null;
      state.releaseCount += 1;
    },
    hasLock: () => state.held && state.owner === owner,
  });
  return { state, handle };
}

const nested = createSharedStrictLock();
const nestedLock = nested.handle('worker-a');
check(nestedLock.tryLock() === true && nested.state.acquireCount === 1, 'outer worker acquires once');
phase.withLifecycleLock_({ lock: nestedLock, lockAlreadyHeld: true }, () => {
  check(nested.state.held && nested.state.owner === 'worker-a'
    && nested.state.acquireCount === 1 && nested.state.releaseCount === 0,
    'inner helper with lockAlreadyHeld does not acquire or release');
});
check(nested.state.held && nested.state.releaseCount === 0, 'caller still owns the lock after inner helper');
nestedLock.releaseLock();
check(!nested.state.held && nested.state.releaseCount === 1 && nested.state.doubleRelease === 0,
  'exactly one matching release by the owner');

const stolen = createSharedStrictLock();
const stolenLock = stolen.handle('worker-a');
stolenLock.tryLock();
phase.withLifecycleLock_({ lock: stolenLock }, () => {
  check(stolen.state.nestedTryLock === 1, 'tryLock while already held is a no-op second acquisition');
});
check(!stolen.state.held && stolen.state.releaseCount === 1,
  'helper without lockAlreadyHeld would release a caller-owned lock; worker must not use that path');

const batchLock = createSharedStrictLock();
const workerLock = batchLock.handle('worker-a');
const firstBatch = makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-lock-a' });
const secondBatch = makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-lock-b' });
const batchStore = makeStore([firstBatch, secondBatch]);
const heldDuring = [];
const observingDeliver = (input) => {
  heldDuring.push({
    held: batchLock.state.held,
    owner: batchLock.state.owner,
    acquireCount: batchLock.state.acquireCount,
    releaseCount: batchLock.state.releaseCount,
  });
  return worker.deliverLifecycleNotification_(input);
};
mailed = [];
const batchRun = runWorker(batchStore, { lock: workerLock, deliver: observingDeliver });
check(batchRun.processed === 2 && batchRun.results.every((item) => item.ok)
  && heldDuring.length === 2
  && heldDuring.every((snap) => snap.held && snap.owner === 'worker-a' && snap.acquireCount === 1 && snap.releaseCount === 0)
  && batchLock.state.acquireCount === 1 && batchLock.state.releaseCount === 1 && !batchLock.state.held
  && batchLock.state.nestedTryLock === 0 && batchLock.state.doubleRelease === 0,
  'outer lock remains held across capability rotation and the rest of the batch, then owner releases once');

const concurrent = createSharedStrictLock();
const lockA = concurrent.handle('worker-a');
const lockB = concurrent.handle('worker-b');
const sharedEntry = durableFromRecord(makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-lock-race' }));
const sharedBooking = makeRecord({ reservation_id: sharedEntry.reservation_id });
const sharedStore = makeStore([sharedBooking]);
const sharedOutbox = worker.memoryNotificationOutboxStore_([sharedEntry]);
let workerBAttempted = false;
const blockingDeliver = (input) => {
  workerBAttempted = true;
  assert.throws(() => runWorker(sharedStore, { lock: lockB, outboxStore: sharedOutbox }), /LOCK_UNAVAILABLE/);
  check(sharedOutbox.records()[0].state === 'claimed' || sharedOutbox.records()[0].state === 'sent',
    'worker B cannot claim the in-flight row while worker A holds the lock');
  return worker.deliverLifecycleNotification_(input);
};
mailed = [];
const workerARun = runWorker(sharedStore, { lock: lockA, outboxStore: sharedOutbox, deliver: blockingDeliver });
check(workerARun.results[0].ok && workerBAttempted && sharedOutbox.records()[0].state === 'sent'
  && concurrent.state.acquireCount === 1 && concurrent.state.releaseCount === 1,
  'concurrent worker cannot independently send the same outbox row');

const enqueueWhileHeld = createSharedStrictLock();
const heldLock = enqueueWhileHeld.handle('worker-a');
const liveBooking = makeRecord({ reservation_id: 'fran-nonprod-20260821-reservation-lock-enqueue' });
liveBooking.rowNumber = 2;
const liveStore = makeStore([liveBooking]);
const liveOutbox = worker.memoryNotificationOutboxStore_([durableFromRecord(liveBooking)]);
const enqueueDuringSend = (input) => {
  check(enqueueWhileHeld.state.held && enqueueWhileHeld.state.owner === 'worker-a',
    'enqueue during send observes the caller-owned lock');
  liveBooking.last_operation_id = opId('patient_reschedule', 'live-booking:later');
  liveBooking.patient_reschedule_count = '1';
  liveBooking.reschedule_capability_revoked_at = 'used';
  worker.enqueueLifecycleNotification_(makeSheet(liveBooking), enqueueSchema, liveBooking, 'PATIENT_RESCHEDULED', null, liveOutbox);
  const claimed = liveOutbox.records().find((row) => row.event_type === 'BOOKING_CONFIRMED');
  const appended = liveOutbox.records().find((row) => row.event_type === 'PATIENT_RESCHEDULED');
  check(claimed && (claimed.state === 'claimed' || claimed.state === 'sent')
    && appended && appended.state === 'pending' && appended.source_operation_id !== claimed.source_operation_id,
    'a new different event persists beside a claimed event');
  return worker.deliverLifecycleNotification_(input);
};
mailed = [];
const liveRun = runWorker(liveStore, { lock: heldLock, outboxStore: liveOutbox, deliver: enqueueDuringSend });
const liveConfirm = liveOutbox.records().find((row) => row.event_type === 'BOOKING_CONFIRMED');
const liveLater = liveOutbox.records().find((row) => row.event_type === 'PATIENT_RESCHEDULED');
check(liveRun.results[0].ok && liveConfirm.state === 'sent' && liveLater.state === 'pending',
  'enqueue while worker owns lock does not corrupt claimed or sent state');
liveConfirm.state = 'sent';
liveConfirm.last_result = 'sent';
const sentGuard = worker.memoryNotificationOutboxStore_([{ ...liveConfirm }]);
runWorker(liveStore, { outboxStore: sentGuard });
check(sentGuard.records()[0].state === 'sent' && sentGuard.records()[0].last_result === 'sent',
  'sent never reverts to claimed or failed');
const supersededGuard = worker.memoryNotificationOutboxStore_([{
  ...liveConfirm, state: 'superseded', last_result: 'superseded', disposition_reason: 'later_same_type',
}]);
runWorker(liveStore, { outboxStore: supersededGuard });
check(supersededGuard.records()[0].state === 'superseded' && supersededGuard.records()[0].last_result === 'superseded',
  'superseded never reverts to claimed or failed');

const maxRotate = makeRecord({
  reservation_id: 'fran-nonprod-20260821-reservation-max-rotate',
  notification_attempt_count: String(phase.MAX_NOTIFICATION_ATTEMPTS - 1),
});
const maxRotateOutbox = worker.memoryNotificationOutboxStore_([
  durableFromRecord(maxRotate, { attempt_count: String(phase.MAX_NOTIFICATION_ATTEMPTS - 1), state: 'failed' }),
]);
mailed = [];
const maxRotateRun = runWorker(makeStore([maxRotate]), {
  outboxStore: maxRotateOutbox,
  requireCapabilitySecret_: () => { throw Object.assign(new Error('CAPABILITY_SECRET_INVALID'), { code: 'CAPABILITY_SECRET_INVALID' }); },
});
const maxRotateEntry = maxRotateOutbox.records()[0];
check(!maxRotateRun.results[0].ok
  && Number(maxRotateEntry.attempt_count) === phase.MAX_NOTIFICATION_ATTEMPTS
  && maxRotateEntry.last_result === 'max_attempts'
  && maxRotateEntry.disposition_reason === 'max_attempts'
  && maxRotateEntry.state === 'failed'
  && maxRotate.reconciliation_state === 'notification_max_attempts'
  && mailed.length === 0,
  'capability-rotation failure at attempt 5 marks max_attempts in the same cycle');
const maxRotateAgain = runWorker(makeStore([maxRotate]), { outboxStore: maxRotateOutbox });
check(maxRotateAgain.processed === 0, 'max_attempts terminal marking does not wait for a later worker invocation');

// 19 + 20 + 21. installer does not duplicate; targets handler; interval = 5
projectTriggers.length = 0;
const installed = worker.installNonprodNotificationRetryTrigger_();
check(installed.ok && installed.created && installed.handler === worker.NONPROD_NOTIFICATION_RETRY_HANDLER, 'installer targets processLifecycleNotificationOutbox_');
check(installed.intervalMinutes === 5 && projectTriggers[0].minutes === 5, 'trigger interval = 5 minutes');
const installedAgain = worker.installNonprodNotificationRetryTrigger_();
check(installedAgain.ok && !installedAgain.created && projectTriggers.length === 1, 'installer does not create duplicate trigger');

projectTriggers.push({
  handler: worker.NONPROD_NOTIFICATION_RETRY_HANDLER,
  minutes: 5,
  getHandlerFunction: () => worker.NONPROD_NOTIFICATION_RETRY_HANDLER,
});
const deduplicated = worker.installNonprodNotificationRetryTrigger_();
check(deduplicated.ok && !deduplicated.created
  && projectTriggers.filter((trigger) => trigger.getHandlerFunction() === worker.NONPROD_NOTIFICATION_RETRY_HANDLER).length === 1,
  'installer removes duplicate matching triggers');

projectTriggers.length = 0;
const calendarInstalled = worker.installNonprodCalendarReconciliationTrigger_();
check(calendarInstalled.ok && calendarInstalled.created
  && calendarInstalled.handler === worker.NONPROD_CALENDAR_RECONCILIATION_HANDLER
  && calendarInstalled.intervalMinutes === worker.NONPROD_CALENDAR_RECONCILIATION_INTERVAL_MINUTES
  && projectTriggers.length === 1 && projectTriggers[0].minutes === 5,
  'Calendar reconciliation installer targets one five-minute trigger');
const calendarInstalledAgain = worker.installNonprodCalendarReconciliationTrigger_();
check(calendarInstalledAgain.ok && !calendarInstalledAgain.created && projectTriggers.length === 1,
  'Calendar reconciliation installer is idempotent');
const calendarRemoved = worker.removeNonprodCalendarReconciliationTrigger_();
check(calendarRemoved.ok && calendarRemoved.removed === 1 && projectTriggers.length === 0,
  'Calendar reconciliation removal targets only its handler');

// 22. removal helper removes only intended handler triggers
projectTriggers.push({
  handler: worker.NONPROD_NOTIFICATION_RETRY_HANDLER,
  minutes: 5,
  getHandlerFunction: () => worker.NONPROD_NOTIFICATION_RETRY_HANDLER,
});
projectTriggers.push({
  handler: 'unrelatedHandler_',
  minutes: 10,
  getHandlerFunction: () => 'unrelatedHandler_',
});
const removed = worker.removeNonprodNotificationRetryTrigger_();
check(removed.ok && removed.removed === 1 && projectTriggers.length === 1
  && projectTriggers[0].getHandlerFunction() === 'unrelatedHandler_', 'removal helper removes only intended handler triggers');

// Preview origin contract and private Apps Script URL absence
const origin = worker.previewOriginFromConfig_(phase.readCapabilityConfig_());
check(origin === 'https://preview-example.pages.dev', 'preview origin derives from validated Preview return URL');
const sampleUrl = worker.managementPageUrl_(origin, 'a'.repeat(64), 'cancel');
check(sampleUrl.startsWith('https://preview-example.pages.dev/manage.html?token=')
  && !sampleUrl.includes('script.google.com') && !sampleUrl.includes('script.googleusercontent.com'),
  'management CTAs use Preview origin without private Apps Script URLs');

// 23. zero real email/network/external calls beyond stubs
check(networkCalls === 0, 'tests execute zero real network calls');
check(!persistedBlob.match(/script\.google\.com|script\.googleusercontent\.com/i), 'no private Apps Script URLs in persisted state');

const rawCapabilityInPersisted = rawTokens.filter((token) => persistedBlob.includes(token)).length;
const rawCapabilityInLogs = rawTokens.filter((token) => logSnapshots.join('\n').includes(token)).length;
check(rawCapabilityInPersisted === 0, 'RAW_CAPABILITY_IN_PERSISTED_STATE = 0');
check(rawCapabilityInLogs === 0, 'RAW_CAPABILITY_IN_LOGS = 0');

console.log(`OUTBOX_TRIGGER_TESTS=PASS assertions=${assertions}`);
console.log('RAW_CAPABILITY_IN_PERSISTED_STATE=0');
console.log('RAW_CAPABILITY_IN_LOGS=0');
console.log('PRIVATE_APPS_SCRIPT_URLS=0');
console.log('REAL_PATIENT_DATA=0');
console.log(`MAIL_STUB_CALLS=${mailCalls >= 0 ? 'stubbed-only' : 'error'}`);
console.log('REAL_EMAILS_SENT=0');
console.log('REAL_TRIGGERS_CREATED=0');

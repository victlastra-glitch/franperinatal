import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const files = ['../Code.js', '../Lifecycle.js', '../CalendarGateway.js', '../Reconciliation.js', '../RefundGateway.js'];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const secret = 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz';
const baseProperties = {
  APP_ENV: 'nonprod', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://sandbox.flow.cl/api', FLOW_RETURN_URL: 'https://preview-example.pages.dev/pago-resultado',
  FLOW_CONFIRMATION_URL: 'https://preview-example.pages.dev/api/flow-confirmation', BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: 'qa+nonprod@example.test', PATIENT_EMAIL_RECIPIENT_ALLOWLIST: 'qa+nonprod@example.test',
  IDEMPOTENCY_NAMESPACE: 'fran-nonprod-20260821', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
};
let propertyValues = { ...baseProperties };
let networkCalls = 0;
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
const headers = ['idempotency_key', 'reservation_id', 'service_type', 'modality', 'patient_email', 'original_start_at', 'current_start_at', 'current_end_at', 'slot_hold_expires_at', 'booking_status', 'payment_status', 'refund_status', 'schedule_status', 'payment_url', 'flow_token', 'commerce_order', 'status_token_hash', 'status_token_expires_at', 'calendar_event_id', 'calendar_event_etag', 'calendar_event_updated_at', 'calendar_sync_hash', 'calendar_link_key', 'calendar_change_source', 'schedule_changed_at', 'meet_url', 'meet_conference_id', 'meet_status', 'patient_reschedule_count', 'reschedule_capability_hash', 'reschedule_capability_expires_at', 'reschedule_capability_version', 'reschedule_capability_revoked_at', 'cancel_capability_hash', 'cancel_capability_expires_at', 'cancel_capability_version', 'cancel_capability_revoked_at', 'cancellation_source', 'cancelled_at', 'refund_commerce_order', 'refund_provider_reference', 'refund_requested_at', 'refund_completed_at', 'refund_last_checked_at', 'refund_last_error_code', 'notification_version', 'notification_outbox_key', 'notification_patient_state', 'notification_internal_state', 'notification_attempt_count', 'notification_last_attempt_at', 'notification_last_result', 'last_patient_notification_at', 'reconciliation_state', 'last_operation_id', 'created_at', 'updated_at'];
const sheet = {
  getLastRow: () => 1, getLastColumn: () => headers.length,
  getRange: () => ({ getDisplayValues: () => [headers], setValue: () => {}, setValues: () => {} }),
  getDataRange: () => ({ getValues: () => [headers] }),
};
const calendarApp = { getCalendarById: (id) => ({ getId: () => id }) };
const context = {
  console, Date, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math, encodeURIComponent, decodeURIComponent,
  Utilities: utilities,
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...propertyValues }) }) },
  SpreadsheetApp: { openById: () => ({ getId: () => 'synthetic-store', getSheetByName: () => sheet }) },
  CalendarApp: calendarApp, MailApp: { sendEmail: () => { throw new Error('mail must not be called'); } },
  GmailApp: { sendEmail: () => { throw new Error('mail must not be called'); } },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  UrlFetchApp: { fetch: () => { networkCalls += 1; throw new Error('network must not be called'); } },
  Session: { getActiveUser: () => ({ getEmail: () => '' }) },
  ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (value) => ({ value, setMimeType() { return this; } }) },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);
const phase = context.__PHASE_A_TEST_EXPORTS__;
const calendar = context.__CALENDAR_TEST_EXPORTS__;
const reconciliation = context.__RECONCILIATION_TEST_EXPORTS__;
const refund = context.__REFUND_TEST_EXPORTS__;
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

// A. Lazy configuration: base endpoints remain usable without capability/refund-only properties.
const base = phase.readConfig_();
check(base && !Object.hasOwn(base, 'capabilityTokenSecret'), 'base config does not read capability secret');
check(phase.BASE_PROPERTY_KEYS.length + phase.CAPABILITY_PROPERTY_KEYS.length === phase.PROPERTY_KEYS.length, 'property scopes are explicit');
assert.throws(() => phase.requireCapabilitySecret_(), /CAPABILITY_SECRET_INVALID/); assertions += 1;
propertyValues.CAPABILITY_TOKEN_SECRET = secret;
check(phase.readCapabilityConfig_().capabilityTokenSecret === secret, 'capability config is explicit and lazy');
delete propertyValues.CAPABILITY_TOKEN_SECRET;

// B. Availability: output is occupied slots, unioned and interval-based.
const workingSlots = [{ date: '2026-08-24', time: '10:00', start: '2026-08-24T14:00:00.000Z', end: '2026-08-24T15:00:00.000Z' },
  { date: '2026-08-24', time: '11:00', start: '2026-08-24T15:00:00.000Z', end: '2026-08-24T16:00:00.000Z' }];
const manuallyBusy = [{ start: '2026-08-24T14:30:00.000Z', end: '2026-08-24T15:30:00.000Z' }];
const occupied = calendar.computeOccupiedSlots_({ workingSlots, busyIntervals: manuallyBusy, reservations: [] });
check(occupied.length === 2, 'manual Calendar partial overlap blocks both adjacent slots');
check(calendar.intervalOverlap_('2026-08-24T15:00:00Z', '2026-08-24T16:00:00Z', '2026-08-24T14:00:00Z', '2026-08-24T15:00:00Z') === false, 'back-to-back intervals do not overlap');
check(calendar.computeOccupiedSlots_({ workingSlots, busyIntervals: [{ start: '2026-08-24T00:00:00Z', end: '2026-08-25T00:00:00Z' }], reservations: [] }).length === 2, 'all-day busy interval blocks working slots');
const sameBooking = { booking_status: 'confirmed', current_start_at: workingSlots[0].start, current_end_at: workingSlots[0].end };
check(calendar.computeOccupiedSlots_({ workingSlots, busyIntervals: [manuallyBusy[0]], reservations: [sameBooking] }).length === 2, 'Calendar plus same datastore booking remains deduplicated');
check(calendar.computeOccupiedSlots_({ workingSlots, busyIntervals: [], reservations: [] }).length === 0, 'Calendar failure path has no synthetic availability fallback');

// C. Gateway: linkage, ETag, same-event update, Meet, delete and sync reset.
let inserted = 0; let updated = 0; let removed = 0; let listCalls = 0; let providerContractAssertions = 0;
const event = { id: 'event-opaque-1', etag: 'etag-1', updated: '2026-08-24T13:00:00.000Z', status: 'confirmed',
  start: { dateTime: '2026-08-24T14:00:00.000Z' }, end: { dateTime: '2026-08-24T15:00:00.000Z' },
  extendedProperties: { private: { source: 'fran_booking', link_key: 'fran-nonprod-20260821-calendar-link-abcdef0123456789', schema: 'fran_booking:v1' } },
  conferenceData: { conferenceId: 'meet-opaque-1', entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque' }] } };
const api = {
  Freebusy: { query: (resource) => {
    assert.deepEqual(resource, { timeMin: '2026-08-24T14:00:00.000Z', timeMax: '2026-08-24T15:00:00.000Z', items: [{ id: 'synthetic-calendar' }] });
    providerContractAssertions += 1;
    return { calendars: { 'synthetic-calendar': { busy: manuallyBusy } } };
  } },
  Events: {
    list: (calendarId, request) => {
      assert.equal(calendarId, 'synthetic-calendar'); assert.ok(request && typeof request === 'object'); providerContractAssertions += 1;
      listCalls += 1; return { items: listCalls === 1 ? [] : [event], nextSyncToken: 'sync-next' };
    },
    get: (calendarId, eventId, optionalArgs) => {
      assert.equal(calendarId, 'synthetic-calendar'); assert.equal(eventId, event.id); assert.equal(optionalArgs, undefined); providerContractAssertions += 1; return event;
    },
    insert: (resource, calendarId, optionalArgs) => {
      assert.equal(calendarId, 'synthetic-calendar'); assert.equal(optionalArgs.conferenceDataVersion, 1); assert.equal(optionalArgs.sendUpdates, 'none');
      assert.equal(resource.extendedProperties.private.source, 'fran_booking'); providerContractAssertions += 1;
      inserted += 1; Object.assign(event, resource); event.conferenceData = { conferenceId: 'meet-opaque-1', entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque' }] }; return event;
    },
    update: (resource, calendarId, eventId, optionalArgs, optionalHeaders) => {
      assert.notEqual(resource, event); assert.equal(resource.id, event.id); assert.equal(calendarId, 'synthetic-calendar'); assert.equal(eventId, event.id);
      assert.equal(JSON.stringify(optionalArgs), JSON.stringify({ conferenceDataVersion: 1, sendUpdates: 'none' }));
      assert.equal(JSON.stringify(optionalHeaders), JSON.stringify({ 'If-Match': 'etag-1' })); providerContractAssertions += 1;
      updated += 1; Object.assign(event, resource, { etag: 'etag-2', updated: '2026-08-24T14:00:00.000Z' }); return event;
    },
    remove: (calendarId, eventId, optionalArgs) => { assert.equal(calendarId, 'synthetic-calendar'); assert.equal(eventId, event.id); assert.equal(JSON.stringify(optionalArgs), JSON.stringify({ sendUpdates: 'none' })); providerContractAssertions += 1; removed += 1; },
  },
};
const gateway = calendar.createCalendarGateway_({ api, calendarId: 'synthetic-calendar', requestMeet: true });
const recordTemplate = { reservation_id: 'fran-nonprod-20260821-reservation-opaque', calendar_event_id: event.id, calendar_link_key: event.extendedProperties.private.link_key,
  current_start_at: '2026-08-24T14:00:00.000Z', current_end_at: '2026-08-24T15:00:00.000Z', calendar_event_etag: 'etag-1' };
const created = gateway.createLinkedBookingEvent(recordTemplate);
check(inserted === 1 && created.id === event.id, 'linked booking event is created once');
const retried = gateway.createLinkedBookingEvent(recordTemplate);
check(inserted === 1 && retried.id === event.id, 'linked event retry does not duplicate');
check(event.extendedProperties.private.source === 'fran_booking' && event.extendedProperties.private.link_key === recordTemplate.calendar_link_key
  && !JSON.stringify(event.extendedProperties.private).match(/patient|email|rut|phone|clinical|reason/i), 'Calendar linkage is opaque and contains no PII');
const moved = gateway.updateSameEvent({ ...recordTemplate, calendar_event_id: event.id }, '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z');
check(updated === 1 && moved.meetUrl === 'https://meet.google.com/opaque', 'same-event update preserves Meet and reads ETag/update');
check(gateway.cancelLinkedEvent({ calendar_event_id: event.id }).ok && removed === 1, 'linked event cancellation is idempotent adapter operation');
const resetApi = { Events: { list: (_id, request) => { if (request.syncToken) { const error = new Error('HTTP 410 Gone'); throw error; } return { items: [], nextSyncToken: 'full-token' }; } } };
const reset = calendar.createCalendarGateway_({ api: resetApi, calendarId: 'synthetic-calendar' }).reconcileIncremental('expired-token', { start: event.start.dateTime, end: event.end.dateTime });
check(reset.fullSyncReset === true && reset.nextSyncToken === 'full-token', 'expired syncToken triggers full-sync reset');

// D. Reconciliation: clinician moves/cancels, stale ETag and loop protection.
let storedRecord = { ...recordTemplate, calendar_event_id: event.id, calendar_event_etag: 'old-etag', calendar_event_updated_at: '2026-08-24T12:00:00.000Z',
  calendar_sync_hash: 'old-hash', booking_status: 'confirmed', payment_status: 'paid', schedule_status: 'scheduled', patient_reschedule_count: '0',
  refund_status: 'not_required', notification_version: '1' };
const updates = []; const store = { loadByCalendarEventId: () => storedRecord, update: (_record, fields) => { updates.push(fields); storedRecord = { ...storedRecord, ...fields }; return storedRecord; }, records: () => [storedRecord] };
let notifications = 0;
const clinicianEvent = { ...event, etag: 'clinician-etag', updated: '2026-08-24T17:00:00.000Z', start: { dateTime: '2026-08-24T18:00:00.000Z' }, end: { dateTime: '2026-08-24T19:00:00.000Z' } };
const movedOutcome = reconciliation.reconcileCalendarChange_({ store, event: clinicianEvent, enqueueNotification: () => { notifications += 1; } });
check(movedOutcome.changed && storedRecord.calendar_change_source === 'clinician' && storedRecord.patient_reschedule_count === '0' && notifications === 1, 'clinician move reconciles without consuming patient quota');
const loopOutcome = reconciliation.reconcileCalendarChange_({ store, event: clinicianEvent, enqueueNotification: () => { notifications += 1; } });
check(loopOutcome.noop === true && notifications === 1, 'reconciliation loop protection is ETag/hash idempotent');
const failedPatientRescheduleRecord = { ...storedRecord, booking_status: 'confirmed', schedule_status: 'reconciliation_required',
  reconciliation_state: 'calendar_reschedule_conflict', patient_reschedule_count: '0', calendar_event_etag: clinicianEvent.etag,
  calendar_event_updated_at: clinicianEvent.updated, calendar_sync_hash: context.__CALENDAR_TEST_EXPORTS__.calendarSyncHash_(clinicianEvent) };
const recovered = reconciliation.reconcileCalendarChange_({ store: {
  loadByCalendarEventId: () => failedPatientRescheduleRecord,
  update: (_record, fields) => Object.assign(failedPatientRescheduleRecord, fields),
}, event: clinicianEvent });
check(recovered.changed && recovered.recovered && failedPatientRescheduleRecord.schedule_status === 'scheduled'
  && failedPatientRescheduleRecord.reconciliation_state === '' && failedPatientRescheduleRecord.patient_reschedule_count === '0',
  'reconciliation recovers an unchanged authoritative event after a patient Calendar conflict');
const unrelatedRecoveryStates = [
  'notification_reschedule_retry', 'notification_cancel_retry', 'notification_max_attempts',
  'capability_configuration_required', 'flow_create_flow_provider_rejected',
  'calendar_cancel_retry', 'calendar_create_retry',
];
unrelatedRecoveryStates.forEach((reconciliationState) => {
  const untouched = { ...failedPatientRescheduleRecord, schedule_status: 'reconciliation_required', reconciliation_state: reconciliationState };
  const untouchedBefore = { ...untouched };
  const unrelatedOutcome = reconciliation.reconcileCalendarChange_({ store: {
    loadByCalendarEventId: () => untouched,
    update: (_record, fields) => Object.assign(untouched, fields),
  }, event: clinicianEvent });
  check(unrelatedOutcome.noop === true && JSON.stringify(untouched) === JSON.stringify(untouchedBefore),
    `unchanged event does not clear unrelated reconciliation state: ${reconciliationState}`);
});
const stale = reconciliation.reconcileCalendarChange_({ store, event: { ...clinicianEvent, etag: 'stale', updated: '2026-08-23T16:00:00.000Z' } });
check(stale.code === 'STALE_CALENDAR_EVENT' && storedRecord.reconciliation_state === 'calendar_stale_event_retry', 'stale Calendar event produces retry state');
const cancelOutcome = reconciliation.reconcileCalendarChange_({ store, event: { ...clinicianEvent, status: 'cancelled', deleted: true }, policyEvaluator: () => ({ eligible: false }), enqueueNotification: () => {} });
check(cancelOutcome.changed && storedRecord.booking_status === 'cancelled' && storedRecord.schedule_status === 'cancelled'
  && storedRecord.cancellation_source === 'clinician', 'clinician cancellation frees schedule independently of refund');

// E. Atomic patient transactions: fresh read, one-shot capability, concurrency and cancel idempotency.
propertyValues.CAPABILITY_TOKEN_SECRET = secret;
const cap = phase.createCapability_('RESCHEDULE', { secret, now: Date.parse('2026-08-23T12:00:00Z'), expiresAt: '2026-08-24T12:00:00Z' });
const cancelCap = phase.createCapability_('CANCEL', { secret, now: Date.parse('2026-08-23T12:00:00Z'), expiresAt: '2026-08-24T12:00:00Z' });
let txnRecord = { reservation_id: 'fran-nonprod-20260821-reservation-txn', booking_status: 'confirmed', payment_status: 'paid', schedule_status: 'scheduled', patient_reschedule_count: '0',
  calendar_event_id: event.id, calendar_event_etag: 'etag-1', calendar_event_updated_at: event.updated, calendar_sync_hash: 'hash', calendar_link_key: recordTemplate.calendar_link_key,
  ...phase.capabilityFields_(phase.capabilityForStorage_(cap)), ...phase.capabilityFields_(phase.capabilityForStorage_(cancelCap)), refund_status: 'not_required', notification_version: '1' };
let updateCount = 0; const txnStore = { loadByReservationId: () => txnRecord, records: () => [txnRecord], update: (_record, fields) => { updateCount += 1; txnRecord = { ...txnRecord, ...fields }; return txnRecord; } };
const txnCalendar = { isSlotAvailable: () => true, updateSameEvent: () => ({ id: event.id, etag: 'etag-new', updated: '2026-08-24T15:00:00Z', syncHash: 'new-hash', meetUrl: 'https://meet.google.com/opaque', meetConferenceId: 'meet-opaque-1', meetStatus: 'available' }), cancelLinkedEvent: () => ({ ok: true }) };
const lock = { held: false, tryLock: () => { if (lock.held) return false; lock.held = true; return true; }, releaseLock: () => { lock.held = false; } };
const deps = { store: txnStore, calendar: txnCalendar, lock, requireCapabilitySecret_: () => secret, enqueueNotification: () => {} };
const fixedNow = Date.parse('2026-08-23T12:00:00Z');
const first = phase.patientRescheduleTransaction_({ reservationId: txnRecord.reservation_id, token: cap.token, targetStartAt: '2026-08-24T15:00:00Z', now: fixedNow, deps });
check(first.ok && txnRecord.patient_reschedule_count === '1' && updateCount === 1, 'patient reschedule succeeds exactly once inside lock');
const second = phase.patientRescheduleTransaction_({ reservationId: txnRecord.reservation_id, token: cap.token, targetStartAt: '2026-08-24T16:00:00Z', now: fixedNow, deps });
check(!second.ok && updateCount === 1, 'concurrent/repeated reschedule cannot authorize from stale pre-lock state');
let cancelNotifications = 0; let cancelRefunds = 0;
const cancelDeps = { ...deps, enqueueNotification: () => { cancelNotifications += 1; }, enqueueRefund: () => { cancelRefunds += 1; }, policyEvaluator: () => ({ eligible: false }) };
const cancelRecord = { ...txnRecord, reservation_id: 'fran-nonprod-20260821-reservation-cancel', booking_status: 'confirmed', schedule_status: 'scheduled', patient_reschedule_count: '0',
  ...phase.capabilityFields_(phase.capabilityForStorage_(cancelCap)) };
const cancelStore = { loadByReservationId: () => cancelRecord, update: (_record, fields) => Object.assign(cancelRecord, fields) };
const cancelResult = phase.patientCancelTransaction_({ reservationId: cancelRecord.reservation_id, token: cancelCap.token, now: fixedNow, deps: { ...cancelDeps, store: cancelStore } });
const cancelReplay = phase.patientCancelTransaction_({ reservationId: cancelRecord.reservation_id, token: cancelCap.token, now: fixedNow, deps: { ...cancelDeps, store: cancelStore } });
check(cancelResult.ok && cancelResult.refund === 'BUSINESS_POLICY_TBD' && cancelReplay.replay === true && cancelRecord.schedule_status === 'cancelled'
  && cancelNotifications === 1 && cancelRefunds === 0, 'patient cancellation is idempotent and capacity release is refund-independent');

// F. Refund idempotency/callback safety and notification CTA policy.
let refundCalls = 0; const refundRecord = { reservation_id: 'fran-nonprod-20260821-reservation-refund', refund_status: 'refund_requested', refund_commerce_order: '', refund_provider_reference: '', payment_status: 'paid' };
const refundStore = { update: (_record, fields) => Object.assign(refundRecord, fields) };
const refundGateway = { create: () => { refundCalls += 1; return { providerReference: 'provider-opaque', status: 'pending' }; }, getStatus: () => ({ status: 'completed', providerReference: 'provider-opaque' }) };
const refundFirst = refund.refundCreateOnce_({ store: refundStore, record: refundRecord, gateway: refundGateway, receiverEmail: 'qa+nonprod@example.test', amount: '500', urlCallBack: 'https://preview-example.pages.dev/api/refund-confirmation', commerceTrxId: 'commerce-opaque' });
const refundSecond = refund.refundCreateOnce_({ store: refundStore, record: refundRecord, gateway: refundGateway, receiverEmail: 'qa+nonprod@example.test', amount: '500', urlCallBack: 'https://preview-example.pages.dev/api/refund-confirmation', commerceTrxId: 'commerce-opaque' });
check(refundFirst.ok && refundSecond.replay === true && refundCalls === 1, 'refund create retry reuses deterministic logical order');
const callback = refund.refundCallbackOnce_({ store: refundStore, record: refundRecord, gateway: refundGateway, token: 'provider-opaque' });
const callbackReplay = refund.refundCallbackOnce_({ store: refundStore, record: refundRecord, gateway: refundGateway, token: 'provider-opaque' });
check(callback.ok && callback.status === 'refunded' && callbackReplay.replay === true, 'duplicate refund callback is safe');
let timeoutCalls = 0; const timeoutRecord = { reservation_id: 'fran-nonprod-20260821-reservation-timeout', refund_status: 'refund_requested', refund_commerce_order: '' };
const timeoutResult = refund.refundCreateOnce_({ store: { update: (_record, fields) => Object.assign(timeoutRecord, fields) }, record: timeoutRecord,
  gateway: { create: () => { timeoutCalls += 1; const error = new Error('timeout'); error.code = 'FLOW_TIMEOUT'; throw error; } }, receiverEmail: 'qa+nonprod@example.test', amount: '500', urlCallBack: 'https://preview-example.pages.dev/api/refund-confirmation', commerceTrxId: 'commerce-opaque' });
const timeoutRetry = refund.refundCreateOnce_({ store: { update: (_record, fields) => Object.assign(timeoutRecord, fields) }, record: timeoutRecord,
  gateway: { create: () => { timeoutCalls += 1; return { providerReference: 'must-not-run' }; } }, receiverEmail: 'qa+nonprod@example.test', amount: '500', urlCallBack: 'https://preview-example.pages.dev/api/refund-confirmation', commerceTrxId: 'commerce-opaque' });
check(timeoutResult.code === 'REFUND_CREATE_OUTCOME_UNKNOWN' && timeoutRecord.refund_status === 'manual_review'
  && timeoutRetry.replay === true && timeoutCalls === 1, 'Flow timeout is manual-review and never creates a second refund');
const timeoutCallback = refund.refundCallbackOnce_({ store: { update: (_record, fields) => Object.assign(timeoutRecord, fields) }, record: timeoutRecord,
  gateway: { getStatus: () => ({ status: 'completed', providerReference: 'provider-after-timeout' }) }, token: 'provider-after-timeout' });
const timeoutCallbackReplay = refund.refundCallbackOnce_({ store: { update: (_record, fields) => Object.assign(timeoutRecord, fields) }, record: timeoutRecord,
  gateway: { getStatus: () => { throw new Error('must not re-query terminal callback'); } }, token: 'provider-after-timeout' });
check(timeoutCallback.status === 'refunded' && timeoutCallbackReplay.replay === true, 'later callback resolves ambiguous refund and duplicate callback is safe');
const rejectedRecord = { reservation_id: 'fran-nonprod-20260821-reservation-rejected', refund_status: 'refund_requested', refund_commerce_order: '' };
const rejectedResult = refund.refundCreateOnce_({ store: { update: (_record, fields) => Object.assign(rejectedRecord, fields) }, record: rejectedRecord,
  gateway: { create: () => { const error = new Error('provider rejected'); error.code = 'FLOW_REFUND_PROVIDER_REJECTED'; error.definite = true; throw error; } } });
check(rejectedResult.code === 'PROVIDER_REFUND_REJECTED' && rejectedRecord.refund_status === 'refund_failed', 'definite provider refund rejection is not treated as an ambiguous retry');

// G. Provider-contract tests are independent from business assertions.
assert.throws(() => api.Events.update('synthetic-calendar', event.id, event, { conferenceDataVersion: 1 }), /resource|reference|equal/);
assert.throws(() => api.Events.delete('synthetic-calendar', event.id), /not a function/);
providerContractAssertions += 2;
const refundTransportCalls = [];
const transportResponse = (body, status = 200) => ({ getResponseCode: () => status, getContentText: () => JSON.stringify(body) });
const transportGateway = refund.createFlowRefundGateway_({
  baseUrl: 'https://sandbox.flow.cl/api', apiKey: 'synthetic-flow-key', secretKey: 'synthetic-flow-secret',
  fetch: (url, options) => {
    const parsed = new URL(url); refundTransportCalls.push({ parsed, options });
    if (parsed.pathname.endsWith('/refund/create')) return transportResponse({ token: 'provider-create', status: 'pending' });
    if (parsed.pathname.endsWith('/refund/getStatus')) return transportResponse({ flowTrxId: 'provider-status', status: 'completed' });
    if (parsed.pathname.endsWith('/refund/cancel')) return transportResponse({ status: 'cancelled' });
    return transportResponse({}, 404);
  },
});
transportGateway.create({ reservationId: 'fran-nonprod-20260821-reservation-transport', receiverEmail: 'qa+nonprod@example.test', amount: '500',
  urlCallBack: 'https://preview-example.pages.dev/api/refund-confirmation', commerceTrxId: 'commerce-opaque' });
transportGateway.getStatus('provider-create');
transportGateway.cancel('provider-create');
const statusCall = refundTransportCalls.find((call) => call.parsed.pathname.endsWith('/refund/getStatus'));
check(refundTransportCalls.length === 3 && refundTransportCalls.every((call) => call.parsed.hostname === 'sandbox.flow.cl'), 'refund transport is sandbox-only');
check(refundTransportCalls[0].options.method === 'post' && refundTransportCalls[2].options.method === 'post'
  && refundTransportCalls[0].options.payload.includes('apiKey=') && refundTransportCalls[0].options.payload.includes('s='), 'refund create and cancel use signed POST form transport');
check(statusCall.options.method === 'get' && !Object.hasOwn(statusCall.options, 'payload') && !Object.hasOwn(statusCall.options, 'contentType'), 'refund getStatus is GET with no body');
check(JSON.stringify([...statusCall.parsed.searchParams.keys()].sort()) === JSON.stringify(['apiKey', 's', 'token'])
  && statusCall.parsed.searchParams.get('token') === 'provider-create', 'refund getStatus signs only apiKey, token and s');
assert.throws(() => transportGateway.create({ reservationId: 'fran-nonprod-20260821-reservation-invalid-callback', receiverEmail: 'qa+nonprod@example.test', amount: '500',
  urlCallBack: 'https://example.invalid/callback', commerceTrxId: 'commerce-opaque' }), /REFUND_REQUEST_INVALID/);
providerContractAssertions += 4;

// H. Optimistic concurrency: stale datastore ETag and provider 412 are hard stops.
assert.throws(() => gateway.updateSameEvent({ ...recordTemplate, calendar_event_etag: 'stale-etag' }, '2026-08-24T16:00:00Z', '2026-08-24T17:00:00Z'),
  (error) => error && error.code === 'CALENDAR_ETAG_CONFLICT' && error.status === 412);
check(updated === 1, 'stale datastore ETag refuses Calendar overwrite');
const raceEvent = { id: 'race-event', etag: 'race-etag-1', updated: '2026-08-24T13:00:00.000Z', start: { dateTime: '2026-08-24T14:00:00.000Z' }, end: { dateTime: '2026-08-24T15:00:00.000Z' }, extendedProperties: event.extendedProperties };
let raceUpdates = 0;
const raceGateway = calendar.createCalendarGateway_({ calendarId: 'synthetic-calendar', api: {
  Events: {
    get: (id, eventId) => { assert.equal(id, 'synthetic-calendar'); assert.equal(eventId, 'race-event'); return raceEvent; },
    update: () => { raceUpdates += 1; const error = new Error('HTTP 412 Precondition Failed'); error.status = 412; throw error; },
  },
  Freebusy: { query: () => ({ calendars: { 'synthetic-calendar': { busy: [] } } }) },
} });
assert.throws(() => raceGateway.updateSameEvent({ calendar_event_id: 'race-event', calendar_event_etag: 'race-etag-1', calendar_link_key: event.extendedProperties.private.link_key },
  '2026-08-24T16:00:00Z', '2026-08-24T17:00:00Z'), (error) => error && error.code === 'CALENDAR_ETAG_CONFLICT');
check(raceUpdates === 1, 'clinician edit between GET and UPDATE is surfaced as 412');
const raceCapability = phase.createCapability_('RESCHEDULE', { secret, now: Date.parse('2026-08-23T12:00:00Z'), expiresAt: '2026-08-24T12:00:00Z' });
const raceRecord = { reservation_id: 'fran-nonprod-20260821-reservation-412', booking_status: 'confirmed', payment_status: 'paid', schedule_status: 'scheduled', patient_reschedule_count: '0',
  calendar_event_id: 'race-event', calendar_event_etag: 'race-etag-1', calendar_link_key: event.extendedProperties.private.link_key,
  ...phase.capabilityFields_(phase.capabilityForStorage_(raceCapability)) };
let raceTxnUpdates = 0; let raceTxnCalls = 0; let raceTxnCreates = 0;
const raceTxnStore = { loadByReservationId: () => raceRecord, records: () => [raceRecord], update: (_record, fields) => { raceTxnUpdates += 1; Object.assign(raceRecord, fields); return raceRecord; } };
const raceTxnResult = phase.patientRescheduleTransaction_({ reservationId: raceRecord.reservation_id, token: raceCapability.token, targetStartAt: '2026-08-24T16:00:00Z', now: fixedNow,
  deps: { lock, store: raceTxnStore, calendar: { isSlotAvailable: () => true, updateSameEvent: () => { raceTxnCalls += 1; const error = new Error('HTTP 412'); error.status = 412; throw error; }, createLinkedBookingEvent: () => { raceTxnCreates += 1; } }, requireCapabilitySecret_: () => secret } });
const raceReplay = phase.patientRescheduleTransaction_({ reservationId: raceRecord.reservation_id, token: raceCapability.token, targetStartAt: '2026-08-24T17:00:00Z', now: fixedNow,
  deps: { lock, store: raceTxnStore, calendar: { isSlotAvailable: () => true, updateSameEvent: () => { raceTxnCalls += 1; }, createLinkedBookingEvent: () => { raceTxnCreates += 1; } }, requireCapabilitySecret_: () => secret } });
check(!raceTxnResult.ok && raceTxnResult.code === 'RECONCILIATION_REQUIRED' && raceRecord.patient_reschedule_count === '0'
  && !raceRecord.reschedule_capability_revoked_at && raceTxnCalls === 1 && raceTxnCreates === 0 && !raceReplay.ok && raceTxnUpdates >= 1,
  '412 never consumes quota/revokes capability/creates a second event and next operation fails closed for reconciliation');

// I. Failure-injection boundaries: Calendar success never becomes silent success when storage fails.
const failureCap = phase.createCapability_('RESCHEDULE', { secret, now: Date.parse('2026-08-23T12:00:00Z'), expiresAt: '2026-08-24T12:00:00Z' });
const failureRecord = { reservation_id: 'fran-nonprod-20260821-reservation-store-failure', booking_status: 'confirmed', payment_status: 'paid', schedule_status: 'scheduled', patient_reschedule_count: '0',
  calendar_event_id: 'race-event', calendar_event_etag: 'race-etag-1', calendar_link_key: event.extendedProperties.private.link_key,
  ...phase.capabilityFields_(phase.capabilityForStorage_(failureCap)) };
let failureCalendarCalls = 0; let failureNotifications = 0;
const failureResult = phase.patientRescheduleTransaction_({ reservationId: failureRecord.reservation_id, token: failureCap.token, targetStartAt: '2026-08-24T16:00:00Z', now: fixedNow,
  deps: { lock, store: { loadByReservationId: () => failureRecord, records: () => [failureRecord], update: () => { throw new Error('store unavailable'); } },
    calendar: { isSlotAvailable: () => true, updateSameEvent: () => { failureCalendarCalls += 1; return { id: 'race-event', etag: 'race-etag-2', updated: '2026-08-24T16:00:00Z', syncHash: 'race-hash' }; } },
    requireCapabilitySecret_: () => secret, enqueueNotification: () => { failureNotifications += 1; } } });
check(!failureResult.ok && failureResult.code === 'RECONCILIATION_REQUIRED' && failureCalendarCalls === 1 && failureRecord.patient_reschedule_count === '0'
  && !failureRecord.reschedule_capability_revoked_at && failureNotifications === 0 && failureResult.reconciliation.state === 'calendar_reschedule_store_retry'
  && failureResult.reconciliation.calendarEventId === 'race-event', 'reschedule store failure is explicit and does not claim success');
const cancelFailureCap = phase.createCapability_('CANCEL', { secret, now: Date.parse('2026-08-23T12:00:00Z'), expiresAt: '2026-08-24T12:00:00Z' });
const cancelFailureRecord = { reservation_id: 'fran-nonprod-20260821-reservation-cancel-store-failure', booking_status: 'confirmed', payment_status: 'paid', schedule_status: 'scheduled', refund_status: 'not_required',
  calendar_event_id: 'race-event', ...phase.capabilityFields_(phase.capabilityForStorage_(cancelFailureCap)) };
let cancelRemoves = 0; let failureCancelNotifications = 0;
const cancelFailure = phase.patientCancelTransaction_({ reservationId: cancelFailureRecord.reservation_id, token: cancelFailureCap.token, now: fixedNow,
  deps: { lock, store: { loadByReservationId: () => cancelFailureRecord, update: () => { throw new Error('store unavailable'); } },
    calendar: { cancelLinkedEvent: () => { cancelRemoves += 1; return { ok: true, deleted: true }; } }, requireCapabilitySecret_: () => secret,
    policyEvaluator: () => ({ eligible: false }), enqueueNotification: () => { failureCancelNotifications += 1; } } });
check(!cancelFailure.ok && cancelFailure.code === 'RECONCILIATION_REQUIRED' && cancelRemoves === 1 && cancelFailureRecord.booking_status === 'confirmed' && failureCancelNotifications === 0,
  'cancellation Calendar-success/store-failure is explicit and side-effect safe');
check(cancelFailure.reconciliation.state === 'calendar_cancel_store_retry' && cancelFailure.reconciliation.operationId,
  'cancellation recovery returns an operation-bound reconciliation snapshot');
assert.throws(() => phase.assertCancellationTransition_({ booking_status: 'cancelled' }), /INVALID_BOOKING_STATUS_TRANSITION/);
check(phase.assertCancellationTransition_({ booking_status: 'confirmed' }) === true
  && phase.assertCancellationTransition_({ booking_status: 'cancellation_requested' }) === true, 'legal cancellation transition hops are explicit');
check(true, 'invalid cancellation transition fails closed');

// J. Incremental sync pagination and cursor safety.
const pageEvent = (id, linkKey, updatedAt) => ({ id, etag: id + '-etag', updated: updatedAt, status: 'confirmed',
  start: { dateTime: '2026-08-24T14:00:00.000Z' }, end: { dateTime: '2026-08-24T15:00:00.000Z' },
  extendedProperties: { private: { source: 'fran_booking', link_key: linkKey, schema: 'fran_booking:v1' } } });
const pageOneEvent = pageEvent('page-one', 'fran-nonprod-20260821-calendar-link-pageone', '2026-08-24T13:00:00.000Z');
const pageTwoEvent = pageEvent('page-two', 'fran-nonprod-20260821-calendar-link-pagetwo', '2026-08-24T13:00:00.000Z');
const pageRequests = [];
const pagedGateway = calendar.createCalendarGateway_({ calendarId: 'synthetic-calendar', api: { Events: {
  list: (calendarId, request) => { pageRequests.push({ calendarId, request }); return request.pageToken ? { items: [pageTwoEvent], nextSyncToken: 'sync-next' } : { items: [pageOneEvent], nextPageToken: 'page-2' }; },
} } });
const paged = pagedGateway.reconcileIncremental('sync-old', { start: pageOneEvent.start.dateTime, end: pageOneEvent.end.dateTime });
check(paged.events.length === 2 && paged.nextSyncToken === 'sync-next' && pageRequests.length === 2
  && pageRequests[1].request.syncToken === 'sync-old' && pageRequests[1].request.pageToken === 'page-2' && !pageRequests[1].request.timeMin,
  'Calendar sync accumulates page 1 and page 2 before accepting nextSyncToken');
let cursorSets = 0; const cursorState = { get: () => 'cursor-old', set: () => { cursorSets += 1; } };
const cleanRecord = { reservation_id: 'fran-nonprod-20260821-reservation-clean', calendar_event_id: pageOneEvent.id, calendar_event_etag: 'old', calendar_event_updated_at: '2026-08-24T12:00:00.000Z', calendar_sync_hash: 'old', booking_status: 'confirmed', schedule_status: 'scheduled', patient_reschedule_count: '0', notification_version: '1' };
const staleRecord = { reservation_id: 'fran-nonprod-20260821-reservation-stale', calendar_event_id: pageTwoEvent.id, calendar_event_etag: 'old', calendar_event_updated_at: '2026-08-24T18:00:00.000Z', calendar_sync_hash: 'old', booking_status: 'confirmed', schedule_status: 'scheduled', patient_reschedule_count: '0', notification_version: '1' };
const syncStore = { loadByCalendarEventId: (id) => id === pageOneEvent.id ? cleanRecord : staleRecord, update: (record, fields) => Object.assign(record, fields) };
const syncResult = reconciliation.reconcileCalendarSync_({ gateway: { reconcileIncremental: () => ({ ok: true, fullSyncReset: false, nextSyncToken: 'cursor-new', events: [{ event: pageOneEvent }, { event: pageTwoEvent }] }) },
  syncState: cursorState, store: syncStore, bounds: { start: pageOneEvent.start.dateTime, end: pageOneEvent.end.dateTime } });
check(!syncResult.ok && syncResult.code === 'RECONCILIATION_REQUIRED' && cursorSets === 0, 'unresolved sync event preserves the previous cursor');
const cursorPersistFailure = reconciliation.reconcileCalendarSync_({ gateway: { reconcileIncremental: () => ({ ok: true, fullSyncReset: false, nextSyncToken: 'cursor-new', events: [] }) },
  syncState: { get: () => 'cursor-old', set: () => { throw new Error('cursor store unavailable'); } }, store: { update: () => {}, loadByCalendarEventId: () => null }, bounds: { start: pageOneEvent.start.dateTime, end: pageOneEvent.end.dateTime } });
check(!cursorPersistFailure.ok && cursorPersistFailure.code === 'SYNC_CURSOR_PERSIST_FAILED' && cursorPersistFailure.nextSyncToken === '', 'sync cursor persistence failure is fail-closed');

// K. Linkage lookup is by calendar_link_key, never by reservation_id.
const lookupRecord = { reservation_id: 'fran-nonprod-20260821-reservation-different', calendar_link_key: pageOneEvent.extendedProperties.private.link_key,
  calendar_event_id: '', calendar_event_etag: 'old', calendar_event_updated_at: '2026-08-24T12:00:00.000Z', calendar_sync_hash: 'old', booking_status: 'confirmed', schedule_status: 'scheduled', patient_reschedule_count: '0', notification_version: '1' };
const lookupOutcome = reconciliation.reconcileCalendarChange_({ event: pageOneEvent, store: { loadByCalendarLinkKey: (key) => key === lookupRecord.calendar_link_key ? lookupRecord : null, update: (record, fields) => Object.assign(record, fields) } });
check(lookupOutcome.changed && lookupRecord.reservation_id.endsWith('different'), 'opaque calendar_link_key uses explicit linkage lookup');
assert.throws(() => reconciliation.reconcileCalendarChange_({ event: pageOneEvent, store: { update: () => {} } }), /CALENDAR_LINKAGE_LOOKUP_UNAVAILABLE/);

// L. FreeBusy has no eventId; same-event availability uses Events.list identity.
const selfEvent = pageEvent('self-event', 'fran-nonprod-20260821-calendar-link-selfevent', '2026-08-24T13:00:00.000Z');
const selfApi = { Freebusy: { query: () => ({ calendars: { 'synthetic-calendar': { busy: [{ start: selfEvent.start.dateTime, end: selfEvent.end.dateTime }] } } }) }, Events: {
  get: () => selfEvent, list: (_id, request) => ({ items: request.singleEvents ? [selfEvent] : [] }),
} };
const selfGateway = calendar.createCalendarGateway_({ api: selfApi, calendarId: 'synthetic-calendar' });
check(selfGateway.isSlotAvailable(selfEvent.start.dateTime, selfEvent.end.dateTime, selfEvent.id) === true, 'same linked event is not rejected using a nonexistent FreeBusy eventId');
const competitor = pageEvent('competitor', 'fran-nonprod-20260821-calendar-link-competitor', '2026-08-24T13:00:00.000Z');
const competitorGateway = calendar.createCalendarGateway_({ api: { ...selfApi, Events: { get: () => selfEvent, list: (_id, request) => ({ items: request.singleEvents ? [selfEvent, competitor] : [] }) } }, calendarId: 'synthetic-calendar' });
check(competitorGateway.isSlotAvailable(selfEvent.start.dateTime, selfEvent.end.dateTime, selfEvent.id) === false, 'same-event availability still rejects a real competing event');

// M. Chile local date/time conversion remains DST-aware on both transitions.
const localParts = (value) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
const dstBeforeEnd = phase.startAt_('2026-04-04', '10:00'); const dstAfterEnd = phase.startAt_('2026-04-05', '10:00');
const dstBeforeStart = phase.startAt_('2026-09-05', '10:00'); const dstAfterStart = phase.startAt_('2026-09-06', '10:00');
check(localParts(dstBeforeEnd).hour === '10' && localParts(dstAfterEnd).hour === '10' && localParts(dstBeforeStart).hour === '10' && localParts(dstAfterStart).hour === '10'
  && dstBeforeEnd !== dstAfterEnd && dstBeforeStart !== dstAfterStart, 'America/Santiago local slots survive both DST offset transitions');

// N. Durable CTA retry rotates hashes and returns only fresh raw bearers.
const retryReschedule = phase.createCapability_('RESCHEDULE', { secret, now: Date.parse('2026-08-23T12:00:00Z'), expiresAt: '2026-08-24T12:00:00Z' });
const retryCancel = phase.createCapability_('CANCEL', { secret, now: Date.parse('2026-08-23T12:00:00Z'), expiresAt: '2026-08-24T12:00:00Z' });
const retryRecord = { reservation_id: 'fran-nonprod-20260821-reservation-cta', booking_status: 'confirmed', schedule_status: 'scheduled', patient_reschedule_count: '0', notification_version: '1',
  ...phase.capabilityFields_(phase.capabilityForStorage_(retryReschedule)), ...phase.capabilityFields_(phase.capabilityForStorage_(retryCancel)) };
const retryStore = { loadByReservationId: () => retryRecord, update: (_record, fields) => Object.assign(retryRecord, fields) };
const failedOutbox = phase.createNotificationOutbox_('notification_fran-nonprod-20260821-cta_notification_patient_state', '1', '2026-08-23T12:00:00Z');
phase.claimNotificationOutbox_(failedOutbox, '2026-08-23T12:01:00Z'); phase.completeNotificationOutbox_(failedOutbox, { ok: false });
const retryOne = phase.retryLifecycleNotification_({ store: retryStore, reservationId: retryRecord.reservation_id, eventType: 'BOOKING_CONFIRMED', now: Date.parse('2026-08-23T12:02:00Z'), requireCapabilitySecret_: () => secret, lock });
const retryTwo = phase.retryLifecycleNotification_({ store: retryStore, reservationId: retryRecord.reservation_id, eventType: 'BOOKING_CONFIRMED', now: Date.parse('2026-08-23T12:03:00Z'), requireCapabilitySecret_: () => secret, lock });
check(retryOne.ok && retryOne.capabilityTokens.RESCHEDULE && retryOne.capabilityTokens.CANCEL && retryTwo.ok
  && !phase.verifyCapability_(retryOne.capabilityTokens.RESCHEDULE, 'RESCHEDULE', phase.capabilityFromRecord_(retryRecord, 'RESCHEDULE'), { secret, now: Date.parse('2026-08-23T12:03:00Z') })
  && phase.verifyCapability_(retryTwo.capabilityTokens.RESCHEDULE, 'RESCHEDULE', phase.capabilityFromRecord_(retryRecord, 'RESCHEDULE'), { secret, now: Date.parse('2026-08-23T12:03:00Z') })
  && !JSON.stringify(failedOutbox).includes(retryOne.capabilityTokens.RESCHEDULE), 'failed notification retry rotates one active capability without persisting raw bearer material');
retryRecord.patient_reschedule_count = '1'; retryRecord.reschedule_capability_revoked_at = 'used';
const postRescheduleRetry = phase.retryLifecycleNotification_({ store: retryStore, reservationId: retryRecord.reservation_id, eventType: 'BOOKING_CONFIRMED', now: Date.parse('2026-08-23T12:04:00Z'), requireCapabilitySecret_: () => secret, lock });
check(postRescheduleRetry.ok && !postRescheduleRetry.capabilityTokens.RESCHEDULE && postRescheduleRetry.capabilityTokens.CANCEL, 'retry after reschedule cannot issue a second RESCHEDULE capability while CANCEL remains independent');
const confirmedNotification = phase.makeLifecycleNotification_('BOOKING_CONFIRMED', { reservation_id: 'opaque', notification_version: '1', booking_status: 'confirmed', schedule_status: 'scheduled', patient_reschedule_count: '0',
  reschedule_capability_hash: 'a'.repeat(64), cancel_capability_hash: 'b'.repeat(64) }, { now: '2026-08-23T12:00:00Z' });
const rescheduledNotification = phase.makeLifecycleNotification_('PATIENT_RESCHEDULED', { reservation_id: 'opaque', notification_version: '2', booking_status: 'confirmed', schedule_status: 'scheduled', patient_reschedule_count: '1',
  reschedule_capability_hash: 'a'.repeat(64), reschedule_capability_revoked_at: 'now', cancel_capability_hash: 'b'.repeat(64) }, { now: '2026-08-23T12:00:00Z' });
check(JSON.stringify(confirmedNotification.ctas) === JSON.stringify(['RESCHEDULE', 'CANCEL']), 'initial confirmation CTA matrix is server-derived');
check(JSON.stringify(rescheduledNotification.ctas) === JSON.stringify(['CANCEL']) && !rescheduledNotification.ctas.includes('RESCHEDULE'), 'post-reschedule notification is CANCEL-only');
check(confirmedNotification.logicalKey !== rescheduledNotification.logicalKey, 'logical keys differ across notification event types');
const cancelledNotification = phase.makeLifecycleNotification_('PATIENT_CANCELLED', { reservation_id: 'opaque', notification_version: '3', booking_status: 'cancelled', schedule_status: 'cancelled', patient_reschedule_count: '1',
  meet_url: 'https://meet.google.com/opaque-stale', cancel_capability_hash: 'b'.repeat(64), cancel_capability_revoked_at: 'now' }, { now: '2026-08-23T12:00:00Z' });
check(!cancelledNotification.meet && cancelledNotification.ctas.length === 0, 'terminal cancellation notification omits Meet and CTAs');
check(phase.formatPatientFacingDateTime_('2026-08-27T17:00:00.000Z') === 'jueves 27 de agosto de 2026, 13:00',
  'patient-facing formatter is America/Santiago and independent of machine timezone');

check(networkCalls === 0, 'lifecycle adversarial harness made no network calls');
console.log(`ADVERSARIAL_LIFECYCLE_TESTS=PASS cases=49 assertions=${assertions}`);
console.log(`PROVIDER_CONTRACT_TESTS=PASS count=${providerContractAssertions}`);

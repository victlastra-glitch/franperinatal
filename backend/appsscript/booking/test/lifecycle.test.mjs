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
  console, Date, Set, Number, String, Object, Array, JSON, RegExp, Math, encodeURIComponent, decodeURIComponent,
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
let inserted = 0; let updated = 0; let deleted = 0; let listCalls = 0;
const event = { id: 'event-opaque-1', etag: 'etag-1', updated: '2026-08-24T13:00:00.000Z', status: 'confirmed',
  start: { dateTime: '2026-08-24T14:00:00.000Z' }, end: { dateTime: '2026-08-24T15:00:00.000Z' },
  extendedProperties: { private: { source: 'fran_booking', link_key: 'fran-nonprod-20260821-calendar-link-abcdef0123456789', schema: 'fran_booking:v1' } },
  conferenceData: { conferenceId: 'meet-opaque-1', entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque' }] } };
const api = {
  Freebusy: { query: () => ({ calendars: { 'synthetic-calendar': { busy: manuallyBusy } } }) },
  Events: {
    list: () => { listCalls += 1; return { items: listCalls === 1 ? [] : [event], nextSyncToken: 'sync-next' }; },
    get: () => event,
    insert: (resource) => { inserted += 1; Object.assign(event, resource); event.conferenceData = { conferenceId: 'meet-opaque-1', entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque' }] }; return event; },
    update: (_calendarId, _id, resource) => { updated += 1; Object.assign(event, resource, { etag: 'etag-2', updated: '2026-08-24T14:00:00.000Z' }); return event; },
    delete: () => { deleted += 1; },
  },
};
const gateway = calendar.createCalendarGateway_({ api, calendarId: 'synthetic-calendar', requestMeet: true });
const recordTemplate = { reservation_id: 'fran-nonprod-20260821-reservation-opaque', calendar_link_key: event.extendedProperties.private.link_key,
  current_start_at: '2026-08-24T14:00:00.000Z', current_end_at: '2026-08-24T15:00:00.000Z' };
const created = gateway.createLinkedBookingEvent(recordTemplate);
check(inserted === 1 && created.id === event.id, 'linked booking event is created once');
const retried = gateway.createLinkedBookingEvent(recordTemplate);
check(inserted === 1 && retried.id === event.id, 'linked event retry does not duplicate');
check(event.extendedProperties.private.source === 'fran_booking' && event.extendedProperties.private.link_key === recordTemplate.calendar_link_key
  && !JSON.stringify(event.extendedProperties.private).match(/patient|email|rut|phone|clinical|reason/i), 'Calendar linkage is opaque and contains no PII');
const moved = gateway.updateSameEvent({ ...recordTemplate, calendar_event_id: event.id }, '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z');
check(updated === 1 && moved.meetUrl === 'https://meet.google.com/opaque', 'same-event update preserves Meet and reads ETag/update');
check(gateway.cancelLinkedEvent({ calendar_event_id: event.id }).ok && deleted === 1, 'linked event cancellation is idempotent adapter operation');
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
const first = phase.patientRescheduleTransaction_({ reservationId: txnRecord.reservation_id, token: cap.token, targetStartAt: '2026-08-24T15:00:00Z', deps });
check(first.ok && txnRecord.patient_reschedule_count === '1' && updateCount === 1, 'patient reschedule succeeds exactly once inside lock');
const second = phase.patientRescheduleTransaction_({ reservationId: txnRecord.reservation_id, token: cap.token, targetStartAt: '2026-08-24T16:00:00Z', deps });
check(!second.ok && updateCount === 1, 'concurrent/repeated reschedule cannot authorize from stale pre-lock state');
const cancelDeps = { ...deps, enqueueNotification: () => {}, policyEvaluator: () => ({ eligible: false }) };
const cancelRecord = { ...txnRecord, reservation_id: 'fran-nonprod-20260821-reservation-cancel', booking_status: 'confirmed', schedule_status: 'scheduled', patient_reschedule_count: '0',
  ...phase.capabilityFields_(phase.capabilityForStorage_(cancelCap)) };
const cancelStore = { loadByReservationId: () => cancelRecord, update: (_record, fields) => Object.assign(cancelRecord, fields) };
const cancelResult = phase.patientCancelTransaction_({ reservationId: cancelRecord.reservation_id, token: cancelCap.token, deps: { ...cancelDeps, store: cancelStore } });
const cancelReplay = phase.patientCancelTransaction_({ reservationId: cancelRecord.reservation_id, token: cancelCap.token, deps: { ...cancelDeps, store: cancelStore } });
check(cancelResult.ok && cancelResult.refund === 'BUSINESS_POLICY_TBD' && cancelReplay.replay === true && cancelRecord.schedule_status === 'cancelled', 'patient cancellation is idempotent and capacity release is refund-independent');

// F. Refund idempotency/callback safety and notification CTA policy.
let refundCalls = 0; const refundRecord = { reservation_id: 'fran-nonprod-20260821-reservation-refund', refund_status: 'refund_requested', refund_commerce_order: '', refund_provider_reference: '', payment_status: 'paid' };
const refundStore = { update: (_record, fields) => Object.assign(refundRecord, fields) };
const refundGateway = { create: () => { refundCalls += 1; return { providerReference: 'provider-opaque', status: 'pending' }; }, getStatus: () => ({ status: 'completed', providerReference: 'provider-opaque' }) };
const refundFirst = refund.refundCreateOnce_({ store: refundStore, record: refundRecord, gateway: refundGateway, receiverEmail: 'qa+nonprod@example.test', amount: '1', urlCallBack: 'https://preview-example.pages.dev/api/refund-confirmation', commerceTrxId: 'commerce-opaque' });
const refundSecond = refund.refundCreateOnce_({ store: refundStore, record: refundRecord, gateway: refundGateway, receiverEmail: 'qa+nonprod@example.test', amount: '1', urlCallBack: 'https://preview-example.pages.dev/api/refund-confirmation', commerceTrxId: 'commerce-opaque' });
check(refundFirst.ok && refundSecond.replay === true && refundCalls === 1, 'refund create retry reuses deterministic logical order');
const callback = refund.refundCallbackOnce_({ store: refundStore, record: refundRecord, gateway: refundGateway, token: 'provider-opaque' });
const callbackReplay = refund.refundCallbackOnce_({ store: refundStore, record: refundRecord, gateway: refundGateway, token: 'provider-opaque' });
check(callback.ok && callback.status === 'refunded' && callbackReplay.replay === true, 'duplicate refund callback is safe');
let timeoutCalls = 0; const timeoutRecord = { reservation_id: 'fran-nonprod-20260821-reservation-timeout', refund_status: 'refund_requested', refund_commerce_order: '' };
const timeoutResult = refund.refundCreateOnce_({ store: { update: (_record, fields) => Object.assign(timeoutRecord, fields) }, record: timeoutRecord,
  gateway: { create: () => { timeoutCalls += 1; const error = new Error('timeout'); error.code = 'FLOW_TIMEOUT'; throw error; } }, receiverEmail: 'qa+nonprod@example.test', amount: '1', urlCallBack: 'https://preview-example.pages.dev/api/refund-confirmation', commerceTrxId: 'commerce-opaque' });
const timeoutRetry = refund.refundCreateOnce_({ store: { update: (_record, fields) => Object.assign(timeoutRecord, fields) }, record: timeoutRecord,
  gateway: { create: () => { timeoutCalls += 1; return { providerReference: 'must-not-run' }; } }, receiverEmail: 'qa+nonprod@example.test', amount: '1', urlCallBack: 'https://preview-example.pages.dev/api/refund-confirmation', commerceTrxId: 'commerce-opaque' });
check(timeoutResult.retry === 'status_only' && timeoutRetry.replay === true && timeoutCalls === 1, 'Flow timeout never creates a second refund');
const confirmedNotification = phase.makeLifecycleNotification_('BOOKING_CONFIRMED', { reservation_id: 'opaque', notification_version: '1', booking_status: 'confirmed', schedule_status: 'scheduled', patient_reschedule_count: '0',
  reschedule_capability_hash: 'a'.repeat(64), cancel_capability_hash: 'b'.repeat(64) }, { now: '2026-08-23T12:00:00Z' });
const rescheduledNotification = phase.makeLifecycleNotification_('PATIENT_RESCHEDULED', { reservation_id: 'opaque', notification_version: '2', booking_status: 'confirmed', schedule_status: 'scheduled', patient_reschedule_count: '1',
  reschedule_capability_hash: 'a'.repeat(64), reschedule_capability_revoked_at: 'now', cancel_capability_hash: 'b'.repeat(64) }, { now: '2026-08-23T12:00:00Z' });
check(JSON.stringify(confirmedNotification.ctas) === JSON.stringify(['RESCHEDULE', 'CANCEL']), 'initial confirmation CTA matrix is server-derived');
check(JSON.stringify(rescheduledNotification.ctas) === JSON.stringify(['CANCEL']) && !rescheduledNotification.ctas.includes('RESCHEDULE'), 'post-reschedule notification is CANCEL-only');

check(networkCalls === 0, 'lifecycle adversarial harness made no network calls');
console.log(`ADVERSARIAL_LIFECYCLE_TESTS=PASS count=25 assertions=${assertions}`);

import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const files = ['../Code.js', '../Lifecycle.js', '../CalendarGateway.js', '../Reconciliation.js', '../RefundGateway.js'];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const secret = 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz';
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const utilities = {
  DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
  computeDigest: (_algorithm, value) => bytes(createHash('sha256').update(String(value)).digest()),
  computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
};
const context = {
  console, Date, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math, encodeURIComponent, decodeURIComponent,
  Utilities: utilities,
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({}) }) },
  SpreadsheetApp: { openById: () => { throw new Error('spreadsheet stub must not be called'); } },
  CalendarApp: { getCalendarById: () => { throw new Error('calendar stub must not be called'); } },
  MailApp: { sendEmail: () => { throw new Error('mail must not be called'); } },
  GmailApp: { sendEmail: () => { throw new Error('mail must not be called'); } },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  UrlFetchApp: { fetch: () => { throw new Error('network must not be called'); } },
  Session: { getActiveUser: () => ({ getEmail: () => '' }) },
  ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (value) => ({ value, setMimeType() { return this; } }) },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);
const phase = context.__PHASE_A_TEST_EXPORTS__;
const calendar = context.__CALENDAR_TEST_EXPORTS__;
const reconciliation = context.__RECONCILIATION_TEST_EXPORTS__;

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

const LINK_KEY = 'fran-nonprod-20260821-calendar-link-metadata01';
const EVENT_ID = 'event-metadata-opaque-1';
const START_Z = '2026-09-03T19:00:00.000Z';
const END_Z = '2026-09-03T20:00:00.000Z';
const START_OFFSET = '2026-09-03T15:00:00.000-04:00';
const END_OFFSET = '2026-09-03T16:00:00.000-04:00';
const MEET_URI = 'https://meet.google.com/opaque-meet';

const requestedMeet = { createRequest: { requestId: LINK_KEY, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
const availableMeet = { conferenceId: 'meet-opaque-1', entryPoints: [{ entryPointType: 'video', uri: MEET_URI }] };

function linkedEvent(overrides = {}) {
  return {
    id: EVENT_ID, etag: 'etag-insert', updated: '2026-09-03T15:00:00.000Z', status: 'confirmed',
    start: { dateTime: START_Z }, end: { dateTime: END_Z },
    extendedProperties: { private: { source: 'fran_booking', link_key: LINK_KEY, schema: 'fran_booking:v1' } },
    conferenceData: requestedMeet,
    ...overrides,
  };
}

function persistConfirmed(event, extra = {}) {
  const result = calendar.calendarEventResult_(event);
  const interval = calendar.eventInterval_(event);
  return {
    reservation_id: 'fran-nonprod-20260821-reservation-metadata',
    booking_status: 'confirmed', payment_status: 'paid', schedule_status: 'scheduled',
    patient_reschedule_count: '0', refund_status: 'not_required', notification_version: '1',
    current_start_at: interval.start, current_end_at: interval.end,
    calendar_event_id: result.id, calendar_event_etag: result.etag, calendar_event_updated_at: result.updated,
    calendar_sync_hash: result.syncHash, calendar_link_key: event.extendedProperties.private.link_key,
    calendar_change_source: '', schedule_changed_at: '', last_operation_id: '',
    meet_url: result.meetUrl, meet_conference_id: result.meetConferenceId, meet_status: result.meetStatus,
    ...extra,
  };
}

function makeStore(holder) {
  return {
    loadByCalendarEventId: (id) => holder.record && holder.record.calendar_event_id === String(id) ? holder.record : null,
    loadByCalendarLinkKey: (key) => holder.record && holder.record.calendar_link_key === String(key) ? holder.record : null,
    update: (_record, fields) => { holder.record = { ...holder.record, ...fields }; return holder.record; },
    records: () => [holder.record],
  };
}

function runReconcile(holder, event, extra = {}) {
  let notifications = 0;
  const outcome = reconciliation.reconcileCalendarChange_({
    store: makeStore(holder), event,
    enqueueNotification: () => { notifications += 1; },
    ...extra,
  });
  return { outcome, notifications, record: holder.record };
}

check(reconciliation.sameAppointmentInstant_(START_Z, START_OFFSET) === true, 'equivalent ISO instants compare equal');
check(reconciliation.sameAppointmentInstant_(START_Z, '2026-09-03T15:00:00.000Z') === false, 'different instants compare unequal');
check(reconciliation.sameAppointmentInstant_('', START_Z) === false, 'missing instant fails closed');
check(reconciliation.sameAppointmentInstant_('not-a-time', START_Z) === false, 'invalid instant fails closed');
check(reconciliation.datastoreAppointmentInterval_({ current_start_at: START_Z, current_end_at: START_Z }).invalid === true,
  'non-positive datastore interval fails closed');

const insertEvent = linkedEvent();
check(calendar.meetFields_(insertEvent).meetStatus === 'requested' && calendar.meetFields_(insertEvent).meetConferenceId === '',
  'insert-time Meet is requested without conferenceId');

const holder = { record: persistConfirmed(insertEvent) };
check(holder.record.meet_status === 'requested' && holder.record.calendar_event_etag === 'etag-insert',
  'confirmed booking persists insert-time Calendar metadata');
const originalStart = holder.record.current_start_at;
const originalEnd = holder.record.current_end_at;
const originalHash = holder.record.calendar_sync_hash;
const originalScheduleChangedAt = holder.record.schedule_changed_at;

const meetReadyEvent = linkedEvent({
  etag: 'etag-meet-ready', updated: '2026-09-03T15:00:05.000Z', conferenceData: availableMeet,
});
check(calendar.calendarSyncHash_(meetReadyEvent) !== originalHash, 'Meet materialization changes calendarSyncHash_');
const meetReady = runReconcile(holder, meetReadyEvent);
check(meetReady.outcome.ok === true && meetReady.outcome.reason === 'metadata_refreshed' && meetReady.outcome.source === 'system',
  'Meet materialization is a metadata/system refresh');
check(meetReady.notifications === 0, 'Meet materialization does not enqueue CLINICIAN_RESCHEDULED');
check(meetReady.record.patient_reschedule_count === '0', 'Meet materialization leaves patient_reschedule_count unchanged');
check(meetReady.record.current_start_at === originalStart && meetReady.record.current_end_at === originalEnd,
  'Meet materialization leaves current start/end unchanged');
check(meetReady.record.calendar_event_id === EVENT_ID, 'Meet materialization keeps the same Calendar event id');
check(meetReady.record.calendar_event_etag === 'etag-meet-ready'
  && meetReady.record.calendar_event_updated_at === '2026-09-03T15:00:05.000Z'
  && meetReady.record.calendar_sync_hash === calendar.calendarSyncHash_(meetReadyEvent),
  'Meet materialization refreshes etag/updated/hash');
check(meetReady.record.meet_url === MEET_URI && meetReady.record.meet_conference_id === 'meet-opaque-1'
  && meetReady.record.meet_status === 'available', 'Meet materialization refreshes Meet metadata');
check(meetReady.record.calendar_change_source !== 'clinician' && meetReady.record.schedule_changed_at === originalScheduleChangedAt
  && meetReady.record.last_operation_id === '',
  'Meet materialization does not mark a clinician schedule change');

const genuineMoveEvent = linkedEvent({
  etag: 'etag-clinician-move', updated: '2026-09-03T16:00:00.000Z', conferenceData: availableMeet,
  start: { dateTime: '2026-09-03T21:00:00.000Z' }, end: { dateTime: '2026-09-03T22:00:00.000Z' },
});
const genuineMove = runReconcile(holder, genuineMoveEvent);
check(genuineMove.outcome.ok === true && genuineMove.outcome.changed === true && genuineMove.outcome.source === 'clinician',
  'genuine clinician move remains a clinician source');
check(genuineMove.notifications === 1, 'genuine clinician move enqueues exactly one CLINICIAN_RESCHEDULED');
check(genuineMove.record.current_start_at === '2026-09-03T21:00:00.000Z'
  && genuineMove.record.current_end_at === '2026-09-03T22:00:00.000Z',
  'genuine clinician move persists the new schedule');
check(genuineMove.record.calendar_event_id === EVENT_ID && genuineMove.record.meet_url === MEET_URI
  && genuineMove.record.meet_status === 'available',
  'genuine clinician move keeps the same event id and Meet');
check(genuineMove.record.patient_reschedule_count === '0' && genuineMove.record.calendar_change_source === 'clinician',
  'genuine clinician move does not consume patient quota');
const replay = runReconcile(holder, genuineMoveEvent);
check(replay.outcome.noop === true && replay.notifications === 0 && holder.record.patient_reschedule_count === '0',
  'duplicate genuine move replay remains ETag/hash idempotent');

const etagOnlyHolder = { record: persistConfirmed(insertEvent) };
const etagOnly = runReconcile(etagOnlyHolder, linkedEvent({ etag: 'etag-only' }));
check(etagOnly.outcome.reason === 'metadata_refreshed' && etagOnly.notifications === 0
  && etagOnly.record.current_start_at === START_Z && etagOnly.record.calendar_event_etag === 'etag-only',
  'same start/end with a changed ETag only is metadata refresh');

const updatedOnlyHolder = { record: persistConfirmed(insertEvent) };
const updatedOnly = runReconcile(updatedOnlyHolder, linkedEvent({ updated: '2026-09-03T15:00:09.000Z' }));
check(updatedOnly.outcome.reason === 'metadata_refreshed' && updatedOnly.notifications === 0
  && updatedOnly.record.calendar_event_updated_at === '2026-09-03T15:00:09.000Z'
  && updatedOnly.record.current_end_at === END_Z,
  'same start/end with a changed updated only is metadata refresh');

const offsetHolder = { record: persistConfirmed(insertEvent) };
const offsetEvent = linkedEvent({
  etag: 'etag-offset', updated: '2026-09-03T15:00:07.000Z',
  start: { dateTime: START_OFFSET }, end: { dateTime: END_OFFSET },
});
const offset = runReconcile(offsetHolder, offsetEvent);
check(offset.outcome.reason === 'metadata_refreshed' && offset.notifications === 0
  && offset.record.current_start_at === START_Z && offset.record.current_end_at === END_Z,
  'semantically equal timestamps with different ISO offsets are not a clinician move');

const startChangeHolder = { record: persistConfirmed(linkedEvent({ conferenceData: availableMeet })) };
const startChange = runReconcile(startChangeHolder, linkedEvent({
  etag: 'etag-start', updated: '2026-09-03T16:10:00.000Z', conferenceData: availableMeet,
  start: { dateTime: '2026-09-03T18:00:00.000Z' },
}));
check(startChange.outcome.source === 'clinician' && startChange.notifications === 1
  && startChange.record.current_start_at === '2026-09-03T18:00:00.000Z'
  && startChange.record.current_end_at === END_Z,
  'genuine start change remains a clinician reschedule');

const endChangeHolder = { record: persistConfirmed(linkedEvent({ conferenceData: availableMeet })) };
const endChange = runReconcile(endChangeHolder, linkedEvent({
  etag: 'etag-end', updated: '2026-09-03T16:11:00.000Z', conferenceData: availableMeet,
  end: { dateTime: '2026-09-03T21:00:00.000Z' },
}));
check(endChange.outcome.source === 'clinician' && endChange.notifications === 1
  && endChange.record.current_start_at === START_Z
  && endChange.record.current_end_at === '2026-09-03T21:00:00.000Z',
  'genuine end change remains a clinician reschedule');

const cancelHolder = { record: persistConfirmed(linkedEvent({ conferenceData: availableMeet })) };
const cancelSameTimes = runReconcile(cancelHolder, linkedEvent({
  etag: 'etag-cancel', updated: '2026-09-03T16:20:00.000Z', conferenceData: availableMeet,
  status: 'cancelled', deleted: true,
}), { policyEvaluator: () => ({ eligible: false }) });
check(cancelSameTimes.outcome.changed === true && cancelSameTimes.notifications === 1
  && cancelSameTimes.record.booking_status === 'cancelled' && cancelSameTimes.record.schedule_status === 'cancelled'
  && cancelSameTimes.record.cancellation_source === 'clinician',
  'cancelled/deleted event still takes the clinician cancellation path');

const staleHolder = { record: persistConfirmed(linkedEvent({ conferenceData: availableMeet, updated: '2026-09-03T16:00:00.000Z' })) };
const stale = runReconcile(staleHolder, linkedEvent({
  etag: 'etag-stale', updated: '2026-09-03T15:00:00.000Z', conferenceData: availableMeet,
}));
check(stale.outcome.code === 'STALE_CALENDAR_EVENT' && stale.notifications === 0
  && staleHolder.record.reconciliation_state === 'calendar_stale_event_retry'
  && staleHolder.record.current_start_at === START_Z,
  'stale Calendar event handling remains intact');

const badIntervalHolder = { record: persistConfirmed(insertEvent) };
const badInterval = runReconcile(badIntervalHolder, linkedEvent({
  etag: 'etag-bad-interval', start: { dateTime: END_Z }, end: { dateTime: START_Z },
}));
check(badInterval.outcome.code === 'CALENDAR_BAD_INTERVAL' && badInterval.notifications === 0, 'invalid Calendar interval fails closed');

const garbageHolder = { record: persistConfirmed(insertEvent, { current_start_at: 'not-a-time', current_end_at: END_Z }) };
const garbage = runReconcile(garbageHolder, linkedEvent({ etag: 'etag-garbage' }));
check(garbage.outcome.code === 'CALENDAR_BAD_INTERVAL' && garbage.notifications === 0,
  'unparseable datastore interval fails closed without a clinician notification');

const patientCap = phase.createCapability_('RESCHEDULE', { secret, now: Date.parse('2026-09-03T12:00:00Z'), expiresAt: '2026-09-04T12:00:00Z' });
let patientRecord = persistConfirmed(linkedEvent({ conferenceData: availableMeet }), {
  ...phase.capabilityFields_(phase.capabilityForStorage_(patientCap)),
});
const patientMovedEvent = linkedEvent({
  etag: 'etag-patient', updated: '2026-09-03T16:30:00.000Z', conferenceData: availableMeet,
  start: { dateTime: '2026-09-03T21:00:00.000Z' }, end: { dateTime: '2026-09-03T22:00:00.000Z' },
});
const patientResult = calendar.calendarEventResult_(patientMovedEvent);
const lock = { held: false, tryLock: () => { if (lock.held) return false; lock.held = true; return true; }, releaseLock: () => { lock.held = false; } };
let patientNotifications = 0;
const patientTxn = phase.patientRescheduleTransaction_({
  reservationId: patientRecord.reservation_id, token: patientCap.token,
  targetStartAt: '2026-09-03T21:00:00.000Z', targetEndAt: '2026-09-03T22:00:00.000Z',
  now: Date.parse('2026-09-03T16:30:00Z'),
  deps: {
    lock, store: {
      loadByReservationId: () => patientRecord, records: () => [patientRecord],
      update: (_record, fields) => { patientRecord = { ...patientRecord, ...fields }; return patientRecord; },
    },
    calendar: { isSlotAvailable: () => true, updateSameEvent: () => patientResult },
    requireCapabilitySecret_: () => secret,
    enqueueNotification: () => { patientNotifications += 1; },
  },
});
check(patientTxn.ok && patientRecord.patient_reschedule_count === '1' && patientRecord.calendar_change_source === 'patient'
  && patientNotifications === 1, 'patient reschedule still persists count=1 and patient change source');
const patientHolder = { record: patientRecord };
const patientFollowup = runReconcile(patientHolder, patientMovedEvent);
check(patientFollowup.outcome.noop === true && patientFollowup.notifications === 0
  && patientHolder.record.patient_reschedule_count === '1' && patientHolder.record.calendar_change_source === 'patient',
  'system-authored patient move is a no-op on the matching incremental event');
const patientMetaEvent = linkedEvent({
  etag: 'etag-patient-meet', updated: '2026-09-03T16:30:08.000Z', conferenceData: availableMeet,
  start: { dateTime: '2026-09-03T21:00:00.000Z' }, end: { dateTime: '2026-09-03T22:00:00.000Z' },
});
const patientMeta = runReconcile(patientHolder, patientMetaEvent);
check(patientMeta.outcome.reason === 'metadata_refreshed' && patientMeta.notifications === 0
  && patientHolder.record.patient_reschedule_count === '1' && patientHolder.record.calendar_change_source === 'patient'
  && patientHolder.record.current_start_at === '2026-09-03T21:00:00.000Z',
  'metadata follow-up after a patient move does not create a clinician notification');

const unrelatedHolder = { record: persistConfirmed(insertEvent, {
  schedule_status: 'reconciliation_required', reconciliation_state: 'notification_reschedule_retry',
}) };
const unrelated = runReconcile(unrelatedHolder, meetReadyEvent);
check(unrelated.outcome.reason === 'metadata_refreshed' && unrelated.notifications === 0
  && unrelated.record.reconciliation_state === 'notification_reschedule_retry'
  && unrelated.record.schedule_status === 'reconciliation_required',
  'metadata refresh does not clear unrelated reconciliation state');

const recoverHolder = { record: persistConfirmed(insertEvent, {
  schedule_status: 'reconciliation_required', reconciliation_state: 'calendar_reschedule_conflict',
}) };
const recovered = runReconcile(recoverHolder, meetReadyEvent);
check(recovered.outcome.reason === 'metadata_refreshed' && recovered.outcome.recovered === true
  && recovered.notifications === 0 && recoverHolder.record.schedule_status === 'scheduled'
  && recoverHolder.record.reconciliation_state === '' && recoverHolder.record.patient_reschedule_count === '0',
  'unchanged-event recovery still succeeds when only Calendar metadata evolved');

let cursorSets = 0;
const cursorRecord = persistConfirmed(insertEvent);
const cursorStore = {
  loadByCalendarEventId: () => cursorRecord,
  update: (_record, fields) => Object.assign(cursorRecord, fields),
};
const cursorSync = reconciliation.reconcileCalendarSync_({
  gateway: { reconcileIncremental: () => ({ ok: true, fullSyncReset: false, nextSyncToken: 'cursor-after-meta', events: [{ event: meetReadyEvent }] }) },
  syncState: { get: () => 'cursor-old', set: () => { cursorSets += 1; } },
  store: cursorStore, bounds: { start: START_Z, end: END_Z },
});
check(cursorSync.ok === true && cursorSync.nextSyncToken === 'cursor-after-meta' && cursorSets === 1
  && cursorSync.changed === 1 && cursorRecord.calendar_event_etag === 'etag-meet-ready'
  && cursorRecord.calendar_change_source !== 'clinician',
  'metadata-only incremental sync refreshes datastore and still advances the cursor');

console.log(`CALENDAR_METADATA_RECONCILIATION_TESTS=PASS assertions=${assertions}`);

/**
 * NONPROD-only targeted Calendar fixture harness.
 *
 * Operator infrastructure for Calendar reconciliation proofs without Flow.
 * Not a public product endpoint. Not invocable through doGet/doPost.
 * Production IDs, arbitrary spreadsheet/calendar/email arguments, raw
 * capability bearers, and Flow transport are all refused.
 */

var TARGETED_CALENDAR_FIXTURE_KEY = 'fran-nonprod-20260821-targeted-cal-v1';
var TARGETED_CALENDAR_FIXTURE_KIND = 'targeted-cal';
var TARGETED_CALENDAR_FIXTURE_CLEANUP_STATE = 'targeted_fixture_cleaned';
var TARGETED_CALENDAR_FIXTURE_OUTBOX_DISPOSITION = 'fixture_cleanup';

function targetedCalendarFixtureReservationId_() {
  return makeOpaqueId_(TARGETED_CALENDAR_FIXTURE_KIND, TARGETED_CALENDAR_FIXTURE_KEY);
}

function targetedCalendarFixtureLinkKey_() {
  return makeCalendarLinkKey_(TARGETED_CALENDAR_FIXTURE_KEY);
}

function isTargetedCalendarFixtureRecord_(record) {
  return Boolean(record)
    && String(record.idempotency_key || '') === TARGETED_CALENDAR_FIXTURE_KEY
    && String(record.reservation_id || '') === targetedCalendarFixtureReservationId_();
}

function assertTargetedFixtureEnvironment_(config) {
  const properties = PropertiesService.getScriptProperties().getProperties();
  if (String(properties.APP_ENV || '') !== NONPROD.appEnv) fail_('CONFIGURATION_INCOMPLETE');
  if (fingerprint_(properties.BOOKING_STORE_ID) !== NONPROD.bookingStoreFingerprint) fail_('CONFIGURATION_INCOMPLETE');
  if (fingerprint_(properties.CALENDAR_ID) !== NONPROD.calendarFingerprint) fail_('CONFIGURATION_INCOMPLETE');
  if (!config || fingerprint_(config.bookingStoreId) !== NONPROD.bookingStoreFingerprint) fail_('CONFIGURATION_INCOMPLETE');
  if (fingerprint_(config.calendarId) !== NONPROD.calendarFingerprint) fail_('CONFIGURATION_INCOMPLETE');
  if (String(config.idempotencyNamespace || '') !== NONPROD.idempotencyNamespace) fail_('CONFIGURATION_INCOMPLETE');
  assertTestRecipient_(config.internalNotificationEmail, config.patientAllowlist);
  return config;
}

function sanitizeTargetedCalendarFixtureEvidence_(record, extra) {
  extra = extra || {};
  const evidence = {
    ok: extra.ok !== false,
    fixtureKey: TARGETED_CALENDAR_FIXTURE_KEY,
    reservationId: String(record && record.reservation_id || ''),
    bookingStatus: String(record && record.booking_status || ''),
    paymentStatus: String(record && record.payment_status || ''),
    scheduleStatus: String(record && record.schedule_status || ''),
    patientRescheduleCount: String(record && record.patient_reschedule_count || ''),
    calendarEventPresent: Boolean(record && record.calendar_event_id),
    calendarEventId: String(record && record.calendar_event_id || ''),
    meetStatus: String(record && record.meet_status || ''),
    reconciliationState: String(record && record.reconciliation_state || ''),
  };
  if (extra.code) evidence.code = extra.code;
  if (extra.replay) evidence.replay = true;
  if (extra.cleaned) evidence.cleaned = true;
  if (extra.alreadyClean) evidence.alreadyClean = true;
  if (extra.reason) evidence.reason = extra.reason;
  return evidence;
}

function findTargetedCalendarFixtureRecord_(sheet, schema) {
  return reservationRecords_(sheet, schema).find(isTargetedCalendarFixtureRecord_) || null;
}

function deriveTargetedCalendarFixtureSlot_(calendarGateway, records) {
  const bounds = availabilityBounds_('');
  const slots = workingSlots_(bounds.start, bounds.end);
  let index = 0;
  for (; index < slots.length; index += 1) {
    const slot = slots[index];
    try { assertBookableSlot_(slot.date, slot.time); }
    catch (_) { continue; }
    if (!calendarGateway || typeof calendarGateway.isSlotAvailable !== 'function') fail_('CALENDAR_UNAVAILABLE');
    if (!calendarGateway.isSlotAvailable(slot.start, slot.end, null)) continue;
    const taken = records.some(function(record) {
      return ACTIVE_SLOT_STATES.indexOf(record.booking_status) !== -1
        && record.current_start_at && record.current_end_at
        && intervalOverlap_(slot.start, slot.end, record.current_start_at, record.current_end_at);
    });
    if (taken) continue;
    return slot;
  }
  fail_('SLOT_UNAVAILABLE');
}

function buildTargetedCalendarFixtureRecord_(config, slot, event) {
  const now = new Date().toISOString();
  const record = {
    idempotency_key: TARGETED_CALENDAR_FIXTURE_KEY,
    reservation_id: targetedCalendarFixtureReservationId_(),
    service_type: 'initial',
    modality: 'online',
    patient_email: assertTestRecipient_(config.internalNotificationEmail, config.patientAllowlist),
    original_start_at: slot.start,
    current_start_at: slot.start,
    current_end_at: slot.end,
    slot_hold_expires_at: '',
    booking_status: LIFECYCLE.BOOKING_STATUS.CONFIRMED,
    payment_status: LIFECYCLE.PAYMENT_STATUS.PAID,
    refund_status: LIFECYCLE.REFUND_STATUS.NOT_REQUIRED,
    schedule_status: LIFECYCLE.SCHEDULE_STATUS.SCHEDULED,
    calendar_link_key: targetedCalendarFixtureLinkKey_(),
    calendar_change_source: '',
    patient_reschedule_count: '0',
    notification_version: '1',
    created_at: now,
    updated_at: now,
    reconciliation_state: '',
  };
  Object.assign(record, calendarEventFields_(event));
  return record;
}

function persistTargetedCalendarFixtureRecord_(sheet, schema, record, existing) {
  if (existing && existing.rowNumber) {
    const updates = {};
    RESERVATION_HEADERS.forEach(function(header) {
      if (header === 'created_at' && existing.created_at) return;
      updates[header] = record[header] || '';
    });
    updateRecord_(sheet, schema, existing.rowNumber, updates);
    return findTargetedCalendarFixtureRecord_(sheet, schema);
  }
  sheet.appendRow(RESERVATION_HEADERS.map(function(header) { return record[header] || ''; }));
  record.rowNumber = sheet.getLastRow();
  return record;
}

function terminalizeTargetedFixtureOutbox_(resources, reservationId) {
  const spreadsheet = resources && resources.spreadsheet;
  if (!spreadsheet || typeof spreadsheet.getSheetByName !== 'function') return 0;
  const sheet = spreadsheet.getSheetByName(NONPROD.notificationOutboxSheetName);
  if (!sheet || sheet.getLastRow() === 0) return 0;
  const store = sheetNotificationOutboxStore_(sheet);
  let count = 0;
  store.records().forEach(function(entry) {
    if (String(entry.reservation_id || '') !== String(reservationId || '')) return;
    if (NOTIFICATION_OUTBOX_RETRYABLE_STATES.indexOf(String(entry.state || '')) === -1) return;
    store.update(entry, {
      state: 'superseded',
      last_result: 'superseded',
      disposition_reason: TARGETED_CALENDAR_FIXTURE_OUTBOX_DISPOSITION,
    });
    count += 1;
  });
  return count;
}

function createTargetedCalendarFixture_() {
  const config = assertTargetedFixtureEnvironment_(readConfig_());
  const resources = assertResources_(config);
  const schema = assertSchema_(resources.sheet);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) fail_('LOCK_UNAVAILABLE');
  try {
    const existing = findTargetedCalendarFixtureRecord_(resources.sheet, schema);
    if (existing && ACTIVE_SLOT_STATES.indexOf(existing.booking_status) !== -1) {
      return sanitizeTargetedCalendarFixtureEvidence_(existing, {
        ok: false, code: 'FIXTURE_ALREADY_EXISTS', replay: true,
      });
    }
    const slot = deriveTargetedCalendarFixtureSlot_(resources.calendarGateway, reservationRecords_(resources.sheet, schema));
    const orphan = resources.calendarGateway.findLinkedEvent(targetedCalendarFixtureLinkKey_());
    if (orphan) resources.calendarGateway.cancelLinkedEvent({ calendar_event_id: orphan.id });
    const event = resources.calendarGateway.createLinkedBookingEvent({
      calendar_link_key: targetedCalendarFixtureLinkKey_(),
      current_start_at: slot.start,
      current_end_at: slot.end,
    });
    const record = persistTargetedCalendarFixtureRecord_(
      resources.sheet, schema, buildTargetedCalendarFixtureRecord_(config, slot, event), existing);
    return sanitizeTargetedCalendarFixtureEvidence_(record, { ok: true });
  } finally { lock.releaseLock(); }
}

function readTargetedCalendarFixture_() {
  const config = assertTargetedFixtureEnvironment_(readConfig_());
  const resources = assertResources_(config);
  const schema = assertSchema_(resources.sheet);
  const record = findTargetedCalendarFixtureRecord_(resources.sheet, schema);
  if (!record) {
    return { ok: false, code: 'FIXTURE_NOT_FOUND', fixtureKey: TARGETED_CALENDAR_FIXTURE_KEY };
  }
  return sanitizeTargetedCalendarFixtureEvidence_(record, { ok: true });
}

function cleanupTargetedCalendarFixture_() {
  const config = assertTargetedFixtureEnvironment_(readConfig_());
  const resources = assertResources_(config);
  const schema = assertSchema_(resources.sheet);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) fail_('LOCK_UNAVAILABLE');
  try {
    const record = findTargetedCalendarFixtureRecord_(resources.sheet, schema);
    if (!record) {
      return {
        ok: true, cleaned: true, alreadyClean: true,
        fixtureKey: TARGETED_CALENDAR_FIXTURE_KEY, reason: 'fixture_absent',
      };
    }
    const alreadyTerminal = record.booking_status === LIFECYCLE.BOOKING_STATUS.CANCELLED
      && record.schedule_status === LIFECYCLE.SCHEDULE_STATUS.CANCELLED
      && String(record.reconciliation_state || '') === TARGETED_CALENDAR_FIXTURE_CLEANUP_STATE
      && !String(record.slot_hold_expires_at || '');
    if (alreadyTerminal) {
      terminalizeTargetedFixtureOutbox_(resources, record.reservation_id);
      return sanitizeTargetedCalendarFixtureEvidence_(record, {
        ok: true, cleaned: true, alreadyClean: true,
      });
    }
    const now = new Date().toISOString();
    const revokedAt = function(hash, current) {
      return hash ? (current || now) : '';
    };
    updateRecord_(resources.sheet, schema, record.rowNumber, {
      booking_status: LIFECYCLE.BOOKING_STATUS.CANCELLED,
      schedule_status: LIFECYCLE.SCHEDULE_STATUS.CANCELLED,
      slot_hold_expires_at: '',
      cancellation_source: 'operator_nonprod',
      cancelled_at: record.cancelled_at || now,
      reconciliation_state: TARGETED_CALENDAR_FIXTURE_CLEANUP_STATE,
      reschedule_capability_revoked_at: revokedAt(record.reschedule_capability_hash, record.reschedule_capability_revoked_at),
      cancel_capability_revoked_at: revokedAt(record.cancel_capability_hash, record.cancel_capability_revoked_at),
    });
    resources.calendarGateway.cancelLinkedEvent(record);
    terminalizeTargetedFixtureOutbox_(resources, record.reservation_id);
    const refreshed = findTargetedCalendarFixtureRecord_(resources.sheet, schema);
    return sanitizeTargetedCalendarFixtureEvidence_(refreshed, {
      ok: true, cleaned: true, alreadyClean: false,
    });
  } finally { lock.releaseLock(); }
}

function nonprodCreateTargetedCalendarFixture() {
  return createTargetedCalendarFixture_();
}

function nonprodReadTargetedCalendarFixture() {
  return readTargetedCalendarFixture_();
}

function nonprodCleanupTargetedCalendarFixture() {
  return cleanupTargetedCalendarFixture_();
}

var __TARGETED_FIXTURE_TEST_EXPORTS__ = Object.freeze({
  TARGETED_CALENDAR_FIXTURE_KEY: TARGETED_CALENDAR_FIXTURE_KEY,
  TARGETED_CALENDAR_FIXTURE_KIND: TARGETED_CALENDAR_FIXTURE_KIND,
  TARGETED_CALENDAR_FIXTURE_CLEANUP_STATE: TARGETED_CALENDAR_FIXTURE_CLEANUP_STATE,
  TARGETED_CALENDAR_FIXTURE_OUTBOX_DISPOSITION: TARGETED_CALENDAR_FIXTURE_OUTBOX_DISPOSITION,
  targetedCalendarFixtureReservationId_: targetedCalendarFixtureReservationId_,
  targetedCalendarFixtureLinkKey_: targetedCalendarFixtureLinkKey_,
  isTargetedCalendarFixtureRecord_: isTargetedCalendarFixtureRecord_,
  assertTargetedFixtureEnvironment_: assertTargetedFixtureEnvironment_,
  sanitizeTargetedCalendarFixtureEvidence_: sanitizeTargetedCalendarFixtureEvidence_,
  createTargetedCalendarFixture_: createTargetedCalendarFixture_,
  readTargetedCalendarFixture_: readTargetedCalendarFixture_,
  cleanupTargetedCalendarFixture_: cleanupTargetedCalendarFixture_,
  nonprodCreateTargetedCalendarFixture: nonprodCreateTargetedCalendarFixture,
  nonprodReadTargetedCalendarFixture: nonprodReadTargetedCalendarFixture,
  nonprodCleanupTargetedCalendarFixture: nonprodCleanupTargetedCalendarFixture,
});

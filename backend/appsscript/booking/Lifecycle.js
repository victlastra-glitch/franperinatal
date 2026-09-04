/**
 * Phase A lifecycle primitives.
 *
 * This file is deliberately side-effect free. Calendar, Flow, mail and
 * datastore adapters are consumers of these contracts in later phases.
 */

var SLOT_HOLD_MS = 15 * 60 * 1000;
var SESSION_DURATION_MINUTES = 50;
var SLOT_INTERVAL_MINUTES = 60;
var SESSION_DURATION_MS = SESSION_DURATION_MINUTES * 60 * 1000;
var SLOT_INTERVAL_MS = SLOT_INTERVAL_MINUTES * 60 * 1000;
var FLOW_PAYMENT_TIMEOUT_SECONDS = 900;
var FLOW_CHECKOUT_TIMEOUT_SECONDS = 900;
var CANONICAL_CONSULTATION_PRICE_CLP = 50000;
var INITIAL_PRICE_CLP = 50000;
var FOLLOWUP_PRICE_CLP = 50000;

// Product aliases (stored values stay snake_case; no schema migration):
// HOLD_PENDING_PAYMENT = payment_pending
// CANCELLATION_PENDING_REFUND = cancellation_requested
// refund NOT_REQUESTED = not_required
// refund CONFIRMED = refunded
// Flow payment status 4 is provider "anulada" → stored payment_status=annulled
// (not "expired"). Booking unpaid holds still expire/release independently.
var LIFECYCLE_TRANSITIONS = Object.freeze({
  booking_status: Object.freeze({
    initiated: Object.freeze(['payment_pending', 'expired', 'cancellation_requested', 'manual_review']),
    payment_pending: Object.freeze(['confirmed', 'expired', 'cancellation_requested', 'reconciliation_required', 'manual_review']),
    confirmed: Object.freeze(['cancellation_requested', 'reconciliation_required', 'manual_review']),
    cancellation_requested: Object.freeze(['cancelled', 'reconciliation_required', 'manual_review']),
    cancelled: Object.freeze([]), expired: Object.freeze([]),
    reconciliation_required: Object.freeze(['manual_review']),
    manual_review: Object.freeze([]),
  }),
  payment_status: Object.freeze({
    not_started: Object.freeze(['pending', 'failed', 'unknown', 'expired', 'annulled']),
    pending: Object.freeze(['paid', 'rejected', 'failed', 'unknown', 'expired', 'annulled']),
    unknown: Object.freeze(['pending', 'paid', 'rejected', 'failed', 'expired', 'annulled']),
    rejected: Object.freeze(['pending']),
    failed: Object.freeze(['pending']),
    paid: Object.freeze([]), expired: Object.freeze([]),
    annulled: Object.freeze(['pending']),
  }),
  refund_status: Object.freeze({
    not_required: Object.freeze(['refund_requested', 'manual_review']),
    refund_requested: Object.freeze(['refund_pending', 'refund_failed', 'manual_review']),
    refund_pending: Object.freeze(['refunded', 'refund_failed', 'manual_review']),
    refund_failed: Object.freeze(['refund_requested', 'refund_pending', 'manual_review']),
    refunded: Object.freeze([]), manual_review: Object.freeze(['refund_pending', 'refunded', 'refund_failed']),
  }),
  schedule_status: Object.freeze({
    hold: Object.freeze(['sync_pending', 'cancelled', 'reconciliation_required', 'manual_review']),
    sync_pending: Object.freeze(['scheduled', 'cancelled', 'reconciliation_required', 'manual_review']),
    scheduled: Object.freeze(['sync_pending', 'cancelled', 'reconciliation_required', 'manual_review']),
    cancelled: Object.freeze([]), reconciliation_required: Object.freeze(['sync_pending', 'manual_review']),
    manual_review: Object.freeze([]),
  }),
});

var CAPABILITY_TTL_MS = 1000 * 60 * 60 * 24;
var CAPABILITY_RANDOM_UUID_COUNT = 3;
var CAPABILITY_SECRET_MIN_LENGTH = 32;
var CAPABILITY_DOMAIN_VERSION = 'booking-capability:v1';

var LIFECYCLE_NOTIFICATION_TYPE = Object.freeze({
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED', PATIENT_RESCHEDULED: 'PATIENT_RESCHEDULED',
  CLINICIAN_RESCHEDULED: 'CLINICIAN_RESCHEDULED', PATIENT_CANCELLED: 'PATIENT_CANCELLED',
  CLINICIAN_CANCELLED: 'CLINICIAN_CANCELLED', SESSION_CANCELLED: 'SESSION_CANCELLED',
  REFUND_REQUESTED: 'REFUND_REQUESTED',
  REFUND_COMPLETED: 'REFUND_COMPLETED', REFUND_FAILED_MANUAL_REVIEW: 'REFUND_FAILED_MANUAL_REVIEW',
});

var LIFECYCLE_NOTIFICATION_CTA = Object.freeze({
  BOOKING_CONFIRMED: Object.freeze(['RESCHEDULE', 'CANCEL']),
  PATIENT_RESCHEDULED: Object.freeze(['CANCEL']),
  CLINICIAN_RESCHEDULED: Object.freeze(['CANCEL']),
  PATIENT_CANCELLED: Object.freeze([]), CLINICIAN_CANCELLED: Object.freeze([]),
  SESSION_CANCELLED: Object.freeze([]),
  REFUND_REQUESTED: Object.freeze([]), REFUND_COMPLETED: Object.freeze([]),
  REFUND_FAILED_MANUAL_REVIEW: Object.freeze([]),
});

var MAX_NOTIFICATION_ATTEMPTS = 5;
var MAX_NOTIFICATION_OUTBOX_BATCH = 10;

function capabilityTypeAllowed_(type) {
  return [LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE, LIFECYCLE.CAPABILITY_TYPE.CANCEL].indexOf(type) !== -1;
}

function capabilitySecretIsStrong_(secret) {
  return typeof secret === 'string' && secret.length >= CAPABILITY_SECRET_MIN_LENGTH && secret.trim() === secret;
}

function assertCapabilitySecret_(secret) {
  if (!capabilitySecretIsStrong_(secret)) fail_('CAPABILITY_SECRET_INVALID');
  return secret;
}

function transitionAllowed_(domain, current, next) {
  if (current === next) return true;
  const states = LIFECYCLE_TRANSITIONS[domain];
  return Boolean(states && states[current] && states[current].indexOf(next) !== -1);
}

function slotHoldExpiryIso_(nowMs) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  return new Date(now + SLOT_HOLD_MS).toISOString();
}

function remainingHoldSeconds_(record, nowMs) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const expires = Date.parse(String(record && record.slot_hold_expires_at || ''));
  if (!Number.isFinite(expires)) return FLOW_PAYMENT_TIMEOUT_SECONDS;
  return Math.max(1, Math.min(FLOW_PAYMENT_TIMEOUT_SECONDS, Math.floor((expires - now) / 1000)));
}

function slotHoldIsExpired_(record, nowMs) {
  if (!record) return false;
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.CONFIRMED) return false;
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.PAID) return false;
  const expires = Date.parse(String(record.slot_hold_expires_at || ''));
  if (!Number.isFinite(expires)) return false;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  return expires <= now;
}

function unpaidHoldBooking_(record) {
  return record && (record.booking_status === LIFECYCLE.BOOKING_STATUS.INITIATED
    || record.booking_status === LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING);
}

function reservationOccupiesSlot_(record, nowMs) {
  if (!record || ACTIVE_SLOT_STATES.indexOf(record.booking_status) === -1) return false;
  if (unpaidHoldBooking_(record) && slotHoldIsExpired_(record, nowMs)) return false;
  return true;
}

function assertTransition_(domain, current, next) {
  if (!transitionAllowed_(domain, current, next)) fail_('INVALID_' + String(domain).toUpperCase() + '_TRANSITION');
  return next;
}

function transitionBooking_(sheet, schema, record, next) {
  assertTransition_('booking_status', String(record.booking_status || ''), next);
  if (record.booking_status !== next) {
    updateRecord_(sheet, schema, record.rowNumber, { booking_status: next });
    record.booking_status = next;
  }
  return record;
}

function transitionPayment_(sheet, schema, record, next) {
  assertTransition_('payment_status', String(record.payment_status || ''), next);
  if (record.payment_status !== next) {
    updateRecord_(sheet, schema, record.rowNumber, { payment_status: next });
    record.payment_status = next;
  }
  return record;
}

function transitionRefund_(sheet, schema, record, next) {
  assertTransition_('refund_status', String(record.refund_status || ''), next);
  if (record.refund_status !== next) {
    updateRecord_(sheet, schema, record.rowNumber, { refund_status: next });
    record.refund_status = next;
  }
  return record;
}

function transitionSchedule_(sheet, schema, record, next) {
  assertTransition_('schedule_status', String(record.schedule_status || ''), next);
  if (record.schedule_status !== next) {
    updateRecord_(sheet, schema, record.rowNumber, { schedule_status: next });
    record.schedule_status = next;
  }
  return record;
}

function randomOpaqueCapabilityToken_() {
  if (!Utilities || typeof Utilities.getUuid !== 'function') fail_('CAPABILITY_UNAVAILABLE');
  const uuids = [];
  for (let index = 0; index < CAPABILITY_RANDOM_UUID_COUNT; index += 1) uuids.push(Utilities.getUuid());
  return uuids.join('').replace(/-/g, '');
}

function hashCapabilityToken_(token, secret, type) {
  if (!capabilityTypeAllowed_(type)) fail_('CAPABILITY_INVALID');
  assertCapabilitySecret_(secret);
  const input = CAPABILITY_DOMAIN_VERSION + ':' + type + ':' + String(token);
  return hexBytes_(Utilities.computeHmacSha256Signature(input, secret));
}

function hexBytes_(bytes) {
  return bytes.map(function(byte) { return ('0' + ((byte < 0 ? byte + 256 : byte).toString(16))).slice(-2); }).join('');
}

function constantTimeEqual_(left, right) {
  const a = String(left || ''); const b = String(right || '');
  let difference = a.length ^ b.length; const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
}

function createCapability_(type, options) {
  if (!capabilityTypeAllowed_(type)) fail_('CAPABILITY_INVALID');
  const secret = assertCapabilitySecret_(options && options.secret);
  const now = Number(options && options.now || Date.now());
  const expiresAt = String(options && options.expiresAt || new Date(now + CAPABILITY_TTL_MS).toISOString());
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now) fail_('CAPABILITY_INVALID');
  const version = String(options && options.version || '1');
  const token = randomOpaqueCapabilityToken_();
  return Object.freeze({
    type: type, token: token, hash: hashCapabilityToken_(token, secret, type),
    expiresAt: expiresAt, version: version, revokedAt: null,
  });
}

function capabilityForStorage_(capability) {
  return Object.freeze({ type: capability.type, hash: capability.hash, expiresAt: capability.expiresAt,
    version: capability.version, revokedAt: capability.revokedAt || null });
}

function verifyCapability_(token, expectedType, stored, options) {
  const now = Number(options && options.now || Date.now()); const version = String(options && options.version || '1');
  if (!capabilityTypeAllowed_(expectedType) || !capabilitySecretIsStrong_(options && options.secret)) return false;
  if (!/^[a-f0-9]{96}$/i.test(String(token || ''))) return false;
  if (!stored || stored.type !== expectedType || stored.version !== version || stored.revokedAt) return false;
  if (!stored.expiresAt || Date.parse(stored.expiresAt) <= now) return false;
  if (!/^[A-Fa-f0-9]{64}$/.test(String(stored.hash || ''))) return false;
  return constantTimeEqual_(hashCapabilityToken_(token, options.secret, expectedType), stored.hash);
}

function revokeCapability_(stored, now) {
  if (!stored || !stored.type || !stored.hash) return null;
  return Object.freeze({ type: stored.type, hash: stored.hash, expiresAt: stored.expiresAt,
    version: stored.version, revokedAt: String(now || new Date().toISOString()) });
}

function capabilityFields_(capability) {
  if (!capability || !capabilityTypeAllowed_(capability.type)) fail_('CAPABILITY_INVALID');
  const prefix = capability.type === LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE ? 'reschedule' : 'cancel';
  const result = {}; result[prefix + '_capability_hash'] = capability.hash;
  result[prefix + '_capability_expires_at'] = capability.expiresAt;
  result[prefix + '_capability_version'] = capability.version;
  result[prefix + '_capability_revoked_at'] = capability.revokedAt || '';
  return result;
}

function capabilityFromRecord_(record, type) {
  if (!record || !capabilityTypeAllowed_(type)) fail_('CAPABILITY_INVALID');
  const prefix = type === LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE ? 'reschedule' : 'cancel';
  return {
    type: type,
    hash: String(record[prefix + '_capability_hash'] || ''),
    expiresAt: String(record[prefix + '_capability_expires_at'] || ''),
    version: String(record[prefix + '_capability_version'] || ''),
    revokedAt: String(record[prefix + '_capability_revoked_at'] || '') || null,
  };
}

function isPatientRescheduleEligible_(input) {
  if (!input || input.bookingStatus !== LIFECYCLE.BOOKING_STATUS.CONFIRMED
    || input.paymentStatus !== LIFECYCLE.PAYMENT_STATUS.PAID
    || input.scheduleStatus !== LIFECYCLE.SCHEDULE_STATUS.SCHEDULED
    || !(input.patientRescheduleCount === 0 || input.patientRescheduleCount === '0')) return false;
  return verifyCapability_(input.token, LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE, input.storedCapability, input);
}

function canPatientReschedule_(input) { return isPatientRescheduleEligible_(input); }

function claimPatientReschedule_(input) {
  if (!canPatientReschedule_(input)) return { ok: false, code: 'CAPABILITY_INVALID' };
  return { ok: true, patient_reschedule_count: 1,
    revokedCapability: revokeCapability_(input.storedCapability, input.nowIso || new Date().toISOString()) };
}

function withLifecycleLock_(deps, operation) {
  if (deps && deps.lockAlreadyHeld) return operation();
  const lock = deps && deps.lock ? deps.lock : (typeof LockService !== 'undefined' && LockService.getScriptLock ? LockService.getScriptLock() : null);
  if (!lock || !lock.tryLock(10000)) fail_('LOCK_UNAVAILABLE');
  try { return operation(); } finally { lock.releaseLock(); }
}

function lifecycleNow_(value) { return Number(value || Date.now()); }

function sessionEndAt_(startAt) {
  const start = new Date(String(startAt));
  if (Number.isNaN(start.getTime())) fail_('REQUEST_REJECTED');
  return new Date(start.getTime() + SESSION_DURATION_MS).toISOString();
}

function slotIntervalEndAt_(startAt) {
  const start = new Date(String(startAt));
  if (Number.isNaN(start.getTime())) fail_('REQUEST_REJECTED');
  return new Date(start.getTime() + SLOT_INTERVAL_MS).toISOString();
}

function targetEndAt_(startAt, endAt) {
  if (endAt) return new Date(String(endAt)).toISOString();
  return sessionEndAt_(startAt);
}

function lifecycleCapabilitySecret_(deps) {
  if (deps && typeof deps.requireCapabilitySecret_ === 'function') return deps.requireCapabilitySecret_();
  if (typeof requireCapabilitySecret_ === 'function') return requireCapabilitySecret_();
  fail_('CAPABILITY_SECRET_INVALID');
}

function lifecycleRecordReadyForReschedule_(record) {
  return record && record.booking_status === LIFECYCLE.BOOKING_STATUS.CONFIRMED
    && record.payment_status === LIFECYCLE.PAYMENT_STATUS.PAID
    && record.schedule_status === LIFECYCLE.SCHEDULE_STATUS.SCHEDULED
    && String(record.patient_reschedule_count) === '0';
}

function assertCancellationTransition_(record) {
  if (!record) fail_('INVALID_BOOKING_STATUS_TRANSITION');
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.CANCELLATION_REQUESTED) {
    assertTransition_('booking_status', record.booking_status, LIFECYCLE.BOOKING_STATUS.CANCELLED);
    return true;
  }
  assertTransition_('booking_status', record.booking_status, LIFECYCLE.BOOKING_STATUS.CANCELLATION_REQUESTED);
  assertTransition_('booking_status', LIFECYCLE.BOOKING_STATUS.CANCELLATION_REQUESTED, LIFECYCLE.BOOKING_STATUS.CANCELLED);
  return true;
}

// Paid cancellations persist CANCELLATION_PENDING_REFUND (cancellation_requested)
// until the refund is provider-confirmed. Unpaid/ineligible cancellations are
// terminal immediately. Schedule is always released in the same write.
function atomicCancellationTransitionFields_(record, updates, options) {
  const terminal = !(options && options.terminal === false);
  if (terminal) {
    assertCancellationTransition_(record);
    return Object.assign({}, updates, { booking_status: LIFECYCLE.BOOKING_STATUS.CANCELLED });
  }
  assertTransition_('booking_status', String(record.booking_status || ''), LIFECYCLE.BOOKING_STATUS.CANCELLATION_REQUESTED);
  return Object.assign({}, updates, { booking_status: LIFECYCLE.BOOKING_STATUS.CANCELLATION_REQUESTED });
}

function storeUpdateWithRetry_(store, record, updates) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = store.update(record, updates);
      return result || Object.assign({}, record, updates);
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('STORE_UPDATE_FAILED');
}

function bestEffortReconciliationUpdate_(deps, record, updates) {
  try { return storeUpdateWithRetry_(deps.store, record, updates); } catch (_) { return null; }
}

function reconciliationFailureSnapshot_(record, updates) {
  return { reservationId: String(record && record.reservation_id || ''), operationId: String(updates && updates.last_operation_id || ''),
    state: String(updates && updates.reconciliation_state || 'reconciliation_required'), calendarEventId: String(updates && updates.calendar_event_id || record && record.calendar_event_id || ''),
    calendarEventEtag: String(updates && updates.calendar_event_etag || record && record.calendar_event_etag || ''),
    targetStartAt: String(updates && updates.current_start_at || ''), targetEndAt: String(updates && updates.current_end_at || '') };
}

function persistReconciliationFailure_(deps, record, updates) {
  const target = deps && deps.reconciliationStore && typeof deps.reconciliationStore.update === 'function'
    ? deps.reconciliationStore : deps && deps.store;
  if (!target) return null;
  try { return storeUpdateWithRetry_(target, record, updates); } catch (_) { return null; }
}

function isCalendarConcurrencyFailure_(error) {
  const code = String(error && error.code || ''); const status = Number(error && error.status || 0);
  return code === 'CALENDAR_ETAG_CONFLICT' || status === 412 || /\b412\b/.test(String(error && error.message || error || ''));
}

function activeReservationOverlaps_(record, targetStartAt, targetEndAt, store) {
  if (!store || typeof store.records !== 'function') return false;
  return store.records().some(function(candidate) {
    if (!candidate || candidate.reservation_id === record.reservation_id || !reservationOccupiesSlot_(candidate)) return false;
    return intervalOverlap_(targetStartAt, targetEndAt, candidate.current_start_at, candidate.current_end_at);
  });
}

function targetSlotAvailable_(record, targetStartAt, targetEndAt, deps) {
  if (deps && typeof deps.isTargetAvailable === 'function') return deps.isTargetAvailable(record, targetStartAt, targetEndAt);
  if (!deps || !deps.calendar || typeof deps.calendar.isSlotAvailable !== 'function') fail_('CALENDAR_UNAVAILABLE');
  if (!deps.calendar.isSlotAvailable(targetStartAt, targetEndAt, record.calendar_event_id)) return false;
  return !activeReservationOverlaps_(record, targetStartAt, targetEndAt, deps.store);
}

function persistedRevocationFields_(capability) {
  return capabilityFields_(capability);
}

function lifecycleTokenAuthorized_(token, type, stored, secret, now, record) {
  if (typeof isLegacyV7ManageToken_ === 'function' && isLegacyV7ManageToken_(token)
    && record && constantTimeEqual_(String(record.manage_token || ''), String(token))) {
    return true;
  }
  return verifyCapability_(token, type, stored, { secret: secret, now: now });
}

function patientRescheduleTransaction_(input) {
  const deps = input && input.deps;
  if (!deps || !deps.store || !input.reservationId || !input.token || !input.targetStartAt) fail_('REQUEST_REJECTED');
  return withLifecycleLock_(deps, function() {
    // This is the authoritative read. Never authorize from input.record or a
    // pre-lock snapshot supplied by a browser or caller.
    const record = deps.store.loadByReservationId(String(input.reservationId));
    if (!record || !lifecycleRecordReadyForReschedule_(record)) return { ok: false, code: 'CAPABILITY_INVALID' };
    const secret = lifecycleCapabilitySecret_(deps);
    const stored = capabilityFromRecord_(record, LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE);
    const now = lifecycleNow_(input.now);
    if (!lifecycleTokenAuthorized_(input.token, LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE, stored, secret, now, record)) {
      return { ok: false, code: 'CAPABILITY_INVALID' };
    }
    const targetEnd = targetEndAt_(input.targetStartAt, input.targetEndAt);
    if (!targetSlotAvailable_(record, input.targetStartAt, targetEnd, deps)) return { ok: false, code: 'SLOT_TAKEN' };
    const operationId = input.operationId || makeOperationId_(LIFECYCLE.OPERATION_TYPE.PATIENT_RESCHEDULE, record.reservation_id + ':' + input.targetStartAt);
    let event;
    try {
      event = deps.calendar.updateSameEvent(record, input.targetStartAt, targetEnd);
    } catch (error) {
      const reconciliationState = isCalendarConcurrencyFailure_(error) ? 'calendar_reschedule_conflict' : 'calendar_reschedule_retry';
      persistReconciliationFailure_(deps, record, { schedule_status: LIFECYCLE.SCHEDULE_STATUS.RECONCILIATION_REQUIRED,
        reconciliation_state: reconciliationState, last_operation_id: operationId });
      return { ok: false, code: 'RECONCILIATION_REQUIRED', reconciliation: reconciliationFailureSnapshot_(record, {
        reconciliation_state: reconciliationState, last_operation_id: operationId }) };
    }
    const revoked = revokeCapability_(stored, new Date(now).toISOString());
    const updates = { current_start_at: new Date(input.targetStartAt).toISOString(), current_end_at: targetEnd,
      patient_reschedule_count: '1', calendar_change_source: 'patient', schedule_changed_at: new Date(now).toISOString(),
      last_operation_id: operationId, reconciliation_state: '', calendar_event_id: event.id, calendar_event_etag: event.etag,
      calendar_event_updated_at: event.updated, calendar_sync_hash: event.syncHash, meet_url: event.meetUrl,
      meet_conference_id: event.meetConferenceId, meet_status: event.meetStatus };
    Object.assign(updates, persistedRevocationFields_(revoked));
    let updated;
    try { updated = storeUpdateWithRetry_(deps.store, record, updates); }
    catch (_) {
      persistReconciliationFailure_(deps, record, Object.assign({}, updates, {
        schedule_status: LIFECYCLE.SCHEDULE_STATUS.RECONCILIATION_REQUIRED,
        reconciliation_state: 'calendar_reschedule_store_retry', last_operation_id: operationId,
      }));
      return { ok: false, code: 'RECONCILIATION_REQUIRED', reconciliation: reconciliationFailureSnapshot_(record, Object.assign({}, updates, {
        reconciliation_state: 'calendar_reschedule_store_retry', last_operation_id: operationId })) };
    }
    if (deps.enqueueNotification) {
      try { deps.enqueueNotification(updated); }
      catch (_) {
        bestEffortReconciliationUpdate_(deps, updated, { reconciliation_state: 'notification_reschedule_retry', last_operation_id: operationId });
        return { ok: false, code: 'NOTIFICATION_RETRY_REQUIRED' };
      }
    }
    return { ok: true, replay: false, status: 'rescheduled', currentStart: updated.current_start_at, currentEnd: updated.current_end_at };
  });
}

function patientCancelTransaction_(input) {
  const deps = input && input.deps;
  if (!deps || !deps.store || !input.reservationId || !input.token) fail_('REQUEST_REJECTED');
  return withLifecycleLock_(deps, function() {
    const record = deps.store.loadByReservationId(String(input.reservationId));
    if (!record) return { ok: false, code: 'CAPABILITY_INVALID' };
    if (record.booking_status === LIFECYCLE.BOOKING_STATUS.CANCELLED) {
      enqueueManualPolicyRefundNotificationBestEffort_(deps, record);
      return { ok: true, replay: true, status: 'cancelled' };
    }
    if (record.booking_status === LIFECYCLE.BOOKING_STATUS.CANCELLATION_REQUESTED) {
      return { ok: true, replay: true, status: 'cancellation_pending', refund: 'pending' };
    }
    if (![LIFECYCLE.BOOKING_STATUS.CONFIRMED, LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING].includes(record.booking_status)) {
      return { ok: false, code: 'CAPABILITY_INVALID' };
    }
    const secret = lifecycleCapabilitySecret_(deps);
    const stored = capabilityFromRecord_(record, LIFECYCLE.CAPABILITY_TYPE.CANCEL);
    const now = lifecycleNow_(input.now);
    if (!lifecycleTokenAuthorized_(input.token, LIFECYCLE.CAPABILITY_TYPE.CANCEL, stored, secret, now, record)) {
      return { ok: false, code: 'CAPABILITY_INVALID' };
    }
    const operationId = input.operationId || makeOperationId_(LIFECYCLE.OPERATION_TYPE.PATIENT_CANCEL, record.reservation_id);
    if (deps.calendar && typeof deps.calendar.cancelLinkedEvent === 'function') {
      try { deps.calendar.cancelLinkedEvent(record); }
      catch (_) {
        persistReconciliationFailure_(deps, record, { booking_status: LIFECYCLE.BOOKING_STATUS.RECONCILIATION_REQUIRED,
          schedule_status: LIFECYCLE.SCHEDULE_STATUS.RECONCILIATION_REQUIRED, reconciliation_state: 'calendar_cancel_retry', last_operation_id: operationId });
        return { ok: false, code: 'RECONCILIATION_REQUIRED', reconciliation: reconciliationFailureSnapshot_(record, {
          reconciliation_state: 'calendar_cancel_retry', last_operation_id: operationId }) };
      }
    }
    assertCancellationTransition_(record);
    assertTransition_('schedule_status', record.schedule_status, LIFECYCLE.SCHEDULE_STATUS.CANCELLED);
    const revoked = revokeCapability_(stored, new Date(now).toISOString());
    const policy = deps.policyEvaluator ? deps.policyEvaluator(record, now) : { decision: 'BUSINESS_POLICY_TBD', eligible: false };
    const refundEligible = Boolean(policy.eligible && record.payment_status === LIFECYCLE.PAYMENT_STATUS.PAID);
    const updates = atomicCancellationTransitionFields_(record, { schedule_status: LIFECYCLE.SCHEDULE_STATUS.CANCELLED,
      cancellation_source: 'patient', cancelled_at: new Date(now).toISOString(), last_operation_id: operationId,
      reconciliation_state: '', cancel_capability_revoked_at: revoked.revokedAt, refund_last_error_code: refundEligible ? '' : (policy.eligible ? '' : 'BUSINESS_POLICY_TBD') },
      { terminal: !refundEligible });
    if (refundEligible) updates.refund_status = LIFECYCLE.REFUND_STATUS.REQUESTED;
    else updates.refund_status = LIFECYCLE.REFUND_STATUS.MANUAL_REVIEW;
    let updated;
    try { updated = storeUpdateWithRetry_(deps.store, record, updates); }
    catch (_) {
      persistReconciliationFailure_(deps, record, Object.assign({}, updates, {
        booking_status: LIFECYCLE.BOOKING_STATUS.RECONCILIATION_REQUIRED,
        schedule_status: LIFECYCLE.SCHEDULE_STATUS.RECONCILIATION_REQUIRED,
        reconciliation_state: 'calendar_cancel_store_retry',
      }));
      return { ok: false, code: 'RECONCILIATION_REQUIRED', reconciliation: reconciliationFailureSnapshot_(record, Object.assign({}, updates, {
        reconciliation_state: 'calendar_cancel_store_retry' })) };
    }
    try {
      if (refundEligible && deps.enqueueRefund) deps.enqueueRefund(updated);
    } catch (_) {
      bestEffortReconciliationUpdate_(deps, updated, { reconciliation_state: 'notification_cancel_retry', last_operation_id: operationId });
      return { ok: false, code: 'NOTIFICATION_RETRY_REQUIRED' };
    }
    enqueueManualPolicyRefundNotificationBestEffort_(deps, updated);
    return { ok: true, replay: false, status: refundEligible ? 'cancellation_pending' : 'cancelled',
      refund: refundEligible ? 'requested' : 'BUSINESS_POLICY_TBD' };
  });
}

function providerRefundAttempted_(record) {
  return Boolean(String(record && record.refund_commerce_order || '')
    || String(record && record.refund_provider_reference || ''));
}

function manualPolicyRefundNotificationNeeded_(record) {
  return Boolean(record)
    && record.booking_status === LIFECYCLE.BOOKING_STATUS.CANCELLED
    && record.payment_status === LIFECYCLE.PAYMENT_STATUS.PAID
    && record.refund_status === LIFECYCLE.REFUND_STATUS.MANUAL_REVIEW;
}

function enqueueManualPolicyRefundNotificationBestEffort_(deps, record) {
  if (!deps || typeof deps.enqueueNotification !== 'function') return;
  if (!manualPolicyRefundNotificationNeeded_(record)) return;
  try { deps.enqueueNotification(record); } catch (_) {}
}

function makeOperationId_(type, entropy) {
  const allowed = Object.keys(LIFECYCLE.OPERATION_TYPE).map(function(key) { return LIFECYCLE.OPERATION_TYPE[key]; });
  if (allowed.indexOf(type) === -1) fail_('OPERATION_TYPE_INVALID');
  const source = String(entropy || (Utilities.getUuid ? Utilities.getUuid() : 'phase-a'));
  return 'op_' + type + '_' + hexBytes_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, source, Utilities.Charset.UTF_8)).slice(0, 32);
}

function makeCalendarLinkKey_(idempotencyKey) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(idempotencyKey || ''))) fail_('CALENDAR_LINK_KEY_INVALID');
  return makeOpaqueId_('calendar-link', String(idempotencyKey));
}

function applyOperationOnce_(operationStore, operationId, operation) {
  if (!operationStore || typeof operationStore !== 'object' || !/^op_[a-z_]+_[a-f0-9]{32}$/.test(String(operationId))) {
    fail_('OPERATION_ID_INVALID');
  }
  if (Object.prototype.hasOwnProperty.call(operationStore, operationId)) {
    return { ok: true, replay: true, result: operationStore[operationId] };
  }
  const result = operation(); operationStore[operationId] = result;
  return { ok: true, replay: false, result: result };
}

function makeNotificationLogicalKey_(record, channel) {
  if (!record || !record.idempotency_key || !/^[A-Za-z0-9_-]{16,128}$/.test(String(record.idempotency_key))) fail_('NOTIFICATION_KEY_INVALID');
  if (!/^(notification_patient_state|notification_internal_state)$/.test(channel)) fail_('NOTIFICATION_KEY_INVALID');
  return 'notification_' + String(record.idempotency_key) + '_' + channel;
}

function createNotificationOutbox_(logicalKey, version, now) {
  if (!/^notification_[A-Za-z0-9_-]{16,128}_(notification_patient_state|notification_internal_state)$/.test(String(logicalKey))) fail_('NOTIFICATION_KEY_INVALID');
  return { key: logicalKey, version: String(version || '1'), state: 'pending', attemptCount: 0,
    lastAttemptAt: null, lastResult: null, claimedAt: null };
}

function lifecycleCtas_(eventType, record) {
  const allowed = LIFECYCLE_NOTIFICATION_CTA[eventType] || [];
  if (!record || record.booking_status !== LIFECYCLE.BOOKING_STATUS.CONFIRMED) return allowed.filter(function(cta) { return cta !== 'RESCHEDULE' && cta !== 'CANCEL'; });
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.PATIENT_RESCHEDULED || eventType === LIFECYCLE_NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED) return ['CANCEL'];
  if (eventType !== LIFECYCLE_NOTIFICATION_TYPE.BOOKING_CONFIRMED) return [];
  return allowed.filter(function(cta) {
    if (cta === 'RESCHEDULE') return String(record.patient_reschedule_count) === '0' && Boolean(record.reschedule_capability_hash && !record.reschedule_capability_revoked_at);
    if (cta === 'CANCEL') return Boolean(record.cancel_capability_hash && !record.cancel_capability_revoked_at);
    return false;
  });
}

function lifecycleNotificationShowsMeet_(eventType) {
  return eventType === LIFECYCLE_NOTIFICATION_TYPE.BOOKING_CONFIRMED
    || eventType === LIFECYCLE_NOTIFICATION_TYPE.PATIENT_RESCHEDULED
    || eventType === LIFECYCLE_NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED;
}

function lifecycleNotificationStateField_(notification) {
  if (notification && notification.eventType === LIFECYCLE_NOTIFICATION_TYPE.SESSION_CANCELLED) {
    return 'notification_patient_state';
  }
  return notification && notification.ctas && notification.ctas.length
    ? 'notification_patient_state'
    : 'notification_internal_state';
}

function nextLifecycleNotificationVersion_(record, eventType) {
  const currentVersion = String(record && record.notification_version || '1');
  const currentType = reconstructLifecycleEventType_(record);
  if (!currentType || currentType === eventType) return currentVersion;
  const parsed = Number(currentVersion);
  return String((Number.isFinite(parsed) ? parsed : 0) + 1);
}

function nextDurableNotificationVersion_(entries, reservationId) {
  let max = 0;
  const list = Array.isArray(entries) ? entries : [];
  for (let i = 0; i < list.length; i += 1) {
    if (String(list[i].reservation_id || '') !== String(reservationId || '')) continue;
    const parsed = Number(list[i].notification_version || 0);
    if (Number.isFinite(parsed) && parsed > max) max = parsed;
  }
  return String(max + 1);
}

function notificationSnapshotFromRecord_(record) {
  return {
    snapshot_service_type: String(record && record.service_type || ''),
    snapshot_modality: String(record && record.modality || ''),
    snapshot_start_at: String(record && record.current_start_at || ''),
    snapshot_end_at: String(record && record.current_end_at || ''),
    snapshot_meet_url: String(record && record.meet_url || ''),
    snapshot_meet_status: String(record && record.meet_status || ''),
    snapshot_booking_status: String(record && record.booking_status || ''),
    snapshot_schedule_status: String(record && record.schedule_status || ''),
    snapshot_patient_reschedule_count: String(record && record.patient_reschedule_count || '0'),
  };
}

function isCancelOrRefundNotification_(eventType) {
  return eventType === LIFECYCLE_NOTIFICATION_TYPE.PATIENT_CANCELLED
    || eventType === LIFECYCLE_NOTIFICATION_TYPE.CLINICIAN_CANCELLED
    || eventType === LIFECYCLE_NOTIFICATION_TYPE.SESSION_CANCELLED
    || eventType === LIFECYCLE_NOTIFICATION_TYPE.REFUND_REQUESTED
    || eventType === LIFECYCLE_NOTIFICATION_TYPE.REFUND_COMPLETED
    || eventType === LIFECYCLE_NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW;
}

function notificationEventDisposition_(entry, record) {
  const eventType = String(entry && entry.event_type || '');
  if (!record) return { disposition: 'failed', reason: 'booking_missing' };
  const cancelled = record.booking_status === LIFECYCLE.BOOKING_STATUS.CANCELLED
    || record.schedule_status === LIFECYCLE.SCHEDULE_STATUS.CANCELLED;
  if (cancelled && !isCancelOrRefundNotification_(eventType)) {
    return { disposition: 'superseded', reason: 'booking_cancelled' };
  }
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.BOOKING_CONFIRMED) {
    if (String(record.patient_reschedule_count || '0') !== '0') {
      return { disposition: 'superseded', reason: 'schedule_changed' };
    }
    if (String(record.current_start_at || '') !== String(entry.snapshot_start_at || '')) {
      return { disposition: 'superseded', reason: 'schedule_changed' };
    }
  }
  return { disposition: 'deliver', reason: '' };
}

function validOperationId_(value) {
  return /^op_[a-z_]+_[a-f0-9]{32}$/.test(String(value || ''));
}

function notificationOccurrenceOperationType_(eventType) {
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.PATIENT_RESCHEDULED) return LIFECYCLE.OPERATION_TYPE.PATIENT_RESCHEDULE;
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.PATIENT_CANCELLED
    || eventType === LIFECYCLE_NOTIFICATION_TYPE.SESSION_CANCELLED) return LIFECYCLE.OPERATION_TYPE.PATIENT_CANCEL;
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED) return LIFECYCLE.OPERATION_TYPE.CLINICIAN_RECONCILE_MOVE;
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.CLINICIAN_CANCELLED) return LIFECYCLE.OPERATION_TYPE.CLINICIAN_RECONCILE_CANCEL;
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.REFUND_REQUESTED
    || eventType === LIFECYCLE_NOTIFICATION_TYPE.REFUND_COMPLETED
    || eventType === LIFECYCLE_NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW) {
    return LIFECYCLE.OPERATION_TYPE.REFUND_CREATE;
  }
  return LIFECYCLE.OPERATION_TYPE.NOTIFICATION;
}

function notificationOccurrenceEntropy_(record, eventType) {
  const reservationId = String(record && record.reservation_id || '');
  if (!reservationId) fail_('NOTIFICATION_OCCURRENCE_INVALID');
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.BOOKING_CONFIRMED) {
    const paymentId = String(record.commerce_order || record.flow_token || record.idempotency_key || '');
    if (!paymentId) fail_('NOTIFICATION_OCCURRENCE_INVALID');
    return reservationId + ':BOOKING_CONFIRMED:' + paymentId;
  }
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.PATIENT_RESCHEDULED) {
    return reservationId + ':' + String(record.current_start_at || '');
  }
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED
    || eventType === LIFECYCLE_NOTIFICATION_TYPE.CLINICIAN_CANCELLED) {
    return String(record.calendar_event_id || '') + ':'
      + String(record.calendar_event_etag || '') + ':'
      + String(record.calendar_event_updated_at || '');
  }
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.PATIENT_CANCELLED
    || eventType === LIFECYCLE_NOTIFICATION_TYPE.SESSION_CANCELLED) {
    return reservationId;
  }
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.REFUND_REQUESTED) {
    return reservationId + ':REFUND_REQUESTED:' + String(record.refund_commerce_order || record.last_operation_id || '');
  }
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.REFUND_COMPLETED) {
    return reservationId + ':REFUND_COMPLETED:'
      + String(record.refund_provider_reference || record.refund_commerce_order || '');
  }
  if (eventType === LIFECYCLE_NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW) {
    return reservationId + ':REFUND_FAILED_MANUAL_REVIEW:'
      + String(record.refund_last_error_code || record.refund_commerce_order || '');
  }
  fail_('NOTIFICATION_TYPE_INVALID');
}

function notificationOccurrenceKey_(record, eventType) {
  if (!LIFECYCLE_NOTIFICATION_TYPE[eventType]) fail_('NOTIFICATION_TYPE_INVALID');
  if (eventType !== LIFECYCLE_NOTIFICATION_TYPE.BOOKING_CONFIRMED) {
    const existing = String(record && record.last_operation_id || '');
    if (validOperationId_(existing)) return existing;
  }
  return makeOperationId_(notificationOccurrenceOperationType_(eventType), notificationOccurrenceEntropy_(record, eventType));
}

function findDurableNotificationReplay_(entries, reservationId, eventType, sourceOperationId) {
  const list = Array.isArray(entries) ? entries : [];
  const occurrence = String(sourceOperationId || '');
  if (!occurrence) return null;
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (String(entry.reservation_id || '') !== String(reservationId || '')) continue;
    if (String(entry.event_type || '') !== String(eventType || '')) continue;
    if (String(entry.source_operation_id || '') !== occurrence) continue;
    return entry;
  }
  return null;
}

function pendingSameTypeNotification_(entries, reservationId, eventType) {
  const list = Array.isArray(entries) ? entries : [];
  const found = [];
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (String(entry.reservation_id || '') !== String(reservationId || '')) continue;
    if (String(entry.event_type || '') !== String(eventType || '')) continue;
    if (NOTIFICATION_OUTBOX_RETRYABLE_STATES.indexOf(String(entry.state || '')) === -1) continue;
    found.push(entry);
  }
  return found;
}

function reconstructLifecycleEventTypeFromEntry_(entry) {
  const eventType = String(entry && entry.event_type || '');
  if (LIFECYCLE_NOTIFICATION_TYPE[eventType]) return eventType;
  return reconstructLifecycleEventType_({
    notification_outbox_key: entry && entry.logical_key,
    reservation_id: entry && entry.reservation_id,
    notification_version: entry && entry.notification_version,
  });
}

function isRetryableNotificationState_(state) {
  return NOTIFICATION_OUTBOX_RETRYABLE_STATES.indexOf(String(state || '')) !== -1;
}

function makeLifecycleNotification_(eventType, record, options) {
  if (!LIFECYCLE_NOTIFICATION_TYPE[eventType]) fail_('NOTIFICATION_TYPE_INVALID');
  if (!record || !record.reservation_id || !record.notification_version) fail_('NOTIFICATION_RECORD_INVALID');
  const key = 'lifecycle_' + String(record.reservation_id) + '_' + eventType + '_' + String(record.notification_version);
  const meet = lifecycleNotificationShowsMeet_(eventType) && record.meet_url
    ? { meetUrl: String(record.meet_url), meetStatus: String(record.meet_status || '') }
    : null;
  return { eventType: eventType, logicalKey: key, version: String(record.notification_version), ctas: lifecycleCtas_(eventType, record),
    meet: meet, createdAt: String(options && options.now || new Date().toISOString()),
    status: record.booking_status, scheduleStatus: record.schedule_status };
}

// Reconstruct only from the persisted lifecycle outbox key contract.
// Format: lifecycle_<reservation_id>_<KNOWN_EVENT_TYPE>_<notification_version>
// Unknown or mismatched keys never authorize a send.
function reconstructLifecycleEventType_(record) {
  const key = String(record && record.notification_outbox_key || '');
  const reservationId = String(record && record.reservation_id || '');
  const version = String(record && record.notification_version || '');
  if (!key || !reservationId || !version) return null;
  const prefix = 'lifecycle_' + reservationId + '_';
  const suffix = '_' + version;
  if (key.indexOf(prefix) !== 0 || key.length <= prefix.length + suffix.length) return null;
  if (key.slice(key.length - suffix.length) !== suffix) return null;
  const eventType = key.slice(prefix.length, key.length - suffix.length);
  if (!LIFECYCLE_NOTIFICATION_TYPE[eventType]) return null;
  return eventType;
}

function notificationRetryStateField_(record) {
  const patient = String(record && record.notification_patient_state || '');
  const internal = String(record && record.notification_internal_state || '');
  if (patient === 'pending' || patient === 'failed') return 'notification_patient_state';
  if (internal === 'pending' || internal === 'failed') return 'notification_internal_state';
  return null;
}

function selectRetryableNotificationWork_(entries, limit) {
  const max = Math.max(1, Number(limit) || MAX_NOTIFICATION_OUTBOX_BATCH);
  const list = Array.isArray(entries) ? entries.slice() : [];
  list.sort(function(a, b) {
    const created = String(a.created_at || a.createdAt || '').localeCompare(String(b.created_at || b.createdAt || ''));
    if (created) return created;
    const versionA = Number(a.notification_version || a.version || 0);
    const versionB = Number(b.notification_version || b.version || 0);
    if (versionA !== versionB) return versionA - versionB;
    return Number(a.rowNumber || 0) - Number(b.rowNumber || 0);
  });
  const selected = [];
  for (let i = 0; i < list.length && selected.length < max; i += 1) {
    const entry = list[i];
    if (!isRetryableNotificationState_(entry.state)) continue;
    if (entry.last_result === 'max_attempts' || entry.last_result === 'event_type_invalid') continue;
    selected.push({ entry: entry, record: entry });
  }
  return selected;
}

// A retry never reconstructs a bearer from a hash. It rotates the one stored
// capability for each CTA under the lifecycle lock and returns the fresh raw
// value only to the caller that immediately renders/sends the notification.
// The outbox stores only its logical key and delivery state.
function retryLifecycleNotification_(input) {
  if (!input || !input.store || !input.reservationId || !input.eventType) fail_('NOTIFICATION_RETRY_INVALID');
  return withLifecycleLock_(input, function() {
    const record = input.store.loadByReservationId(String(input.reservationId));
    if (!record) return { ok: false, code: 'NOTIFICATION_RECORD_MISSING' };
    const secret = lifecycleCapabilitySecret_(input);
    const now = lifecycleNow_(input.now); const nowIso = new Date(now).toISOString(); const fields = {}; const tokens = {};
    const notification = makeLifecycleNotification_(input.eventType, record, { now: nowIso });
    notification.ctas.forEach(function(cta) {
      const type = cta === 'RESCHEDULE' ? LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE : LIFECYCLE.CAPABILITY_TYPE.CANCEL;
      const fresh = createCapability_(type, { secret: secret, now: now });
      Object.assign(fields, capabilityFields_(fresh)); tokens[cta] = fresh.token;
    });
    if (!notification.ctas.length) return { ok: true, notification: notification, capabilityTokens: {} };
    const updated = storeUpdateWithRetry_(input.store, record, fields);
    const refreshed = Object.assign({}, record, updated, fields);
    return { ok: true, notification: makeLifecycleNotification_(input.eventType, refreshed, { now: nowIso }),
      capabilityTokens: tokens, record: refreshed };
  });
}

function claimNotificationOutbox_(entry, now) {
  if (!entry || !entry.key) return { ok: false, code: 'NOTIFICATION_CLAIM_REJECTED' };
  if (entry.state === 'sent' || entry.state === 'superseded') return { ok: false, code: 'NOTIFICATION_ALREADY_SENT' };
  entry.state = 'claimed'; entry.attemptCount += 1; entry.claimedAt = String(now || new Date().toISOString());
  entry.lastAttemptAt = entry.claimedAt; return { ok: true, entry: entry };
}

function completeNotificationOutbox_(entry, result) {
  if (!entry || entry.state !== 'claimed') return { ok: false, code: 'NOTIFICATION_NOT_CLAIMED' };
  entry.state = result && result.ok ? 'sent' : 'failed'; entry.lastResult = result && result.ok ? 'sent' : 'failed';
  return { ok: entry.state === 'sent', entry: entry };
}

function notificationLogSafe_(entry) {
  return { key: entry.key, version: entry.version, state: entry.state, attemptCount: entry.attemptCount,
    lastAttemptAt: entry.lastAttemptAt, lastResult: entry.lastResult };
}

var __PHASE_A_TEST_EXPORTS__ = Object.freeze({
  LIFECYCLE: LIFECYCLE,
  HEADERS: RESERVATION_HEADERS,
  OUTBOX_HEADERS: NOTIFICATION_OUTBOX_HEADERS,
  TRANSITIONS: LIFECYCLE_TRANSITIONS,
  CAPABILITY_RANDOM_UUID_COUNT: CAPABILITY_RANDOM_UUID_COUNT,
  CAPABILITY_SECRET_MIN_LENGTH: CAPABILITY_SECRET_MIN_LENGTH,
  PROPERTY_KEYS: PROPERTY_KEYS, BASE_PROPERTY_KEYS: BASE_PROPERTY_KEYS, CAPABILITY_PROPERTY_KEYS: CAPABILITY_PROPERTY_KEYS,
  REFUND_PROPERTY_KEYS: REFUND_PROPERTY_KEYS, readConfig_: readConfig_, readCapabilityConfig_: readCapabilityConfig_, requireCapabilitySecret_: requireCapabilitySecret_,
  transitionAllowed_: transitionAllowed_, assertTransition_: assertTransition_,
  randomOpaqueCapabilityToken_: randomOpaqueCapabilityToken_, hashCapabilityToken_: hashCapabilityToken_,
  constantTimeEqual_: constantTimeEqual_, createCapability_: createCapability_,
  capabilityForStorage_: capabilityForStorage_, verifyCapability_: verifyCapability_,
  revokeCapability_: revokeCapability_, capabilityFields_: capabilityFields_,
  capabilityFromRecord_: capabilityFromRecord_, isPatientRescheduleEligible_: isPatientRescheduleEligible_,
  canPatientReschedule_: canPatientReschedule_, claimPatientReschedule_: claimPatientReschedule_,
  makeOperationId_: makeOperationId_, applyOperationOnce_: applyOperationOnce_,
  makeCalendarLinkKey_: makeCalendarLinkKey_,
  makeNotificationLogicalKey_: makeNotificationLogicalKey_, createNotificationOutbox_: createNotificationOutbox_,
  claimNotificationOutbox_: claimNotificationOutbox_, completeNotificationOutbox_: completeNotificationOutbox_,
  makeLifecycleNotification_: makeLifecycleNotification_, lifecycleCtas_: lifecycleCtas_,
  lifecycleNotificationShowsMeet_: lifecycleNotificationShowsMeet_,
  lifecycleNotificationStateField_: lifecycleNotificationStateField_,
  nextLifecycleNotificationVersion_: nextLifecycleNotificationVersion_,
  nextDurableNotificationVersion_: nextDurableNotificationVersion_,
  notificationSnapshotFromRecord_: notificationSnapshotFromRecord_,
  notificationEventDisposition_: notificationEventDisposition_,
  validOperationId_: validOperationId_,
  notificationOccurrenceKey_: notificationOccurrenceKey_,
  findDurableNotificationReplay_: findDurableNotificationReplay_,
  pendingSameTypeNotification_: pendingSameTypeNotification_,
  reconstructLifecycleEventTypeFromEntry_: reconstructLifecycleEventTypeFromEntry_,
  isRetryableNotificationState_: isRetryableNotificationState_,
  retryLifecycleNotification_: retryLifecycleNotification_, assertCancellationTransition_: assertCancellationTransition_, atomicCancellationTransitionFields_: atomicCancellationTransitionFields_,
  patientRescheduleTransaction_: patientRescheduleTransaction_, patientCancelTransaction_: patientCancelTransaction_,
  providerRefundAttempted_: providerRefundAttempted_,
  manualPolicyRefundNotificationNeeded_: manualPolicyRefundNotificationNeeded_,
  withLifecycleLock_: withLifecycleLock_,
  notificationLogSafe_: notificationLogSafe_, reconstructLifecycleEventType_: reconstructLifecycleEventType_,
  notificationRetryStateField_: notificationRetryStateField_, selectRetryableNotificationWork_: selectRetryableNotificationWork_,
  MAX_NOTIFICATION_ATTEMPTS: MAX_NOTIFICATION_ATTEMPTS, MAX_NOTIFICATION_OUTBOX_BATCH: MAX_NOTIFICATION_OUTBOX_BATCH,
  LIFECYCLE_NOTIFICATION_TYPE: LIFECYCLE_NOTIFICATION_TYPE,
  NOTIFICATION_OUTBOX_RETRYABLE_STATES: NOTIFICATION_OUTBOX_RETRYABLE_STATES,
  NOTIFICATION_OUTBOX_TERMINAL_STATES: NOTIFICATION_OUTBOX_TERMINAL_STATES,
  transitionBooking_: transitionBooking_,
  transitionPayment_: transitionPayment_, transitionRefund_: transitionRefund_, transitionSchedule_: transitionSchedule_,
  validIdempotencyKey_: validIdempotencyKey_, makeOpaqueId_: makeOpaqueId_,
  makeFlowCommerceOrder_: makeFlowCommerceOrder_, FLOW_COMMERCE_ORDER_MAX_LENGTH: FLOW_COMMERCE_ORDER_MAX_LENGTH,
  startAt_: startAt_,
  formatPatientFacingDateTime_: formatPatientFacingDateTime_,
  SLOT_HOLD_MS: SLOT_HOLD_MS, SESSION_DURATION_MINUTES: SESSION_DURATION_MINUTES,
  SLOT_INTERVAL_MINUTES: SLOT_INTERVAL_MINUTES, SESSION_DURATION_MS: SESSION_DURATION_MS,
  SLOT_INTERVAL_MS: SLOT_INTERVAL_MS, sessionEndAt_: sessionEndAt_, slotIntervalEndAt_: slotIntervalEndAt_,
  targetEndAt_: targetEndAt_,
  FLOW_PAYMENT_TIMEOUT_SECONDS: FLOW_PAYMENT_TIMEOUT_SECONDS,
  FLOW_CHECKOUT_TIMEOUT_SECONDS: FLOW_CHECKOUT_TIMEOUT_SECONDS,
  INITIAL_PRICE_CLP: INITIAL_PRICE_CLP, FOLLOWUP_PRICE_CLP: FOLLOWUP_PRICE_CLP,
  CANONICAL_CONSULTATION_PRICE_CLP: CANONICAL_CONSULTATION_PRICE_CLP,
  slotHoldExpiryIso_: slotHoldExpiryIso_, remainingHoldSeconds_: remainingHoldSeconds_,
  slotHoldIsExpired_: slotHoldIsExpired_, reservationOccupiesSlot_: reservationOccupiesSlot_,
  patientFacingServiceLabel_: patientFacingServiceLabel_,
  patientFacingModalityLabel_: patientFacingModalityLabel_,
  PATIENT_EMAIL_TIME_ZONE: PATIENT_EMAIL_TIME_ZONE,
  memoryNotificationOutboxStore_: memoryNotificationOutboxStore_,
});

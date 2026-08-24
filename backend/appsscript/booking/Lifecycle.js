/**
 * Phase A lifecycle primitives.
 *
 * This file is deliberately side-effect free. Calendar, Flow, mail and
 * datastore adapters are consumers of these contracts in later phases.
 */

var LIFECYCLE_TRANSITIONS = Object.freeze({
  booking_status: Object.freeze({
    initiated: Object.freeze(['payment_pending', 'cancellation_requested', 'manual_review']),
    payment_pending: Object.freeze(['confirmed', 'cancellation_requested', 'reconciliation_required', 'manual_review']),
    confirmed: Object.freeze(['cancellation_requested', 'reconciliation_required', 'manual_review']),
    cancellation_requested: Object.freeze(['cancelled', 'reconciliation_required', 'manual_review']),
    cancelled: Object.freeze([]), reconciliation_required: Object.freeze(['manual_review']),
    manual_review: Object.freeze([]),
  }),
  payment_status: Object.freeze({
    not_started: Object.freeze(['pending', 'failed', 'unknown']),
    pending: Object.freeze(['paid', 'rejected', 'failed', 'unknown']),
    unknown: Object.freeze(['pending', 'paid', 'rejected', 'failed']),
    paid: Object.freeze([]), rejected: Object.freeze([]), failed: Object.freeze([]),
  }),
  refund_status: Object.freeze({
    not_required: Object.freeze(['refund_requested', 'manual_review']),
    refund_requested: Object.freeze(['refund_pending', 'refund_failed', 'manual_review']),
    refund_pending: Object.freeze(['refunded', 'refund_failed', 'manual_review']),
    refund_failed: Object.freeze(['refund_requested', 'refund_pending', 'manual_review']),
    refunded: Object.freeze([]), manual_review: Object.freeze([]),
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

function claimNotificationOutbox_(entry, now) {
  if (!entry || !entry.key || entry.state === 'sent') return { ok: false, code: 'NOTIFICATION_ALREADY_SENT' };
  if (entry.state === 'claimed') return { ok: false, code: 'NOTIFICATION_CLAIMED' };
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
  TRANSITIONS: LIFECYCLE_TRANSITIONS,
  CAPABILITY_RANDOM_UUID_COUNT: CAPABILITY_RANDOM_UUID_COUNT,
  CAPABILITY_SECRET_MIN_LENGTH: CAPABILITY_SECRET_MIN_LENGTH,
  PROPERTY_KEYS: PROPERTY_KEYS, readConfig_: readConfig_,
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
  notificationLogSafe_: notificationLogSafe_, transitionBooking_: transitionBooking_,
  transitionPayment_: transitionPayment_, transitionRefund_: transitionRefund_, transitionSchedule_: transitionSchedule_,
  validIdempotencyKey_: validIdempotencyKey_, makeOpaqueId_: makeOpaqueId_,
});

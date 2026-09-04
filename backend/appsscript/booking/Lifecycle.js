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

// ---------------------------------------------------------------------------
// PATIENT MANAGEMENT POLICY V2 — the one canonical 24-hour authority.
//
// getBookingManagementPolicy_(reservation, serverNow) is the ONLY place in this
// repository that decides how long before a session a patient may still
// reschedule, cancel, or be refunded. Endpoints, email templates, the Worker
// and the /manage page all consume its decision; none of them re-derive it.
//
// The cutoff is exactly 24 chronological hours before the CURRENT persisted
// session start:
//
//     cutoff_at = current_start_at - 24h
//
// It is deliberately NOT "the previous calendar day" and NOT "the same date
// minus one", so a Chile DST transition inside the window cannot move it: the
// arithmetic is absolute-instant subtraction and never touches a wall clock.
//
// Time authority is the server. `serverNow` defaults to the server clock; an
// explicitly supplied but unusable value fails closed rather than falling back,
// so no caller — least of all a browser — can widen the window by supplying a
// bad clock.
//
// Schedule authority is `current_start_at` only. `original_start_at` is the
// pre-reschedule appointment and must never drive the cutoff, so after a valid
// reschedule the cutoff recomputes from the newly persisted start.
// ---------------------------------------------------------------------------

var PATIENT_MANAGEMENT_CUTOFF_HOURS = 24;
var PATIENT_MANAGEMENT_CUTOFF_MS = PATIENT_MANAGEMENT_CUTOFF_HOURS * 60 * 60 * 1000;
var PATIENT_MANAGEMENT_REFUND_PERCENT_FULL = 100;
var PATIENT_MANAGEMENT_REFUND_PERCENT_NONE = 0;

/** Durable audit code for a cancellation the 24-hour policy decided is not
 *  refundable. It is an outcome, not a pending question, so it never routes to
 *  manual review the way BUSINESS_POLICY_TBD does. */
var PATIENT_CANCEL_LATE_NON_REFUNDABLE = 'PATIENT_CANCEL_LATE_NON_REFUNDABLE';

/** Public, non-leaky vocabulary for the /manage surface. Never a stored state name. */
var MANAGEMENT_WINDOW = Object.freeze({
  OPEN: 'open',               // >= 24h: reschedule + cancel + full refund
  CANCEL_ONLY: 'cancel_only', // 0 < remaining < 24h: cancel to notify, no refund
  CLOSED: 'closed',           // started/past, or nothing can be determined safely
});

/** Why the policy decided what it decided. Operational/diagnostic, not UI copy. */
var BOOKING_MANAGEMENT_REASON = Object.freeze({
  OPEN_FULL: 'MANAGEMENT_OPEN_FULL',
  CANCEL_ONLY_NON_REFUNDABLE: 'MANAGEMENT_CANCEL_ONLY_NON_REFUNDABLE',
  SESSION_STARTED: 'MANAGEMENT_CLOSED_SESSION_STARTED',
  RESERVATION_UNKNOWN: 'MANAGEMENT_CLOSED_RESERVATION_UNKNOWN',
  SCHEDULE_UNKNOWN: 'MANAGEMENT_CLOSED_SCHEDULE_UNKNOWN',
  CLOCK_UNKNOWN: 'MANAGEMENT_CLOSED_CLOCK_UNKNOWN',
  NOT_ACTIVE: 'MANAGEMENT_CLOSED_NOT_ACTIVE',
});

/** Booking states in which normal patient self-management is even conceivable. */
var PATIENT_MANAGEABLE_BOOKING_STATUSES = Object.freeze([
  LIFECYCLE.BOOKING_STATUS.INITIATED,
  LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING,
  LIFECYCLE.BOOKING_STATUS.CONFIRMED,
]);

function managementPolicyClosed_(reason, extra) {
  return Object.freeze(Object.assign({
    can_reschedule: false,
    can_cancel: false,
    refund_eligible: false,
    refund_percent: PATIENT_MANAGEMENT_REFUND_PERCENT_NONE,
    cutoff_at: '',
    cutoff_hours: PATIENT_MANAGEMENT_CUTOFF_HOURS,
    remaining_ms: null,
    session_start_at: '',
    window: MANAGEMENT_WINDOW.CLOSED,
    reason: reason,
  }, extra || {}));
}

/**
 * Resolve the server instant the policy is evaluated at.
 *
 * Absent  -> the server clock (production behaviour).
 * Finite  -> that instant.
 * Present but unusable -> null, which the caller turns into a fail-closed policy.
 */
function managementPolicyNow_(serverNow) {
  if (serverNow === undefined || serverNow === null) return Date.now();
  // Only a real instant counts. A numeric-looking string, a boolean or an object
  // is refused outright rather than coerced, because coercion is how a garbage
  // clock quietly becomes epoch 0 — an instant from which every session is in
  // the future and every window looks open.
  // Duck-typed rather than `instanceof Date`, so a Date from another realm (an
  // Apps Script library, or a test harness clock) is still accepted.
  const value = typeof serverNow === 'number' ? serverNow
    : (serverNow && typeof serverNow.getTime === 'function' ? Number(serverNow.getTime()) : NaN);
  return Number.isFinite(value) ? value : null;
}

/**
 * THE canonical patient-management decision.
 *
 * @param {Object} reservation persisted reservation record (current_start_at is authoritative)
 * @param {number|Date} [serverNow] server instant; omit to use the server clock
 * @return {Object} frozen decision: can_reschedule, can_cancel, refund_eligible,
 *   refund_percent, cutoff_at, remaining_ms, reason (+ window, cutoff_hours,
 *   session_start_at for presentation)
 */
function getBookingManagementPolicy_(reservation, serverNow) {
  if (!reservation || typeof reservation !== 'object') {
    return managementPolicyClosed_(BOOKING_MANAGEMENT_REASON.RESERVATION_UNKNOWN);
  }
  const now = managementPolicyNow_(serverNow);
  if (now === null) return managementPolicyClosed_(BOOKING_MANAGEMENT_REASON.CLOCK_UNKNOWN);

  // Current persisted start only. original_start_at is never consulted here.
  const startMs = Date.parse(String(reservation.current_start_at || ''));
  if (!Number.isFinite(startMs)) {
    return managementPolicyClosed_(BOOKING_MANAGEMENT_REASON.SCHEDULE_UNKNOWN);
  }

  const startIso = new Date(startMs).toISOString();
  const cutoffAt = new Date(startMs - PATIENT_MANAGEMENT_CUTOFF_MS).toISOString();
  const remainingMs = startMs - now;
  const timing = {
    cutoff_at: cutoffAt,
    cutoff_hours: PATIENT_MANAGEMENT_CUTOFF_HOURS,
    remaining_ms: remainingMs,
    session_start_at: startIso,
  };

  // C) the session has started or is in the past: normal self-management closed.
  if (remainingMs <= 0) {
    return managementPolicyClosed_(BOOKING_MANAGEMENT_REASON.SESSION_STARTED, timing);
  }

  // Refund eligibility is a function of the schedule window and the confirmed
  // payment alone. It intentionally ignores booking_status, because the refund
  // decision is taken for a reservation that is being cancelled right now and
  // is re-read afterwards for audit while it sits in cancellation_requested.
  const paid = String(reservation.payment_status || '') === LIFECYCLE.PAYMENT_STATUS.PAID;
  const beforeCutoff = remainingMs >= PATIENT_MANAGEMENT_CUTOFF_MS;

  // The single refund decision. Every branch below reads it rather than
  // restating a literal, so there is exactly one expression in the codebase
  // that can make a cancellation refundable.
  const refundEligible = beforeCutoff && paid;
  const money = {
    refund_eligible: refundEligible,
    refund_percent: refundEligible ? PATIENT_MANAGEMENT_REFUND_PERCENT_FULL : PATIENT_MANAGEMENT_REFUND_PERCENT_NONE,
  };

  // Actions additionally require a booking that is still self-manageable.
  const active = PATIENT_MANAGEABLE_BOOKING_STATUSES.indexOf(String(reservation.booking_status || '')) !== -1;
  if (!active) {
    return Object.freeze(Object.assign({
      can_reschedule: false,
      can_cancel: false,
      window: MANAGEMENT_WINDOW.CLOSED,
      reason: BOOKING_MANAGEMENT_REASON.NOT_ACTIVE,
    }, money, timing));
  }

  // A) remaining >= 24h — reschedule, cancel, 100% refund.
  if (beforeCutoff) {
    return Object.freeze(Object.assign({
      can_reschedule: true,
      can_cancel: true,
      window: MANAGEMENT_WINDOW.OPEN,
      reason: BOOKING_MANAGEMENT_REASON.OPEN_FULL,
    }, money, timing));
  }

  // B) 0 < remaining < 24h — cancel to notify, no reschedule, no refund.
  return Object.freeze(Object.assign({
    can_reschedule: false,
    can_cancel: true,
    window: MANAGEMENT_WINDOW.CANCEL_ONLY,
    reason: BOOKING_MANAGEMENT_REASON.CANCEL_ONLY_NON_REFUNDABLE,
  }, money, timing));
}

// ---------------------------------------------------------------------------
// MANAGEMENT CAPABILITY LIFETIME — derived from the current schedule.
//
// A management link must stay usable for as long as the business policy leaves
// management open, and not one moment longer. A fixed TTL cannot express that:
// a session booked three weeks out would hand the patient a link that dies
// while REAGENDAR and the full refund are still legitimately available.
//
// So the lifetime is derived from the CURRENT persisted session start:
//
//     capability_expires_at = current_start_at + one slot interval
//
// The grace is what keeps the POLICY the authority that speaks at the boundary.
// A patient who opens /manage a minute before the session start gets a neutral
// "closed" state from getBookingManagementPolicy_ rather than a broken link,
// and a mutation attempted seconds after the start is refused as
// MANAGEMENT_WINDOW_CLOSED — a policy decision — instead of as a bad token.
//
// This is not an unbounded capability. It is pinned to one concrete instant,
// and clamped to the booking horizon so a corrupted far-future start cannot
// mint a capability that outlives the window such a booking could have come
// from. Token validity is necessary but never sufficient: every action is
// authorized by the policy, re-evaluated under the lock at action time.
// ---------------------------------------------------------------------------

var CAPABILITY_POST_SESSION_GRACE_MS = SLOT_INTERVAL_MS;

/**
 * The minimum lead time a reschedule TARGET must satisfy. Reuses the canonical
 * BOOKING_LEAD_MINUTES that assertBookableSlot_ applies to a new booking — one
 * number, one meaning — and fails closed if its owner is not loaded.
 */
function rescheduleTargetMinLeadMinutes_() {
  if (typeof BOOKING_LEAD_MINUTES !== 'number') fail_('BOOKING_LEAD_CONFIGURATION_MISSING');
  return BOOKING_LEAD_MINUTES;
}

function rescheduleTargetMinLeadMs_() {
  return rescheduleTargetMinLeadMinutes_() * 60 * 1000;
}

/**
 * The booking horizon is the longest legitimate distance to a session, so no
 * capability may outlive it. Read at call time from its canonical owner
 * (CalendarGateway.js) rather than duplicated here, and fail closed with a
 * diagnosable code if that owner is not loaded.
 */
function capabilityHorizonCeilingMs_(nowMs) {
  if (typeof AVAILABILITY_HORIZON_DAYS !== 'number') fail_('BOOKING_HORIZON_CONFIGURATION_MISSING');
  return nowMs + (AVAILABILITY_HORIZON_DAYS * 24 * 60 * 60 * 1000) + CAPABILITY_POST_SESSION_GRACE_MS;
}

/**
 * The instant a management capability for this reservation stops being useful.
 *
 * Returns '' — never a fallback — when the current schedule is unusable or the
 * horizon has already passed, so every caller fails closed rather than minting
 * a capability it cannot justify.
 */
function capabilityManagementHorizonIso_(record, nowMs) {
  const startMs = Date.parse(String(record && record.current_start_at || ''));
  if (!Number.isFinite(startMs)) return '';
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const horizonMs = startMs + CAPABILITY_POST_SESSION_GRACE_MS;
  if (horizonMs <= now) return '';
  return new Date(Math.min(horizonMs, capabilityHorizonCeilingMs_(now))).toISOString();
}

/**
 * Re-align the stored capability expiries onto the horizon of a schedule that
 * just moved, so an already-delivered link tracks the CURRENT session:
 * it is extended when the session moves later, and contracted when it moves
 * earlier. Never resurrects a capability that is already revoked or expired —
 * a schedule change must not give a dead bearer a second life.
 */
function alignedCapabilityExpiryFields_(record, nowMs) {
  const horizon = capabilityManagementHorizonIso_(record, nowMs);
  if (!horizon) return {};
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const fields = {};
  [LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE, LIFECYCLE.CAPABILITY_TYPE.CANCEL].forEach(function(type) {
    const prefix = type === LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE ? 'reschedule' : 'cancel';
    const stored = capabilityFromRecord_(record, type);
    if (!stored.hash || stored.revokedAt) return;
    const currentExpiry = Date.parse(String(stored.expiresAt || ''));
    if (!Number.isFinite(currentExpiry) || currentExpiry <= now) return;
    if (stored.expiresAt === horizon) return;
    fields[prefix + '_capability_expires_at'] = horizon;
  });
  return fields;
}

// Fallback only, for a caller with no schedule context (primitives and unit
// tests). Every production mint passes an explicit schedule-derived expiresAt;
// falling back to this fixed TTL is the defect this section exists to prevent.
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
    // Stale-page / direct-call guard. The window is recomputed HERE, under the
    // lock, from the record just read from the store. A browser that rendered
    // REAGENDAR while 26 hours remained cannot carry that button past the
    // cutoff, and neither can a hand-rolled request to this endpoint.
    const policy = getBookingManagementPolicy_(record, now);
    if (!policy.can_reschedule) {
      return { ok: false, code: 'RESCHEDULE_WINDOW_CLOSED', window: policy.window,
        cutoffAt: policy.cutoff_at, cutoffHours: policy.cutoff_hours };
    }
    // Server-side minimum lead time on the TARGET slot, using the same canonical
    // BOOKING_LEAD_MINUTES and the same comparison as assertBookableSlot_ uses
    // for a new booking. The picker enforces this client-side too, but a browser
    // is not authority: a hand-rolled payload, a tampered page or a stale tab
    // must all be refused here.
    const targetStartMs = Date.parse(String(input.targetStartAt || ''));
    if (!Number.isFinite(targetStartMs)) return { ok: false, code: 'REQUEST_REJECTED' };
    if (targetStartMs < now + rescheduleTargetMinLeadMs_()) {
      return { ok: false, code: 'TARGET_LEAD_TIME_TOO_SHORT', minLeadMinutes: rescheduleTargetMinLeadMinutes_() };
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
    // Applied over the revocation, and computed from the merged post-move view,
    // so the just-revoked RESCHEDULE capability is never extended and the
    // surviving CANCEL capability tracks the new session start.
    Object.assign(updates, alignedCapabilityExpiryFields_(Object.assign({}, record, updates), now));
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
      enqueueTerminalCancellationNotificationBestEffort_(deps, record);
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
    // Same revalidation as reschedule, on the same freshly read record. Cancel
    // stays open right up to the session start; only a started/past session, a
    // non-self-manageable booking or an undeterminable schedule closes it.
    const managementPolicy = getBookingManagementPolicy_(record, now);
    if (!managementPolicy.can_cancel) {
      return { ok: false, code: 'MANAGEMENT_WINDOW_CLOSED', window: managementPolicy.window,
        cutoffAt: managementPolicy.cutoff_at, cutoffHours: managementPolicy.cutoff_hours };
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
    const evaluated = deps.policyEvaluator ? deps.policyEvaluator(record, now) : { decision: 'BUSINESS_POLICY_TBD', eligible: false };
    // An injected evaluator may only ever NARROW eligibility. The canonical
    // policy is ANDed in unconditionally, so no wiring — a test fake, a
    // callback, reconciliation, or a future caller — can authorise a refund the
    // 24-hour policy refuses. managementPolicy.refund_eligible already requires
    // a confirmed `paid` payment, so payment state is not re-derived here.
    const refundEligible = Boolean(evaluated.eligible && managementPolicy.refund_eligible);
    // A cancellation inside the cutoff is a DECIDED non-refundable outcome, not
    // an open question: it persists refund NOT_REQUIRED and never reaches the
    // operational manual-review path. Everything else that is not eligible
    // keeps its prior BUSINESS_POLICY_TBD manual-review semantics.
    const lateNonRefundable = !refundEligible
      && managementPolicy.window === MANAGEMENT_WINDOW.CANCEL_ONLY
      && String(record.payment_status || '') === LIFECYCLE.PAYMENT_STATUS.PAID;
    const updates = atomicCancellationTransitionFields_(record, { schedule_status: LIFECYCLE.SCHEDULE_STATUS.CANCELLED,
      cancellation_source: 'patient', cancelled_at: new Date(now).toISOString(), last_operation_id: operationId,
      reconciliation_state: '', cancel_capability_revoked_at: revoked.revokedAt,
      refund_last_error_code: refundEligible ? '' : (lateNonRefundable ? PATIENT_CANCEL_LATE_NON_REFUNDABLE : 'BUSINESS_POLICY_TBD') },
      { terminal: !refundEligible });
    if (refundEligible) updates.refund_status = LIFECYCLE.REFUND_STATUS.REQUESTED;
    else if (lateNonRefundable) updates.refund_status = LIFECYCLE.REFUND_STATUS.NOT_REQUIRED;
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
    enqueueTerminalCancellationNotificationBestEffort_(deps, updated);
    return { ok: true, replay: false, status: refundEligible ? 'cancellation_pending' : 'cancelled',
      refund: refundEligible ? 'requested' : (lateNonRefundable ? 'not_required' : 'BUSINESS_POLICY_TBD'),
      refundPercent: refundEligible ? managementPolicy.refund_percent : PATIENT_MANAGEMENT_REFUND_PERCENT_NONE };
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

/**
 * A cancellation that is ALREADY terminal at cancellation time and owes a
 * notification. Two shapes qualify:
 *
 *  - refund MANUAL_REVIEW — out of policy, an operator has to look
 *  - refund NOT_REQUIRED  — decided non-refundable inside the 24-hour cutoff
 *
 * A refundable cancellation is excluded on purpose: it is still
 * cancellation_requested here and is spoken for by the provider-confirmed
 * final email. The consumer decides which patient/operator notifications the
 * shape actually earns.
 */
function terminalCancellationNotificationNeeded_(record) {
  if (!record) return false;
  if (record.booking_status !== LIFECYCLE.BOOKING_STATUS.CANCELLED) return false;
  if (record.payment_status !== LIFECYCLE.PAYMENT_STATUS.PAID) return false;
  const refund = String(record.refund_status || '');
  return refund === LIFECYCLE.REFUND_STATUS.MANUAL_REVIEW
    || refund === LIFECYCLE.REFUND_STATUS.NOT_REQUIRED;
}

function enqueueTerminalCancellationNotificationBestEffort_(deps, record) {
  if (!deps || typeof deps.enqueueNotification !== 'function') return;
  if (!terminalCancellationNotificationNeeded_(record)) return;
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
    // The horizon comes from the record just read under the lock, so a lifecycle
    // email emitted after ANY schedule change — patient or clinician — carries a
    // capability scoped to the NEW current session start. original_start_at is
    // never consulted. An unusable or already-passed horizon mints nothing: the
    // email still sends, simply without management buttons it could not honour.
    const horizon = capabilityManagementHorizonIso_(record, now);
    notification.ctas.forEach(function(cta) {
      if (!horizon) return;
      const type = cta === 'RESCHEDULE' ? LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE : LIFECYCLE.CAPABILITY_TYPE.CANCEL;
      const fresh = createCapability_(type, { secret: secret, now: now, expiresAt: horizon });
      Object.assign(fields, capabilityFields_(fresh)); tokens[cta] = fresh.token;
    });
    if (!Object.keys(fields).length) return { ok: true, notification: notification, capabilityTokens: {} };
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
  getBookingManagementPolicy_: getBookingManagementPolicy_,
  capabilityManagementHorizonIso_: capabilityManagementHorizonIso_,
  capabilityHorizonCeilingMs_: capabilityHorizonCeilingMs_,
  rescheduleTargetMinLeadMinutes_: rescheduleTargetMinLeadMinutes_,
  alignedCapabilityExpiryFields_: alignedCapabilityExpiryFields_,
  CAPABILITY_POST_SESSION_GRACE_MS: CAPABILITY_POST_SESSION_GRACE_MS,
  CAPABILITY_TTL_MS: CAPABILITY_TTL_MS,
  managementPolicyNow_: managementPolicyNow_,
  PATIENT_MANAGEMENT_CUTOFF_HOURS: PATIENT_MANAGEMENT_CUTOFF_HOURS,
  PATIENT_MANAGEMENT_CUTOFF_MS: PATIENT_MANAGEMENT_CUTOFF_MS,
  PATIENT_MANAGEMENT_REFUND_PERCENT_FULL: PATIENT_MANAGEMENT_REFUND_PERCENT_FULL,
  PATIENT_MANAGEMENT_REFUND_PERCENT_NONE: PATIENT_MANAGEMENT_REFUND_PERCENT_NONE,
  PATIENT_CANCEL_LATE_NON_REFUNDABLE: PATIENT_CANCEL_LATE_NON_REFUNDABLE,
  PATIENT_MANAGEABLE_BOOKING_STATUSES: PATIENT_MANAGEABLE_BOOKING_STATUSES,
  MANAGEMENT_WINDOW: MANAGEMENT_WINDOW,
  BOOKING_MANAGEMENT_REASON: BOOKING_MANAGEMENT_REASON,
  providerRefundAttempted_: providerRefundAttempted_,
  manualPolicyRefundNotificationNeeded_: manualPolicyRefundNotificationNeeded_,
  terminalCancellationNotificationNeeded_: terminalCancellationNotificationNeeded_,
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

import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sourcePaths = ['../Code.js', '../Lifecycle.js'];
const source = await Promise.all(sourcePaths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
let networkCalls = 0;
let mailCalls = 0;

const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const utilities = {
  DigestAlgorithm: { SHA_256: 'sha256' },
  Charset: { UTF_8: 'utf8' },
  getUuid: randomUUID,
  computeDigest: (_algorithm, value) => bytes(createHash('sha256').update(String(value)).digest()),
  computeHmacSha256Signature: (value, secret) => bytes(createHmac('sha256', String(secret)).update(String(value)).digest()),
};
const properties = { getProperties: () => ({}) };
const context = {
  console,
  Date,
  Intl,
  Set,
  Number,
  String,
  Object,
  Array,
  JSON,
  RegExp,
  Math,
  encodeURIComponent,
  decodeURIComponent,
  Utilities: utilities,
  PropertiesService: { getScriptProperties: () => properties },
  SpreadsheetApp: { openById: () => { throw new Error('spreadsheet stub must not be called'); } },
  CalendarApp: { getCalendarById: () => { throw new Error('calendar stub must not be called'); } },
  MailApp: { sendEmail: () => { mailCalls += 1; } },
  GmailApp: { sendEmail: () => { mailCalls += 1; } },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  UrlFetchApp: { fetch: () => { networkCalls += 1; throw new Error('unexpected network call'); } },
  Session: { getActiveUser: () => ({ getEmail: () => '' }) },
  ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (value) => ({ value, setMimeType() { return this; } }) },
};
vm.createContext(context);
for (const file of source) vm.runInContext(file, context);
const api = context.__PHASE_A_TEST_EXPORTS__;
assert.ok(api, 'Phase A exports must be available to the local harness');

let assertions = 1;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const rejects = (fn, pattern, message) => { assert.throws(fn, pattern, message); assertions += 1; };

// Schema: exact, unique and lifecycle-separated.
check(api.HEADERS.length === 57, 'schema header count is exact');
check(new Set(api.HEADERS).size === api.HEADERS.length, 'schema has no duplicate headers');
check(Array.isArray(api.OUTBOX_HEADERS) && api.OUTBOX_HEADERS.length === 20
  && new Set(api.OUTBOX_HEADERS).size === api.OUTBOX_HEADERS.length
  && api.OUTBOX_HEADERS.includes('source_operation_id'),
  'durable outbox schema is exact and unique');
check(!api.OUTBOX_HEADERS.some((header) => /email|token|rut|secret|bearer|phone|message/.test(header)),
  'outbox schema stores no recipient, token, RUT, or clinical text');
for (const header of [
  'idempotency_key', 'reservation_id', 'original_start_at', 'current_start_at', 'current_end_at',
  'booking_status', 'payment_status', 'refund_status', 'schedule_status', 'status_token_hash',
  'calendar_event_id', 'calendar_event_etag', 'calendar_sync_hash', 'calendar_link_key',
  'meet_url', 'patient_reschedule_count', 'reschedule_capability_hash', 'reschedule_capability_revoked_at',
  'cancel_capability_hash', 'cancel_capability_revoked_at',
  'cancelled_at', 'refund_commerce_order', 'notification_outbox_key', 'reconciliation_state',
  'last_operation_id', 'created_at', 'updated_at',
]) check(api.HEADERS.includes(header), `required header present: ${header}`);
check(!api.HEADERS.includes('status') && !api.HEADERS.includes('flow_status'), 'overloaded legacy state fields are not schema truth');

// State model: domain transitions are independent and fail closed.
check(api.transitionAllowed_('booking_status', 'initiated', 'payment_pending'), 'valid booking transition');
check(api.transitionAllowed_('payment_status', 'pending', 'paid'), 'valid payment transition');
check(api.transitionAllowed_('refund_status', 'refund_pending', 'refunded'), 'valid refund transition');
check(api.transitionAllowed_('schedule_status', 'sync_pending', 'scheduled'), 'valid schedule transition');
rejects(() => api.assertTransition_('booking_status', 'confirmed', 'initiated'), /INVALID_BOOKING_STATUS_TRANSITION/);
rejects(() => api.assertTransition_('payment_status', 'paid', 'pending'), /INVALID_PAYMENT_STATUS_TRANSITION/);
check(api.transitionAllowed_('booking_status', 'cancelled', 'cancelled'), 'same booking state is idempotent');
check(api.transitionAllowed_('booking_status', 'cancelled', 'cancelled')
  && api.transitionAllowed_('refund_status', 'not_required', 'refund_pending') === false,
  'booking cancellation is independent from refund lifecycle');
check(api.transitionAllowed_('refund_status', 'refund_requested', 'refund_pending'), 'cancelled booking may reach refund_pending independently');

// Transition helpers persist once per real change and synchronize the loaded record.
const transitionSchema = { columns: {
  booking_status: 1, payment_status: 2, refund_status: 3, schedule_status: 4, updated_at: 5,
} };
const transitionWrites = [];
const transitionSheet = { getRange: (_row, column) => ({ setValue: (value) => transitionWrites.push({ column, value }) }) };
const stateWrites = (column) => transitionWrites.filter((write) => write.column === column);
const bookingRecord = { rowNumber: 2, booking_status: 'initiated' };
api.transitionBooking_(transitionSheet, transitionSchema, bookingRecord, 'payment_pending');
api.transitionBooking_(transitionSheet, transitionSchema, bookingRecord, 'confirmed');
check(bookingRecord.booking_status === 'confirmed' && stateWrites(1).length === 2, 'booking sequential transitions synchronize record and persist once each');
api.transitionBooking_(transitionSheet, transitionSchema, bookingRecord, 'cancellation_requested');
api.transitionBooking_(transitionSheet, transitionSchema, bookingRecord, 'cancelled');
check(bookingRecord.booking_status === 'cancelled' && stateWrites(1).length === 4, 'booking cancellation sequence uses same record');
const writesBeforeNoOp = transitionWrites.length;
api.transitionBooking_(transitionSheet, transitionSchema, bookingRecord, 'cancelled');
check(transitionWrites.length === writesBeforeNoOp, 'same-state booking transition is idempotent without duplicate write');

const paymentRecord = { rowNumber: 3, payment_status: 'pending' };
api.transitionPayment_(transitionSheet, transitionSchema, paymentRecord, 'paid');
check(paymentRecord.payment_status === 'paid' && stateWrites(2).length === 1, 'payment transition synchronizes record');
const refundRecord = { rowNumber: 4, refund_status: 'refund_requested' };
api.transitionRefund_(transitionSheet, transitionSchema, refundRecord, 'refund_pending');
api.transitionRefund_(transitionSheet, transitionSchema, refundRecord, 'refunded');
check(refundRecord.refund_status === 'refunded' && stateWrites(3).length === 2, 'refund sequential transitions synchronize record');
const scheduleRecord = { rowNumber: 5, schedule_status: 'hold' };
api.transitionSchedule_(transitionSheet, transitionSchema, scheduleRecord, 'sync_pending');
api.transitionSchedule_(transitionSheet, transitionSchema, scheduleRecord, 'scheduled');
check(scheduleRecord.schedule_status === 'scheduled' && stateWrites(4).length === 2, 'schedule sequential transitions synchronize record');
rejects(() => api.transitionBooking_(transitionSheet, transitionSchema, bookingRecord, 'initiated'), /INVALID_BOOKING_STATUS_TRANSITION/);
rejects(() => api.transitionPayment_(transitionSheet, transitionSchema, paymentRecord, 'pending'), /INVALID_PAYMENT_STATUS_TRANSITION/);
rejects(() => api.transitionRefund_(transitionSheet, transitionSchema, refundRecord, 'refund_requested'), /INVALID_REFUND_STATUS_TRANSITION/);
rejects(() => api.transitionSchedule_(transitionSheet, transitionSchema, scheduleRecord, 'hold'), /INVALID_SCHEDULE_STATUS_TRANSITION/);

// Capabilities: opaque, >=256-bit entropy, hashed at rest, domain-separated, expiring and revocable.
check(api.PROPERTY_KEYS.includes('CAPABILITY_TOKEN_SECRET'), 'capability secret property is required by the runtime contract');
const secret = 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz';
const now = Date.parse('2026-08-23T12:00:00.000Z');
rejects(() => api.createCapability_('RESCHEDULE', { secret: '' }), /CAPABILITY_SECRET_INVALID/);
rejects(() => api.createCapability_('RESCHEDULE', { secret: 'too-short' }), /CAPABILITY_SECRET_INVALID/);
rejects(() => api.createCapability_('RESCHEDULE', { secret: undefined }), /CAPABILITY_SECRET_INVALID/);
const capability = api.createCapability_('RESCHEDULE', {
  secret, now, expiresAt: '2026-08-24T12:00:00.000Z', version: '7',
});
const stored = api.capabilityForStorage_(capability);
check(capability.token.length >= 64, 'capability token has at least 256 bits of encoded entropy');
check(!Object.hasOwn(stored, 'token'), 'stored capability excludes raw token');
check(stored.hash.length === 64 && stored.hash !== capability.token, 'capability is hash-at-rest');
check(!capability.token.includes('reservation') && !capability.token.includes('synthetic-email'), 'capability is not PII-derived');
check(api.verifyCapability_(capability.token, 'RESCHEDULE', stored, { secret, now, version: '7' }), 'valid capability');
check(!api.verifyCapability_(capability.token, 'RESCHEDULE', stored, { secret: '', now, version: '7' }), 'missing or blank secret rejects verification');
check(!api.verifyCapability_(capability.token, 'RESCHEDULE', stored, { secret: 'too-short', now, version: '7' }), 'weak secret rejects verification');
check(!api.verifyCapability_(capability.token, 'RESCHEDULE', stored, { secret: 'wrong-synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz', now, version: '7' }), 'wrong secret rejects verification');
check(!api.verifyCapability_(capability.token, 'CANCEL', stored, { secret, now, version: '7' }), 'wrong capability type rejected');
check(api.hashCapabilityToken_(capability.token, secret, 'RESCHEDULE') !== api.hashCapabilityToken_(capability.token, secret, 'CANCEL'), 'capability HMAC domains are distinct');
const cancelCapability = api.createCapability_('CANCEL', { secret, now, version: '7', expiresAt: '2026-08-24T12:00:00.000Z' });
const cancelStored = api.capabilityForStorage_(cancelCapability);
check(!api.verifyCapability_(cancelCapability.token, 'RESCHEDULE', cancelStored, { secret, now, version: '7' }), 'CANCEL capability cannot validate as RESCHEDULE');
check(!api.verifyCapability_(capability.token, 'CANCEL', stored, { secret, now, version: '7' }), 'RESCHEDULE capability cannot validate as CANCEL');
check(!api.verifyCapability_(capability.token, 'RESCHEDULE', stored, { secret, now: Date.parse('2026-08-25T00:00:00.000Z'), version: '7' }), 'expired capability rejected');
check(!api.verifyCapability_(capability.token, 'RESCHEDULE', api.revokeCapability_(stored, '2026-08-23T12:05:00.000Z'), { secret, now, version: '7' }), 'revoked capability rejected');
check(!api.verifyCapability_(capability.token, 'RESCHEDULE', stored, { secret, now, version: '8' }), 'wrong capability version rejected');
check(!api.verifyCapability_('malformed', 'RESCHEDULE', stored, { secret, now, version: '7' }), 'malformed capability rejected');
check(api.constantTimeEqual_('aa', 'aa') && !api.constantTimeEqual_('aa', 'ab'), 'constant-time-ish comparison result');
const activeFields = api.capabilityFields_(stored);
check(activeFields.reschedule_capability_hash === capability.hash && activeFields.reschedule_capability_revoked_at === '', 'active reschedule storage fields are explicit');
check(api.capabilityFields_(api.createCapability_('CANCEL', { secret, now, version: '2' })).cancel_capability_version === '2', 'cancel storage fields are explicit');
const activePersisted = api.capabilityForStorage_(api.capabilityFromRecord_(activeFields, 'RESCHEDULE'));
check(api.verifyCapability_(capability.token, 'RESCHEDULE', activePersisted, { secret, now, version: '7' }), 'persisted active capability round-trip validates');
const revoked = api.revokeCapability_(stored, '2026-08-23T12:05:00.000Z');
const revokedFields = api.capabilityFields_(revoked);
check(revokedFields.reschedule_capability_revoked_at === '2026-08-23T12:05:00.000Z', 'revoked_at maps to the reschedule schema field');
const revokedPersisted = api.capabilityForStorage_(api.capabilityFromRecord_(revokedFields, 'RESCHEDULE'));
check(!api.verifyCapability_(capability.token, 'RESCHEDULE', revokedPersisted, { secret, now, version: '7' }), 'persisted revoked capability round-trip rejects');

// Reschedule eligibility: every lifecycle/payment/schedule invariant is required.
const rescheduleInput = {
  bookingStatus: 'confirmed', paymentStatus: 'paid', scheduleStatus: 'scheduled', patientRescheduleCount: 0,
  token: capability.token, storedCapability: stored, secret, now, version: '7', nowIso: '2026-08-23T12:00:00.000Z',
};
check(api.canPatientReschedule_(rescheduleInput), 'initial count 0 allows valid capability');
const firstClaim = api.claimPatientReschedule_(rescheduleInput);
check(firstClaim.ok && firstClaim.patient_reschedule_count === 1, 'successful self-reschedule consumes quota');
check(!api.canPatientReschedule_({ ...rescheduleInput, patientRescheduleCount: 1 }), 'count 1 rejects future self-reschedule');
check(!api.canPatientReschedule_({ ...rescheduleInput, token: 'stale-token' }), 'stale capability rejects self-reschedule');
for (const bookingStatus of ['initiated', 'payment_pending', 'cancellation_requested', 'cancelled', 'reconciliation_required', 'manual_review']) {
  check(!api.canPatientReschedule_({ ...rescheduleInput, bookingStatus }), `${bookingStatus} rejects self-reschedule`);
}
for (const paymentStatus of ['pending', 'rejected', 'failed']) {
  check(!api.canPatientReschedule_({ ...rescheduleInput, paymentStatus }), `${paymentStatus} rejects self-reschedule`);
}
for (const scheduleStatus of ['hold', 'sync_pending', 'cancelled', 'reconciliation_required']) {
  check(!api.canPatientReschedule_({ ...rescheduleInput, scheduleStatus }), `${scheduleStatus} rejects self-reschedule`);
}
check(!api.canPatientReschedule_({ ...rescheduleInput, storedCapability: revokedPersisted }), 'revoked capability rejects self-reschedule');
check(!api.canPatientReschedule_({ ...rescheduleInput, now: Date.parse('2026-08-25T00:00:00.000Z') }), 'expired capability rejects self-reschedule');

// Notification outbox: stable key, deterministic retries, no PII in safe logs.
const record = { idempotency_key: 'fran-nonprod-20260823-123e4567-e89b-42d3-a456-426614174000' };
const logicalKey = api.makeNotificationLogicalKey_(record, 'notification_patient_state');
const outbox = api.createNotificationOutbox_(logicalKey, '3', '2026-08-23T12:00:00.000Z');
const claim = api.claimNotificationOutbox_(outbox, '2026-08-23T12:01:00.000Z');
check(claim.ok && outbox.attemptCount === 1 && outbox.state === 'claimed', 'outbox claim is deterministic');
check(api.completeNotificationOutbox_(outbox, { ok: true }).ok && outbox.state === 'sent', 'outbox completion is explicit');
check(!api.claimNotificationOutbox_(outbox, '2026-08-23T12:02:00.000Z').ok, 'same logical notification cannot duplicate');
const retry = api.createNotificationOutbox_(logicalKey, '3', '2026-08-23T12:00:00.000Z');
api.claimNotificationOutbox_(retry, '2026-08-23T12:01:00.000Z');
check(!api.completeNotificationOutbox_(retry, { ok: false }).ok && retry.state === 'failed', 'failed notification retains retryable state');
check(api.claimNotificationOutbox_(retry, '2026-08-23T12:03:00.000Z').ok && retry.attemptCount === 2, 'failed notification retry is deterministic');
const safeLog = JSON.stringify(api.notificationLogSafe_(retry));
check(!safeLog.includes('synthetic-person-label') && !safeLog.includes('synthetic-email') && !safeLog.includes('synthetic-clinical-text'), 'outbox log has no patient or clinical details');

// Operation idempotency: replay is a no-op with an opaque operation id.
const operationId = api.makeOperationId_('patient_reschedule', 'synthetic-operation-seed');
const operationStore = {};
let operationRuns = 0;
const firstOperation = api.applyOperationOnce_(operationStore, operationId, () => { operationRuns += 1; return { ok: true }; });
const replayOperation = api.applyOperationOnce_(operationStore, operationId, () => { operationRuns += 1; return { ok: false }; });
check(firstOperation.ok && !firstOperation.replay && replayOperation.replay && operationRuns === 1, 'repeated operation id is replay-safe');
check(!operationId.includes('synthetic-person-label') && !operationId.includes('synthetic-email'), 'operation id contains no PII');

const confirmedRecord = {
  reservation_id: 'fran-nonprod-20260821-reservation-occ',
  idempotency_key: 'fran-nonprod-20260821-123e4567-e89b-42d3-a456-426614174000',
  commerce_order: 'npo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  current_start_at: '2026-08-25T16:00:00.000Z',
};
const confirmKey = api.notificationOccurrenceKey_(confirmedRecord, 'BOOKING_CONFIRMED');
check(confirmKey === api.notificationOccurrenceKey_({ ...confirmedRecord, current_start_at: '2026-08-25T18:00:00.000Z' }, 'BOOKING_CONFIRMED'),
  'BOOKING_CONFIRMED occurrence identity is payment-derived, not snapshot_start_at');
check(confirmKey !== api.notificationOccurrenceKey_({ ...confirmedRecord, commerce_order: 'npo-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, 'BOOKING_CONFIRMED'),
  'a different payment identity is a different BOOKING_CONFIRMED occurrence');

const timeB = '2026-08-25T16:00:00.000Z';
const clinicianFirst = {
  reservation_id: confirmedRecord.reservation_id,
  current_start_at: timeB,
  last_operation_id: api.makeOperationId_('clinician_reconcile_move', 'event-1:etag-1:2026-08-25T16:00:00.000Z'),
};
const clinicianMid = {
  reservation_id: confirmedRecord.reservation_id,
  current_start_at: '2026-08-25T17:00:00.000Z',
  last_operation_id: api.makeOperationId_('clinician_reconcile_move', 'event-1:etag-2:2026-08-25T16:30:00.000Z'),
};
const clinicianBackToB = {
  reservation_id: confirmedRecord.reservation_id,
  current_start_at: timeB,
  last_operation_id: api.makeOperationId_('clinician_reconcile_move', 'event-1:etag-3:2026-08-25T17:00:00.000Z'),
};
const firstOcc = api.notificationOccurrenceKey_(clinicianFirst, 'CLINICIAN_RESCHEDULED');
const thirdOcc = api.notificationOccurrenceKey_(clinicianBackToB, 'CLINICIAN_RESCHEDULED');
check(firstOcc !== thirdOcc && firstOcc !== api.notificationOccurrenceKey_(clinicianMid, 'CLINICIAN_RESCHEDULED'),
  'CLINICIAN_RESCHEDULED back to the same snapshot_start_at is a new occurrence');
check(firstOcc === api.notificationOccurrenceKey_(clinicianFirst, 'CLINICIAN_RESCHEDULED'),
  'same clinician source mutation is a deterministic replay identity');
const occEntries = [
  { reservation_id: confirmedRecord.reservation_id, event_type: 'CLINICIAN_RESCHEDULED', source_operation_id: firstOcc, snapshot_start_at: timeB, state: 'sent' },
];
check(api.findDurableNotificationReplay_(occEntries, confirmedRecord.reservation_id, 'CLINICIAN_RESCHEDULED', firstOcc)
  && !api.findDurableNotificationReplay_(occEntries, confirmedRecord.reservation_id, 'CLINICIAN_RESCHEDULED', thirdOcc),
  'replay lookup is source_operation_id, not snapshot_start_at');
check(!confirmKey.includes('synthetic-email') && !firstOcc.includes('@') && !firstOcc.includes(timeB),
  'occurrence keys are non-PII and do not embed the appointment snapshot');

const eventTypes = ['BOOKING_CONFIRMED', 'PATIENT_RESCHEDULED', 'CLINICIAN_RESCHEDULED', 'PATIENT_CANCELLED',
  'CLINICIAN_CANCELLED', 'REFUND_REQUESTED', 'REFUND_COMPLETED', 'REFUND_FAILED_MANUAL_REVIEW'];
for (const eventType of eventTypes) {
  const opA = api.makeOperationId_(eventType === 'BOOKING_CONFIRMED' ? 'notification' : 'clinician_reconcile_move', eventType + ':op-a');
  const opB = api.makeOperationId_(eventType === 'BOOKING_CONFIRMED' ? 'notification' : 'clinician_reconcile_move', eventType + ':op-b');
  const base = {
    reservation_id: confirmedRecord.reservation_id,
    idempotency_key: confirmedRecord.idempotency_key,
    commerce_order: confirmedRecord.commerce_order,
    current_start_at: timeB,
    calendar_event_id: 'event-1',
    calendar_event_etag: 'etag-x',
    calendar_event_updated_at: '2026-08-25T16:00:00.000Z',
    refund_commerce_order: 'fran-nonprod-refund-aaaaaaaaaaaaaaaaaaaaaaaa',
    refund_provider_reference: 'refund-ref-1',
    last_operation_id: eventType === 'BOOKING_CONFIRMED' ? '' : opA,
  };
  const keyA = api.notificationOccurrenceKey_(base, eventType);
  const replay = api.notificationOccurrenceKey_(base, eventType);
  const other = api.notificationOccurrenceKey_({
    ...base,
    last_operation_id: eventType === 'BOOKING_CONFIRMED' ? '' : opB,
    commerce_order: eventType === 'BOOKING_CONFIRMED' ? 'npo-cccccccccccccccccccccccccccccccccccccccc' : base.commerce_order,
    calendar_event_etag: 'etag-y',
    calendar_event_updated_at: '2026-08-25T17:00:00.000Z',
    refund_provider_reference: 'refund-ref-2',
    refund_commerce_order: 'fran-nonprod-refund-bbbbbbbbbbbbbbbbbbbbbbbb',
    refund_last_error_code: 'PROVIDER_REFUND_FAILED',
  }, eventType);
  check(keyA === replay && keyA !== other && api.validOperationId_(keyA),
    `${eventType} replay is one identity and a later same-type mutation is another`);
}

// Existing payment idempotency primitives remain deterministic and namespaced.
const paymentIdempotencyKey = 'fran-nonprod-20260821-123e4567-e89b-42d3-a456-426614174000';
check(api.validIdempotencyKey_(paymentIdempotencyKey), 'existing payment idempotency key remains valid');
check(!api.validIdempotencyKey_('other-namespace-123e4567-e89b-42d3-a456-426614174000'), 'foreign idempotency namespace rejected');
check(api.makeOpaqueId_('order', paymentIdempotencyKey) === api.makeOpaqueId_('order', paymentIdempotencyKey), 'payment order id remains deterministic for replay');
const flowCommerceOrder = api.makeFlowCommerceOrder_(paymentIdempotencyKey);
check(flowCommerceOrder === api.makeFlowCommerceOrder_(paymentIdempotencyKey)
  && flowCommerceOrder.length <= api.FLOW_COMMERCE_ORDER_MAX_LENGTH
  && /^npo-[0-9a-f]{40}$/i.test(flowCommerceOrder), 'Flow commerceOrder is deterministic and bounded to 45 chars');
check(api.makeCalendarLinkKey_(paymentIdempotencyKey).startsWith('fran-nonprod-20260821-calendar-link-') && !api.makeCalendarLinkKey_(paymentIdempotencyKey).includes('123e4567'), 'Calendar link identifier is opaque');
check(api.formatPatientFacingDateTime_('2026-08-27T17:00:00.000Z') === 'jueves 27 de agosto de 2026, 13:00',
  'Phase A patient-facing time is America/Santiago without raw UTC');
check(api.patientFacingServiceLabel_('initial') === 'Primera sesión / Evaluación'
  && api.patientFacingServiceLabel_('followup') === 'Seguimiento'
  && api.patientFacingModalityLabel_('online') === 'Online'
  && api.patientFacingModalityLabel_('presencial') === 'presencial',
  'patient-facing labels localize known codes without inventing presencial copy');

check(networkCalls === 0 && mailCalls === 0, 'no-network harness made no external calls');
console.log(`NO_NETWORK_TESTS=PASS count=${assertions}`);

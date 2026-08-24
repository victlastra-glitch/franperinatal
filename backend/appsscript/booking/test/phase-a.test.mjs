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
check(api.HEADERS.length === 55, 'schema header count is exact');
check(new Set(api.HEADERS).size === api.HEADERS.length, 'schema has no duplicate headers');
for (const header of [
  'idempotency_key', 'reservation_id', 'original_start_at', 'current_start_at', 'current_end_at',
  'booking_status', 'payment_status', 'refund_status', 'schedule_status', 'status_token_hash',
  'calendar_event_id', 'calendar_event_etag', 'calendar_sync_hash', 'calendar_link_key',
  'meet_url', 'patient_reschedule_count', 'reschedule_capability_hash', 'cancel_capability_hash',
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

// Capabilities: opaque, >=256-bit entropy, hashed at rest, expiring and revocable.
const secret = 'phase-a-test-secret';
const now = Date.parse('2026-08-23T12:00:00.000Z');
const capability = api.createCapability_('RESCHEDULE', {
  secret, now, expiresAt: '2026-08-24T12:00:00.000Z', version: '7',
});
const stored = api.capabilityForStorage_(capability);
check(capability.token.length >= 64, 'capability token has at least 256 bits of encoded entropy');
check(!Object.hasOwn(stored, 'token'), 'stored capability excludes raw token');
check(stored.hash.length === 64 && stored.hash !== capability.token, 'capability is hash-at-rest');
check(!capability.token.includes('reservation') && !capability.token.includes('synthetic-email'), 'capability is not PII-derived');
check(api.verifyCapability_(capability.token, 'RESCHEDULE', stored, { secret, now, version: '7' }), 'valid capability');
check(!api.verifyCapability_(capability.token, 'CANCEL', stored, { secret, now, version: '7' }), 'wrong capability type rejected');
check(!api.verifyCapability_(capability.token, 'RESCHEDULE', stored, { secret, now: Date.parse('2026-08-25T00:00:00.000Z'), version: '7' }), 'expired capability rejected');
check(!api.verifyCapability_(capability.token, 'RESCHEDULE', api.revokeCapability_(stored, '2026-08-23T12:05:00.000Z'), { secret, now, version: '7' }), 'revoked capability rejected');
check(!api.verifyCapability_(capability.token, 'RESCHEDULE', stored, { secret, now, version: '8' }), 'wrong capability version rejected');
check(!api.verifyCapability_('malformed', 'RESCHEDULE', stored, { secret, now, version: '7' }), 'malformed capability rejected');
check(api.constantTimeEqual_('aa', 'aa') && !api.constantTimeEqual_('aa', 'ab'), 'constant-time-ish comparison result');
check(api.capabilityFields_(capability).reschedule_capability_hash === capability.hash, 'reschedule storage fields are explicit');
check(api.capabilityFields_(api.createCapability_('CANCEL', { secret, now, version: '2' })).cancel_capability_version === '2', 'cancel storage fields are explicit');

// One-reschedule invariant: count 0 admits once; count 1 and replay do not.
const rescheduleInput = {
  bookingStatus: 'confirmed', patientRescheduleCount: 0, token: capability.token,
  storedCapability: stored, secret, now, version: '7', nowIso: '2026-08-23T12:00:00.000Z',
};
check(api.canPatientReschedule_(rescheduleInput), 'initial count 0 allows valid capability');
const firstClaim = api.claimPatientReschedule_(rescheduleInput);
check(firstClaim.ok && firstClaim.patient_reschedule_count === 1, 'successful self-reschedule consumes quota');
check(!api.canPatientReschedule_({ ...rescheduleInput, patientRescheduleCount: 1 }), 'count 1 rejects future self-reschedule');
check(!api.canPatientReschedule_({ ...rescheduleInput, token: 'stale-token' }), 'stale capability rejects self-reschedule');

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

// Existing payment idempotency primitives remain deterministic and namespaced.
const paymentIdempotencyKey = 'fran-nonprod-20260821-123e4567-e89b-42d3-a456-426614174000';
check(api.validIdempotencyKey_(paymentIdempotencyKey), 'existing payment idempotency key remains valid');
check(!api.validIdempotencyKey_('other-namespace-123e4567-e89b-42d3-a456-426614174000'), 'foreign idempotency namespace rejected');
check(api.makeOpaqueId_('order', paymentIdempotencyKey) === api.makeOpaqueId_('order', paymentIdempotencyKey), 'payment order id remains deterministic for replay');
const calendarLinkKey = api.makeCalendarLinkKey_(paymentIdempotencyKey);
check(calendarLinkKey.startsWith('fran-nonprod-20260821-calendar-link-') && !calendarLinkKey.includes('123e4567'), 'Calendar link identifier is opaque');

check(networkCalls === 0 && mailCalls === 0, 'no-network harness made no external calls');
console.log(`NO_NETWORK_TESTS=PASS count=${assertions}`);

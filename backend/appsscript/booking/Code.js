/**
 * Isolated NONPROD booking backend.
 * Sanitized derivative informed by the verified production lifecycle.
 * Source and runtime values stay outside Git.
 */
const NONPROD = Object.freeze({
  appEnv: 'nonprod', flowBaseUrl: 'https://sandbox.flow.cl/api', flowHost: 'sandbox.flow.cl',
  bookingStoreFingerprint: '390f55363168', calendarFingerprint: '6c0535f4450c',
  idempotencyNamespace: 'fran-nonprod-20260821', sheetName: 'reservations_nonprod',
  backendVersion: 'nonprod-hardened-20260822', statusTokenTtlMs: 7200000,
});

// Synthetic NONPROD Sandbox amount only. Production clinical prices remain
// unchanged (initial 65000 / followup 60000) and are not used here.
// Flow Chile FAQ: payable amount must be greater than 350 CLP.
var NONPROD_FLOW_TEST_AMOUNT_CLP = 500;

const BASE_PROPERTY_KEYS = Object.freeze([
  'APP_ENV', 'FLOW_API_KEY', 'FLOW_SECRET_KEY', 'FLOW_BASE_URL', 'FLOW_RETURN_URL',
  'FLOW_CONFIRMATION_URL', 'BOOKING_STORE_ID', 'CALENDAR_ID', 'INTERNAL_NOTIFICATION_EMAIL',
  'PATIENT_EMAIL_RECIPIENT_ALLOWLIST', 'IDEMPOTENCY_NAMESPACE', 'STATUS_TOKEN_SECRET',
]);
const CAPABILITY_PROPERTY_KEYS = Object.freeze(['CAPABILITY_TOKEN_SECRET']);
const REFUND_PROPERTY_KEYS = Object.freeze(['FLOW_REFUND_CALLBACK_URL']);
const PROPERTY_KEYS = Object.freeze(BASE_PROPERTY_KEYS.concat(CAPABILITY_PROPERTY_KEYS));
var LIFECYCLE = Object.freeze({
  BOOKING_STATUS: Object.freeze({
    INITIATED: 'initiated', PAYMENT_PENDING: 'payment_pending', CONFIRMED: 'confirmed',
    CANCELLATION_REQUESTED: 'cancellation_requested', CANCELLED: 'cancelled',
    RECONCILIATION_REQUIRED: 'reconciliation_required', MANUAL_REVIEW: 'manual_review',
  }),
  PAYMENT_STATUS: Object.freeze({
    NOT_STARTED: 'not_started', PENDING: 'pending', PAID: 'paid', REJECTED: 'rejected',
    FAILED: 'failed', UNKNOWN: 'unknown',
  }),
  REFUND_STATUS: Object.freeze({
    NOT_REQUIRED: 'not_required', REQUESTED: 'refund_requested', PENDING: 'refund_pending',
    REFUNDED: 'refunded', FAILED: 'refund_failed', MANUAL_REVIEW: 'manual_review',
  }),
  SCHEDULE_STATUS: Object.freeze({
    HOLD: 'hold', SCHEDULED: 'scheduled', CANCELLED: 'cancelled', SYNC_PENDING: 'sync_pending',
    RECONCILIATION_REQUIRED: 'reconciliation_required', MANUAL_REVIEW: 'manual_review',
  }),
  CAPABILITY_TYPE: Object.freeze({ RESCHEDULE: 'RESCHEDULE', CANCEL: 'CANCEL' }),
  OPERATION_TYPE: Object.freeze({
    PATIENT_RESCHEDULE: 'patient_reschedule', PATIENT_CANCEL: 'patient_cancel',
    CLINICIAN_RECONCILE_MOVE: 'clinician_reconcile_move',
    CLINICIAN_RECONCILE_CANCEL: 'clinician_reconcile_cancel', REFUND_CREATE: 'refund_create',
    NOTIFICATION: 'notification',
  }),
  NOTIFICATION_TYPE: Object.freeze({
    BOOKING_CONFIRMED: 'BOOKING_CONFIRMED', PATIENT_RESCHEDULED: 'PATIENT_RESCHEDULED',
    CLINICIAN_RESCHEDULED: 'CLINICIAN_RESCHEDULED', PATIENT_CANCELLED: 'PATIENT_CANCELLED',
    CLINICIAN_CANCELLED: 'CLINICIAN_CANCELLED', REFUND_REQUESTED: 'REFUND_REQUESTED',
    REFUND_COMPLETED: 'REFUND_COMPLETED', REFUND_FAILED_MANUAL_REVIEW: 'REFUND_FAILED_MANUAL_REVIEW',
  }),
});
var RESERVATION_HEADERS = Object.freeze([
  'idempotency_key', 'reservation_id', 'service_type', 'modality', 'patient_email',
  'original_start_at', 'current_start_at', 'current_end_at', 'slot_hold_expires_at',
  'booking_status', 'payment_status', 'refund_status', 'schedule_status', 'payment_url',
  'flow_token', 'commerce_order', 'status_token_hash', 'status_token_expires_at',
  'calendar_event_id', 'calendar_event_etag', 'calendar_event_updated_at', 'calendar_sync_hash',
  'calendar_link_key', 'calendar_change_source', 'schedule_changed_at', 'meet_url',
  'meet_conference_id', 'meet_status', 'patient_reschedule_count', 'reschedule_capability_hash',
  'reschedule_capability_expires_at', 'reschedule_capability_version', 'reschedule_capability_revoked_at',
  'cancel_capability_hash', 'cancel_capability_expires_at', 'cancel_capability_version',
  'cancel_capability_revoked_at', 'cancellation_source', 'cancelled_at',
  'refund_commerce_order', 'refund_provider_reference', 'refund_requested_at', 'refund_completed_at',
  'refund_last_checked_at', 'refund_last_error_code', 'notification_version',
  'notification_outbox_key', 'notification_patient_state', 'notification_internal_state',
  'notification_attempt_count', 'notification_last_attempt_at', 'notification_last_result',
  'last_patient_notification_at', 'reconciliation_state', 'last_operation_id', 'created_at', 'updated_at',
]);
const CREATE_FLOW_FIELDS = Object.freeze([
  'idempotencyKey', 'serviceType', 'modality', 'date', 'time', 'name', 'email', 'phone',
  'patientRut', 'reason', 'message',
]);
var ACTIVE_SLOT_STATES = Object.freeze([
  LIFECYCLE.BOOKING_STATUS.INITIATED,
  LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING,
  LIFECYCLE.BOOKING_STATUS.CONFIRMED,
]);

function doGet(e) {
  try {
    const action = getAction_(e);
    if (action === 'availability') return json_({ ok: true, slots: availability_(e) });
    if (action === 'payment_status') return json_(paymentStatus_(e));
    if (action === 'manage_lookup') return json_(manageLookup_(e));
    if (action === 'manage_availability') return json_({ ok: true, slots: availability_(e) });
    return json_({ ok: false, code: 'NOT_FOUND' });
  } catch (error) { return json_({ ok: false, code: safeCode_(error) }); }
}

function doPost(e) {
  try {
    const action = getAction_(e);
    if (action === 'create_flow_payment') return json_(createFlowPayment_(e));
    if (action === 'flow_confirmation') return json_(flowConfirmation_(e));
    if (action === 'manage_lookup') return json_(manageLookup_(e));
    if (action === 'patient_reschedule') return json_(patientReschedule_(e));
    if (action === 'patient_cancel') return json_(patientCancel_(e));
    if (action === 'refund_confirmation') return json_(refundConfirmation_(e));
    return json_({ ok: false, code: 'NOT_FOUND' });
  } catch (error) { return json_({ ok: false, code: safeCode_(error) }); }
}

function fail_(code) { const error = new Error(code); error.code = code; throw error; }
function safeCode_(error) { const code = String(error && error.code || 'REQUEST_REJECTED'); return /^[A-Z_][A-Z0-9_]{2,63}$/.test(code) ? code : 'REQUEST_REJECTED'; }
function getAction_(e) { return String((e && e.parameter && e.parameter.action) || '').trim(); }
function json_(payload) { return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON); }

function readConfig_() {
  const properties = PropertiesService.getScriptProperties().getProperties();
  BASE_PROPERTY_KEYS.forEach(function(key) { if (!String(properties[key] || '').trim()) fail_('CONFIGURATION_INCOMPLETE'); });
  if (properties.APP_ENV !== NONPROD.appEnv) fail_('CONFIGURATION_INCOMPLETE');
  if (properties.FLOW_BASE_URL !== NONPROD.flowBaseUrl || getHttpsHost_(properties.FLOW_BASE_URL) !== NONPROD.flowHost) fail_('CONFIGURATION_INCOMPLETE');
  if (fingerprint_(properties.BOOKING_STORE_ID) !== NONPROD.bookingStoreFingerprint) fail_('CONFIGURATION_INCOMPLETE');
  if (fingerprint_(properties.CALENDAR_ID) !== NONPROD.calendarFingerprint) fail_('CONFIGURATION_INCOMPLETE');
  if (properties.IDEMPOTENCY_NAMESPACE !== NONPROD.idempotencyNamespace) fail_('CONFIGURATION_INCOMPLETE');
  assertPreviewRoute_(properties.FLOW_RETURN_URL, '/pago-resultado');
  assertPreviewRoute_(properties.FLOW_CONFIRMATION_URL, '/api/flow-confirmation');
  const allowlist = parseAllowlist_(properties.PATIENT_EMAIL_RECIPIENT_ALLOWLIST);
  const internal = String(properties.INTERNAL_NOTIFICATION_EMAIL || '').trim().toLowerCase();
  if (allowlist.length !== 1 || allowlist[0] !== internal || !isTestRecipient_(internal)) fail_('CONFIGURATION_INCOMPLETE');
  return { flowApiKey: properties.FLOW_API_KEY, flowSecretKey: properties.FLOW_SECRET_KEY,
    flowBaseUrl: properties.FLOW_BASE_URL, flowReturnUrl: properties.FLOW_RETURN_URL,
    flowConfirmationUrl: properties.FLOW_CONFIRMATION_URL, bookingStoreId: properties.BOOKING_STORE_ID,
    calendarId: properties.CALENDAR_ID, internalNotificationEmail: internal, patientAllowlist: allowlist,
    idempotencyNamespace: properties.IDEMPOTENCY_NAMESPACE, statusTokenSecret: properties.STATUS_TOKEN_SECRET };
}

// Capability configuration is deliberately lazy-scoped. Availability, payment
// creation, payment confirmation and payment status do not need this secret.
function requireCapabilitySecret_() {
  const properties = PropertiesService.getScriptProperties().getProperties();
  return assertCapabilitySecret_(properties.CAPABILITY_TOKEN_SECRET);
}

function readCapabilityConfig_() {
  const config = readConfig_();
  config.capabilityTokenSecret = requireCapabilitySecret_();
  return config;
}

function readRefundConfig_() {
  const config = readConfig_();
  const properties = PropertiesService.getScriptProperties().getProperties();
  REFUND_PROPERTY_KEYS.forEach(function(key) {
    if (!String(properties[key] || '').trim()) fail_('REFUND_CONFIGURATION_INCOMPLETE');
  });
  assertPreviewRoute_(properties.FLOW_REFUND_CALLBACK_URL, '/api/refund-confirmation');
  config.refundCallbackUrl = properties.FLOW_REFUND_CALLBACK_URL;
  return config;
}

function assertPreviewRoute_(value, requiredPath) {
  const match = previewPagesUrlMatch_(value);
  if (!match || match[2] !== requiredPath) fail_('CONFIGURATION_INCOMPLETE');
}
function previewPagesUrlMatch_(value) {
  return /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+pages\.dev)(\/[^?#]*)?(?:\?([^#]*))?$/i.exec(String(value || ''));
}
function getHttpsHost_(value) { const match = /^https:\/\/([^/:?#]+)(?::\d+)?(?:\/|$)/i.exec(String(value)); return match ? match[1].toLowerCase() : ''; }
function fingerprint_(value) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8).map(function(byte) { return ('0' + (byte & 0xff).toString(16)).slice(-2); }).join('').slice(0, 12); }
function parseAllowlist_(value) { return String(value || '').split(',').map(function(address) { return address.trim().toLowerCase(); }).filter(Boolean); }
function isTestRecipient_(address) { return /^[^\s@]+\+nonprod@[^\s@]+\.[^\s@]+$/i.test(String(address || '')); }
function assertTestRecipient_(address, allowlist) { const normalized = String(address || '').trim().toLowerCase(); if (!isTestRecipient_(normalized) || allowlist.indexOf(normalized) === -1) fail_('RECIPIENT_REJECTED'); return normalized; }

function assertResources_(config) {
  const spreadsheet = SpreadsheetApp.openById(config.bookingStoreId);
  if (spreadsheet.getId() !== config.bookingStoreId || !spreadsheet.getSheetByName(NONPROD.sheetName)) fail_('CONFIGURATION_INCOMPLETE');
  const calendar = CalendarApp.getCalendarById(config.calendarId);
  if (!calendar || calendar.getId() !== config.calendarId) fail_('CONFIGURATION_INCOMPLETE');
  return { spreadsheet: spreadsheet, sheet: spreadsheet.getSheetByName(NONPROD.sheetName), calendar: calendar,
    calendarGateway: createCalendarGateway_({ calendarId: config.calendarId, requestMeet: true }) };
}

// Guarded and idempotent. It is intentionally not invoked during this mission.
function bootstrapNonprodSchema_() {
  const resources = assertResources_(readConfig_());
  if (resources.sheet.getLastRow() === 0) {
    resources.sheet.getRange(1, 1, 1, RESERVATION_HEADERS.length).setValues([RESERVATION_HEADERS]);
    return { ok: true, initialized: true };
  }
  return { ok: true, initialized: false, schema: assertSchema_(resources.sheet).headers.length };
}

function assertSchema_(sheet) {
  if (sheet.getLastRow() === 0) fail_('SCHEMA_NOT_READY');
  if (new Set(RESERVATION_HEADERS).size !== RESERVATION_HEADERS.length) fail_('SCHEMA_MISMATCH');
  if (sheet.getLastColumn() !== RESERVATION_HEADERS.length) fail_('SCHEMA_MISMATCH');
  const actual = sheet.getRange(1, 1, 1, RESERVATION_HEADERS.length).getDisplayValues()[0].map(String);
  if (actual.some(function(value, index) { return value !== RESERVATION_HEADERS[index]; })) fail_('SCHEMA_MISMATCH');
  const columns = {}; RESERVATION_HEADERS.forEach(function(header, index) { columns[header] = index + 1; });
  return { headers: RESERVATION_HEADERS, columns: columns };
}

function availability_(e) {
  const config = readConfig_(); const resources = assertResources_(config); const schema = assertSchema_(resources.sheet);
  const requestedDate = String((e.parameter || {}).date || ''); if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) fail_('REQUEST_REJECTED');
  const bounds = availabilityBounds_(requestedDate);
  let busyIntervals;
  try { busyIntervals = resources.calendarGateway.freeBusy(bounds.start, bounds.end); }
  catch (_) { fail_('CALENDAR_UNAVAILABLE'); }
  const occupied = computeOccupiedSlots_({
    workingSlots: workingSlots_(bounds.start, bounds.end, requestedDate),
    busyIntervals: busyIntervals,
    reservations: reservationRecords_(resources.sheet, schema),
  });
  return occupied.map(function(slot) { return { date: slot.date, time: slot.time }; });
}

function createFlowPayment_(e) {
  const config = readConfig_(); const payload = parseCreatePayload_(e); payload.email = assertTestRecipient_(payload.email, config.patientAllowlist);
  const resources = assertResources_(config); const schema = assertSchema_(resources.sheet); const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) fail_('LOCK_UNAVAILABLE');
  try {
    const existing = findBy_(resources.sheet, schema, 'idempotency_key', payload.idempotencyKey);
    if (existing) return existingBookingResult_(existing);
    const reservation = reserveOnce_(resources.sheet, schema, payload, resources.calendarGateway);
    if (!reservation.ok) return reservation; // SLOT_TAKEN: never contact Flow.
    let flow;
    try { flow = createSandboxFlowPayment_(config, payload, reservation); }
    catch (error) {
      persistFailedFlowCreate_(resources.sheet, schema, reservation, error);
      return { ok: false, code: 'FLOW_CREATE_FAILED' };
    }
    updateRecord_(resources.sheet, schema, reservation.rowNumber, { payment_url: flow.paymentUrl, flow_token: flow.token,
      commerce_order: flow.commerceOrder, status_token_hash: statusTokenHash_(flow.publicStatusToken, config.statusTokenSecret),
      status_token_expires_at: new Date(Date.now() + NONPROD.statusTokenTtlMs).toISOString(),
      payment_status: LIFECYCLE.PAYMENT_STATUS.PENDING, reconciliation_state: '' });
    transitionBooking_(resources.sheet, schema, reservation, LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING);
    return { ok: true, paymentUrl: flow.paymentUrl, publicStatusToken: flow.publicStatusToken };
  } finally { lock.releaseLock(); }
}

function parseCreatePayload_(e) {
  const raw = String((e && e.postData && e.postData.contents) || ''); if (!raw || raw.length > 4096) fail_('REQUEST_REJECTED');
  let candidate; try { candidate = JSON.parse(raw); } catch (_) { fail_('REQUEST_REJECTED'); }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail_('REQUEST_REJECTED');
  if (Object.keys(candidate).some(function(key) { return key !== 'action' && CREATE_FLOW_FIELDS.indexOf(key) === -1; })) fail_('REQUEST_REJECTED');
  if (candidate.action !== 'create_flow_payment') fail_('REQUEST_REJECTED');
  const payload = {}; CREATE_FLOW_FIELDS.forEach(function(key) { payload[key] = String(candidate[key] || '').trim(); });
  if (!validIdempotencyKey_(payload.idempotencyKey)) fail_('IDEMPOTENCY_KEY_REJECTED');
  if (!/^(initial|followup)$/.test(payload.serviceType) || !/^(online|presencial)$/.test(payload.modality)
    || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date) || !/^\d{2}:\d{2}$/.test(payload.time)) fail_('REQUEST_REJECTED');
  if (!payload.name || payload.name.length > 80 || !payload.email || payload.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) fail_('REQUEST_REJECTED');
  ['phone', 'patientRut', 'reason', 'message'].forEach(function(key) { if (payload[key].length > 500) fail_('REQUEST_REJECTED'); });
  return payload;
}
function validIdempotencyKey_(value) { return new RegExp('^' + NONPROD.idempotencyNamespace + '-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'i').test(String(value || '')); }

function assertBookableSlot_(date, time, nowMs) {
  if (WORKING_HOURS.indexOf(String(time || '')) === -1) fail_('REQUEST_REJECTED');
  const requestedStart = startAt_(String(date || ''), String(time || ''));
  const weekday = new Date(String(date) + 'T00:00:00Z').getUTCDay();
  if (weekday === 0 || weekday === 6) fail_('REQUEST_REJECTED');
  const currentMs = nowMs === undefined ? Date.now() : Number(nowMs);
  if (!Number.isFinite(currentMs)) fail_('REQUEST_REJECTED');
  const today = localDateLabel_(new Date(currentMs));
  const lastBookableDate = addCalendarDays_(today, AVAILABILITY_HORIZON_DAYS);
  if (String(date) < today || String(date) > lastBookableDate) fail_('REQUEST_REJECTED');
  if (Date.parse(requestedStart) < currentMs + BOOKING_LEAD_MINUTES * 60000) fail_('REQUEST_REJECTED');
  return requestedStart;
}

function reserveOnce_(sheet, schema, payload, calendarGateway) {
  const requestedStart = assertBookableSlot_(payload.date, payload.time);
  const requestedEnd = new Date(Date.parse(requestedStart) + 3600000).toISOString();
  if (!calendarGateway || typeof calendarGateway.isSlotAvailable !== 'function') fail_('CALENDAR_UNAVAILABLE');
  if (!calendarGateway.isSlotAvailable(requestedStart, requestedEnd, null)) return { ok: false, code: 'SLOT_TAKEN' };
  const taken = reservationRecords_(sheet, schema).some(function(record) {
    return record.current_start_at === requestedStart && ACTIVE_SLOT_STATES.indexOf(record.booking_status) !== -1;
  });
  if (taken) return { ok: false, code: 'SLOT_TAKEN' };
  const now = new Date().toISOString();
  const reservation = { ok: true, idempotency_key: payload.idempotencyKey,
    reservation_id: makeOpaqueId_('reservation', payload.idempotencyKey), service_type: payload.serviceType,
    modality: payload.modality, patient_email: payload.email, original_start_at: requestedStart,
    current_start_at: requestedStart, current_end_at: new Date(Date.parse(requestedStart) + 3600000).toISOString(),
    booking_status: LIFECYCLE.BOOKING_STATUS.INITIATED, payment_status: LIFECYCLE.PAYMENT_STATUS.NOT_STARTED,
    refund_status: LIFECYCLE.REFUND_STATUS.NOT_REQUIRED, schedule_status: LIFECYCLE.SCHEDULE_STATUS.HOLD,
    calendar_link_key: makeCalendarLinkKey_(payload.idempotencyKey),
    patient_reschedule_count: '0', notification_version: '1', created_at: now, updated_at: now };
  sheet.appendRow(RESERVATION_HEADERS.map(function(header) { return reservation[header] || ''; })); reservation.rowNumber = sheet.getLastRow(); return reservation;
}
function existingBookingResult_(record) {
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING && record.payment_url && record.status_token_hash) {
    const config = readConfig_();
    return { ok: true, paymentUrl: record.payment_url, publicStatusToken: makeStatusToken_(record.idempotency_key, config.statusTokenSecret), code: 'IDEMPOTENT_REPLAY' };
  }
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.INITIATED) return { ok: false, code: 'BOOKING_IN_PROGRESS' };
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.FAILED) return { ok: false, code: 'FLOW_CREATE_FAILED' };
  return { ok: false, code: 'BOOKING_NOT_RETRYABLE' };
}

// Flow Sandbox commerceOrder must stay short. The previous namespaced
// makeOpaqueId_('order') form was 52 chars and exceeded the practical
// provider limit observed across Flow client integrations (45).
var FLOW_COMMERCE_ORDER_MAX_LENGTH = 45;
function makeFlowCommerceOrder_(idempotencyKey) {
  if (!validIdempotencyKey_(idempotencyKey)) fail_('IDEMPOTENCY_KEY_REJECTED');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'order:' + String(idempotencyKey), Utilities.Charset.UTF_8)
    .map(function(byte) { return ('0' + (byte & 0xff).toString(16)).slice(-2); }).join('');
  const order = 'npo-' + digest.slice(0, 40);
  if (order.length > FLOW_COMMERCE_ORDER_MAX_LENGTH) fail_('FLOW_ORDER_INVALID');
  return order;
}

function createSandboxFlowPayment_(config, payload, reservation) {
  const commerceOrder = makeFlowCommerceOrder_(payload.idempotencyKey);
  const publicStatusToken = makeStatusToken_(payload.idempotencyKey, config.statusTokenSecret);
  const data = flowRequest_(config, '/payment/create', {
    commerceOrder: commerceOrder,
    subject: 'NONPROD booking',
    currency: 'CLP',
    amount: String(NONPROD_FLOW_TEST_AMOUNT_CLP),
    email: payload.email,
    urlConfirmation: config.flowConfirmationUrl,
    urlReturn: config.flowReturnUrl + '?st=' + encodeURIComponent(publicStatusToken),
  }, 'post');
  if (!data || !String(data.token || '') || !/^https:\/\/sandbox\.flow\.cl\//.test(String(data.url || ''))) {
    failFlow_('FLOW_RESPONSE_SHAPE', { statusClass: '2xx' });
  }
  return {
    token: String(data.token),
    commerceOrder: commerceOrder,
    publicStatusToken: publicStatusToken,
    paymentUrl: String(data.url) + '?token=' + encodeURIComponent(String(data.token)),
  };
}
function makeOpaqueId_(kind, idempotencyKey) { const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, kind + ':' + idempotencyKey, Utilities.Charset.UTF_8).map(function(byte) { return ('0' + (byte & 0xff).toString(16)).slice(-2); }).join(''); return NONPROD.idempotencyNamespace + '-' + kind + '-' + digest.slice(0, 24); }
function makeStatusToken_(idempotencyKey, secret) { return NONPROD.idempotencyNamespace + '-st-' + statusTokenHash_(idempotencyKey, secret).slice(0, 32); }
function statusTokenHash_(token, secret) { return Utilities.computeHmacSha256Signature(String(token), String(secret)).map(function(byte) { return ('0' + ((byte < 0 ? byte + 256 : byte).toString(16))).slice(-2); }).join(''); }

function failFlow_(code, meta) {
  const error = new Error(code || 'FLOW_CREATE_FAILED');
  error.code = code || 'FLOW_CREATE_FAILED';
  if (meta && meta.statusClass) error.statusClass = String(meta.statusClass);
  if (meta && meta.providerCode) error.providerCode = String(meta.providerCode).slice(0, 32);
  throw error;
}

function safeFlowFailureClass_(error) {
  const code = safeCode_(error);
  if (code === 'FLOW_PROVIDER_REJECTED' || code === 'FLOW_PROVIDER_UNAVAILABLE' || code === 'FLOW_NETWORK'
    || code === 'FLOW_BAD_RESPONSE' || code === 'FLOW_RESPONSE_SHAPE' || code === 'FLOW_ORDER_INVALID'
    || code === 'FLOW_VERIFICATION_FAILED' || code === 'CONFIGURATION_INCOMPLETE') return code;
  return 'FLOW_CREATE_FAILED';
}

function safeFlowProviderCode_(error) {
  const value = String(error && error.providerCode || '');
  return /^[A-Za-z0-9_.-]{1,32}$/.test(value) ? value : '';
}

function persistFailedFlowCreate_(sheet, schema, reservation, error) {
  const classification = safeFlowFailureClass_(error);
  const providerCode = safeFlowProviderCode_(error);
  const updates = {
    payment_status: LIFECYCLE.PAYMENT_STATUS.FAILED,
    booking_status: LIFECYCLE.BOOKING_STATUS.MANUAL_REVIEW,
    schedule_status: LIFECYCLE.SCHEDULE_STATUS.CANCELLED,
    reconciliation_state: 'flow_create_' + classification.toLowerCase(),
    refund_last_error_code: providerCode ? ('flow_' + providerCode) : classification,
  };
  updateRecord_(sheet, schema, reservation.rowNumber, updates);
  Object.assign(reservation, updates);
}

// Operator-safe NONPROD cleanup for failed checkout rows. Never deletes.
// Requires payment_failed + manual_review and does not call Flow/Calendar/email.
function abandonFailedNonprodCheckout_(reservationId) {
  const config = readConfig_();
  const resources = assertResources_(config);
  const schema = assertSchema_(resources.sheet);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) fail_('LOCK_UNAVAILABLE');
  try {
    const record = findBy_(resources.sheet, schema, 'reservation_id', String(reservationId || ''));
    if (!record) fail_('REQUEST_REJECTED');
    if (record.payment_status !== LIFECYCLE.PAYMENT_STATUS.FAILED
      || record.booking_status !== LIFECYCLE.BOOKING_STATUS.MANUAL_REVIEW) {
      fail_('BOOKING_NOT_RETRYABLE');
    }
    if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.PAID
      || record.booking_status === LIFECYCLE.BOOKING_STATUS.CONFIRMED) fail_('BOOKING_NOT_RETRYABLE');
    updateRecord_(resources.sheet, schema, record.rowNumber, {
      booking_status: LIFECYCLE.BOOKING_STATUS.CANCELLED,
      schedule_status: LIFECYCLE.SCHEDULE_STATUS.CANCELLED,
      reconciliation_state: 'flow_create_abandoned',
      cancellation_source: 'operator_nonprod',
      cancelled_at: new Date().toISOString(),
    });
    return { ok: true, reservationId: record.reservation_id, status: 'abandoned' };
  } finally { lock.releaseLock(); }
}

function flowRequest_(config, endpoint, params, method) {
  if (config.flowBaseUrl !== NONPROD.flowBaseUrl || getHttpsHost_(config.flowBaseUrl) !== NONPROD.flowHost) fail_('CONFIGURATION_INCOMPLETE');
  if (['/payment/create', '/payment/getStatus'].indexOf(endpoint) === -1 || ['get', 'post'].indexOf(method) === -1) fail_('REQUEST_REJECTED');
  const signed = {};
  Object.keys(params || {}).forEach(function(key) {
    if (params[key] === null || params[key] === undefined) return;
    signed[key] = String(params[key]);
  });
  signed.apiKey = String(config.flowApiKey);
  signed.s = signFlowParams_(signed, config.flowSecretKey);
  const encoded = Object.keys(signed).sort().map(function(key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(signed[key]);
  }).join('&');
  const options = { method: method, muteHttpExceptions: true };
  let url = config.flowBaseUrl + endpoint;
  if (method === 'get') url += '?' + encoded;
  else { options.contentType = 'application/x-www-form-urlencoded'; options.payload = encoded; }
  let response;
  try { response = UrlFetchApp.fetch(url, options); }
  catch (_) { failFlow_('FLOW_NETWORK', { statusClass: 'network' }); }
  const status = response.getResponseCode();
  const statusClass = status >= 500 ? '5xx' : (status >= 400 ? '4xx' : (status >= 200 && status < 300 ? '2xx' : 'other'));
  let bodyText = '';
  try { bodyText = String(response.getContentText() || ''); } catch (_) { bodyText = ''; }
  let data = null;
  if (bodyText) {
    try { data = JSON.parse(bodyText); } catch (_) { data = null; }
  }
  if (status < 200 || status >= 300) {
    const providerCode = data && (data.code != null || data.errorCode != null)
      ? String(data.code != null ? data.code : data.errorCode) : '';
    failFlow_(statusClass === '4xx' ? 'FLOW_PROVIDER_REJECTED' : (statusClass === '5xx' ? 'FLOW_PROVIDER_UNAVAILABLE' : 'FLOW_VERIFICATION_FAILED'),
      { statusClass: statusClass, providerCode: providerCode });
  }
  if (!data || typeof data !== 'object') failFlow_('FLOW_BAD_RESPONSE', { statusClass: statusClass });
  return data;
}
function signFlowParams_(params, secretKey) {
  const toSign = Object.keys(params).sort().reduce(function(value, key) {
    return params[key] === null || params[key] === undefined ? value : value + key + String(params[key]);
  }, '');
  return Utilities.computeHmacSha256Signature(toSign, secretKey).map(function(byte) {
    return ('0' + ((byte < 0 ? byte + 256 : byte).toString(16))).slice(-2);
  }).join('');
}

function flowConfirmation_(e) {
  const config = readConfig_(); const callbackToken = parseCallbackToken_(e); const resources = assertResources_(config); const schema = assertSchema_(resources.sheet); const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) fail_('LOCK_UNAVAILABLE');
  try {
    const status = flowRequest_(config, '/payment/getStatus', { token: callbackToken }, 'get'); const commerceOrder = String(status && status.commerceOrder || '');
    if (!validCommerceOrder_(commerceOrder)) fail_('FLOW_VERIFICATION_FAILED');
    const record = findBy_(resources.sheet, schema, 'commerce_order', commerceOrder); if (!record || record.flow_token !== callbackToken) fail_('FLOW_VERIFICATION_FAILED');
    const next = stateForFlowStatus_(status.status);
    if (next === LIFECYCLE.PAYMENT_STATUS.PENDING) {
      transitionPayment_(resources.sheet, schema, record, next);
      return { ok: true, status: 'payment_pending' };
    }
    if (next === LIFECYCLE.PAYMENT_STATUS.REJECTED || next === LIFECYCLE.PAYMENT_STATUS.FAILED) {
      transitionPayment_(resources.sheet, schema, record, next);
      if (record.booking_status === LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING) {
        transitionBooking_(resources.sheet, schema, record, LIFECYCLE.BOOKING_STATUS.MANUAL_REVIEW);
      }
      return { ok: true, status: next === LIFECYCLE.PAYMENT_STATUS.REJECTED ? 'payment_rejected' : 'payment_failed' };
    }
    if (next !== LIFECYCLE.PAYMENT_STATUS.PAID) fail_('FLOW_VERIFICATION_FAILED');
    transitionPayment_(resources.sheet, schema, record, next);
    if (record.booking_status === LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING) {
      transitionBooking_(resources.sheet, schema, record, LIFECYCLE.BOOKING_STATUS.CONFIRMED);
    } else if (record.booking_status !== LIFECYCLE.BOOKING_STATUS.CONFIRMED) fail_('INVALID_STATE_TRANSITION');
    applyConfirmedSideEffects_(resources, schema, config, findBy_(resources.sheet, schema, 'commerce_order', commerceOrder)); return { ok: true, status: 'payment_confirmed' };
  } finally { lock.releaseLock(); }
}
function parseCallbackToken_(e) { const direct = String((e && e.parameter && e.parameter.token) || '').trim(); const raw = String((e && e.postData && e.postData.contents) || ''); if (raw.length > 1024) fail_('REQUEST_REJECTED'); const parsed = raw ? parseForm_(raw) : {}; const token = direct || String(parsed.token || '').trim(); if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) fail_('REQUEST_REJECTED'); return token; }
function parseForm_(raw) { return raw.split('&').reduce(function(result, part) { const pieces = part.split('='); if (pieces.length !== 2 || !pieces[0]) fail_('REQUEST_REJECTED'); const key = decodeURIComponent(pieces[0].replace(/\+/g, ' ')); if (key !== 'token' || Object.prototype.hasOwnProperty.call(result, key)) fail_('REQUEST_REJECTED'); result[key] = decodeURIComponent(pieces[1].replace(/\+/g, ' ')); return result; }, {}); }
function validCommerceOrder_(value) { return /^npo-[0-9a-f]{40}$/i.test(String(value || '')); }
function stateForFlowStatus_(value) { const status = Number(value); if (status === 2) return LIFECYCLE.PAYMENT_STATUS.PAID; if (status === 1) return LIFECYCLE.PAYMENT_STATUS.PENDING; if (status === 3 || status === 4) return LIFECYCLE.PAYMENT_STATUS.REJECTED; return LIFECYCLE.PAYMENT_STATUS.FAILED; }

function applyConfirmedSideEffects_(resources, schema, config, record) {
  if (!record || record.booking_status !== LIFECYCLE.BOOKING_STATUS.CONFIRMED || record.payment_status !== LIFECYCLE.PAYMENT_STATUS.PAID) fail_('INVALID_STATE_TRANSITION');
  const current = findBy_(resources.sheet, schema, 'idempotency_key', record.idempotency_key);
  if (current.schedule_status === LIFECYCLE.SCHEDULE_STATUS.HOLD || current.schedule_status === LIFECYCLE.SCHEDULE_STATUS.SYNC_PENDING) {
    updateRecord_(resources.sheet, schema, current.rowNumber, { schedule_status: LIFECYCLE.SCHEDULE_STATUS.SYNC_PENDING });
    try {
      const event = resources.calendarGateway.createLinkedBookingEvent(current);
      const fields = calendarEventFields_(event);
      fields.schedule_status = LIFECYCLE.SCHEDULE_STATUS.SCHEDULED;
      updateRecord_(resources.sheet, schema, current.rowNumber, fields);
    } catch (_) {
      updateRecord_(resources.sheet, schema, current.rowNumber, {
        schedule_status: LIFECYCLE.SCHEDULE_STATUS.RECONCILIATION_REQUIRED,
        reconciliation_state: 'calendar_create_retry',
      });
    }
  }
  const refreshed = findBy_(resources.sheet, schema, 'idempotency_key', record.idempotency_key);
  const capabilityIssue = ensureManagementCapabilities_(resources.sheet, schema, refreshed);
  const afterCapabilities = findBy_(resources.sheet, schema, 'idempotency_key', record.idempotency_key);
  enqueueLifecycleNotification_(resources.sheet, schema, afterCapabilities, LIFECYCLE.NOTIFICATION_TYPE.BOOKING_CONFIRMED,
    capabilityIssue && capabilityIssue.tokens);
}

function ensureManagementCapabilities_(sheet, schema, record) {
  if (!record || record.booking_status !== LIFECYCLE.BOOKING_STATUS.CONFIRMED) return null;
  if (record.reschedule_capability_hash && record.cancel_capability_hash) return null;
  try {
    const secret = requireCapabilitySecret_(); const now = Date.now();
    const reschedule = createCapability_(LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE, { secret: secret, now: now });
    const cancel = createCapability_(LIFECYCLE.CAPABILITY_TYPE.CANCEL, { secret: secret, now: now });
    updateRecord_(sheet, schema, record.rowNumber, Object.assign({}, capabilityFields_(reschedule), capabilityFields_(cancel)));
    return { tokens: { RESCHEDULE: reschedule.token, CANCEL: cancel.token } };
  } catch (_) {
    updateRecord_(sheet, schema, record.rowNumber, { reconciliation_state: 'capability_configuration_required' });
    return { tokens: null };
  }
}
function bookingBounds_(startAt) { const start = new Date(String(startAt)); if (Number.isNaN(start.getTime())) fail_('REQUEST_REJECTED'); return { start: start, end: new Date(start.getTime() + 3600000) }; }
function startAt_(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) fail_('REQUEST_REJECTED');
  const parts = String(date).split('-').map(Number); const clock = String(time).split(':').map(Number);
  const naiveUtc = Date.UTC(parts[0], parts[1] - 1, parts[2], clock[0], clock[1], 0);
  if (Number.isNaN(naiveUtc)) fail_('REQUEST_REJECTED');
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    let candidate = naiveUtc;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const local = {}; formatter.formatToParts(new Date(candidate)).forEach(function(part) { if (part.type !== 'literal') local[part.type] = Number(part.value); });
      const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
      const next = naiveUtc - (localAsUtc - candidate);
      if (next === candidate) {
        const verified = {}; formatter.formatToParts(new Date(next)).forEach(function(part) { if (part.type !== 'literal') verified[part.type] = Number(part.value); });
        if (verified.year !== parts[0] || verified.month !== parts[1] || verified.day !== parts[2]
          || verified.hour !== clock[0] || verified.minute !== clock[1]) fail_('REQUEST_REJECTED');
        return new Date(next).toISOString();
      }
      candidate = next;
    }
    fail_('REQUEST_REJECTED');
  } catch (error) {
    if (error && error.code === 'REQUEST_REJECTED') throw error;
    fail_('TIMEZONE_UNAVAILABLE');
  }
}
function paymentStatus_(e) {
  const config = readConfig_(); const resources = assertResources_(config); const schema = assertSchema_(resources.sheet); const token = String((e && e.parameter && e.parameter.st) || '').trim();
  if (!validStatusToken_(token)) fail_('STATUS_TOKEN_REJECTED'); const record = findBy_(resources.sheet, schema, 'status_token_hash', statusTokenHash_(token, config.statusTokenSecret));
  if (!record || !record.status_token_expires_at || Date.parse(record.status_token_expires_at) < Date.now()) fail_('STATUS_TOKEN_REJECTED');
  return { ok: true, status: publicStatus_(record), amount: NONPROD_FLOW_TEST_AMOUNT_CLP, currency: 'CLP', serviceType: record.service_type, modality: record.modality, backendVersion: NONPROD.backendVersion };
}
function validStatusToken_(value) { return new RegExp('^' + NONPROD.idempotencyNamespace + '-st-[0-9a-f]{32}$', 'i').test(value); }
function publicStatus_(record) {
  if (!record || !record.payment_status) return 'payment_failed';
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.PAID) return 'payment_confirmed';
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.PENDING) return 'payment_pending';
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.REJECTED) return 'payment_rejected';
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.FAILED) return 'payment_failed';
  return record.booking_status === LIFECYCLE.BOOKING_STATUS.INITIATED ? 'booking_started' : 'payment_failed';
}

function reservationRecords_(sheet, schema) { return sheet.getDataRange().getValues().slice(1).map(function(row, index) { return recordFromRow_(row, schema, index + 2); }); }
function findBy_(sheet, schema, field, value) { return reservationRecords_(sheet, schema).find(function(record) { return record[field] === value; }) || null; }
function recordFromRow_(row, schema, rowNumber) { const record = { rowNumber: rowNumber }; RESERVATION_HEADERS.forEach(function(header) { record[header] = row[schema.columns[header] - 1] == null ? '' : String(row[schema.columns[header] - 1]); }); return record; }
function updateRecord_(sheet, schema, rowNumber, updates) { Object.keys(updates).forEach(function(field) { if (!Object.prototype.hasOwnProperty.call(schema.columns, field)) fail_('SCHEMA_MISMATCH'); sheet.getRange(rowNumber, schema.columns[field]).setValue(updates[field]); }); sheet.getRange(rowNumber, schema.columns.updated_at).setValue(new Date().toISOString()); }

function calendarEventFields_(event) {
  return {
    calendar_event_id: String(event && event.id || ''),
    calendar_event_etag: String(event && event.etag || ''),
    calendar_event_updated_at: String(event && event.updated || ''),
    calendar_sync_hash: String(event && event.syncHash || ''),
    meet_url: String(event && event.meetUrl || ''),
    meet_conference_id: String(event && event.meetConferenceId || ''),
    meet_status: String(event && event.meetStatus || 'not_requested'),
  };
}

function sheetReservationStore_(resources, schema) {
  return {
    loadByReservationId: function(id) { return findBy_(resources.sheet, schema, 'reservation_id', String(id)); },
    loadByCalendarEventId: function(id) { return findBy_(resources.sheet, schema, 'calendar_event_id', String(id)); },
    loadByCalendarLinkKey: function(linkKey) { return findBy_(resources.sheet, schema, 'calendar_link_key', String(linkKey)); },
    loadByCapability: function(token, type, secret) {
      const capability = capabilityHashForToken_(token, type, secret);
      const field = type === LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE ? 'reschedule_capability_hash' : 'cancel_capability_hash';
      return findBy_(resources.sheet, schema, field, capability.hash);
    },
    update: function(record, updates) {
      updateRecord_(resources.sheet, schema, record.rowNumber, updates);
      return findBy_(resources.sheet, schema, 'reservation_id', record.reservation_id);
    },
    records: function() { return reservationRecords_(resources.sheet, schema); },
  };
}

function capabilityHashForToken_(token, type, secret) {
  return { hash: hashCapabilityToken_(String(token || ''), secret, type) };
}

function manageLookup_(e) {
  const token = managementToken_(e); const config = readCapabilityConfig_();
  const resources = assertResources_(config); const schema = assertSchema_(resources.sheet); const store = sheetReservationStore_(resources, schema);
  const cancel = store.loadByCapability(token, LIFECYCLE.CAPABILITY_TYPE.CANCEL, config.capabilityTokenSecret);
  const found = cancel || store.loadByCapability(token, LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE, config.capabilityTokenSecret);
  const capabilityType = cancel ? LIFECYCLE.CAPABILITY_TYPE.CANCEL : (found ? LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE : '');
  if (!found || !managementTokenValidForRecord_(token, found, config.capabilityTokenSecret)) fail_('CAPABILITY_INVALID');
  return publicManagementRecord_(found, capabilityType);
}

function managementToken_(e) {
  const raw = String((e && e.postData && e.postData.contents) || '');
  if (raw.length > 2048) fail_('REQUEST_REJECTED');
  let payload; try { payload = raw ? JSON.parse(raw) : e.parameter || {}; } catch (_) { fail_('REQUEST_REJECTED'); }
  const token = String(payload.token || '').trim();
  if (!/^[A-Za-z0-9_-]{64,256}$/.test(token)) fail_('CAPABILITY_INVALID');
  return token;
}

function managementTokenValidForRecord_(token, record, secret) {
  return verifyCapability_(token, LIFECYCLE.CAPABILITY_TYPE.CANCEL, capabilityFromRecord_(record, LIFECYCLE.CAPABILITY_TYPE.CANCEL), { secret: secret })
    || verifyCapability_(token, LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE, capabilityFromRecord_(record, LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE), { secret: secret });
}

function publicManagementRecord_(record, capabilityType) {
  return { ok: true, status: publicManagementStatus_(record), date: String(record.current_start_at).slice(0, 10),
    time: String(record.current_start_at).slice(11, 16), serviceType: record.service_type, modality: record.modality,
    originalStart: record.original_start_at, currentStart: record.current_start_at, currentEnd: record.current_end_at,
    meetUrl: record.meet_url || '', capabilityType: capabilityType || '' };
}

function publicManagementStatus_(record) {
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.CANCELLED) return 'cancelled';
  if (String(record.patient_reschedule_count) === '1') return 'rescheduled';
  return 'active';
}

function patientReschedule_(e) {
  const token = managementToken_(e); const payload = JSON.parse(String(e.postData.contents));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.fecha || '')) || !/^\d{2}:\d{2}$/.test(String(payload.hora || ''))) fail_('REQUEST_REJECTED');
  const config = readCapabilityConfig_(); const resources = assertResources_(config); const schema = assertSchema_(resources.sheet);
  const store = sheetReservationStore_(resources, schema); const record = store.loadByCapability(token, LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE, config.capabilityTokenSecret);
  if (!record) fail_('CAPABILITY_INVALID');
  return patientRescheduleTransaction_({ reservationId: record.reservation_id, token: token, targetStartAt: startAt_(payload.fecha, payload.hora),
    now: Date.now(), deps: { store: store, calendar: resources.calendarGateway, requireCapabilitySecret_: function() { return config.capabilityTokenSecret; },
      enqueueNotification: function(updated) { enqueueLifecycleNotification_(resources.sheet, schema, updated, LIFECYCLE.NOTIFICATION_TYPE.PATIENT_RESCHEDULED); } } });
}

function patientCancel_(e) {
  const token = managementToken_(e); const config = readCapabilityConfig_(); const resources = assertResources_(config); const schema = assertSchema_(resources.sheet);
  const store = sheetReservationStore_(resources, schema); const record = store.loadByCapability(token, LIFECYCLE.CAPABILITY_TYPE.CANCEL, config.capabilityTokenSecret);
  if (!record) fail_('CAPABILITY_INVALID');
  return patientCancelTransaction_({ reservationId: record.reservation_id, token: token, now: Date.now(), deps: { store: store, calendar: resources.calendarGateway,
    requireCapabilitySecret_: function() { return config.capabilityTokenSecret; }, policyEvaluator: refundPolicy_,
    enqueueNotification: function(updated) { enqueueLifecycleNotification_(resources.sheet, schema, updated, LIFECYCLE.NOTIFICATION_TYPE.PATIENT_CANCELLED); },
    enqueueRefund: function(updated) { enqueueLifecycleNotification_(resources.sheet, schema, updated, LIFECYCLE.NOTIFICATION_TYPE.REFUND_REQUESTED); } } });
}

function refundConfirmation_(e) {
  const config = readRefundConfig_(); const token = String((e && e.parameter && e.parameter.token) || '').trim();
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) fail_('REFUND_CALLBACK_INVALID');
  const resources = assertResources_(config); const schema = assertSchema_(resources.sheet); const store = sheetReservationStore_(resources, schema);
  const record = findBy_(resources.sheet, schema, 'refund_provider_reference', token);
  if (!record) fail_('REFUND_CALLBACK_INVALID');
  const gateway = createFlowRefundGateway_({ baseUrl: config.flowBaseUrl, apiKey: config.flowApiKey, secretKey: config.flowSecretKey });
  return refundCallbackOnce_({ store: store, record: record, gateway: gateway, token: token });
}

function refundPolicy_() { return { decision: 'BUSINESS_POLICY_TBD', eligible: false }; }

function enqueueLifecycleNotification_(sheet, schema, record, type, capabilityTokens) {
  const notification = makeLifecycleNotification_(type, record, { now: new Date().toISOString() });
  if (capabilityTokens) notification.capabilityTokens = capabilityTokens;
  const stateField = notification.ctas.length ? 'notification_patient_state' : 'notification_internal_state';
  if (record[stateField] === 'sent' || record[stateField] === 'claimed') return notification;
  updateRecord_(sheet, schema, record.rowNumber, { notification_outbox_key: notification.logicalKey, notification_version: notification.version,
    [stateField]: 'pending', notification_last_result: notification.eventType });
  return notification;
}

function previewOriginFromConfig_(config) {
  const match = previewPagesUrlMatch_(config && config.flowReturnUrl);
  if (!match) fail_('CONFIGURATION_INCOMPLETE');
  return 'https://' + match[1].toLowerCase();
}

function managementPageUrl_(origin, token, open) {
  const base = String(origin || '').replace(/\/$/, '');
  const match = previewPagesUrlMatch_(base);
  if (!match || match[2] || match[3]) fail_('CONFIGURATION_INCOMPLETE');
  if (!/^[A-Za-z0-9_-]{64,256}$/.test(String(token || ''))) fail_('CAPABILITY_INVALID');
  let url = base + '/manage.html?token=' + encodeURIComponent(String(token));
  if (open === 'reschedule' || open === 'cancel') url += '&open=' + open;
  return url;
}

function lifecycleNotificationSubject_(eventType) {
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.BOOKING_CONFIRMED) return 'Confirmación de tu sesión';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_RESCHEDULED || eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED) {
    return 'Tu sesión fue reagendada';
  }
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_CANCELLED || eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_CANCELLED) {
    return 'Tu sesión fue cancelada';
  }
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_REQUESTED) return 'Solicitud de reembolso en curso';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_COMPLETED) return 'Reembolso completado';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW) return 'Reembolso en revisión manual';
  return 'Actualización de tu reserva';
}

function renderLifecycleNotificationEmail_(input) {
  if (!input || !input.notification || !input.record || !input.previewOrigin) fail_('NOTIFICATION_RENDER_INVALID');
  const notification = input.notification;
  const record = input.record;
  const tokens = input.capabilityTokens || {};
  const lines = ['Hola,', '', 'Te escribimos con una actualización operativa de tu reserva.'];
  lines.push('Servicio: ' + String(record.service_type || ''));
  lines.push('Modalidad: ' + String(record.modality || ''));
  lines.push('Fecha y hora: ' + String(record.current_start_at || ''));
  if (notification.meet && notification.meet.meetUrl) lines.push('Meet: ' + String(notification.meet.meetUrl));
  if (tokens.RESCHEDULE) {
    lines.push('Reagendar: ' + managementPageUrl_(input.previewOrigin, tokens.RESCHEDULE, 'reschedule'));
  }
  if (tokens.CANCEL) {
    lines.push('Cancelar: ' + managementPageUrl_(input.previewOrigin, tokens.CANCEL, 'cancel'));
  }
  lines.push('', 'Francisca Bustos — Psicología Perinatal');
  return { subject: lifecycleNotificationSubject_(notification.eventType), body: lines.join('\n') };
}

// NONPROD-only delivery adapter. Recipient must match allowlist + +nonprod policy.
// No CC/BCC. Raw capability tokens may appear only in the ephemeral email body.
function deliverLifecycleNotification_(input) {
  if (!input || !input.config) fail_('CONFIGURATION_INCOMPLETE');
  const to = assertTestRecipient_(input.to, input.config.patientAllowlist);
  const subject = String(input.subject || '');
  const body = String(input.body || '');
  if (!subject || !body) fail_('NOTIFICATION_RENDER_INVALID');
  MailApp.sendEmail({ to: to, subject: subject, body: body, name: 'Francisca Bustos' });
  return { ok: true };
}

function notificationOutboxEntryFromRecord_(record, stateField) {
  return {
    key: String(record.notification_outbox_key || ''),
    version: String(record.notification_version || '1'),
    state: String(record[stateField] || ''),
    attemptCount: Number(record.notification_attempt_count || 0) || 0,
    lastAttemptAt: record.notification_last_attempt_at || null,
    lastResult: record.notification_last_result || null,
    claimedAt: null,
  };
}

function persistNotificationOutboxRecord_(deps, record, fields) {
  if (deps && deps.store && typeof deps.store.update === 'function') {
    return deps.store.update(record, fields) || Object.assign(record, fields);
  }
  updateRecord_(deps.sheet, deps.schema, record.rowNumber, fields);
  return Object.assign(record, fields);
}

function notificationWorkerResultSafe_(result) {
  return {
    ok: Boolean(result && result.ok),
    code: result && result.code ? String(result.code) : '',
    reservationId: result && result.reservationId ? String(result.reservationId) : '',
    eventType: result && result.eventType ? String(result.eventType) : '',
    state: result && result.state ? String(result.state) : '',
    attemptCount: Number(result && result.attemptCount || 0) || 0,
  };
}

function processOneLifecycleNotificationOutbox_(deps) {
  const record = deps.record;
  const stateField = deps.stateField;
  const nowIso = new Date(Number(deps.now || Date.now())).toISOString();
  const reservationId = String(record.reservation_id || '');
  const attempts = Number(record.notification_attempt_count || 0) || 0;
  const eventType = reconstructLifecycleEventType_(record);
  if (!eventType) {
    persistNotificationOutboxRecord_(deps, record, {
      reconciliation_state: 'notification_event_type_invalid',
      notification_last_result: 'event_type_invalid',
      notification_last_attempt_at: nowIso,
    });
    return { ok: false, code: 'NOTIFICATION_EVENT_TYPE_INVALID', reservationId: reservationId, state: record[stateField], attemptCount: attempts };
  }
  if (attempts >= MAX_NOTIFICATION_ATTEMPTS) {
    persistNotificationOutboxRecord_(deps, record, {
      reconciliation_state: 'notification_max_attempts',
      notification_last_result: 'max_attempts',
      notification_last_attempt_at: nowIso,
    });
    return { ok: false, code: 'NOTIFICATION_MAX_ATTEMPTS', reservationId: reservationId, eventType: eventType,
      state: record[stateField], attemptCount: attempts };
  }

  const entry = notificationOutboxEntryFromRecord_(record, stateField);
  const claim = claimNotificationOutbox_(entry, nowIso);
  if (!claim.ok) {
    return { ok: false, code: claim.code || 'NOTIFICATION_CLAIM_REJECTED', reservationId: reservationId, eventType: eventType,
      state: entry.state, attemptCount: entry.attemptCount };
  }
  persistNotificationOutboxRecord_(deps, record, {
    [stateField]: entry.state,
    notification_attempt_count: String(entry.attemptCount),
    notification_last_attempt_at: entry.lastAttemptAt,
    notification_last_result: 'claimed',
  });

  let capabilityTokens = {};
  let notification;
  try {
    const retry = retryLifecycleNotification_({
      store: deps.store,
      reservationId: reservationId,
      eventType: eventType,
      now: deps.now || Date.now(),
      lock: deps.lock,
      requireCapabilitySecret_: deps.requireCapabilitySecret_ || requireCapabilitySecret_,
    });
    if (!retry || !retry.ok) {
      completeNotificationOutbox_(entry, { ok: false });
      persistNotificationOutboxRecord_(deps, record, {
        [stateField]: entry.state,
        notification_attempt_count: String(entry.attemptCount),
        notification_last_attempt_at: nowIso,
        notification_last_result: 'failed',
      });
      return { ok: false, code: (retry && retry.code) || 'NOTIFICATION_RETRY_FAILED', reservationId: reservationId,
        eventType: eventType, state: entry.state, attemptCount: entry.attemptCount };
    }
    notification = retry.notification;
    capabilityTokens = retry.capabilityTokens || {};
    if (retry.record) Object.assign(record, retry.record);
  } catch (error) {
    completeNotificationOutbox_(entry, { ok: false });
    persistNotificationOutboxRecord_(deps, record, {
      [stateField]: entry.state,
      notification_attempt_count: String(entry.attemptCount),
      notification_last_attempt_at: nowIso,
      notification_last_result: 'failed',
    });
    return { ok: false, code: safeCode_(error), reservationId: reservationId, eventType: eventType,
      state: entry.state, attemptCount: entry.attemptCount };
  }

  const previewOrigin = previewOriginFromConfig_(deps.config);
  const rendered = renderLifecycleNotificationEmail_({
    notification: notification, record: record, capabilityTokens: capabilityTokens, previewOrigin: previewOrigin,
  });
  const deliver = deps.deliver || deliverLifecycleNotification_;
  let delivered = false;
  try {
    const delivery = deliver({
      config: deps.config,
      to: record.patient_email,
      subject: rendered.subject,
      body: rendered.body,
    });
    delivered = Boolean(delivery && delivery.ok);
  } catch (error) {
    delivered = false;
    completeNotificationOutbox_(entry, { ok: false });
    const failedFields = {
      [stateField]: entry.state,
      notification_attempt_count: String(entry.attemptCount),
      notification_last_attempt_at: nowIso,
      notification_last_result: 'failed',
    };
    if (entry.attemptCount >= MAX_NOTIFICATION_ATTEMPTS) {
      failedFields.reconciliation_state = 'notification_max_attempts';
      failedFields.notification_last_result = 'max_attempts';
    }
    persistNotificationOutboxRecord_(deps, record, failedFields);
    return { ok: false, code: safeCode_(error) === 'REQUEST_REJECTED' ? 'NOTIFICATION_DELIVERY_FAILED' : safeCode_(error),
      reservationId: reservationId, eventType: eventType, state: entry.state, attemptCount: entry.attemptCount };
  }

  completeNotificationOutbox_(entry, { ok: delivered });
  if (delivered) {
    const sentFields = {
      [stateField]: entry.state,
      notification_attempt_count: String(entry.attemptCount),
      notification_last_attempt_at: nowIso,
      notification_last_result: 'sent',
    };
    if (stateField === 'notification_patient_state') sentFields.last_patient_notification_at = nowIso;
    persistNotificationOutboxRecord_(deps, record, sentFields);
    return { ok: true, code: 'SENT', reservationId: reservationId, eventType: eventType,
      state: entry.state, attemptCount: entry.attemptCount };
  }

  const failedFields = {
    [stateField]: entry.state,
    notification_attempt_count: String(entry.attemptCount),
    notification_last_attempt_at: nowIso,
    notification_last_result: 'failed',
  };
  if (entry.attemptCount >= MAX_NOTIFICATION_ATTEMPTS) {
    failedFields.reconciliation_state = 'notification_max_attempts';
    failedFields.notification_last_result = 'max_attempts';
  }
  persistNotificationOutboxRecord_(deps, record, failedFields);
  return { ok: false, code: 'NOTIFICATION_DELIVERY_FAILED', reservationId: reservationId, eventType: eventType,
    state: entry.state, attemptCount: entry.attemptCount };
}

// Time-driven NONPROD outbox worker. Source only: do not install/run in this mission.
function processLifecycleNotificationOutbox_(opt) {
  const deps = opt || {};
  const config = deps.config || readCapabilityConfig_();
  const lock = deps.lock || LockService.getScriptLock();
  if (!lock || !lock.tryLock(Number(deps.lockTimeoutMs || 10000))) fail_('LOCK_UNAVAILABLE');
  try {
    const resources = deps.resources || assertResources_(config);
    const schema = deps.schema || assertSchema_(resources.sheet);
    const store = deps.store || sheetReservationStore_(resources, schema);
    const batch = selectRetryableNotificationWork_(
      typeof store.records === 'function' ? store.records() : [],
      deps.batchSize || MAX_NOTIFICATION_OUTBOX_BATCH
    );
    const results = [];
    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i];
      try {
        results.push(processOneLifecycleNotificationOutbox_({
          record: item.record,
          stateField: item.stateField,
          store: store,
          sheet: resources && resources.sheet,
          schema: schema,
          config: config,
          lock: lock,
          now: deps.now,
          deliver: deps.deliver,
          requireCapabilitySecret_: deps.requireCapabilitySecret_ || requireCapabilitySecret_,
        }));
      } catch (error) {
        const code = safeCode_(error);
        if (code === 'CONFIGURATION_INCOMPLETE' || code === 'SCHEMA_MISMATCH' || code === 'SCHEMA_NOT_READY'
          || code === 'LOCK_UNAVAILABLE' || code === 'CAPABILITY_SECRET_INVALID') {
          throw error;
        }
        results.push({
          ok: false, code: code, reservationId: String(item.record && item.record.reservation_id || ''),
          state: String(item.record && item.record[item.stateField] || ''), attemptCount: Number(item.record && item.record.notification_attempt_count || 0) || 0,
        });
      }
    }
    return { ok: true, processed: results.length, results: results.map(notificationWorkerResultSafe_) };
  } finally {
    lock.releaseLock();
  }
}

var NONPROD_NOTIFICATION_RETRY_HANDLER = 'processLifecycleNotificationOutbox_';
var NONPROD_NOTIFICATION_RETRY_INTERVAL_MINUTES = 5;
var NONPROD_CALENDAR_RECONCILIATION_HANDLER = 'processCalendarReconciliation_';
var NONPROD_CALENDAR_RECONCILIATION_INTERVAL_MINUTES = 5;
var NONPROD_CALENDAR_SYNC_TOKEN_PROPERTY = 'NONPROD_CALENDAR_NEXT_SYNC_TOKEN';

function matchingProjectTriggers_(handler) {
  return ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === handler;
  });
}

function installTimeTriggerExactlyOnce_(handler, intervalMinutes) {
  const existing = matchingProjectTriggers_(handler);
  existing.slice(1).forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  if (existing.length) return { ok: true, created: false, handler: handler, intervalMinutes: intervalMinutes };
  ScriptApp.newTrigger(handler).timeBased().everyMinutes(intervalMinutes).create();
  return { ok: true, created: true, handler: handler, intervalMinutes: intervalMinutes };
}

function processCalendarReconciliation_() {
  const config = readConfig_();
  const resources = assertResources_(config);
  const schema = assertSchema_(resources.sheet);
  const store = sheetReservationStore_(resources, schema);
  const properties = PropertiesService.getScriptProperties();
  const syncState = {
    get: function() { return String(properties.getProperty(NONPROD_CALENDAR_SYNC_TOKEN_PROPERTY) || ''); },
    set: function(token) { properties.setProperty(NONPROD_CALENDAR_SYNC_TOKEN_PROPERTY, String(token)); },
  };
  const bounds = availabilityBounds_('');
  return reconcileCalendarSync_({
    gateway: resources.calendarGateway,
    syncState: syncState,
    store: store,
    bounds: bounds,
    lock: LockService.getScriptLock(),
    policyEvaluator: refundPolicy_,
    enqueueNotification: function(updated) {
      const eventType = updated.schedule_status === LIFECYCLE.SCHEDULE_STATUS.CANCELLED
        ? LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_CANCELLED
        : LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED;
      enqueueLifecycleNotification_(resources.sheet, schema, updated, eventType);
    },
  });
}

function installNonprodCalendarReconciliationTrigger_() {
  readConfig_();
  return installTimeTriggerExactlyOnce_(NONPROD_CALENDAR_RECONCILIATION_HANDLER,
    NONPROD_CALENDAR_RECONCILIATION_INTERVAL_MINUTES);
}

function removeNonprodCalendarReconciliationTrigger_() {
  const handler = NONPROD_CALENDAR_RECONCILIATION_HANDLER;
  const triggers = matchingProjectTriggers_(handler);
  triggers.forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  return { ok: true, handler: handler, removed: triggers.length };
}

// IDEMPOTENT installer. Runtime execution is restricted by readConfig_.
function installNonprodNotificationRetryTrigger_() {
  readConfig_();
  return installTimeTriggerExactlyOnce_(NONPROD_NOTIFICATION_RETRY_HANDLER,
    NONPROD_NOTIFICATION_RETRY_INTERVAL_MINUTES);
}

function removeNonprodNotificationRetryTrigger_() {
  const handler = NONPROD_NOTIFICATION_RETRY_HANDLER;
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  });
  return { ok: true, handler: handler, removed: removed };
}

function nonprodRefundAmountClp_() {
  return String(NONPROD_FLOW_TEST_AMOUNT_CLP);
}

var __FLOW_PAYMENT_TEST_EXPORTS__ = Object.freeze({
  createFlowPayment_: createFlowPayment_,
  createSandboxFlowPayment_: createSandboxFlowPayment_,
  flowRequest_: flowRequest_,
  signFlowParams_: signFlowParams_,
  makeFlowCommerceOrder_: makeFlowCommerceOrder_,
  validCommerceOrder_: validCommerceOrder_,
  persistFailedFlowCreate_: persistFailedFlowCreate_,
  abandonFailedNonprodCheckout_: abandonFailedNonprodCheckout_,
  safeFlowFailureClass_: safeFlowFailureClass_,
  existingBookingResult_: existingBookingResult_,
  FLOW_COMMERCE_ORDER_MAX_LENGTH: FLOW_COMMERCE_ORDER_MAX_LENGTH,
  NONPROD_FLOW_TEST_AMOUNT_CLP: NONPROD_FLOW_TEST_AMOUNT_CLP,
  nonprodRefundAmountClp_: nonprodRefundAmountClp_,
  paymentStatus_: paymentStatus_,
});

var __NOTIFICATION_OUTBOX_TEST_EXPORTS__ = Object.freeze({
  processLifecycleNotificationOutbox_: processLifecycleNotificationOutbox_,
  processOneLifecycleNotificationOutbox_: processOneLifecycleNotificationOutbox_,
  deliverLifecycleNotification_: deliverLifecycleNotification_,
  renderLifecycleNotificationEmail_: renderLifecycleNotificationEmail_,
  previewOriginFromConfig_: previewOriginFromConfig_,
  managementPageUrl_: managementPageUrl_,
  installNonprodNotificationRetryTrigger_: installNonprodNotificationRetryTrigger_,
  removeNonprodNotificationRetryTrigger_: removeNonprodNotificationRetryTrigger_,
  installNonprodCalendarReconciliationTrigger_: installNonprodCalendarReconciliationTrigger_,
  removeNonprodCalendarReconciliationTrigger_: removeNonprodCalendarReconciliationTrigger_,
  notificationWorkerResultSafe_: notificationWorkerResultSafe_,
  NONPROD_CALENDAR_RECONCILIATION_HANDLER: NONPROD_CALENDAR_RECONCILIATION_HANDLER,
  NONPROD_CALENDAR_RECONCILIATION_INTERVAL_MINUTES: NONPROD_CALENDAR_RECONCILIATION_INTERVAL_MINUTES,
  NONPROD_CALENDAR_SYNC_TOKEN_PROPERTY: NONPROD_CALENDAR_SYNC_TOKEN_PROPERTY,
  NONPROD_NOTIFICATION_RETRY_HANDLER: NONPROD_NOTIFICATION_RETRY_HANDLER,
  NONPROD_NOTIFICATION_RETRY_INTERVAL_MINUTES: NONPROD_NOTIFICATION_RETRY_INTERVAL_MINUTES,
  assertTestRecipient_: assertTestRecipient_,
  isTestRecipient_: isTestRecipient_,
  enqueueLifecycleNotification_: enqueueLifecycleNotification_,
  abandonFailedNonprodCheckout_: abandonFailedNonprodCheckout_,
});

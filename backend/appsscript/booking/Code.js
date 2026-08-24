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

const PROPERTY_KEYS = Object.freeze([
  'APP_ENV', 'FLOW_API_KEY', 'FLOW_SECRET_KEY', 'FLOW_BASE_URL', 'FLOW_RETURN_URL',
  'FLOW_CONFIRMATION_URL', 'BOOKING_STORE_ID', 'CALENDAR_ID', 'INTERNAL_NOTIFICATION_EMAIL',
  'PATIENT_EMAIL_RECIPIENT_ALLOWLIST', 'IDEMPOTENCY_NAMESPACE', 'STATUS_TOKEN_SECRET',
  'CAPABILITY_TOKEN_SECRET',
]);
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
    return json_({ ok: false, code: 'NOT_FOUND' });
  } catch (error) { return json_({ ok: false, code: safeCode_(error) }); }
}

function doPost(e) {
  try {
    const action = getAction_(e);
    if (action === 'create_flow_payment') return json_(createFlowPayment_(e));
    if (action === 'flow_confirmation') return json_(flowConfirmation_(e));
    return json_({ ok: false, code: 'NOT_FOUND' });
  } catch (error) { return json_({ ok: false, code: safeCode_(error) }); }
}

function fail_(code) { const error = new Error(code); error.code = code; throw error; }
function safeCode_(error) { const code = String(error && error.code || 'REQUEST_REJECTED'); return /^[A-Z_]{3,64}$/.test(code) ? code : 'REQUEST_REJECTED'; }
function getAction_(e) { return String((e && e.parameter && e.parameter.action) || '').trim(); }
function json_(payload) { return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON); }

function readConfig_() {
  const properties = PropertiesService.getScriptProperties().getProperties();
  PROPERTY_KEYS.forEach(function(key) { if (!String(properties[key] || '').trim()) fail_('CONFIGURATION_INCOMPLETE'); });
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
    idempotencyNamespace: properties.IDEMPOTENCY_NAMESPACE, statusTokenSecret: properties.STATUS_TOKEN_SECRET,
    capabilityTokenSecret: properties.CAPABILITY_TOKEN_SECRET };
}

function assertPreviewRoute_(value, requiredPath) {
  const match = /^https:\/\/([a-z0-9-]+\.pages\.dev)(\/[^?#]*)?(?:\?[^#]*)?$/i.exec(String(value || ''));
  if (!match || match[2] !== requiredPath) fail_('CONFIGURATION_INCOMPLETE');
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
  return { spreadsheet: spreadsheet, sheet: spreadsheet.getSheetByName(NONPROD.sheetName), calendar: calendar };
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
  const resources = assertResources_(readConfig_()); const schema = assertSchema_(resources.sheet);
  const requestedDate = String((e.parameter || {}).date || ''); if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) fail_('REQUEST_REJECTED');
  return reservationRecords_(resources.sheet, schema).filter(function(record) {
    return ACTIVE_SLOT_STATES.indexOf(record.booking_status) !== -1
      && (!requestedDate || String(record.current_start_at).slice(0, 10) === requestedDate);
  }).map(function(record) {
    return { date: String(record.current_start_at).slice(0, 10), time: String(record.current_start_at).slice(11, 16) };
  });
}

function createFlowPayment_(e) {
  const config = readConfig_(); const payload = parseCreatePayload_(e); payload.email = assertTestRecipient_(payload.email, config.patientAllowlist);
  const resources = assertResources_(config); const schema = assertSchema_(resources.sheet); const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) fail_('LOCK_UNAVAILABLE');
  try {
    const existing = findBy_(resources.sheet, schema, 'idempotency_key', payload.idempotencyKey);
    if (existing) return existingBookingResult_(existing);
    const reservation = reserveOnce_(resources.sheet, schema, payload);
    if (!reservation.ok) return reservation; // SLOT_TAKEN: never contact Flow.
    let flow;
    try { flow = createSandboxFlowPayment_(config, payload, reservation); }
    catch (_) {
      transitionPayment_(resources.sheet, schema, reservation, LIFECYCLE.PAYMENT_STATUS.FAILED);
      transitionBooking_(resources.sheet, schema, reservation, LIFECYCLE.BOOKING_STATUS.MANUAL_REVIEW);
      return { ok: false, code: 'FLOW_CREATE_FAILED' };
    }
    updateRecord_(resources.sheet, schema, reservation.rowNumber, { payment_url: flow.paymentUrl, flow_token: flow.token,
      commerce_order: flow.commerceOrder, status_token_hash: statusTokenHash_(flow.publicStatusToken, config.statusTokenSecret),
      status_token_expires_at: new Date(Date.now() + NONPROD.statusTokenTtlMs).toISOString(),
      payment_status: LIFECYCLE.PAYMENT_STATUS.PENDING });
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
  if (!/^(initial|followup)$/.test(payload.serviceType) || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date) || !/^\d{2}:\d{2}$/.test(payload.time)) fail_('REQUEST_REJECTED');
  if (!payload.name || payload.name.length > 80 || !payload.email || payload.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) fail_('REQUEST_REJECTED');
  ['modality', 'phone', 'patientRut', 'reason', 'message'].forEach(function(key) { if (payload[key].length > 500) fail_('REQUEST_REJECTED'); });
  return payload;
}
function validIdempotencyKey_(value) { return new RegExp('^' + NONPROD.idempotencyNamespace + '-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'i').test(String(value || '')); }

function reserveOnce_(sheet, schema, payload) {
  const requestedStart = startAt_(payload.date, payload.time);
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

function createSandboxFlowPayment_(config, payload, reservation) {
  const commerceOrder = makeOpaqueId_('order', payload.idempotencyKey); const publicStatusToken = makeStatusToken_(payload.idempotencyKey, config.statusTokenSecret);
  const data = flowRequest_(config, '/payment/create', { commerceOrder: commerceOrder, subject: 'NONPROD booking', currency: 'CLP', amount: 1,
    email: payload.email, urlConfirmation: config.flowConfirmationUrl, urlReturn: config.flowReturnUrl + '?st=' + encodeURIComponent(publicStatusToken),
    optional: JSON.stringify({ environment: NONPROD.appEnv, reservation: reservation.reservation_id }) }, 'post');
  if (!data || !String(data.token || '') || !/^https:\/\/sandbox\.flow\.cl\//.test(String(data.url || ''))) fail_('FLOW_CREATE_FAILED');
  return { token: String(data.token), commerceOrder: commerceOrder, publicStatusToken: publicStatusToken, paymentUrl: String(data.url) + '?token=' + encodeURIComponent(String(data.token)) };
}
function makeOpaqueId_(kind, idempotencyKey) { const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, kind + ':' + idempotencyKey, Utilities.Charset.UTF_8).map(function(byte) { return ('0' + (byte & 0xff).toString(16)).slice(-2); }).join(''); return NONPROD.idempotencyNamespace + '-' + kind + '-' + digest.slice(0, 24); }
function makeStatusToken_(idempotencyKey, secret) { return NONPROD.idempotencyNamespace + '-st-' + statusTokenHash_(idempotencyKey, secret).slice(0, 32); }
function statusTokenHash_(token, secret) { return Utilities.computeHmacSha256Signature(String(token), String(secret)).map(function(byte) { return ('0' + ((byte < 0 ? byte + 256 : byte).toString(16))).slice(-2); }).join(''); }

function flowRequest_(config, endpoint, params, method) {
  if (config.flowBaseUrl !== NONPROD.flowBaseUrl || getHttpsHost_(config.flowBaseUrl) !== NONPROD.flowHost) fail_('CONFIGURATION_INCOMPLETE');
  if (['/payment/create', '/payment/getStatus'].indexOf(endpoint) === -1 || ['get', 'post'].indexOf(method) === -1) fail_('REQUEST_REJECTED');
  const signed = {}; Object.keys(params).forEach(function(key) { signed[key] = params[key]; }); signed.apiKey = config.flowApiKey; signed.s = signFlowParams_(signed, config.flowSecretKey);
  const encoded = Object.keys(signed).map(function(key) { return encodeURIComponent(key) + '=' + encodeURIComponent(signed[key]); }).join('&');
  const options = { method: method, muteHttpExceptions: true }; let url = config.flowBaseUrl + endpoint;
  if (method === 'get') url += '?' + encoded; else { options.contentType = 'application/x-www-form-urlencoded'; options.payload = encoded; }
  const response = UrlFetchApp.fetch(url, options); if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) fail_('FLOW_VERIFICATION_FAILED');
  try { return JSON.parse(response.getContentText()); } catch (_) { fail_('FLOW_VERIFICATION_FAILED'); }
}
function signFlowParams_(params, secretKey) { const toSign = Object.keys(params).sort().reduce(function(value, key) { return params[key] === null || params[key] === undefined ? value : value + key + params[key]; }, ''); return Utilities.computeHmacSha256Signature(toSign, secretKey).map(function(byte) { return ('0' + ((byte < 0 ? byte + 256 : byte).toString(16))).slice(-2); }).join(''); }

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
function validCommerceOrder_(value) { return new RegExp('^' + NONPROD.idempotencyNamespace + '-order-[0-9a-f]{24}$', 'i').test(value); }
function stateForFlowStatus_(value) { const status = Number(value); if (status === 2) return LIFECYCLE.PAYMENT_STATUS.PAID; if (status === 1) return LIFECYCLE.PAYMENT_STATUS.PENDING; if (status === 3 || status === 4) return LIFECYCLE.PAYMENT_STATUS.REJECTED; return LIFECYCLE.PAYMENT_STATUS.FAILED; }

function applyConfirmedSideEffects_(resources, schema, config, record) {
  if (!record || record.booking_status !== LIFECYCLE.BOOKING_STATUS.CONFIRMED || record.payment_status !== LIFECYCLE.PAYMENT_STATUS.PAID) fail_('INVALID_STATE_TRANSITION');
  const current = findBy_(resources.sheet, schema, 'idempotency_key', record.idempotency_key);
  if (current.schedule_status === LIFECYCLE.SCHEDULE_STATUS.HOLD || current.schedule_status === LIFECYCLE.SCHEDULE_STATUS.SYNC_PENDING) {
    updateRecord_(resources.sheet, schema, current.rowNumber, { schedule_status: LIFECYCLE.SCHEDULE_STATUS.SYNC_PENDING }); const bounds = bookingBounds_(current.current_start_at);
    const event = resources.calendar.createEvent('NONPROD confirmed booking', bounds.start, bounds.end);
    updateRecord_(resources.sheet, schema, current.rowNumber, { calendar_event_id: event.getId(), schedule_status: LIFECYCLE.SCHEDULE_STATUS.SCHEDULED });
  }
  const refreshed = findBy_(resources.sheet, schema, 'idempotency_key', record.idempotency_key);
  sendOnce_(resources.sheet, schema, config, refreshed, 'notification_patient_state', refreshed.patient_email, 'NONPROD booking confirmed');
  sendOnce_(resources.sheet, schema, config, refreshed, 'notification_internal_state', config.internalNotificationEmail, 'NONPROD booking confirmed');
}
function bookingBounds_(startAt) { const start = new Date(String(startAt)); if (Number.isNaN(start.getTime())) fail_('REQUEST_REJECTED'); return { start: start, end: new Date(start.getTime() + 3600000) }; }
function startAt_(date, time) { if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) fail_('REQUEST_REJECTED'); const start = new Date(date + 'T' + time + ':00-04:00'); if (Number.isNaN(start.getTime())) fail_('REQUEST_REJECTED'); return start.toISOString(); }
function sendOnce_(sheet, schema, config, record, stateField, recipient, subject) {
  assertTestRecipient_(recipient, config.patientAllowlist);
  if (record[stateField] !== '') return;
  const claim = {}; claim[stateField] = 'claimed'; claim.notification_outbox_key = makeNotificationLogicalKey_(record, stateField);
  claim.notification_version = '1'; claim.notification_attempt_count = String(Number(record.notification_attempt_count || 0) + 1);
  claim.notification_last_attempt_at = new Date().toISOString(); updateRecord_(sheet, schema, record.rowNumber, claim);
  MailApp.sendEmail({ to: recipient, subject: subject, body: 'NONPROD confirmed booking.' });
  const sent = {}; sent[stateField] = 'sent'; sent.notification_last_result = 'sent';
  if (stateField === 'notification_patient_state') sent.last_patient_notification_at = new Date().toISOString();
  updateRecord_(sheet, schema, record.rowNumber, sent);
}

function paymentStatus_(e) {
  const config = readConfig_(); const resources = assertResources_(config); const schema = assertSchema_(resources.sheet); const token = String((e && e.parameter && e.parameter.st) || '').trim();
  if (!validStatusToken_(token)) fail_('STATUS_TOKEN_REJECTED'); const record = findBy_(resources.sheet, schema, 'status_token_hash', statusTokenHash_(token, config.statusTokenSecret));
  if (!record || !record.status_token_expires_at || Date.parse(record.status_token_expires_at) < Date.now()) fail_('STATUS_TOKEN_REJECTED');
  return { ok: true, status: publicStatus_(record), amount: 1, currency: 'CLP', serviceType: record.service_type, modality: record.modality, backendVersion: NONPROD.backendVersion };
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

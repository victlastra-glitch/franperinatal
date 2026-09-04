/**
 * Production booking backend.
 * Selective lifecycle V2 port onto live Production Apps Script v7 contracts.
 * Runtime secrets stay in Script Properties. They are not in Git.
 */
const PRODUCTION = Object.freeze({
  appEnv: 'production', flowBaseUrl: 'https://www.flow.cl/api', flowHost: 'www.flow.cl',
  publicHost: 'franciscabustos.cl',
  idempotencyNamespace: 'fran-booking',
  sheetName: 'Respuestas de formulario 1',
  equivalentSheetNames: Object.freeze(['reservations']),
  notificationOutboxSheetName: 'notification_outbox',
  backendVersion: 'production-lifecycle-v2-20260831', statusTokenTtlMs: 7200000,
});
var SCHEMA_MIGRATION_STRATEGY = 'APPEND_ONLY_V7_COMPATIBILITY';
var NEW_PRODUCTION_PROPERTY_NAMES = Object.freeze([
  'APP_ENV', 'FLOW_CONFIRMATION_URL', 'INTERNAL_NOTIFICATION_EMAIL',
  'STATUS_TOKEN_SECRET', 'CAPABILITY_TOKEN_SECRET', 'FLOW_REFUND_CALLBACK_URL',
]);
var V7_FLOW_HEADERS = Object.freeze([
  'commerceOrder', 'flowOrder', 'flowToken', 'priceClp', 'paidAt',
  'rawFlowStatus', 'serviceType', 'patientRut', 'paymentUrl', 'publicStatusToken',
  'calendarCreated', 'emailPatientSent', 'emailInternalSent',
  'emailPatientSentAt', 'emailInternalSentAt', 'paymentExpiresAt', 'reviewReason',
]);
var V7_POSITIONAL_CANONICAL = Object.freeze([
  'timestamp', 'phone', 'email', 'service', 'modality', 'date', 'time', 'message',
  'reservationId', 'name', 'googleMeetLink', 'calendarEventId', 'manageToken',
  'status', 'cancelledAt', 'replacedByReservationId',
]);
var V7_HEADER_ALIASES = Object.freeze({
  timestamp: Object.freeze(['timestamp', 'marca temporal', 'marca_temporal', 'fecha creacion', 'fecha_creacion', 'createdat', 'created at']),
  phone: Object.freeze(['phone', 'telefono', 'tel', 'celular']),
  email: Object.freeze(['email', 'correo', 'correo electronico', 'mail', 'e-mail']),
  service: Object.freeze(['service', 'servicio', 'tipo servicio', 'tipo de servicio']),
  modality: Object.freeze(['modality', 'modalidad']),
  date: Object.freeze(['date', 'fecha']),
  time: Object.freeze(['time', 'hora']),
  message: Object.freeze(['message', 'motivo', 'reason', 'motivo de consulta', 'mensaje']),
  reservationId: Object.freeze(['reservationid', 'reservation_id', 'id reserva', 'id_reserva', 'reserva id', 'idreserva']),
  name: Object.freeze(['name', 'nombre', 'nombre completo', 'nombre paciente']),
  googleMeetLink: Object.freeze(['googlemeetlink', 'google meet link', 'meet link', 'meet_url', 'enlace meet']),
  calendarEventId: Object.freeze(['calendareventid', 'calendar event id', 'calendar_event_id', 'event id', 'id evento']),
  manageToken: Object.freeze(['managetoken', 'manage_token', 'columna 1', 'token gestion', 'token de gestion']),
  status: Object.freeze(['status', 'estado']),
  cancelledAt: Object.freeze(['cancelledat', 'cancelled_at', 'cancelado', 'fecha cancelacion']),
  replacedByReservationId: Object.freeze(['replacedbyreservationid', 'replaced_by_reservation_id', 'reemplazado por']),
  patientRut: Object.freeze(['patientrut', 'patient_rut', 'rut', 'rut paciente']),
});
var V7_TO_V2_FIELD = Object.freeze({
  reservationId: 'reservation_id',
  email: 'patient_email',
  service: 'service_type',
  serviceType: 'service_type',
  modality: 'modality',
  googleMeetLink: 'meet_url',
  calendarEventId: 'calendar_event_id',
  cancelledAt: 'cancelled_at',
  commerceOrder: 'commerce_order',
  flowToken: 'flow_token',
  paymentUrl: 'payment_url',
  paymentExpiresAt: 'slot_hold_expires_at',
});
var V2_TO_V7_WRITE = Object.freeze({
  reservation_id: Object.freeze(['reservationId']),
  patient_email: Object.freeze(['email']),
  service_type: Object.freeze(['service', 'serviceType']),
  modality: Object.freeze(['modality']),
  meet_url: Object.freeze(['googleMeetLink']),
  calendar_event_id: Object.freeze(['calendarEventId']),
  cancelled_at: Object.freeze(['cancelledAt']),
  commerce_order: Object.freeze(['commerceOrder']),
  flow_token: Object.freeze(['flowToken']),
  payment_url: Object.freeze(['paymentUrl']),
  slot_hold_expires_at: Object.freeze(['paymentExpiresAt']),
  booking_status: Object.freeze(['status']),
});
var V7_STATUS = Object.freeze({
  ACTIVE: 'active',
  CANCELLED: 'cancelled',
  RESCHEDULED: 'rescheduled',
  PENDING_PAYMENT: 'pending_payment',
  PAID_CONFIRMED: 'paid_confirmed',
  PAYMENT_REJECTED: 'payment_rejected',
  PAYMENT_REVIEW: 'payment_review_required',
});

var INITIAL_PRICE_CLP = 50000;
var FOLLOWUP_PRICE_CLP = 50000;

const BASE_PROPERTY_KEYS = Object.freeze([
  'APP_ENV', 'FLOW_API_KEY', 'FLOW_SECRET_KEY', 'FLOW_BASE_URL', 'FLOW_RETURN_URL',
  'FLOW_CONFIRMATION_URL', 'CALENDAR_ID', 'INTERNAL_NOTIFICATION_EMAIL',
  'IDEMPOTENCY_NAMESPACE', 'STATUS_TOKEN_SECRET',
]);
const CAPABILITY_PROPERTY_KEYS = Object.freeze(['CAPABILITY_TOKEN_SECRET']);
const REFUND_PROPERTY_KEYS = Object.freeze(['FLOW_REFUND_CALLBACK_URL']);
const PROPERTY_KEYS = Object.freeze(BASE_PROPERTY_KEYS.concat(CAPABILITY_PROPERTY_KEYS));
var LIFECYCLE = Object.freeze({
  BOOKING_STATUS: Object.freeze({
    INITIATED: 'initiated', PAYMENT_PENDING: 'payment_pending', CONFIRMED: 'confirmed',
    CANCELLATION_REQUESTED: 'cancellation_requested', CANCELLED: 'cancelled', EXPIRED: 'expired',
    RECONCILIATION_REQUIRED: 'reconciliation_required', MANUAL_REVIEW: 'manual_review',
  }),
  PAYMENT_STATUS: Object.freeze({
    NOT_STARTED: 'not_started', PENDING: 'pending', PAID: 'paid', REJECTED: 'rejected',
    FAILED: 'failed', UNKNOWN: 'unknown', EXPIRED: 'expired', ANNULLED: 'annulled',
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
    CLINICIAN_CANCELLED: 'CLINICIAN_CANCELLED', SESSION_CANCELLED: 'SESSION_CANCELLED',
    REFUND_REQUESTED: 'REFUND_REQUESTED',
    REFUND_COMPLETED: 'REFUND_COMPLETED', REFUND_FAILED_MANUAL_REVIEW: 'REFUND_FAILED_MANUAL_REVIEW',
  }),
});
var FLOW_PROVIDER_PAYMENT_STATUS = Object.freeze({
  1: 'pending_payment',
  2: 'paid',
  3: 'rejected',
  4: 'annulled',
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
var NOTIFICATION_OUTBOX_HEADERS = Object.freeze([
  'logical_key', 'reservation_id', 'event_type', 'notification_version', 'state',
  'attempt_count', 'created_at', 'last_attempt_at', 'last_result', 'disposition_reason',
  'snapshot_service_type', 'snapshot_modality', 'snapshot_start_at', 'snapshot_end_at',
  'snapshot_meet_url', 'snapshot_meet_status', 'snapshot_booking_status', 'snapshot_schedule_status',
  'snapshot_patient_reschedule_count', 'source_operation_id',
]);
var NOTIFICATION_OUTBOX_RETRYABLE_STATES = Object.freeze(['pending', 'failed', 'claimed']);
var NOTIFICATION_OUTBOX_TERMINAL_STATES = Object.freeze(['sent', 'superseded']);
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
    if (action === 'retry_flow_payment') return json_(retryFlowPayment_(e));
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

function pickScriptProperty_(properties, canonical, aliases) {
  const primary = String(properties[canonical] || '').trim();
  if (primary) return primary;
  const names = aliases || [];
  for (let i = 0; i < names.length; i += 1) {
    const value = String(properties[names[i]] || '').trim();
    if (value) return value;
  }
  return '';
}

function resolvedScriptProperties_(properties) {
  const source = properties || {};
  return {
    APP_ENV: pickScriptProperty_(source, 'APP_ENV', []),
    FLOW_API_KEY: pickScriptProperty_(source, 'FLOW_API_KEY', []),
    FLOW_SECRET_KEY: pickScriptProperty_(source, 'FLOW_SECRET_KEY', []),
    FLOW_BASE_URL: pickScriptProperty_(source, 'FLOW_BASE_URL', []),
    FLOW_RETURN_URL: pickScriptProperty_(source, 'FLOW_RETURN_URL', ['PUBLIC_RETURN_URL']),
    FLOW_CONFIRMATION_URL: pickScriptProperty_(source, 'FLOW_CONFIRMATION_URL', []),
    CALENDAR_ID: pickScriptProperty_(source, 'CALENDAR_ID', []),
    INTERNAL_NOTIFICATION_EMAIL: pickScriptProperty_(source, 'INTERNAL_NOTIFICATION_EMAIL', []),
    IDEMPOTENCY_NAMESPACE: pickScriptProperty_(source, 'IDEMPOTENCY_NAMESPACE', []) || PRODUCTION.idempotencyNamespace,
    STATUS_TOKEN_SECRET: pickScriptProperty_(source, 'STATUS_TOKEN_SECRET', []),
    BOOKING_STORE_ID: pickScriptProperty_(source, 'BOOKING_STORE_ID', ['SHEET_ID']),
    CAPABILITY_TOKEN_SECRET: pickScriptProperty_(source, 'CAPABILITY_TOKEN_SECRET', []),
    FLOW_REFUND_CALLBACK_URL: pickScriptProperty_(source, 'FLOW_REFUND_CALLBACK_URL', []),
  };
}

function readConfig_() {
  const raw = PropertiesService.getScriptProperties().getProperties();
  const properties = resolvedScriptProperties_(raw);
  ['APP_ENV', 'FLOW_API_KEY', 'FLOW_SECRET_KEY', 'FLOW_BASE_URL', 'FLOW_RETURN_URL',
    'FLOW_CONFIRMATION_URL', 'CALENDAR_ID', 'INTERNAL_NOTIFICATION_EMAIL',
    'STATUS_TOKEN_SECRET'].forEach(function(key) {
    if (!String(properties[key] || '').trim()) fail_('CONFIGURATION_INCOMPLETE');
  });
  if (!properties.BOOKING_STORE_ID) fail_('CONFIGURATION_INCOMPLETE');
  if (properties.APP_ENV !== PRODUCTION.appEnv) fail_('CONFIGURATION_INCOMPLETE');
  if (/sandbox\.flow\.cl/i.test(String(properties.FLOW_BASE_URL || ''))) fail_('CONFIGURATION_INCOMPLETE');
  if (properties.FLOW_BASE_URL !== PRODUCTION.flowBaseUrl || getHttpsHost_(properties.FLOW_BASE_URL) !== PRODUCTION.flowHost) fail_('CONFIGURATION_INCOMPLETE');
  if (/nonprod|sandbox/i.test(String(properties.IDEMPOTENCY_NAMESPACE || ''))) fail_('CONFIGURATION_INCOMPLETE');
  if (properties.IDEMPOTENCY_NAMESPACE !== PRODUCTION.idempotencyNamespace) fail_('CONFIGURATION_INCOMPLETE');
  assertProductionRoute_(properties.FLOW_RETURN_URL, '/pago-resultado');
  assertProductionRoute_(properties.FLOW_CONFIRMATION_URL, '/api/flow-confirmation');
  const internal = assertPatientEmail_(properties.INTERNAL_NOTIFICATION_EMAIL);
  return { flowApiKey: properties.FLOW_API_KEY, flowSecretKey: properties.FLOW_SECRET_KEY,
    flowBaseUrl: properties.FLOW_BASE_URL, flowReturnUrl: properties.FLOW_RETURN_URL,
    flowConfirmationUrl: properties.FLOW_CONFIRMATION_URL, bookingStoreId: properties.BOOKING_STORE_ID,
    calendarId: properties.CALENDAR_ID, internalNotificationEmail: internal,
    idempotencyNamespace: properties.IDEMPOTENCY_NAMESPACE, statusTokenSecret: properties.STATUS_TOKEN_SECRET };
}

// Capability configuration is deliberately lazy-scoped. Availability, payment
// creation, payment confirmation and payment status do not need this secret.
function requireCapabilitySecret_() {
  const properties = resolvedScriptProperties_(PropertiesService.getScriptProperties().getProperties());
  return assertCapabilitySecret_(properties.CAPABILITY_TOKEN_SECRET);
}

function readCapabilityConfig_() {
  const config = readConfig_();
  config.capabilityTokenSecret = requireCapabilitySecret_();
  return config;
}

function readRefundConfig_() {
  const config = readConfig_();
  const properties = resolvedScriptProperties_(PropertiesService.getScriptProperties().getProperties());
  if (!String(properties.FLOW_REFUND_CALLBACK_URL || '').trim()) fail_('REFUND_CONFIGURATION_INCOMPLETE');
  assertProductionRoute_(properties.FLOW_REFUND_CALLBACK_URL, '/api/refund-confirmation');
  config.refundCallbackUrl = properties.FLOW_REFUND_CALLBACK_URL;
  return config;
}

function assertProductionRoute_(value, requiredPath) {
  const match = productionSiteUrlMatch_(value);
  if (!match || match[1] !== requiredPath) fail_('CONFIGURATION_INCOMPLETE');
}
function productionSiteUrlMatch_(value) {
  return /^https:\/\/(?:www\.)?franciscabustos\.cl(\/[^?#]*)?(?:\?([^#]*))?$/i.exec(String(value || ''));
}
function getHttpsHost_(value) { const match = /^https:\/\/([^/:?#]+)(?::\d+)?(?:\/|$)/i.exec(String(value)); return match ? match[1].toLowerCase() : ''; }
function fingerprint_(value) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8).map(function(byte) { return ('0' + (byte & 0xff).toString(16)).slice(-2); }).join('').slice(0, 12); }
function assertPatientEmail_(address) {
  const normalized = String(address || '').trim().toLowerCase();
  if (!normalized || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) fail_('RECIPIENT_REJECTED');
  if (/\+nonprod@/i.test(normalized) || /nonprod/i.test(normalized)) fail_('RECIPIENT_REJECTED');
  return normalized;
}

function resolveBookingSheet_(spreadsheet) {
  if (!spreadsheet || typeof spreadsheet.getSheetByName !== 'function') fail_('CONFIGURATION_INCOMPLETE');
  const preferred = spreadsheet.getSheetByName(PRODUCTION.sheetName);
  if (preferred) return preferred;
  const aliases = PRODUCTION.equivalentSheetNames || [];
  for (let i = 0; i < aliases.length; i += 1) {
    const found = spreadsheet.getSheetByName(aliases[i]);
    if (found) return found;
  }
  fail_('CONFIGURATION_INCOMPLETE');
}

function assertResources_(config) {
  const spreadsheet = SpreadsheetApp.openById(config.bookingStoreId);
  if (spreadsheet.getId() !== config.bookingStoreId) fail_('CONFIGURATION_INCOMPLETE');
  const sheet = resolveBookingSheet_(spreadsheet);
  const calendar = CalendarApp.getCalendarById(config.calendarId);
  if (!calendar || calendar.getId() !== config.calendarId) fail_('CONFIGURATION_INCOMPLETE');
  return { spreadsheet: spreadsheet, sheet: sheet, calendar: calendar,
    calendarGateway: createCalendarGateway_({ calendarId: config.calendarId, requestMeet: true }) };
}

function normalizeHeaderKey_(value) {
  return String(value || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
}

function headerRowValues_(sheet) {
  const lastColumn = Number(sheet && sheet.getLastColumn && sheet.getLastColumn() || 0);
  if (!lastColumn) fail_('SCHEMA_NOT_READY');
  const range = sheet.getRange(1, 1, 1, lastColumn);
  let row = [];
  if (range.getDisplayValues) row = range.getDisplayValues()[0] || [];
  else if (range.getValues) row = range.getValues()[0] || [];
  const named = row.filter(function(value) { return String(value || '').trim(); }).length;
  if (named === 0 && typeof sheet.getDataRange === 'function') {
    const data = sheet.getDataRange().getValues();
    if (data && data[0] && data[0].length) row = data[0];
  }
  return row.map(function(value) { return String(value == null ? '' : value); });
}

function headerFingerprint_(headers) {
  return fingerprint_(headers.map(function(header) { return String(header || ''); }).join('\u001f'));
}

function schemaMetadata_(inspection) {
  return {
    ok: true,
    strategy: SCHEMA_MIGRATION_STRATEGY,
    kind: inspection.kind,
    sheetName: inspection.sheetName || '',
    headerCount: inspection.physicalHeaders.length,
    headerFingerprint: headerFingerprint_(inspection.physicalHeaders),
    rowCount: Number(inspection.rowCount || 0),
    missingV2Columns: inspection.missingV2Columns.slice(),
    presentV2Columns: inspection.presentV2Columns.slice(),
    outbox: inspection.outbox || null,
  };
}

function operatorLog_(payload) {
  if (typeof Logger !== 'undefined' && Logger && typeof Logger.log === 'function') Logger.log(JSON.stringify(payload));
  return payload;
}

function resolveAliasColumn_(physicalHeaders, canonical) {
  const aliases = V7_HEADER_ALIASES[canonical] || [normalizeHeaderKey_(canonical)];
  for (let i = 0; i < physicalHeaders.length; i += 1) {
    const normalized = normalizeHeaderKey_(physicalHeaders[i]);
    if (!normalized) continue;
    if (aliases.indexOf(normalized) !== -1 || normalized === normalizeHeaderKey_(canonical)) return i + 1;
  }
  return 0;
}

function v7PositionalColumn_(canonical) {
  const index = V7_POSITIONAL_CANONICAL.indexOf(canonical);
  return index === -1 ? 0 : index + 1;
}

function isExactV2Headers_(headers) {
  if (!headers || headers.length !== RESERVATION_HEADERS.length) return false;
  return headers.every(function(value, index) { return String(value) === RESERVATION_HEADERS[index]; });
}

function looksLikeV7Headers_(headers) {
  if (!headers || headers.length < V7_POSITIONAL_CANONICAL.length) return false;
  if (String(headers[0] || '') === RESERVATION_HEADERS[0]) return false;
  const firstNorm = normalizeHeaderKey_(headers[0]);
  const knownTimestamp = (V7_HEADER_ALIASES.timestamp || []).indexOf(firstNorm) !== -1;
  const aliasHits = ['email', 'date', 'time', 'status', 'reservationId'].filter(function(canonical) {
    return resolveAliasColumn_(headers, canonical);
  });
  return knownTimestamp || aliasHits.length >= 4;
}

function inspectReservationSchema_(sheet, opt) {
  const options = opt || {};
  if (!sheet || Number(sheet.getLastRow() || 0) === 0) fail_('SCHEMA_NOT_READY');
  if (new Set(RESERVATION_HEADERS).size !== RESERVATION_HEADERS.length) fail_('SCHEMA_MISMATCH');
  const physicalHeaders = headerRowValues_(sheet);
  if (physicalHeaders.some(function(header, index) { return index < V7_POSITIONAL_CANONICAL.length && !String(header || '').trim(); })) {
    fail_('SCHEMA_MISMATCH');
  }
  const duplicateNames = {};
  physicalHeaders.forEach(function(header) {
    const key = String(header || '').trim();
    if (!key) return;
    duplicateNames[key] = (duplicateNames[key] || 0) + 1;
  });
  if (Object.keys(duplicateNames).some(function(key) { return duplicateNames[key] > 1; })) fail_('SCHEMA_MISMATCH');

  const columns = {};
  const legacyColumns = {};
  physicalHeaders.forEach(function(header, index) {
    if (header) columns[header] = index + 1;
  });

  if (isExactV2Headers_(physicalHeaders)) {
    RESERVATION_HEADERS.forEach(function(header, index) { columns[header] = index + 1; });
    return {
      kind: 'v2_native',
      physicalHeaders: physicalHeaders,
      headers: RESERVATION_HEADERS.slice(),
      columns: columns,
      legacyColumns: legacyColumns,
      legacyWriteColumns: {},
      missingV2Columns: [],
      presentV2Columns: RESERVATION_HEADERS.slice(),
      rowCount: Math.max(0, Number(sheet.getLastRow() || 1) - 1),
      sheetName: options.sheetName || '',
    };
  }

  if (!looksLikeV7Headers_(physicalHeaders)) fail_('SCHEMA_MISMATCH');

  V7_POSITIONAL_CANONICAL.forEach(function(canonical, index) {
    legacyColumns[canonical] = resolveAliasColumn_(physicalHeaders, canonical) || (index + 1);
  });
  V7_FLOW_HEADERS.forEach(function(name) {
    if (columns[name]) legacyColumns[name] = columns[name];
  });
  Object.keys(V7_HEADER_ALIASES).forEach(function(canonical) {
    const col = resolveAliasColumn_(physicalHeaders, canonical);
    if (col) legacyColumns[canonical] = col;
  });

  RESERVATION_HEADERS.forEach(function(header) {
    if (columns[header]) return;
    const mappedFrom = Object.keys(V7_TO_V2_FIELD).find(function(legacy) { return V7_TO_V2_FIELD[legacy] === header; });
    if (mappedFrom && legacyColumns[mappedFrom]) columns[header] = legacyColumns[mappedFrom];
  });
  if (!columns.booking_status && legacyColumns.status) columns.booking_status = legacyColumns.status;

  const missingV2Columns = RESERVATION_HEADERS.filter(function(header) { return physicalHeaders.indexOf(header) === -1; });
  const presentV2Columns = RESERVATION_HEADERS.filter(function(header) { return physicalHeaders.indexOf(header) !== -1; });
  const legacyWriteColumns = {};
  Object.keys(V2_TO_V7_WRITE).forEach(function(v2Field) {
    const targets = [];
    V2_TO_V7_WRITE[v2Field].forEach(function(legacyName) {
      const col = legacyColumns[legacyName] || columns[legacyName];
      if (col) targets.push(col);
    });
    if (targets.length) legacyWriteColumns[v2Field] = targets;
  });

  return {
    kind: 'v7_compat',
    physicalHeaders: physicalHeaders,
    headers: physicalHeaders.slice(),
    columns: columns,
    legacyColumns: legacyColumns,
    legacyWriteColumns: legacyWriteColumns,
    missingV2Columns: missingV2Columns,
    presentV2Columns: presentV2Columns,
    rowCount: Math.max(0, Number(sheet.getLastRow() || 1) - 1),
    sheetName: options.sheetName || '',
  };
}

function inspectOutboxSchema_(spreadsheet) {
  const sheet = spreadsheet && spreadsheet.getSheetByName
    ? spreadsheet.getSheetByName(PRODUCTION.notificationOutboxSheetName) : null;
  if (!sheet || Number(sheet.getLastRow() || 0) === 0) {
    return { present: false, headerCount: 0, headerFingerprint: '', ready: false };
  }
  const headers = headerRowValues_(sheet);
  const exact = headers.length === NOTIFICATION_OUTBOX_HEADERS.length
    && headers.every(function(value, index) { return value === NOTIFICATION_OUTBOX_HEADERS[index]; });
  return {
    present: true,
    headerCount: headers.length,
    headerFingerprint: headerFingerprint_(headers),
    rowCount: Math.max(0, Number(sheet.getLastRow() || 1) - 1),
    ready: exact,
  };
}

function assertSchema_(sheet) {
  const inspection = inspectReservationSchema_(sheet);
  if (inspection.kind === 'v2_native') {
    return { kind: inspection.kind, headers: RESERVATION_HEADERS, columns: inspection.columns };
  }
  if (inspection.missingV2Columns.length) fail_('SCHEMA_NOT_READY');
  RESERVATION_HEADERS.forEach(function(header) {
    if (!inspection.columns[header]) fail_('SCHEMA_NOT_READY');
  });
  return {
    kind: inspection.kind,
    headers: inspection.physicalHeaders,
    columns: inspection.columns,
    legacyColumns: inspection.legacyColumns,
    legacyWriteColumns: inspection.legacyWriteColumns,
    physicalHeaders: inspection.physicalHeaders,
  };
}

function appendMissingHeaders_(sheet, names) {
  const appended = [];
  names.forEach(function(name) {
    const nextCol = Number(sheet.getLastColumn() || 0) + 1;
    sheet.getRange(1, nextCol).setValue(name);
    appended.push(name);
  });
  return appended;
}

function productionSchemaMigrationDryRun_(opt) {
  const deps = opt || {};
  const config = deps.config || readConfig_();
  const resources = deps.resources || assertResources_(config);
  const inspection = inspectReservationSchema_(resources.sheet, { sheetName: PRODUCTION.sheetName });
  inspection.outbox = inspectOutboxSchema_(resources.spreadsheet);
  const metadata = schemaMetadata_(inspection);
  metadata.writes = 0;
  return operatorLog_(metadata);
}

function migrateProductionV7SchemaToLifecycleV2_(opt) {
  const deps = opt || {};
  const config = deps.config || readConfig_();
  const resources = deps.resources || assertResources_(config);
  const before = inspectReservationSchema_(resources.sheet, { sheetName: PRODUCTION.sheetName });
  const missing = before.kind === 'v2_native' ? [] : RESERVATION_HEADERS.filter(function(header) {
    return before.physicalHeaders.indexOf(header) === -1;
  });
  const appended = missing.length ? appendMissingHeaders_(resources.sheet, missing) : [];
  const outboxSheet = ensureNotificationOutboxSheet_(resources.spreadsheet);
  const schema = assertSchema_(resources.sheet);
  const after = inspectReservationSchema_(resources.sheet, { sheetName: PRODUCTION.sheetName });
  const result = {
    ok: true,
    strategy: SCHEMA_MIGRATION_STRATEGY,
    idempotent: appended.length === 0,
    appendedCount: appended.length,
    appended: appended.slice(),
    headerFingerprintBefore: headerFingerprint_(before.physicalHeaders),
    headerFingerprintAfter: headerFingerprint_(after.physicalHeaders),
    rowCount: after.rowCount,
    kind: after.kind,
    outboxSchema: assertNotificationOutboxSchema_(outboxSheet).headers.length,
    schemaColumns: Object.keys(schema.columns).length,
  };
  return operatorLog_(result);
}

// Public operator entry points. Apps Script treats a trailing underscore as
// private, so the private operators above cannot be selected in the editor's
// Run menu. These wrappers only delegate: no logic, no constants, no secret
// handling. Fail-closed behaviour stays in the underlying functions, which
// call readConfig_ themselves.
function opProductionSchemaDryRun() {
  return productionSchemaMigrationDryRun_();
}

function opProductionSchemaMigrate() {
  return migrateProductionV7SchemaToLifecycleV2_();
}

// Guarded and idempotent. Empty-sheet bootstrap only. Live V7 uses migrateProductionV7SchemaToLifecycleV2_.
function bootstrapProductionSchema_() {
  const resources = assertResources_(readConfig_());
  let initialized = false;
  if (resources.sheet.getLastRow() === 0) {
    resources.sheet.getRange(1, 1, 1, RESERVATION_HEADERS.length).setValues([RESERVATION_HEADERS]);
    initialized = true;
  }
  const outboxSheet = ensureNotificationOutboxSheet_(resources.spreadsheet);
  if (outboxSheet.getLastRow() === 1 && outboxSheet.getLastColumn() === NOTIFICATION_OUTBOX_HEADERS.length) {
    initialized = initialized || false;
  }
  return { ok: true, initialized: initialized, schema: assertSchema_(resources.sheet).headers.length,
    outboxSchema: assertNotificationOutboxSchema_(outboxSheet).headers.length };
}

function ensureNotificationOutboxSheet_(spreadsheet) {
  if (!spreadsheet || typeof spreadsheet.getSheetByName !== 'function') fail_('CONFIGURATION_INCOMPLETE');
  let sheet = spreadsheet.getSheetByName(PRODUCTION.notificationOutboxSheetName);
  if (!sheet) {
    if (typeof spreadsheet.insertSheet !== 'function') fail_('CONFIGURATION_INCOMPLETE');
    sheet = spreadsheet.insertSheet(PRODUCTION.notificationOutboxSheetName);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, NOTIFICATION_OUTBOX_HEADERS.length).setValues([NOTIFICATION_OUTBOX_HEADERS]);
  }
  return sheet;
}

function assertNotificationOutboxSchema_(sheet) {
  if (!sheet || sheet.getLastRow() === 0) fail_('SCHEMA_NOT_READY');
  if (new Set(NOTIFICATION_OUTBOX_HEADERS).size !== NOTIFICATION_OUTBOX_HEADERS.length) fail_('SCHEMA_MISMATCH');
  if (sheet.getLastColumn() !== NOTIFICATION_OUTBOX_HEADERS.length) fail_('SCHEMA_MISMATCH');
  const actual = sheet.getRange(1, 1, 1, NOTIFICATION_OUTBOX_HEADERS.length).getDisplayValues()[0].map(String);
  if (actual.some(function(value, index) { return value !== NOTIFICATION_OUTBOX_HEADERS[index]; })) fail_('SCHEMA_MISMATCH');
  const columns = {}; NOTIFICATION_OUTBOX_HEADERS.forEach(function(header, index) { columns[header] = index + 1; });
  return { headers: NOTIFICATION_OUTBOX_HEADERS, columns: columns };
}

function expireUnpaidHoldRecord_(sheet, schema, record, nowMs) {
  if (!unpaidHoldBooking_(record) || !slotHoldIsExpired_(record, nowMs)) return record;
  assertTransition_('booking_status', record.booking_status, LIFECYCLE.BOOKING_STATUS.EXPIRED);
  assertTransition_('schedule_status', record.schedule_status, LIFECYCLE.SCHEDULE_STATUS.CANCELLED);
  const updates = {
    booking_status: LIFECYCLE.BOOKING_STATUS.EXPIRED,
    schedule_status: LIFECYCLE.SCHEDULE_STATUS.CANCELLED,
    reconciliation_state: 'slot_hold_expired',
  };
  updateRecord_(sheet, schema, record.rowNumber, updates);
  return Object.assign(record, updates);
}

function expireUnpaidHolds_(sheet, schema, nowMs) {
  reservationRecords_(sheet, schema).forEach(function(record) {
    expireUnpaidHoldRecord_(sheet, schema, record, nowMs);
  });
}

function availability_(e) {
  const config = readConfig_(); const resources = assertResources_(config); const schema = assertSchema_(resources.sheet);
  expireUnpaidHolds_(resources.sheet, schema);
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
  const config = readConfig_(); const payload = parseCreatePayload_(e); payload.email = assertPatientEmail_(payload.email);
  const resources = assertResources_(config); const schema = assertSchema_(resources.sheet); const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) fail_('LOCK_UNAVAILABLE');
  try {
    expireUnpaidHolds_(resources.sheet, schema);
    const existing = findBy_(resources.sheet, schema, 'idempotency_key', payload.idempotencyKey);
    if (existing) return existingBookingResult_(existing);
    const reservation = reserveOnce_(resources.sheet, schema, payload, resources.calendarGateway);
    if (!reservation.ok) return reservation; // SLOT_TAKEN: never contact Flow.
    let flow;
    try { flow = createProductionFlowPayment_(config, payload, reservation); }
    catch (error) {
      persistFailedFlowCreate_(resources.sheet, schema, reservation, error);
      return { ok: false, code: 'FLOW_CREATE_FAILED' };
    }
    const holdExpiresAt = reservation.slot_hold_expires_at || slotHoldExpiryIso_();
    updateRecord_(resources.sheet, schema, reservation.rowNumber, { payment_url: flow.paymentUrl, flow_token: flow.token,
      commerce_order: flow.commerceOrder, status_token_hash: statusTokenHash_(flow.publicStatusToken, config.statusTokenSecret),
      status_token_expires_at: new Date(Date.now() + PRODUCTION.statusTokenTtlMs).toISOString(),
      slot_hold_expires_at: holdExpiresAt,
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
function validIdempotencyKey_(value) { return new RegExp('^' + PRODUCTION.idempotencyNamespace + '-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'i').test(String(value || '')); }

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
  const requestedEnd = sessionEndAt_(requestedStart);
  if (!calendarGateway || typeof calendarGateway.isSlotAvailable !== 'function') fail_('CALENDAR_UNAVAILABLE');
  if (!calendarGateway.isSlotAvailable(requestedStart, requestedEnd, null)) return { ok: false, code: 'SLOT_TAKEN' };
  const taken = reservationRecords_(sheet, schema).some(function(record) {
    return record.current_start_at === requestedStart && reservationOccupiesSlot_(record);
  });
  if (taken) return { ok: false, code: 'SLOT_TAKEN' };
  const now = new Date().toISOString();
  const reservation = { ok: true, idempotency_key: payload.idempotencyKey,
    reservation_id: makeOpaqueId_('reservation', payload.idempotencyKey), service_type: payload.serviceType,
    modality: payload.modality, patient_email: payload.email, original_start_at: requestedStart,
    current_start_at: requestedStart, current_end_at: requestedEnd,
    slot_hold_expires_at: slotHoldExpiryIso_(),
    booking_status: LIFECYCLE.BOOKING_STATUS.INITIATED, payment_status: LIFECYCLE.PAYMENT_STATUS.NOT_STARTED,
    refund_status: LIFECYCLE.REFUND_STATUS.NOT_REQUIRED, schedule_status: LIFECYCLE.SCHEDULE_STATUS.HOLD,
    calendar_link_key: makeCalendarLinkKey_(payload.idempotencyKey),
    patient_reschedule_count: '0', notification_version: '1', created_at: now, updated_at: now };
  appendReservationRow_(sheet, schema, reservation);
  reservation.rowNumber = sheet.getLastRow(); return reservation;
}
function paymentRetryAllowed_(record) {
  if (!record || slotHoldIsExpired_(record)) return false;
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.EXPIRED) return false;
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.PAID) return false;
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.CONFIRMED) return false;
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.MANUAL_REVIEW
    && record.reconciliation_state && String(record.reconciliation_state).indexOf('flow_create_') === 0) {
    return false;
  }
  return record.booking_status === LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING
    && (record.payment_status === LIFECYCLE.PAYMENT_STATUS.PENDING
      || record.payment_status === LIFECYCLE.PAYMENT_STATUS.REJECTED
      || record.payment_status === LIFECYCLE.PAYMENT_STATUS.FAILED
      || record.payment_status === LIFECYCLE.PAYMENT_STATUS.ANNULLED);
}

function makeFlowRetryCommerceOrder_(idempotencyKey) {
  if (!validIdempotencyKey_(idempotencyKey)) fail_('IDEMPOTENCY_KEY_REJECTED');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'order-retry:' + String(idempotencyKey) + ':' + String(Date.now()), Utilities.Charset.UTF_8)
    .map(function(byte) { return ('0' + (byte & 0xff).toString(16)).slice(-2); }).join('');
  const order = 'fp-' + digest.slice(0, 40);
  if (order.length > FLOW_COMMERCE_ORDER_MAX_LENGTH) fail_('FLOW_ORDER_INVALID');
  return order;
}

function retryFlowPayment_(e) {
  const config = readConfig_();
  const raw = String((e && e.postData && e.postData.contents) || '');
  if (!raw || raw.length > 2048) fail_('REQUEST_REJECTED');
  let payload; try { payload = JSON.parse(raw); } catch (_) { fail_('REQUEST_REJECTED'); }
  const token = String(payload.st || payload.publicStatusToken || '').trim();
  if (!validStatusToken_(token)) fail_('STATUS_TOKEN_REJECTED');
  const resources = assertResources_(config); const schema = assertSchema_(resources.sheet);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) fail_('LOCK_UNAVAILABLE');
  try {
    expireUnpaidHolds_(resources.sheet, schema);
    const record = findBy_(resources.sheet, schema, 'status_token_hash', statusTokenHash_(token, config.statusTokenSecret));
    if (!record || !record.status_token_expires_at || Date.parse(record.status_token_expires_at) < Date.now()) fail_('STATUS_TOKEN_REJECTED');
    if (slotHoldIsExpired_(record) || record.booking_status === LIFECYCLE.BOOKING_STATUS.EXPIRED) {
      expireUnpaidHoldRecord_(resources.sheet, schema, record);
      return { ok: false, code: 'HOLD_EXPIRED' };
    }
    if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.PAID || record.booking_status === LIFECYCLE.BOOKING_STATUS.CONFIRMED) {
      return { ok: false, code: 'BOOKING_NOT_RETRYABLE' };
    }
    if (record.booking_status === LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING
      && record.payment_status === LIFECYCLE.PAYMENT_STATUS.PENDING && record.payment_url) {
      return { ok: true, paymentUrl: record.payment_url, publicStatusToken: token, code: 'IDEMPOTENT_REPLAY' };
    }
    if (!paymentRetryAllowed_(record)) return { ok: false, code: 'BOOKING_NOT_RETRYABLE' };
    const originalHold = record.slot_hold_expires_at;
    const flow = createProductionFlowPayment_(config, { email: record.patient_email, idempotencyKey: record.idempotency_key }, record, {
      commerceOrder: makeFlowRetryCommerceOrder_(record.idempotency_key),
      publicStatusToken: token,
      timeoutSeconds: remainingHoldSeconds_(record),
    });
    if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.REJECTED
      || record.payment_status === LIFECYCLE.PAYMENT_STATUS.FAILED
      || record.payment_status === LIFECYCLE.PAYMENT_STATUS.ANNULLED) {
      transitionPayment_(resources.sheet, schema, record, LIFECYCLE.PAYMENT_STATUS.PENDING);
    }
    updateRecord_(resources.sheet, schema, record.rowNumber, {
      payment_url: flow.paymentUrl, flow_token: flow.token, commerce_order: flow.commerceOrder,
      slot_hold_expires_at: originalHold, reconciliation_state: '',
    });
    return { ok: true, paymentUrl: flow.paymentUrl, publicStatusToken: token };
  } finally { lock.releaseLock(); }
}

function existingBookingResult_(record) {
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.EXPIRED || slotHoldIsExpired_(record)) {
    return { ok: false, code: 'HOLD_EXPIRED' };
  }
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING && record.payment_url && record.status_token_hash) {
    const config = readConfig_();
    return { ok: true, paymentUrl: record.payment_url, publicStatusToken: makeStatusToken_(record.idempotency_key, config.statusTokenSecret), code: 'IDEMPOTENT_REPLAY' };
  }
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.INITIATED) return { ok: false, code: 'BOOKING_IN_PROGRESS' };
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.FAILED && record.booking_status === LIFECYCLE.BOOKING_STATUS.MANUAL_REVIEW) {
    return { ok: false, code: 'FLOW_CREATE_FAILED' };
  }
  if (paymentRetryAllowed_(record)) return { ok: false, code: 'PAYMENT_RETRY_REQUIRED' };
  return { ok: false, code: 'BOOKING_NOT_RETRYABLE' };
}

// Flow commerceOrder must stay short. The previous namespaced
// makeOpaqueId_('order') form was 52 chars and exceeded the practical
// provider limit observed across Flow client integrations (45).
var FLOW_COMMERCE_ORDER_MAX_LENGTH = 45;
function makeFlowCommerceOrder_(idempotencyKey) {
  if (!validIdempotencyKey_(idempotencyKey)) fail_('IDEMPOTENCY_KEY_REJECTED');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'order:' + String(idempotencyKey), Utilities.Charset.UTF_8)
    .map(function(byte) { return ('0' + (byte & 0xff).toString(16)).slice(-2); }).join('');
  const order = 'fp-' + digest.slice(0, 40);
  if (order.length > FLOW_COMMERCE_ORDER_MAX_LENGTH) fail_('FLOW_ORDER_INVALID');
  return order;
}

function createProductionFlowPayment_(config, payload, reservation, options) {
  options = options || {};
  const commerceOrder = options.commerceOrder || makeFlowCommerceOrder_(payload.idempotencyKey);
  const publicStatusToken = options.publicStatusToken || makeStatusToken_(payload.idempotencyKey, config.statusTokenSecret);
  const timeoutSeconds = String(options.timeoutSeconds || remainingHoldSeconds_(reservation));
  const data = flowRequest_(config, '/payment/create', {
    commerceOrder: commerceOrder,
    subject: 'Sesión Francisca Bustos',
    currency: 'CLP',
    amount: String(consultationAmountClp_(payload.serviceType || reservation.service_type)),
    email: payload.email,
    urlConfirmation: config.flowConfirmationUrl,
    urlReturn: config.flowReturnUrl + '?st=' + encodeURIComponent(publicStatusToken),
    timeout: timeoutSeconds,
    checkout_timeout: timeoutSeconds,
  }, 'post');
  if (!data || !String(data.token || '') || !/^https:\/\/www\.flow\.cl\//.test(String(data.url || ''))
    || /sandbox\.flow\.cl/i.test(String(data.url || ''))) {
    failFlow_('FLOW_RESPONSE_SHAPE', { statusClass: '2xx' });
  }
  return {
    token: String(data.token),
    commerceOrder: commerceOrder,
    publicStatusToken: publicStatusToken,
    paymentUrl: String(data.url) + '?token=' + encodeURIComponent(String(data.token)),
  };
}
function makeOpaqueId_(kind, idempotencyKey) { const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, kind + ':' + idempotencyKey, Utilities.Charset.UTF_8).map(function(byte) { return ('0' + (byte & 0xff).toString(16)).slice(-2); }).join(''); return PRODUCTION.idempotencyNamespace + '-' + kind + '-' + digest.slice(0, 24); }
function makeStatusToken_(idempotencyKey, secret) { return PRODUCTION.idempotencyNamespace + '-st-' + statusTokenHash_(idempotencyKey, secret).slice(0, 32); }
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

// Operator-safe cleanup for failed checkout rows. Never deletes.
// Requires payment_failed + manual_review and does not call Flow/Calendar/email.
function abandonFailedCheckout_(reservationId) {
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
      cancellation_source: 'operator',
      cancelled_at: new Date().toISOString(),
    });
    return { ok: true, reservationId: record.reservation_id, status: 'abandoned' };
  } finally { lock.releaseLock(); }
}

function flowRequest_(config, endpoint, params, method) {
  if (/sandbox\.flow\.cl/i.test(String(config.flowBaseUrl || ''))) fail_('CONFIGURATION_INCOMPLETE');
  if (config.flowBaseUrl !== PRODUCTION.flowBaseUrl || getHttpsHost_(config.flowBaseUrl) !== PRODUCTION.flowHost) fail_('CONFIGURATION_INCOMPLETE');
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
    expireUnpaidHolds_(resources.sheet, schema);
    let status;
    try { status = flowRequest_(config, '/payment/getStatus', { token: callbackToken }, 'get'); }
    catch (error) {
      const code = safeFlowFailureClass_(error);
      return { ok: true, status: 'payment_verifying', code: code };
    }
    const commerceOrder = String(status && status.commerceOrder || '');
    if (!validCommerceOrder_(commerceOrder)) fail_('FLOW_VERIFICATION_FAILED');
    const record = findBy_(resources.sheet, schema, 'commerce_order', commerceOrder); if (!record || record.flow_token !== callbackToken) fail_('FLOW_VERIFICATION_FAILED');
    const next = stateForFlowStatus_(status.status);
    if (next === LIFECYCLE.PAYMENT_STATUS.UNKNOWN) {
      transitionPayment_(resources.sheet, schema, record, next);
      return { ok: true, status: 'payment_verifying' };
    }
    if (next === LIFECYCLE.PAYMENT_STATUS.PENDING) {
      transitionPayment_(resources.sheet, schema, record, next);
      return { ok: true, status: 'payment_pending' };
    }
    if (next === LIFECYCLE.PAYMENT_STATUS.ANNULLED) {
      transitionPayment_(resources.sheet, schema, record, next);
      if (unpaidHoldBooking_(record) && slotHoldIsExpired_(record)) {
        expireUnpaidHoldRecord_(resources.sheet, schema, record);
      }
      updateRecord_(resources.sheet, schema, record.rowNumber, {
        reconciliation_state: 'flow_provider_status_4_annulled',
      });
      return { ok: true, status: 'payment_annulled', providerStatus: 4 };
    }
    if (next === LIFECYCLE.PAYMENT_STATUS.EXPIRED) {
      transitionPayment_(resources.sheet, schema, record, next);
      if (unpaidHoldBooking_(record)) {
        updateRecord_(resources.sheet, schema, record.rowNumber, {
          booking_status: LIFECYCLE.BOOKING_STATUS.EXPIRED,
          schedule_status: LIFECYCLE.SCHEDULE_STATUS.CANCELLED,
          reconciliation_state: 'flow_order_expired',
        });
      }
      return { ok: true, status: 'payment_expired' };
    }
    if (next === LIFECYCLE.PAYMENT_STATUS.REJECTED || next === LIFECYCLE.PAYMENT_STATUS.FAILED) {
      transitionPayment_(resources.sheet, schema, record, next);
      return { ok: true, status: next === LIFECYCLE.PAYMENT_STATUS.REJECTED ? 'payment_rejected' : 'payment_failed' };
    }
    if (next !== LIFECYCLE.PAYMENT_STATUS.PAID) fail_('FLOW_VERIFICATION_FAILED');
    if (record.booking_status === LIFECYCLE.BOOKING_STATUS.EXPIRED
      || (unpaidHoldBooking_(record) && slotHoldIsExpired_(record))) {
      transitionPayment_(resources.sheet, schema, record, next);
      if (record.booking_status !== LIFECYCLE.BOOKING_STATUS.EXPIRED) {
        expireUnpaidHoldRecord_(resources.sheet, schema, record);
      }
      remediatePaidAfterHoldExpiry_(resources, schema, record);
      return { ok: true, status: 'payment_verifying' };
    }
    if (record.booking_status === LIFECYCLE.BOOKING_STATUS.CONFIRMED && record.payment_status === LIFECYCLE.PAYMENT_STATUS.PAID) {
      return { ok: true, status: 'payment_confirmed' };
    }
    transitionPayment_(resources.sheet, schema, record, next);
    if (record.booking_status === LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING) {
      transitionBooking_(resources.sheet, schema, record, LIFECYCLE.BOOKING_STATUS.CONFIRMED);
    } else if (record.booking_status !== LIFECYCLE.BOOKING_STATUS.CONFIRMED) fail_('INVALID_STATE_TRANSITION');
    applyConfirmedSideEffects_(resources, schema, config, findBy_(resources.sheet, schema, 'commerce_order', commerceOrder)); return { ok: true, status: 'payment_confirmed' };
  } finally { lock.releaseLock(); }
}
function parseCallbackToken_(e) { const direct = String((e && e.parameter && e.parameter.token) || '').trim(); const raw = String((e && e.postData && e.postData.contents) || ''); if (raw.length > 1024) fail_('REQUEST_REJECTED'); const parsed = raw ? parseForm_(raw) : {}; const token = direct || String(parsed.token || '').trim(); if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) fail_('REQUEST_REJECTED'); return token; }
function parseForm_(raw) { return raw.split('&').reduce(function(result, part) { const pieces = part.split('='); if (pieces.length !== 2 || !pieces[0]) fail_('REQUEST_REJECTED'); const key = decodeURIComponent(pieces[0].replace(/\+/g, ' ')); if (key !== 'token' || Object.prototype.hasOwnProperty.call(result, key)) fail_('REQUEST_REJECTED'); result[key] = decodeURIComponent(pieces[1].replace(/\+/g, ' ')); return result; }, {}); }
function validCommerceOrder_(value) { return /^fp-[0-9a-f]{40}$/i.test(String(value || '')); }
function stateForFlowStatus_(value) {
  const status = Number(value);
  if (status === 2) return LIFECYCLE.PAYMENT_STATUS.PAID;
  if (status === 1) return LIFECYCLE.PAYMENT_STATUS.PENDING;
  if (status === 3) return LIFECYCLE.PAYMENT_STATUS.REJECTED;
  if (status === 4) return LIFECYCLE.PAYMENT_STATUS.ANNULLED;
  return LIFECYCLE.PAYMENT_STATUS.UNKNOWN;
}

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
function bookingBounds_(startAt) {
  const start = new Date(String(startAt));
  if (Number.isNaN(start.getTime())) fail_('REQUEST_REJECTED');
  return { start: start, end: new Date(sessionEndAt_(startAt)) };
}
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
  expireUnpaidHoldRecord_(resources.sheet, schema, record);
  const retryAvailable = paymentRetryAllowed_(record);
  return {
    ok: true, status: publicStatus_(record), amount: consultationAmountClp_(record.service_type), currency: 'CLP',
    serviceType: record.service_type, modality: record.modality, backendVersion: PRODUCTION.backendVersion,
    retryAvailable: retryAvailable, holdValid: !slotHoldIsExpired_(record) && record.booking_status !== LIFECYCLE.BOOKING_STATUS.EXPIRED,
  };
}
function validStatusToken_(value) { return new RegExp('^' + PRODUCTION.idempotencyNamespace + '-st-[0-9a-f]{32}$', 'i').test(value); }
function publicStatus_(record) {
  if (!record || !record.payment_status) return 'payment_failed';
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.PAID) {
    return record.booking_status === LIFECYCLE.BOOKING_STATUS.CONFIRMED ? 'payment_confirmed' : 'payment_verifying';
  }
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.EXPIRED
    || record.payment_status === LIFECYCLE.PAYMENT_STATUS.EXPIRED
    || record.payment_status === LIFECYCLE.PAYMENT_STATUS.ANNULLED) {
    return record.payment_status === LIFECYCLE.PAYMENT_STATUS.ANNULLED ? 'payment_annulled' : 'payment_expired';
  }
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.PENDING) return 'payment_pending';
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.REJECTED) return 'payment_rejected';
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.FAILED) return 'payment_failed';
  if (record.payment_status === LIFECYCLE.PAYMENT_STATUS.UNKNOWN) return 'payment_verifying';
  return record.booking_status === LIFECYCLE.BOOKING_STATUS.INITIATED ? 'booking_started' : 'payment_verifying';
}

function reservationRecords_(sheet, schema) { return sheet.getDataRange().getValues().slice(1).map(function(row, index) { return recordFromRow_(row, schema, index + 2); }); }
function findBy_(sheet, schema, field, value) { return reservationRecords_(sheet, schema).find(function(record) { return record[field] === value; }) || null; }

function cellFromRow_(row, column) {
  if (!column) return '';
  const value = row[column - 1];
  return value == null ? '' : String(value);
}

function normalizeV7Date_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !Number.isNaN(value.getTime())) {
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) return Utilities.formatDate(value, 'America/Santiago', 'yyyy-MM-dd');
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  const pipeMatch = raw.match(/\|\s*(\d{4}-\d{2}-\d{2})\s*$/);
  if (pipeMatch) return pipeMatch[1];
  const isoMatch = raw.match(/(\d{4}-\d{2}-\d{2})/);
  return isoMatch ? isoMatch[1] : '';
}

function normalizeV7Time_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !Number.isNaN(value.getTime())) {
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) return Utilities.formatDate(value, 'America/Santiago', 'HH:mm');
  }
  const raw = String(value).replace(/\s*h$/i, '').trim();
  const match = raw.match(/(\d{1,2}):(\d{2})/);
  return match ? match[1].padStart(2, '0') + ':' + match[2] : '';
}

function mapV7StatusToV2_(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === V7_STATUS.PENDING_PAYMENT) {
    return { booking_status: LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING, payment_status: LIFECYCLE.PAYMENT_STATUS.PENDING, schedule_status: LIFECYCLE.SCHEDULE_STATUS.HOLD };
  }
  if (normalized === V7_STATUS.PAID_CONFIRMED || normalized === V7_STATUS.ACTIVE) {
    return { booking_status: LIFECYCLE.BOOKING_STATUS.CONFIRMED, payment_status: LIFECYCLE.PAYMENT_STATUS.PAID, schedule_status: LIFECYCLE.SCHEDULE_STATUS.SCHEDULED };
  }
  if (normalized === V7_STATUS.PAYMENT_REJECTED) {
    return { booking_status: LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING, payment_status: LIFECYCLE.PAYMENT_STATUS.REJECTED, schedule_status: LIFECYCLE.SCHEDULE_STATUS.HOLD };
  }
  if (normalized === V7_STATUS.PAYMENT_REVIEW) {
    return { booking_status: LIFECYCLE.BOOKING_STATUS.MANUAL_REVIEW, payment_status: LIFECYCLE.PAYMENT_STATUS.UNKNOWN, schedule_status: LIFECYCLE.SCHEDULE_STATUS.MANUAL_REVIEW };
  }
  if (normalized === V7_STATUS.RESCHEDULED || normalized === V7_STATUS.CANCELLED) {
    return { booking_status: LIFECYCLE.BOOKING_STATUS.CANCELLED, payment_status: '', schedule_status: LIFECYCLE.SCHEDULE_STATUS.CANCELLED };
  }
  return null;
}

function mapV2StatusToV7_(bookingStatus, paymentStatus) {
  if (bookingStatus === LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING && paymentStatus === LIFECYCLE.PAYMENT_STATUS.REJECTED) return V7_STATUS.PAYMENT_REJECTED;
  if (bookingStatus === LIFECYCLE.BOOKING_STATUS.PAYMENT_PENDING) return V7_STATUS.PENDING_PAYMENT;
  if (bookingStatus === LIFECYCLE.BOOKING_STATUS.CONFIRMED) return V7_STATUS.PAID_CONFIRMED;
  if (bookingStatus === LIFECYCLE.BOOKING_STATUS.CANCELLED) return V7_STATUS.CANCELLED;
  if (bookingStatus === LIFECYCLE.BOOKING_STATUS.MANUAL_REVIEW) return V7_STATUS.PAYMENT_REVIEW;
  if (bookingStatus === LIFECYCLE.BOOKING_STATUS.INITIATED) return V7_STATUS.PENDING_PAYMENT;
  return bookingStatus || '';
}

function applyLegacyV7RecordAdapter_(record, row, schema) {
  if (!record || !schema || schema.kind !== 'v7_compat') return record;
  const legacy = schema.legacyColumns || {};
  function take(name) { return cellFromRow_(row, legacy[name] || schema.columns[name]); }
  if (!record.reservation_id) record.reservation_id = take('reservationId');
  if (!record.patient_email) record.patient_email = take('email');
  if (!record.service_type) record.service_type = take('serviceType') || take('service');
  if (!record.modality) record.modality = take('modality');
  if (!record.meet_url) record.meet_url = take('googleMeetLink');
  if (!record.calendar_event_id) record.calendar_event_id = take('calendarEventId');
  if (!record.cancelled_at) record.cancelled_at = take('cancelledAt');
  if (!record.commerce_order) record.commerce_order = take('commerceOrder');
  if (!record.flow_token) record.flow_token = take('flowToken');
  if (!record.payment_url) record.payment_url = take('paymentUrl');
  if (!record.slot_hold_expires_at) record.slot_hold_expires_at = take('paymentExpiresAt');
  record.manage_token = record.manage_token || take('manageToken');
  record.replaced_by_reservation_id = take('replacedByReservationId');
  if (!record.current_start_at) {
    const date = normalizeV7Date_(row[(legacy.date || 6) - 1]);
    const time = normalizeV7Time_(row[(legacy.time || 7) - 1]);
    if (date && time) {
      try { record.current_start_at = startAt_(date, time); } catch (_) { record.current_start_at = ''; }
    }
  }
  if (!record.original_start_at) record.original_start_at = record.current_start_at;
  if (!record.current_end_at && record.current_start_at) {
    try { record.current_end_at = sessionEndAt_(record.current_start_at); } catch (_) { record.current_end_at = ''; }
  }
  const mapped = mapV7StatusToV2_(take('status'));
  if (mapped) {
    if (!record.booking_status || record.booking_status === take('status')) record.booking_status = mapped.booking_status;
    if (!record.payment_status) {
      record.payment_status = mapped.payment_status || (take('paidAt') ? LIFECYCLE.PAYMENT_STATUS.PAID : record.payment_status);
    }
    if (!record.schedule_status) record.schedule_status = mapped.schedule_status;
    if (!record.refund_status) record.refund_status = LIFECYCLE.REFUND_STATUS.NOT_REQUIRED;
  }
  return record;
}

function recordFromRow_(row, schema, rowNumber) {
  const record = { rowNumber: rowNumber };
  RESERVATION_HEADERS.forEach(function(header) {
    const column = schema.columns && schema.columns[header];
    record[header] = column ? cellFromRow_(row, column) : '';
  });
  applyLegacyV7RecordAdapter_(record, row, schema);
  return record;
}

function appendReservationRow_(sheet, schema, reservation) {
  const physical = (schema && (schema.physicalHeaders || schema.headers)) || RESERVATION_HEADERS;
  const row = physical.map(function() { return ''; });
  function write(field, value, column) {
    if (!column) return;
    row[column - 1] = value == null ? '' : String(value);
  }
  RESERVATION_HEADERS.forEach(function(header) {
    write(header, reservation[header] || '', schema.columns && schema.columns[header]);
  });
  if (schema && schema.kind === 'v7_compat') {
    const legacyWrite = schema.legacyWriteColumns || {};
    Object.keys(legacyWrite).forEach(function(field) {
      let value = reservation[field] || '';
      if (field === 'booking_status') value = mapV2StatusToV7_(reservation.booking_status, reservation.payment_status);
      legacyWrite[field].forEach(function(column) { write(field, value, column); });
    });
    const dateCol = schema.legacyColumns && schema.legacyColumns.date;
    const timeCol = schema.legacyColumns && schema.legacyColumns.time;
    if (dateCol && reservation.current_start_at) write('date', String(reservation.current_start_at).slice(0, 10), dateCol);
    if (timeCol && reservation.current_start_at) {
      try {
        const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .formatToParts(new Date(reservation.current_start_at)).reduce(function(acc, part) { acc[part.type] = part.value; return acc; }, {});
        write('time', String(local.hour || '00').padStart(2, '0') + ':' + String(local.minute || '00').padStart(2, '0'), timeCol);
      } catch (_) { /* date/time dual-write is best-effort */ }
    }
  }
  sheet.appendRow(row);
}

function updateRecord_(sheet, schema, rowNumber, updates) {
  Object.keys(updates).forEach(function(field) {
    if (!Object.prototype.hasOwnProperty.call(schema.columns, field) && field !== 'manage_token') fail_('SCHEMA_MISMATCH');
    if (schema.columns[field]) sheet.getRange(rowNumber, schema.columns[field]).setValue(updates[field]);
    const legacyCols = schema.legacyWriteColumns && schema.legacyWriteColumns[field];
    if (legacyCols) {
      let value = updates[field];
      if (field === 'booking_status') value = mapV2StatusToV7_(updates.booking_status || updates[field], updates.payment_status);
      legacyCols.forEach(function(column) {
        if (column && column !== schema.columns[field]) sheet.getRange(rowNumber, column).setValue(value);
      });
    }
  });
  if (schema.columns.updated_at) sheet.getRange(rowNumber, schema.columns.updated_at).setValue(new Date().toISOString());
}

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
    loadByLegacyManageToken: function(token) {
      return reservationRecords_(resources.sheet, schema).find(function(record) {
        return isLegacyV7ManageToken_(token) && constantTimeEqual_(String(record.manage_token || ''), String(token || ''));
      }) || null;
    },
    loadByCapability: function(token, type, secret) {
      const legacy = this.loadByLegacyManageToken(token);
      if (legacy) return legacy;
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
  return publicManagementRecord_(found, capabilityType, Date.now());
}

function isLegacyV7ManageToken_(token) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(token || ''));
}

function managementToken_(e) {
  const raw = String((e && e.postData && e.postData.contents) || '');
  if (raw.length > 2048) fail_('REQUEST_REJECTED');
  let payload; try { payload = raw ? JSON.parse(raw) : e.parameter || {}; } catch (_) { fail_('REQUEST_REJECTED'); }
  const token = String(payload.token || '').trim();
  if (isLegacyV7ManageToken_(token)) return token;
  if (!/^[A-Za-z0-9_-]{64,256}$/.test(token)) fail_('CAPABILITY_INVALID');
  return token;
}

function managementTokenValidForRecord_(token, record, secret) {
  if (isLegacyV7ManageToken_(token) && constantTimeEqual_(String(record && record.manage_token || ''), token)) return true;
  return verifyCapability_(token, LIFECYCLE.CAPABILITY_TYPE.CANCEL, capabilityFromRecord_(record, LIFECYCLE.CAPABILITY_TYPE.CANCEL), { secret: secret })
    || verifyCapability_(token, LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE, capabilityFromRecord_(record, LIFECYCLE.CAPABILITY_TYPE.RESCHEDULE), { secret: secret });
}

/**
 * The /manage contract. Capabilities are SERVER-DERIVED from the canonical
 * policy on every lookup; the page renders them and never computes a cutoff.
 * `managementWindow` is a deliberately public vocabulary (open / cancel_only /
 * closed) so no internal lifecycle state name is exposed.
 */
function publicManagementRecord_(record, capabilityType, nowMs) {
  const policy = getBookingManagementPolicy_(record, nowMs);
  return { ok: true, status: publicManagementStatus_(record), date: String(record.current_start_at).slice(0, 10),
    time: String(record.current_start_at).slice(11, 16), serviceType: record.service_type, modality: record.modality,
    originalStart: record.original_start_at, currentStart: record.current_start_at, currentEnd: record.current_end_at,
    meetUrl: record.meet_url || '', capabilityType: capabilityType || '',
    managementWindow: policy.window,
    canReschedule: Boolean(policy.can_reschedule && lifecycleRecordReadyForReschedule_(record)),
    canCancel: Boolean(policy.can_cancel),
    refundEligible: Boolean(policy.refund_eligible),
    refundPercent: policy.refund_percent,
    cutoffAt: policy.cutoff_at,
    cutoffHours: policy.cutoff_hours };
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
    requireCapabilitySecret_: function() { return config.capabilityTokenSecret; }, policyEvaluator: patientCancellationRefundPolicy_,
    enqueueRefund: function(updated) { beginRefundForPaidCancellation_(resources, schema, updated); },
    enqueueNotification: function(updated) {
      enqueueManualPolicyRefundNotification_(resources.sheet, schema, updated);
      enqueueSessionCancelledNotification_(resources.sheet, schema, updated);
    } } });
}

/**
 * Refund states that descend from an authorized cancellation refund.
 *
 * patientCancelTransaction_ can only ever move refund_status from NOT_REQUIRED
 * to REQUESTED (classified refundable) or leave it NOT_REQUIRED / MANUAL_REVIEW
 * (classified NOT refundable). PENDING, REFUNDED and FAILED are reachable only
 * downstream of REQUESTED, so they are re-entry, not authorization drift, and
 * refundCreateOnce_ supplies the once-only semantics for them.
 */
var PATIENT_CANCELLATION_REFUND_AUTHORIZED_STATES = Object.freeze([
  LIFECYCLE.REFUND_STATUS.REQUESTED,
  LIFECYCLE.REFUND_STATUS.PENDING,
  LIFECYCLE.REFUND_STATUS.REFUNDED,
  LIFECYCLE.REFUND_STATUS.FAILED,
]);

function patientCancellationRefundAuthorized_(record) {
  return PATIENT_CANCELLATION_REFUND_AUTHORIZED_STATES
    .indexOf(String(record && record.refund_status || '')) !== -1;
}

function beginRefundForPaidCancellation_(resources, schema, record) {
  // The durable authorization gate. A cancellation the canonical 24-hour policy
  // classified as non-refundable persists refund NOT_REQUIRED, so this refuses
  // before any Flow call — and a replay, callback or reconciliation pass cannot
  // reclassify it, because the refusal reads persisted state rather than
  // recomputing a window or trusting the caller.
  if (!patientCancellationRefundAuthorized_(record)) {
    return { ok: false, code: 'REFUND_NOT_AUTHORIZED' };
  }
  return createProviderRefundOnce_(resources, schema, record, 'user_cancellation');
}

function createProviderRefundOnce_(resources, schema, record, reason) {
  if (!record || record.payment_status !== LIFECYCLE.PAYMENT_STATUS.PAID) return { ok: false, code: 'REFUND_NOT_ELIGIBLE' };
  let refundConfig;
  try { refundConfig = readRefundConfig_(); }
  catch (_) {
    updateRecord_(resources.sheet, schema, record.rowNumber, {
      refund_status: LIFECYCLE.REFUND_STATUS.MANUAL_REVIEW,
      refund_last_error_code: 'REFUND_CONFIGURATION_INCOMPLETE',
      reconciliation_state: reason === 'paid_after_hold_expiry'
        ? 'paid_after_hold_expiry_refund_config_missing'
        : record.reconciliation_state,
    });
    enqueueLifecycleNotification_(resources.sheet, schema, record, LIFECYCLE.NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW);
    return { ok: false, code: 'REFUND_CONFIGURATION_INCOMPLETE' };
  }
  const gateway = createFlowRefundGateway_({ baseUrl: refundConfig.flowBaseUrl, apiKey: refundConfig.flowApiKey, secretKey: refundConfig.flowSecretKey });
  const result = refundCreateOnce_({
    store: sheetReservationStore_(resources, schema),
    record: record,
    gateway: gateway,
    receiverEmail: record.patient_email,
    amount: String(consultationAmountClp_(record.service_type)),
    urlCallBack: refundConfig.refundCallbackUrl,
    commerceTrxId: record.commerce_order,
  });
  if (!result.ok) {
    updateRecord_(resources.sheet, schema, record.rowNumber, {
      reconciliation_state: reason === 'paid_after_hold_expiry'
        ? 'paid_after_hold_expiry_refund_failed'
        : String(record.reconciliation_state || ''),
    });
    enqueueLifecycleNotification_(resources.sheet, schema, record, LIFECYCLE.NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW);
  }
  return result;
}

function latePaidRefundAlreadyAttempted_(record) {
  if (!record) return false;
  if (String(record.refund_commerce_order || '').trim()) return true;
  const refundStatus = String(record.refund_status || '');
  if (refundStatus === LIFECYCLE.REFUND_STATUS.REQUESTED
    || refundStatus === LIFECYCLE.REFUND_STATUS.PENDING
    || refundStatus === LIFECYCLE.REFUND_STATUS.REFUNDED
    || refundStatus === LIFECYCLE.REFUND_STATUS.FAILED) return true;
  const state = String(record.reconciliation_state || '');
  return state.indexOf('paid_after_hold_expiry_refund') === 0;
}

function remediatePaidAfterHoldExpiry_(resources, schema, record) {
  if (latePaidRefundAlreadyAttempted_(record)) {
    return { ok: true, replay: true, code: 'PAID_AFTER_HOLD_EXPIRY_REPLAY' };
  }
  updateRecord_(resources.sheet, schema, record.rowNumber, {
    reconciliation_state: 'paid_after_hold_expiry',
  });
  const current = findBy_(resources.sheet, schema, 'reservation_id', record.reservation_id) || record;
  const result = createProviderRefundOnce_(resources, schema, current, 'paid_after_hold_expiry');
  return { ok: true, replay: false, refundAttempted: true, refund: result };
}

function refundConfirmation_(e) {
  const config = readRefundConfig_(); const token = String((e && e.parameter && e.parameter.token) || '').trim();
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) fail_('REFUND_CALLBACK_INVALID');
  const resources = assertResources_(config); const schema = assertSchema_(resources.sheet); const store = sheetReservationStore_(resources, schema);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) fail_('LOCK_UNAVAILABLE');
  try {
    let record = findBy_(resources.sheet, schema, 'refund_provider_reference', token);
    if (!record) fail_('REFUND_CALLBACK_INVALID');
    const gateway = createFlowRefundGateway_({ baseUrl: config.flowBaseUrl, apiKey: config.flowApiKey, secretKey: config.flowSecretKey });
    const result = refundCallbackOnce_({ store: store, record: record, gateway: gateway, token: token });
    record = findBy_(resources.sheet, schema, 'reservation_id', record.reservation_id) || record;
    if (!result.replay && result.status === LIFECYCLE.REFUND_STATUS.REFUNDED) {
      const userCancellation = record.booking_status === LIFECYCLE.BOOKING_STATUS.CANCELLATION_REQUESTED
        || record.cancellation_source === 'patient'
        || record.cancellation_source === 'clinician';
      if (record.booking_status === LIFECYCLE.BOOKING_STATUS.CANCELLATION_REQUESTED) {
        transitionBooking_(resources.sheet, schema, record, LIFECYCLE.BOOKING_STATUS.CANCELLED);
      }
      if (userCancellation) {
        enqueuePatientCancellationNotificationOnce_(resources.sheet, schema, record,
          LIFECYCLE.NOTIFICATION_TYPE.PATIENT_CANCELLED);
      }
    }
    if (!result.replay && result.status === LIFECYCLE.REFUND_STATUS.FAILED) {
      enqueueLifecycleNotification_(resources.sheet, schema, record, LIFECYCLE.NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW);
    }
    return result;
  } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------------------
// Refund policy — single source of truth.
//
// A normal patient-initiated cancellation of an already-paid session is refunded
// in full, automatically, exactly once, against the original confirmed payment
// transaction — provided at least PATIENT_MANAGEMENT_CUTOFF_HOURS (24) remain
// before the CURRENT persisted session start. Inside that cutoff the patient may
// still cancel to tell us they will not attend, but no refund corresponds and
// zero Flow refund calls are made.
//
// The window itself is owned by getBookingManagementPolicy_ (Lifecycle.js).
// Nothing in this file re-derives it.
//
// Every other refund path is deliberately NOT covered by this policy and keeps
// its prior BUSINESS_POLICY_TBD semantics: clinician cancellation reconciliation,
// late-paid-after-hold-expiry system remediation, no-show, chargebacks, and
// administrative refunds. Those evaluate through refundPolicy_/activeRefundPolicy_.
// ---------------------------------------------------------------------------
var CANONICAL_REFUND_POLICY = 'PATIENT_CANCEL_FULL_AUTOMATIC_REFUND';
var PATIENT_CANCEL_REFUND_PERCENT = 100;

/**
 * Refund eligibility is NOT decided here. It is read from the single canonical
 * authority, getBookingManagementPolicy_ in Lifecycle.js, so the 24-hour rule
 * exists in exactly one place in the codebase.
 */
function patientCancelFullRefundEligible_(record, nowMs) {
  return getBookingManagementPolicy_(record, nowMs).refund_eligible;
}

/** Evaluator for patientCancel_ only. Capability and cancellability are already
 *  enforced by patientCancelTransaction_ before this runs, which also re-ANDs
 *  the canonical policy over whatever this returns. */
function patientCancellationRefundPolicy_(record, nowMs) {
  const policy = getBookingManagementPolicy_(record, nowMs);
  if (policy.refund_eligible) {
    return { decision: CANONICAL_REFUND_POLICY, eligible: true, percent: policy.refund_percent, window: policy.window };
  }
  if (policy.window === MANAGEMENT_WINDOW.CANCEL_ONLY) {
    return { decision: PATIENT_CANCEL_LATE_NON_REFUNDABLE, eligible: false, percent: 0, window: policy.window };
  }
  return { decision: 'BUSINESS_POLICY_TBD', eligible: false, percent: 0, window: policy.window };
}

function refundPolicy_(record) {
  void record;
  return { decision: 'BUSINESS_POLICY_TBD', eligible: false, percent: 0 };
}

function activeRefundPolicy_(record) {
  return refundPolicy_(record);
}

function consultationAmountClp_(serviceType) {
  return String(serviceType || '') === 'followup' ? FOLLOWUP_PRICE_CLP : INITIAL_PRICE_CLP;
}

var PATIENT_EMAIL_TIME_ZONE = 'America/Santiago';
var PATIENT_EMAIL_WEEKDAYS_ES = Object.freeze(['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']);
var PATIENT_EMAIL_MONTHS_ES = Object.freeze([
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]);

function formatPatientFacingDateTime_(value) {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return '';
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: PATIENT_EMAIL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const parts = {};
    formatter.formatToParts(new Date(ms)).forEach(function(part) {
      if (part.type !== 'literal') parts[part.type] = part.value;
    });
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    if (!year || !month || !day) return '';
    const hour = String(parts.hour == null ? '' : parts.hour).padStart(2, '0');
    const minute = String(parts.minute == null ? '' : parts.minute).padStart(2, '0');
    const weekday = PATIENT_EMAIL_WEEKDAYS_ES[new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay()];
    const monthName = PATIENT_EMAIL_MONTHS_ES[month - 1];
    if (!weekday || !monthName) return '';
    return weekday + ' ' + day + ' de ' + monthName + ' de ' + year + ', ' + hour + ':' + minute;
  } catch (error) {
    fail_('TIMEZONE_UNAVAILABLE');
  }
}

function patientFacingServiceLabel_(serviceType) {
  const value = String(serviceType || '');
  if (value === 'initial') return 'Primera sesión / Evaluación';
  if (value === 'followup') return 'Seguimiento';
  return value;
}

function patientFacingModalityLabel_(modality) {
  const value = String(modality || '');
  if (value === 'online') return 'Online';
  return value;
}

function enqueueManualPolicyRefundNotification_(sheet, schema, record) {
  if (!manualPolicyRefundNotificationNeeded_(record)) return null;
  return enqueueLifecycleNotification_(sheet, schema, record, LIFECYCLE.NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW);
}

// A reservation gets at most ONE patient cancellation email.
//
// SESSION_CANCELLED is the pre-provider-confirmation variant: it is enqueued at
// cancellation time only when no refund is in flight, and it makes no refund
// claim. PATIENT_CANCELLED / CLINICIAN_CANCELLED is the final variant, enqueued
// only from refundConfirmation_ once the provider confirms REFUNDED, and it
// carries the refund copy. Whichever lands first wins, so a later provider
// confirmation can never produce a second Francisca patient email.
var PATIENT_CANCELLATION_NOTIFICATION_TYPES = Object.freeze([
  'SESSION_CANCELLED', 'PATIENT_CANCELLED', 'CLINICIAN_CANCELLED',
]);

function patientCancellationNotificationExists_(outboxStore, reservationId) {
  const id = String(reservationId || '');
  if (!id) return false;
  return outboxStore.records().some(function(row) {
    return String(row.reservation_id || '') === id
      && PATIENT_CANCELLATION_NOTIFICATION_TYPES.indexOf(String(row.event_type || '')) !== -1
      && String(row.state || '') !== 'superseded';
  });
}

function enqueuePatientCancellationNotificationOnce_(sheet, schema, record, eventType) {
  const store = notificationOutboxStoreFromSheet_(sheet);
  if (patientCancellationNotificationExists_(store, record && record.reservation_id)) return null;
  return enqueueLifecycleNotification_(sheet, schema, record, eventType, null, store);
}

/**
 * When the economically-silent patient cancellation confirmation is owed.
 *
 * A refundable cancellation is NOT covered here: it stays in
 * cancellation_requested until the provider confirms, and the final
 * PATIENT_CANCELLED variant is the one that speaks. This variant covers the
 * cancellations that are already terminal at cancellation time:
 *
 *  - refund NOT_REQUIRED  — decided non-refundable inside the 24-hour cutoff
 *  - refund MANUAL_REVIEW — out of policy, parked for a human
 */
function patientCancellationConfirmationNeeded_(record) {
  if (!record) return false;
  if (record.booking_status !== LIFECYCLE.BOOKING_STATUS.CANCELLED) return false;
  if (record.payment_status !== LIFECYCLE.PAYMENT_STATUS.PAID) return false;
  const refund = String(record.refund_status || '');
  return refund === LIFECYCLE.REFUND_STATUS.MANUAL_REVIEW
    || refund === LIFECYCLE.REFUND_STATUS.NOT_REQUIRED;
}

function enqueueSessionCancelledNotification_(sheet, schema, record) {
  if (!patientCancellationConfirmationNeeded_(record)) return null;
  return enqueuePatientCancellationNotificationOnce_(sheet, schema, record,
    LIFECYCLE.NOTIFICATION_TYPE.SESSION_CANCELLED);
}

function enqueueLifecycleNotification_(sheet, schema, record, type, capabilityTokens, outboxStore) {
  const snapshot = notificationSnapshotFromRecord_(record);
  const store = outboxStore || notificationOutboxStoreFromSheet_(sheet);
  const existing = store.records();
  const sourceOperationId = notificationOccurrenceKey_(record, type);
  const replay = findDurableNotificationReplay_(existing, record.reservation_id, type, sourceOperationId);
  if (replay) {
    syncBookingNotificationAudit_(sheet, schema, record, replay);
    const notification = makeLifecycleNotification_(type, Object.assign({}, record, {
      notification_version: replay.notification_version,
    }), { now: replay.created_at });
    if (capabilityTokens) notification.capabilityTokens = capabilityTokens;
    notification.logicalKey = replay.logical_key;
    return notification;
  }
  pendingSameTypeNotification_(existing, record.reservation_id, type).forEach(function(entry) {
    store.update(entry, { state: 'superseded', last_result: 'superseded', disposition_reason: 'later_same_type' });
  });
  const version = nextDurableNotificationVersion_(store.records(), record.reservation_id);
  const notification = makeLifecycleNotification_(type, Object.assign({}, record, { notification_version: version }), {
    now: new Date().toISOString(),
  });
  if (capabilityTokens) notification.capabilityTokens = capabilityTokens;
  const stateField = lifecycleNotificationStateField_(notification);
  store.append(Object.assign({
    logical_key: notification.logicalKey,
    reservation_id: String(record.reservation_id || ''),
    event_type: type,
    notification_version: version,
    state: 'pending',
    attempt_count: '0',
    created_at: notification.createdAt,
    last_attempt_at: '',
    last_result: type,
    disposition_reason: '',
    source_operation_id: sourceOperationId,
  }, snapshot));
  const audit = {
    notification_outbox_key: notification.logicalKey,
    notification_version: version,
    [stateField]: 'pending',
    notification_attempt_count: '0',
    notification_last_attempt_at: '',
    notification_last_result: type,
  };
  const recon = String(record.reconciliation_state || '');
  if (recon === 'notification_max_attempts' || recon === 'notification_event_type_invalid'
    || recon === 'notification_reschedule_retry' || recon === 'notification_cancel_retry') {
    audit.reconciliation_state = '';
  }
  if (record.rowNumber && schema) updateRecord_(sheet, schema, record.rowNumber, audit);
  Object.assign(record, audit);
  return notification;
}

function syncBookingNotificationAudit_(sheet, schema, record, entry) {
  if (!record || !record.rowNumber || !schema) return;
  const audit = {
    notification_outbox_key: String(entry.logical_key || ''),
    notification_version: String(entry.notification_version || ''),
    notification_attempt_count: String(entry.attempt_count || '0'),
    notification_last_attempt_at: String(entry.last_attempt_at || ''),
    notification_last_result: String(entry.last_result || ''),
  };
  updateRecord_(sheet, schema, record.rowNumber, audit);
  Object.assign(record, audit);
}

function notificationOutboxStoreFromSheet_(sheet) {
  const spreadsheet = sheet && typeof sheet.getParent === 'function' ? sheet.getParent() : null;
  return sheetNotificationOutboxStore_(ensureNotificationOutboxSheet_(spreadsheet));
}

function outboxRecordFromRow_(row, schema, rowNumber) {
  const record = { rowNumber: rowNumber };
  NOTIFICATION_OUTBOX_HEADERS.forEach(function(header) {
    record[header] = row[schema.columns[header] - 1] == null ? '' : String(row[schema.columns[header] - 1]);
  });
  return record;
}

function updateOutboxRecord_(sheet, schema, rowNumber, updates) {
  Object.keys(updates).forEach(function(field) {
    if (!Object.prototype.hasOwnProperty.call(schema.columns, field)) fail_('SCHEMA_MISMATCH');
    sheet.getRange(rowNumber, schema.columns[field]).setValue(updates[field]);
  });
}

function sheetNotificationOutboxStore_(sheet) {
  const schema = assertNotificationOutboxSchema_(sheet);
  const readAll = function() {
    const values = sheet.getDataRange().getValues();
    return values.slice(1).map(function(row, index) {
      return outboxRecordFromRow_(row, schema, index + 2);
    }).filter(function(entry) { return String(entry.logical_key || '') !== ''; });
  };
  return {
    records: readAll,
    loadByLogicalKey: function(key) {
      return readAll().find(function(entry) { return entry.logical_key === String(key); }) || null;
    },
    append: function(fields) {
      const row = NOTIFICATION_OUTBOX_HEADERS.map(function(header) {
        return fields[header] == null ? '' : String(fields[header]);
      });
      sheet.appendRow(row);
      return outboxRecordFromRow_(row, schema, sheet.getLastRow());
    },
    update: function(entry, fields) {
      updateOutboxRecord_(sheet, schema, entry.rowNumber, fields);
      return Object.assign(entry, fields);
    },
  };
}

function memoryNotificationOutboxStore_(seed) {
  const entries = Array.isArray(seed) ? seed.slice() : [];
  let nextRow = 2;
  entries.forEach(function(entry) {
    if (Number(entry.rowNumber) >= nextRow) nextRow = Number(entry.rowNumber) + 1;
  });
  return {
    records: function() { return entries.slice(); },
    loadByLogicalKey: function(key) {
      return entries.find(function(entry) { return entry.logical_key === String(key); }) || null;
    },
    append: function(fields) {
      const entry = { rowNumber: nextRow };
      nextRow += 1;
      NOTIFICATION_OUTBOX_HEADERS.forEach(function(header) {
        entry[header] = fields[header] == null ? '' : String(fields[header]);
      });
      entries.push(entry);
      return entry;
    },
    update: function(entry, fields) {
      Object.assign(entry, fields);
      return entry;
    },
  };
}

function notificationOutboxClaimView_(entry) {
  return {
    key: String(entry.logical_key || ''),
    version: String(entry.notification_version || '1'),
    state: String(entry.state || ''),
    attemptCount: Number(entry.attempt_count || 0) || 0,
    lastAttemptAt: entry.last_attempt_at || null,
    lastResult: entry.last_result || null,
    claimedAt: null,
  };
}

function previewOriginFromConfig_(config) {
  const match = productionSiteUrlMatch_(config && config.flowReturnUrl);
  if (!match) fail_('CONFIGURATION_INCOMPLETE');
  return 'https://' + PRODUCTION.publicHost;
}

function managementPageUrl_(origin, token, open) {
  const base = String(origin || '').replace(/\/$/, '');
  const match = productionSiteUrlMatch_(base);
  if (!match || match[1] || match[2]) fail_('CONFIGURATION_INCOMPLETE');
  if (!/^[A-Za-z0-9_-]{64,256}$/.test(String(token || ''))) fail_('CAPABILITY_INVALID');
  let url = base + '/manage.html?token=' + encodeURIComponent(String(token));
  if (open === 'reschedule' || open === 'cancel') url += '&open=' + open;
  return url;
}

function renderLifecycleNotificationEmail_(input) {
  if (!input || !input.notification || !input.record || !input.previewOrigin) fail_('NOTIFICATION_RENDER_INVALID');
  const parts = lifecycleEmailDateParts_(input.record.current_start_at);
  return {
    subject: lifecycleNotificationSubject_(input.notification.eventType, parts),
    body: renderLifecycleEmailText_(input),
    htmlBody: renderLifecycleEmailHtml_(input),
  };
}

// Production delivery adapter. GmailApp matches live v7. No CC/BCC.
// Raw capability tokens may appear only in the ephemeral email body.
function lifecycleNotificationRecipient_(config, booking, eventType) {
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW) {
    return config && config.internalNotificationEmail;
  }
  return booking && booking.patient_email;
}

function deliverLifecycleNotification_(input) {
  if (!input || !input.config) fail_('CONFIGURATION_INCOMPLETE');
  const to = assertPatientEmail_(input.to);
  const subject = String(input.subject || '');
  const body = String(input.body || '');
  if (!subject || !body) fail_('NOTIFICATION_RENDER_INVALID');
  const options = { name: 'Francisca Bustos' };
  if (input.htmlBody) options.htmlBody = String(input.htmlBody);
  GmailApp.sendEmail(to, subject, body, options);
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

function persistDurableOutbox_(deps, entry, fields) {
  if (deps && deps.outboxStore && typeof deps.outboxStore.loadByLogicalKey === 'function'
    && entry && entry.logical_key) {
    const current = deps.outboxStore.loadByLogicalKey(entry.logical_key);
    if (current && (current.state === 'superseded' || current.state === 'sent')) {
      const next = fields && fields.state;
      if (next && next !== current.state && (next === 'claimed' || next === 'pending' || next === 'failed')) {
        Object.assign(entry, current);
        return current;
      }
    }
  }
  if (deps && deps.outboxStore && typeof deps.outboxStore.update === 'function') {
    return deps.outboxStore.update(entry, fields) || Object.assign(entry, fields);
  }
  return Object.assign(entry, fields);
}

function auditBookingFromOutbox_(deps, booking, entry) {
  if (!booking) return;
  const cancelOrRefund = isCancelOrRefundNotification_(String(entry.event_type || ''));
  const stateField = cancelOrRefund ? 'notification_internal_state' : 'notification_patient_state';
  const fields = {
    notification_outbox_key: String(entry.logical_key || ''),
    notification_version: String(entry.notification_version || ''),
    notification_attempt_count: String(entry.attempt_count || '0'),
    notification_last_attempt_at: String(entry.last_attempt_at || ''),
    notification_last_result: String(entry.last_result || ''),
  };
  fields[stateField] = String(entry.state || '');
  if (entry.last_result === 'max_attempts') fields.reconciliation_state = 'notification_max_attempts';
  if (entry.last_result === 'event_type_invalid') fields.reconciliation_state = 'notification_event_type_invalid';
  if (stateField === 'notification_patient_state' && entry.state === 'sent') {
    fields.last_patient_notification_at = String(entry.last_attempt_at || '');
  }
  if (deps && deps.store && typeof deps.store.update === 'function') deps.store.update(booking, fields);
  else if (deps && deps.sheet && deps.schema && booking.rowNumber) updateRecord_(deps.sheet, deps.schema, booking.rowNumber, fields);
  Object.assign(booking, fields);
}

function snapshotRenderRecord_(booking, entry) {
  return Object.assign({}, booking, {
    service_type: entry.snapshot_service_type || booking.service_type,
    modality: entry.snapshot_modality || booking.modality,
    current_start_at: entry.snapshot_start_at || booking.current_start_at,
    current_end_at: entry.snapshot_end_at || booking.current_end_at,
    meet_url: entry.snapshot_meet_url || '',
    meet_status: entry.snapshot_meet_status || '',
  });
}

function notificationAttemptFailureFields_(claimView, nowIso) {
  const atMax = Number(claimView && claimView.attemptCount || 0) >= MAX_NOTIFICATION_ATTEMPTS;
  const fields = {
    state: claimView && claimView.state || 'failed',
    attempt_count: String(claimView && claimView.attemptCount || 0),
    last_attempt_at: nowIso,
    last_result: atMax ? 'max_attempts' : 'failed',
  };
  if (atMax) fields.disposition_reason = 'max_attempts';
  return fields;
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
  const entry = deps.entry || deps.record;
  const nowIso = new Date(Number(deps.now || Date.now())).toISOString();
  const reservationId = String(entry.reservation_id || '');
  const attempts = Number(entry.attempt_count || 0) || 0;
  const eventType = reconstructLifecycleEventTypeFromEntry_(entry);
  const booking = deps.store && typeof deps.store.loadByReservationId === 'function'
    ? deps.store.loadByReservationId(reservationId)
    : null;
  const persist = function(fields) {
    persistDurableOutbox_(deps, entry, fields);
    auditBookingFromOutbox_(deps, booking, entry);
    return entry;
  };
  if (!eventType) {
    persist({
      state: 'failed',
      last_result: 'event_type_invalid',
      last_attempt_at: nowIso,
      disposition_reason: 'event_type_invalid',
    });
    return { ok: false, code: 'NOTIFICATION_EVENT_TYPE_INVALID', reservationId: reservationId, state: entry.state, attemptCount: attempts };
  }
  const decided = notificationEventDisposition_(entry, booking);
  if (decided.disposition === 'failed' && decided.reason === 'booking_missing') {
    persist({
      state: 'failed', last_result: 'booking_missing', last_attempt_at: nowIso, disposition_reason: 'booking_missing',
    });
    return { ok: false, code: 'NOTIFICATION_RECORD_MISSING', reservationId: reservationId, eventType: eventType,
      state: 'failed', attemptCount: attempts };
  }
  if (decided.disposition === 'superseded') {
    persist({
      state: 'superseded', last_result: 'superseded', last_attempt_at: nowIso, disposition_reason: decided.reason,
    });
    return { ok: true, code: 'SUPERSEDED', reservationId: reservationId, eventType: eventType,
      state: 'superseded', attemptCount: attempts };
  }
  if (attempts >= MAX_NOTIFICATION_ATTEMPTS) {
    persist({
      last_result: 'max_attempts', last_attempt_at: nowIso, disposition_reason: 'max_attempts',
    });
    return { ok: false, code: 'NOTIFICATION_MAX_ATTEMPTS', reservationId: reservationId, eventType: eventType,
      state: entry.state, attemptCount: attempts };
  }

  const claimView = notificationOutboxClaimView_(entry);
  const claim = claimNotificationOutbox_(claimView, nowIso);
  if (!claim.ok) {
    return { ok: false, code: claim.code || 'NOTIFICATION_CLAIM_REJECTED', reservationId: reservationId, eventType: eventType,
      state: claimView.state, attemptCount: claimView.attemptCount };
  }
  persist({
    state: claimView.state,
    attempt_count: String(claimView.attemptCount),
    last_attempt_at: claimView.lastAttemptAt,
    last_result: 'claimed',
  });
  if (entry.state === 'superseded' || entry.state === 'sent') {
    return { ok: true, code: entry.state === 'sent' ? 'SENT' : 'SUPERSEDED', reservationId: reservationId,
      eventType: eventType, state: entry.state, attemptCount: Number(entry.attempt_count || attempts) || attempts };
  }
  if (entry.state !== 'claimed') {
    return { ok: false, code: 'NOTIFICATION_CLAIM_REJECTED', reservationId: reservationId, eventType: eventType,
      state: entry.state, attemptCount: Number(entry.attempt_count || attempts) || attempts };
  }

  let capabilityTokens = {};
  let notification;
  try {
    const retry = retryLifecycleNotification_({
      store: deps.store,
      reservationId: reservationId,
      eventType: eventType,
      now: deps.now || Date.now(),
      lock: deps.lock,
      lockAlreadyHeld: deps.lockAlreadyHeld === true,
      requireCapabilitySecret_: deps.requireCapabilitySecret_ || requireCapabilitySecret_,
    });
    if (!retry || !retry.ok) {
      completeNotificationOutbox_(claimView, { ok: false });
      persist(notificationAttemptFailureFields_(claimView, nowIso));
      return { ok: false, code: (retry && retry.code) || 'NOTIFICATION_RETRY_FAILED', reservationId: reservationId,
        eventType: eventType, state: claimView.state, attemptCount: claimView.attemptCount };
    }
    notification = retry.notification;
    capabilityTokens = retry.capabilityTokens || {};
  } catch (error) {
    completeNotificationOutbox_(claimView, { ok: false });
    persist(notificationAttemptFailureFields_(claimView, nowIso));
    return { ok: false, code: safeCode_(error), reservationId: reservationId, eventType: eventType,
      state: claimView.state, attemptCount: claimView.attemptCount };
  }

  notification.meet = lifecycleNotificationShowsMeet_(eventType) && entry.snapshot_meet_url
    ? { meetUrl: String(entry.snapshot_meet_url), meetStatus: String(entry.snapshot_meet_status || '') }
    : null;
  const previewOrigin = previewOriginFromConfig_(deps.config);
  const rendered = renderLifecycleNotificationEmail_({
    notification: notification,
    record: snapshotRenderRecord_(booking, entry),
    capabilityTokens: capabilityTokens,
    previewOrigin: previewOrigin,
  });
  const deliver = deps.deliver || deliverLifecycleNotification_;
  let delivered = false;
  try {
    const delivery = deliver({
      config: deps.config,
      to: lifecycleNotificationRecipient_(deps.config, booking, eventType),
      subject: rendered.subject,
      body: rendered.body,
      htmlBody: rendered.htmlBody,
    });
    delivered = Boolean(delivery && delivery.ok);
  } catch (error) {
    completeNotificationOutbox_(claimView, { ok: false });
    persist(notificationAttemptFailureFields_(claimView, nowIso));
    return { ok: false, code: safeCode_(error) === 'REQUEST_REJECTED' ? 'NOTIFICATION_DELIVERY_FAILED' : safeCode_(error),
      reservationId: reservationId, eventType: eventType, state: claimView.state, attemptCount: claimView.attemptCount };
  }

  completeNotificationOutbox_(claimView, { ok: delivered });
  if (delivered) {
    persist({
      state: claimView.state,
      attempt_count: String(claimView.attemptCount),
      last_attempt_at: nowIso,
      last_result: 'sent',
    });
    if (deps.sheet && deps.schema && booking && booking.rowNumber) {
      const audit = {
        notification_outbox_key: entry.logical_key,
        notification_version: entry.notification_version,
        notification_attempt_count: String(claimView.attemptCount),
        notification_last_attempt_at: nowIso,
        notification_last_result: 'sent',
      };
      if (lifecycleNotificationStateField_(notification) === 'notification_patient_state') {
        audit.notification_patient_state = 'sent';
        audit.last_patient_notification_at = nowIso;
      } else {
        audit.notification_internal_state = 'sent';
      }
      updateRecord_(deps.sheet, deps.schema, booking.rowNumber, audit);
      Object.assign(booking, audit);
    }
    return { ok: true, code: 'SENT', reservationId: reservationId, eventType: eventType,
      state: claimView.state, attemptCount: claimView.attemptCount };
  }

  persist(notificationAttemptFailureFields_(claimView, nowIso));
  return { ok: false, code: 'NOTIFICATION_DELIVERY_FAILED', reservationId: reservationId, eventType: eventType,
    state: claimView.state, attemptCount: claimView.attemptCount };
}

function resolveNotificationOutboxStore_(deps, resources) {
  if (deps && deps.outboxStore) return deps.outboxStore;
  const spreadsheet = resources && resources.spreadsheet
    || (resources && resources.sheet && typeof resources.sheet.getParent === 'function' && resources.sheet.getParent())
    || (deps && deps.sheet && typeof deps.sheet.getParent === 'function' && deps.sheet.getParent());
  return sheetNotificationOutboxStore_(ensureNotificationOutboxSheet_(spreadsheet));
}

function processLifecycleNotificationOutbox_(opt) {
  const deps = opt || {};
  const config = deps.config || readCapabilityConfig_();
  const lock = deps.lock || LockService.getScriptLock();
  if (!lock || !lock.tryLock(Number(deps.lockTimeoutMs || 10000))) fail_('LOCK_UNAVAILABLE');
  try {
    const resources = deps.resources || assertResources_(config);
    const schema = deps.schema || assertSchema_(resources.sheet);
    const store = deps.store || sheetReservationStore_(resources, schema);
    const outboxStore = resolveNotificationOutboxStore_(deps, resources);
    const batch = selectRetryableNotificationWork_(
      typeof outboxStore.records === 'function' ? outboxStore.records() : [],
      deps.batchSize || MAX_NOTIFICATION_OUTBOX_BATCH
    );
    const results = [];
    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i];
      try {
        results.push(processOneLifecycleNotificationOutbox_({
          entry: item.entry,
          outboxStore: outboxStore,
          store: store,
          sheet: resources && resources.sheet,
          schema: schema,
          config: config,
          lock: lock,
          lockAlreadyHeld: true,
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
          ok: false, code: code, reservationId: String(item.entry && item.entry.reservation_id || ''),
          state: String(item.entry && item.entry.state || ''),
          attemptCount: Number(item.entry && item.entry.attempt_count || 0) || 0,
        });
      }
    }
    return { ok: true, processed: results.length, results: results.map(notificationWorkerResultSafe_) };
  } finally {
    lock.releaseLock();
  }
}


var PRODUCTION_NOTIFICATION_RETRY_HANDLER = 'processLifecycleNotificationOutbox_';
var PRODUCTION_NOTIFICATION_RETRY_INTERVAL_MINUTES = 5;
var PRODUCTION_CALENDAR_RECONCILIATION_HANDLER = 'processCalendarReconciliation_';
var PRODUCTION_CALENDAR_RECONCILIATION_INTERVAL_MINUTES = 5;
var PRODUCTION_CALENDAR_SYNC_TOKEN_PROPERTY = 'PRODUCTION_CALENDAR_NEXT_SYNC_TOKEN';

function matchingProjectTriggers_(handler) {
  return ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === handler;
  });
}

// Lifecycle trigger installation/verification lives in TriggerInstallGuard.js
// (installProductionLifecycleTriggersDeterministic_ /
// verifyProductionLifecycleTriggersDeterministic_). An installed Apps Script
// Trigger does not expose its clock cadence, so no installer or verifier here
// may infer cadence from a Trigger object. The helpers below only remove
// triggers by handler name, which needs no cadence read-back.

function processCalendarReconciliation_() {
  const config = readConfig_();
  const resources = assertResources_(config);
  const schema = assertSchema_(resources.sheet);
  const store = sheetReservationStore_(resources, schema);
  const properties = PropertiesService.getScriptProperties();
  const syncState = {
    get: function() { return String(properties.getProperty(PRODUCTION_CALENDAR_SYNC_TOKEN_PROPERTY) || ''); },
    set: function(token) { properties.setProperty(PRODUCTION_CALENDAR_SYNC_TOKEN_PROPERTY, String(token)); },
  };
  const bounds = availabilityBounds_('');
  return reconcileCalendarSync_({
    gateway: resources.calendarGateway,
    syncState: syncState,
    store: store,
    bounds: bounds,
    lock: LockService.getScriptLock(),
    policyEvaluator: activeRefundPolicy_,
    enqueueRefund: function(updated) { beginRefundForPaidCancellation_(resources, schema, updated); },
    enqueueNotification: function(updated) {
      if (updated.schedule_status === LIFECYCLE.SCHEDULE_STATUS.CANCELLED) {
        enqueueManualPolicyRefundNotification_(resources.sheet, schema, updated);
        return;
      }
      enqueueLifecycleNotification_(resources.sheet, schema, updated, LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED);
    },
  });
}

function removeProductionCalendarReconciliationTrigger_() {
  const handler = PRODUCTION_CALENDAR_RECONCILIATION_HANDLER;
  const triggers = matchingProjectTriggers_(handler);
  triggers.forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  return { ok: true, handler: handler, removed: triggers.length };
}

function removeProductionNotificationRetryTrigger_() {
  const handler = PRODUCTION_NOTIFICATION_RETRY_HANDLER;
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

var __FLOW_PAYMENT_TEST_EXPORTS__ = Object.freeze({
  createFlowPayment_: createFlowPayment_,
  createProductionFlowPayment_: createProductionFlowPayment_,
  flowRequest_: flowRequest_,
  signFlowParams_: signFlowParams_,
  makeFlowCommerceOrder_: makeFlowCommerceOrder_,
  validCommerceOrder_: validCommerceOrder_,
  persistFailedFlowCreate_: persistFailedFlowCreate_,
  abandonFailedCheckout_: abandonFailedCheckout_,
  safeFlowFailureClass_: safeFlowFailureClass_,
  existingBookingResult_: existingBookingResult_,
  retryFlowPayment_: retryFlowPayment_,
  flowConfirmation_: flowConfirmation_,
  stateForFlowStatus_: stateForFlowStatus_,
  paymentRetryAllowed_: paymentRetryAllowed_,
  paymentStatus_: paymentStatus_,
  expireUnpaidHoldRecord_: expireUnpaidHoldRecord_,
  FLOW_COMMERCE_ORDER_MAX_LENGTH: FLOW_COMMERCE_ORDER_MAX_LENGTH,
  INITIAL_PRICE_CLP: INITIAL_PRICE_CLP,
  FOLLOWUP_PRICE_CLP: FOLLOWUP_PRICE_CLP,
  consultationAmountClp_: consultationAmountClp_,
  FLOW_PROVIDER_PAYMENT_STATUS: FLOW_PROVIDER_PAYMENT_STATUS,
  refundPolicy_: refundPolicy_,
  activeRefundPolicy_: activeRefundPolicy_,
  patientCancellationRefundPolicy_: patientCancellationRefundPolicy_,
  patientCancelFullRefundEligible_: patientCancelFullRefundEligible_,
  publicManagementRecord_: publicManagementRecord_,
  publicManagementStatus_: publicManagementStatus_,
  beginRefundForPaidCancellation_: beginRefundForPaidCancellation_,
  patientCancellationRefundAuthorized_: patientCancellationRefundAuthorized_,
  PATIENT_CANCELLATION_REFUND_AUTHORIZED_STATES: PATIENT_CANCELLATION_REFUND_AUTHORIZED_STATES,
  createProviderRefundOnce_: createProviderRefundOnce_,
  CANONICAL_REFUND_POLICY: CANONICAL_REFUND_POLICY,
  PATIENT_CANCEL_REFUND_PERCENT: PATIENT_CANCEL_REFUND_PERCENT,
  remediatePaidAfterHoldExpiry_: remediatePaidAfterHoldExpiry_,
  latePaidRefundAlreadyAttempted_: latePaidRefundAlreadyAttempted_,
});

var __NOTIFICATION_OUTBOX_TEST_EXPORTS__ = Object.freeze({
  processLifecycleNotificationOutbox_: processLifecycleNotificationOutbox_,
  processOneLifecycleNotificationOutbox_: processOneLifecycleNotificationOutbox_,
  deliverLifecycleNotification_: deliverLifecycleNotification_,
  renderLifecycleNotificationEmail_: renderLifecycleNotificationEmail_,
  previewOriginFromConfig_: previewOriginFromConfig_,
  managementPageUrl_: managementPageUrl_,
  removeProductionNotificationRetryTrigger_: removeProductionNotificationRetryTrigger_,
  removeProductionCalendarReconciliationTrigger_: removeProductionCalendarReconciliationTrigger_,
  notificationWorkerResultSafe_: notificationWorkerResultSafe_,
  PRODUCTION_CALENDAR_RECONCILIATION_HANDLER: PRODUCTION_CALENDAR_RECONCILIATION_HANDLER,
  PRODUCTION_CALENDAR_RECONCILIATION_INTERVAL_MINUTES: PRODUCTION_CALENDAR_RECONCILIATION_INTERVAL_MINUTES,
  PRODUCTION_CALENDAR_SYNC_TOKEN_PROPERTY: PRODUCTION_CALENDAR_SYNC_TOKEN_PROPERTY,
  PRODUCTION_NOTIFICATION_RETRY_HANDLER: PRODUCTION_NOTIFICATION_RETRY_HANDLER,
  PRODUCTION_NOTIFICATION_RETRY_INTERVAL_MINUTES: PRODUCTION_NOTIFICATION_RETRY_INTERVAL_MINUTES,
  assertPatientEmail_: assertPatientEmail_,
  enqueueLifecycleNotification_: enqueueLifecycleNotification_,
  enqueueManualPolicyRefundNotification_: enqueueManualPolicyRefundNotification_,
  enqueueSessionCancelledNotification_: enqueueSessionCancelledNotification_,
  enqueuePatientCancellationNotificationOnce_: enqueuePatientCancellationNotificationOnce_,
  patientCancellationNotificationExists_: patientCancellationNotificationExists_,
  patientCancellationConfirmationNeeded_: patientCancellationConfirmationNeeded_,
  PATIENT_CANCELLATION_NOTIFICATION_TYPES: PATIENT_CANCELLATION_NOTIFICATION_TYPES,
  lifecycleNotificationRecipient_: lifecycleNotificationRecipient_,
  notificationAttemptFailureFields_: notificationAttemptFailureFields_,
  abandonFailedCheckout_: abandonFailedCheckout_,
  formatPatientFacingDateTime_: formatPatientFacingDateTime_,
  patientFacingServiceLabel_: patientFacingServiceLabel_,
  patientFacingModalityLabel_: patientFacingModalityLabel_,
  PATIENT_EMAIL_TIME_ZONE: PATIENT_EMAIL_TIME_ZONE,
  ensureNotificationOutboxSheet_: ensureNotificationOutboxSheet_,
  sheetNotificationOutboxStore_: sheetNotificationOutboxStore_,
  memoryNotificationOutboxStore_: memoryNotificationOutboxStore_,
  notificationOutboxStoreFromSheet_: notificationOutboxStoreFromSheet_,
});

var __COMPATIBILITY_TEST_EXPORTS__ = Object.freeze({
  SCHEMA_MIGRATION_STRATEGY: SCHEMA_MIGRATION_STRATEGY,
  NEW_PRODUCTION_PROPERTY_NAMES: NEW_PRODUCTION_PROPERTY_NAMES,
  V7_FLOW_HEADERS: V7_FLOW_HEADERS,
  V7_POSITIONAL_CANONICAL: V7_POSITIONAL_CANONICAL,
  V7_STATUS: V7_STATUS,
  PRODUCTION: PRODUCTION,
  pickScriptProperty_: pickScriptProperty_,
  resolvedScriptProperties_: resolvedScriptProperties_,
  resolveBookingSheet_: resolveBookingSheet_,
  inspectReservationSchema_: inspectReservationSchema_,
  inspectOutboxSchema_: inspectOutboxSchema_,
  productionSchemaMigrationDryRun_: productionSchemaMigrationDryRun_,
  migrateProductionV7SchemaToLifecycleV2_: migrateProductionV7SchemaToLifecycleV2_,
  assertSchema_: assertSchema_,
  recordFromRow_: recordFromRow_,
  appendReservationRow_: appendReservationRow_,
  mapV7StatusToV2_: mapV7StatusToV2_,
  isLegacyV7ManageToken_: isLegacyV7ManageToken_,
  bookingBounds_: bookingBounds_,
  headerFingerprint_: headerFingerprint_,
  looksLikeV7Headers_: looksLikeV7Headers_,
  readConfig_: readConfig_,
});

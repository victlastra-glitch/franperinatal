import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { FIXED_TEST_NOW_MS } from './helpers/fixed-date.mjs';

const files = ['../Code.js', '../Lifecycle.js', '../EmailTemplates.js', '../CalendarGateway.js', '../Reconciliation.js', '../RefundGateway.js'];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const allowlisted = 'ops@example.test';
const capabilitySecret = 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz';
const propertyValues = {
  APP_ENV: 'production', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://www.flow.cl/api', FLOW_RETURN_URL: 'https://franciscabustos.cl/pago-resultado',
  FLOW_CONFIRMATION_URL: 'https://franciscabustos.cl/api/flow-confirmation',
  FLOW_REFUND_CALLBACK_URL: 'https://franciscabustos.cl/api/refund-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: allowlisted,
  IDEMPOTENCY_NAMESPACE: 'fran-booking', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
  CAPABILITY_TOKEN_SECRET: capabilitySecret,
};
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const digestBytes = (value) => {
  const text = String(value);
  if (text === 'synthetic-store') return bytes(Buffer.from('390f55363168', 'hex'));
  if (text === 'synthetic-calendar') return bytes(Buffer.from('6c0535f4450c', 'hex'));
  return bytes(createHash('sha256').update(text).digest());
};

let nowMs = FIXED_TEST_NOW_MS;
class MutableDate extends Date {
  constructor(...args) { if (args.length === 0) super(nowMs); else super(...args); }
  static now() { return nowMs; }
}
Object.defineProperty(MutableDate, 'parse', { value: Date.parse, writable: true, configurable: true });
Object.defineProperty(MutableDate, 'UTC', { value: Date.UTC, writable: true, configurable: true });

let headers = [];
const byReservation = new Map();
const outboxRows = [];
let outboxHeaders = [];
let spreadsheet = null;
let mailBodies = [];
let mailShouldFail = false;
let calendarUpdateShouldFail = false;
let getStatusShouldFail = false;
let refundStatusOverride = 'accepted';
let flowCreateCalls = 0;
let refundCreateCalls = 0;
let refundCreateShouldFail = false;
let refundSeq = 0;
const refundByToken = new Map();
const flowByToken = new Map();
const eventsById = new Map();
let eventSeq = 0;
let tokenSeq = 0;
let lastCreatePayload = null;

function currentRows() { return [...byReservation.values()]; }
function makeRange(targetHeaders, setCell) {
  return function(row, col) {
    return {
      getDisplayValues: () => [targetHeaders],
      setValue: (value) => setCell(row, col, value),
      setValues: (values) => {
        if (row === 1 && values && values[0] && targetHeaders === outboxHeaders) {
          outboxHeaders.splice(0, outboxHeaders.length, ...values[0].map(String));
        }
      },
    };
  };
}
const sheet = {
  getLastRow: () => 1 + byReservation.size,
  getLastColumn: () => headers.length,
  getRange: makeRange(headers, (row, col, value) => {
    if (row < 2) return;
    const record = currentRows()[row - 2];
    if (!record) return;
    record[headers[col - 1]] = String(value == null ? '' : value);
    byReservation.set(record.reservation_id, record);
  }),
  getDataRange: () => ({
    getValues: () => [headers, ...currentRows().map((record) => headers.map((header) => record[header] ?? ''))],
  }),
  appendRow: (row) => {
    const record = { rowNumber: byReservation.size + 2 };
    headers.forEach((header, index) => { record[header] = row[index] == null ? '' : String(row[index]); });
    byReservation.set(record.reservation_id, record);
  },
  getParent: () => spreadsheet,
};
const outboxSheet = {
  getLastRow: () => outboxHeaders.length ? 1 + outboxRows.length : 0,
  getLastColumn: () => outboxHeaders.length,
  getRange: makeRange(outboxHeaders, (row, col, value) => {
    if (row < 2) return;
    const current = outboxRows[row - 2];
    if (!current) return;
    current[outboxHeaders[col - 1]] = String(value == null ? '' : value);
  }),
  getDataRange: () => ({
    getValues: () => [outboxHeaders, ...outboxRows.map((row) => outboxHeaders.map((header) => row[header] ?? ''))],
  }),
  appendRow: (row) => {
    const created = { rowNumber: outboxRows.length + 2 };
    outboxHeaders.forEach((header, index) => { created[header] = row[index] == null ? '' : String(row[index]); });
    outboxRows.push(created);
  },
  getParent: () => spreadsheet,
};
spreadsheet = {
  getId: () => 'synthetic-store',
  getSheetByName: (name) => {
    if (name === 'reservations') return sheet;
    if (name === 'notification_outbox') return outboxHeaders.length ? outboxSheet : null;
    return null;
  },
  insertSheet: (name) => name === 'notification_outbox' ? outboxSheet : sheet,
};

const context = {
  console, Date: MutableDate, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math, encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
    computeDigest: (_a, value) => digestBytes(value),
    computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperties: () => ({ ...propertyValues }),
      getProperty: (key) => propertyValues[key] || '',
      setProperty: (key, value) => { propertyValues[key] = String(value); },
    }),
  },
  SpreadsheetApp: { openById: () => spreadsheet },
  CalendarApp: { getCalendarById: (id) => ({ getId: () => id }) },
  Calendar: {
    Freebusy: { query: () => ({ calendars: { 'synthetic-calendar': { busy: [] } } }) },
    Events: {
      list: () => ({ items: [...eventsById.values()], nextSyncToken: 'sync-1' }),
      get: (_id, eventId) => eventsById.get(String(eventId)) || null,
      insert: (resource) => {
        eventSeq += 1;
        const event = {
          id: 'event-v2-' + eventSeq, etag: 'etag-' + eventSeq, updated: new MutableDate().toISOString(), status: 'confirmed',
          start: resource.start, end: resource.end, extendedProperties: resource.extendedProperties,
          conferenceData: { conferenceId: 'meet-' + eventSeq, entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque-meet-' + eventSeq }] },
        };
        eventsById.set(event.id, event);
        return event;
      },
      update: (resource) => {
        if (calendarUpdateShouldFail) throw new Error('calendar update failed');
        const current = eventsById.get(String(resource.id)) || resource;
        const next = Object.assign({}, current, resource, { etag: 'etag-u', updated: new MutableDate().toISOString() });
        eventsById.set(String(next.id), next);
        return next;
      },
      remove: (id, eventId) => {
        const current = eventsById.get(String(eventId));
        if (current) eventsById.set(String(eventId), Object.assign({}, current, { status: 'cancelled', deleted: true }));
      },
    },
  },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  UrlFetchApp: {
    fetch: (url, options) => {
      const href = String(url);
      if (href.includes('/payment/create')) {
        flowCreateCalls += 1;
        const body = Object.fromEntries(String(options.payload || '').split('&').filter(Boolean).map((part) => part.split('=').map(decodeURIComponent)));
        lastCreatePayload = body;
        tokenSeq += 1;
        const token = 'FLOWTOKENV2' + String(tokenSeq).padStart(20, '0');
        flowByToken.set(token, { commerceOrder: body.commerceOrder, status: 1, timeout: body.timeout });
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ url: 'https://www.flow.cl/app/web/pay', token }) };
      }
      if (href.includes('/payment/getStatus')) {
        if (getStatusShouldFail) throw new Error('provider down');
        const query = Object.fromEntries(href.split('?')[1].split('&').map((part) => part.split('=').map(decodeURIComponent)));
        const current = flowByToken.get(query.token);
        if (!current) return { getResponseCode: () => 404, getContentText: () => JSON.stringify({ code: 404 }) };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ status: current.status, commerceOrder: current.commerceOrder }) };
      }
      if (href.includes('/refund/create')) {
        refundCreateCalls += 1;
        if (refundCreateShouldFail) {
          return { getResponseCode: () => 500, getContentText: () => JSON.stringify({ code: 500 }) };
        }
        refundSeq += 1;
        const token = 'REFUNDTOKENV2' + String(refundSeq).padStart(12, '0');
        refundByToken.set(token, { status: 'created' });
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ token, status: 'created' }) };
      }
      if (href.includes('/refund/getStatus')) {
        const query = Object.fromEntries(href.split('?')[1].split('&').map((part) => part.split('=').map(decodeURIComponent)));
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ token: query.token, status: refundStatusOverride }) };
      }
      throw new Error('unexpected url ' + href);
    },
  },
  GmailApp: {
    sendEmail: (to, subject, body, options) => {
      if (mailShouldFail) throw new Error('smtp failed');
      mailBodies.push({ to, subject, body, htmlBody: options && options.htmlBody, name: options && options.name });
      return true;
    },
  },
  MailApp: { sendEmail: () => { throw new Error('MailApp must not be called'); } },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }), deleteTrigger: () => {} },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);
headers = [...context.RESERVATION_HEADERS];
const phase = context.__PHASE_A_TEST_EXPORTS__;
outboxHeaders.splice(0, outboxHeaders.length, ...phase.OUTBOX_HEADERS);
const worker = context.__NOTIFICATION_OUTBOX_TEST_EXPORTS__;
const templates = context.__EMAIL_TEMPLATE_TEST_EXPORTS__;

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const schema = () => ({ headers, columns: Object.fromEntries(headers.map((h, i) => [h, i + 1])) });
const store = {
  records: () => currentRows(),
  loadByReservationId: (id) => byReservation.get(String(id)) || null,
  loadByCalendarEventId: (id) => currentRows().find((row) => row.calendar_event_id === String(id)) || null,
  loadByCalendarLinkKey: (key) => currentRows().find((row) => row.calendar_link_key === String(key)) || null,
  update: (current, fields) => {
    Object.assign(current, fields);
    byReservation.set(current.reservation_id, current);
    return current;
  },
};

function idempotencyKey(n) {
  return 'fran-booking-aaaaaa' + String(n).padStart(2, '0') + '-e89b-12d3-a456-426614174000';
}
function createPayload(n, time, date) {
  return {
    action: 'create_flow_payment', idempotencyKey: idempotencyKey(n), serviceType: n % 2 ? 'followup' : 'initial',
    modality: 'online', date: date || '2026-09-03', time, name: 'Synthetic', email: allowlisted,
    phone: '', patientRut: '', reason: '', message: '',
  };
}
function createBooking(n, time, date) {
  return context.createFlowPayment_({ postData: { contents: JSON.stringify(createPayload(n, time, date)) } });
}
function byKey(n) {
  return currentRows().find((row) => row.idempotency_key === idempotencyKey(n));
}
function setFlowStatus(record, status) {
  flowByToken.get(record.flow_token).status = status;
}
function drain(now) {
  return worker.processLifecycleNotificationOutbox_({
    config: phase.readCapabilityConfig_(), store, resources: { sheet }, schema: schema(),
    requireCapabilitySecret_: () => capabilitySecret, now: now || nowMs,
  });
}
function tokenFrom(body, label) {
  const match = String(body).match(new RegExp(label + ':.*token=([A-Za-z0-9_-]{64,256})'));
  return match && match[1];
}
function forbiddenPatientCopy(text) {
  return /instagram|testimoni|55\.000|(?<![0-9])55000(?![0-9])|diagn[oó]stico|motivo de consulta|transferencia bancaria/i.test(String(text || ''));
}

check(phase.CANONICAL_CONSULTATION_PRICE_CLP === 50000, 'Z canonical Production price is 50000');
check(phase.SLOT_HOLD_MS === 15 * 60 * 1000 && phase.FLOW_PAYMENT_TIMEOUT_SECONDS === 900, 'hold window is 15 minutes / 900s');
check(context.stateForFlowStatus_(1) === 'pending' && context.stateForFlowStatus_(2) === 'paid'
  && context.stateForFlowStatus_(3) === 'rejected' && context.stateForFlowStatus_(4) === 'annulled'
  && context.stateForFlowStatus_(99) === 'unknown', 'Flow numeric status mapping is 1/2/3/4 with 4=annulled');
check(context.FLOW_PROVIDER_PAYMENT_STATUS[4] === 'annulled', 'provider status 4 is preserved as anulada/annulled');
check(context.refundPolicy_().decision === 'BUSINESS_POLICY_TBD' && context.refundPolicy_().eligible === false,
  'canonical refund policy is BUSINESS_POLICY_TBD');
check(context.activeRefundPolicy_({ payment_status: 'paid', booking_status: 'confirmed' }).eligible === false
  && context.activeRefundPolicy_({ payment_status: 'paid', booking_status: 'confirmed' }).decision === 'BUSINESS_POLICY_TBD',
  'paid cancellation stays BUSINESS_POLICY_TBD with no automatic refund');

const createdA = createBooking(1, '10:00');
check(createdA.ok && byKey(1).booking_status === 'payment_pending' && byKey(1).payment_status === 'pending', 'A booking created pending');
check(!String(byKey(1).notification_outbox_key || '').includes('BOOKING_CONFIRMED') && mailBodies.length === 0, 'A create sends no email');
const statusPending = context.paymentStatus_({ parameter: { st: createdA.publicStatusToken } });
check(statusPending.status === 'payment_pending' && mailBodies.length === 0, 'B pending payment is not confirmed and sends no email');
check(statusPending.status !== 'payment_confirmed', 'C urlReturn/status pending is not success');
check(lastCreatePayload.timeout === '900' && lastCreatePayload.checkout_timeout === '900', 'initial Flow timeout is 900s');

const createdAnnul = createBooking(20, '16:00');
setFlowStatus(byKey(20), 4);
const annulled = context.flowConfirmation_({ parameter: { token: byKey(20).flow_token } });
check(annulled.status === 'payment_annulled' && byKey(20).payment_status === 'annulled'
  && byKey(20).booking_status === 'payment_pending'
  && byKey(20).reconciliation_state === 'flow_provider_status_4_annulled' && mailBodies.length === 0,
  'Flow status 4 annuls the unpaid order without confirming or releasing a still-valid hold');
const annulledPublic = context.paymentStatus_({ parameter: { st: createdAnnul.publicStatusToken } });
check(annulledPublic.status === 'payment_annulled' && annulledPublic.retryAvailable === true && annulledPublic.holdValid === true,
  'annulled unpaid order remains retryable while hold is valid');
const originalAnnulHold = byKey(20).slot_hold_expires_at;
const annulledRetry = context.retryFlowPayment_({ postData: { contents: JSON.stringify({ st: createdAnnul.publicStatusToken }) } });
check(annulledRetry.ok && byKey(20).payment_status === 'pending' && byKey(20).slot_hold_expires_at === originalAnnulHold,
  'retry after status 4 creates a new pending order without extending the hold');

getStatusShouldFail = true;
const unknown = context.flowConfirmation_({ parameter: { token: byKey(1).flow_token } });
getStatusShouldFail = false;
check(unknown.status === 'payment_verifying' && byKey(1).booking_status === 'payment_pending' && mailBodies.length === 0,
  'J provider error stays verifying, no false success/failure, no email');

setFlowStatus(byKey(1), 1);
const stillPending = context.flowConfirmation_({ parameter: { token: byKey(1).flow_token } });
check(stillPending.status === 'payment_pending' && byKey(1).booking_status !== 'confirmed' && mailBodies.length === 0,
  'C/D confirmation with Flow pending does not confirm');

setFlowStatus(byKey(1), 3);
const failed = context.flowConfirmation_({ parameter: { token: byKey(1).flow_token } });
check(failed.status === 'payment_rejected' && byKey(1).booking_status === 'payment_pending' && mailBodies.length === 0,
  'E failed payment is not confirmed and sends no email');
const failedPublic = context.paymentStatus_({ parameter: { st: createdA.publicStatusToken } });
check(failedPublic.status === 'payment_rejected' && failedPublic.retryAvailable === true && failedPublic.holdValid === true,
  'F retry remains available while hold is valid');
const originalHold = byKey(1).slot_hold_expires_at;
nowMs += 5 * 60 * 1000;
const retried = context.retryFlowPayment_({ postData: { contents: JSON.stringify({ st: createdA.publicStatusToken }) } });
check(retried.ok && byKey(1).slot_hold_expires_at === originalHold, 'M retry does not extend the original hold');
check(Number(lastCreatePayload.timeout) <= 600 && Number(lastCreatePayload.checkout_timeout) <= 600,
  'M retry Flow timeout uses remaining hold, not a fresh 900s');

nowMs += 11 * 60 * 1000;
const expiredRetry = context.retryFlowPayment_({ postData: { contents: JSON.stringify({ st: createdA.publicStatusToken }) } });
check(expiredRetry.ok === false && expiredRetry.code === 'HOLD_EXPIRED' && byKey(1).booking_status === 'expired',
  'G failed payment + expired hold releases the slot');
check(phase.reservationOccupiesSlot_(byKey(1)) === false, 'K unpaid expired hold does not occupy availability');

const createdB = createBooking(2, '10:00');
check(createdB.ok && byKey(2).booking_status === 'payment_pending', 'K expired slot can be selected again');
setFlowStatus(byKey(1), 2);
const latePaid = context.flowConfirmation_({ parameter: { token: byKey(1).flow_token } });
check(latePaid.status === 'payment_verifying' && byKey(1).booking_status === 'expired' && byKey(1).payment_status === 'paid'
  && byKey(2).booking_status === 'payment_pending' && byKey(2).booking_status !== 'confirmed'
  && byKey(1).refund_status === 'refund_pending'
  && String(byKey(1).reconciliation_state || '').indexOf('paid_after_hold_expiry') === 0,
  'L expired transaction cannot later steal a rebooked slot; system-consistency refund is attempted');
check(mailBodies.length === 0 || !mailBodies.some((item) => /confirmada/i.test(item.subject)),
  'L late paid after expiry does not send confirmation email');
check(refundCreateCalls === 1, 'H late paid after expiry attempts system-consistency refund exactly once');
check(!String(byKey(1).notification_outbox_key || '').includes('BOOKING_CONFIRMED'),
  'E/G late paid does not enqueue BOOKING_CONFIRMED');
const latePaidDuplicate = context.flowConfirmation_({ parameter: { token: byKey(1).flow_token } });
check(latePaidDuplicate.status === 'payment_verifying' && refundCreateCalls === 1
  && byKey(1).booking_status === 'expired' && byKey(1).payment_status === 'paid'
  && byKey(2).booking_status === 'payment_pending',
  'I duplicate late-paid callback does not reclaim the slot or create a duplicate refund');
check(byKey(1).booking_status === 'expired' && byKey(1).payment_status === 'paid'
  && !String(byKey(1).notification_outbox_key || '').includes('PATIENT_CANCELLED'),
  'J hold-expiry remediation stays expired/paid without PATIENT_CANCELLED');
mailBodies = [];
drain();
check(!mailBodies.some((item) => /Tu sesión fue cancelada|reembolso fue procesado/i.test(item.subject + item.body + (item.htmlBody || ''))),
  'L no refund-success patient email before/without user-cancellation refund');
mailBodies = [];

const createdC = createBooking(3, '11:00');
setFlowStatus(byKey(3), 2);
mailBodies = [];
const paid = context.flowConfirmation_({ parameter: { token: byKey(3).flow_token } });
check(paid.status === 'payment_confirmed' && byKey(3).booking_status === 'confirmed' && byKey(3).payment_status === 'paid',
  'H/N validated Flow PAID confirms booking and owns the slot');
check(String(byKey(3).notification_outbox_key).includes('BOOKING_CONFIRMED'), 'H confirmation emits one durable event');
const taken = createBooking(4, '11:00');
check(taken.ok === false && taken.code === 'SLOT_TAKEN', 'N confirmed payment atomically owns the slot');
drain();
const confirmMail = mailBodies.filter((item) => String(item.subject).startsWith('Tu sesión está confirmada · '));
check(confirmMail.length === 1 && confirmMail[0].htmlBody && !/pagar|pendiente de pago|transferencia/i.test(confirmMail[0].body + confirmMail[0].htmlBody)
  && !forbiddenPatientCopy(confirmMail[0].body + confirmMail[0].htmlBody),
  'H exactly one confirmation email after persist, no pay instructions');
const confirmKey = String(byKey(3).notification_outbox_key);
const duplicatePaid = context.flowConfirmation_({ parameter: { token: byKey(3).flow_token } });
check(duplicatePaid.status === 'payment_confirmed' && byKey(3).notification_outbox_key === confirmKey, 'I duplicate callback is idempotent');
mailBodies = [];
drain();
check(mailBodies.length === 0, 'I duplicate confirmation does not resend email');

const createdD = createBooking(5, '12:00');
setFlowStatus(byKey(5), 2);
context.flowConfirmation_({ parameter: { token: byKey(5).flow_token } });
mailBodies = [];
drain();
check(mailBodies.length === 1, 'reschedule fixture confirmation delivered');
const rsToken = tokenFrom(mailBodies[0].body, 'Reagendar');
const cancelToken = tokenFrom(mailBodies[0].body, 'Cancelar');
check(rsToken && cancelToken, 'confirmation issued management tokens');

calendarUpdateShouldFail = true;
const failedMove = context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: rsToken, fecha: '2026-09-03', hora: '13:00' }) },
});
calendarUpdateShouldFail = false;
check(failedMove.ok === false && byKey(5).current_start_at === byKey(5).original_start_at
  && !String(byKey(5).notification_outbox_key).includes('PATIENT_RESCHEDULED'),
  'P failed schedule update does not emit reschedule email');

const createdMove = createBooking(9, '17:00');
setFlowStatus(byKey(9), 2);
context.flowConfirmation_({ parameter: { token: byKey(9).flow_token } });
mailBodies = [];
drain();
const rsTokenOk = tokenFrom(mailBodies[0].body, 'Reagendar');
const moved = context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: rsTokenOk, fecha: '2026-09-03', hora: '18:00' }) },
});
check(moved.ok && byKey(9).payment_status === 'paid' && String(byKey(9).notification_outbox_key).includes('PATIENT_RESCHEDULED'),
  'O successful reschedule persists first and does not charge again');
mailBodies = [];
drain();
check(mailBodies.length === 1 && mailBodies[0].subject.startsWith('Tu sesión fue reagendada · '), 'O exactly one patient reschedule email');
const duplicateMove = context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: rsTokenOk, fecha: '2026-09-03', hora: '16:00' }) },
});
check(duplicateMove.ok === false, 'Q duplicate reschedule is rejected');
mailBodies = [];
drain();
check(mailBodies.length === 0, 'Q duplicate reschedule does not send another email');

const createdE = createBooking(6, '14:00');
setFlowStatus(byKey(6), 2);
context.flowConfirmation_({ parameter: { token: byKey(6).flow_token } });
mailBodies = [];
drain();
const cancelTok = tokenFrom(mailBodies[0].body, 'Cancelar');
const refundCreatesBeforeCancel = refundCreateCalls;
const cancel = context.patientCancel_({ postData: { contents: JSON.stringify({ token: cancelTok }) } });
check(cancel.ok && cancel.refund === 'BUSINESS_POLICY_TBD'
  && byKey(6).booking_status === 'cancelled' && byKey(6).schedule_status === 'cancelled'
  && phase.reservationOccupiesSlot_(byKey(6)) === false,
  'R cancellation releases the slot immediately');
check(byKey(6).payment_status === 'paid' && byKey(6).refund_status === 'manual_review'
  && refundCreateCalls === refundCreatesBeforeCancel
  && !String(byKey(6).notification_outbox_key || '').includes('PATIENT_CANCELLED'),
  'S payment history is preserved and Flow refund is not called');
mailBodies = [];
drain();
check(outboxRows.filter((row) => row.reservation_id === byKey(6).reservation_id
  && row.event_type === 'REFUND_FAILED_MANUAL_REVIEW').length === 1,
  'V exactly one internal manual-review notification');
check(mailBodies.filter((item) => item.subject === 'Tu sesión fue cancelada'
  && /Si corresponde un reembolso, te contactaremos/.test(item.body)).length === 1,
  'V patient cancel copy is TBD-neutral and is not refund-success');
check(!mailBodies.some((item) => /reembolso de tu sesión fue procesado/i.test(item.body + (item.htmlBody || ''))),
  'V no PATIENT_CANCELLED refund-success email');

const createdG = createBooking(8, '16:00');
setFlowStatus(byKey(8), 2);
context.flowConfirmation_({ parameter: { token: byKey(8).flow_token } });
check(byKey(8).booking_status === 'confirmed' && byKey(8).payment_status === 'paid', 'W payment persisted before email');
mailShouldFail = true;
mailBodies = [];
const failedMail = drain();
mailShouldFail = false;
check(byKey(8).booking_status === 'confirmed' && byKey(8).payment_status === 'paid',
  'W email delivery failure does not roll back payment or booking');
check(failedMail.results.some((item) => item.ok === false), 'W failed send remains retryable');
mailBodies = [];
drain();
check(mailBodies.length === 1, 'X retried email job sends once after prior failure');
mailBodies = [];
drain();
check(mailBodies.length === 0, 'X successful send is not duplicated on later worker runs');

const publicPages = ['../../../../index.html', '../../../../servicios.html', '../../../../reserva.html', '../../../../faq.html'];
for (const relative of publicPages) {
  const html = await readFile(new URL(relative, import.meta.url), 'utf8');
  check(!html.includes('$55.000') && !html.includes('$60.000') && !html.includes('$65.000')
    && !html.includes('55000') && html.includes('$50.000'),
    'Y/Z public ' + relative + ' keeps canonical $50.000');
}

const sampleRecord = {
  service_type: 'initial', modality: 'online',
  current_start_at: '2026-09-03T17:00:00.000Z', current_end_at: '2026-09-03T18:00:00.000Z',
  booking_status: 'confirmed',
};
const previewOrigin = 'https://franciscabustos.cl';
const emailCases = [
  { eventType: 'BOOKING_CONFIRMED', tokens: { RESCHEDULE: 'r'.repeat(64), CANCEL: 'c'.repeat(64) } },
  { eventType: 'PATIENT_RESCHEDULED', tokens: { CANCEL: 'c'.repeat(64) } },
  { eventType: 'CLINICIAN_RESCHEDULED', tokens: { CANCEL: 'c'.repeat(64) } },
  { eventType: 'SESSION_CANCELLED', tokens: {} },
];
const fixtureDir = new URL('./fixtures/email-preview/', import.meta.url);
await mkdir(fixtureDir, { recursive: true });
for (const item of emailCases) {
  const rendered = context.renderLifecycleNotificationEmail_({
    notification: {
      eventType: item.eventType,
      meet: item.eventType === 'SESSION_CANCELLED' ? null : { meetUrl: 'https://meet.google.com/opaque-meet' },
    },
    record: sampleRecord,
    capabilityTokens: item.tokens,
    previewOrigin,
  });
  check(rendered.subject && rendered.body && rendered.htmlBody, item.eventType + ' has subject + text + html');
  check(rendered.htmlBody.includes('max-width:600') && rendered.htmlBody.includes('alt="Francisca Bustos"')
    && rendered.htmlBody.includes('font-size:16px'),
    item.eventType + ' is email-safe, 600px, alt text, 16px body');
  if (item.eventType !== 'SESSION_CANCELLED') {
    check(rendered.htmlBody.includes('min-height:44px'), item.eventType + ' CTAs meet 44px touch target');
  }
  check(!forbiddenPatientCopy(rendered.subject + rendered.body + rendered.htmlBody), item.eventType + ' has no marketing/clinical leakage');
  if (item.eventType === 'BOOKING_CONFIRMED') {
    check(rendered.subject.startsWith('Tu sesión está confirmada · ') && !/pagar|pendiente de pago/i.test(rendered.body + rendered.htmlBody),
      'confirmation subject and no pay instructions');
  }
  if (item.eventType === 'PATIENT_RESCHEDULED') check(rendered.subject.startsWith('Tu sesión fue reagendada · '), 'patient reschedule subject');
  if (item.eventType === 'CLINICIAN_RESCHEDULED') check(rendered.subject === 'Hubo un cambio en tu próxima sesión', 'clinician reschedule subject');
  if (item.eventType === 'SESSION_CANCELLED') {
    check(rendered.subject === 'Tu sesión fue cancelada'
      && rendered.body.includes('Si corresponde un reembolso, te contactaremos.')
      && !/reembolso de tu sesión fue procesado/i.test(rendered.body),
      'cancel email uses BUSINESS_POLICY_TBD copy');
  }
  const wrapped = '<!DOCTYPE html><html lang="es-CL"><head><meta charset="utf-8"><title>'
    + item.eventType + '</title></head><body style="margin:0;background:#e5e5e5;">'
    + rendered.htmlBody.replace('<!DOCTYPE html>', '').replace(/<html[^>]*>/, '').replace('</html>', '')
    + '</body></html>';
  const fileBase = {
    BOOKING_CONFIRMED: 'booking-confirmed',
    PATIENT_RESCHEDULED: 'session-rescheduled',
    CLINICIAN_RESCHEDULED: 'session-clinician-change',
    SESSION_CANCELLED: 'session-cancelled',
  }[item.eventType];
  await writeFile(new URL(fileBase + '.html', fixtureDir), rendered.htmlBody);
  await writeFile(new URL(fileBase + '.txt', fixtureDir), rendered.body);
  void wrapped;
}

check(templates.EMAIL_BRAND.maxWidth === 600, 'desktop email max width is 600');

refundCreateShouldFail = true;
const createdExpiryFail = createBooking(21, '10:00', '2026-09-04');
check(createdExpiryFail.ok, 'K fail-path fixture created');
nowMs += 16 * 60 * 1000;
setFlowStatus(byKey(21), 2);
const failedRemediation = context.flowConfirmation_({ parameter: { token: byKey(21).flow_token } });
check(failedRemediation.status === 'payment_verifying' && byKey(21).booking_status === 'expired'
  && byKey(21).payment_status === 'paid'
  && (byKey(21).refund_status === 'manual_review' || byKey(21).refund_status === 'refund_failed'
    || String(byKey(21).reconciliation_state || '').indexOf('paid_after_hold_expiry') === 0),
  'K failed hold-expiry refund becomes explicit high-priority manual review');
mailBodies = [];
drain();
check(String(byKey(21).notification_outbox_key || '').includes('REFUND_FAILED_MANUAL_REVIEW')
  || mailBodies.some((item) => /revisión/i.test(item.subject + item.body)),
  'K failed remediation raises REFUND_FAILED_MANUAL_REVIEW, not a patient refund-success email');
check(!mailBodies.some((item) => item.subject === 'Tu sesión fue cancelada'),
  'K failed remediation does not send PATIENT_CANCELLED');
refundCreateShouldFail = false;

check(context.activeRefundPolicy_({ payment_status: 'paid', booking_status: 'confirmed' }).decision === 'BUSINESS_POLICY_TBD'
  && context.activeRefundPolicy_({ payment_status: 'paid', booking_status: 'confirmed' }).eligible === false,
  'canonical BUSINESS_POLICY_TBD remains ineligible for automatic refund');
const createdTbd = createBooking(22, '12:00', '2026-09-04');
setFlowStatus(byKey(22), 2);
context.flowConfirmation_({ parameter: { token: byKey(22).flow_token } });
mailBodies = [];
drain();
const tbdCancelTok = tokenFrom(mailBodies[0].body, 'Cancelar');
const refundCreatesBeforeTbd = refundCreateCalls;
const tbdCancel = context.patientCancel_({ postData: { contents: JSON.stringify({ token: tbdCancelTok }) } });
check(tbdCancel.ok && tbdCancel.refund === 'BUSINESS_POLICY_TBD'
  && byKey(22).booking_status === 'cancelled' && byKey(22).schedule_status === 'cancelled'
  && byKey(22).payment_status === 'paid' && byKey(22).refund_status === 'manual_review'
  && phase.reservationOccupiesSlot_(byKey(22)) === false
  && refundCreateCalls === refundCreatesBeforeTbd
  && !String(byKey(22).notification_outbox_key || '').includes('PATIENT_CANCELLED'),
  'TBD paid cancel releases capacity, keeps payment paid, and does not call Flow refund');
check(outboxRows.filter((row) => row.reservation_id === byKey(22).reservation_id
  && row.event_type === 'REFUND_FAILED_MANUAL_REVIEW').length === 1,
  'TBD paid cancel enqueues exactly one operational manual-review notification');
mailBodies = [];
drain();
check(mailBodies.filter((item) => item.subject.startsWith('Revisión operativa')).length === 1
  && mailBodies.filter((item) => item.subject === 'Tu sesión fue cancelada').length === 1
  && mailBodies.some((item) => item.subject.startsWith('Revisión operativa')
    && /no es confirmación de reembolso/i.test(item.body)
    && item.body.includes(byKey(22).reservation_id)
    && item.body.includes('Pago: paid')
    && item.body.includes('Reembolso: manual_review')
    && item.body.includes('no intentado')
    && item.body.includes('revisión humana'))
  && mailBodies.some((item) => item.subject === 'Tu sesión fue cancelada'
    && /Si corresponde un reembolso, te contactaremos/.test(item.body)
    && !/reembolso de tu sesión fue procesado/i.test(item.body)),
  'operational alert is internal and patient copy stays BUSINESS_POLICY_TBD');
const tbdReplay = context.patientCancel_({ postData: { contents: JSON.stringify({ token: tbdCancelTok }) } });
check(tbdReplay.ok && tbdReplay.replay === true, 'TBD cancel replay is idempotent');
mailBodies = [];
drain();
check(mailBodies.length === 0
  && outboxRows.filter((row) => row.reservation_id === byKey(22).reservation_id
    && row.event_type === 'REFUND_FAILED_MANUAL_REVIEW').length === 1,
  'TBD cancel replay does not duplicate the operational notification');

const tbdRendered = context.renderLifecycleNotificationEmail_({
  notification: { eventType: 'REFUND_FAILED_MANUAL_REVIEW', meet: null },
  record: {
    reservation_id: 'fran-booking-reservation-ops-alert',
    payment_status: 'paid', refund_status: 'manual_review', refund_last_error_code: 'BUSINESS_POLICY_TBD',
    current_start_at: '2026-09-05T15:00:00.000Z',
  },
  capabilityTokens: {},
  previewOrigin,
});
check(tbdRendered.subject.startsWith('Revisión operativa')
  && /no es confirmación de reembolso/i.test(tbdRendered.body + tbdRendered.htmlBody)
  && tbdRendered.body.includes('fran-booking-reservation-ops-alert')
  && !tbdRendered.htmlBody.includes('min-height:44px')
  && !/transferencia bancaria|pagar/i.test(tbdRendered.body + tbdRendered.htmlBody),
  'manual-review template is operational, has no patient CTAs, and does not claim refund success');
check(worker.lifecycleNotificationRecipient_({ internalNotificationEmail: allowlisted }, { patient_email: allowlisted }, 'REFUND_FAILED_MANUAL_REVIEW') === allowlisted,
  'manual-review delivery uses the internal operational recipient');

console.log(`LIFECYCLE_EMAIL_V2_MATRIX=PASS assertions=${assertions}`);
console.log('EMAIL_PREVIEW_FIXTURES=' + fileURLToPath(new URL('./fixtures/email-preview/', import.meta.url)));
console.log('REAL_NETWORK_SIDE_EFFECTS=0');

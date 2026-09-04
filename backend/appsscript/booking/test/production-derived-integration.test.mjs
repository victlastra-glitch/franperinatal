import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createFixedDate } from './helpers/fixed-date.mjs';

const FixedDate = createFixedDate();
const files = ['../Code.js', '../Lifecycle.js', '../EmailTemplates.js', '../CalendarGateway.js', '../Reconciliation.js', '../RefundGateway.js'];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const opsEmail = 'ops@example.test';
const capabilitySecret = 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz';
const propertyValues = {
  APP_ENV: 'production', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://www.flow.cl/api', FLOW_RETURN_URL: 'https://franciscabustos.cl/pago-resultado',
  FLOW_CONFIRMATION_URL: 'https://franciscabustos.cl/api/flow-confirmation',
  FLOW_REFUND_CALLBACK_URL: 'https://franciscabustos.cl/api/refund-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: opsEmail,
  IDEMPOTENCY_NAMESPACE: 'fran-booking', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
  CAPABILITY_TOKEN_SECRET: capabilitySecret,
};
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));

let headers = [];
const rows = [];
let lastCreate = null;
let refundCreateCalls = 0;
let flowSeq = 0;
const flowByToken = new Map();
const eventsById = new Map();
const mailed = [];

const sheet = {
  getLastRow: () => 1 + rows.length,
  getLastColumn: () => headers.length,
  getRange: (row, col) => ({
    getDisplayValues: () => [headers],
    setValue: (value) => {
      if (row === 1) return;
      const record = rows[row - 2];
      if (record) record[headers[col - 1]] = value;
    },
    setValues: () => {},
  }),
  getDataRange: () => ({ getValues: () => [headers, ...rows.map((record) => headers.map((header) => record[header] ?? ''))] }),
  appendRow: (row) => {
    const record = {};
    headers.forEach((header, index) => { record[header] = row[index] == null ? '' : String(row[index]); });
    rows.push(record);
  },
  getParent: () => spreadsheet,
};
const outboxRows = [];
const outboxHeaders = [];
const outboxSheet = {
  getLastRow: () => outboxHeaders.length ? 1 + outboxRows.length : 0,
  getLastColumn: () => outboxHeaders.length,
  getRange: (row, col) => ({
    getDisplayValues: () => [outboxHeaders.length ? outboxHeaders : []],
    setValues: (values) => {
      if (row === 1) outboxHeaders.splice(0, outboxHeaders.length, ...values[0]);
    },
    setValue: (value) => {
      if (row === 1) return;
      const record = outboxRows[row - 2];
      if (record && outboxHeaders[col - 1]) record[outboxHeaders[col - 1]] = value;
    },
  }),
  getDataRange: () => ({ getValues: () => [outboxHeaders, ...outboxRows.map((record) => outboxHeaders.map((header) => record[header] ?? ''))] }),
  appendRow: (row) => {
    const record = {};
    outboxHeaders.forEach((header, index) => { record[header] = row[index] == null ? '' : String(row[index]); });
    outboxRows.push(record);
  },
};
const spreadsheet = {
  getId: () => 'synthetic-store',
  getSheetByName: (name) => {
    if (name === 'reservations') return sheet;
    if (name === 'notification_outbox') return outboxHeaders.length || outboxRows.length ? outboxSheet : null;
    return null;
  },
  insertSheet: (name) => name === 'notification_outbox' ? outboxSheet : sheet,
};

const context = {
  console, Date: FixedDate, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math,
  encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
    computeDigest: (_algorithm, value) => bytes(createHash('sha256').update(String(value)).digest()),
    computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
  },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...propertyValues }) }) },
  SpreadsheetApp: { openById: () => spreadsheet },
  CalendarApp: { getCalendarById: (id) => ({ getId: () => id }) },
  Calendar: {
    Freebusy: { query: () => ({ calendars: { 'synthetic-calendar': { busy: [] } } }) },
    Events: {
      list: () => ({ items: [...eventsById.values()] }),
      get: (calendarId, eventId) => eventsById.get(String(eventId)) || null,
      insert: (resource) => {
        const id = 'event-' + (eventsById.size + 1);
        const created = {
          id, etag: 'etag-1', updated: new Date().toISOString(), status: 'confirmed',
          summary: resource.summary, start: resource.start, end: resource.end,
          extendedProperties: resource.extendedProperties,
          conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque-meet' }], conferenceId: 'meet-1' },
        };
        eventsById.set(id, created);
        return created;
      },
      update: (resource) => {
        const current = eventsById.get(String(resource.id)) || resource;
        const next = Object.assign({}, current, resource, { etag: 'etag-2', updated: new Date().toISOString() });
        eventsById.set(String(next.id), next);
        return next;
      },
      remove: (_calendarId, eventId) => { eventsById.delete(String(eventId)); },
    },
  },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  UrlFetchApp: {
    fetch: (url, options) => {
      const href = String(url);
      if (href.includes('/payment/create')) {
        const body = Object.fromEntries(String(options.payload || '').split('&').filter(Boolean).map((part) => part.split('=').map(decodeURIComponent)));
        lastCreate = body;
        flowSeq += 1;
        const token = 'FLOWTOKEN' + String(flowSeq).padStart(16, '0');
        flowByToken.set(token, { commerceOrder: body.commerceOrder, status: 1 });
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ url: 'https://www.flow.cl/app/web/pay', token }) };
      }
      if (href.includes('/payment/getStatus')) {
        const query = Object.fromEntries(href.split('?')[1].split('&').map((part) => part.split('=').map(decodeURIComponent)));
        const current = flowByToken.get(query.token);
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ status: current.status, commerceOrder: current.commerceOrder }) };
      }
      if (href.includes('/refund/create')) {
        refundCreateCalls += 1;
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ token: 'REFUNDTOKEN-LATE-' + refundCreateCalls, status: 'created' }) };
      }
      throw new Error('unexpected url ' + href);
    },
  },
  GmailApp: {
    sendEmail: (to, subject, body, options) => {
      mailed.push({ to, subject, body, htmlBody: options && options.htmlBody });
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
const flow = context.__FLOW_PAYMENT_TEST_EXPORTS__;
const worker = context.__NOTIFICATION_OUTBOX_TEST_EXPORTS__;
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

check(phase.INITIAL_PRICE_CLP === 50000 && flow.INITIAL_PRICE_CLP === 50000, 'PRICE_INITIAL_50000');
check(phase.FOLLOWUP_PRICE_CLP === 50000 && flow.FOLLOWUP_PRICE_CLP === 50000, 'PRICE_FOLLOWUP_50000');
check(phase.SLOT_HOLD_MS === 15 * 60 * 1000, 'HOLD_15_MINUTES');
check(phase.FLOW_PAYMENT_TIMEOUT_SECONDS === 900, 'FLOW_TIMEOUT_900');
check(phase.FLOW_CHECKOUT_TIMEOUT_SECONDS === 900, 'FLOW_CHECKOUT_TIMEOUT_900');
check(flow.stateForFlowStatus_(1) === 'pending', 'FLOW_STATUS_1_PENDING');
check(flow.stateForFlowStatus_(2) === 'paid', 'FLOW_STATUS_2_PAID');
check(flow.stateForFlowStatus_(3) === 'rejected', 'FLOW_STATUS_3_REJECTED');
check(flow.stateForFlowStatus_(4) === 'annulled', 'FLOW_STATUS_4_ANNULLED');
check(flow.stateForFlowStatus_(99) === 'unknown', 'FLOW_UNKNOWN_NEUTRAL');
check(context.refundPolicy_().decision === 'BUSINESS_POLICY_TBD' && context.refundPolicy_().eligible === false,
  'REFUND_POLICY_TBD_PRESERVED');
check(context.activeRefundPolicy_({ payment_status: 'paid', booking_status: 'confirmed' }).eligible === false,
  'no automatic FULL_REFUND');

function create(n, serviceType, time) {
  const key = 'fran-booking-aaaaaa' + String(n).padStart(2, '0') + '-e89b-12d3-a456-426614174000';
  return context.createFlowPayment_({
    postData: { contents: JSON.stringify({
      action: 'create_flow_payment', idempotencyKey: key, serviceType, modality: 'online',
      date: '2026-09-03', time, name: 'Synthetic', email: opsEmail,
      phone: '', patientRut: '', reason: '', message: '',
    }) },
  });
}
function rowFor(n) {
  const key = 'fran-booking-aaaaaa' + String(n).padStart(2, '0') + '-e89b-12d3-a456-426614174000';
  return rows.find((row) => row.idempotency_key === key);
}

const initial = create(1, 'initial', '10:00');
check(initial.ok && Number(lastCreate.amount) === 50000, 'initial create charges 50000');
check(lastCreate.timeout === '900' && lastCreate.checkout_timeout === '900', 'create timeouts are 900');
const followup = create(2, 'followup', '11:00');
check(followup.ok && Number(lastCreate.amount) === 50000, 'followup create charges 50000');

const originalHold = rowFor(1).slot_hold_expires_at;
flowByToken.get(rowFor(1).flow_token).status = 3;
context.flowConfirmation_({ parameter: { token: rowFor(1).flow_token } });
const retried = context.retryFlowPayment_({ postData: { contents: JSON.stringify({ st: initial.publicStatusToken }) } });
check(retried.ok && rowFor(1).slot_hold_expires_at === originalHold, 'RETRY_DOES_NOT_EXTEND_HOLD');
check(Number(lastCreate.timeout) <= 900 && Number(lastCreate.checkout_timeout) <= 900, 'retry timeouts remain <= 900');

const pendingStatus = context.paymentStatus_({ parameter: { st: followup.publicStatusToken } });
check(pendingStatus.status === 'payment_pending' && pendingStatus.status !== 'payment_confirmed',
  'URL_RETURN_NOT_AUTHORITATIVE');

flowByToken.get(rowFor(2).flow_token).status = 2;
const confirmed = context.flowConfirmation_({ parameter: { token: rowFor(2).flow_token } });
check(confirmed.status === 'payment_confirmed', 'paid getStatus confirms');
worker.processLifecycleNotificationOutbox_({
  config: phase.readCapabilityConfig_(),
  resources: { sheet }, schema: { headers, columns: Object.fromEntries(headers.map((h, i) => [h, i + 1])) },
  requireCapabilitySecret_: () => capabilitySecret,
});
check(mailed.filter((item) => String(item.subject).startsWith('Tu sesión está confirmada')).length === 1,
  'BOOKING_CONFIRMED_EMAIL_COUNT=1');
check(mailed.filter((item) => /no pudimos procesar|pago rechazado|failed payment/i.test(item.subject + item.body)).length === 0,
  'FAILED_PAYMENT_EMAIL_COUNT=0');
check([...eventsById.values()].filter((event) => event.status !== 'cancelled').length === 1, 'CALENDAR_EVENT_COUNT=1');
check([...eventsById.values()].filter((event) => event.conferenceData).length === 1, 'MEET_COUNT=1');

const duplicate = context.flowConfirmation_({ parameter: { token: rowFor(2).flow_token } });
check(duplicate.status === 'payment_confirmed', 'DUPLICATE_CONFIRM_IDEMPOTENCY');
worker.processLifecycleNotificationOutbox_({
  config: phase.readCapabilityConfig_(),
  resources: { sheet }, schema: { headers, columns: Object.fromEntries(headers.map((h, i) => [h, i + 1])) },
  requireCapabilitySecret_: () => capabilitySecret,
});
check(mailed.filter((item) => String(item.subject).startsWith('Tu sesión está confirmada')).length === 1,
  'duplicate confirm does not resend');

function schema() {
  return { headers, columns: Object.fromEntries(headers.map((header, index) => [header, index + 1])) };
}
function drain() {
  return worker.processLifecycleNotificationOutbox_({
    config: phase.readCapabilityConfig_(),
    resources: { sheet }, schema: schema(),
    requireCapabilitySecret_: () => capabilitySecret,
  });
}
function tokenFrom(body, label) {
  const match = String(body).match(new RegExp(label + ':.*token=([A-Za-z0-9_-]{64,256})'));
  return match && match[1];
}

const confirmMail = mailed.find((item) => String(item.subject).startsWith('Tu sesión está confirmada'));
const rescheduleToken = tokenFrom(confirmMail.body, 'Reagendar');
const cancelToken = tokenFrom(confirmMail.body, 'Cancelar');
check(rescheduleToken && cancelToken, 'confirmation mail issues management tokens');

const mailBeforeReschedule = mailed.length;
const reschedule = context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: rescheduleToken, fecha: '2026-09-03', hora: '12:00' }) },
});
check(reschedule.ok && rowFor(2).payment_status === 'paid', 'PAYMENT_PRESERVED_AFTER_RESCHEDULE');
check(rowFor(2).notification_patient_state === 'pending'
  && String(rowFor(2).notification_outbox_key).includes('PATIENT_RESCHEDULED')
  && mailed.length === mailBeforeReschedule,
  'RESCHEDULE_PERSIST_BEFORE_EMAIL');
check([...eventsById.values()].filter((event) => event.status !== 'cancelled').length === 1,
  'DUPLICATE_CALENDAR_AFTER_RESCHEDULE=0');
const staleReschedule = context.patientReschedule_({
  postData: { contents: JSON.stringify({ token: rescheduleToken, fecha: '2026-09-03', hora: '13:00' }) },
});
check(staleReschedule && staleReschedule.ok === false, 'STALE_RESCHEDULE_REJECTED');
drain();
check(mailed.filter((item) => /reagend/i.test(item.subject + item.body)).length >= 1,
  'reschedule email sends after persist');
const rescheduleMail = [...mailed].reverse().find((item) => /reagend/i.test(item.subject));
const rotatedCancelToken = tokenFrom(rescheduleMail.body, 'Cancelar');
check(rotatedCancelToken && rotatedCancelToken !== cancelToken, 'reschedule rotates CANCEL capability');

const refundCreatesBeforeCancel = refundCreateCalls;
const cancel = context.patientCancel_({ postData: { contents: JSON.stringify({ token: rotatedCancelToken }) } });
check(cancel.ok && rowFor(2).schedule_status === 'cancelled'
  && context.ACTIVE_SLOT_STATES.indexOf(rowFor(2).booking_status) === -1,
  'CANCEL_CAPACITY_RELEASE');
check(rowFor(2).payment_status === 'paid', 'CANCEL_PAYMENT_HISTORY_PRESERVED');
check(cancel.refund === 'BUSINESS_POLICY_TBD' && rowFor(2).refund_status === 'manual_review'
  && refundCreateCalls === refundCreatesBeforeCancel,
  'NORMAL_CANCEL_FLOW_REFUND_CALLS=0');
drain();
check(outboxRows.filter((row) => row.event_type === 'REFUND_FAILED_MANUAL_REVIEW').length === 1,
  'MANUAL_REVIEW_NOTIFICATION_COUNT=1');
check(outboxRows.filter((row) => row.event_type === 'SESSION_CANCELLED').length === 1
  && mailed.filter((item) => item.subject === 'Tu sesión fue cancelada'
    && !/(pago|cobro|valor|devoluci[oó]n|reembolso|\\$50\\.000|50000)/i.test(item.body + (item.htmlBody || ''))).length >= 1,
  'SESSION_CANCELLED_ALLOWED with neutral refund copy');
check(outboxRows.filter((row) => row.event_type === 'PATIENT_CANCELLED').length === 0
  && mailed.filter((item) => /reembolso fue procesado|reembolso completado/i.test(
    item.subject + item.body + (item.htmlBody || ''))).length === 0,
  'PATIENT_CANCELLED_EMAIL_COUNT_UNDER_TBD=0');

const lateCreate = create(3, 'followup', '14:00');
check(lateCreate.ok, 'late-paid fixture created');
rowFor(3).slot_hold_expires_at = '2026-08-25T12:00:00.000Z';
flowByToken.get(rowFor(3).flow_token).status = 2;
const eventsBeforeLatePaid = [...eventsById.values()].filter((event) => event.status !== 'cancelled').length;
const refundCreatesBeforeLatePaid = refundCreateCalls;
const latePaid = context.flowConfirmation_({ parameter: { token: rowFor(3).flow_token } });
check(latePaid.status === 'payment_verifying' && rowFor(3).booking_status === 'expired'
  && rowFor(3).payment_status === 'paid'
  && [...eventsById.values()].filter((event) => event.status !== 'cancelled').length === eventsBeforeLatePaid,
  'LATE_PAID_NO_SLOT_RECLAIM');
check(refundCreateCalls - refundCreatesBeforeLatePaid === 1, 'LATE_PAID_SYSTEM_REFUND_ATTEMPT_COUNT=1');
const latePaidReplay = context.flowConfirmation_({ parameter: { token: rowFor(3).flow_token } });
check(latePaidReplay.status === 'payment_verifying' && refundCreateCalls - refundCreatesBeforeLatePaid === 1
  && rowFor(3).booking_status === 'expired' && rowFor(3).payment_status === 'paid',
  'LATE_PAID_REFUND_IDEMPOTENCY');

console.log(`PRODUCTION_DERIVED_INTEGRATION_TESTS=PASS assertions=${assertions}`);
console.log('PRICE_INITIAL_50000=PASS');
console.log('PRICE_FOLLOWUP_50000=PASS');
console.log('HOLD_15_MINUTES=PASS');
console.log('FLOW_TIMEOUT_900=PASS');
console.log('FLOW_CHECKOUT_TIMEOUT_900=PASS');
console.log('RETRY_DOES_NOT_EXTEND_HOLD=PASS');
console.log('FLOW_STATUS_1_PENDING=PASS');
console.log('FLOW_STATUS_2_PAID=PASS');
console.log('FLOW_STATUS_3_REJECTED=PASS');
console.log('FLOW_STATUS_4_ANNULLED=PASS');
console.log('FLOW_UNKNOWN_NEUTRAL=PASS');
console.log('URL_RETURN_NOT_AUTHORITATIVE=PASS');
console.log('REFUND_POLICY_TBD_PRESERVED=PASS');
console.log('BOOKING_CONFIRMED_EMAIL_COUNT=1');
console.log('FAILED_PAYMENT_EMAIL_COUNT=0');
console.log('CALENDAR_EVENT_COUNT=1');
console.log('MEET_COUNT=1');
console.log('DUPLICATE_CONFIRM_IDEMPOTENCY=PASS');
console.log('RESCHEDULE_PERSIST_BEFORE_EMAIL=PASS');
console.log('PAYMENT_PRESERVED_AFTER_RESCHEDULE=PASS');
console.log('DUPLICATE_CALENDAR_AFTER_RESCHEDULE=0');
console.log('STALE_RESCHEDULE_REJECTED=PASS');
console.log('CANCEL_CAPACITY_RELEASE=PASS');
console.log('CANCEL_PAYMENT_HISTORY_PRESERVED=PASS');
console.log('NORMAL_CANCEL_FLOW_REFUND_CALLS=0');
console.log('MANUAL_REVIEW_NOTIFICATION_COUNT=1');
console.log('SESSION_CANCELLED_ALLOWED=YES');
console.log('PATIENT_CANCELLED_EMAIL_COUNT_UNDER_TBD=0');
console.log('LATE_PAID_NO_SLOT_RECLAIM=PASS');
console.log('LATE_PAID_SYSTEM_REFUND_ATTEMPT_COUNT=1');
console.log('LATE_PAID_REFUND_IDEMPOTENCY=PASS');
console.log('REAL_NETWORK_SIDE_EFFECTS=0');

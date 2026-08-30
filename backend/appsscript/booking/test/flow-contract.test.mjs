import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createFixedDate } from './helpers/fixed-date.mjs';

const FixedDate = createFixedDate();

const sources = await Promise.all(['../Code.js', '../Lifecycle.js', '../CalendarGateway.js']
  .map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const allowlisted = 'qa+nonprod@example.test';
const secret = 'synthetic-status-secret';
const propertyValues = {
  APP_ENV: 'nonprod', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://sandbox.flow.cl/api', FLOW_RETURN_URL: 'https://preview-example.pages.dev/pago-resultado',
  FLOW_CONFIRMATION_URL: 'https://preview-example.pages.dev/api/flow-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: allowlisted, PATIENT_EMAIL_RECIPIENT_ALLOWLIST: allowlisted,
  IDEMPOTENCY_NAMESPACE: 'fran-nonprod-20260821', STATUS_TOKEN_SECRET: secret,
};
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const digestBytes = (value) => {
  const text = String(value);
  if (text === 'synthetic-store') return bytes(Buffer.from('390f55363168', 'hex'));
  if (text === 'synthetic-calendar') return bytes(Buffer.from('6c0535f4450c', 'hex'));
  return bytes(createHash('sha256').update(text).digest());
};

let headers = [];
let rows = [];
let lastFetch = null;
let fetchImpl = null;
const sheet = {
  getLastRow: () => 1 + rows.length,
  getLastColumn: () => headers.length,
  getRange: (row, col) => ({
    getDisplayValues: () => [headers],
    setValue: (value) => {
      if (row === 1) return;
      const record = rows[row - 2];
      if (!record) return;
      record[headers[col - 1]] = value;
    },
    setValues: () => {},
  }),
  getDataRange: () => ({ getValues: () => [headers, ...rows.map((record) => headers.map((header) => record[header] ?? ''))] }),
  appendRow: (row) => {
    const record = {};
    headers.forEach((header, index) => { record[header] = row[index] == null ? '' : String(row[index]); });
    rows.push(record);
  },
};

const context = {
  console, Date: FixedDate, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math, encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
    computeDigest: (_algorithm, value) => digestBytes(value),
    computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
  },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...propertyValues }) }) },
  SpreadsheetApp: { openById: () => ({ getId: () => 'synthetic-store', getSheetByName: () => sheet }) },
  CalendarApp: { getCalendarById: (id) => ({ getId: () => id }) },
  Calendar: {
    Freebusy: { query: (resource) => ({ calendars: { 'synthetic-calendar': { busy: [] } } }) },
    Events: { list: () => ({ items: [] }), get: () => null, insert: () => ({ id: 'event-1', etag: 'e1', updated: '2026-08-27T15:00:00.000Z' }) },
  },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  UrlFetchApp: {
    fetch: (url, options) => {
      lastFetch = { url, options };
      if (typeof fetchImpl === 'function') return fetchImpl(url, options);
      throw new Error('fetchImpl missing');
    },
  },
  MailApp: { sendEmail: () => { throw new Error('mail must not be called'); } },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);
headers = [...context.RESERVATION_HEADERS];
const flow = context.__FLOW_PAYMENT_TEST_EXPORTS__;
const phase = context.__PHASE_A_TEST_EXPORTS__;

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

const idempotencyKey = 'fran-nonprod-20260821-123e4567-e89b-12d3-a456-426614174000';
const payload = {
  action: 'create_flow_payment', idempotencyKey, serviceType: 'initial', modality: 'online',
  date: '2026-08-27', time: '11:00', name: 'Synthetic', email: allowlisted, phone: '', patientRut: '', reason: '', message: '',
};

// 1-3. commerceOrder contract
const order = flow.makeFlowCommerceOrder_(idempotencyKey);
check(order.length <= flow.FLOW_COMMERCE_ORDER_MAX_LENGTH, 'commerceOrder length <= 45');
check(flow.validCommerceOrder_(order), 'commerceOrder matches npo-<40hex> contract');
const legacyOrder = phase.makeOpaqueId_('order', idempotencyKey);
check(legacyOrder.length > flow.FLOW_COMMERCE_ORDER_MAX_LENGTH, 'legacy opaque order exceeded Flow length bound');

// 4-10. signed create request shape
fetchImpl = (url, options) => {
  check(url === 'https://sandbox.flow.cl/api/payment/create', 'Flow create uses sandbox /payment/create');
  check(options.method === 'post', 'Flow create uses POST');
  check(options.contentType === 'application/x-www-form-urlencoded', 'Flow create uses form encoding');
  const body = String(options.payload || '');
  const params = Object.fromEntries(body.split('&').map((part) => part.split('=').map(decodeURIComponent)));
  check(params.apiKey === 'synthetic-flow-key', 'apiKey included');
  check(params.amount === String(flow.NONPROD_FLOW_TEST_AMOUNT_CLP) && params.currency === 'CLP'
    && Number(params.amount) === 500 && Number(params.amount) > 350, 'amount/currency representation uses NONPROD sandbox minimum-safe 500 CLP');
  check(params.commerceOrder === order, 'commerceOrder in body');
  check(params.subject === 'NONPROD booking', 'subject present');
  check(params.email === allowlisted, 'email present');
  check(params.urlConfirmation === propertyValues.FLOW_CONFIRMATION_URL, 'urlConfirmation');
  check(params.urlReturn.startsWith(propertyValues.FLOW_RETURN_URL + '?st='), 'urlReturn with status token');
  check(!Object.prototype.hasOwnProperty.call(params, 'optional'), 'optional payload omitted');
  const unsigned = { ...params }; delete unsigned.s;
  const expected = flow.signFlowParams_(unsigned, 'synthetic-flow-secret');
  check(params.s === expected, 'HMAC signature matches sorted key+value contract');
  const keys = body.split('&').map((part) => decodeURIComponent(part.split('=')[0]));
  check(JSON.stringify(keys) === JSON.stringify([...keys].sort()), 'form body keys are sorted');
  return {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ url: 'https://sandbox.flow.cl/app/web/pay', token: 'FLOWTOKENOPAQUE1234567890' }),
  };
};
rows = [];
const created = context.createFlowPayment_({ postData: { contents: JSON.stringify(payload) } });
check(created.ok && created.paymentUrl.startsWith('https://sandbox.flow.cl/app/web/pay?token=')
  && /^fran-nonprod-20260821-st-[0-9a-f]{32}$/i.test(created.publicStatusToken), 'token response parsing and payment URL construction');
check(flow.NONPROD_FLOW_TEST_AMOUNT_CLP === 500, 'canonical NONPROD_FLOW_TEST_AMOUNT_CLP is 500');
const signedBody = Object.fromEntries(String(lastFetch.options.payload).split('&').map((part) => part.split('=').map(decodeURIComponent)));
check(signedBody.amount === '500' && signedBody.s === flow.signFlowParams_({
  amount: signedBody.amount, apiKey: signedBody.apiKey, commerceOrder: signedBody.commerceOrder,
  currency: signedBody.currency, email: signedBody.email, subject: signedBody.subject,
  urlConfirmation: signedBody.urlConfirmation, urlReturn: signedBody.urlReturn,
}, 'synthetic-flow-secret'), 'request signature includes the 500 amount correctly');
check(flow.nonprodRefundAmountClp_() === '500', 'refund synthetic amount derives from NONPROD paid amount');
const status = flow.paymentStatus_({ parameter: { st: created.publicStatusToken } });
check(status.ok && status.amount === 500 && status.currency === 'CLP', 'public payment status returns amount 500');

// 11. HTTP 4xx classification + failure recovery
rows = [];
fetchImpl = () => ({
  getResponseCode: () => 400,
  getContentText: () => JSON.stringify({ code: 1807, message: 'sensitive-should-not-persist' }),
});
const failed = context.createFlowPayment_({
  postData: { contents: JSON.stringify({ ...payload, idempotencyKey: 'fran-nonprod-20260821-123e4567-e89b-12d3-a456-426614174001' }) },
});
check(failed.ok === false && failed.code === 'FLOW_CREATE_FAILED', 'public response stays FLOW_CREATE_FAILED');
check(rows.length === 1, 'failed create retains exactly one datastore row');
check(rows[0].payment_status === 'failed' && rows[0].booking_status === 'manual_review'
  && rows[0].schedule_status === 'cancelled', 'failed create releases hold and marks recoverable states');
check(rows[0].reconciliation_state === 'flow_create_flow_provider_rejected', 'safe diagnostic class persisted');
check(String(rows[0].refund_last_error_code).includes('1807')
  && !JSON.stringify(rows[0]).includes('sensitive-should-not-persist')
  && !JSON.stringify(rows[0]).includes('synthetic-flow-secret')
  && !JSON.stringify(rows[0]).includes('synthetic-flow-key'), 'provider code kept without secrets/raw message');

// 12. same idempotency cannot create duplicate Flow order
fetchImpl = () => { throw new Error('must not call Flow on replay'); };
const replay = context.createFlowPayment_({
  postData: { contents: JSON.stringify({ ...payload, idempotencyKey: 'fran-nonprod-20260821-123e4567-e89b-12d3-a456-426614174001' }) },
});
check(replay.ok === false && replay.code === 'FLOW_CREATE_FAILED' && rows.length === 1, 'same idempotency key cannot create duplicate Flow orders');

// 13. failed row does not consume availability-active states
check(context.ACTIVE_SLOT_STATES.indexOf('manual_review') === -1
  && context.ACTIVE_SLOT_STATES.indexOf('cancelled') === -1, 'failed/manual-review does not permanently consume availability');

// 14. malformed/non-JSON response
rows = [];
fetchImpl = () => ({ getResponseCode: () => 200, getContentText: () => '<html>nope</html>' });
const badJson = context.createFlowPayment_({
  postData: { contents: JSON.stringify({ ...payload, idempotencyKey: 'fran-nonprod-20260821-123e4567-e89b-12d3-a456-426614174002' }) },
});
check(badJson.code === 'FLOW_CREATE_FAILED' && rows[0].reconciliation_state === 'flow_create_flow_bad_response',
  'malformed provider response classified safely');

// 15. network failure
rows = [];
fetchImpl = () => { throw new Error('socket hang up'); };
const network = context.createFlowPayment_({
  postData: { contents: JSON.stringify({ ...payload, idempotencyKey: 'fran-nonprod-20260821-123e4567-e89b-12d3-a456-426614174003' }) },
});
check(network.code === 'FLOW_CREATE_FAILED' && rows[0].reconciliation_state === 'flow_create_flow_network',
  'network failure classified safely');

// 16. operator abandon without delete / public route
const abandoned = flow.abandonFailedNonprodCheckout_(rows[0].reservation_id);
check(abandoned.ok && rows[0].booking_status === 'cancelled' && rows[0].reconciliation_state === 'flow_create_abandoned',
  'operator-safe abandon marks terminal cleanup without deletion');
assert.throws(() => flow.abandonFailedNonprodCheckout_(rows[0].reservation_id), /BOOKING_NOT_RETRYABLE/);
assertions += 1;

console.log(`FLOW_CONTRACT_TESTS=PASS assertions=${assertions}`);
console.log('REAL_FLOW_CALLS=0');

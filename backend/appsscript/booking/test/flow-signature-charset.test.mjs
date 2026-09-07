/**
 * Flow API signature encoding contract.
 *
 * Production defect (2026-09-07): every booking-path `payment/create` was rejected
 * by Flow, at CLP 500 and at CLP 50000 alike, while standalone provider probes
 * with ASCII-only subjects succeeded. Root cause, proven on the real Apps Script
 * V8 runtime with synthetic inputs: the two-argument String overload of
 * `Utilities.computeHmacSha256Signature` encodes as US-ASCII, mapping every
 * non-ASCII character to '?'. The app signed "Sesi?n Francisca Bustos" while the
 * body carried the UTF-8 bytes of "Sesión Francisca Bustos", so Flow's own
 * HMAC over the decoded UTF-8 bytes could never match.
 *
 * Contract pinned here: every Flow API signature is computed over UTF-8 bytes,
 * by passing Utilities.Charset.UTF_8 explicitly. The oracle is an independent
 * Node HMAC, never the signer under test; the Utilities stub reproduces the
 * digests measured on the runtime, and that fidelity is asserted first.
 *
 * Deterministic: no network, no mail, no Flow.
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createFixedDate } from './helpers/fixed-date.mjs';
import {
  Charset, createUtilitiesStub, encodeForCharset, flowSignatureOracle, runtimeProbe, toHex,
} from './helpers/apps-script-utilities.mjs';

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

const FILES = ['Code.js', 'Lifecycle.js', 'EmailTemplates.js', 'CalendarGateway.js', 'RefundGateway.js'];
const SOURCE = Object.fromEntries(await Promise.all(FILES.map(async (name) => [
  name, await readFile(new URL('../' + name, import.meta.url), 'utf8'),
])));

const SECRET = 'synthetic-flow-secret';
const API_KEY = 'synthetic-flow-key';
const properties = {
  APP_ENV: 'production', FLOW_API_KEY: API_KEY, FLOW_SECRET_KEY: SECRET,
  FLOW_BASE_URL: 'https://www.flow.cl/api', FLOW_RETURN_URL: 'https://franciscabustos.cl/pago-resultado',
  FLOW_CONFIRMATION_URL: 'https://franciscabustos.cl/api/flow-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: 'ops@example.test',
  IDEMPOTENCY_NAMESPACE: 'fran-booking', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
};
const digestOverride = (text) => {
  if (text === 'synthetic-store') return Buffer.from('390f55363168', 'hex');
  if (text === 'synthetic-calendar') return Buffer.from('6c0535f4450c', 'hex');
  return null;
};
const decodeBody = (body) => Object.fromEntries(String(body).split('&').map((part) => part.split('=').map(decodeURIComponent)));

/**
 * One Apps Script context. `patches` rewrites source before it enters the VM so
 * the mutation half of this file can break exactly one signer at a time.
 */
function buildContext(patches) {
  const hmacCalls = [];
  const fetches = [];
  const context = {
    console, Date: createFixedDate(), Intl, Set, Number, String, Object, Array, JSON, RegExp, Math,
    encodeURIComponent, decodeURIComponent,
    Utilities: createUtilitiesStub({ getUuid: randomUUID, digestOverride, onHmac: (call) => hmacCalls.push(call) }),
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...properties }) }) },
    SpreadsheetApp: { openById: () => ({ getId: () => 'synthetic-store', getSheetByName: () => null }) },
    CalendarApp: { getCalendarById: (id) => ({ getId: () => id }) },
    Calendar: { Freebusy: { query: () => ({ calendars: {} }) }, Events: { list: () => ({ items: [] }) } },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetch: (url, options) => {
        fetches.push({ url: String(url), options });
        if (String(url).includes('/payment/getStatus')) {
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ status: 2, amount: 500, currency: 'CLP', commerceOrder: 'x' }) };
        }
        return { getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ url: 'https://www.flow.cl/app/web/pay', token: 'FLOWTOKENCHARSET01' }) };
      },
    },
    MailApp: { sendEmail: () => { throw new Error('mail must not be called'); } },
  };
  vm.createContext(context);
  FILES.forEach((name) => {
    let text = SOURCE[name];
    ((patches && patches[name]) || []).forEach(([find, replace]) => {
      if (text.indexOf(find) === -1) throw new Error('mutation anchor missing in ' + name + ': ' + find);
      text = text.split(find).join(replace);
    });
    vm.runInContext(text, context);
  });
  return { context, hmacCalls, fetches, config: context.readConfig_() };
}

const KEY = 'fran-booking-123e4567-e89b-12d3-a456-426614174000';
const PAYLOAD = { email: 'hola@franciscabustos.cl', idempotencyKey: KEY };
const reservationAt = (ctx, amount) => ({
  transaction_amount_clp: String(amount),
  slot_hold_expires_at: new Date(ctx.context.Date.now() + 900000).toISOString(),
});

// ---------------------------------------------------------------------------
// 0. The stub is faithful to the runtime probe before it is trusted as an oracle.
// ---------------------------------------------------------------------------
{
  const u = createUtilitiesStub();
  check(toHex(u.computeHmacSha256Signature(runtimeProbe.value, runtimeProbe.key)) === runtimeProbe.implicitHex,
    'stub: implicit overload reproduces the runtime digest for "Sesión"');
  check(toHex(u.computeHmacSha256Signature(runtimeProbe.value, runtimeProbe.key, u.Charset.US_ASCII)) === runtimeProbe.implicitHex,
    'stub: explicit US_ASCII equals the implicit overload, as on the runtime');
  check(toHex(u.computeHmacSha256Signature(runtimeProbe.value, runtimeProbe.key, u.Charset.UTF_8)) === runtimeProbe.explicitUtf8Hex,
    'stub: explicit UTF_8 reproduces the runtime digest for "Sesión"');
  check(toHex(u.computeHmacSha256Signature(runtimeProbe.asciiControl, runtimeProbe.key)) === runtimeProbe.asciiControlHex,
    'stub: ASCII control "Sesion" reproduces the runtime digest');
  check(runtimeProbe.implicitHex !== runtimeProbe.explicitUtf8Hex, 'runtime: implicit and UTF-8 digests differ for "Sesión"');
  check(encodeForCharset('Sesión').toString('latin1') === 'Sesi?n', 'implicit encoding is "Sesi?n", the measured behaviour');
  check(runtimeProbe.explicitUtf8Hex === createHmac('sha256', 'k').update(Buffer.from('Sesión', 'utf8')).digest('hex'),
    'runtime UTF-8 digest equals an independent Node HMAC over the UTF-8 bytes');
}

// ---------------------------------------------------------------------------
// A. Non-ASCII control through the production signer.
// ---------------------------------------------------------------------------
const good = buildContext(null);
const NON_ASCII = { amount: '500', apiKey: API_KEY, commerceOrder: 'fp-' + '0'.repeat(40), currency: 'CLP',
  email: 'hola@franciscabustos.cl', subject: 'Sesión Francisca Bustos' };
{
  const expected = flowSignatureOracle(NON_ASCII, SECRET);
  const wrong = createHmac('sha256', SECRET).update(encodeForCharset(
    Object.keys(NON_ASCII).sort().map((k) => k + NON_ASCII[k]).join(''))).digest('hex');
  check(expected !== wrong, 'A: implicit (US-ASCII) semantics yield a different signature than Flow expects');
  check(good.context.signFlowParams_(NON_ASCII, SECRET) === expected, 'A: signFlowParams_ matches the UTF-8 oracle for "Sesión"');
  check(good.context.signFlowParams_(NON_ASCII, SECRET) !== wrong, 'A: signFlowParams_ is not the "Sesi?n" signature');
  const last = good.hmacCalls[good.hmacCalls.length - 1];
  check(last.charset === Charset.UTF_8, 'A: the signer asks the runtime for UTF-8 explicitly');
  check(last.value.includes('subjectSesión Francisca Bustos'), 'A: the signed string carries the real "ó", encoding happens at the runtime boundary');
}

// ---------------------------------------------------------------------------
// B. ASCII control: explicit UTF-8 does not change an ASCII-only signature.
// ---------------------------------------------------------------------------
{
  const ascii = { ...NON_ASCII, subject: 'Sesion Francisca Bustos' };
  const canonical = Object.keys(ascii).sort().map((k) => k + ascii[k]).join('');
  const viaAsciiBytes = createHmac('sha256', SECRET).update(encodeForCharset(canonical)).digest('hex');
  check(good.context.signFlowParams_(ascii, SECRET) === flowSignatureOracle(ascii, SECRET), 'B: ASCII subject matches the oracle');
  check(good.context.signFlowParams_(ascii, SECRET) === viaAsciiBytes, 'B: ASCII subject is byte-identical under either charset — no regression');
}

// ---------------------------------------------------------------------------
// C/D/E. payment/create at CLP 500 and CLP 50000: amount canonical, subject kept,
// signature over the exact logical values that are sent, signed keys == body
// keys minus `s`, body percent-encodes UTF-8 while the signed string does not.
// ---------------------------------------------------------------------------
function createAndInspect(ctx, amount) {
  const before = ctx.fetches.length;
  ctx.hmacCalls.length = 0;
  const result = ctx.context.createProductionFlowPayment_(ctx.config, PAYLOAD, reservationAt(ctx, amount), {});
  const fetch = ctx.fetches[ctx.fetches.length - 1];
  check(ctx.fetches.length === before + 1 && fetch.url === 'https://www.flow.cl/api/payment/create', `CLP${amount}: exactly one payment/create call`);
  const body = String(fetch.options.payload);
  const params = decodeBody(body);
  const unsigned = { ...params }; delete unsigned.s;
  const signCall = ctx.hmacCalls.find((call) => call.value.includes('commerceOrder'));
  return { result, body, params, unsigned, signCall };
}
for (const amount of [500, 50000]) {
  const wire = createAndInspect(good, amount);
  check(wire.result.token === 'FLOWTOKENCHARSET01', `CLP${amount}: create succeeds`);
  check(wire.params.amount === String(amount) && /^[1-9][0-9]*$/.test(wire.params.amount), `CLP${amount}: amount canonical on the wire`);
  check(wire.params.currency === 'CLP', `CLP${amount}: currency CLP`);
  check(wire.params.subject === 'Sesión Francisca Bustos', `CLP${amount}: subject retains "Sesión"`);
  check(wire.body.includes('subject=Sesi%C3%B3n%20Francisca%20Bustos'), `CLP${amount}: body percent-encodes the UTF-8 bytes of "ó"`);
  check(wire.params.s === flowSignatureOracle(wire.unsigned, SECRET), `CLP${amount}: transmitted signature equals the independent UTF-8 oracle over the transmitted body`);
  check(wire.signCall && wire.signCall.charset === Charset.UTF_8, `CLP${amount}: runtime asked for UTF-8 explicitly`);
  const canonical = Object.keys(wire.unsigned).sort().map((k) => k + wire.unsigned[k]).join('');
  check(wire.signCall.value === canonical, `CLP${amount}: signed string is exactly the sorted key+value concatenation of the body minus "s"`);
  check(wire.signCall.value.includes('amount' + amount + 'apiKey'), `CLP${amount}: signed amount is the transmitted amount`);
  check(!wire.signCall.value.includes('%'), `CLP${amount}: signed string holds decoded values, percent-encoding is a transport-stage concern`);
  const expectedKeys = ['amount', 'apiKey', 'checkout_timeout', 'commerceOrder', 'currency', 'email', 's', 'subject', 'timeout', 'urlConfirmation', 'urlReturn'];
  check(JSON.stringify(Object.keys(wire.params).sort()) === JSON.stringify(expectedKeys), `CLP${amount}: POST key set unchanged`);
}

// ---------------------------------------------------------------------------
// F. Other Flow endpoints: payment/getStatus and the refund gateway sign over
// UTF-8 as well, and ASCII-only requests are unchanged.
// ---------------------------------------------------------------------------
{
  good.hmacCalls.length = 0;
  good.context.flowRequest_(good.config, '/payment/getStatus', { token: 'FLOWTOKENCHARSET01' }, 'get');
  const fetch = good.fetches[good.fetches.length - 1];
  const query = decodeBody(fetch.url.split('?')[1]);
  const unsigned = { ...query }; delete unsigned.s;
  check(query.s === flowSignatureOracle(unsigned, SECRET), 'F: payment/getStatus signature matches the oracle');
  check(good.hmacCalls[good.hmacCalls.length - 1].charset === Charset.UTF_8, 'F: payment/getStatus signer asks for UTF-8');

  const refundFetches = [];
  const gateway = good.context.createFlowRefundGateway_({
    apiKey: API_KEY, secretKey: SECRET,
    fetch: (url, request) => {
      refundFetches.push({ url, request });
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ token: 'REFUNDTOKEN01', status: 'pending' }) };
    },
  });
  good.hmacCalls.length = 0;
  gateway.create({ reservationId: 'reservation-synthetic-0001', receiverEmail: 'jose.muñoz@example.test', amount: '500',
    urlCallBack: 'https://franciscabustos.cl/api/refund-confirmation', commerceTrxId: 'fp-' + '0'.repeat(40) });
  const refundBody = decodeBody(refundFetches[0].request.payload);
  const refundUnsigned = { ...refundBody }; delete refundUnsigned.s;
  check(refundBody.receiverEmail === 'jose.muñoz@example.test', 'F: refund body carries the non-ASCII receiver verbatim');
  check(refundBody.s === flowSignatureOracle(refundUnsigned, SECRET), 'F: refund/create signature matches the UTF-8 oracle with a non-ASCII value');
  check(good.hmacCalls[good.hmacCalls.length - 1].charset === Charset.UTF_8, 'F: refund signer asks for UTF-8');
}

// ---------------------------------------------------------------------------
// G. Mutations: remove the explicit UTF_8 from each Flow signer. The outcome
// checks above must fail — the suite is only worth anything if it can.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  { name: 'MUTATION_CREATE_SIGNER_IMPLICIT_CHARSET', patches: { 'Code.js': [[
    'Utilities.computeHmacSha256Signature(toSign, secretKey, Utilities.Charset.UTF_8)',
    'Utilities.computeHmacSha256Signature(toSign, secretKey)']] },
    detect: (ctx) => {
      const wire = createAndInspect(ctx, 500);
      return wire.params.s !== flowSignatureOracle(wire.unsigned, SECRET) ? 'create_signature_mismatch' : null;
    } },
  { name: 'MUTATION_REFUND_SIGNER_IMPLICIT_CHARSET', patches: { 'RefundGateway.js': [[
    'Utilities.computeHmacSha256Signature(canonical, secretKey, Utilities.Charset.UTF_8)',
    'Utilities.computeHmacSha256Signature(canonical, secretKey)']] },
    detect: (ctx) => {
      const calls = [];
      const gateway = ctx.context.createFlowRefundGateway_({ apiKey: API_KEY, secretKey: SECRET,
        fetch: (url, request) => { calls.push(request); return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ token: 't', status: 'pending' }) }; } });
      gateway.create({ reservationId: 'reservation-synthetic-0001', receiverEmail: 'jose.muñoz@example.test', amount: '500',
        urlCallBack: 'https://franciscabustos.cl/api/refund-confirmation', commerceTrxId: 'fp-' + '0'.repeat(40) });
      const body = decodeBody(calls[0].payload); const unsigned = { ...body }; delete unsigned.s;
      return body.s !== flowSignatureOracle(unsigned, SECRET) ? 'refund_signature_mismatch' : null;
    } },
];
for (const mutation of MUTATIONS) {
  const mutated = buildContext(mutation.patches);
  const detectedBy = mutation.detect(mutated);
  check(Boolean(detectedBy), `${mutation.name} must be detected`);
  console.log(`${mutation.name}=DETECTED_BY[${detectedBy}]`);
}

console.log(`FLOW_SIGNATURE_CHARSET_TESTS=PASS assertions=${assertions}`);
console.log('FLOW_SIGNERS_EXPLICIT_UTF8=2/2 (signFlowParams_, refundSign_)');
console.log('SIGNED_STRING_EQUALS_BODY_MINUS_S=YES');
console.log('REAL_FLOW_CALLS=0');

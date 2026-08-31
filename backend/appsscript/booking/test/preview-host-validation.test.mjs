import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../Code.js', import.meta.url), 'utf8');
const origin = 'https://franciscabustos.cl';
const propertyValues = {
  APP_ENV: 'production', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://www.flow.cl/api', FLOW_RETURN_URL: origin + '/pago-resultado',
  FLOW_CONFIRMATION_URL: origin + '/api/flow-confirmation',
  FLOW_REFUND_CALLBACK_URL: origin + '/api/refund-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: 'ops@example.test',
  IDEMPOTENCY_NAMESPACE: 'fran-booking', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
  CAPABILITY_TOKEN_SECRET: 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz',
};
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const context = {
  console, Date, Set, Number, String, Object, Array, JSON, RegExp, Math,
  encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (_algorithm, value) => bytes(Buffer.from(String(value))),
  },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...propertyValues }) }) },
  UrlFetchApp: { fetch: () => { throw new Error('network must not be called'); } },
};
vm.createContext(context);
vm.runInContext(source, context);

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const rejectsConfiguration = (fn, message) => {
  assert.throws(fn, (error) => error && error.code === 'CONFIGURATION_INCOMPLETE', message);
  assertions += 1;
};

context.assertProductionRoute_('https://franciscabustos.cl/pago-resultado', '/pago-resultado');
assertions += 1;
context.assertProductionRoute_('https://www.franciscabustos.cl/pago-resultado', '/pago-resultado');
assertions += 1;

check(context.readConfig_().flowReturnUrl === origin + '/pago-resultado', 'FLOW_RETURN_URL accepts the production site');
check(context.readConfig_().flowConfirmationUrl === origin + '/api/flow-confirmation',
  'FLOW_CONFIRMATION_URL accepts the production site');
check(context.readRefundConfig_().refundCallbackUrl === origin + '/api/refund-confirmation',
  'FLOW_REFUND_CALLBACK_URL accepts the production site');

const refundSource = await readFile(new URL('../RefundGateway.js', import.meta.url), 'utf8');
vm.runInContext(refundSource, context);
check(context.__REFUND_TEST_EXPORTS__.validRefundCallbackUrl_(origin + '/api/refund-confirmation'),
  'refund gateway accepts production callback URL');
check(!context.__REFUND_TEST_EXPORTS__.validRefundCallbackUrl_('https://example.com/api/refund-confirmation'),
  'refund gateway rejects foreign callback URL');
check(!context.__REFUND_TEST_EXPORTS__.validRefundCallbackUrl_('https://preview.pages.dev/api/refund-confirmation'),
  'refund gateway rejects pages.dev callback URL');

check(context.previewOriginFromConfig_({ flowReturnUrl: origin + '/pago-resultado' }) === origin,
  'previewOriginFromConfig_ returns the canonical production origin');

const managementUrl = context.managementPageUrl_(origin, 'a'.repeat(64), 'cancel');
check(managementUrl === origin + '/manage.html?token=' + 'a'.repeat(64) + '&open=cancel',
  'managementPageUrl_ accepts the production origin');

rejectsConfiguration(() => context.assertProductionRoute_(origin + '/wrong-path', '/pago-resultado'),
  'wrong required path is rejected');
rejectsConfiguration(() => context.assertProductionRoute_('https://example.com/pago-resultado', '/pago-resultado'),
  'foreign host is rejected');
rejectsConfiguration(() => context.assertProductionRoute_('https://foo.pages.dev/pago-resultado', '/pago-resultado'),
  'pages.dev host is rejected');
rejectsConfiguration(() => context.assertProductionRoute_('http://franciscabustos.cl/pago-resultado', '/pago-resultado'),
  'http is rejected');
for (const host of ['franciscabustos.cl.evil.com', 'evilfranciscabustos.cl']) {
  rejectsConfiguration(() => context.assertProductionRoute_('https://' + host + '/pago-resultado', '/pago-resultado'),
    'malicious suffix/prefix is rejected: ' + host);
}

assert.equal(context.managementPageUrl_(origin + '/', 'b'.repeat(64), 'reschedule'),
  origin + '/manage.html?token=' + 'b'.repeat(64) + '&open=reschedule',
  'management origin trailing slash remains supported');
assertions += 1;

console.log(`PRODUCTION_HOST_VALIDATION_TESTS=PASS assertions=${assertions}`);

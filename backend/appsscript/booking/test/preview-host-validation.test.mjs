import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../Code.js', import.meta.url), 'utf8');
const previewOrigin = 'https://nonprod-booking-20260822.franciscabustos.pages.dev';
const allowlisted = 'qa+nonprod@example.test';
const propertyValues = {
  APP_ENV: 'nonprod', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://sandbox.flow.cl/api', FLOW_RETURN_URL: previewOrigin + '/pago-resultado',
  FLOW_CONFIRMATION_URL: previewOrigin + '/api/flow-confirmation',
  FLOW_REFUND_CALLBACK_URL: previewOrigin + '/api/refund-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: allowlisted, PATIENT_EMAIL_RECIPIENT_ALLOWLIST: allowlisted,
  IDEMPOTENCY_NAMESPACE: 'fran-nonprod-20260821', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
  CAPABILITY_TOKEN_SECRET: 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz',
};
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const context = {
  console, Date, Set, Number, String, Object, Array, JSON, RegExp, Math,
  encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (_algorithm, value) => {
      if (String(value) === 'synthetic-store') return bytes(Buffer.from('390f55363168', 'hex'));
      if (String(value) === 'synthetic-calendar') return bytes(Buffer.from('6c0535f4450c', 'hex'));
      return bytes(createHash('sha256').update(String(value)).digest());
    },
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

// 1. A direct Pages project origin remains valid.
context.assertPreviewRoute_('https://foo.pages.dev/pago-resultado', '/pago-resultado');
assertions += 1;

// 2. Branch aliases with project and branch labels are valid.
context.assertPreviewRoute_(previewOrigin + '/pago-resultado', '/pago-resultado');
assertions += 1;

// 3-5. All configured Flow callback routes accept the branch alias.
check(context.readConfig_().flowReturnUrl === previewOrigin + '/pago-resultado',
  'FLOW_RETURN_URL accepts the branch alias');
check(context.readConfig_().flowConfirmationUrl === previewOrigin + '/api/flow-confirmation',
  'FLOW_CONFIRMATION_URL accepts the branch alias');
check(context.readRefundConfig_().refundCallbackUrl === previewOrigin + '/api/refund-confirmation',
  'FLOW_REFUND_CALLBACK_URL accepts the branch alias');

// Refund gateway callback validator must accept the same branch Preview origin.
const refundSource = await readFile(new URL('../RefundGateway.js', import.meta.url), 'utf8');
vm.runInContext(refundSource, context);
check(context.__REFUND_TEST_EXPORTS__.validRefundCallbackUrl_(previewOrigin + '/api/refund-confirmation'),
  'refund gateway accepts branch Preview callback URL');
check(!context.__REFUND_TEST_EXPORTS__.validRefundCallbackUrl_('https://example.com/api/refund-confirmation'),
  'refund gateway rejects non-Preview callback URL');


// 6. The derived origin preserves every valid DNS label.
check(context.previewOriginFromConfig_({ flowReturnUrl: previewOrigin + '/pago-resultado' }) === previewOrigin,
  'previewOriginFromConfig_ returns the full branch.project.pages.dev origin');

// 7. Management URLs use the same validated branch origin.
const managementUrl = context.managementPageUrl_(previewOrigin, 'a'.repeat(64), 'cancel');
check(managementUrl === previewOrigin + '/manage.html?token=' + 'a'.repeat(64) + '&open=cancel',
  'managementPageUrl_ accepts the branch alias');

// 8-12. Path, scheme, host shape, and malicious suffix/prefix remain fail-closed.
rejectsConfiguration(() => context.assertPreviewRoute_(previewOrigin + '/wrong-path', '/pago-resultado'),
  'wrong required path is rejected');
rejectsConfiguration(() => context.assertPreviewRoute_('https://example.com/pago-resultado', '/pago-resultado'),
  'non-pages.dev host is rejected');
for (const host of ['bad_label.pages.dev', '-bad.pages.dev', 'bad-.pages.dev']) {
  rejectsConfiguration(() => context.assertPreviewRoute_('https://' + host + '/pago-resultado', '/pago-resultado'),
    'malformed host is rejected: ' + host);
}
rejectsConfiguration(() => context.assertPreviewRoute_('http://foo.pages.dev/pago-resultado', '/pago-resultado'),
  'http is rejected');
for (const host of ['pages.dev.evil.com', 'evilpages.dev']) {
  rejectsConfiguration(() => context.assertPreviewRoute_('https://' + host + '/pago-resultado', '/pago-resultado'),
    'malicious suffix/prefix is rejected: ' + host);
}

assert.equal(context.managementPageUrl_(previewOrigin + '/', 'b'.repeat(64), 'reschedule'),
  previewOrigin + '/manage.html?token=' + 'b'.repeat(64) + '&open=reschedule',
  'management origin trailing slash remains supported');
assertions += 1;

console.log(`PREVIEW_HOST_VALIDATION_TESTS=PASS assertions=${assertions}`);

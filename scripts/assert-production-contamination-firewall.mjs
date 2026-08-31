import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFiles = [
  'backend/appsscript/booking/Code.js',
  'backend/appsscript/booking/Lifecycle.js',
  'backend/appsscript/booking/EmailTemplates.js',
  'backend/appsscript/booking/CalendarGateway.js',
  'backend/appsscript/booking/Reconciliation.js',
  'backend/appsscript/booking/RefundGateway.js',
  '_worker.js',
  'assets/booking.js',
  'pago-resultado.html',
  'manage.html',
  'reserva.html',
];
const forbidden = [
  'NONPROD_FLOW_TEST_AMOUNT_CLP',
  'TargetedFixture',
  'nonprodRunIsolatedPostPaidLifecycle',
  'SYNTHETIC_FULL',
  'fran-nonprod',
  "APP_ENV = 'nonprod'",
  'reservations_nonprod',
  'notification_outbox_nonprod',
];

const texts = {};
for (const rel of runtimeFiles) {
  texts[rel] = await readFile(path.join(root, rel), 'utf8');
}

for (const [rel, text] of Object.entries(texts)) {
  for (const needle of forbidden) {
    assert.equal(text.includes(needle), false, `${rel} must not contain ${needle}`);
  }
  assert.equal(/APP_ENV:\s*'nonprod'/.test(text), false, `${rel} must not accept APP_ENV=nonprod`);
}

const code = texts['backend/appsscript/booking/Code.js'];
const worker = texts['_worker.js'];
assert.match(code, /appEnv: 'production'/);
assert.match(code, /flowHost: 'www\.flow\.cl'/);
assert.match(code, /idempotencyNamespace: 'fran-booking'/);
assert.match(code, /sandbox\\.flow\\.cl/);
assert.equal(code.includes('https://sandbox.flow.cl/api'), false);
assert.match(worker, /env\.APPS_SCRIPT_WEB_APP_URL/);
assert.equal(/APPS_SCRIPT_WEB_APP_URL\s*=\s*['"]https?:/.test(worker), false,
  'worker must not hardcode an Apps Script URL fallback');
assert.match(worker, /env\.APP_ENV !== 'production'/);

const bookingDir = path.join(root, 'backend/appsscript/booking');
const bookingFiles = await readdir(bookingDir);
assert.equal(bookingFiles.includes('Código.js'), false, 'v7 monolith must not remain in the clasp folder');
assert.equal(bookingFiles.includes('TargetedFixture.js'), false,
  'TargetedFixture.js must not be present in the Production clasp folder');

console.log('NONPROD_CONTAMINATION_FIREWALL=PASS');

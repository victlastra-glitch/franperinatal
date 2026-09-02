import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bookingDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(bookingDir, '../../..');
const expected = [
  'Code.js',
  'Lifecycle.js',
  'EmailTemplates.js',
  'CalendarGateway.js',
  'Reconciliation.js',
  'RefundGateway.js',
  'appsscript.json',
];
const forbidden = ['Código.js', 'TargetedFixture.js'];
const entries = await readdir(bookingDir);
for (const name of expected) {
  assert.equal(entries.includes(name), true, `missing clasp runtime file ${name}`);
}
for (const name of forbidden) {
  assert.equal(entries.includes(name), false, `${name} must not be in the clasp folder`);
}
const extraJs = entries.filter((name) => name.endsWith('.js') && !expected.includes(name));
assert.deepEqual(extraJs, [], `unexpected JS beside the modular runtime: ${extraJs.join(',')}`);

const runbook = await readFile(path.join(root, 'docs/production/PRODUCTION_RC_RUNBOOK.md'), 'utf8');
assert.match(runbook, /clasp list|remote Apps Script files|FILESET/);
assert.match(runbook, /Código\.js/);
assert.match(runbook, /TargetedFixture/);
assert.match(runbook, /schema dry-run|productionSchemaMigrationDryRun_/);
assert.match(runbook, /installProductionLifecycleTriggers_/);
assert.match(runbook, /FLOW_PROVIDER_MICRO_E2E/);
assert.match(runbook, /BOOKING_APPLICATION_E2E/);
assert.match(runbook, /INITIAL_PRICE_CLP=50000|50000 \/ 50000/);

console.log('CLASP_REMOTE_FILESET_RELEASE_GATE=PASS');
console.log('TRIGGER_RELEASE_SEQUENCE=PASS');
console.log('FLOW_TEST_PLAN_SEPARATION=PASS');

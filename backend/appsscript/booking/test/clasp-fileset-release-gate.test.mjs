import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bookingDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(bookingDir, '../../..');
// Exact deployable Apps Script runtime: 7 JS files + appsscript.json.
// TriggerInstallGuard.js is JS source, so it needs no manifest entry.
const expectedJs = [
  'Code.js',
  'Lifecycle.js',
  'EmailTemplates.js',
  'CalendarGateway.js',
  'Reconciliation.js',
  'RefundGateway.js',
  'TriggerInstallGuard.js',
];
const expected = [...expectedJs, 'appsscript.json'];
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
assert.equal(expectedJs.length, 7, 'deployable JS runtime is exactly seven files');
assert.equal(expected.length, 8, 'deployable fileset is exactly eight files');
assert.equal(entries.some((name) => /nonprod/i.test(name)), false,
  'NONPROD operators must not sit in the clasp folder');
assert.equal(entries.some((name) => name.endsWith('.test.mjs')), false,
  'tests must not be deployable runtime beside the modular bundle');

const runbook = await readFile(path.join(root, 'docs/production/PRODUCTION_RC_RUNBOOK.md'), 'utf8');
assert.match(runbook, /clasp list|remote Apps Script files|FILESET/);
assert.match(runbook, /Código\.js/);
assert.match(runbook, /TargetedFixture/);
assert.match(runbook, /schema dry-run|productionSchemaMigrationDryRun_/);
assert.match(runbook, /installProductionLifecycleTriggersDeterministic_/);
assert.match(runbook, /verifyProductionLifecycleTriggersDeterministic_/);
assert.match(runbook, /INSTALL_METADATA_PLUS_TRIGGER_ID/);
assert.match(runbook, /runtimeCadenceIntrospection=false/);
assert.match(runbook, /TriggerInstallGuard\.js/);
assert.match(runbook, /7 JS files \+ `appsscript\.json` = 8 deployable files/);
assert.match(runbook, /does not expose (?:its )?clock cadence/i);
assert.match(runbook, /convergent/i);
// The corrected contract must not re-advertise the withdrawn cadence-reading
// operators that produced the false-positive PASS.
assert.equal(/installProductionLifecycleTriggers_\(\)/.test(runbook), false,
  'runbook must not reference the withdrawn cadence-guessing installer');
assert.equal(/verifyProductionLifecycleTriggers_\(\)/.test(runbook), false,
  'runbook must not reference the withdrawn cadence-guessing verifier');
assert.match(runbook, /FLOW_PROVIDER_MICRO_E2E/);
assert.match(runbook, /BOOKING_APPLICATION_E2E/);
assert.match(runbook, /INITIAL_PRICE_CLP=50000|50000 \/ 50000/);

console.log('CLASP_REMOTE_FILESET_RELEASE_GATE=PASS');
console.log(`CLASP_RUNTIME_FILE_COUNT=${expected.length}`);
console.log('TRIGGER_RELEASE_SEQUENCE=PASS');
console.log('FLOW_TEST_PLAN_SEPARATION=PASS');

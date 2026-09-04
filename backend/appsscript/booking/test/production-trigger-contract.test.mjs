/**
 * Production lifecycle trigger contract.
 *
 * The synthetic Trigger objects below deliberately expose ONLY the public
 * methods a real installed Apps Script Trigger has that this contract needs:
 * getHandlerFunction(), getUniqueId(), getTriggerSource(). They must never
 * carry a `.minutes` property or a `getEveryMinutes()` method, because a real
 * Trigger cannot report its clock cadence back to the runtime. Cadence proof
 * is therefore install-time only: the TriggerBuilder mock records the
 * everyMinutes(...) argument in a separate TEST-ONLY array.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const files = ['../Code.js', '../Lifecycle.js', '../EmailTemplates.js', '../TriggerInstallGuard.js'];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const guardSource = sources[files.indexOf('../TriggerInstallGuard.js')];

const secretPropertyValues = {
  APP_ENV: 'production', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://www.flow.cl/api', FLOW_RETURN_URL: 'https://franciscabustos.cl/pago-resultado',
  FLOW_CONFIRMATION_URL: 'https://franciscabustos.cl/api/flow-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: 'ops@example.test',
  IDEMPOTENCY_NAMESPACE: 'fran-booking', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
};
const scriptProperties = { ...secretPropertyValues };

const TRIGGER_SOURCE = Object.freeze({ CLOCK: 'CLOCK', SPREADSHEETS: 'SPREADSHEETS', FORMS: 'FORMS' });
const projectTriggers = [];
// TEST-ONLY cadence ledger. The runtime never reads this; it exists so the
// test can prove the installer asked for everyMinutes(5).
const builderCadenceCalls = [];
let uniqueIdSeq = 0;

// Realistic public Trigger surface only: no cadence property, no cadence getter.
const makeTrigger = (handler, source, uniqueId) => {
  const id = String(uniqueId || `synthetic-trigger-id-${(uniqueIdSeq += 1)}`);
  const triggerSource = String(source || TRIGGER_SOURCE.CLOCK);
  return Object.freeze({
    getHandlerFunction: () => handler,
    getUniqueId: () => id,
    getTriggerSource: () => triggerSource,
  });
};

const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const context = {
  console, Date, Set, Number, String, Object, Array, JSON, RegExp, Math,
  encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
    computeDigest: (_algorithm, value) => bytes(createHash('sha256').update(String(value)).digest()),
    computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperties: () => ({ ...scriptProperties }),
      getProperty: (key) => (Object.prototype.hasOwnProperty.call(scriptProperties, key)
        ? scriptProperties[key] : null),
      setProperty: (key, value) => { scriptProperties[key] = String(value); },
      deleteProperty: (key) => { delete scriptProperties[key]; },
    }),
  },
  Logger: { log: () => {} },
  ScriptApp: {
    TriggerSource: TRIGGER_SOURCE,
    getProjectTriggers: () => projectTriggers.slice(),
    newTrigger: (handler) => ({
      timeBased: () => ({
        everyMinutes: (minutes) => {
          builderCadenceCalls.push({ handler, minutes });
          return {
            create: () => {
              const trigger = makeTrigger(handler, TRIGGER_SOURCE.CLOCK);
              projectTriggers.push(trigger);
              return trigger;
            },
          };
        },
      }),
    }),
    // Deletes exactly the addressed trigger. Never matches by handler name, so
    // an installer that loses track of unique IDs cannot accidentally pass.
    deleteTrigger: (trigger) => {
      const index = projectTriggers.findIndex((item) => item.getUniqueId() === trigger.getUniqueId());
      if (index >= 0) projectTriggers.splice(index, 1);
    },
  },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);
const guard = context.__TRIGGER_INSTALL_GUARD_TEST_EXPORTS__;
const worker = context.__NOTIFICATION_OUTBOX_TEST_EXPORTS__;
assert.ok(guard && worker, 'trigger install guard exports must be available');

const NOTIFICATION_HANDLER = worker.PRODUCTION_NOTIFICATION_RETRY_HANDLER;
const CALENDAR_HANDLER = worker.PRODUCTION_CALENDAR_RECONCILIATION_HANDLER;
const TARGET_HANDLERS = [NOTIFICATION_HANDLER, CALENDAR_HANDLER];
const META_PROPERTY = guard.PRODUCTION_LIFECYCLE_TRIGGER_INSTALL_META_PROPERTY;

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const currentFor = (handler) => projectTriggers.filter((trigger) => trigger.getHandlerFunction() === handler);
const ids = () => projectTriggers.map((trigger) => trigger.getUniqueId());
const creationCadences = () => builderCadenceCalls.map((call) => call.minutes);
const readMeta = () => JSON.parse(scriptProperties[META_PROPERTY]);

// Runtime-source firewall: the guard module must not claim cadence read-back.
check(!/getEveryMinutes/.test(guardSource), 'guard runtime never calls getEveryMinutes');
check(!/\.minutes\b/.test(guardSource), 'guard runtime never reads a .minutes cadence property');
check(guard.PRODUCTION_LIFECYCLE_TRIGGER_CADENCE_VERIFICATION === 'INSTALL_METADATA_PLUS_TRIGGER_ID'
  && guard.PRODUCTION_LIFECYCLE_TRIGGER_RUNTIME_CADENCE_INTROSPECTION === false
  && META_PROPERTY === 'PRODUCTION_LIFECYCLE_TRIGGER_INSTALL_META_V1',
  'cadence verification contract constants are the deterministic ones');

// A. pre-existing target triggers of UNKNOWN cadence are replaced, unrelated kept.
projectTriggers.length = 0;
builderCadenceCalls.length = 0;
delete scriptProperties[META_PROPERTY];
const staleNotification = makeTrigger(NOTIFICATION_HANDLER, TRIGGER_SOURCE.CLOCK, 'stale-notification-id');
const staleCalendar = makeTrigger(CALENDAR_HANDLER, TRIGGER_SOURCE.CLOCK, 'stale-calendar-id');
const unrelated = makeTrigger('unrelatedProjectHandler_', TRIGGER_SOURCE.SPREADSHEETS, 'unrelated-id');
projectTriggers.push(staleNotification, staleCalendar, unrelated);
check(!('minutes' in staleNotification) && typeof staleNotification.getEveryMinutes === 'undefined',
  'pre-existing triggers carry no readable cadence at all');

const installed = guard.installProductionLifecycleTriggersDeterministic_();
check(installed.ok && installed.behavior === 'CONVERGENT_RECREATE'
  && installed.cadenceMinutes === 5 && installed.replaced === 2,
  'A. deterministic installer replaces both unknown-cadence target triggers');
check(!ids().includes('stale-notification-id') && !ids().includes('stale-calendar-id'),
  'A. stale target trigger IDs are gone');
check(ids().includes('unrelated-id') && currentFor('unrelatedProjectHandler_').length === 1,
  'A. unrelated project triggers are preserved');

// B. exactly one current trigger per target handler, two in total.
check(currentFor(NOTIFICATION_HANDLER).length === 1 && currentFor(CALENDAR_HANDLER).length === 1
  && projectTriggers.filter((trigger) => TARGET_HANDLERS.includes(trigger.getHandlerFunction())).length === 2,
  'B. exactly two current target triggers remain');

// C. creation calls asked for everyMinutes(5) for both handlers.
check(builderCadenceCalls.length === 2 && creationCadences().every((minutes) => minutes === 5)
  && builderCadenceCalls.map((call) => call.handler).sort().join(',') === [...TARGET_HANDLERS].sort().join(','),
  'C. builder creation calls were everyMinutes(5) for both target handlers');

// D. current Trigger objects expose no cadence property or method.
const targetTriggers = () => projectTriggers.filter((trigger) => TARGET_HANDLERS.includes(trigger.getHandlerFunction()));
check(targetTriggers().every((trigger) => !('minutes' in trigger)
  && typeof trigger.getEveryMinutes !== 'function'
  && Object.keys(trigger).sort().join(',') === 'getHandlerFunction,getTriggerSource,getUniqueId'),
  'D. synthetic Trigger objects expose no cadence property and no cadence getter');

// E. deterministic verifier PASS on that state.
const verified = guard.verifyProductionLifecycleTriggersDeterministic_();
const meta = readMeta();
check(verified.ok
  && verified.metadataPresent === true
  && verified.cadenceVerification === 'INSTALL_METADATA_PLUS_TRIGGER_ID'
  && verified.runtimeCadenceIntrospection === false
  && verified.cadenceMinutes === 5
  && verified.expectedHandlers.join(',') === TARGET_HANDLERS.join(',')
  && verified.missing.length === 0 && verified.duplicates.length === 0
  && verified.wrongSource.length === 0 && verified.idMismatch.length === 0
  && verified.metadataMismatch.length === 0 && verified.unexpectedNonprod.length === 0,
  'E. deterministic verifier passes with metadata-bound trigger IDs');
check(meta.version === guard.PRODUCTION_LIFECYCLE_TRIGGER_META_VERSION
  && meta.cadenceVerification === 'INSTALL_METADATA_PLUS_TRIGGER_ID'
  && meta.runtimeCadenceIntrospection === false
  && typeof meta.installedAt === 'string' && meta.installedAt.length > 0
  && meta.triggers.length === 2
  && meta.triggers.every((entry) => entry.intervalMinutes === 5 && entry.uniqueId
    && TARGET_HANDLERS.includes(entry.handler)),
  'E. persisted metadata carries version, cadence, IDs and no cadence claim');
check(TARGET_HANDLERS.every((handler) => meta.triggers.find((entry) => entry.handler === handler).uniqueId
  === currentFor(handler)[0].getUniqueId()),
  'E. metadata unique IDs equal the current trigger unique IDs');
const metaKeys = Object.keys(meta).sort().join(',');
check(metaKeys === 'cadenceVerification,installedAt,runtimeCadenceIntrospection,triggers,version',
  'E. metadata holds only the non-secret install contract fields');
const evidenceBlob = JSON.stringify(verified) + JSON.stringify(installed) + scriptProperties[META_PROPERTY];
check(!/synthetic-flow|synthetic-status-secret|synthetic-store|synthetic-calendar|ops@example\.test/.test(evidenceBlob),
  'E. installer/verifier evidence and metadata log no secrets or config values');

// F. rerunning the installer is CONVERGENT, not identity-preserving idempotency.
const idsBeforeRerun = TARGET_HANDLERS.map((handler) => currentFor(handler)[0].getUniqueId());
builderCadenceCalls.length = 0;
const reinstalled = guard.installProductionLifecycleTriggersDeterministic_();
const idsAfterRerun = TARGET_HANDLERS.map((handler) => currentFor(handler)[0].getUniqueId());
check(reinstalled.ok && reinstalled.behavior === 'CONVERGENT_RECREATE' && reinstalled.replaced === 2
  && currentFor(NOTIFICATION_HANDLER).length === 1 && currentFor(CALENDAR_HANDLER).length === 1,
  'F. rerun converges on exactly one current trigger per target handler');
check(idsAfterRerun.every((id, index) => id !== idsBeforeRerun[index]),
  'F. rerun recreates the target triggers, so unique IDs change (convergent, not identity-idempotent)');
check(builderCadenceCalls.length === 2 && creationCadences().every((minutes) => minutes === 5),
  'F. rerun creation calls are again exactly 5 minutes');
check(ids().includes('unrelated-id'), 'F. rerun still preserves unrelated project triggers');
check(guard.verifyProductionLifecycleTriggersDeterministic_().ok,
  'F. verifier passes against the freshly recreated IDs');

const reset = () => {
  projectTriggers.length = 0;
  builderCadenceCalls.length = 0;
  delete scriptProperties[META_PROPERTY];
  projectTriggers.push(makeTrigger('unrelatedProjectHandler_', TRIGGER_SOURCE.SPREADSHEETS, 'unrelated-id'));
  const result = guard.installProductionLifecycleTriggersDeterministic_();
  assert.equal(result.ok, true, 'reset install must pass');
};

// G. rogue unique ID with the right handler and CLOCK source must FAIL idMismatch.
reset();
const rogueIndex = projectTriggers.findIndex((trigger) => trigger.getHandlerFunction() === NOTIFICATION_HANDLER);
projectTriggers[rogueIndex] = makeTrigger(NOTIFICATION_HANDLER, TRIGGER_SOURCE.CLOCK, 'rogue-unique-id');
const rogue = guard.verifyProductionLifecycleTriggersDeterministic_();
check(!rogue.ok && rogue.idMismatch.length === 1 && rogue.idMismatch[0] === NOTIFICATION_HANDLER
  && rogue.missing.length === 0 && rogue.duplicates.length === 0 && rogue.wrongSource.length === 0,
  'G. a rogue trigger unique ID fails verification with idMismatch');

// H. missing metadata must FAIL closed even though the triggers look right.
reset();
delete scriptProperties[META_PROPERTY];
const noMeta = guard.verifyProductionLifecycleTriggersDeterministic_();
check(!noMeta.ok && noMeta.metadataPresent === false
  && noMeta.metadataMismatch.includes('METADATA_MISSING')
  && noMeta.idMismatch.length === 2,
  'H. deleted install metadata fails verification closed');

reset();
scriptProperties[META_PROPERTY] = '{not-json';
const badMeta = guard.verifyProductionLifecycleTriggersDeterministic_();
check(!badMeta.ok && badMeta.metadataPresent === false
  && badMeta.metadataMismatch.includes('METADATA_INVALID_JSON'),
  'H. corrupt install metadata fails verification closed');

reset();
const claimingMeta = readMeta();
claimingMeta.runtimeCadenceIntrospection = true;
scriptProperties[META_PROPERTY] = JSON.stringify(claimingMeta);
const claiming = guard.verifyProductionLifecycleTriggersDeterministic_();
check(!claiming.ok && claiming.metadataMismatch.includes('METADATA_CLAIMS_RUNTIME_CADENCE_INTROSPECTION'),
  'H. metadata claiming runtime cadence introspection fails verification');

reset();
const staleCadenceMeta = readMeta();
staleCadenceMeta.triggers[0].intervalMinutes = 10;
scriptProperties[META_PROPERTY] = JSON.stringify(staleCadenceMeta);
check(!guard.verifyProductionLifecycleTriggersDeterministic_().ok
  && guard.verifyProductionLifecycleTriggersDeterministic_().metadataMismatch.includes('METADATA_CADENCE_UNEXPECTED'),
  'H. metadata cadence other than the configured 5 minutes fails verification');

// I. same unique ID and handler but a non-CLOCK source must FAIL wrongSource.
reset();
const clockIndex = projectTriggers.findIndex((trigger) => trigger.getHandlerFunction() === CALENDAR_HANDLER);
const keptId = projectTriggers[clockIndex].getUniqueId();
projectTriggers[clockIndex] = makeTrigger(CALENDAR_HANDLER, TRIGGER_SOURCE.SPREADSHEETS, keptId);
const wrongSource = guard.verifyProductionLifecycleTriggersDeterministic_();
check(!wrongSource.ok && wrongSource.wrongSource.length === 1
  && wrongSource.wrongSource[0] === CALENDAR_HANDLER && wrongSource.idMismatch.length === 0,
  'I. a non-CLOCK trigger source fails verification with wrongSource');

// J. duplicate target handlers and missing triggers fail closed.
reset();
projectTriggers.push(makeTrigger(NOTIFICATION_HANDLER, TRIGGER_SOURCE.CLOCK, 'duplicate-id'));
const duplicated = guard.verifyProductionLifecycleTriggersDeterministic_();
check(!duplicated.ok && duplicated.duplicates.length === 1
  && duplicated.duplicates[0] === NOTIFICATION_HANDLER,
  'J. duplicate target handlers fail verification');

reset();
const dropIndex = projectTriggers.findIndex((trigger) => trigger.getHandlerFunction() === CALENDAR_HANDLER);
projectTriggers.splice(dropIndex, 1);
const missingOne = guard.verifyProductionLifecycleTriggersDeterministic_();
check(!missingOne.ok && missingOne.missing.length === 1 && missingOne.missing[0] === CALENDAR_HANDLER,
  'J. a missing target trigger fails verification');

// K. NONPROD / fixture / test handlers are rejected.
reset();
projectTriggers.push(makeTrigger('nonprodTargetedFixtureHandler_', TRIGGER_SOURCE.CLOCK, 'nonprod-id'));
const contaminated = guard.verifyProductionLifecycleTriggersDeterministic_();
check(!contaminated.ok && contaminated.unexpectedNonprod.length === 1
  && contaminated.unexpectedNonprod[0] === 'nonprodTargetedFixtureHandler_',
  'K. unexpected NONPROD/fixture handlers fail verification');

// L. installer stays fail-closed on a non-Production configuration and leaves
// no partial metadata or new target triggers behind.
reset();
const goodMetaBlob = scriptProperties[META_PROPERTY];
const triggerCountBefore = projectTriggers.length;
scriptProperties.APP_ENV = 'nonprod';
assert.throws(() => guard.installProductionLifecycleTriggersDeterministic_(),
  (error) => error && error.code === 'CONFIGURATION_INCOMPLETE');
assertions += 1;
scriptProperties.APP_ENV = 'production';
check(projectTriggers.length === triggerCountBefore && scriptProperties[META_PROPERTY] === goodMetaBlob,
  'L. a fail-closed configuration neither creates triggers nor rewrites metadata');

// M. legacy cadence-guessing operators are gone from the runtime surface.
check(typeof context.triggerIntervalMinutes_ === 'undefined'
  && typeof context.installTimeTriggerExactlyOnce_ === 'undefined'
  && typeof context.installProductionLifecycleTriggers_ === 'undefined'
  && typeof context.verifyProductionLifecycleTriggers_ === 'undefined'
  && typeof worker.installProductionLifecycleTriggers_ === 'undefined'
  && typeof worker.verifyProductionLifecycleTriggers_ === 'undefined',
  'M. the old cadence-guessing installer/verifier no longer exists');
check(TARGET_HANDLERS.join(',') === 'processLifecycleNotificationOutbox_,processCalendarReconciliation_'
  && !/nonprod/i.test(TARGET_HANDLERS.join(',')),
  'M. only the two expected Production handlers are targeted');

console.log(`TRIGGER_TESTS=PASS assertions=${assertions}`);
console.log('PRODUCTION_TRIGGER_CONTRACT=PASS');
console.log('TRIGGER_CADENCE_VERIFICATION=INSTALL_METADATA_PLUS_TRIGGER_ID');
console.log('RUNTIME_CADENCE_INTROSPECTION=NO');
console.log('SYNTHETIC_TRIGGER_EXPOSES_MINUTES_PROPERTY=NO');
console.log('SYNTHETIC_TRIGGER_EXPOSES_GET_EVERY_MINUTES=NO');
console.log('TRIGGER_INSTALLER_BEHAVIOR=CONVERGENT_RECREATE');
console.log('TRIGGER_TARGET_CADENCE_MINUTES=5');
console.log('TRIGGER_HANDLER_COUNT=2');

import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const files = ['../Code.js', '../Lifecycle.js', '../EmailTemplates.js'];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const propertyValues = {
  APP_ENV: 'production', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://www.flow.cl/api', FLOW_RETURN_URL: 'https://franciscabustos.cl/pago-resultado',
  FLOW_CONFIRMATION_URL: 'https://franciscabustos.cl/api/flow-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: 'ops@example.test',
  IDEMPOTENCY_NAMESPACE: 'fran-booking', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
};
const projectTriggers = [];
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const context = {
  console, Date, Set, Number, String, Object, Array, JSON, RegExp, Math,
  encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
    computeDigest: (_algorithm, value) => bytes(createHash('sha256').update(String(value)).digest()),
    computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
  },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...propertyValues }) }) },
  Logger: { log: () => {} },
  ScriptApp: {
    getProjectTriggers: () => projectTriggers.slice(),
    newTrigger: (handler) => ({
      timeBased: () => ({
        everyMinutes: (minutes) => ({
          create: () => {
            projectTriggers.push({
              handler, minutes,
              getHandlerFunction: () => handler,
            });
          },
        }),
      }),
    }),
    deleteTrigger: (trigger) => {
      const index = projectTriggers.findIndex((item) => item === trigger || item.getHandlerFunction() === trigger.getHandlerFunction());
      if (index >= 0) projectTriggers.splice(index, 1);
    },
  },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);
const worker = context.__NOTIFICATION_OUTBOX_TEST_EXPORTS__;
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

projectTriggers.length = 0;
const installed = worker.installProductionLifecycleTriggers_();
check(installed.ok && installed.notification.created && installed.calendar.created, 'installer creates both lifecycle triggers');
check(projectTriggers.length === 2
  && projectTriggers.every((trigger) => trigger.minutes === 5),
  'both handlers use a 5-minute cadence');
const installedAgain = worker.installProductionLifecycleTriggers_();
check(installedAgain.ok && !installedAgain.notification.created && !installedAgain.calendar.created
  && projectTriggers.length === 2,
  'rerunning the installer is idempotent');

const verified = worker.verifyProductionLifecycleTriggers_();
check(verified.ok && verified.missing.length === 0 && verified.duplicates.length === 0
  && !JSON.stringify(verified).includes('synthetic-flow'),
  'verifier is read-only and prints no secrets');

projectTriggers.push({
  handler: worker.PRODUCTION_NOTIFICATION_RETRY_HANDLER,
  minutes: 5,
  getHandlerFunction: () => worker.PRODUCTION_NOTIFICATION_RETRY_HANDLER,
});
const deduped = worker.installProductionLifecycleTriggers_();
check(deduped.ok && projectTriggers.filter((trigger) => trigger.getHandlerFunction() === worker.PRODUCTION_NOTIFICATION_RETRY_HANDLER).length === 1,
  'duplicate equivalent triggers are collapsed');

check(worker.PRODUCTION_NOTIFICATION_RETRY_HANDLER === 'processLifecycleNotificationOutbox_'
  && worker.PRODUCTION_CALENDAR_RECONCILIATION_HANDLER === 'processCalendarReconciliation_'
  && !/nonprod/i.test(worker.PRODUCTION_NOTIFICATION_RETRY_HANDLER + worker.PRODUCTION_CALENDAR_RECONCILIATION_HANDLER),
  'only expected Production handlers are installed');

console.log(`TRIGGER_TESTS=PASS assertions=${assertions}`);
console.log('PRODUCTION_TRIGGER_CONTRACT=PASS');

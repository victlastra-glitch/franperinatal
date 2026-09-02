import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

const manifest = JSON.parse(await readFile(new URL('../appsscript.json', import.meta.url), 'utf8'));
const calendarSource = await readFile(new URL('../CalendarGateway.js', import.meta.url), 'utf8');
const services = manifest.dependencies && manifest.dependencies.enabledAdvancedServices;
const calendarService = (services || []).find((service) => service.serviceId === 'calendar');
assert.ok(calendarService, 'Calendar advanced service is declared');
assert.equal(calendarService.userSymbol, 'Calendar');
assert.equal(calendarService.version, 'v3');
assert.equal(manifest.oauthScopes, undefined, 'unrelated OAuth scopes were not added');

const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
const context = {
  console, Date, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math,
  Calendar: { Events: { insert() {}, list() {}, get() {}, update() {}, remove() {} }, Freebusy: { query() {} } },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
    computeDigest: () => bytes(Buffer.from('00', 'hex')),
  },
};
vm.createContext(context);
vm.runInContext(calendarSource, context);
const api = context.__CALENDAR_TEST_EXPORTS__.calendarApi_({});
assert.equal(api, context.Calendar, 'modular runtime uses the global Calendar advanced service');
assert.match(calendarSource, /typeof Calendar !== 'undefined'\) return Calendar/);

console.log('CALENDAR_ADVANCED_SERVICE_MANIFEST=PASS');
console.log('CALENDAR_GLOBAL_RUNTIME_CONTRACT=PASS');

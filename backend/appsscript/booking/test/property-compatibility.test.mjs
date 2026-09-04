import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../Code.js', import.meta.url), 'utf8');
const origin = 'https://franciscabustos.cl';
const v7Properties = {
  APP_ENV: 'production', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://www.flow.cl/api', PUBLIC_RETURN_URL: origin + '/pago-resultado',
  FLOW_CONFIRMATION_URL: origin + '/api/flow-confirmation',
  SHEET_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: 'ops@example.test', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
};
const v2Properties = {
  ...v7Properties,
  FLOW_RETURN_URL: origin + '/pago-resultado',
  BOOKING_STORE_ID: 'canonical-store',
  IDEMPOTENCY_NAMESPACE: 'fran-booking',
};
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));
let propertyValues = { ...v7Properties };
const context = {
  console, Date, Set, Number, String, Object, Array, JSON, RegExp, Math,
  encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (_algorithm, value) => bytes(createHash('sha256').update(String(value)).digest()),
  },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...propertyValues }) }) },
  UrlFetchApp: { fetch: () => { throw new Error('network must not be called'); } },
};
vm.createContext(context);
vm.runInContext(source, context);
const compat = context.__COMPATIBILITY_TEST_EXPORTS__;
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

const fromV7 = context.readConfig_();
check(fromV7.bookingStoreId === 'synthetic-store', 'SHEET_ID aliases BOOKING_STORE_ID');
check(fromV7.flowReturnUrl === origin + '/pago-resultado', 'PUBLIC_RETURN_URL aliases FLOW_RETURN_URL');
check(fromV7.idempotencyNamespace === 'fran-booking', 'IDEMPOTENCY_NAMESPACE defaults to canonical namespace');
check(fromV7.flowConfirmationUrl === origin + '/api/flow-confirmation', 'FLOW_CONFIRMATION_URL is the public worker route');

propertyValues = { ...v2Properties };
const fromV2 = context.readConfig_();
check(fromV2.bookingStoreId === 'canonical-store', 'canonical V2 BOOKING_STORE_ID wins over SHEET_ID');

propertyValues = { ...v7Properties, FLOW_ENV: 'production' };
delete propertyValues.APP_ENV;
assert.throws(() => context.readConfig_(), (error) => error && error.code === 'CONFIGURATION_INCOMPLETE');
assertions += 1;

propertyValues = { ...v7Properties, FLOW_WEBHOOK_URL: 'https://script.google.com/macros/s/fake/exec' };
delete propertyValues.FLOW_CONFIRMATION_URL;
assert.throws(() => context.readConfig_(), (error) => error && error.code === 'CONFIGURATION_INCOMPLETE');
assertions += 1;

check(compat.NEW_PRODUCTION_PROPERTY_NAMES.includes('APP_ENV'), 'APP_ENV is a new Production property');
check(compat.NEW_PRODUCTION_PROPERTY_NAMES.includes('FLOW_CONFIRMATION_URL'), 'FLOW_CONFIRMATION_URL is a new public URL');
check(!compat.NEW_PRODUCTION_PROPERTY_NAMES.includes('FLOW_RETURN_URL'), 'FLOW_RETURN_URL is not required when PUBLIC_RETURN_URL exists');
check(!compat.NEW_PRODUCTION_PROPERTY_NAMES.includes('BOOKING_STORE_ID'), 'BOOKING_STORE_ID is not new versus SHEET_ID');
check(JSON.stringify(compat.NEW_PRODUCTION_PROPERTY_NAMES).includes('synthetic') === false, 'property names dump contains no values');

console.log(`PROPERTY_COMPATIBILITY_GATE=PASS assertions=${assertions}`);
console.log('NEW_PROPERTY_NAMES_REQUIRED=' + compat.NEW_PRODUCTION_PROPERTY_NAMES.join(','));

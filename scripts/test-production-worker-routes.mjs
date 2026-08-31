import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertProductionUpstreamCallSites } from './assert-production-worker-structure.mjs';

const workerSource = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
const previousFetch = globalThis.fetch;
let upstreamFetchCalls = 0;
globalThis.fetch = async () => {
  upstreamFetchCalls += 1;
  throw new Error('unexpected upstream fetch');
};

try {
  const configuredEnv = { APP_ENV: 'production', APPS_SCRIPT_WEB_APP_URL: 'https://invalid.example/unused-production-endpoint' };
  const disabledRoutes = [['/api/leadmagnet', 'POST']];

  for (const [path, method] of disabledRoutes) {
    const response = await workerModule.default.fetch(
      new Request(`https://preview.example${path}`, { method }), configuredEnv, {}
    );
    assert.equal(response.status, 503, `${path} must be disabled`);
    assert.deepEqual(await response.json(), { ok: false, code: 'feature_disabled' });
  }

  const bookingRoutes = [
    ['/api/availability', 'GET', 'json'],
    ['/api/create-flow-payment', 'POST', 'json'],
    ['/api/retry-flow-payment', 'POST', 'json'],
    ['/api/flow-confirmation', 'POST', 'text'],
    ['/api/payment-status', 'GET', 'json']
  ];
  const managementRoutes = [
    ['/api/manage', 'POST', 'json'], ['/api/manage-availability', 'GET', 'json'],
    ['/api/manage-cancel', 'POST', 'json'], ['/api/manage-reschedule', 'POST', 'json'],
    ['/api/refund-confirmation', 'POST', 'text']
  ];
  for (const [path, method, bodyType] of [...bookingRoutes, ...managementRoutes]) {
    const missingEnvResponse = await workerModule.default.fetch(
      new Request(`https://preview.example${path}`, { method }), {}, {}
    );
    assert.equal(missingEnvResponse.status, 503, `${path} must fail closed without APP_ENV`);
    if (bodyType === 'json') {
      assert.deepEqual(await missingEnvResponse.json(), { ok: false, code: 'environment_not_configured' });
    } else {
      assert.equal(await missingEnvResponse.text(), 'environment_not_configured');
    }

    const missingUpstreamResponse = await workerModule.default.fetch(
      new Request(`https://preview.example${path}`, { method }), { APP_ENV: 'production' }, {}
    );
    assert.equal(missingUpstreamResponse.status, 503, `${path} must fail closed without an upstream`);
    if (bodyType === 'json') {
      assert.deepEqual(await missingUpstreamResponse.json(), { ok: false, code: 'upstream_not_configured' });
    } else {
      assert.equal(await missingUpstreamResponse.text(), 'upstream_not_configured');
    }
  }
  assert.equal(upstreamFetchCalls, 0, 'disabled routes and missing booking config must not fetch upstream');
  assertProductionUpstreamCallSites(workerSource);
  console.log('SEMANTIC_UPSTREAM_CALL_SITE_TEST=PASS');

  // Management responses are allowlisted even when the synthetic upstream
  // attempts to return patient/contact/clinical fields.
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true, status: 'active', date: '2026-08-24', time: '10:00', serviceType: 'initial', modality: 'Online',
    nombre: 'synthetic-person', email: 'synthetic@example.test', patientRut: '11.111.111-1', reason: 'clinical text', capabilityType: 'RESCHEDULE'
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const managementResponse = await workerModule.default.fetch(
    new Request('https://preview.example/api/manage', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'manage', token: 'a'.repeat(64) }) }),
    { APP_ENV: 'production', APPS_SCRIPT_WEB_APP_URL: 'https://script.google.com/macros/s/synthetic/exec' }, {}
  );
  const managementBody = await managementResponse.json();
  assert.equal(managementBody.ok, true);
  assert.equal(managementBody.capabilityType, 'RESCHEDULE', 'management capability type is allowlisted');
  assert.equal(Object.hasOwn(managementBody, 'nombre'), false, 'management response excludes patient name');
  assert.equal(Object.hasOwn(managementBody, 'email'), false, 'management response excludes email');
  assert.equal(Object.hasOwn(managementBody, 'patientRut'), false, 'management response excludes RUT');
  assert.equal(Object.hasOwn(managementBody, 'reason'), false, 'management response excludes clinical text');
  console.log('MANAGEMENT_RESPONSE_NO_PII_TEST=PASS');

  const availabilityCall = workerSource.indexOf(
    'productionUpstream(env)',
    workerSource.indexOf('async function handleAvailability')
  );
  assert.notEqual(availabilityCall, -1, 'synthetic mutation target missing');
  const withoutAvailabilityCall = workerSource.slice(0, availabilityCall)
    + workerSource.slice(availabilityCall + 'productionUpstream(env)'.length);
  const unauthorizedHandlerBody = withoutAvailabilityCall.indexOf(
    '{',
    withoutAvailabilityCall.indexOf('function handlePagoResultadoPost')
  ) + 1;
  const mutantSource = withoutAvailabilityCall.slice(0, unauthorizedHandlerBody)
    + '\n  productionUpstream(env);'
    + withoutAvailabilityCall.slice(unauthorizedHandlerBody);
  assert.throws(
    () => assertProductionUpstreamCallSites(mutantSource),
    /handleAvailability|unauthorized handler/,
    'semantic assertion must reject a same-count lost/gained call-site mutation'
  );
  console.log('SEMANTIC_UPSTREAM_MUTANT_TESTS=PASS');
  console.log('FAIL_CLOSED_ROUTE_UPSTREAM_FETCH_CALLS=0');
  console.log('PRODUCTION_WORKER_ROUTE_TESTS=PASS');
} finally {
  globalThis.fetch = previousFetch;
}

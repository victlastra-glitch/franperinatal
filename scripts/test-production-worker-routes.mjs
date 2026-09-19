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

  // The create contract no longer carries a patient RUT. The key is still
  // tolerated so a browser holding the previous booking.js across a deploy is
  // not rejected mid-booking, and it is dropped here rather than forwarded.
  const createEnv = { APP_ENV: 'production', APPS_SCRIPT_WEB_APP_URL: 'https://script.google.com/macros/s/synthetic/exec' };
  const createBase = {
    idempotencyKey: 'fran-booking-123e4567-e89b-12d3-a456-426614174000',
    serviceType: 'initial', modality: 'online', date: '2026-08-27', time: '10:00',
    name: 'Synthetic Patient', email: 'synthetic@example.test', phone: '+56900000000',
    reason: 'synthetic reason', message: 'synthetic message',
  };
  const forwardedBodies = [];
  const stubCreateUpstream = () => {
    globalThis.fetch = async (_input, init) => {
      forwardedBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        ok: true, paymentUrl: 'https://www.flow.cl/app/web/pay.php?token=synthetic',
        publicStatusToken: 'fran-booking-st-0123456789abcdef0123456789abcdef',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  };
  const postCreate = async (module, body) => module.default.fetch(
    new Request('https://preview.example/api/create-flow-payment', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), createEnv, {}
  );

  stubCreateUpstream();
  const withoutRut = await postCreate(workerModule, createBase);
  assert.equal((await withoutRut.json()).ok, true, 'a create payload with no patientRut is accepted');
  assert.equal(Object.hasOwn(forwardedBodies[0], 'patientRut'), false,
    'the forwarded create body carries no patientRut');

  const legacyRut = await postCreate(workerModule, { ...createBase, patientRut: '11.111.111-1' });
  assert.equal((await legacyRut.json()).ok, true,
    'a legacy create payload still carrying patientRut is not rejected');
  assert.equal(Object.hasOwn(forwardedBodies[1], 'patientRut'), false,
    'a supplied patientRut is dropped at the Worker and never forwarded upstream');
  assert.deepEqual(forwardedBodies[1], forwardedBodies[0],
    'a supplied patientRut changes nothing about what is forwarded');
  console.log('CREATE_REQUEST_NO_PATIENT_RUT_TEST=PASS');

  // Adversarial mutation: reinstating the field must be visible downstream.
  const recollectSource = workerSource.replace("'phone', 'reason', 'message'", "'phone', 'patientRut', 'reason', 'message'");
  assert.notEqual(recollectSource, workerSource, 'mutation target present in _worker.js');
  const recollectModule = await import(`data:text/javascript;base64,${Buffer.from(recollectSource).toString('base64')}`);
  forwardedBodies.length = 0;
  stubCreateUpstream();
  await postCreate(recollectModule, { ...createBase, patientRut: '11.111.111-1' });
  assert.equal(forwardedBodies[0].patientRut, '11.111.111-1',
    'reinstating patientRut in CREATE_FIELDS must forward it upstream');
  console.log('MUTATION_WORKER_PATIENT_RUT_RECOLLECTED=DETECTED');

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

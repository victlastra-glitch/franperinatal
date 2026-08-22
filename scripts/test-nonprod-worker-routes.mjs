import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertNonprodUpstreamCallSites } from './assert-nonprod-worker-structure.mjs';

const workerSource = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
const previousFetch = globalThis.fetch;
let upstreamFetchCalls = 0;
globalThis.fetch = async () => {
  upstreamFetchCalls += 1;
  throw new Error('unexpected upstream fetch');
};

try {
  const configuredEnv = {
    APP_ENV: 'nonprod',
    APPS_SCRIPT_WEB_APP_URL: 'https://invalid.example/unused-nonprod-endpoint'
  };
  const disabledRoutes = [
    ['/api/leadmagnet', 'POST'],
    ['/api/manage', 'POST'],
    ['/api/manage-availability', 'GET'],
    ['/api/manage-cancel', 'POST'],
    ['/api/manage-reschedule', 'POST']
  ];

  for (const [path, method] of disabledRoutes) {
    const response = await workerModule.default.fetch(
      new Request(`https://preview.example${path}`, { method }), configuredEnv, {}
    );
    assert.equal(response.status, 503, `${path} must be disabled`);
    assert.deepEqual(await response.json(), { ok: false, code: 'feature_disabled_nonprod' });
  }

  const bookingRoutes = [
    ['/api/availability', 'GET', 'json'],
    ['/api/create-flow-payment', 'POST', 'json'],
    ['/api/flow-confirmation', 'POST', 'text'],
    ['/api/payment-status', 'GET', 'json']
  ];
  for (const [path, method, bodyType] of bookingRoutes) {
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
      new Request(`https://preview.example${path}`, { method }), { APP_ENV: 'nonprod' }, {}
    );
    assert.equal(missingUpstreamResponse.status, 503, `${path} must fail closed without an upstream`);
    if (bodyType === 'json') {
      assert.deepEqual(await missingUpstreamResponse.json(), { ok: false, code: 'upstream_not_configured' });
    } else {
      assert.equal(await missingUpstreamResponse.text(), 'upstream_not_configured');
    }
  }
  assert.equal(upstreamFetchCalls, 0, 'disabled routes and missing booking config must not fetch upstream');
  assertNonprodUpstreamCallSites(workerSource);
  console.log('SEMANTIC_UPSTREAM_CALL_SITE_TEST=PASS');

  const availabilityCall = workerSource.indexOf(
    'nonprodUpstream(env)',
    workerSource.indexOf('async function handleAvailability')
  );
  assert.notEqual(availabilityCall, -1, 'synthetic mutation target missing');
  const withoutAvailabilityCall = workerSource.slice(0, availabilityCall)
    + workerSource.slice(availabilityCall + 'nonprodUpstream(env)'.length);
  const unauthorizedHandlerBody = withoutAvailabilityCall.indexOf(
    '{',
    withoutAvailabilityCall.indexOf('function handlePagoResultadoPost')
  ) + 1;
  const mutantSource = withoutAvailabilityCall.slice(0, unauthorizedHandlerBody)
    + '\n  nonprodUpstream(env);'
    + withoutAvailabilityCall.slice(unauthorizedHandlerBody);
  assert.throws(
    () => assertNonprodUpstreamCallSites(mutantSource),
    /handleAvailability|unauthorized handler/,
    'semantic assertion must reject a same-count lost/gained call-site mutation'
  );
  console.log('SEMANTIC_UPSTREAM_MUTANT_TESTS=PASS');
  console.log('DISABLED_ROUTES_UPSTREAM_FETCH_CALLS=0');
  console.log('NONPROD_WORKER_ROUTE_TESTS=PASS');
} finally {
  globalThis.fetch = previousFetch;
}

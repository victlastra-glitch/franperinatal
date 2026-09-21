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

  // The create contract carries the billing trio the post-session boleta needs.
  // The Worker is a proxy: it forwards them verbatim and decides nothing about
  // them, and they appear in no response and no log line.
  const createEnv = { APP_ENV: 'production', APPS_SCRIPT_WEB_APP_URL: 'https://script.google.com/macros/s/synthetic/exec' };
  const createBase = {
    idempotencyKey: 'fran-booking-123e4567-e89b-12d3-a456-426614174000',
    serviceType: 'initial', modality: 'online', date: '2026-08-27', time: '10:00',
    name: 'Synthetic Patient', email: 'synthetic@example.test', phone: '+56900000000',
    patientRut: '11.111.111-1', address: 'Calle Sintetica 123', comuna: 'Providencia',
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
  const withBilling = await postCreate(workerModule, createBase);
  assert.equal((await withBilling.json()).ok, true, 'a create payload carrying billing data is accepted');
  assert.equal(forwardedBodies[0].patientRut, '11.111.111-1',
    'the forwarded create body carries the RUT verbatim');
  assert.equal(forwardedBodies[0].address, 'Calle Sintetica 123',
    'the forwarded create body carries the address verbatim');
  assert.equal(forwardedBodies[0].comuna, 'Providencia',
    'the forwarded create body carries the comuna verbatim');

  // The Worker forwards; it does not judge. An unparseable RUT is the upstream's
  // decision, and inventing a second verdict here is the defect this asserts away.
  const badRut = await postCreate(workerModule, { ...createBase, patientRut: 'not-a-rut' });
  assert.equal(badRut.status, 200, 'the Worker does not reject a RUT on its own authority');
  assert.equal(forwardedBodies[1].patientRut, 'not-a-rut',
    'and it forwards the value it was given, unchanged, for the server to refuse');

  // An unknown key is still refused: widening the contract stays deliberate.
  const unknownKey = await postCreate(workerModule, { ...createBase, giro: 'synthetic' });
  assert.equal(unknownKey.status, 400, 'an unlisted create field is still rejected');
  console.log('CREATE_REQUEST_BILLING_FORWARDED_TEST=PASS');

  // The response the browser gets is unchanged by any of it.
  const createBody = await (await postCreate(workerModule, {
    ...createBase, idempotencyKey: 'fran-booking-123e4567-e89b-12d3-a456-4266141740ff',
  })).json();
  ['patientRut', 'address', 'comuna', 'name', 'email', 'phone', 'reason', 'message']
    .forEach((field) => assert.equal(Object.hasOwn(createBody, field), false,
      `the create response never echoes ${field}`));
  console.log('CREATE_RESPONSE_NO_BILLING_ECHO_TEST=PASS');

  // Adversarial mutation: dropping the field must be visible downstream.
  const droppedSource = workerSource.replace("'phone', 'patientRut', 'address', 'comuna', 'reason', 'message'", "'phone', 'reason', 'message'");
  assert.notEqual(droppedSource, workerSource, 'mutation target present in _worker.js');
  const droppedModule = await import(`data:text/javascript;base64,${Buffer.from(droppedSource).toString('base64')}`);
  forwardedBodies.length = 0;
  stubCreateUpstream();
  const droppedResponse = await postCreate(droppedModule, createBase);
  assert.equal(droppedResponse.status, 400,
    'removing patientRut/address/comuna from CREATE_FIELDS must reject the browser that sends them');
  console.log('MUTATION_WORKER_BILLING_FIELDS_DROPPED=DETECTED');

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
  // -------------------------------------------------------------------------
  // _routes.json — which requests invoke the Function at all.
  //
  // Pages Advanced Mode defaults to running _worker.js on /*, so every image,
  // stylesheet and HTML page was a Function invocation. The manifest narrows
  // that to the routes whose behaviour actually depends on Worker execution.
  //
  // The covered set is DERIVED from _worker.js rather than typed out here: a
  // route added to the Worker and not to the manifest would be served as a
  // static 404, and a hardcoded list would not notice.
  // -------------------------------------------------------------------------
  const routesManifest = JSON.parse(await readFile(new URL('../_routes.json', import.meta.url), 'utf8'));
  assert.equal(routesManifest.version, 1, '_routes.json must declare version 1');
  assert.ok(Array.isArray(routesManifest.include) && routesManifest.include.length > 0, 'include must be a non-empty array');
  assert.ok(Array.isArray(routesManifest.exclude), 'exclude must be an array');
  assert.ok(routesManifest.include.length + routesManifest.exclude.length <= 100, 'Pages allows at most 100 rules');
  for (const rule of [...routesManifest.include, ...routesManifest.exclude]) {
    assert.match(rule, /^\/[^*]*(\*)?$/, `rule must start with / and may only end in *: ${rule}`);
  }
  assert.ok(!routesManifest.include.includes('/*'), 'including /* would reinstate the invoke-on-everything default');

  // Cloudflare Pages route matching: `*` is a trailing wildcard, everything
  // else is an exact path match.
  const invokesFunction = (pathname) => routesManifest.include.some((rule) => rule.endsWith('*')
    ? pathname.startsWith(rule.slice(0, -1))
    : pathname === rule)
    && !routesManifest.exclude.some((rule) => rule.endsWith('*')
      ? pathname.startsWith(rule.slice(0, -1))
      : pathname === rule);

  // Every path _worker.js branches on, read out of its own source.
  const exactRoutes = [...workerSource.matchAll(/url\.pathname === '([^']+)'/g)].map((m) => m[1]);
  const prefixRoutes = [...workerSource.matchAll(/url\.pathname\.startsWith\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(exactRoutes.length >= 12, `expected the full Worker route surface, saw ${exactRoutes.length}`);
  assert.ok(prefixRoutes.includes('/backend/'), 'the /backend/ prefix block must still be in the Worker');

  const workerDependent = [...new Set([...exactRoutes, ...prefixRoutes.map((prefix) => prefix + 'appsscript/booking/Code.js')])];
  for (const pathname of workerDependent) {
    assert.ok(invokesFunction(pathname), `_routes.json must invoke the Function for ${pathname}`);
  }
  console.log('WORKER_DEPENDENT_ROUTES_COVERED=' + workerDependent.length);

  // /backend is blocked by the Worker, not only by _redirects. Both halves.
  assert.ok(invokesFunction('/backend'), '/backend must reach the Worker 404');
  assert.ok(invokesFunction('/backend/appsscript/booking/Code.js'), '/backend/* must reach the Worker 404');
  const backendBlock = await workerModule.default.fetch(
    new Request('https://preview.example/backend/appsscript/booking/Code.js'),
    { APP_ENV: 'production', APPS_SCRIPT_WEB_APP_URL: 'https://script.google.com/macros/s/synthetic/exec' }, {}
  );
  assert.equal(backendBlock.status, 404, '/backend/* is still refused by the Worker');
  assert.equal(await backendBlock.text(), 'not_found');
  console.log('BACKEND_BLOCK_PRESERVED=YES');

  // Ordinary site traffic must never reach the Function.
  const staticPaths = ['/', '/index.html', '/reserva.html', '/reserva', '/assets/booking.js', '/assets/styles.css',
    '/assets/booking.css', '/assets/francisca-hero-1200.webp', '/servicios', '/sobre-mi', '/faq', '/contacto',
    '/blog', '/blog/sintomas-depresion-postparto', '/guia/10-senales', '/recursos/test-edimburgo',
    '/manage', '/manage.html', '/pago', '/pago.html', '/pago-resultado.html', '/privacidad',
    '/sitemap.xml', '/robots.txt', '/favicon.ico'];
  for (const pathname of staticPaths) {
    assert.ok(!invokesFunction(pathname), `${pathname} must be served statically, not by the Function`);
  }
  console.log('STATIC_ROUTES_BYPASS_FUNCTION=YES count=' + staticPaths.length);

  // The Worker's own 301 www -> apex now only sees included paths, so the
  // apex-canonical rule has to exist in _redirects, which Pages applies to
  // statically served requests. Losing it would be an SEO regression, silent.
  const redirects = await readFile(new URL('../_redirects', import.meta.url), 'utf8');
  assert.match(redirects, /^https:\/\/www\.franciscabustos\.cl\/\*\s+https:\/\/franciscabustos\.cl\/:splat\s+301$/m,
    '_redirects must carry the www -> apex 301 for statically served routes');
  assert.ok(workerSource.includes("url.hostname === 'www.franciscabustos.cl'"),
    'and the Worker keeps its own copy for the routes it still sees');
  console.log('WWW_CANONICAL_REDIRECT=BOTH_LAYERS');

  // Adversarial mutations: each assertion above must be able to fail.
  const mutate = (manifest) => {
    const invokes = (pathname) => manifest.include.some((rule) => rule.endsWith('*')
      ? pathname.startsWith(rule.slice(0, -1)) : pathname === rule)
      && !manifest.exclude.some((rule) => rule.endsWith('*')
        ? pathname.startsWith(rule.slice(0, -1)) : pathname === rule);
    return invokes;
  };
  const withoutApi = mutate({ include: routesManifest.include.filter((r) => r !== '/api/*'), exclude: [] });
  assert.ok(!withoutApi('/api/availability'),
    'MUTATION_DROP_API_ROUTE: dropping /api/* really does stop the Function being invoked');
  const everything = mutate({ include: ['/*'], exclude: [] });
  assert.ok(everything('/assets/booking.js'),
    'MUTATION_INCLUDE_EVERYTHING: the default /* really does invoke the Function for a static asset');
  const excludedBackend = mutate({ include: routesManifest.include, exclude: ['/backend/*'] });
  assert.ok(!excludedBackend('/backend/appsscript/booking/Code.js'),
    'MUTATION_EXCLUDE_BACKEND: an exclude rule really does take a path away from the Worker');
  console.log('MUTATION_DROP_API_ROUTE=DETECTED');
  console.log('MUTATION_INCLUDE_EVERYTHING=DETECTED');
  console.log('MUTATION_EXCLUDE_BACKEND=DETECTED');
  console.log('PRODUCTION_ROUTES_MANIFEST_TESTS=PASS');

  console.log('FAIL_CLOSED_ROUTE_UPSTREAM_FETCH_CALLS=0');
  console.log('PRODUCTION_WORKER_ROUTE_TESTS=PASS');
} finally {
  globalThis.fetch = previousFetch;
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
const previousFetch = globalThis.fetch;
const statusToken = 'fran-nonprod-20260821-st-0123456789abcdef0123456789abcdef';
const upstreamPayload = {
  ok: true,
  status: 'PAID',
  amount: '65000',
  currency: 'CLP',
  serviceType: 'initial',
  modality: 'online',
  backendVersion: 'nonprod-v1',
  patientRut: '11.111.111-1',
  patientName: 'Paciente Sintetica',
  name: 'Nombre Privado',
  email: 'synthetic@example.invalid',
  phone: '+56900000000',
  reason: 'Motivo clinico sintetico',
  message: 'Mensaje clinico sintetico',
  meetUrl: 'https://meet.example.invalid/private-room',
  meetURL: 'https://meet.example.invalid/private-room-2',
  flowToken: 'flow-internal-token-synthetic',
  flowInternalToken: 'flow-internal-token-synthetic-2',
  appsScriptUrl: 'https://script.google.com/macros/s/PRIVATE_SYNTHETIC',
  appsScriptWebAppUrl: 'https://script.google.com/macros/s/PRIVATE_SYNTHETIC_2',
  internalId: 'internal-booking-id-synthetic',
  customerId: 'private-customer-id-synthetic',
  statusToken: 'raw-upstream-status-token-synthetic',
  rawStatusToken: 'raw-upstream-status-token-synthetic-2',
  token: 'raw-upstream-token-synthetic',
  private: { clinicalReason: 'nested clinical reason synthetic' }
};

let fetchCalls = 0;
globalThis.fetch = async (input) => {
  fetchCalls += 1;
  const url = new URL(input);
  assert.equal(url.hostname, 'script.google.com');
  assert.equal(url.searchParams.get('action'), 'payment_status');
  assert.equal(url.searchParams.get('st'), statusToken);
  return new Response(JSON.stringify(upstreamPayload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};

try {
  const response = await workerModule.default.fetch(
    new Request(`https://preview.example/api/payment-status?st=${encodeURIComponent(statusToken)}`),
    { APP_ENV: 'nonprod', APPS_SCRIPT_WEB_APP_URL: 'https://script.google.com/macros/s/SYNTHETIC_NONPROD' },
    {}
  );
  assert.equal(response.status, 200);
  const bodyText = await response.text();
  const body = JSON.parse(bodyText);
  assert.deepEqual(body, {
    ok: true,
    status: 'PAID',
    amount: 65000,
    currency: 'CLP',
    serviceType: 'initial',
    modality: 'online',
    backendVersion: 'nonprod-v1'
  });
  assert.equal(fetchCalls, 1);

  for (const [key, value] of Object.entries(upstreamPayload)) {
    if (key === 'ok' || key === 'status' || key === 'amount' || key === 'currency'
      || key === 'serviceType' || key === 'modality' || key === 'backendVersion') continue;
    assert.equal(Object.hasOwn(body, key), false, `forbidden response key exposed: ${key}`);
    if (typeof value === 'string') assert.equal(bodyText.includes(value), false, `forbidden value exposed: ${key}`);
  }
  assert.equal(bodyText.includes(statusToken), false, 'raw public status token must not be reflected');
  console.log('PAYMENT_STATUS_PII_ALLOWLIST_TESTS=PASS');
} finally {
  globalThis.fetch = previousFetch;
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFiles = [
  'backend/appsscript/booking/Code.js',
  'backend/appsscript/booking/Lifecycle.js',
  'backend/appsscript/booking/EmailTemplates.js',
  'backend/appsscript/booking/CalendarGateway.js',
  'backend/appsscript/booking/Reconciliation.js',
  'backend/appsscript/booking/RefundGateway.js',
  '_worker.js',
  'assets/booking.js',
  'pago-resultado.html',
  'manage.html',
  'reserva.html',
];

for (const rel of runtimeFiles) {
  const text = await readFile(path.join(root, rel), 'utf8');
  assert.equal(/55\.000|55000|\$55/.test(text), false, `${rel} must not contain legacy 55000 price`);
  if (rel.includes('booking/Code.js') || rel.includes('Lifecycle.js')) {
    assert.match(text, /INITIAL_PRICE_CLP = 50000/);
    assert.match(text, /FOLLOWUP_PRICE_CLP = 50000/);
  }
}

console.log('LEGACY_PRICE_SCAN=PASS');

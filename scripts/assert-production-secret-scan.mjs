import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = execSync('git ls-files -z', { cwd: root })
  .toString()
  .split('\0')
  .filter(Boolean);

const forbidden = [
  /sk_live_[A-Za-z0-9]+/,
  /AIzaSy[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /client_secret_[A-Za-z0-9-]+/,
  /FLOW_SECRET_KEY\s*=\s*['"](?!synthetic)[^'"]+['"]/,
  /FLOW_API_KEY\s*=\s*['"](?!synthetic)[^'"]+['"]/,
];
const allow = /synthetic-|example\.test|REDACTED|fingerprint/;

for (const rel of files) {
  const text = await readFile(path.join(root, rel), 'utf8');
  if (/client_secret|refresh_token|access_token/.test(rel) && !allow.test(rel)) {
    assert.equal(/credentials\.json$|\.clasprc/.test(rel), false, `credential file tracked: ${rel}`);
  }
  for (const pattern of forbidden) {
    const match = text.match(pattern);
    if (match && !allow.test(match[0])) {
      assert.equal(true, false, `${rel} matched secret pattern ${pattern}`);
    }
  }
}

console.log('SECRET_SCAN=PASS');

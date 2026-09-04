#!/usr/bin/env node
/**
 * Deterministic Production Apps Script staging builder.
 *
 * The Apps Script runtime source directory (backend/appsscript/booking) also
 * holds the test tree, and clasp pushes .js/.gs/.html recursively from its
 * root. A `clasp push` from that directory would therefore upload the
 * test/fixtures/email-preview/*.html fixtures as deployable Apps Script HTML
 * files. Never push from the source directory.
 *
 * This builder copies ONLY the explicit runtime allowlist into an ephemeral
 * directory OUTSIDE the repository, flat, with nothing else. The staged
 * artifact is what a future authorized `clasp push` must use. A private
 * .clasp.json / script ID may be injected into that directory at deployment
 * time; it must never be copied back into Git.
 *
 * Generated, never hand-maintained. Read-only with respect to the repo.
 *
 * Usage:
 *   node scripts/build-production-appsscript-staging.mjs [--out <dir>] [--json]
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_APPS_SCRIPT_ALLOWLIST = Object.freeze([
  'Code.js',
  'Lifecycle.js',
  'EmailTemplates.js',
  'CalendarGateway.js',
  'Reconciliation.js',
  'RefundGateway.js',
  'TriggerInstallGuard.js',
  'appsscript.json',
]);

export const EXPECTED_STAGING_FILE_COUNT = PRODUCTION_APPS_SCRIPT_ALLOWLIST.length;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'backend/appsscript/booking');

const fail = (code, detail) => {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
};

const isInsideRepo = (target) => {
  const relative = path.relative(REPO_ROOT, path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export async function buildProductionStaging(options = {}) {
  const outDir = options.out
    ? path.resolve(options.out)
    : await mkdtemp(path.join(os.tmpdir(), 'fran-appsscript-staging-'));

  // Fail closed: the staged artifact must never live inside the repository,
  // so a stray .clasp.json or script ID cannot be committed by accident.
  if (isInsideRepo(outDir)) fail('STAGING_DIR_INSIDE_REPO', outDir);

  await mkdir(outDir, { recursive: true });

  const existing = await readdir(outDir);
  if (existing.length) fail('STAGING_DIR_NOT_EMPTY', `${outDir} contains ${existing.length} entries`);

  const manifest = [];
  for (const name of [...PRODUCTION_APPS_SCRIPT_ALLOWLIST].sort()) {
    const source = path.join(SOURCE_DIR, name);
    let info;
    try {
      info = await stat(source);
    } catch {
      fail('REQUIRED_RUNTIME_FILE_MISSING', name);
    }
    if (!info.isFile()) fail('REQUIRED_RUNTIME_FILE_NOT_A_FILE', name);
    const target = path.join(outDir, name);
    await copyFile(source, target);
    const bytes = await readFile(target);
    manifest.push({
      name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }

  if (manifest.length !== EXPECTED_STAGING_FILE_COUNT) {
    fail('STAGING_FILE_COUNT_UNEXPECTED', String(manifest.length));
  }

  const fingerprint = createHash('sha256')
    .update(manifest.map((entry) => `${entry.name}:${entry.sha256}`).join('\n'))
    .digest('hex');

  return { stagingDir: outDir, fileCount: manifest.length, manifest, fingerprint };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const result = await buildProductionStaging({ out });
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`STAGING_DIR=${result.stagingDir}`);
    console.log(`STAGING_FILE_COUNT=${result.fileCount}`);
    console.log(`STAGING_FINGERPRINT=${result.fingerprint}`);
    for (const entry of result.manifest) {
      console.log(`  ${entry.name} ${entry.bytes}B sha256=${entry.sha256.slice(0, 16)}…`);
    }
    console.log('DEPLOY_STAGING_STRATEGY=EXACT_ALLOWLIST_EPHEMERAL');
  }
}

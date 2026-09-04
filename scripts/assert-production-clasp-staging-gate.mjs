#!/usr/bin/env node
/**
 * Recursive Production clasp staging release gate.
 *
 * Validates the GENERATED staging artifact, not the top level of the runtime
 * source directory. The previous fileset gate only listed the source
 * directory non-recursively, so it could not see the pushable
 * test/fixtures/email-preview/*.html files nested below it. This gate walks
 * the staged tree in full.
 *
 * Usage:
 *   node scripts/assert-production-clasp-staging-gate.mjs <stagingDir>
 *   node scripts/assert-production-clasp-staging-gate.mjs --build
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_APPS_SCRIPT_ALLOWLIST,
  EXPECTED_STAGING_FILE_COUNT,
  buildProductionStaging,
} from './build-production-appsscript-staging.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// clasp uploads these as Apps Script project files. appsscript.json is the
// manifest; .clasp.json is local clasp config and is never uploaded.
const PUSHABLE_EXTENSIONS = new Set(['.js', '.gs', '.html', '.ts']);
const CLASP_LOCAL_CONFIG = '.clasp.json';

const FORBIDDEN_PATH_WORDS = ['test', 'fixture', 'nonprod', 'sandbox'];
const FORBIDDEN_BASENAMES = ['Código.js', 'TargetedFixture.js'];
const CREDENTIAL_PATTERNS = [
  /^\.clasprc\.json$/i,
  /^credentials\.json$/i,
  /^client_secret/i,
  /^\.env($|\.)/i,
  /\.(pem|key|p12|pfx|crt|credentials|secrets?)$/i,
  /token/i,
];

// macOS may store the accented filename decomposed (NFD), so normalize before
// comparing or "Código.js" can slip past an exact-string check.
const norm = (value) => String(value).normalize('NFC');

const walk = async (root) => {
  const found = { files: [], dirs: [] };
  const recurse = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        found.dirs.push(rel);
        await recurse(full);
      } else {
        found.files.push(rel);
      }
    }
  };
  await recurse(root);
  return found;
};

export async function assertStagingArtifact(stagingDir) {
  const root = path.resolve(stagingDir);
  const failures = [];
  const add = (code, detail) => failures.push(detail ? `${code} (${detail})` : code);

  const info = await stat(root).catch(() => null);
  if (!info || !info.isDirectory()) {
    return { ok: false, failures: [`STAGING_DIR_MISSING (${root})`], deployable: [], stagingDir: root };
  }

  const relativeToRepo = path.relative(REPO_ROOT, root);
  const insideRepo = relativeToRepo === ''
    || (!relativeToRepo.startsWith('..') && !path.isAbsolute(relativeToRepo));
  if (insideRepo) add('STAGING_DIR_INSIDE_REPO', root);

  const { files, dirs } = await walk(root);

  // Flat artifact only: a nested directory is how fixtures leak back in.
  for (const dir of dirs) add('UNEXPECTED_SUBDIRECTORY', dir);

  const deployable = [];
  for (const rel of files) {
    const base = norm(path.basename(rel));
    const ext = path.extname(base).toLowerCase();
    const segments = norm(rel).split(path.sep);

    for (const word of FORBIDDEN_PATH_WORDS) {
      if (segments.some((segment) => segment.toLowerCase().includes(word))) {
        add('FORBIDDEN_PATH_WORD', `${word} in ${rel}`);
      }
    }
    if (FORBIDDEN_BASENAMES.map(norm).includes(base)) add('FORBIDDEN_FILE', rel);
    if (ext === '.html') add('HTML_NOT_ALLOWED', rel);
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(base))) {
      add('CREDENTIAL_FILE_PRESENT', rel);
    }

    if (base === CLASP_LOCAL_CONFIG) continue; // deploy-time private config, not uploaded
    if (PUSHABLE_EXTENSIONS.has(ext) || base === 'appsscript.json') {
      deployable.push(rel);
      continue;
    }
    add('UNEXPECTED_FILE', rel);
  }

  const expected = [...PRODUCTION_APPS_SCRIPT_ALLOWLIST].map(norm).sort();
  const actual = [...deployable].map(norm).sort();

  if (actual.length !== EXPECTED_STAGING_FILE_COUNT) {
    add('DEPLOYABLE_COUNT_UNEXPECTED', `${actual.length} != ${EXPECTED_STAGING_FILE_COUNT}`);
  }
  for (const name of expected) {
    if (!actual.includes(name)) add('REQUIRED_FILE_ABSENT', name);
  }
  for (const name of actual) {
    if (!expected.includes(name)) add('UNEXPECTED_DEPLOYABLE_FILE', name);
  }

  return { ok: failures.length === 0, failures, deployable: actual, stagingDir: root };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const args = process.argv.slice(2);
  let target = args.find((arg) => !arg.startsWith('--'));
  if (args.includes('--build') || !target) {
    const built = await buildProductionStaging();
    target = built.stagingDir;
    console.log(`STAGING_DIR=${target}`);
    console.log(`STAGING_FINGERPRINT=${built.fingerprint}`);
  }
  const result = await assertStagingArtifact(target);
  console.log(`STAGING_FILE_COUNT=${result.deployable.length}`);
  if (!result.ok) {
    for (const failure of result.failures) console.error(`FAIL ${failure}`);
    console.log('STAGING_FILESET_GATE=FAIL');
    console.log('RECURSIVE_FILESET_GATE=FAIL');
    process.exit(1);
  }
  console.log('STAGING_FILESET_GATE=PASS');
  console.log('RECURSIVE_FILESET_GATE=PASS');
  console.log('DEPLOY_STAGING_STRATEGY=EXACT_ALLOWLIST_EPHEMERAL');
}

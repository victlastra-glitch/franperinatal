/**
 * Recursive Production clasp staging release gate.
 *
 * B1: the Apps Script runtime source directory also contains the test tree,
 * and clasp pushes .js/.gs/.html recursively from its root. This test proves
 * (a) that pushing from the source directory would leak pushable HTML
 * fixtures, (b) that the generated staging artifact contains exactly the 8
 * allowlisted files, and (c) that the recursive gate rejects every leak shape.
 *
 * Mutations run against throwaway copies under the OS temp dir, so no
 * mutation artifact is ever written into the repository.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_APPS_SCRIPT_ALLOWLIST,
  EXPECTED_STAGING_FILE_COUNT,
  buildProductionStaging,
} from '../../../../scripts/build-production-appsscript-staging.mjs';
import { assertStagingArtifact } from '../../../../scripts/assert-production-clasp-staging-gate.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const bookingDir = path.resolve(testDir, '..');
const repoRoot = path.resolve(bookingDir, '../../..');

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const temps = [];
const stageCopy = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fran-staging-mutation-'));
  temps.push(dir);
  const target = path.join(dir, 'artifact');
  await cp(baseline.stagingDir, target, { recursive: true });
  return target;
};

const walkRelative = async (root) => {
  const out = [];
  const recurse = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await recurse(full);
      else out.push(path.relative(root, full));
    }
  };
  await recurse(root);
  return out;
};

let baseline;
try {
  // 0. B1 evidence: the source directory is NOT safe to push from.
  // Read tracked paths from the git index rather than walking the live tree:
  // lifecycle-email-v2.test.mjs regenerates test/fixtures/email-preview/ and
  // node --test runs files in parallel, so a live walk of that directory can
  // race with those writes. The index is stable and needs no exclusion, so
  // fixture coverage below is preserved in full.
  const sourceTree = execFileSync('git', ['ls-files', '--', 'backend/appsscript/booking'],
    { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .map((rel) => path.relative('backend/appsscript/booking', rel));
  const pushableFromSource = sourceTree.filter((rel) => /\.(js|gs|html|ts)$/i.test(rel)
    || path.basename(rel) === 'appsscript.json');
  const leakedHtml = pushableFromSource.filter((rel) => /\.html$/i.test(rel));
  check(leakedHtml.length > 0,
    'B1 evidence: the runtime source tree does contain pushable HTML below its top level');
  check(pushableFromSource.length > EXPECTED_STAGING_FILE_COUNT,
    `B1 evidence: pushing the source dir would upload ${pushableFromSource.length} files, not ${EXPECTED_STAGING_FILE_COUNT}`);
  check(leakedHtml.every((rel) => rel.split(path.sep).includes('test')),
    'B1 evidence: the leaked HTML all lives under test/');

  // 1. The generated artifact is exact.
  baseline = await buildProductionStaging();
  temps.push(baseline.stagingDir);
  check(baseline.fileCount === EXPECTED_STAGING_FILE_COUNT && baseline.fileCount === 8,
    'staging artifact holds exactly 8 files');
  const staged = await walkRelative(baseline.stagingDir);
  check(staged.length === 8 && staged.every((rel) => !rel.includes(path.sep)),
    'staging artifact is flat with no nested entries');
  check([...staged].sort().join(',') === [...PRODUCTION_APPS_SCRIPT_ALLOWLIST].sort().join(','),
    'staging artifact contents equal the allowlist exactly');
  check(path.relative(repoRoot, baseline.stagingDir).startsWith('..'),
    'staging artifact lives outside the repository');
  check(/^[0-9a-f]{64}$/.test(baseline.fingerprint), 'staging artifact has a sha256 fingerprint');

  const pass = await assertStagingArtifact(baseline.stagingDir);
  check(pass.ok && pass.failures.length === 0 && pass.deployable.length === 8,
    'recursive gate passes on the clean staging artifact');

  // 2. Mutation: one .html fixture leaks in.
  const htmlCase = await stageCopy();
  await writeFile(path.join(htmlCase, 'booking-confirmed.html'), '<p>fixture</p>');
  const htmlResult = await assertStagingArtifact(htmlCase);
  check(!htmlResult.ok && htmlResult.failures.some((f) => f.startsWith('HTML_NOT_ALLOWED')),
    'HTML_FIXTURE_LEAK_TEST: an injected .html fixture fails the gate');

  // 3. Mutation: the v7 monolith leaks in (NFC/NFD-safe name check).
  const codigoCase = await stageCopy();
  await writeFile(path.join(codigoCase, 'Código.js'.normalize('NFC')), '// v7 monolith');
  const codigoResult = await assertStagingArtifact(codigoCase);
  check(!codigoResult.ok && codigoResult.failures.some((f) => f.startsWith('FORBIDDEN_FILE')),
    'CODIGO_LEAK_TEST: an injected Código.js fails the gate');
  const codigoNfdCase = await stageCopy();
  await writeFile(path.join(codigoNfdCase, 'Código.js'.normalize('NFD')), '// v7 monolith');
  const codigoNfdResult = await assertStagingArtifact(codigoNfdCase);
  check(!codigoNfdResult.ok && codigoNfdResult.failures.some((f) => f.startsWith('FORBIDDEN_FILE')),
    'CODIGO_LEAK_TEST: the decomposed (NFD) spelling also fails the gate');

  // 4. Mutation: a ninth JS file.
  const extraCase = await stageCopy();
  await writeFile(path.join(extraCase, 'TargetedFixture.js'), '// nonprod operator');
  const extraResult = await assertStagingArtifact(extraCase);
  check(!extraResult.ok
    && extraResult.failures.some((f) => f.startsWith('FORBIDDEN_FILE'))
    && extraResult.failures.some((f) => f.startsWith('DEPLOYABLE_COUNT_UNEXPECTED')),
    'EXTRA_JS_LEAK_TEST: a ninth JS file fails the gate on both name and count');
  const ninthCase = await stageCopy();
  await writeFile(path.join(ninthCase, 'Helper.js'), '// unexpected ninth runtime file');
  const ninthResult = await assertStagingArtifact(ninthCase);
  check(!ninthResult.ok
    && ninthResult.failures.some((f) => f.startsWith('UNEXPECTED_DEPLOYABLE_FILE'))
    && ninthResult.failures.some((f) => f.startsWith('DEPLOYABLE_COUNT_UNEXPECTED')),
    'EXTRA_JS_LEAK_TEST: an unlisted ninth .js fails the gate');

  // 5. Mutation: a required runtime file is missing.
  const missingCase = await stageCopy();
  await rm(path.join(missingCase, 'TriggerInstallGuard.js'));
  const missingResult = await assertStagingArtifact(missingCase);
  check(!missingResult.ok
    && missingResult.failures.some((f) => f.includes('REQUIRED_FILE_ABSENT (TriggerInstallGuard.js)'))
    && missingResult.failures.some((f) => f.startsWith('DEPLOYABLE_COUNT_UNEXPECTED')),
    'MISSING_REQUIRED_FILE_TEST: a removed TriggerInstallGuard.js fails the gate');

  // 6. Mutation: a nested test/fixture subtree.
  const nestedCase = await stageCopy();
  await mkdir(path.join(nestedCase, 'test/fixtures'), { recursive: true });
  await writeFile(path.join(nestedCase, 'test/fixtures/helper.js'), '// fixture');
  const nestedResult = await assertStagingArtifact(nestedCase);
  check(!nestedResult.ok
    && nestedResult.failures.some((f) => f.startsWith('UNEXPECTED_SUBDIRECTORY'))
    && nestedResult.failures.some((f) => f.startsWith('FORBIDDEN_PATH_WORD')),
    'a nested test/fixture subtree fails the gate');

  // 7. Mutation: a credential file.
  const credentialCase = await stageCopy();
  await writeFile(path.join(credentialCase, '.clasprc.json'), '{}');
  const credentialResult = await assertStagingArtifact(credentialCase);
  check(!credentialResult.ok
    && credentialResult.failures.some((f) => f.startsWith('CREDENTIAL_FILE_PRESENT')),
    'a credential file in the staging artifact fails the gate');

  // 8. A deploy-time private .clasp.json is tolerated and never counted as deployable.
  const claspCase = await stageCopy();
  await writeFile(path.join(claspCase, '.clasp.json'), '{"scriptId":"REDACTED"}');
  const claspResult = await assertStagingArtifact(claspCase);
  check(claspResult.ok && claspResult.deployable.length === 8,
    'a deploy-time .clasp.json is allowed and is not a deployable file');

  // 9. The gate refuses an artifact located inside the repository.
  const insideRepoResult = await assertStagingArtifact(bookingDir);
  check(!insideRepoResult.ok
    && insideRepoResult.failures.some((f) => f.startsWith('STAGING_DIR_INSIDE_REPO')),
    'the gate refuses a staging artifact inside the repository');

  // 10. No script ID, clasp config, or credential is tracked in Git.
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  check(!tracked.some((rel) => path.basename(rel) === '.clasp.json'),
    'no .clasp.json is tracked in Git');
  check(!tracked.some((rel) => /\.clasprc\.json$|^credentials\.json$|client_secret/i.test(path.basename(rel))),
    'no clasp/OAuth credential file is tracked in Git');
  // Match real identifier SHAPES, not the word "scriptId": this very file
  // contains the literal as a mutation fixture, and a word scan would flag it.
  // Scanned with `git grep --cached`, i.e. against COMMITTED content, which is
  // exactly what "committed to Git" should mean and is race-free while
  // lifecycle-email-v2.test.mjs regenerates its preview fixtures in parallel.
  // Every tracked file, fixtures included, stays in scope.
  const idShapes = [
    'AKfycb[A-Za-z0-9_-]{20,}',                                      // deployment / web app id
    '"scriptId"\\s*:\\s*"(?!REDACTED|PLACEHOLDER)[A-Za-z0-9_-]{25,}"', // real .clasp.json value
    'script\\.google\\.com/macros/s/[A-Za-z0-9_-]{25,}',              // deployed /exec url
  ];
  const idHits = [];
  for (const pattern of idShapes) {
    try {
      const hits = execFileSync('git', ['grep', '-P', '--cached', '-l', pattern, '--', '.'],
        { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
      idHits.push(...hits);
    } catch (error) {
      if (error.status !== 1) throw error; // 1 = no match, the passing case
    }
  }
  check(idHits.length === 0,
    `no Production script/deployment ID is committed to Git (${[...new Set(idHits)].join(',')})`);

  // 11. The runbook must mandate the staged artifact and forbid a direct push.
  const runbook = execFileSync('cat', ['docs/production/PRODUCTION_RC_RUNBOOK.md'],
    { cwd: repoRoot, encoding: 'utf8' });
  check(/build-production-appsscript-staging\.mjs/.test(runbook),
    'runbook names the staging builder');
  check(/assert-production-clasp-staging-gate\.mjs/.test(runbook),
    'runbook names the recursive staging gate');
  check(/never|not|Do \*\*not\*\*/i.test(runbook) && /push .*from .*backend\/appsscript\/booking/i.test(runbook),
    'runbook explicitly forbids pushing from the runtime source directory');
  check(/EXACT_ALLOWLIST_EPHEMERAL/.test(runbook), 'runbook records the staging strategy');
} finally {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
}

// Every mutation artifact lived in the OS temp dir and is now removed.
for (const dir of temps) {
  const stillThere = await readdir(dir).then(() => true, () => false);
  assert.equal(stillThere, false, `mutation artifact not cleaned up: ${dir}`);
  assertions += 1;
}

console.log(`CLASP_STAGING_TESTS=PASS assertions=${assertions}`);
console.log('B1_CLASP_SCOPING=PASS');
console.log(`STAGING_FILE_COUNT=${EXPECTED_STAGING_FILE_COUNT}`);
console.log('STAGING_FILESET_GATE=PASS');
console.log('RECURSIVE_FILESET_GATE=PASS');
console.log('HTML_FIXTURE_LEAK_TEST=FAILS_AS_REQUIRED');
console.log('CODIGO_LEAK_TEST=FAILS_AS_REQUIRED');
console.log('EXTRA_JS_LEAK_TEST=FAILS_AS_REQUIRED');
console.log('MISSING_REQUIRED_FILE_TEST=FAILS_AS_REQUIRED');
console.log('DEPLOY_STAGING_STRATEGY=EXACT_ALLOWLIST_EPHEMERAL');
console.log('MUTATION_ARTIFACTS_REMOVED=YES');

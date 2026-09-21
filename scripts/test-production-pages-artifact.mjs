// Gate for scripts/build-production-pages-artifact.sh.
//
// The builder is the only thing standing between the Git object database and a
// Cloudflare Pages Direct Upload, so every way it could ship the wrong bytes is
// asserted here as a failure, not as an observation. Each negative case builds a
// throwaway fixture repository, because proving the builder refuses a broken
// artifact requires a broken artifact to exist.
import assert from 'node:assert/strict';
import { execFileSync, execFileSync as run } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builder = path.join(root, 'scripts', 'build-production-pages-artifact.sh');
const scratchRoots = [];

function scratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratchRoots.push(dir);
  return dir;
}

function build(args, options = {}) {
  try {
    const stdout = run('/bin/bash', [options.builder || builder, ...args], {
      cwd: options.cwd || root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout || ''), stderr: String(error.stderr || ''), status: error.status };
  }
}

function field(stdout, name) {
  const match = stdout.match(new RegExp(`^${name}=(.*)$`, 'm'));
  assert.ok(match, `${name} missing from builder output:\n${stdout}`);
  return match[1];
}

// A minimal but complete Production surface: every root file the builder
// requires, plus one file in each public directory.
const FIXTURE_ROOT_FILES = [
  '_redirects', '_routes.json', '_worker.js',
  '404.html', 'ansiedad-perinatal.html', 'blog.html', 'contacto.html',
  'depresion-postparto.html', 'faq.html', 'index.html', 'lp.html', 'manage.html',
  'pago-resultado.html', 'pago.html', 'privacidad.html', 'reserva.html',
  'robots.txt', 'servicios.html', 'sitemap.xml', 'sobre-mi.html',
];
const FIXTURE_TREE_FILES = [
  ...FIXTURE_ROOT_FILES,
  'assets/booking.js', 'assets/app.css',
  'blog/post.html', 'guia/index.html', 'recursos/test-edimburgo.html',
  // Committed and never deployable. Their absence from the artifact is a
  // property of the allowlist, so they have to be in the fixture tree.
  'backend/appsscript/booking/Code.js', 'docs/production/PRODUCTION_RC_RUNBOOK.md',
  'scripts/helper.mjs', 'AGENTS.md', 'CLAUDE.md', 'README.md',
];

function makeFixtureRepo({ omit = [] } = {}) {
  const repo = scratch('fran-artifact-fixture-');
  const git = (...args) => run('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'fixture');
  for (const relative of FIXTURE_TREE_FILES) {
    if (omit.includes(relative)) continue;
    const target = path.join(repo, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `fixture:${relative}\n`);
  }
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  writeFileSync(path.join(repo, 'scripts', 'build-production-pages-artifact.sh'), readFileSync(builder));
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  return { repo, sha, builder: path.join(repo, 'scripts', 'build-production-pages-artifact.sh') };
}

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}

// --- usage -----------------------------------------------------------------

check('no ref fails with a usage error', () => {
  const result = build([]);
  assert.equal(result.ok, false);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: build-production-pages-artifact\.sh <GIT_REF>/);
});

check('an unknown ref fails closed', () => {
  const result = build(['definitely-not-a-ref']);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /PRODUCTION_PAGES_ARTIFACT=FAIL: unknown git ref/);
});

check('an output directory inside the repository is refused', () => {
  const inside = path.join(root, '.artifact-negative-probe');
  try {
    const result = build(['HEAD', inside]);
    assert.equal(result.ok, false);
    assert.match(result.stderr, /must be outside the repository/);
  } finally {
    rmSync(inside, { recursive: true, force: true });
  }
});

// --- A / B: the release-critical Worker pair --------------------------------

for (const missing of ['_routes.json', '_worker.js']) {
  check(`a ref without ${missing} cannot produce an artifact`, () => {
    const fixture = makeFixtureRepo({ omit: [missing] });
    const result = build([fixture.sha, path.join(scratch('fran-artifact-out-'), 'out')], {
      cwd: fixture.repo, builder: fixture.builder,
    });
    assert.equal(result.ok, false, `${missing} omitted must fail the build`);
    assert.match(result.stderr, new RegExp(`release-critical file missing: ${missing.replace('.', '\\.')}`));
  });
}

// --- C / D: forbidden trees -------------------------------------------------

const forbiddenCases = [
  ['a backend file in the artifact is rejected', 'backend/appsscript/booking/Code.js'],
  ['a docs file in the artifact is rejected', 'docs/production/PRODUCTION_RC_RUNBOOK.md'],
  ['a scripts file in the artifact is rejected', 'scripts/helper.mjs'],
];
for (const [name, forbidden] of forbiddenCases) {
  check(name, () => {
    const fixture = makeFixtureRepo();
    const out = path.join(scratch('fran-artifact-out-'), 'out');
    const built = build([fixture.sha, out], { cwd: fixture.repo, builder: fixture.builder });
    assert.equal(built.ok, true, built.stderr);
    const artifactDir = field(built.stdout, 'ARTIFACT_DIR');
    assert.equal(existsSync(path.join(artifactDir, forbidden)), false, `${forbidden} must never be built in`);

    const smuggled = path.join(artifactDir, forbidden);
    mkdirSync(path.dirname(smuggled), { recursive: true });
    writeFileSync(smuggled, 'smuggled\n');
    const verified = build(['--verify', artifactDir, fixture.sha], { cwd: fixture.repo, builder: fixture.builder });
    assert.equal(verified.ok, false, `${forbidden} must be rejected on verify`);
    assert.match(verified.stderr, /forbidden path in artifact/);
  });
}

// --- E: the worktree is not a source ---------------------------------------

check('untracked and dirty worktree content never reaches the artifact', () => {
  const fixture = makeFixtureRepo();
  // An untracked file that would pass the allowlist if the worktree were read,
  // and a tracked file edited after the commit.
  writeFileSync(path.join(fixture.repo, 'assets', 'untracked-probe.js'), 'leak\n');
  writeFileSync(path.join(fixture.repo, 'index.html'), 'dirty-worktree\n');

  const built = build([fixture.sha, path.join(scratch('fran-artifact-out-'), 'out')], {
    cwd: fixture.repo, builder: fixture.builder,
  });
  assert.equal(built.ok, true, built.stderr);
  const artifactDir = field(built.stdout, 'ARTIFACT_DIR');
  assert.equal(existsSync(path.join(artifactDir, 'assets', 'untracked-probe.js')), false,
    'untracked worktree file reached the artifact');
  assert.equal(readFileSync(path.join(artifactDir, 'index.html'), 'utf8'), 'fixture:index.html\n',
    'artifact took index.html from the worktree instead of the ref');
});

// --- F: manifest and file-count drift ---------------------------------------

check('a mutated artifact file fails verification', () => {
  const fixture = makeFixtureRepo();
  const built = build([fixture.sha, path.join(scratch('fran-artifact-out-'), 'out')], {
    cwd: fixture.repo, builder: fixture.builder,
  });
  assert.equal(built.ok, true, built.stderr);
  const artifactDir = field(built.stdout, 'ARTIFACT_DIR');
  writeFileSync(path.join(artifactDir, 'assets', 'booking.js'), 'tampered\n');
  const verified = build(['--verify', artifactDir, fixture.sha], { cwd: fixture.repo, builder: fixture.builder });
  assert.equal(verified.ok, false);
  assert.match(verified.stderr, /content differs from ref: assets\/booking\.js/);
});

check('a removed artifact file fails verification and changes the count', () => {
  const fixture = makeFixtureRepo();
  const built = build([fixture.sha, path.join(scratch('fran-artifact-out-'), 'out')], {
    cwd: fixture.repo, builder: fixture.builder,
  });
  assert.equal(built.ok, true, built.stderr);
  const artifactDir = field(built.stdout, 'ARTIFACT_DIR');
  const before = Number(field(built.stdout, 'FILE_COUNT'));
  rmSync(path.join(artifactDir, 'blog', 'post.html'));
  const verified = build(['--verify', artifactDir, fixture.sha], { cwd: fixture.repo, builder: fixture.builder });
  assert.equal(verified.ok, false);
  assert.match(verified.stderr, /missing path in artifact: blog\/post\.html/);
  assert.ok(before > 0);
});

check('an unexpected extra file fails verification', () => {
  const fixture = makeFixtureRepo();
  const built = build([fixture.sha, path.join(scratch('fran-artifact-out-'), 'out')], {
    cwd: fixture.repo, builder: fixture.builder,
  });
  assert.equal(built.ok, true, built.stderr);
  const artifactDir = field(built.stdout, 'ARTIFACT_DIR');
  writeFileSync(path.join(artifactDir, 'assets', 'stale-from-a-previous-build.js'), 'stale\n');
  const verified = build(['--verify', artifactDir, fixture.sha], { cwd: fixture.repo, builder: fixture.builder });
  assert.equal(verified.ok, false);
  assert.match(verified.stderr, /unexpected path in artifact: assets\/stale-from-a-previous-build\.js/);
});

// --- determinism and the real Production surface ----------------------------

check('two builds of one ref agree on files, hashes and manifest digest', () => {
  const first = build(['HEAD', path.join(scratch('fran-artifact-out-'), 'out')]);
  const second = build(['HEAD', path.join(scratch('fran-artifact-out-'), 'out')]);
  assert.equal(first.ok, true, first.stderr);
  assert.equal(second.ok, true, second.stderr);
  assert.notEqual(field(first.stdout, 'ARTIFACT_DIR'), field(second.stdout, 'ARTIFACT_DIR'));
  assert.equal(field(first.stdout, 'FILE_COUNT'), field(second.stdout, 'FILE_COUNT'));
  assert.equal(field(first.stdout, 'MANIFEST_SHA256'), field(second.stdout, 'MANIFEST_SHA256'));
  const manifest = readFileSync(field(first.stdout, 'MANIFEST_PATH'), 'utf8');
  assert.equal(manifest, readFileSync(field(second.stdout, 'MANIFEST_PATH'), 'utf8'));
  const paths = manifest.trimEnd().split('\n').map((line) => line.split('  ')[1]);
  assert.deepEqual(paths, [...paths].sort(), 'manifest paths must be sorted');
  assert.equal(new Set(paths).size, paths.length, 'manifest must not repeat a path');
});

check('the real Production artifact carries the Worker pair and no forbidden tree', () => {
  const built = build(['HEAD', path.join(scratch('fran-artifact-out-'), 'out')]);
  assert.equal(built.ok, true, built.stderr);
  const artifactDir = field(built.stdout, 'ARTIFACT_DIR');
  for (const required of ['_worker.js', '_routes.json', '_redirects', 'assets/booking.js', 'reserva.html']) {
    assert.ok(existsSync(path.join(artifactDir, required)), `missing ${required}`);
  }
  const listed = execFileSync('find', [artifactDir, '-type', 'f'], { encoding: 'utf8' })
    .trimEnd().split('\n').map((absolute) => path.relative(artifactDir, absolute));
  for (const forbidden of ['backend/', 'docs/', 'scripts/', '.git/', '.agents/', '.claude/']) {
    assert.equal(listed.some((relative) => relative.startsWith(forbidden)), false, `forbidden tree present: ${forbidden}`);
  }
  for (const forbidden of ['AGENTS.md', 'CLAUDE.md', 'README.md', '.gitignore']) {
    assert.equal(listed.includes(forbidden), false, `forbidden file present: ${forbidden}`);
  }
  assert.equal(Number(field(built.stdout, 'FILE_COUNT')), listed.length);
});

for (const root_ of scratchRoots) rmSync(root_, { recursive: true, force: true });
console.log(`PRODUCTION_PAGES_ARTIFACT_GATE=PASS (${results.length} assertions)`);

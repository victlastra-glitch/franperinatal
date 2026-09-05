// Fails closed if the Claude and Codex project-skill trees are not byte-identical,
// or if a skill is missing the frontmatter agents rely on for discovery.
// Read-only. No network, no external service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_ROOT = path.join(root, '.claude/skills');
const CODEX_ROOT = path.join(root, '.agents/skills');

async function walk(base, rel = '') {
  const out = new Map();
  let entries;
  try {
    entries = await readdir(path.join(base, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of await walk(base, next)) out.set(k, v);
    } else {
      const buf = await readFile(path.join(base, next));
      out.set(next, createHash('sha256').update(buf).digest('hex'));
    }
  }
  return out;
}

const claude = await walk(CLAUDE_ROOT);
const codex = await walk(CODEX_ROOT);

assert.ok(claude.size > 0, '.claude/skills is empty; the project has no Claude skills');

const missingInCodex = [...claude.keys()].filter((k) => !codex.has(k)).sort();
const missingInClaude = [...codex.keys()].filter((k) => !claude.has(k)).sort();
assert.deepEqual(missingInCodex, [], `present for Claude but not Codex: ${missingInCodex.join(', ')}`);
assert.deepEqual(missingInClaude, [], `present for Codex but not Claude: ${missingInClaude.join(', ')}`);

const drifted = [...claude.entries()]
  .filter(([rel, hash]) => codex.get(rel) !== hash)
  .map(([rel]) => rel)
  .sort();
assert.deepEqual(drifted, [], `skill bodies differ between the two trees: ${drifted.join(', ')}`);

// Every skill directory must hold exactly one SKILL.md with usable frontmatter.
const skillFiles = [...claude.keys()].filter((rel) => rel.endsWith('SKILL.md')).sort();
const dirs = (await readdir(CLAUDE_ROOT, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
assert.deepEqual(
  skillFiles,
  dirs.map((d) => `${d}/SKILL.md`),
  'each skill directory must contain exactly one SKILL.md at its root',
);

for (const dir of dirs) {
  const text = await readFile(path.join(CLAUDE_ROOT, dir, 'SKILL.md'), 'utf8');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(front, `${dir}/SKILL.md is missing YAML frontmatter`);
  const name = /^name:[ \t]*(\S.*)$/m.exec(front[1]);
  const description = /^description:[ \t]*(\S.*)$/m.exec(front[1]);
  assert.ok(name, `${dir}/SKILL.md frontmatter has no name`);
  assert.ok(description, `${dir}/SKILL.md frontmatter has no description`);
  assert.equal(name[1].trim(), dir, `${dir}/SKILL.md name must equal its directory`);
  const len = description[1].trim().length;
  assert.ok(len >= 60, `${dir} description is too thin to route on (${len} chars)`);
  assert.ok(len <= 600, `${dir} description is too long for metadata (${len} chars)`);
  // A router that points at a file nobody ships is worse than no router.
  assert.equal(
    /docs\/booking\/|docs\/control-tower\/|docs\/deployment\/|docs\/recovery\//.test(
      text.replace(/^.*gitignored.*$/gm, '').replace(/^.*local (only|workstation).*$/gm, ''),
    ),
    false,
    `${dir}/SKILL.md cites a gitignored docs path as if it were tracked`,
  );
}

console.log(`AGENT_SKILLS_PARITY=PASS skills=${dirs.length} files=${claude.size}`);

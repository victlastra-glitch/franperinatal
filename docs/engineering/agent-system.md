# Agent instruction system

How coding agents are governed in this repository, and how to maintain it. This page
describes the *system*; it does not restate any rule. Rules live in `AGENTS.md` and
in the skill bodies.

## Architecture

```
AGENTS.md                     single shared authority: invariants, routing, gates
├── CLAUDE.md                 pointer only; no independent project authority
├── .claude/skills/<n>/SKILL.md   project skills, Claude Code
└── .agents/skills/<n>/SKILL.md   the same bytes, Codex
docs/production/**            canonical domain documents (tracked)
scripts/assert-agent-skills-parity.mjs   gate that keeps the two trees identical
```

Both agents read `AGENTS.md` from the repository root. Claude additionally reads
`CLAUDE.md`, which only redirects to `AGENTS.md`, so no rule can reach one agent and
not the other.

## Skills

Eleven project skills, one owner per concern. The routing table and the ownership
matrix are in `AGENTS.md`; do not duplicate them here.

| Skill | Type |
| --- | --- |
| `fran-booking-lifecycle` | domain |
| `fran-payment-integrity` | domain |
| `fran-reconciliation-integrity` | domain |
| `fran-workflow-automation-integrity` | domain |
| `fran-content-claims` | domain |
| `fran-worker-api-contract` | infra / delivery |
| `fran-frontend-web` | engineering |
| `fran-security-privacy` | engineering |
| `fran-systematic-debugging` | engineering |
| `fran-testing-contract` | engineering |
| `fran-release-quality-gate` | infra / delivery |

Each skill names the canonical document for its domain and the offline gates that
prove work in it. None duplicates a canonical document.

## Claude / Codex parity

The trees are byte-identical by construction. The gate is:

```
node scripts/assert-agent-skills-parity.mjs
```

It fails closed on a file present in one tree only, on any content drift, on a skill
directory without exactly one `SKILL.md`, on missing or unusable frontmatter, on a
frontmatter `name` that does not match its directory, and on a skill citing a
gitignored `docs/` path as if it were tracked.

There is no CI in this repository — hosted Actions minutes are unavailable and
`NEW_GITHUB_ACTIONS=0` is a standing constraint — so the gate is a local script in
the existing `scripts/assert-*.mjs` family, listed in `AGENTS.md` as required for any
change to agent instructions, and in `fran-release-quality-gate` as part of a release
candidate. If CI is ever introduced, this one command is what it must run; the
equivalent shorthand is `diff -r .claude/skills .agents/skills`.

## Maintenance

- Edit the skill under `.claude/skills/`, then mirror:
  `rm -rf .agents/skills && cp -R .claude/skills .agents/skills`
- Re-run the parity gate. Never hand-edit one tree only.
- Symlinking the two trees is not used: it does not survive every clone, checkout or
  archive path this project relies on.
- Adding a skill means adding its row to the ownership and routing tables in
  `AGENTS.md`. A skill that no routing row points at is dead weight — delete it.
- Overlap is resolved by moving the boundary between two skills, never by adding a
  third.
- Keep descriptions discriminative — "Use when X. Not for Y." — because that line is
  what decides whether the skill loads.

## Relationship to Cursor and other global skills

At the time of writing, this workstation carries eleven Cloudflare product skills,
identical under `~/.cursor/skills` and `~/.claude/skills` (`cloudflare`, `wrangler`,
`workers-best-practices`, `durable-objects`, `agents-sdk`, `sandbox-sdk`,
`turnstile-spin`, `web-perf`, `cloudflare-email-service`, `cloudflare-one`,
`cloudflare-one-migrations`). A global `~/.codex/AGENTS.md` also exists.

All of it is **optional context**. This project deploys a static Pages site with a
single proxy Worker: none of those skills describes the architecture here, and none
is required for correctness. Where a global instruction and this repository
disagree, the repository wins.

```
GLOBAL_DEPENDENCY_FOR_CORRECTNESS=NO
```

If a global skill ever becomes load-bearing, that is a defect: move what is needed
into a project skill so both agents get it from Git.

## Testing and release

Test selection and the browser-verification obligation are owned by
`fran-testing-contract`; the release states and their evidence by
`fran-release-quality-gate`. The tracked list of gates for a release candidate is the
**Running the gates** section of
`docs/production/CANCELLATION_RESCHEDULE_POLICY_V2.md`.

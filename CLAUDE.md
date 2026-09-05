# CLAUDE.md

Read and obey `AGENTS.md`. It is the single authority for this repository and it is
shared with Codex.

This file deliberately carries **no project rules of its own**. Anything material
belongs in `AGENTS.md` or in a skill, so that every agent gets identical behaviour.

- Project skills for Claude Code: `.claude/skills/<name>/SKILL.md`
- The same skills for Codex: `.agents/skills/<name>/SKILL.md`
- The two trees are byte-identical; `scripts/assert-agent-skills-parity.mjs` enforces it.

Skill routing, sources of truth, invariants, testing and the release gate are all in
`AGENTS.md`. How the system is maintained is in `docs/engineering/agent-system.md`.

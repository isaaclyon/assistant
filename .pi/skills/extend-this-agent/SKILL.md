---
name: extend-this-agent
description: "Extends and maintains this Telegram agent's own repo-local skills, Pi extensions, host source, tests, and documentation. Use when adding a capability, changing agent behavior, or repairing the bridge's internals."
---

# Extend This Agent

You are explicitly allowed to improve this agent from inside its own repository. You may create or edit repo-local skills and extensions, and you may change `src/`, tests, scripts, dependencies, documentation, and architecture when the requested outcome requires it. Treat the repository—not global Pi configuration—as the agent's capability boundary.

## Choose the smallest mechanism

- **Skill** (`.pi/skills/<name>/SKILL.md`): instructions for work the model can already perform with its available tools. Start from [the skill scaffold](templates/skill/SKILL.md).
- **Extension** (`.pi/extensions/<name>.ts`): executable Pi behavior such as a custom tool, command, event hook, or UI integration. Start from [the single-file extension scaffold](templates/extension.ts).
- **Core source** (`src/`): host lifetime, persistence, Telegram capability boundaries, resource loading, setup, or service behavior. Read [the project map](references/project-map.md) first.

Prefer a skill over code when guidance is sufficient. Prefer one extension file until the implementation genuinely needs multiple modules. Prefer a custom tool over shell instructions when a command-backed capability should be reliable and reusable.

## Workflow

1. Inspect the nearest existing example and the relevant source/tests before editing.
2. For runtime-boundary changes, read `ARCHITECTURE.md` and `docs/adr/` first. Record a durable new decision in an ADR when appropriate.
3. Add a failing behavior test first when a test harness exists, then make the smallest implementation that passes.
4. Keep credentials and `~/.pi/agent/telegram.json` secret. Never broaden `src/host.ts` resource filtering to load global or ancestor capabilities.
5. Run `npm run check` and `npm run build` after code changes. For a skill-only documentation change, inspect links and frontmatter; the full checks are optional unless another file changed.
6. Explain what changed and any deployment requirement. Do not enable, restart, or deploy the live service unless the user explicitly asks.

Changes become available to the running Telegram agent only after they are committed, merged, and deployed by the repository workflow. A local interactive Pi may use `/reload` for repo-local skills and extensions.


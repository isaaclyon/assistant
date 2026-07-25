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

## Telegram-visible slash commands

To add a slash command that appears in Telegram's `/` autocomplete menu, call
`registerReloadSafeTelegramCommand` from `.pi/lib/telegram-command.ts` with
`showInMenu: true` and an `emoji` — start from [the Telegram command scaffold](templates/telegram-command.ts).
That helper registers through the fork's Telegram registry (dispatched at the
Telegram layer and listed in the menu) and handles the reload-safe
re-registration the process-global registry requires. Do **not** use
`pi.registerCommand` for a menu command: those still run when typed but only reach
Pi as a forwarded turn, so they never show in autocomplete. Extension files are
type-checked via `npm run check` (`tsconfig.extensions.json`). Working examples:
`.pi/extensions/restart.ts` and `.pi/extensions/skills.ts`.

## Workflow

1. Inspect the nearest existing example and the relevant source/tests before editing.
2. For runtime-boundary changes, read `ARCHITECTURE.md` and `docs/adr/` first. Record a durable new decision in an ADR when appropriate.
3. Add a failing behavior test first when a test harness exists, then make the smallest implementation that passes.
4. Keep credentials and `~/.pi/agent/telegram.json` secret. Never broaden `src/host.ts` resource filtering to load global or ancestor capabilities.
5. Run `npm run check` and `npm run build` after code changes. For a skill-only documentation change, inspect links and frontmatter; the full checks are optional unless another file changed.
6. Explain what changed and any deployment requirement. For a completed,
   validated coding change, the standing coding publish instruction authorizes
   committing, merging, and the repository's normal deployment workflow; do not
   enable, restart, or reconfigure the live service as a separate operational
   action unless the user explicitly asks.

Changes become available to the running Telegram agent only after they are committed, merged, and deployed by the repository workflow. A local interactive Pi may use `/reload` for repo-local skills and extensions.

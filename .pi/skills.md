# Skills

Repo-local skills for the bridge agent. Each skill is a directory containing a `SKILL.md` (frontmatter: `name`, `description`).

Only resources inside this repo load on the host (see `src/host.ts`); commit here and `npm run deploy` to ship.

- [personal-memory](skills/personal-memory/SKILL.md) — explicit-consent durable personal memory in a private external Markdown vault, via a skill-local stdin JSON CLI.

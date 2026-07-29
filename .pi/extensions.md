# Extensions

Repo-local Pi extensions for the bridge agent. Each extension is a `.ts`/`.js` file (or directory with an entry point) exporting a Pi extension.

Only resources inside this repo load on the host (see `src/host.ts`); commit here and `npm run deploy` to ship.

For a Telegram-visible slash command, use `registerReloadSafeTelegramCommand` from
`.pi/lib/telegram-command.ts` (see the `extend-this-agent` skill). Extension files
are type-checked by `npm run check` via `tsconfig.extensions.json`.

- `restart.ts`: the `/restart` command. Restarts the bridge process so it comes
  back on the deployed release (distinct from Pi's built-in `/reload`, which
  hot-reloads skills/extensions in-process). See `docs/adr/0006`.
- `deploy.ts`: the builder-only `/deploy` command. Loads the tracked GitHub
  finish-line prompt and exposes it in Telegram autocomplete.
- `skills.ts`: the `/skills` command. Lists available skills with a short
  description of each; menu-visible in Telegram autocomplete.
- `google-workspace.ts`: one typed, allowlisted Google integration tool backed
  by externally configured `gogcli`. It exposes account status plus bounded,
  read-only Calendar listing, event search, and availability operations, plus
  bounded Gmail thread search and sanitized thread retrieval. It exposes no
  Gmail send, draft, or mutation operation. Other service operations are added
  by their feature issues. See
  `docs/google-workspace.md` and ADR-0027.

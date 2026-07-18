# Extensions

Repo-local Pi extensions for the bridge agent. Each extension is a `.ts`/`.js` file (or directory with an entry point) exporting a Pi extension.

Only resources inside this repo load on the host (see `src/host.ts`); commit here and `npm run deploy` to ship.

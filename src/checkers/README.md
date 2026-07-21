# Heartbeat checkers

Put repository-specific heartbeat checkers here as TypeScript. The normal build
emits them under `dist/src/checkers/`. Jobs refer to the filename stem as
`checker.id`; the host resolves and executes that compiled JavaScript beside its
own immutable-release modules, not source from the canonical checkout or a shell
command.

A checker is stateless. It fetches and normalizes one current value, writes one
versioned JSON observation to stdout, and exits nonzero on operational failure.
The host owns comparison and temporal state under the bridge state directory.

Minimal shape:

```ts
import type { HeartbeatObservationV1 } from "../heartbeat.js";

const value = await fetchCurrentValue();
const observation = {
  version: 1,
  value,
  display: String(value),
} satisfies HeartbeatObservationV1;

process.stdout.write(`${JSON.stringify(observation)}\n`);
```

Keep stdout at or below 4 KB and reserve stderr for bounded diagnostics. Emit
only normalized data needed by the configured rule or prompt; never emit
credentials or unrestricted external content.

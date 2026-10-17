# C1 provider/auth probe

Prototype-only evidence against pi-ai/pi-durable/chord 1.3.0. Run from the native checkout:

```sh
npm test -- prototypes/durable-c1/provider/provider.test.ts
```

## Proven locally

- Two independent `Models` owners share an injected synthetic `CredentialStore`; twelve concurrent auth resolutions refresh an expired credential once. A failed refresh preserves its stored credential and never reads the environment fallback. Metadata enumeration returns only provider and credential type.
- Host-side catalog validation rejects unknown models and unsupported thinking. The installed OpenAI catalog supplies a model supporting `max` (selected dynamically from the pinned catalog), and the actual adapter serializes its mapped `max` effort.
- The native OpenAI Responses implementation performs actual request serialization and SSE decoding, with only its documented `fetch` option replaced. Every request terminates in the deterministic transport; no upstream network is used. The wrapper injects this option at the supported `ProviderStreams` boundary because Harness's curated stream settings do not expose fetch.
- Updated instructions, named section patches, executable JSON schemas, tool replacement/removal, and removal of every tool reach the actual serialized request. Input context is unchanged.
- Native Harness handles a synthetic HTTP 503 with SDK retries disabled, retries as a durable generation attempt, emits streaming message updates, and settles a final committed assistant answer. Provider session identity remains stable across those attempts.

## Differences and limits

The prior `tests/codex-request.test.ts` fixtures exercise the legacy conversion extension's Codex serializer. Native OpenAI Responses sends leading instructions as a developer message in `input`, rather than a top-level `instructions` string. For the selected catalog model, later section changes remain positional: the original prefix still contains OLD_RULES and REMOVE_ME, followed by explicit replacement/removal instructions. The active tool list excludes removed tools. This is native documented behavior, not byte-for-byte legacy serializer parity.

This probe selects the current `openai` provider/API approach. pi-ai describes `openai-codex` as legacy, superseded by OpenAI's Sign in with ChatGPT. The real built-in API-key auth resolver and catalog are used for requests; OAuth refresh behavior uses a synthetic public `OAuthAuth` implementation to avoid contacting auth servers. The in-memory store demonstrates shared process-local serialization only. Cross-process credential locks, disk encryption, actual refresh rotation and credential migration are unproven.

Harness stream settings expose transport, timeout, retry limits, headers, metadata, cache retention, and deferred options. They do not directly expose the OpenAI API-specific `serviceTier` or reasoning-summary controls. A supported ProviderStreams wrapper could supply such settings after a separate parity decision. Fast-mode, subscription usage/account headers, deployed Codex model aliases, and exact legacy request parity remain C4 work.

## Live evidence and remaining decision

**Real-provider API-key smoke passed.** After authorized discovery of existing private configuration, a disposable native Harness with SQLite WAL/FULL committed the requested fixed-marker response. A second provider turn generated the labeled text for the authorized outbound Telegram smoke. Credentials entered through private process input, without persistence or logging. Private scripts and receipts remain outside the repository. No live-service action occurred. Real OAuth login/refresh remains unverified.

Recommended decision: use the native `openai` provider with its supported ChatGPT OAuth flow for future subscription parity work, and validate its request/account behavior separately before accepting it as replacement for legacy Codex conversion. If retaining `openai-codex` is required, add an equivalent isolated native-Codex transport probe; this suite does not claim that path is proven.

Validation: four provider tests pass. See the [combined pilot evidence](../README.md) for the final whole-prototype count, typecheck and build results. No SDK internals patched or imported.

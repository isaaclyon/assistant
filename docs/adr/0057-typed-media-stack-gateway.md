---
status: proposed
relates-to: ADR-0051, ADR-0056
---

# Typed media-stack access through a credential-holding gateway

The household runs Sonarr, Radarr, Prowlarr and Seerr on a separate media host. An
engineering shell on the application host can already log in to that host as an
administrator and run commands. Nothing records that access, and the isolated
personal runtime has no SSH credentials, tailnet access or Docker socket
(ADR-0051, ADR-0056). Both bots should answer media questions and request titles
without gaining administrator authority.

## Decision

Add a typed `media_stack` (read) and `media_request` (Seerr request) tool pair, a local
gateway, and a restricted collector on the media host.

- **Native tools.** `src/durable/media-stack.ts` registers the tools only for
  profiles with the `mediaStack` policy flag (`durable-personal-isaac`,
  `durable-builder`) and only when the instance configuration names a gateway socket.
  Without the socket the bundle registers no tools, so existing instances start
  unchanged. Reads replay safely. A request is replay-unsafe: recovery reports an
  interruption and the skill checks the request list before any new attempt.
- **Gateway.** `scripts/media-gateway.mjs` runs under its own identity, holds the only
  SSH key, and listens on a filesystem Unix socket. Pathname sockets cross the
  personal network namespace, so the runtime needs no network change. The gateway
  accepts one typed JSON line per connection, rejects anything outside a fixed
  operation list, and runs SSH with no agent, a pinned host key, a literal IPv4
  address and no command. It never retries and enforces size, time and concurrency
  limits. Request creation is off unless the operator sets `allowRequests`.
- **Collector.** `scripts/media-stack-collector.py` is the remote end of an SSH forced
  command. It reads one request from stdin, validates it again, and calls local
  Sonarr, Radarr, Prowlarr and Seerr APIs. It reads API keys from root-owned files
  that the caller cannot see, and returns bounded, field-filtered JSON. It accepts no
  URL, header, path or shell text. The operations are health, queue, upcoming,
  library search, Seerr search, request list and request create.

The tools cannot delete media, restart containers, change settings, trigger
searches or read logs. Those stay with an administrator.

## Consequences

- The personal runtime holds no SSH key, host name or API key. A compromised runtime
  can use only the operations above, and request creation only while the operator
  allows it.
- The engineering shell keeps its existing broad access. This decision adds a
  narrower path and a record of it. Removing the shell's media SSH key is a separate
  administrator decision.
- Provisioning (key, sudo wrapper, forced command, gateway unit, group membership,
  instance configuration) is operator work, described in
  [media stack](../media-stack.md). The configuration digest pin means the instance
  configuration change needs a normal deployment.
- Adding a service later needs a collector operation, a gateway allowlist entry and a
  tool change. It never needs host-specific release code.

## Activation on existing stores

The bundle is registered for both profiles whether or not a socket is configured,
so it changes the stored compatibility contract. Existing stores therefore need the
`mediaUpgradeFrom` selector, which accepts exactly this change against a pinned
predecessor and nothing else. See `docs/media-stack.md`.

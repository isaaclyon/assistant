# Media stack access

Typed read and request access to Sonarr, Radarr, Prowlarr and Seerr for the
personal Isaac and builder bots. See
[ADR-0057](adr/0057-typed-media-stack-gateway.md) for the decision. These steps
need an administrator and are separate from merging code. Keep real addresses,
keys, paths and the task manifest outside the repository.

## Parts

| Part | Runs on | Source |
| --- | --- | --- |
| Collector (forced SSH command) | media host | `scripts/media-stack-collector.py` |
| Gateway (holds the SSH key, serves a Unix socket) | application host | `scripts/media-gateway.mjs` |
| Tools `media_stack`, `media_request` | inside each bot | `src/durable/media-stack.ts` |
| Skill | inside each bot | `.pi/skills/manage-media/SKILL.md` |

Operations: `health`, `queue`, `upcoming`, `library_search`, `request_search`,
`request_list`, and `request_create` (only when the gateway has
`allowRequests: true`).

## 1. Media host

1. Install the collector at a root-owned path such as
   `/usr/local/libexec/media-stack-collector.py`, and a root-owned config
   (`/etc/media-stack/collector.json`):

   ```json
   {"version":1,"services":{
     "sonarr":{"url":"http://127.0.0.1:8989","apiKey":{"file":"<sonarr config.xml>","xml":"ApiKey"}},
     "radarr":{"url":"http://127.0.0.1:7878","apiKey":{"file":"<radarr config.xml>","xml":"ApiKey"}},
     "prowlarr":{"url":"http://127.0.0.1:9696","apiKey":{"file":"<prowlarr config.xml>","xml":"ApiKey"}},
     "seerr":{"url":"http://127.0.0.1:5055","apiKey":{"file":"<seerr settings.json>","json":"main.apiKey"}}}}
   ```

   URLs must be plain `http` on loopback or this host's own tailnet address (`100.64.0.0/10`). Use the real container config paths on the host.
   Omit a service to disable it.
2. Add a root-owned wrapper that runs
   `/usr/bin/python3 -I /usr/local/libexec/media-stack-collector.py /etc/media-stack/collector.json`
   with `timeout 25`, accepts no arguments, and ignores `SSH_ORIGINAL_COMMAND`.
3. Create a non-login account (for example `media-collector`) with no Docker group
   and no general sudo. Allow only the wrapper with an empty argument list. Keep its
   home and `authorized_keys` root-owned and not writable by the account.
4. Authorize one new key for that account with
   `restrict,from="<application host tailnet IP>",command="sudo <wrapper>" ssh-ed25519 ...`.
   The key is separate from every existing administrator key.
5. Verify from the application host: a request returns JSON, and a shell, `-L`
   forward, `scp` and a different command all fail.

## 2. Application host

1. Create a dedicated gateway user (for example `pi-media-gateway`) that owns the
   private key (mode `0600`) and a pinned `known_hosts` file. Verify the media host
   fingerprint out of band.
2. Write the gateway config, root-owned and readable by the gateway user:

   ```json
   {"version":1,"socketPath":"/run/media-gateway/gateway.sock","socketMode":432,
    "allowRequests":true,"maxConcurrent":2,
    "ssh":{"host":"<media host tailnet IPv4>","user":"media-collector",
           "key":"<private key>","knownHosts":"<known_hosts>"}}
   ```

   `socketMode` is decimal for `0660`. Set `allowRequests` to `false` for read-only use.
3. Install a systemd unit that runs
   `node /opt/.../scripts/media-gateway.mjs <config>` as `User=pi-media-gateway`
   with `Group=` set to the personal runtime's group, so the socket's group is that
   group. Use `RuntimeDirectory=media-gateway`, `RuntimeDirectoryMode=0750`,
   `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`,
   `PrivateTmp=yes`, and `IPAddressDeny=any` with `IPAddressAllow=<media host>/32`.
   Keep the key readable by the user only, not by the group.
4. The personal unit has no supplementary groups, so its primary group must own the
   socket as above. The builder runs as an ordinary user service: add that user to the
   same group, or provision a second socket for it.

## 3. Instance configuration

The media bundle is part of the stored runtime compatibility contract of
`durable-personal-isaac` and `durable-builder`. A store created before this release
refuses to start on it, with or without the socket setting, unless the new private
configuration selects the one-time upgrade below. Deploy through the staged
procedure in [pi-durable-c6-rehearsal.md](pi-durable-c6-rehearsal.md#media-bundle-upgrades).

```json
{"mediaStack":{"socketPath":"/run/media-gateway/gateway.sock"},
 "mediaUpgradeFrom":{"configPath":"/private/retained-prior.json","sha256":"<exact prior configuration SHA-256>"}}
```

Only `durable-personal-isaac` and `durable-builder` accept `mediaStack`. Other
profiles reject it. Drop `mediaUpgradeFrom` from later configurations.

## Acceptance checks

- `media_stack` with `health` returns each service as reachable.
- `library_search` for a known title finds it.
- `request_search` for a multiword title succeeds, not just a single word.
  The collector uses percent-encoded URI components (`%20` for spaces).
  Seerr's OpenAPI validator rejects the raw `+` used by form-style encoding.
  If single-word search works but multiword search returns HTTP 400, check the
  installed collector version before treating it as a service outage. A
  collector-only fix needs an administrator to replace the root-owned collector
  on the media host; merging code or upgrading a bot alone does not install it.
  Verify through the typed tool after installation; no service restart is needed
  for the per-request collector.
- `media_request` for an already-requested title returns `ALREADY_EXISTS`.
- With `allowRequests` false, `media_request` returns `REQUESTS_DISABLED`.
- Stop the gateway: both tools return `MEDIA_GATEWAY_UNAVAILABLE` once, without
  retries.
- Confirm the personal runtime still has no route to the media host and holds no key.

## Retirement

Remove `mediaStack` from the instance configuration and deploy, stop and disable the
gateway unit, delete the collector key line on the media host and the gateway key and
configuration. Removing the key does not end any session already in progress.

# Private editable Messages links

The `message-link` skill produces Telegram-clickable HTTPS links that open a
small review page. Recipient, display label, and proposed body are encoded only
after `#`, so browsers do not send them in the HTTPS request. The user can edit
the body, must tap **Open Messages**, and must separately send inside Messages.

## Tailscale requirement

Production requires:

- `tailscaled` connected to the intended tailnet with HTTPS enabled;
- MagicDNS/reachability for the node's `*.ts.net` name;
- tailnet grants or ACLs that allow only intended users/devices;
- noninteractive `sudo -n tailscale serve ...` permission for the production
  deployment user; and
- HTTPS port 8443 reserved for this page, with no Funnel exposure.

The normal merged deployment runs:

```bash
scripts/activate-messages-link.sh <immutable-release-path>
```

It points Tailscale Serve at `<release>/web/messages`, checks that port 8443 has
no `AllowFunnel` entry, and fetches `/healthz` through the tailnet HTTPS name.
It refuses to overwrite an existing public Funnel endpoint. Do not run
`tailscale funnel` for this page.

Inspect it with:

```bash
tailscale serve status --json
curl "https://$(tailscale status --json | jq -r '.Self.DNSName[:-1]'):8443/healthz"
```

Expected health content is exactly `ok`. A content page request contains no
recipient or draft because URL fragments are not part of HTTP requests.

## Lifecycle and failure behavior

`tailscaled` owns HTTPS and static serving across login sessions and reboots.
Each successful repository deployment repoints Serve to the exact immutable
release after bridge readiness and before old release cleanup. If configuration,
privacy validation, or HTTPS health fails, the activation script restores the
prior Serve target and the deployment reports failure. It does not restart a
healthy Telegram bridge merely because this post-readiness auxiliary activation
failed.

To disable the page intentionally:

```bash
sudo tailscale serve --https=8443 off
```

That is an operational removal, not part of routine deployment. Re-running a
normal deployment restores the configured private page.

## Generating a link manually

The tracked helper reads private values from stdin and emits JSON:

```bash
printf '%s\n' '{"to":"+18018851827","label":"Emma","body":"Dinner tonight?"}' \
  | node .pi/skills/message-link/scripts/messages-link.mjs
```

By default it derives `https://<node>.<tailnet>.ts.net:8443/` from
`tailscale status`. Set `PI_TELEGRAM_MESSAGES_BASE_URL` to a credential-free
HTTPS origin ending in `/` only when another approved private origin is used.

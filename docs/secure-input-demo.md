# Telegram private-form prototype

This demo tests Telegram Mini App launch, private Tailscale HTTPS, signed user
identity, and a single dummy submission. **Use only sample code `123456`.** It
does not fill a website or accept credentials.

## Run

From a built immutable release on the bridge host:

```sh
node dist/src/secure-input-demo-cli.js <private-instance-id> 8445
```

The launcher uses the normal `PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST`,
`PI_TELEGRAM_BRIDGE_CONFIG_ROOT`, and `PI_CODING_AGENT_DIR` configuration. The
selected instance must have a private Telegram surface and a paired named
profile. Telegram configuration must be owned by the operator and mode `0600`.
No tokens belong in arguments or environment overrides.

Prerequisites: Tailscale connected with HTTPS enabled, an unused HTTPS port,
and noninteractive permission for `sudo -n tailscale serve`. The launcher checks
that the selected port has no background/foreground handler or Funnel grant.
It creates a temporary foreground Serve mapping and verifies HTTPS before
sending the button. It neither polls Telegram nor changes persistent bot menus.

Keep the process running. Ctrl-C or SIGTERM removes the temporary endpoint;
otherwise the demo expires after fifteen minutes. A terminal status is printed
without input values. Completion/cancellation edits the original bot message.
If cleanup reports a problem, inspect `tailscale serve status --json`; never
reset the whole Serve configuration because other services use it.

## Phone acceptance check

1. Enable Tailscale on the phone. Open the selected bot's **private chat**.
2. Tap **Open test form**. Check that it opens inside Telegram.
3. Confirm the page says Telegram identity was verified.
4. Enter `123456`, then submit. Check both the form's success message and the
   bot's completion notice. No code should appear in that notice.
5. On a fresh launch, test Cancel. On another launch, allow expiry and verify the
   button is removed and the endpoint closes.

Opening the URL in an ordinary browser lacks Telegram-signed launch data and
must leave the form disabled. A forwarded button must not authorize a different
Telegram user. If the page cannot load in Telegram while Tailscale is connected,
record the client/platform and error; do not enable Funnel as a workaround.

## Future production capability

Use the result of the phone check to choose hosting. Then add a host-owned request
service, a typed Pi tool, supported Mini App buttons in the pinned Telegram fork,
and an exclusive browser input operation bound to the launch/tab/origin/fields.
Keep screenshots and ordinary reads paused until sensitive fields are cleared
or safely left behind. Continue to use the existing SSH browser handoff for
privileged input until that protected path is implemented and tested.

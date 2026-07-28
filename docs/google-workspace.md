# Google Workspace runtime setup

The bridge wraps [`gogcli`](https://github.com/openclaw/gogcli) behind the typed
`google_workspace` tool. The model never receives arbitrary `gog` command access.
Only profiles explicitly containing the extension can use it.

## Install gogcli

Install a reviewed version and record its absolute path. On Linux with Homebrew:

```bash
brew install openclaw/tap/gogcli
command -v gog
gog version
```

Upgrades are deliberate operator actions. Run repository checks against a new
version before changing the deployed path.

## Create external credential storage

Choose a private per-instance `GOG_HOME` and a path outside the repository for
the encrypted-file keyring password. Separate homes prevent one assistant
instance from selecting another instance's stored account. Generate the password
without printing it:

```bash
install -d -m 700 ~/.local/share/pi-telegram-bridge/google/isaac
umask 077
openssl rand -base64 48 > ~/.local/share/pi-telegram-bridge/google/isaac/keyring-password
chmod 600 ~/.local/share/pi-telegram-bridge/google/isaac/keyring-password
```

Configure `gog` while exposing the password only to that process:

```bash
export GOG_HOME="$HOME/.local/share/pi-telegram-bridge/google/isaac/gog"
export GOG_KEYRING_PASSWORD="$(cat ~/.local/share/pi-telegram-bridge/google/isaac/keyring-password)"
gog auth keyring file
gog auth credentials set /private/path/client_secret.json
```

The OAuth client JSON is a secret. Keep it outside Git and do not transfer it
through chat.

## Authorize an account

Enable only the Google APIs required by the feature being deployed, then request
only its read-only services. For example:

```bash
export GOG_HOME="$HOME/.local/share/pi-telegram-bridge/google/isaac/gog"
export GOG_KEYRING_PASSWORD="$(cat ~/.local/share/pi-telegram-bridge/google/isaac/keyring-password)"
gog --readonly --gmail-no-send auth add account@example.com \
  --services calendar
gog auth doctor --check
```

Add `gmail` or `contacts` only when the corresponding reviewed feature is
enabled for that instance. Keep the authorized service set least-privileged.

Remote/headless authorization can use `gog auth add --remote`; keep the returned
authorization redirect out of chat and shell history because it temporarily
contains an authorization code.

## Configure one bridge instance

Add these non-secret pointers and the default account to that instance's private
mode-`0600` environment file:

```dotenv
PI_TELEGRAM_GOG_BINARY=/absolute/path/to/gog
PI_TELEGRAM_GOG_HOME=/absolute/per-instance/path/to/gog-home
PI_TELEGRAM_GOG_KEYRING_PASSWORD_FILE=/absolute/path/to/keyring-password
PI_TELEGRAM_GOOGLE_ACCOUNT=account@example.com
```

The environment file is validated during fleet preflight. The password file
must be a regular file owned by the service user, mode `0600`, non-empty, and no
larger than 4 KiB. Restart the instance through the normal deployment/operator
workflow after changing environment configuration.

`PI_TELEGRAM_GOOGLE_ACCOUNT` is optional. Without it, every tool call must name
an account explicitly.

### Configure account aliases

When one instance can read multiple accounts, configure explicit aliases in its
isolated `GOG_HOME`. The bridge passes the selected alias directly to `gog`; the
underlying address does not need to appear in conversation:

```bash
export GOG_HOME="$HOME/.local/share/pi-telegram-bridge/google/isaac/gog"
export GOG_KEYRING_PASSWORD="$(cat ~/.local/share/pi-telegram-bridge/google/isaac/keyring-password)"
gog auth alias set personal personal-account@example.com
gog auth alias set work work-account@example.com
gog auth alias list
```

`PI_TELEGRAM_GOOGLE_ACCOUNT` may be an alias. Each aliased account must be
authorized independently with the required read-only service scopes. Alias
configuration is private external state, not tracked repository configuration.

## Verify

Ask the assistant to check Google account status. The typed result reports only
the selected account, whether it has a stored authorization, and its configured
service names. It omits OAuth subjects, scopes, client names, token paths, and
raw diagnostics.

For Calendar, ask it to list calendars, show events for a bounded date range,
search a bounded range, or check availability across configured aliases. The
tool always supplies `--readonly`, `--no-input`, and Gmail-send blocking. It
normalizes and bounds returned fields, omits cancelled events, preserves
all-day/date and time-zone distinctions, and marks remote text as untrusted.

## Rotate or remove access

To rotate the keyring password, use `gog`'s supported keyring migration while
the old password is available, replace the private password file atomically,
and restart the instance. Never overwrite the password independently of the
encrypted keyring.

To remove an account:

```bash
export GOG_HOME="$HOME/.local/share/pi-telegram-bridge/google/isaac/gog"
export GOG_KEYRING_PASSWORD="$(cat ~/.local/share/pi-telegram-bridge/google/isaac/keyring-password)"
gog auth remove account@example.com
gog auth list
```

Then remove the instance's Google environment entries if no account remains.
Revoke the OAuth application's access in the Google account as a separate step
when complete revocation is required. Remove OAuth client credentials with
`gog auth credentials remove` only after every account using that client has
been migrated or removed.

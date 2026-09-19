# SSH hardening

Installed on the production server as `/etc/ssh/sshd_config.d/00-nova-hardening.conf`.

## What it changes

| Setting | Before | After |
|---|---|---|
| `PermitRootLogin` | `yes` | `prohibit-password` (key-only) |
| `PasswordAuthentication` | `yes` | `no` |
| `KbdInteractiveAuthentication` | — | `no` |
| `MaxAuthTries` | default (6) | `3` |

Also enabled `fail2ban` (`jail.d/nova-sshd.local`: 4 retries / 10 min → 1 h ban).

## Why the file is named `00-`

sshd takes the **first** value it sees, and includes `sshd_config.d/*.conf` in
lexical order. The base image ships `50-cloud-init.conf` with
`PasswordAuthentication yes`. A `99-*.conf` drop-in loses to it — which is what
happened on the first attempt here, and why `sshd -T` still reported
`passwordauthentication yes` after a reload. `00-` wins.

## Applying it

```sh
install -m 644 infrastructure/ssh/00-nova-hardening.conf /etc/ssh/sshd_config.d/
sshd -t                                  # validate BEFORE reloading
systemctl reload ssh                      # reload, not restart
sshd -T | grep -E 'passwordauth|permitrootlogin'
```

## Verifying it actually took effect

Prove both directions, or you have only changed a file:

```sh
# must succeed
ssh -o BatchMode=yes root@<host> 'echo KEY_OK'

# must be REFUSED
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@<host> true
```

## Before you lock yourself out

Key authentication must be confirmed working while password auth is still on.
The server has authorised keys; verify one of them works before disabling
passwords. Reload rather than restart so the session you are fixing it from
survives a mistake.

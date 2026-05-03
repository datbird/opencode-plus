# Configuration

OpenCode Plus is configured through Docker environment variables, persistent files under `/config`, and mounted workspace data under `/data`.

## Runtime Mounts

- `/config`: persistent container state, logs, copied root home files, and gateway config.
- `/data`: workspace data. The entrypoint creates `/root/aiplayground -> /data/aiplayground` and `/root/gitrepos -> /data/gitrepos`.
- `/var/run/docker.sock`: optional host Docker socket for Docker-aware agents and devcontainer workflows.

## Core Environment Variables

- `ROOT_PASSWORD`: root SSH password inside the container.
- `OPENCODE_SERVER_USERNAME`: OpenCode server Basic Auth username.
- `OPENCODE_SERVER_PASSWORD`: OpenCode server Basic Auth password.
- `OPENCODE_SERVER_HOSTNAME`: OpenCode bind host. Defaults to `0.0.0.0`.
- `OPENCODE_SERVER_PORT`: OpenCode upstream port. Defaults to `4096`.
- `OPENCODE_LOG_LEVEL`: OpenCode log level. Defaults to `INFO`.
- `TZ`: container timezone.

## Persistent Root State

At startup, the entrypoint copies `/config/persist/root/` into `/root/` with `rsync`. Use this for durable CLI/auth/editor state such as:

- `/config/persist/root/.config/opencode`
- `/config/persist/root/.local/share/opencode`
- `/config/persist/root/.cache/opencode`
- `/config/persist/root/.ssh`
- `/config/persist/root/.config/gh`

The current OpenCode session/auth state should live in `/config/persist/root/.local/share/opencode` so container rebuilds do not lose sessions.

## Cloudflare Access Gateway

The bundled gateway binary is `/usr/local/bin/opencode-cf-auth-proxy`. Supervisor starts it from `supervisor/opencode-cf-auth-proxy.conf`, which sources:

```text
/config/persist/opencode-cf-auth-proxy.env
```

Create that file from `opencode-cf-auth-proxy.env.example`.

Gateway environment variables:

- `LISTEN_ADDR`: gateway listen address, for example `0.0.0.0:4097`.
- `UPSTREAM_URL`: OpenCode upstream URL, usually `http://127.0.0.1:4096`.
- `CF_ACCESS_AUD`: Cloudflare Access audience tag.
- `CF_ACCESS_SKIP_AUD`: set to `true` only if intentionally skipping audience verification.
- `TRUSTED_CF_ISSUER_SUFFIX`: expected Cloudflare Access issuer suffix.
- `ALLOWED_EMAILS`: comma-separated allowlist of authenticated emails.
- `OPENCODE_BASIC_USER`: OpenCode Basic Auth username for upstream proxying.
- `OPENCODE_BASIC_PASSWORD`: OpenCode Basic Auth password for upstream proxying.
- `OPENCODE_BASIC_AUTH_B64`: alternative to username/password, base64 of `username:password`.
- `OPENCODE_ROOT_REDIRECT_PATH`: optional root redirect path.

Health endpoint:

```text
GET /__health
```

A healthy gateway normally reports `upstream_status:401` when OpenCode Basic Auth is enabled upstream.

## Optional Sync Services

Syncthing and Dropbox are installed in the `dev` and `full` variants, but their supervisor configs are disabled by default:

- `supervisor/syncthing.conf.disabled`
- `supervisor/dropbox.conf.disabled`

Enable them intentionally in your own derived image or runtime configuration.

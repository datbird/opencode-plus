# Configuration

OpenCode Plus is configured through Docker environment variables, persistent files under `/config`, and mounted workspace data.

## Runtime Mounts

- `/config`: persistent container state, logs, copied root home files, and gateway config.
- `/root/workspace`: default workspace directory where `opencode serve` starts.
- `/root/repos`: default directory for local Git clones.
- `/data`: optional compatibility mount root for Unraid or custom layouts; it is not created as a Docker volume by default.
- `/var/run/docker.sock`: optional host Docker socket for Docker-aware agents and devcontainer workflows.

## Core Environment Variables

- `ROOT_PASSWORD`: root SSH password inside the container.
- `OPENCODE_SERVER_USERNAME`: OpenCode server Basic Auth username.
- `OPENCODE_SERVER_PASSWORD`: OpenCode server Basic Auth password.
- `OPENCODE_SERVER_HOSTNAME`: OpenCode bind host. Defaults to `0.0.0.0`.
- `OPENCODE_SERVER_PORT`: OpenCode upstream port. Defaults to `4096`.
- `OPENCODE_LOG_LEVEL`: OpenCode log level. Defaults to `INFO`.
- `TZ`: container timezone.

## Workspace Environment Variables

- `OPENCODE_WORKSPACE_DIR`: directory where `opencode serve` starts. Defaults to `/root/workspace`.
- `OPENCODE_REPOS_DIR`: directory for local Git clones. Defaults to `/root/repos`.

At startup, the entrypoint creates both configured directories and, when no real `/root` mount exists, symlinks:

```text
/root/aiplayground -> $OPENCODE_WORKSPACE_DIR
/root/gitrepos -> $OPENCODE_REPOS_DIR
```

For migrated or compatibility-heavy setups, map the same host workspace to a real directory under `/root` and any legacy path you still need. Keep `OPENCODE_WORKSPACE_DIR` pointed at the `/root/...` path used by the browser route, and treat other mounts as compatibility mirrors only.

The public defaults avoid duplicate mounts by making `/root/workspace` and `/root/repos` real directories. The OpenCode web project picker starts directory searches from `path.home` (`/root`), and its finder can skip symlinked workspace roots.

## Persistent Root State

At startup, the entrypoint copies `/config/persist/root/` into `/root/` with `rsync`. Use this for durable CLI/auth/editor state such as:

- `/config/persist/root/.config/opencode`
- `/config/persist/root/.local/share/opencode`
- `/config/persist/root/.cache/opencode`
- `/config/persist/root/.ssh`
- `/config/persist/root/.config/gh`

The current OpenCode session/auth state should live in `/config/persist/root/.local/share/opencode` so container rebuilds do not lose sessions. If this state is mounted directly into `/root/.local/share/opencode`, the entrypoint skips copying that path from `/config/persist/root` to avoid self-rsync loops and stale state revival.

## Cloudflare Access Gateway

The bundled gateway binary is `/usr/local/bin/opencode-cf-auth-proxy`. The gateway is disabled by default. Set `OPENCODE_CF_AUTH_ENABLED=true` to generate `/config/persist/opencode-cf-auth-proxy.env` from Docker environment variables and start the supervisor program.

Generated gateway config is written to:

```text
/config/persist/opencode-cf-auth-proxy.env
```

You can also create that file from `opencode-cf-auth-proxy.env.example` for reference, but environment variables are the preferred Docker/Unraid path.

Gateway environment variables:

- `OPENCODE_CF_AUTH_ENABLED`: enables the gateway when set to `true`. Defaults to `false`.
- `OPENCODE_CF_AUTH_LISTEN_ADDR`: gateway listen address. Defaults to `0.0.0.0:4097`.
- `OPENCODE_CF_AUTH_UPSTREAM_URL`: OpenCode upstream URL. Defaults to `http://127.0.0.1:$OPENCODE_SERVER_PORT`.
- `CF_ACCESS_AUD`: Cloudflare Access audience tag.
- `CF_ACCESS_SKIP_AUD`: set to `true` only if intentionally skipping audience verification.
- `TRUSTED_CF_ISSUER_SUFFIX`: expected Cloudflare Access issuer suffix.
- `ALLOWED_EMAILS`: comma-separated allowlist of authenticated emails.
- `OPENCODE_BASIC_USER`: OpenCode Basic Auth username for upstream proxying. Defaults to `OPENCODE_SERVER_USERNAME` when omitted.
- `OPENCODE_BASIC_PASSWORD`: OpenCode Basic Auth password for upstream proxying. Defaults to `OPENCODE_SERVER_PASSWORD` when omitted.
- `OPENCODE_BASIC_AUTH_B64`: alternative to username/password, base64 of `username:password`.
- `OPENCODE_ROOT_REDIRECT_PATH`: optional root redirect path.

When `OPENCODE_CF_AUTH_ENABLED=true`, startup requires `ALLOWED_EMAILS` plus either `CF_ACCESS_AUD` or `CF_ACCESS_SKIP_AUD=true`, and either `OPENCODE_BASIC_AUTH_B64` or upstream basic-auth user/password values.

Health endpoint:

```text
GET /__health
```

A healthy gateway normally reports `upstream_status:401` when OpenCode Basic Auth is enabled upstream. When the gateway is disabled, the supervisor program exits cleanly instead of entering `BACKOFF`.

## Optional Sync Services

Syncthing and Dropbox are installed in the `dev` and `full` variants, but their supervisor configs are disabled by default:

- `supervisor/syncthing.conf.disabled`
- `supervisor/dropbox.conf.disabled`

Enable them intentionally in your own derived image or runtime configuration.

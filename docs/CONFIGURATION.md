# Configuration

OpenCode Plus is configured through Docker environment variables, persistent files under `/config`, and mounted workspace data.

## Runtime Mounts

- `/config`: persistent container state, logs, copied root home files, and gateway config.
- `/root/workspace`: default workspace directory where `opencode serve` starts.
- `/root/repos`: default directory for local Git clones.
- `/data`: optional compatibility mount root for Unraid or custom layouts; it is not created as a Docker volume by default.
- `/var/run/docker.sock`: optional host Docker socket for Docker-aware agents and devcontainer workflows.

## Core Environment Variables

- `ROOT_PASSWORD`: root SSH password inside the container when Plus mode is enabled.
- `OPENCODE_SERVER_USERNAME`: OpenCode server Basic Auth username.
- `OPENCODE_SERVER_PASSWORD`: OpenCode server Basic Auth password.
- `OPENCODE_SERVER_HOSTNAME`: OpenCode bind host. Defaults to `0.0.0.0`.
- `OPENCODE_SERVER_PORT`: OpenCode upstream port. Defaults to `4096`.
- `OPENCODE_LOG_LEVEL`: OpenCode log level. Defaults to `INFO`.
- `OPENCODE_PLUS_ENHANCEMENT_MODE`: enables OpenCode Plus runtime behavior. Defaults to `true`. Set to `false` for a plain OpenCode server.
- `OPENCODE_PLUS_UI_ENABLED`: injects OpenCode Plus browser UI assets through the gateway when set to `true`. Defaults to `false`.
- `OPENCODE_PLUS_UI_ASSET_DIR`: optional live asset directory for `drawer.js` and `drawer.css`, useful for testing UI changes without rebuilding the image.
- `OPENCODE_PLUS_MOUNTS_DIR`: persistent file mount configuration directory. Defaults to `/config/persist/opencode-plus-mounts`.
- `OPENCODE_PLUS_SOUL_DB_ENABLED`: enables database-backed Soul Sync readiness checks. Defaults to `true`.
- `OPENCODE_PLUS_SOUL_PB_URL`: PocketBase URL for Soul Sync metadata. Defaults to `http://pocketbase:8080`.
- `OPENCODE_PLUS_DEPLOYMENT_ID`: stable deployment identity for DB-backed sync records. Set this explicitly for each container, such as `opencode1` or `opencode2`.
- `OPENCODE_PLUS_DEPLOYMENT_NAME`: human-readable deployment name shown in the drawer. Set this explicitly with the same stable container identity unless a friendlier label is needed.
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

## Plain OpenCode Mode

Set `OPENCODE_PLUS_ENHANCEMENT_MODE=false` to run only the OpenCode server process. In this mode:

- `sshd` exits cleanly and does not listen on port `22`.
- The Cloudflare Access gateway is unavailable, even if its supervisor config exists.
- `/config/persist/root` is not copied into `/root`.
- Compatibility symlinks such as `/root/aiplayground` and `/root/gitrepos` are not created.
- The OpenCode project database is not modified to enforce `project.global.worktree`.

Use this mode when you want the image's packaged OpenCode binary and tooling but not the runtime session/persistence/gateway enhancements.

## Persistent Root State

At startup, the entrypoint copies `/config/persist/root/` into `/root/` with `rsync`. Use this for durable CLI/auth/editor state such as:

- `/config/persist/root/.config/opencode`
- `/config/persist/root/.local/share/opencode`
- `/config/persist/root/.cache/opencode`
- `/config/persist/root/.ssh`
- `/config/persist/root/.config/gh`

The current OpenCode session/auth state should live in `/config/persist/root/.local/share/opencode` so container rebuilds do not lose sessions. If this state is mounted directly into `/root/.local/share/opencode`, the entrypoint skips copying that path from `/config/persist/root` to avoid self-rsync loops and stale state revival.

## Cloudflare Access Gateway

The bundled gateway binary is `/usr/local/bin/opencode-cf-auth-proxy`. The gateway is disabled by default. Set `OPENCODE_CF_AUTH_ENABLED=true` to generate `/config/persist/opencode-cf-auth-proxy.env` from Docker environment variables and start the supervisor program. This requires `OPENCODE_PLUS_ENHANCEMENT_MODE=true`.

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
- `OPENCODE_PLUS_AUTH_STATE_FILE`: optional runtime auth state file. Defaults to `/config/persist/opencode-plus-auth-state.json`.
- `OPENCODE_PLUS_QUOTA_URL`: provider quota/status bridge URL used by `/__opencode-plus/quota`. Defaults to `http://127.0.0.1:18765/quota`.
- `OPENCODE_PLUS_SECRETS_DIR`: encrypted OpenCode Plus provider credential vault directory. Defaults to `/config/persist/opencode-plus-secrets`.
- `OPENCODE_PLUS_CONFIG_FILE`: non-secret OpenCode Plus runtime config file. Defaults to `/config/persist/opencode-plus-config.json`.

When `OPENCODE_CF_AUTH_ENABLED=true`, startup requires `ALLOWED_EMAILS` plus either `CF_ACCESS_AUD` or `CF_ACCESS_SKIP_AUD=true`, and either `OPENCODE_BASIC_AUTH_B64` or upstream basic-auth user/password values.

Health endpoint:

```text
GET /__health
```

A healthy gateway normally reports `upstream_status:401` when OpenCode Basic Auth is enabled upstream. When the gateway is disabled, the supervisor program exits cleanly instead of entering `BACKOFF`.

Runtime auth mode endpoint:

```text
GET /__opencode-plus/auth
POST /__opencode-plus/auth
```

The injected drawer uses this endpoint for the `Cloudflare Auth` dropdown. Disabling Cloudflare Auth skips Access validation and upstream Basic Auth injection, so users see the local OpenCode login. The UI warns users to know the local username/password before continuing. Local OpenCode auth is never changed automatically by this toggle.

Provider quota endpoint:

```text
GET /__opencode-plus/quota
```

The injected statusline sidecar fetches this same-origin endpoint. The gateway proxies it to `OPENCODE_PLUS_QUOTA_URL`, which should point at the local provider quota bridge.

Provider credential vault endpoints:

```text
GET /__opencode-plus/secrets/status
POST /__opencode-plus/secrets/key/generate
POST /__opencode-plus/secrets/key/regenerate
POST /__opencode-plus/secrets/provider/openrouter
POST /__opencode-plus/secrets/provider/gemini
```

The drawer uses these endpoints to create an app-managed AES-256-GCM vault key and save provider credentials. The gateway stores the key and encrypted provider vault under `OPENCODE_PLUS_SECRETS_DIR` with `0600` files and returns only configured/not-configured status, never secret values. Credential save buttons remain disabled until the encryption key exists. Regenerating the key requires `confirm_wipe: true` and deletes the encrypted provider vault because existing vault credentials can no longer be decrypted.

Runtime config endpoint:

```text
GET /__opencode-plus/config
POST /__opencode-plus/config
```

The drawer uses this endpoint for non-secret preferences such as Gemini quota auth source. Supported Gemini auth sources are `auto`, `gemini_cli`, and `opencode_provider`. `auto` checks the encrypted vault, then Gemini CLI OAuth credentials, then compatible OpenCode OAuth provider entries.

## OpenCode Plus UI Injection

When both `OPENCODE_CF_AUTH_ENABLED=true` and `OPENCODE_PLUS_UI_ENABLED=true`, the gateway injects same-origin UI assets into OpenCode HTML responses:

```text
/__opencode-plus/drawer.css
/__opencode-plus/drawer.js
/__opencode-plus/statusline.css
/__opencode-plus/statusline.js
```

The first injected feature is a top slide-down OpenCode Plus control drawer. It is intentionally separate from the composer/statusline enhancement CSS so the tuned statusline layout can remain stable while the drawer evolves.

For live UI iteration, place editable assets in a persistent directory and set:

```text
OPENCODE_PLUS_UI_ASSET_DIR=/config/persist/opencode-plus-ui
```

Then edit `/config/persist/opencode-plus-ui/drawer.js` and `/config/persist/opencode-plus-ui/drawer.css`, refresh the browser, and avoid rebuilding the Docker image until the UI is ready to bake in.

## Soul Sync

Soul Sync is optional and gated. When PocketBase is unavailable or the schema is missing, OpenCode continues normally and synced features remain disabled.

Set these environment variables when enabling the drawer's `Soul & Sync` status panel:

```text
OPENCODE_PLUS_SOUL_DB_ENABLED=true
OPENCODE_PLUS_SOUL_PB_URL=http://pocketbase:8080
OPENCODE_PLUS_DEPLOYMENT_ID=opencode1
OPENCODE_PLUS_DEPLOYMENT_NAME=opencode1
```

Use a distinct stable `OPENCODE_PLUS_DEPLOYMENT_ID` for each OpenCode Plus container. Do not rely on Docker's generated hostname if containers may be recreated.

The required PocketBase migration is tracked in:

```text
pb_migrations/202605080041_opencode_plus_soul_sync.js
```

The current schema creates metadata collections for deployments, Souls, Roles, small synced assets, Named Spaces, Synced Projects, deployment path mappings, and render history. It does not write `AGENTS.md`, skills, commands, tools, plugins, or project files by itself.

## File Mounts

File mount configuration is stored under `OPENCODE_PLUS_MOUNTS_DIR`. Mounts are constrained to a `mounts/<name>` child path below the current OpenCode workspace root.

SSH/SFTP mounting is the first supported provider path. SMB and Google Drive records can be staged in the UI while provider-specific mount commands are completed.

## Optional Sync Services

Syncthing and Dropbox are installed in the `dev` and `full` variants, but their supervisor configs are disabled by default:

- `supervisor/syncthing.conf.disabled`
- `supervisor/dropbox.conf.disabled`

Enable them intentionally in your own derived image or runtime configuration.

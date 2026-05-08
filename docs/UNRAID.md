# Unraid Deployment

OpenCode Plus is designed to run cleanly as an Unraid Docker container while preserving state in appdata.

## Recommended Variant

Use `datbird/opencode-plus:dev` for the default Unraid install. Use `:base` for a smaller server and `:full` only when image/PDF/chart/OCR tools are required.

Set `OPENCODE_PLUS_ENHANCEMENT_MODE=false` if you want the container to behave like a plain OpenCode server without the SSH daemon, Cloudflare gateway, startup state restore, or compatibility path helpers.

## Suggested Paths

- Appdata: `/mnt/user/appdata/opencode-plus:/config`
- Workspace: map the desired host workspace to `/root/workspace` for new installs.
- Repos: optionally map a separate host repo path to `/root/repos`.
- Docker socket: `/var/run/docker.sock:/var/run/docker.sock`

The entrypoint creates:

- `/root/workspace` from `OPENCODE_WORKSPACE_DIR` by default.
- `/root/repos` from `OPENCODE_REPOS_DIR` by default.
- `/root/aiplayground -> $OPENCODE_WORKSPACE_DIR` when `/root/aiplayground` is not already a real mounted directory.
- `/root/gitrepos -> $OPENCODE_REPOS_DIR` when `/root/gitrepos` is not already a real mounted directory.

## Ports

- `4096`: direct OpenCode server. Use only if you are not using the gateway.
- `4097`: Cloudflare Access gateway when `LISTEN_ADDR=0.0.0.0:4097`.
- `22`: SSH.

## Example Docker Run

```bash
docker run -d \
  --name opencode-plus \
  --restart unless-stopped \
  -p 4096:4096 \
  -p 2222:22 \
  -v /mnt/user/appdata/opencode-plus:/config:rw \
  -v /mnt/user/appdata/opencode-workspace:/root/workspace:rw \
  -v /mnt/user/gitrepos:/root/repos:rw \
  -v /var/run/docker.sock:/var/run/docker.sock:rw \
  -e TZ=America/Chicago \
  -e ROOT_PASSWORD='change-me' \
  -e OPENCODE_SERVER_USERNAME='opencode' \
  -e OPENCODE_SERVER_PASSWORD='change-me' \
  -e OPENCODE_SERVER_HOSTNAME=0.0.0.0 \
  -e OPENCODE_SERVER_PORT=4096 \
  datbird/opencode-plus:dev
```

For migrated containers, use a single canonical workspace in `OPENCODE_WORKSPACE_DIR`. Prefer a real path under `/root`, such as `/root/workspace`, and only keep matching `/data/...` mounts when compatibility with older session rows or tooling is needed.

## Unraid Labels

When creating an Unraid template, include Docker Manager labels so Unraid recognizes the container as managed:

- `net.unraid.docker.managed=dockerman`
- `net.unraid.docker.webui=http://<container-ip-or-host>:4097/`
- `net.unraid.docker.icon=<icon-url>`

## Persistent OpenCode State

Place copied OpenCode state under:

```text
/mnt/user/appdata/opencode-plus/persist/root/.config/opencode
/mnt/user/appdata/opencode-plus/persist/root/.local/share/opencode
/mnt/user/appdata/opencode-plus/persist/root/.cache/opencode
/mnt/user/appdata/opencode-plus/persist/root/.mymcp
/mnt/user/appdata/opencode-plus/persist/root/.config/op
```

This keeps auth, sessions, model metadata, memories, tool output, mymcp credential registry, and 1Password CLI account/session renewal state durable across image rebuilds.

For live containers that directly bind-mount only the three OpenCode state directories, `.mymcp` and `.config/op` still need to live under `/config/persist/root` so the startup restore copies them into `/root`. Do not leave those support paths only in the container overlay after a repair.

## Cloudflare Access

Cloudflare Access is disabled by default. To enable it, add the gateway port mapping, set `OPENCODE_CF_AUTH_ENABLED=true`, keep `OPENCODE_PLUS_ENHANCEMENT_MODE=true`, and provide the gateway environment variables documented in `docs/CONFIGURATION.md`.

The entrypoint writes generated gateway config to:

```text
/mnt/user/appdata/opencode-plus/persist/opencode-cf-auth-proxy.env
```

Use `opencode-cf-auth-proxy.env.example` as a reference template. Route Cloudflare Tunnel or a reverse proxy to port `4097` when using the gateway.

## Live UI Testing

The OpenCode Plus UI drawer can be tested without rebuilding the Docker image after the updated gateway binary is installed.

Use a persistent asset directory such as:

```text
/mnt/user/appdata/opencode-plus/persist/opencode-plus-ui
```

Map or create it inside the container as:

```text
/config/persist/opencode-plus-ui
```

Set these environment variables on the container:

```text
OPENCODE_CF_AUTH_ENABLED=true
OPENCODE_PLUS_UI_ENABLED=true
OPENCODE_PLUS_UI_ASSET_DIR=/config/persist/opencode-plus-ui
```

Then edit `drawer.js` and `drawer.css` in that directory and refresh the browser. Rebuild the image only after the drawer behavior and styling are ready to bake into the embedded gateway assets.

## Soul Sync Backplane

When using multiple OpenCode Plus containers with PocketBase, connect each OpenCode Plus container and the PocketBase container to the same Docker network, for example `opencode-plus-backplane`.

Set stable deployment identity variables in each Unraid container template:

```text
OPENCODE_PLUS_SOUL_DB_ENABLED=true
OPENCODE_PLUS_SOUL_PB_URL=http://pocketbase:8080
OPENCODE_PLUS_DEPLOYMENT_ID=opencode1
OPENCODE_PLUS_DEPLOYMENT_NAME=opencode1
```

For a second container, use `opencode2` for both deployment fields. These values must be durable in the Unraid template because Docker-generated hostnames can change when a container is recreated.

Apply the PocketBase migration tracked in `pb_migrations/202605080041_opencode_plus_soul_sync.js` before enabling synced features. The drawer's `Soul & Sync` section should report `schema_ready:true` and will keep `Create Synced Project` disabled until at least one Named Space exists.

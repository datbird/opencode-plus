# Unraid Deployment

OpenCode Plus is designed to run cleanly as an Unraid Docker container while preserving state in appdata.

## Recommended Variant

Use `datbird/opencode-plus:dev` for the default Unraid install. Use `:base` for a smaller server and `:full` only when image/PDF/chart/OCR tools are required.

## Suggested Paths

- Appdata: `/mnt/user/appdata/opencode-plus:/config`
- Workspace: `/mnt/user:/data`
- Docker socket: `/var/run/docker.sock:/var/run/docker.sock`

The entrypoint creates:

- `/root/aiplayground -> /data/aiplayground`
- `/root/gitrepos -> /data/gitrepos`

## Ports

- `4096`: direct OpenCode server. Use only if you are not using the gateway.
- `4097`: Cloudflare Access gateway when `LISTEN_ADDR=0.0.0.0:4097`.
- `22`: SSH.

## Example Docker Run

```bash
docker run -d \
  --name opencode-plus \
  --restart unless-stopped \
  -p 4097:4097 \
  -p 2222:22 \
  -v /mnt/user/appdata/opencode-plus:/config:rw \
  -v /mnt/user:/data:rw \
  -v /var/run/docker.sock:/var/run/docker.sock:rw \
  -e TZ=America/Chicago \
  -e ROOT_PASSWORD='change-me' \
  -e OPENCODE_SERVER_USERNAME='datbird' \
  -e OPENCODE_SERVER_PASSWORD='change-me' \
  -e OPENCODE_SERVER_HOSTNAME=0.0.0.0 \
  -e OPENCODE_SERVER_PORT=4096 \
  datbird/opencode-plus:dev
```

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
```

This keeps auth, sessions, model metadata, memories, and tool output durable across image rebuilds.

## Cloudflare Access

Create:

```text
/mnt/user/appdata/opencode-plus/persist/opencode-cf-auth-proxy.env
```

Use `opencode-cf-auth-proxy.env.example` as the template. Route Cloudflare Tunnel or a reverse proxy to port `4097` when using the gateway.

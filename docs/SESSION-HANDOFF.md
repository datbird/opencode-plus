# Session and Memory Handoff

OpenCode Plus is intended to preserve AI working context across image rebuilds and container recreation.

## Durable Workspace Paths

- Public-image defaults should be generic, not Robert-specific. Preferred defaults are `OPENCODE_WORKSPACE_DIR=/root/workspace` and `OPENCODE_REPOS_DIR=/root/repos`.
- Robert's current migrated `opencode2` uses `/data/aiplayground` for session DB compatibility and also mounts the same host workspace at `/root/aiplayground` for web picker discovery.
- `/root/aiplayground` and `/root/gitrepos` may be real bind mounts. The entrypoint should only create symlinks there when those paths are not already real directories.
- OpenCode state is copied from `/config/persist/root` into `/root` during startup.

The web `Open project` dialog starts searches from `path.home` (`/root`). If the useful workspace is only reachable through a symlink under `/root`, directory discovery may look empty. For new installs, prefer a real workspace directory directly under `/root`, such as `/root/workspace`.

## Current Live Containers

- `opencode1`: primary OpenCode Plus container on Docker network `br0` with static IP `172.25.1.8`.
- `opencode2`: secondary/fallback OpenCode Plus container on Docker network `br0` with static IP `172.25.1.24`.
- Both containers serve through the bundled Cloudflare Access bridge on port `4097`.
- Cloudflare Tunnel `req` routes `opencode.crossmojonation.net` to `http://172.25.1.8:4097` and `opencode2.crossmojonation.net` to `http://172.25.1.24:4097` as of tunnel configuration version `14`.
- `opencode1` was formerly named `opencode-ubuntu`; use `opencode1` for live Docker commands going forward.
- Both live containers should have real bind mounts for `/root/aiplayground` and `/root/gitrepos`, not only symlinks, so the web Open project picker lists `~/aiplayground` contents.
- Both live bridge env files should include `OPENCODE_ROOT_REDIRECT_PATH=/L2RhdGEvYWlwbGF5Z3JvdW5k/session`; otherwise authenticated visits to `/` can open the global `/` project and the picker will show `//`.
- As of 2026-05-03, `opencode1` and `opencode2` both run image ID `sha256:700cdd2e2919e0d8832610e3f967980b62b6ff067d3da32fc3fa3751abe1531a`.
- `opencode1` directly bind-mounts `/mnt/user/appdata/opencode-ubuntu/persist/root/.local/share/opencode`, `.config/opencode`, and `.cache/opencode` into `/root/...`. This was added because the older one-way startup copy from `/config/persist/root` could revive archived sessions after restart.
- Zombie sessions `Session persistence after Docker migration` and `Kansas City weather today` were archived in the persistent `opencode1` DB on 2026-05-03 and verified to stay archived after restart.

Verification commands:

```bash
docker ps --filter name=opencode --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Networks}}'
docker inspect opencode1 --format '{{.NetworkSettings.Networks.br0.IPAddress}} {{index .Config.Labels "net.unraid.docker.webui"}}'
docker exec opencode1 bash -lc 'ls -ld /root/aiplayground /root/gitrepos /data/aiplayground /data/gitrepos; grep ^OPENCODE_ROOT_REDIRECT_PATH= /config/persist/opencode-cf-auth-proxy.env'
docker exec opencode1 bash -lc 'sqlite3 -header -column /root/.local/share/opencode/opencode.db "select title,time_archived from session where title in (\"Session persistence after Docker migration\",\"Kansas City weather today\") order by title;"'
curl -fsS http://172.25.1.8:4097/__health
curl -sS -o /dev/null -w '%{http_code}\n' https://opencode.crossmojonation.net
```

## Important Durable State

Persist these paths under `/config/persist/root`:

- `.config/opencode`: config, memories, and project instructions.
- `.local/share/opencode`: auth, sessions, database, logs, and tool outputs.
- `.cache/opencode`: cache/model metadata.
- `.config/gh`: GitHub CLI auth if desired.
- `.ssh`: SSH keys and known hosts if desired.

## Session Notes

Project/session handoff notes should live in the workspace, not only inside a container layer:

```text
$OPENCODE_WORKSPACE_DIR/sessionnotes/
```

For long-running work, update session notes with:

- what changed,
- files touched,
- commands/builds run,
- image IDs/tags,
- live container status,
- unresolved next steps.

## Current OpenCode Plus Repository

Public repo:

```text
https://github.com/datbird/opencode-plus
```

Local repo path in this environment:

```text
/root/gitrepos/opencode-ubuntu-container
```

The local directory name is historical; the public project name is OpenCode Plus.

## GitHub Auth

- Pushes to `datbird/opencode-plus` should use the 1Password item `GitHub PAT Token (Unraid)` in the `Private` vault through a one-shot Git credential helper.
- Do not store the token in Git remotes or global Git config, and do not print it in logs or chat.
- As of 2026-05-03, Robert regenerated the Unraid PAT and updated the 1Password item. Validation passed as GitHub user `datbird` with `push=true` and `admin=true` for `datbird/opencode-plus`.
- Commit `8470674 Update workspace defaults and handoff docs` was pushed to `origin/main` with that refreshed token.
- `GitHub PAT (Budgetron)` authenticated as `datbird` but returned permission denied for this repo during testing.
- `Github`/`GitHub` beamflash tokens authenticated as `beamflash` and did not have push access to this repo.

Current working tree note: the repo should be clean and synced after commit `8470674`. If future sessions see local changes, inspect them before editing and do not revert unrelated work unless Robert explicitly asks.

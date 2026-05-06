# Session and Memory Handoff

OpenCode Plus is intended to preserve AI working context across image rebuilds and container recreation. Keep deployment-specific hostnames, IP addresses, credentials, and personal appdata paths outside this public handoff document.

## Durable Workspace Paths

- Public-image defaults should be generic, not deployment-specific. Preferred defaults are `OPENCODE_WORKSPACE_DIR=/root/workspace` and `OPENCODE_REPOS_DIR=/root/repos`.
- Live containers should use one canonical Docker workspace variable, preferably a real path under `/root`, such as `OPENCODE_WORKSPACE_DIR=/root/workspace` and `OPENCODE_REPOS_DIR=/root/repos`.
- `/root/aiplayground` and `/root/gitrepos` may be real bind mounts in migrated installs. The entrypoint should only create symlinks there when those paths are not already real directories.
- OpenCode state is copied from `/config/persist/root` into `/root` during startup unless those state paths are direct mounts.
- `OPENCODE_PLUS_ENHANCEMENT_MODE=false` disables runtime Plus behavior and leaves only the plain OpenCode server process running.

The web `Open project` dialog starts searches from `path.home` (`/root`). If the useful workspace is only reachable through a symlink under `/root`, directory discovery may look empty. For new installs, prefer a real workspace directory directly under `/root`, such as `/root/workspace`.

## Runtime Consistency

- The Cloudflare Access gateway should redirect authenticated browser root visits to the encoded canonical workspace route when a stable Web UI workspace is desired.
- Directly bind-mounting OpenCode state paths such as `/root/.local/share/opencode`, `/root/.config/opencode`, and `/root/.cache/opencode` avoids stale one-way startup copies across rebuilds.
- The entrypoint excludes directly mounted OpenCode state paths from startup rsync to avoid self-copy loops and stale state revival.
- `opencode-server-wrapper` repeatedly enforces `project.global.worktree=$OPENCODE_WORKSPACE_DIR` during startup because OpenCode can reset the global worktree to `/` after initial server initialization.
- Plain mode skips sshd, Cloudflare gateway, state restore, compatibility symlinks, and worktree enforcement.

Verification commands:

```bash
docker ps --filter name=opencode --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Networks}}'
docker exec opencode-plus bash -lc 'printf "cwd="; readlink /proc/$(pgrep -f "opencode serve" | head -n1)/cwd; sqlite3 -header -column /root/.local/share/opencode/opencode.db "select id,worktree from project;"'
curl -fsS http://<container-ip-or-host>:4097/__health
```

## Important Durable State

Persist these paths under `/config/persist/root`:

- `.config/opencode`: config, memories, and project instructions.
- `.local/share/opencode`: auth, sessions, database, logs, and tool outputs.
- `.cache/opencode`: cache/model metadata.
- `.mymcp`: mymcp credential registry, encrypted 1Password renewal state, and active op session cache.
- `.config/op`: 1Password CLI account configuration required before `OP_SESSION_*` values can be used.
- `.config/gh`: GitHub CLI auth if desired.
- `.ssh`: SSH keys and known hosts if desired.

The support credential paths above are not direct bind mounts in the current live containers. They must exist under `/config/persist/root` so the entrypoint's startup restore recreates them after container restart/recreate. If a live repair copies `.mymcp` or `.config/op` from another container into `/root`, immediately sync it back into `/config/persist/root`; otherwise the fix only lives in the Docker overlay and will disappear on recreate.

Do not bake credentials, session databases, personal memories, provider auth, SSH keys, or workspace data into the image.

## Session Notes

Project/session handoff notes should live in the mounted workspace, not only inside a container layer:

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

## Repository

Public repo:

```text
https://github.com/datbird/opencode-plus
```

The local source directory name may be historical; the public project name is OpenCode Plus.

The gateway/proxy source is part of this repository under `bridge/opencode-cf-auth-proxy/`. The compiled proxy binary should be produced by Docker or local `go build` from that source; do not treat an external loose checkout or copied binary as canonical.

The quota bridge source is part of this repository under `bridge/opencode-plus-quota/`. If live testing edits `/root/aiplayground/opencode-enhancement-suite-bridge/`, copy accepted changes back into `bridge/opencode-plus-quota/` before building or committing.

## Publishing Auth

Use your own registry credentials or CI secrets when publishing. Do not store tokens in Git remotes, global Git config, Docker image layers, or public docs.

For Robert's live `datbird/opencode-plus` repo pushes from the Unraid/OpenCode environment, use the private workspace/project docs as the source of truth. Current live procedure: renew 1Password through `mymcp`, retrieve the `GitHub PAT Token (Unraid)` item from the `Private` vault, and pass it through a one-shot Git credential helper for `git push`. If `mymcp` cannot renew because local encrypted state is missing, restore `/root/.mymcp` and `/root/.config/op/config` from the live OpenCode Plus persistent state before asking Robert for manual auth. Never commit credentials or bypass GitHub push protection.

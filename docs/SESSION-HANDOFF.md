# Session and Memory Handoff

OpenCode Plus is intended to preserve AI working context across image rebuilds and container recreation.

## Durable Workspace Paths

- `/root/aiplayground` is a symlink to `/data/aiplayground`.
- `/root/gitrepos` is a symlink to `/data/gitrepos`.
- OpenCode state is copied from `/config/persist/root` into `/root` during startup.

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
/data/aiplayground/sessionnotes/
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

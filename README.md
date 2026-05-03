# OpenCode Plus

Unofficial enhanced OpenCode server images for Docker and Unraid.

OpenCode Plus packages OpenCode Server with a durable Ubuntu-based remote development environment, an optional Cloudflare Access aware gateway, SSH access, persistent workspace mounts, and three image sizes for different use cases.

OpenCode Plus is not affiliated with or endorsed by the upstream OpenCode project.

Documentation:

- [Configuration](docs/CONFIGURATION.md)
- [Unraid Deployment](docs/UNRAID.md)
- [Development and Publishing](docs/DEVELOPMENT.md)
- [Session and Memory Handoff](docs/SESSION-HANDOFF.md)

Image variants:

| Tag | Target | Intended Use |
| --- | --- | --- |
| `base` | `base` | Small runnable OpenCode server with SSH, Git, Docker CLI/Compose, GitHub CLI, basic shells/editors, and the Cloudflare Access auth bridge. |
| `dev` | `dev` | Default workstation image. Adds compilers, runtimes, editors, LSPs, debug adapters, cloud CLIs, sync tools, and AI/editor-friendly tooling. |
| `full` | `full` | Largest image. Adds image/PDF/chart/OCR/media tooling on top of `dev`. |
| `latest` | `dev` | Recommended default for general OpenCode server use. |

Runtime mounts:

- `/config`: persistent app/config state.
- `/root/workspace`: default workspace directory where `opencode serve` starts.
- `/root/repos`: default directory for local Git clones.
- `/data`: optional mount root for Unraid or custom layouts.
- `/var/run/docker.sock`: host Docker socket when launched on Unraid.

Workspace paths are configurable with `OPENCODE_WORKSPACE_DIR` and `OPENCODE_REPOS_DIR`. New installs should keep real workspace directories under `/root` so the OpenCode web project picker can discover them from `path.home`.

This image is designed as a clean baseline for a durable OpenCode server. Live installs inside a running container can be tested, then promoted back into this Dockerfile.

Quick start:

Build the image locally first, or use the published image once container registry publishing is enabled.

```bash
docker run -d \
  --name opencode-plus \
  --restart unless-stopped \
  -p 4096:4096 \
  -p 2222:22 \
  -v opencode-plus-config:/config \
  -v /path/to/workspace:/root/workspace \
  -v /path/to/repos:/root/repos \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e ROOT_PASSWORD='change-me' \
  -e OPENCODE_SERVER_USERNAME='datbird' \
  -e OPENCODE_SERVER_PASSWORD='change-me' \
  datbird/opencode-plus:dev
```

For the Cloudflare Access gateway, expose the gateway port configured in `/config/persist/opencode-cf-auth-proxy.env` instead of exposing OpenCode directly. The gateway health endpoint is `GET /__health`.

Build examples:

```bash
./build-variants.sh
./build-variants.sh base dev
IMAGE_NAME=ghcr.io/datbird/opencode-plus ./build-variants.sh
```

Cloud sync tooling:

- Google Drive: `rclone` with the `drive` backend. Google does not provide an official Linux Drive sync client.
- Dropbox: official Dropbox daemon at `dropboxd` plus the Dropbox CLI helper at `dropbox`.
- Syncthing: installed as `syncthing`; optional supervisor config is included disabled by default.

Remote editor and IDE support:

- SSH-first workflow for VS Code Remote SSH, Cursor/Windsurf-style SSH, JetBrains Gateway, terminal editors, and AI coding agents.
- Dev container tooling: Docker CLI/Compose and `devcontainer` CLI.
- Language servers and formatters: TypeScript, JSON/CSS/HTML, YAML, Bash, Dockerfile, Tailwind, Pyright, Python LSP, Prettier, ESLint, Ruff, Black, MyPy, ShellCheck, `shfmt`, `clang-format`, and EditorConfig tooling.
- Debug tooling: `gdb`, `lldb`, Delve (`dlv`), `debugpy`, and `debugpy-adapter`.
- Editor-friendly Git/dev tools: `gh`, `git-lfs`, `lazygit`, `ripgrep`, `fd`, `fzf`, `jq`, and common compilers/runtimes.

Full image media/PDF/chart tooling:

- Images and video: ImageMagick, GraphicsMagick, libvips, FFmpeg, WebP, AVIF, PNG/JPEG optimizers, EXIF tooling, Inkscape, and SVG conversion.
- PDF/document generation: Poppler, qpdf, Ghostscript, wkhtmltopdf, Pandoc, and basic LaTeX support.
- Charts and diagrams: Graphviz, Gnuplot, PlantUML, Mermaid CLI, and Python plotting libraries.
- OCR: Tesseract.

Publishing notes:

- Build targets map directly to tags: `base`, `dev`, and `full`.
- Tag `latest` to `dev` unless you intentionally want the largest image to be the default.
- The Unraid template should usually reference `:dev` or `:latest`; `:full` is for users who explicitly want media/PDF/chart tooling baked in.

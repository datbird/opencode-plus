# OpenCode Plus

Unofficial enhanced OpenCode server images for Docker and Unraid.

Image variants:

| Tag | Target | Intended Use |
| --- | --- | --- |
| `base` | `base` | Small runnable OpenCode server with SSH, Git, Docker CLI/Compose, GitHub CLI, basic shells/editors, and the Cloudflare Access auth bridge. |
| `dev` | `dev` | Default workstation image. Adds compilers, runtimes, editors, LSPs, debug adapters, cloud CLIs, sync tools, and AI/editor-friendly tooling. |
| `full` | `full` | Largest image. Adds image/PDF/chart/OCR/media tooling on top of `dev`. |
| `latest` | `dev` | Recommended default for general OpenCode server use. |

Runtime mounts:

- `/config`: persistent app/config state.
- `/data`: Unraid user share, with `/root/aiplayground -> /data/aiplayground` and `/root/gitrepos -> /data/gitrepos`.
- `/var/run/docker.sock`: host Docker socket when launched on Unraid.

This image is designed as a clean baseline for a durable OpenCode server. Live installs inside a running container can be tested, then promoted back into this Dockerfile.

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

OpenCode Plus is not affiliated with or endorsed by the upstream OpenCode project.

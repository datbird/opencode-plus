# Development and Publishing

## Build Variants

Use `build-variants.sh` to build all variants:

```bash
./build-variants.sh
```

Build selected variants:

```bash
./build-variants.sh base dev
```

Override the image name:

```bash
IMAGE_NAME=ghcr.io/datbird/opencode-plus ./build-variants.sh
```

The script tags:

- `<image>:base`
- `<image>:dev`
- `<image>:full`
- `<image>:latest` as `dev`

## Manual Build Commands

```bash
docker build --target base -t datbird/opencode-plus:base .
docker build --target dev -t datbird/opencode-plus:dev -t datbird/opencode-plus:latest .
docker build --target full -t datbird/opencode-plus:full .
```

## Gateway Source

The OpenCode Plus gateway source lives in:

```text
bridge/opencode-cf-auth-proxy/
```

This includes the Cloudflare Access bridge, `/__opencode-plus/*` endpoints, HTML UI injection, and embedded drawer assets. Docker builds compile this Go source in an `auth-proxy-builder` stage; do not edit or vendor a standalone proxy binary as the source of truth.

Run gateway checks locally with:

```bash
cd bridge/opencode-cf-auth-proxy
go test ./...
node --check ui/drawer.js
```

## Quota Bridge Source

The provider quota/status bridge lives in:

```text
bridge/opencode-plus-quota/
```

It serves `GET /health` and `GET /quota` on port `18765` by default. The gateway proxies `/__opencode-plus/quota` to this bridge through `OPENCODE_PLUS_QUOTA_URL`.

Run syntax checks with:

```bash
node --check bridge/opencode-plus-quota/server.mjs
```

OpenAI usage is collected natively from OpenCode OAuth state in `~/.local/share/opencode/auth.json` and `https://chatgpt.com/backend-api/wham/usage`. OpenRouter, Gemini, Anthropic Admin/API status, and other provider status modules are native collectors. Claude subscription-window quota is not reported.

For live UI iteration, set `OPENCODE_PLUS_UI_ASSET_DIR` to a writable persistent directory and edit `drawer.js` / `drawer.css` there. Once the UI is approved, copy those files back into `bridge/opencode-cf-auth-proxy/ui/` so the next image build embeds them.

The statusline layout is locked. Read `docs/STATUSLINE-LAYOUT-LOCK.md` before changing `bridge/opencode-cf-auth-proxy/ui/statusline.css`, chip DOM structure, row detection, transforms, margins, or wrap reserve constants.

## Current Size Expectations

Approximate local image sizes from the first multi-variant build:

- `base`: 1.05 GB
- `dev` / `latest`: 7.89 GB
- `full`: 9.71 GB

## Local Verification

Base:

```bash
docker run --rm --entrypoint bash datbird/opencode-plus:base -lc 'opencode --version; git --version; docker --version; gh --version | sed -n "1p"'
```

Dev:

```bash
docker run --rm --entrypoint bash datbird/opencode-plus:dev -lc 'opencode --version; gcc --version | sed -n "1p"; devcontainer --version; ruff --version; hx --version'
```

Full:

```bash
docker run --rm --entrypoint bash datbird/opencode-plus:full -lc 'identify --version | sed -n "1p"; ffmpeg -version | sed -n "1p"; qpdf --version | sed -n "1p"; tesseract --version | sed -n "1p"; mmdc --version'
```

## Publishing Images

Container images have not been published yet. Recommended GHCR flow:

```bash
IMAGE_NAME=ghcr.io/datbird/opencode-plus ./build-variants.sh
docker push ghcr.io/datbird/opencode-plus:base
docker push ghcr.io/datbird/opencode-plus:dev
docker push ghcr.io/datbird/opencode-plus:full
docker push ghcr.io/datbird/opencode-plus:latest
```

Before publishing, decide whether `latest` should remain `dev`.

## Enhancement Mode Direction

Runtime Plus behavior is feature-gated behind:

```text
OPENCODE_PLUS_ENHANCEMENT_MODE=false
```

The default remains `true` for existing OpenCode Plus deployments. Set it to `false` to smoke-test plain OpenCode mode.

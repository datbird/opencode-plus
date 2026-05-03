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

Before publishing, decide whether `latest` should remain `dev` and whether the gateway enhancement mode API is stable enough for public docs.

## Enhancement Mode Direction

The planned Go gateway/sidecar should keep Cloudflare Access behavior working as it does now, then add feature-gated enhancements behind an explicit enable/disable toggle. Recommended environment variable:

```text
OPENCODE_PLUS_ENHANCEMENT_MODE=false
```

Keep the default conservative until the enhancement mode is documented and tested.

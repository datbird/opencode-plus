# Unraid Community Applications Publishing

This repository includes a Community Applications-ready Docker template at:

```text
unraid/templates/opencode-plus.xml
```

## Before Submission

- Publish public container images for `ghcr.io/datbird/opencode-plus`.
- Keep `:dev` as the default Unraid template tag unless a smaller default is intentionally chosen.
- Verify the template XML points at public URLs for `TemplateURL`, `Icon`, `Project`, `Registry`, and `Support`.
- Create an Unraid forum support thread if Community Applications requires one, then replace the GitHub Issues `Support` URL with that thread.
- Keep deployment-specific hostnames, emails, tokens, appdata paths, Cloudflare tunnel URLs, and private publishing runbooks out of the XML.

## Community Applications Template Repo

Community Applications can index public GitHub-hosted templates. If a separate templates repository is preferred, copy these files into that repository without changing the public URLs until the target repo path is final:

```text
unraid/templates/opencode-plus.xml
unraid/opencode-plus.svg
```

Then update `TemplateURL` and `Icon` in the XML to the raw URLs in the final template repository.

## Current Defaults

- WebUI: gateway on `4097`.
- Direct OpenCode: advanced port `4096`.
- SSH: host `2222` to container `22`.
- Appdata: `/mnt/user/appdata/opencode-plus` to `/config`.
- Workspace: `/mnt/user/appdata/opencode-workspace` to `/root/workspace`.
- Repositories: `/mnt/user/gitrepos` to `/root/repos`.
- Docker socket: included as advanced and optional.
- OpenCode Plus enhancement mode: enabled.
- Gateway/UI: enabled by default.
- Cloudflare Access enforcement: disabled by default for first-run local usability; users can enable it in OpenCode Plus or set `OPENCODE_PLUS_CLOUDFLARE_AUTH_DEFAULT=true` before first start.

## Validation

Before submitting, validate locally:

```bash
python3 -m xml.etree.ElementTree unraid/templates/opencode-plus.xml
grep -R "crossmojonation\|/home/robert\|gmail.com\|172\.25\." unraid docs README.md
```

After publishing the template, install it through Unraid Apps rather than a manual `docker run` so Docker Manager labels and template metadata stay attached to the container.

# OpenCode Enhancement Suite Bridge

Tiny local HTTP bridge for OpenCode Enhancement Suite.

It reads OpenAI ChatGPT usage, OpenRouter credits, Gemini Code Assist quota, and configured provider API/Admin status directly. It exposes browser-safe JSON at:

- `http://127.0.0.1:18765/health`
- `http://127.0.0.1:18765/quota`

Start it with:

```bash
./start.sh
```

When used from the AI Playground support copy, the path is:

```bash
/root/aiplayground/opencode-enhancement-suite-bridge/start.sh
```

Gemini quota source is controlled by `OPENCODE_PLUS_CONFIG_FILE` and defaults to `auto`. Auto checks the encrypted OpenCode Plus provider vault under `OPENCODE_PLUS_SECRETS_DIR`, then `~/.gemini/oauth_creds.json`, then compatible OpenCode OAuth provider entries from `~/.local/share/opencode/auth.json`. Override the CLI file fallback with `GEMINI_OAUTH_CREDS_PATH=/path/to/oauth_creds.json` if needed.

OpenAI usage uses OpenCode's native OAuth entry from `~/.local/share/opencode/auth.json` by default and calls `https://chatgpt.com/backend-api/wham/usage` directly. Override the auth file with `OPENCODE_AUTH_PATH=/path/to/auth.json` if needed.

OpenRouter account credits use `OPENROUTER_MANAGEMENT_KEY` and the official `https://openrouter.ai/api/v1/credits` endpoint. `OPENROUTER_API_KEY` is accepted as a fallback env var name, but OpenRouter requires a management key for this endpoint. When env vars are absent, the bridge checks the encrypted OpenCode Plus provider vault, then tries 1Password item `OpenRouter.ai Management Key` in the `Private` vault.

Known current limitations:

- Claude subscription-window quota is not reported. Anthropic Admin/API auth status can be shown when configured.
- Shell `op` must be signed in for automatic OpenRouter key lookup unless `OPENROUTER_MANAGEMENT_KEY` is already set.

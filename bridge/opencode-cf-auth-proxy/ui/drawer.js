(() => {
  if (window.__opencodePlusDrawerLoaded) return;
  window.__opencodePlusDrawerLoaded = true;

  const STORAGE_KEY = "opencodePlusDrawerSettings";
  const STALE_THINKING_VISIBLE_MS = 4 * 60 * 1000;
  const STALE_THINKING_QUIET_MS = 90 * 1000;
  const STALE_THINKING_CHECK_MS = 15 * 1000;
  const STALE_THINKING_SNOOZE_MS = 10 * 60 * 1000;
  const DEFAULT_SETTINGS = {
    open: false,
    handleXPercent: 72,
    mobileHandleXPercent: null,
    modules: {
      openai: true,
      gemini: true,
      openrouter: true,
      claude: false,
      deepseek: false,
      siliconflow: false,
      moonshot: false,
      fireworks: false,
      xai: false,
      shell: true,
    },
  };

  const MODULES = [
    { id: "openai", label: "OpenAI usage", description: "ChatGPT usage windows from OpenCode auth." },
    { id: "gemini", label: "Gemini", description: "Code Assist subscription quota or OpenCode Gemini provider auth status." },
    { id: "openrouter", label: "OpenRouter credits", description: "OpenRouter account credit balance." },
    { id: "claude", label: "Claude usage", description: "Anthropic quota windows." },
    { id: "deepseek", label: "DeepSeek balance", description: "DeepSeek API balance from OpenCode provider auth." },
    { id: "siliconflow", label: "SiliconFlow balance", description: "SiliconFlow account balance from OpenCode provider auth." },
    { id: "moonshot", label: "Kimi/Moonshot balance", description: "Moonshot API balance from OpenCode provider auth." },
    { id: "fireworks", label: "Fireworks AI quota", description: "Fireworks spend quota from OpenCode provider auth." },
    { id: "xai", label: "xAI/Grok credits", description: "xAI prepaid credit balance from OpenCode Plus management key." },
    { id: "shell", label: "Command line status", description: "Shell, tool, and background job status." },
  ];

  const CONFIG_AREAS = [
    { id: "restart", label: "Restart OpenCode", description: "Restart the OpenCode server while OpenCode Plus stays online." },
    { id: "system", label: "OpenCode System", description: "Global OpenCode Plus settings, vault encryption, and runtime preferences." },
    { id: "gateway", label: "Gateway", description: "Cloudflare Access, local auth handoff, and gateway health." },
    { id: "statusline", label: "Statusline Modules", description: "Enable chips and configure provider-specific statusline settings." },
  ];

  function readSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return { ...DEFAULT_SETTINGS, ...stored };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function textOf(element) {
    return (element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isOwnUiNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    return Boolean(node.closest?.("#opencode-plus-drawer, #oc-webui-sidecar, .ocp-stale-thinking"));
  }

  function pageLooksLikeThinking() {
    const bodyText = textOf(document.body);
    return /\bThinking\b/i.test(bodyText) && /\b(Ask anything|Finalizing|Running|Calling|Reading|Editing|Searching|Checking)\b/i.test(bodyText);
  }

  function dismissStaleThinkingNotice(snooze = true) {
    document.querySelector(".ocp-stale-thinking")?.remove();
    if (snooze) window.__opencodePlusStaleThinkingSnoozedUntil = Date.now() + STALE_THINKING_SNOOZE_MS;
  }

  function showStaleThinkingNotice() {
    if (document.querySelector(".ocp-stale-thinking")) return;
    const notice = document.createElement("aside");
    notice.className = "ocp-stale-thinking";
    notice.setAttribute("role", "status");
    notice.innerHTML = `
      <div class="ocp-stale-thinking__copy">
        <strong>OpenCode may be stale</strong>
        <span>The page has shown Thinking for several minutes without visible updates. The response may already be saved.</span>
      </div>
      <div class="ocp-stale-thinking__actions">
        <button type="button" class="ocp-stale-thinking__button ocp-stale-thinking__button--primary">Refresh</button>
        <button type="button" class="ocp-stale-thinking__button">Dismiss</button>
      </div>
    `;
    notice.querySelector(".ocp-stale-thinking__button--primary")?.addEventListener("click", () => window.location.reload());
    notice.querySelector(".ocp-stale-thinking__button:not(.ocp-stale-thinking__button--primary)")?.addEventListener("click", () => dismissStaleThinkingNotice(true));
    document.documentElement.append(notice);
  }

  function installStaleThinkingWatchdog() {
    if (window.__opencodePlusStaleThinkingWatchdogInstalled) return;
    window.__opencodePlusStaleThinkingWatchdogInstalled = true;
    let thinkingSince = 0;
    let lastAppMutation = Date.now();

    const observer = new MutationObserver((mutations) => {
      if (mutations.every((mutation) => {
        const nodes = [mutation.target, ...mutation.addedNodes, ...mutation.removedNodes];
        return nodes.every((node) => node.nodeType !== Node.ELEMENT_NODE || isOwnUiNode(node));
      })) return;
      lastAppMutation = Date.now();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      const looksLikeThinking = pageLooksLikeThinking();
      if (!looksLikeThinking) {
        thinkingSince = 0;
        dismissStaleThinkingNotice(false);
        return;
      }
      if (!thinkingSince) thinkingSince = now;
      if (window.__opencodePlusStaleThinkingSnoozedUntil > now) return;
      if (now - thinkingSince >= STALE_THINKING_VISIBLE_MS && now - lastAppMutation >= STALE_THINKING_QUIET_MS) showStaleThinkingNotice();
    }, STALE_THINKING_CHECK_MS);
  }

  function writeSettings(settings) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent("opencode-plus:settings", { detail: settings }));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function applyHandlePosition(root, settings) {
    const isMobile = window.matchMedia?.("(max-width: 640px)").matches;
    const configuredPosition = isMobile ? settings.mobileHandleXPercent : settings.handleXPercent;
    const defaultPosition = isMobile ? 50 : DEFAULT_SETTINGS.handleXPercent;
    const rawPosition = Number.isFinite(Number(configuredPosition)) ? Number(configuredPosition) : defaultPosition;
    root.style.setProperty("--ocp-drawer-handle-x", `${clamp(rawPosition, 12, 88)}%`);
  }

  function createModuleRow(module, settings, onConfigure) {
    const row = document.createElement("div");
    row.className = "ocp-drawer__module-row";
    row.dataset.module = module.id;

    const label = document.createElement("label");
    label.className = "ocp-drawer__module-toggle";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(settings.modules[module.id]);
    input.addEventListener("change", () => {
      settings.modules[module.id] = input.checked;
      writeSettings(settings);
    });

    const copy = document.createElement("span");
    copy.className = "ocp-drawer__module-copy";
    copy.innerHTML = `<strong></strong><small></small>`;
    copy.querySelector("strong").textContent = module.label;
    copy.querySelector("small").textContent = module.description;

    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "ocp-drawer__gear";
    gear.setAttribute("aria-label", `Configure ${module.label}`);
    gear.title = `Configure ${module.label}`;
    gear.textContent = "⚙";
    gear.addEventListener("click", () => onConfigure(module));

    label.append(input, copy);
    row.append(label, gear);
    return row;
  }

  function createConfigAreaRow(area, onConfigure) {
    const row = document.createElement("div");
    row.className = "ocp-drawer__config-row";
    row.dataset.configArea = area.id;

    const copy = document.createElement("span");
    copy.className = "ocp-drawer__config-copy";
    copy.innerHTML = `<strong></strong><small></small>`;
    copy.querySelector("strong").textContent = area.label;
    copy.querySelector("small").textContent = area.description;

    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "ocp-drawer__gear";
    gear.setAttribute("aria-label", `Configure ${area.label}`);
    gear.title = `Configure ${area.label}`;
    gear.textContent = "⚙";
    gear.addEventListener("click", () => onConfigure(area));

    row.append(copy, gear);
    return row;
  }

  async function fetchGatewayHealth() {
    try {
      const response = await fetch("/__opencode-plus/health", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data.ui_enabled ? "UI gateway online" : "UI gateway disabled";
    } catch (error) {
      return `Gateway status unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function fetchAuthStatus() {
    const response = await fetch("/__opencode-plus/auth", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function updateCloudflareAuth(enabled) {
    const response = await fetch("/__opencode-plus/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cloudflare_auth_enabled: enabled }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function fetchSecretsStatus() {
    const response = await fetch("/__opencode-plus/secrets/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function generateSecretsKey() {
    const response = await fetch("/__opencode-plus/secrets/key/generate", { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function regenerateSecretsKey() {
    const response = await fetch("/__opencode-plus/secrets/key/regenerate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm_wipe: true }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function saveOpenRouterCredentials(managementKey) {
    const response = await fetch("/__opencode-plus/secrets/provider/openrouter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ managementKey }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function saveOpenAiCredentials(adminKey) {
    const response = await fetch("/__opencode-plus/secrets/provider/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function saveAnthropicCredentials(adminKey) {
    const response = await fetch("/__opencode-plus/secrets/provider/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function saveGeminiCredentials(oauthCredsText) {
    let oauthCreds;
    try {
      oauthCreds = JSON.parse(oauthCredsText);
    } catch {
      throw new Error("Gemini OAuth credentials must be valid JSON.");
    }
    const response = await fetch("/__opencode-plus/secrets/provider/gemini", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oauthCreds }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function saveXaiCredentials(managementKey, teamId) {
    const response = await fetch("/__opencode-plus/secrets/provider/xai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ managementKey, teamId }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function fetchPlusConfig() {
    const response = await fetch("/__opencode-plus/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function updatePlusConfig(config) {
    const response = await fetch("/__opencode-plus/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function restartOpenCode() {
    const response = await fetch("/__opencode-plus/opencode/restart", { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function waitForOpenCodeRestartStatus(overlay) {
    const detail = overlay.querySelector(".ocp-drawer__restart-detail");
    const started = Date.now();
    while (Date.now() - started < 45_000) {
      try {
        const response = await fetch("/__health", { cache: "no-store" });
        if (response.ok) {
          const status = await response.json();
          if (status?.ok) {
            if (detail) detail.textContent = "OpenCode is responding again. Refreshing...";
            window.setTimeout(() => window.location.reload(), 600);
            return;
          }
        }
      } catch {
        // The upstream can briefly disappear while opencode-server restarts.
      }
      if (detail) detail.textContent = "Restarting OpenCode server...";
      await new Promise((resolve) => window.setTimeout(resolve, 1_200));
    }
    if (detail) detail.textContent = "Restart queued, but OpenCode did not report ready yet. Refresh manually if needed.";
    overlay.querySelector(".ocp-drawer__restart-close")?.removeAttribute("disabled");
  }

  function showRestartOverlay(root) {
    let overlay = root.querySelector(".ocp-drawer__restart-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "ocp-drawer__restart-overlay";
      overlay.innerHTML = `
        <div class="ocp-drawer__restart-card" role="status" aria-live="polite">
          <span class="ocp-drawer__restart-spinner" aria-hidden="true"></span>
          <strong>Restarting OpenCode</strong>
          <p class="ocp-drawer__restart-detail">Queueing restart...</p>
          <button type="button" class="ocp-drawer__button ocp-drawer__restart-close" disabled>Close</button>
        </div>
      `;
      root.append(overlay);
      overlay.querySelector(".ocp-drawer__restart-close")?.addEventListener("click", () => overlay.remove());
    }
    overlay.hidden = false;
    return overlay;
  }

  function renderAuthStatus(root, status) {
    const select = root.querySelector(".ocp-drawer__auth-select");
    const detail = root.querySelector(".ocp-drawer__auth-detail");
    if (select) select.value = status.cloudflare_auth_enabled ? "enabled" : "disabled";
    if (detail) {
      detail.textContent = status.cloudflare_auth_enabled
        ? "Cloudflare Access is required and the bridge signs in to local OpenCode auth upstream."
        : "Cloudflare Auth is disabled. Visitors will see the local OpenCode login instead.";
    }
  }

  function renderSecretsStatus(container, status) {
    const keyStatus = container.querySelector(".ocp-drawer__secrets-key-status");
    const openRouterStatus = container.querySelector(".ocp-drawer__provider-status[data-provider='openrouter']");
    const openAiStatus = container.querySelector(".ocp-drawer__provider-status[data-provider='openai']");
    const anthropicStatus = container.querySelector(".ocp-drawer__provider-status[data-provider='anthropic']");
    const geminiStatus = container.querySelector(".ocp-drawer__provider-status[data-provider='gemini']");
    const xaiStatus = container.querySelector(".ocp-drawer__provider-status[data-provider='xai']");
    const generateButton = container.querySelector(".ocp-drawer__secrets-generate");
    const saveButtons = container.querySelectorAll(".ocp-drawer__provider-save");
    const keyExists = Boolean(status?.key_exists);
    const disabledTitle = "Generate an encryption key before saving credentials.";

    if (keyStatus) keyStatus.textContent = keyExists ? "Encrypted vault key is ready." : "No encryption key yet.";
    if (openAiStatus) openAiStatus.textContent = status?.providers?.openai?.configured ? "Saved" : "Not saved";
    if (anthropicStatus) anthropicStatus.textContent = status?.providers?.anthropic?.configured ? "Saved" : "Not saved";
    if (openRouterStatus) openRouterStatus.textContent = status?.providers?.openrouter?.configured ? "Saved" : "Not saved";
    if (geminiStatus) geminiStatus.textContent = status?.providers?.gemini?.configured ? "Saved" : "Not saved";
    if (xaiStatus) xaiStatus.textContent = status?.providers?.xai?.configured ? "Saved" : "Not saved";
    if (generateButton) {
      generateButton.disabled = keyExists;
      generateButton.textContent = keyExists ? "Key Generated" : "Generate Key";
    }
    saveButtons.forEach((button) => {
      button.disabled = !keyExists;
      button.title = keyExists ? "" : disabledTitle;
    });
  }

  async function setupCredentialControls(container) {
    const keyStatus = container.querySelector(".ocp-drawer__secrets-key-status");
    const generateButton = container.querySelector(".ocp-drawer__secrets-generate");
    const openRouterInput = container.querySelector(".ocp-drawer__openrouter-key");
    const openAiInput = container.querySelector(".ocp-drawer__openai-admin-key");
    const anthropicInput = container.querySelector(".ocp-drawer__anthropic-admin-key");
    const geminiInput = container.querySelector(".ocp-drawer__gemini-creds");
    const xaiKeyInput = container.querySelector(".ocp-drawer__xai-key");
    const xaiTeamInput = container.querySelector(".ocp-drawer__xai-team");
    const openRouterButton = container.querySelector(".ocp-drawer__provider-save[data-provider='openrouter']");
    const openAiButton = container.querySelector(".ocp-drawer__provider-save[data-provider='openai']");
    const anthropicButton = container.querySelector(".ocp-drawer__provider-save[data-provider='anthropic']");
    const geminiButton = container.querySelector(".ocp-drawer__provider-save[data-provider='gemini']");
    const xaiButton = container.querySelector(".ocp-drawer__provider-save[data-provider='xai']");

    async function refreshStatus() {
      try {
        renderSecretsStatus(container, await fetchSecretsStatus());
      } catch (error) {
        if (keyStatus) keyStatus.textContent = `Credential status unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    generateButton?.addEventListener("click", async () => {
      generateButton.disabled = true;
      if (keyStatus) keyStatus.textContent = "Generating encryption key...";
      try {
        await generateSecretsKey();
        await refreshStatus();
      } catch (error) {
        if (keyStatus) keyStatus.textContent = `Key generation failed: ${error instanceof Error ? error.message : String(error)}`;
        generateButton.disabled = false;
      }
    });

    openRouterButton?.addEventListener("click", async () => {
      const value = openRouterInput.value.trim();
      if (!value) {
        openRouterInput.focus();
        return;
      }
      openRouterButton.disabled = true;
      try {
        await saveOpenRouterCredentials(value);
        openRouterInput.value = "";
        await refreshStatus();
      } catch (error) {
        container.querySelector(".ocp-drawer__provider-status[data-provider='openrouter']").textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        openRouterButton.disabled = false;
      }
    });

    openAiButton?.addEventListener("click", async () => {
      const value = openAiInput.value.trim();
      if (!value) {
        openAiInput.focus();
        return;
      }
      openAiButton.disabled = true;
      try {
        await saveOpenAiCredentials(value);
        openAiInput.value = "";
        await refreshStatus();
      } catch (error) {
        container.querySelector(".ocp-drawer__provider-status[data-provider='openai']").textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        openAiButton.disabled = false;
      }
    });

    anthropicButton?.addEventListener("click", async () => {
      const value = anthropicInput.value.trim();
      if (!value) {
        anthropicInput.focus();
        return;
      }
      anthropicButton.disabled = true;
      try {
        await saveAnthropicCredentials(value);
        anthropicInput.value = "";
        await refreshStatus();
      } catch (error) {
        container.querySelector(".ocp-drawer__provider-status[data-provider='anthropic']").textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        anthropicButton.disabled = false;
      }
    });

    geminiButton?.addEventListener("click", async () => {
      const value = geminiInput.value.trim();
      if (!value) {
        geminiInput.focus();
        return;
      }
      geminiButton.disabled = true;
      try {
        await saveGeminiCredentials(value);
        geminiInput.value = "";
        await refreshStatus();
      } catch (error) {
        container.querySelector(".ocp-drawer__provider-status[data-provider='gemini']").textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        geminiButton.disabled = false;
      }
    });

    xaiButton?.addEventListener("click", async () => {
      const key = xaiKeyInput.value.trim();
      const teamId = xaiTeamInput.value.trim();
      if (!key) {
        xaiKeyInput.focus();
        return;
      }
      xaiButton.disabled = true;
      try {
        await saveXaiCredentials(key, teamId);
        xaiKeyInput.value = "";
        xaiTeamInput.value = "";
        await refreshStatus();
      } catch (error) {
        container.querySelector(".ocp-drawer__provider-status[data-provider='xai']").textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        xaiButton.disabled = false;
      }
    });

    await refreshStatus();
  }

  async function setupGeminiAuthSourceControls(container) {
    const select = container.querySelector(".ocp-drawer__gemini-auth-source");
    const detail = container.querySelector(".ocp-drawer__gemini-auth-source-detail");
    if (!select) return;

    try {
      const response = await fetchPlusConfig();
      select.value = response?.config?.gemini_auth_source || "auto";
      detail.textContent = "Auto prefers Code Assist subscription quota, then falls back to OpenCode Gemini API/Vertex provider auth status.";
      select.disabled = false;
    } catch (error) {
      detail.textContent = `Auth source unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }

    select.addEventListener("change", async () => {
      select.disabled = true;
      detail.textContent = "Saving Gemini auth source...";
      try {
        const response = await updatePlusConfig({ gemini_auth_source: select.value });
        select.value = response?.config?.gemini_auth_source || select.value;
        detail.textContent = "Saved. Quota refresh will use this source on the next bridge poll.";
      } catch (error) {
        detail.textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        select.disabled = false;
      }
    });
  }

  async function setupProviderAuthSourceControls(container, provider) {
    const select = container.querySelector(`.ocp-drawer__${provider}-auth-source`);
    const detail = container.querySelector(`.ocp-drawer__${provider}-auth-source-detail`);
    if (!select) return;
    const configKey = provider === "openai" ? "openai_auth_source" : "anthropic_auth_source";
    const defaultValue = "auto";

    try {
      const response = await fetchPlusConfig();
      select.value = response?.config?.[configKey] || defaultValue;
      if (detail) detail.textContent = provider === "openai"
        ? "Auto prefers ChatGPT subscription quota, then OpenAI Admin usage/costs, then OpenCode API auth status."
        : "Auto prefers Claude subscription quota, then Anthropic Admin costs, then OpenCode API auth status.";
      select.disabled = false;
    } catch (error) {
      if (detail) detail.textContent = `Auth source unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }

    select.addEventListener("change", async () => {
      select.disabled = true;
      if (detail) detail.textContent = "Saving auth source...";
      try {
        const response = await updatePlusConfig({ [configKey]: select.value });
        select.value = response?.config?.[configKey] || select.value;
        if (detail) detail.textContent = "Saved. Quota refresh will use this source on the next bridge poll.";
      } catch (error) {
        if (detail) detail.textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        select.disabled = false;
      }
    });
  }

  function renderSystemSecretsStatus(container, status) {
    const keyStatus = container.querySelector(".ocp-drawer__system-key-status");
    const generateButton = container.querySelector(".ocp-drawer__system-key-generate");
    const regenerateButton = container.querySelector(".ocp-drawer__system-key-regenerate");
    const providerSummary = container.querySelector(".ocp-drawer__system-vault-summary");
    const keyExists = Boolean(status?.key_exists);
    const openRouterConfigured = Boolean(status?.providers?.openrouter?.configured);
    const openAiConfigured = Boolean(status?.providers?.openai?.configured);
    const anthropicConfigured = Boolean(status?.providers?.anthropic?.configured);
    const geminiConfigured = Boolean(status?.providers?.gemini?.configured);

    if (keyStatus) keyStatus.textContent = keyExists ? "Encryption key exists." : "No encryption key has been generated yet.";
    if (generateButton) generateButton.disabled = keyExists;
    if (regenerateButton) regenerateButton.disabled = !keyExists;
    if (providerSummary) {
      providerSummary.textContent = `Encrypted vault credentials: OpenAI Admin ${openAiConfigured ? "saved" : "not saved"}, Anthropic Admin ${anthropicConfigured ? "saved" : "not saved"}, OpenRouter ${openRouterConfigured ? "saved" : "not saved"}, Gemini ${geminiConfigured ? "saved" : "not saved"}.`;
    }
  }

  async function setupSystemControls(container) {
    const keyStatus = container.querySelector(".ocp-drawer__system-key-status");
    const generateButton = container.querySelector(".ocp-drawer__system-key-generate");
    const regenerateButton = container.querySelector(".ocp-drawer__system-key-regenerate");
    const restartButton = container.querySelector(".ocp-drawer__opencode-restart");

    async function refreshStatus() {
      try {
        renderSystemSecretsStatus(container, await fetchSecretsStatus());
      } catch (error) {
        if (keyStatus) keyStatus.textContent = `Encryption status unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    generateButton?.addEventListener("click", async () => {
      generateButton.disabled = true;
      if (keyStatus) keyStatus.textContent = "Generating encryption key...";
      try {
        await generateSecretsKey();
        await refreshStatus();
      } catch (error) {
        if (keyStatus) keyStatus.textContent = `Key generation failed: ${error instanceof Error ? error.message : String(error)}`;
        generateButton.disabled = false;
      }
    });

    regenerateButton?.addEventListener("click", async () => {
      const confirmed = window.confirm(
        "Regenerating the encryption key will permanently delete any credentials currently saved in the encrypted OpenCode Plus vault. Continue?",
      );
      if (!confirmed) return;
      regenerateButton.disabled = true;
      if (keyStatus) keyStatus.textContent = "Regenerating encryption key and wiping encrypted vault...";
      try {
        await regenerateSecretsKey();
        await refreshStatus();
      } catch (error) {
        if (keyStatus) keyStatus.textContent = `Key regeneration failed: ${error instanceof Error ? error.message : String(error)}`;
        regenerateButton.disabled = false;
      }
    });

    restartButton?.addEventListener("click", async () => {
      const confirmed = window.confirm("Restart only the OpenCode server process? OpenCode Plus will keep showing this page while the restart is queued.");
      if (!confirmed) return;
      const root = document.getElementById("opencode-plus-drawer");
      const overlay = root ? showRestartOverlay(root) : null;
      restartButton.disabled = true;
      try {
        await restartOpenCode();
        if (overlay) waitForOpenCodeRestartStatus(overlay);
      } catch (error) {
        if (overlay) {
          overlay.querySelector(".ocp-drawer__restart-detail").textContent = `Restart failed: ${error instanceof Error ? error.message : String(error)}`;
          overlay.querySelector(".ocp-drawer__restart-close")?.removeAttribute("disabled");
        }
        restartButton.disabled = false;
      }
    });

    await refreshStatus();
  }

  function setupRestartControls(container) {
    const restartButton = container.querySelector(".ocp-drawer__opencode-restart");
    wireRestartButton(restartButton);
  }

  function restartConfigMarkup() {
    return `
      <div class="ocp-drawer__system-section">
        <h4>Restart OpenCode</h4>
        <p class="ocp-drawer__field-detail">Restart only the OpenCode server process. The OpenCode Plus gateway remains online and shows a restart overlay while OpenCode comes back.</p>
        <div class="ocp-drawer__button-row">
          <button type="button" class="ocp-drawer__button ocp-drawer__opencode-restart">Restart OpenCode</button>
        </div>
      </div>
    `;
  }

  function wireRestartButton(button) {
    button?.addEventListener("click", async () => {
      const confirmed = window.confirm("Restart only the OpenCode server process? OpenCode Plus will keep showing this page while the restart is queued.");
      if (!confirmed) return;
      const root = document.getElementById("opencode-plus-drawer");
      const overlay = root ? showRestartOverlay(root) : null;
      button.disabled = true;
      try {
        await restartOpenCode();
        if (overlay) waitForOpenCodeRestartStatus(overlay);
      } catch (error) {
        if (overlay) {
          overlay.querySelector(".ocp-drawer__restart-detail").textContent = `Restart failed: ${error instanceof Error ? error.message : String(error)}`;
          overlay.querySelector(".ocp-drawer__restart-close")?.removeAttribute("disabled");
        }
        button.disabled = false;
      }
    });
  }

  function systemConfigMarkup() {
    return `
      <div class="ocp-drawer__system-section">
        <h4>OpenCode Server</h4>
        <p class="ocp-drawer__field-detail">Restart the OpenCode server process without restarting the OpenCode Plus gateway.</p>
        <div class="ocp-drawer__button-row">
          <button type="button" class="ocp-drawer__button ocp-drawer__opencode-restart">Restart OpenCode</button>
        </div>
      </div>
      <div class="ocp-drawer__system-section">
        <h4>Encryption Key</h4>
        <p class="ocp-drawer__system-key-status">Checking encryption key...</p>
        <p class="ocp-drawer__system-vault-summary">Checking encrypted vault...</p>
        <div class="ocp-drawer__button-row">
          <button type="button" class="ocp-drawer__button ocp-drawer__system-key-generate">Generate Key</button>
          <button type="button" class="ocp-drawer__button ocp-drawer__button--danger ocp-drawer__system-key-regenerate">Regenerate Key</button>
        </div>
        <p class="ocp-drawer__field-detail">Regenerating creates a new encryption key and wipes the encrypted provider credential vault. Saved OpenRouter or Gemini vault credentials must be re-entered afterward.</p>
      </div>
    `;
  }

  function credentialFormMarkup(provider) {
    const isOpenRouter = provider === "openrouter";
    const isOpenAi = provider === "openai";
    const isAnthropic = provider === "claude";
    const isXai = provider === "xai";
    return `
      <p class="ocp-drawer__secrets-key-status">Checking encrypted vault...</p>
      <p class="ocp-drawer__field-detail">Manage the encryption key in OpenCode System settings.</p>
      <div class="ocp-drawer__credential-form ${isOpenAi ? "" : "ocp-drawer__credential-form--hidden"}">
        <label>
          <span>OpenAI quota auth source</span>
          <select class="ocp-drawer__field ocp-drawer__openai-auth-source" disabled>
            <option value="auto">Auto</option>
            <option value="chatgpt_subscription">ChatGPT Subscription</option>
            <option value="admin_api">OpenAI Admin API</option>
            <option value="opencode_provider">OpenCode Provider Auth</option>
          </select>
        </label>
        <p class="ocp-drawer__field-detail ocp-drawer__openai-auth-source-detail">Checking auth source...</p>
        <label>
          <span>OpenAI Admin Key</span>
          <input class="ocp-drawer__field ocp-drawer__openai-admin-key" type="password" autocomplete="off" placeholder="sk-admin...">
        </label>
        <p class="ocp-drawer__field-detail">Used for OpenAI organization usage/cost APIs. Normal ChatGPT/OpenCode auth is still read from OpenCode auth.</p>
        <button type="button" class="ocp-drawer__button ocp-drawer__provider-save" data-provider="openai">Save OpenAI Admin</button>
        <span class="ocp-drawer__provider-status" data-provider="openai">Not saved</span>
      </div>
      <div class="ocp-drawer__credential-form ${isAnthropic ? "" : "ocp-drawer__credential-form--hidden"}">
        <label>
          <span>Anthropic quota auth source</span>
          <select class="ocp-drawer__field ocp-drawer__anthropic-auth-source" disabled>
            <option value="auto">Auto</option>
            <option value="claude_subscription">Claude Subscription</option>
            <option value="admin_api">Anthropic Admin API</option>
            <option value="opencode_provider">OpenCode Provider Auth</option>
          </select>
        </label>
        <p class="ocp-drawer__field-detail ocp-drawer__anthropic-auth-source-detail">Checking auth source...</p>
        <label>
          <span>Anthropic Admin API Key</span>
          <input class="ocp-drawer__field ocp-drawer__anthropic-admin-key" type="password" autocomplete="off" placeholder="sk-ant-admin...">
        </label>
        <p class="ocp-drawer__field-detail">Used for Anthropic organization cost reports. Normal Claude/OpenCode auth is still read from OpenCode auth.</p>
        <button type="button" class="ocp-drawer__button ocp-drawer__provider-save" data-provider="anthropic">Save Anthropic Admin</button>
        <span class="ocp-drawer__provider-status" data-provider="anthropic">Not saved</span>
      </div>
      <div class="ocp-drawer__credential-form ${isOpenRouter ? "" : "ocp-drawer__credential-form--hidden"}">
        <label>
          <span>OpenRouter Management Key</span>
          <input class="ocp-drawer__field ocp-drawer__openrouter-key" type="password" autocomplete="off" placeholder="sk-or-v1...">
        </label>
        <button type="button" class="ocp-drawer__button ocp-drawer__provider-save" data-provider="openrouter">Save OpenRouter</button>
        <span class="ocp-drawer__provider-status" data-provider="openrouter">Not saved</span>
      </div>
      <div class="ocp-drawer__credential-form ${!isOpenRouter && !isOpenAi && !isAnthropic && !isXai ? "" : "ocp-drawer__credential-form--hidden"}">
        <label>
          <span>Gemini quota auth source</span>
          <select class="ocp-drawer__field ocp-drawer__gemini-auth-source" disabled>
            <option value="auto">Auto</option>
            <option value="gemini_cli">Gemini CLI Auth</option>
            <option value="opencode_provider">OpenCode Provider Auth</option>
          </select>
        </label>
        <p class="ocp-drawer__field-detail ocp-drawer__gemini-auth-source-detail">Checking auth source...</p>
        <label>
          <span>Gemini OAuth Credentials JSON</span>
          <textarea class="ocp-drawer__field ocp-drawer__gemini-creds" autocomplete="off" spellcheck="false" placeholder='{"refresh_token":"..."}'></textarea>
        </label>
        <button type="button" class="ocp-drawer__button ocp-drawer__provider-save" data-provider="gemini">Save Gemini</button>
        <span class="ocp-drawer__provider-status" data-provider="gemini">Not saved</span>
      </div>
      <div class="ocp-drawer__credential-form ${isXai ? "" : "ocp-drawer__credential-form--hidden"}">
        <label>
          <span>xAI Management Key</span>
          <input class="ocp-drawer__field ocp-drawer__xai-key" type="password" autocomplete="off" placeholder="xai-mgmt-...">
        </label>
        <label>
          <span>xAI Team ID (optional)</span>
          <input class="ocp-drawer__field ocp-drawer__xai-team" type="text" autocomplete="off" placeholder="Auto-detected from management key when possible">
        </label>
        <p class="ocp-drawer__field-detail">Used only for xAI Management API billing/prepaid balance. This is separate from normal OpenCode Grok inference keys.</p>
        <button type="button" class="ocp-drawer__button ocp-drawer__provider-save" data-provider="xai">Save xAI</button>
        <span class="ocp-drawer__provider-status" data-provider="xai">Not saved</span>
      </div>
    `;
  }

  function openModuleConfig(root, module) {
    const modal = root.querySelector(".ocp-drawer__modal");
    const title = modal.querySelector(".ocp-drawer__modal-title");
    const body = modal.querySelector(".ocp-drawer__modal-body");
    title.textContent = `Configure ${module.label}`;

    if (module.id === "openai" || module.id === "openrouter" || module.id === "gemini" || module.id === "claude" || module.id === "xai") {
      body.innerHTML = credentialFormMarkup(module.id);
      setupCredentialControls(body);
      if (module.id === "gemini") setupGeminiAuthSourceControls(body);
      if (module.id === "openai") setupProviderAuthSourceControls(body, "openai");
      if (module.id === "claude") setupProviderAuthSourceControls(body, "anthropic");
    } else {
      body.innerHTML = `<p class="ocp-drawer__empty-config">No extra configuration is available for ${module.label} yet.</p>`;
    }

    modal.hidden = false;
    modal.querySelector(".ocp-drawer__modal-close").focus();
  }

  async function setupGatewayControls(container) {
    container.querySelector(".ocp-drawer__health").textContent = await fetchGatewayHealth();
    const authSelect = container.querySelector(".ocp-drawer__auth-select");
    try {
      const authStatus = await fetchAuthStatus();
      renderAuthStatus(container, authStatus);
      authSelect.disabled = false;
    } catch (error) {
      container.querySelector(".ocp-drawer__auth-detail").textContent = `Auth mode unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }

    authSelect.addEventListener("change", async () => {
      const enableCloudflareAuth = authSelect.value === "enabled";
      const previousValue = enableCloudflareAuth ? "disabled" : "enabled";
      if (!enableCloudflareAuth) {
        const confirmed = window.confirm(
          "Disabling Cloudflare Auth will expose the local OpenCode login. Make sure you know the local username and password before continuing, or you may lock yourself out. Local OpenCode auth will not be changed.",
        );
        if (!confirmed) {
          authSelect.value = previousValue;
          return;
        }
      }
      authSelect.disabled = true;
      container.querySelector(".ocp-drawer__auth-detail").textContent = "Updating auth mode...";
      try {
        const authStatus = await updateCloudflareAuth(enableCloudflareAuth);
        renderAuthStatus(container, authStatus);
      } catch (error) {
        authSelect.value = previousValue;
        container.querySelector(".ocp-drawer__auth-detail").textContent = `Auth mode update failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        authSelect.disabled = false;
      }
    });
  }

  function gatewayConfigMarkup() {
    return `
      <p class="ocp-drawer__health">Checking gateway...</p>
      <label class="ocp-drawer__select-row">
        <span>Cloudflare Auth</span>
        <select class="ocp-drawer__auth-select" disabled>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
      </label>
      <p class="ocp-drawer__auth-detail">Checking auth mode...</p>
    `;
  }

  function openConfigArea(root, area, settings) {
    const modal = root.querySelector(".ocp-drawer__modal");
    const title = modal.querySelector(".ocp-drawer__modal-title");
    const body = modal.querySelector(".ocp-drawer__modal-body");
    title.textContent = area.label;

    if (area.id === "restart") {
      body.innerHTML = restartConfigMarkup();
      setupRestartControls(body);
    } else if (area.id === "system") {
      body.innerHTML = systemConfigMarkup();
      setupSystemControls(body);
    } else if (area.id === "gateway") {
      body.innerHTML = gatewayConfigMarkup();
      setupGatewayControls(body);
    } else if (area.id === "statusline") {
      body.innerHTML = `<p class="ocp-drawer__modal-intro">Enable or disable each statusline module. Provider gears open credentials and module-specific settings.</p><div class="ocp-drawer__module-list"></div>`;
      const moduleList = body.querySelector(".ocp-drawer__module-list");
      MODULES.forEach((module) => {
        moduleList.append(createModuleRow(module, settings, (selectedModule) => openModuleConfig(root, selectedModule)));
      });
    } else {
      body.innerHTML = `<p class="ocp-drawer__empty-config">No configuration is available for ${area.label} yet.</p>`;
    }

    modal.hidden = false;
    modal.querySelector(".ocp-drawer__modal-close").focus();
  }

  function closeModuleConfig(root) {
    const modal = root.querySelector(".ocp-drawer__modal");
    if (modal) modal.hidden = true;
  }

  function setOpen(root, settings, open) {
    settings.open = open;
    const panel = root.querySelector(".ocp-drawer__panel");
    if (panel) root.style.setProperty("--ocp-drawer-panel-height", `${panel.offsetHeight}px`);
    root.classList.toggle("ocp-drawer--open", open);
    root.querySelector(".ocp-drawer__handle-text").textContent = open ? "Hide OpenCode Plus" : "OpenCode Plus";
    writeSettings(settings);
  }

  function enableHandleDrag(root, handle, settings) {
    let drag = null;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        moved: false,
      };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("ocp-drawer__handle--dragging");
    });

    handle.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const rect = document.documentElement.getBoundingClientRect();
      const next = clamp((event.clientX / rect.width) * 100, 12, 88);
      if (Math.abs(event.clientX - drag.startX) > 3) drag.moved = true;
      if (window.matchMedia?.("(max-width: 640px)").matches) {
        settings.mobileHandleXPercent = Math.round(next * 10) / 10;
      } else {
        settings.handleXPercent = Math.round(next * 10) / 10;
      }
      applyHandlePosition(root, settings);
    });

    function finishDrag(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      handle.releasePointerCapture(event.pointerId);
      handle.classList.remove("ocp-drawer__handle--dragging");
      if (drag.moved) {
        event.preventDefault();
        event.stopPropagation();
        writeSettings(settings);
        setTimeout(() => {
          drag = null;
        }, 0);
      } else {
        drag = null;
      }
    }

    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);
    handle.addEventListener("click", (event) => {
      if (drag?.moved) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
  }

  async function mount() {
    if (document.getElementById("opencode-plus-drawer")) return;

    const settings = readSettings();
    const root = document.createElement("section");
    root.id = "opencode-plus-drawer";
    root.className = "ocp-drawer";
    root.setAttribute("aria-label", "OpenCode Plus enhancements");
    applyHandlePosition(root, settings);
    root.classList.toggle("ocp-drawer--open", Boolean(settings.open));

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "ocp-drawer__handle";
    handle.innerHTML = `<span class="ocp-drawer__handle-dot"></span><span class="ocp-drawer__handle-text">${settings.open ? "Hide OpenCode Plus" : "OpenCode Plus"}</span><span class="ocp-drawer__chevron">⌄</span>`;
    handle.addEventListener("click", () => setOpen(root, settings, !settings.open));
    enableHandleDrag(root, handle, settings);

    const panel = document.createElement("div");
    panel.className = "ocp-drawer__panel";
    panel.innerHTML = `
      <div class="ocp-drawer__header">
        <div>
          <div class="ocp-drawer__eyebrow">Enhancement Suite</div>
          <h2>OpenCode Plus Controls</h2>
        </div>
        <div class="ocp-drawer__header-actions">
          <button type="button" class="ocp-drawer__button ocp-drawer__button--compact ocp-drawer__opencode-restart-header">Restart</button>
          <button type="button" class="ocp-drawer__close">Hide</button>
        </div>
      </div>
      <div class="ocp-drawer__config-shell">
        <h3>Configuration Areas</h3>
        <p>Choose a feature area to configure. New OpenCode Plus features will appear here and wrap into the two-column list.</p>
        <div class="ocp-drawer__config-list"></div>
      </div>
    `;

    const modal = document.createElement("div");
    modal.className = "ocp-drawer__modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="ocp-drawer__modal-backdrop" data-modal-close></div>
      <div class="ocp-drawer__modal-panel" role="dialog" aria-modal="true" aria-labelledby="ocp-drawer-modal-title">
        <div class="ocp-drawer__modal-header">
          <h3 id="ocp-drawer-modal-title" class="ocp-drawer__modal-title">Configure Module</h3>
          <button type="button" class="ocp-drawer__modal-close" data-modal-close>Close</button>
        </div>
        <div class="ocp-drawer__modal-body"></div>
      </div>
    `;

    const configList = panel.querySelector(".ocp-drawer__config-list");
    CONFIG_AREAS.forEach((area) => {
      configList.append(createConfigAreaRow(area, (selectedArea) => openConfigArea(root, selectedArea, settings)));
    });

    panel.querySelector(".ocp-drawer__close").addEventListener("click", () => setOpen(root, settings, false));
    wireRestartButton(panel.querySelector(".ocp-drawer__opencode-restart-header"));
    modal.querySelectorAll("[data-modal-close]").forEach((element) => {
      element.addEventListener("click", () => closeModuleConfig(root));
    });
    root.append(panel, modal, handle);
    document.documentElement.append(root);
    root.style.setProperty("--ocp-drawer-panel-height", `${panel.offsetHeight}px`);
    window.addEventListener("resize", () => {
      root.style.setProperty("--ocp-drawer-panel-height", `${panel.offsetHeight}px`);
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !root.querySelector(".ocp-drawer__modal")?.hidden) {
        closeModuleConfig(root);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setOpen(root, settings, !settings.open);
      }
    });
    installStaleThinkingWatchdog();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();

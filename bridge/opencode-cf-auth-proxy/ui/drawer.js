(() => {
  if (window.__opencodePlusDrawerLoaded) return;
  window.__opencodePlusDrawerLoaded = true;

  const STORAGE_KEY = "opencodePlusDrawerSettings";
  const OPENCODE_PLUS_VERSION = "local Docker build";
  const OPENCODE_VERSION = "checking...";
  const GITHUB_URL = "https://github.com/datbird/opencode-plus";
  const STALE_THINKING_VISIBLE_MS = 4 * 60 * 1000;
  const STALE_THINKING_QUIET_MS = 90 * 1000;
  const STALE_THINKING_CHECK_MS = 15 * 1000;
  const STALE_THINKING_RETURN_REFRESH_MS = 2 * 60 * 1000;
  const STALE_THINKING_SNOOZE_MS = 10 * 60 * 1000;
  const RECOVERY_NOTICE_KEY_PREFIX = "opencodePlusRecoveryNoticeDismissed";
  const DEFAULT_SETTINGS = {
    open: false,
    handleXPercent: 72,
    mobileHandleXPercent: null,
    nativeControlsCollapsed: false,
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
    { id: "system", label: "OpenCode Plus Settings", description: "Gateway, statusline modules, vault encryption, and runtime preferences." },
    { id: "hidden", label: "OpenCode Hidden Settings", description: "Access persisted OpenCode settings that normally only live in config." },
    { id: "soul", label: "Soul & Sync", description: "Database-backed Souls, synced skills, commands, tools, hooks, named spaces, and synced projects." },
    { id: "storage-providers", label: "Storage Providers", description: "Connect reusable storage accounts and servers." },
    { id: "workspace-links", label: "Workspace Links", description: "Map connected storage into the current workspace." },
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
    return Boolean(node.closest?.("#opencode-plus-drawer, #oc-webui-sidecar, .ocp-stale-thinking, .ocp-recovery-notice"));
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

  function showAutoRefreshNotice() {
    if (document.querySelector(".ocp-stale-thinking")) return;
    const notice = document.createElement("aside");
    notice.className = "ocp-stale-thinking ocp-stale-thinking--refreshing";
    notice.setAttribute("role", "status");
    notice.innerHTML = `
      <span class="ocp-drawer__mini-spinner" aria-hidden="true"></span>
      <div class="ocp-stale-thinking__copy">
        <strong>Refreshing stale OpenCode view</strong>
        <span>This tab was idle while OpenCode showed Thinking. Reloading the view to catch up with the saved session.</span>
      </div>
    `;
    document.documentElement.append(notice);
  }

  function currentSessionId() {
    return location.pathname.match(/\/session\/(ses_[^/?#]+)/)?.[1] || "";
  }

  async function fetchLatestSessionMessage(sessionId) {
    if (!sessionId) return null;
    const response = await fetch(`/session/${encodeURIComponent(sessionId)}/message`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    const messages = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.messages) ? body.messages : [];
    return messages
      .map((message) => message?.data && typeof message.data === "object" ? { id: message.id || message.data.id, ...message.data } : message)
      .filter(Boolean)
      .sort((a, b) => Number(a?.time?.created || a?.time_created || 0) - Number(b?.time?.created || b?.time_created || 0))
      .at(-1) || null;
  }

  function recoveryErrorFromMessage(message) {
    if (message?.role !== "assistant") return "";
    const error = message.error || message.data?.error;
    return String(error?.data?.message || error?.message || error || "").trim();
  }

  function recoveryNoticeKey(message, error) {
    const id = message?.id || message?.time?.created || Date.now();
    return `${RECOVERY_NOTICE_KEY_PREFIX}:${id}:${error.slice(0, 80)}`;
  }

  function showRecoveryNotice(message, error) {
    if (!error || document.querySelector(".ocp-recovery-notice")) return;
    const key = recoveryNoticeKey(message, error);
    if (sessionStorage.getItem(key) === "dismissed") return;

    const notice = document.createElement("aside");
    notice.className = "ocp-stale-thinking ocp-recovery-notice";
    notice.setAttribute("role", "status");
    notice.innerHTML = `
      <div class="ocp-stale-thinking__copy">
        <strong>Latest request failed</strong>
        <span>${escapeHtml(shorten(error, 180))}</span>
      </div>
      <div class="ocp-stale-thinking__actions">
        <button type="button" class="ocp-stale-thinking__button ocp-stale-thinking__button--primary">Refresh</button>
        <button type="button" class="ocp-stale-thinking__button">Dismiss</button>
      </div>
    `;
    notice.querySelector(".ocp-stale-thinking__button--primary")?.addEventListener("click", () => window.location.reload());
    notice.querySelector(".ocp-stale-thinking__button:not(.ocp-stale-thinking__button--primary)")?.addEventListener("click", () => {
      sessionStorage.setItem(key, "dismissed");
      notice.remove();
    });
    document.documentElement.append(notice);
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  }

  function shorten(value, maxLength) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  function formatOpenCodeVersionTransition(currentVersion, upgradeVersion, installedVersion = "") {
    const current = currentVersion || "unknown";
    const upgrade = upgradeVersion || "unknown";
    const installed = installedVersion ? ` | Installed: ${installedVersion}` : "";
    return `Current: ${current} | Upgrade: ${upgrade}${installed}`;
  }

  function formatRelativeTime(value) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "unknown";
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 90) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function deploymentLastSeen(deployment) {
    return deployment?.metadata?.last_seen_at || deployment?.updated || deployment?.created || "";
  }

  function instanceTooltip(deployment) {
    const rows = [
      ["Name", deployment.name],
      ["ID", deployment.id],
      ["Hostname", deployment.hostname],
      ["OpenCode", deployment.opencode_version],
      ["Commit", deployment.git_commit],
      ["Identity", deployment.stable_identity === false ? "hostname fallback" : "stable"],
      ["URL", deployment.url],
    ];
    return rows
      .filter(([, value]) => value !== undefined && value !== null && String(value).trim())
      .map(([label, value]) => `${label}: ${value}`)
      .join("\n");
  }

  function updateInstanceBadge(root, status) {
    const deployment = status?.deployment || {};
    const label = deployment.name || deployment.id || "unknown";
    const tooltip = instanceTooltip(deployment) || "Instance information unavailable";
    root.querySelectorAll(".ocp-drawer__instance-name").forEach((element) => {
      element.textContent = label;
      element.title = tooltip;
      element.setAttribute("aria-label", tooltip);
    });
    root.querySelectorAll(".ocp-drawer__instance-badge").forEach((element) => {
      element.classList.toggle("ocp-drawer__instance-badge--unstable", deployment.stable_identity === false);
      element.title = tooltip;
      element.setAttribute("aria-label", tooltip);
    });
    const handleInstance = root.querySelector(".ocp-drawer__handle-instance");
    if (handleInstance) {
      handleInstance.textContent = label;
      handleInstance.title = tooltip;
      handleInstance.setAttribute("aria-label", tooltip);
    }
  }

  function base64UrlEncode(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    bytes.forEach((byte) => binary += String.fromCharCode(byte));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  function currentOpenCodeDirectory() {
    const encoded = location.pathname.split("/").filter(Boolean)[0];
    if (!encoded) return "/root/aiplayground";
    try {
      const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes);
      return decoded.startsWith("/") ? decoded : "/root/aiplayground";
    } catch {
      return "/root/aiplayground";
    }
  }

  function syncOpenCodeAutoAcceptPreference(enabled) {
    const key = "permission.v3";
    let state = {};
    try {
      state = JSON.parse(localStorage.getItem(key) || "{}");
    } catch {
      state = {};
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
    if (!state.autoAccept || typeof state.autoAccept !== "object" || Array.isArray(state.autoAccept)) state.autoAccept = {};
    state.autoAccept[`${base64UrlEncode(currentOpenCodeDirectory())}/*`] = Boolean(enabled);
    localStorage.setItem(key, JSON.stringify(state));
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(state), storageArea: localStorage }));
  }

  function installStaleThinkingWatchdog() {
    if (window.__opencodePlusStaleThinkingWatchdogInstalled) return;
    window.__opencodePlusStaleThinkingWatchdogInstalled = true;
    let thinkingSince = 0;
    let lastAppMutation = Date.now();
    let lastRecoveryCheck = 0;
    let hiddenSince = document.visibilityState === "hidden" ? Date.now() : 0;
    let blurredSince = document.hasFocus?.() === false ? Date.now() : 0;
    let autoRefreshQueued = false;

    const observer = new MutationObserver((mutations) => {
      if (mutations.every((mutation) => {
        const nodes = [mutation.target, ...mutation.addedNodes, ...mutation.removedNodes];
        return nodes.every((node) => node.nodeType !== Node.ELEMENT_NODE || isOwnUiNode(node));
      })) return;
      lastAppMutation = Date.now();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    function runThinkingWatchdog(fromReturn = false) {
      if (document.visibilityState === "hidden") {
        if (!hiddenSince) hiddenSince = Date.now();
        return;
      }
      const now = Date.now();
      const hiddenFor = hiddenSince ? now - hiddenSince : 0;
      const blurredFor = blurredSince ? now - blurredSince : 0;
      const awayFor = Math.max(hiddenFor, blurredFor);
      hiddenSince = 0;
      blurredSince = 0;
      if (now - lastRecoveryCheck >= STALE_THINKING_CHECK_MS) {
        lastRecoveryCheck = now;
        fetchLatestSessionMessage(currentSessionId()).then((message) => {
          const error = recoveryErrorFromMessage(message);
          if (error) showRecoveryNotice(message, error);
        }).catch(() => {});
      }
      const looksLikeThinking = pageLooksLikeThinking();
      if (!looksLikeThinking) {
        thinkingSince = 0;
        dismissStaleThinkingNotice(false);
        return;
      }
      if (!thinkingSince) thinkingSince = now;
      if (fromReturn && !autoRefreshQueued && awayFor >= STALE_THINKING_RETURN_REFRESH_MS && now - lastAppMutation >= STALE_THINKING_QUIET_MS) {
        autoRefreshQueued = true;
        showAutoRefreshNotice();
        window.setTimeout(() => window.location.reload(), 450);
        return;
      }
      if (window.__opencodePlusStaleThinkingSnoozedUntil > now) return;
      if (now - thinkingSince >= STALE_THINKING_VISIBLE_MS && now - lastAppMutation >= STALE_THINKING_QUIET_MS) showStaleThinkingNotice();
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        hiddenSince = Date.now();
        return;
      }
      runThinkingWatchdog(true);
    });
    window.addEventListener("blur", () => {
      blurredSince = Date.now();
    });
    window.addEventListener("focus", () => runThinkingWatchdog(true));
    window.addEventListener("pageshow", () => runThinkingWatchdog(true));
    window.setInterval(() => runThinkingWatchdog(false), STALE_THINKING_CHECK_MS);
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

  async function fetchGatewayInfo() {
    const response = await fetch("/__opencode-plus/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function fetchSoulStatus() {
    const response = await fetch("/__opencode-plus/soul/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function formatSupportConsole(info) {
    const rows = [
      ["service", info?.service || "opencode-plus-ui-gateway"],
      ["gateway", info?.ui_enabled ? "online" : "disabled"],
      ["ui assets", info?.external_ui ? "external persisted assets" : "embedded assets"],
      ["upstream", info?.upstream_url || "unknown"],
    ];
    const support = Array.isArray(info?.support) ? info.support : [];
    support.forEach((item) => rows.push([item?.name || "unknown", item?.version || "unknown"]));
    const width = rows.reduce((max, row) => Math.max(max, row[0].length), 0);
    return rows.map(([name, value]) => `$ ${name.padEnd(width)} : ${value}`).join("\n");
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
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

  async function fetchOpenCodeConfig() {
    const response = await fetch("/__opencode-plus/opencode/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function updateOpenCodeConfig(config) {
    const response = await fetch("/__opencode-plus/opencode/config", {
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

  async function updateOpenCode() {
    const response = await fetch("/__opencode-plus/opencode/update", { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function checkOpenCodeUpdate() {
    const response = await fetch("/__opencode-plus/opencode/update/check", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function fetchOpenCodeUpdateStatus() {
    const response = await fetch("/__opencode-plus/opencode/update/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function fetchMounts() {
    const response = await fetch("/__opencode-plus/mounts", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function fetchStorageProviders() {
    const response = await fetch("/__opencode-plus/storage-providers", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function createStorageProvider(payload) {
    const response = await fetch("/__opencode-plus/storage-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function deleteStorageProvider(id) {
    const response = await fetch(`/__opencode-plus/storage-providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function fetchGoogleDriveAccounts() {
    const response = await fetch("/__opencode-plus/mounts/google-drive/account", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function connectGoogleDriveAccount(payload) {
    const response = await fetch("/__opencode-plus/mounts/google-drive/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function createMount(payload) {
    const response = await fetch("/__opencode-plus/mounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      const body = contentType.includes("application/json")
        ? await response.json().catch(() => ({}))
        : { detail: (await response.text().catch(() => "")).trim().slice(0, 180) };
      throw new Error(body.detail || body.error || `${response.status} ${response.statusText || "request failed"}`);
    }
    return response.json();
  }

  async function updateMount(id, payload) {
    const response = await fetch(`/__opencode-plus/mounts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function mountAction(id, action) {
    const response = await fetch(`/__opencode-plus/mounts/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function deleteMount(id) {
    const response = await fetch(`/__opencode-plus/mounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
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

  function showUpdateOverlay(root) {
    let overlay = root.querySelector(".ocp-drawer__update-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "ocp-drawer__restart-overlay ocp-drawer__update-overlay";
      overlay.innerHTML = `
        <div class="ocp-drawer__restart-card ocp-drawer__update-card" role="status" aria-live="polite">
          <span class="ocp-drawer__restart-spinner" aria-hidden="true"></span>
          <strong class="ocp-drawer__update-title">Updating OpenCode</strong>
          <p class="ocp-drawer__restart-detail ocp-drawer__update-detail">Queueing update...</p>
          <div class="ocp-drawer__update-version" hidden></div>
          <div class="ocp-drawer__update-changelog" hidden></div>
          <pre class="ocp-drawer__update-log" hidden></pre>
          <div class="ocp-drawer__button-row ocp-drawer__update-actions">
            <button type="button" class="ocp-drawer__button ocp-drawer__update-continue" hidden>Continue Upgrade</button>
            <button type="button" class="ocp-drawer__button ocp-drawer__update-close" disabled>Close</button>
          </div>
        </div>
      `;
      root.append(overlay);
      overlay.querySelector(".ocp-drawer__update-close")?.addEventListener("click", () => overlay.remove());
    }
    overlay.hidden = false;
    const title = overlay.querySelector(".ocp-drawer__update-title");
    if (title) title.textContent = "Updating OpenCode";
    overlay.querySelector(".ocp-drawer__restart-spinner")?.removeAttribute("hidden");
    overlay.querySelector(".ocp-drawer__update-close")?.setAttribute("disabled", "");
    return overlay;
  }

  function showWorkspaceLinkOverlay(root, titleText, detailText) {
    let overlay = root.querySelector(".ocp-drawer__link-action-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "ocp-drawer__restart-overlay ocp-drawer__link-action-overlay";
      overlay.innerHTML = `
        <div class="ocp-drawer__restart-card ocp-drawer__link-action-card" role="status" aria-live="polite">
          <span class="ocp-drawer__restart-spinner" aria-hidden="true"></span>
          <strong class="ocp-drawer__link-action-title"></strong>
          <p class="ocp-drawer__restart-detail ocp-drawer__link-action-detail"></p>
          <button type="button" class="ocp-drawer__button ocp-drawer__link-action-close" disabled>Close</button>
        </div>
      `;
      root.append(overlay);
      overlay.querySelector(".ocp-drawer__link-action-close")?.addEventListener("click", () => overlay.remove());
    }
    overlay.hidden = false;
    overlay.querySelector(".ocp-drawer__restart-spinner")?.removeAttribute("hidden");
    overlay.querySelector(".ocp-drawer__link-action-close")?.setAttribute("disabled", "");
    overlay.querySelector(".ocp-drawer__link-action-title").textContent = titleText;
    overlay.querySelector(".ocp-drawer__link-action-detail").textContent = detailText;
    return overlay;
  }

  function finishWorkspaceLinkOverlay(overlay, titleText, detailText) {
    if (!overlay) return;
    overlay.querySelector(".ocp-drawer__restart-spinner")?.setAttribute("hidden", "");
    overlay.querySelector(".ocp-drawer__link-action-title").textContent = titleText;
    overlay.querySelector(".ocp-drawer__link-action-detail").textContent = detailText;
    overlay.querySelector(".ocp-drawer__link-action-close")?.removeAttribute("disabled");
  }

  function updateStatusText(status) {
    const stage = status?.stage || "queued";
    if (stage === "queued") return "Update queued...";
    if (stage === "checking") return "Checking current and latest OpenCode versions...";
    if (stage === "installing") return "Installing OpenCode. This can take a while; the gateway is still alive.";
    if (stage === "persisting") return "Persisting updated OpenCode install so container recreates keep it...";
    if (stage === "restarting") return "Restarting only opencode-server while OpenCode Plus stays online...";
    if (stage === "verifying") return "Waiting for OpenCode server to respond again...";
    if (stage === "up_to_date") return `OpenCode is already current${status.latest_version ? ` (${status.latest_version})` : ""}.`;
    if (stage === "complete") return `OpenCode updated${status.after_version ? ` to ${status.after_version}` : ""}. Refreshing...`;
    if (stage === "failed") return `Update failed: ${status.error || "unknown error"}`;
    return "Updating OpenCode...";
  }

  async function waitForOpenCodeUpdateStatus(overlay) {
    const detail = overlay.querySelector(".ocp-drawer__update-detail");
    const version = overlay.querySelector(".ocp-drawer__update-version");
    const changelog = overlay.querySelector(".ocp-drawer__update-changelog");
    const log = overlay.querySelector(".ocp-drawer__update-log");
    const close = overlay.querySelector(".ocp-drawer__update-close");
    const spinner = overlay.querySelector(".ocp-drawer__restart-spinner");
    const started = Date.now();
    while (Date.now() - started < 360_000) {
      try {
        const response = await fetchOpenCodeUpdateStatus();
        const status = response?.status || {};
        if (detail) detail.textContent = updateStatusText(status);
        if (version && (status.before_version || status.latest_version || status.after_version)) {
          version.hidden = false;
          version.textContent = formatOpenCodeVersionTransition(status.before_version, status.latest_version || "checking", status.after_version);
        }
        if (changelog && status.changelog) {
          changelog.hidden = false;
          changelog.textContent = String(status.changelog).replace(/^##\s*Changelog\s*/i, "").trim().slice(0, 12000);
        }
        if (log && status.log) {
          log.hidden = false;
          log.textContent = String(status.log).slice(-4000);
        }
        if (status.stage === "up_to_date") {
          spinner?.setAttribute("hidden", "");
          close?.removeAttribute("disabled");
          return;
        }
        if (status.stage === "complete") {
          spinner?.setAttribute("hidden", "");
          window.setTimeout(() => window.location.reload(), 900);
          return;
        }
        if (status.stage === "failed") {
          spinner?.setAttribute("hidden", "");
          close?.removeAttribute("disabled");
          return;
        }
      } catch (error) {
        if (detail) detail.textContent = `Update status unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    }
    if (detail) detail.textContent = "Update is still running or status timed out. Check OpenCode Plus logs if needed.";
    close?.removeAttribute("disabled");
  }

  function renderUpdateCheck(overlay, check) {
    const detail = overlay.querySelector(".ocp-drawer__update-detail");
    const version = overlay.querySelector(".ocp-drawer__update-version");
    const changelog = overlay.querySelector(".ocp-drawer__update-changelog");
    const continueButton = overlay.querySelector(".ocp-drawer__update-continue");
    const close = overlay.querySelector(".ocp-drawer__update-close");
    const spinner = overlay.querySelector(".ocp-drawer__restart-spinner");
    const title = overlay.querySelector(".ocp-drawer__update-title");

    if (title) title.textContent = check.update_available ? "OpenCode Upgrade Available" : "OpenCode Is Current";

    if (detail) {
      detail.textContent = check.update_available
        ? "Review the current and upgrade versions plus the changelog before continuing."
        : "OpenCode is already current. No update is needed.";
    }
    if (version) {
      version.hidden = false;
      version.textContent = formatOpenCodeVersionTransition(check.current_version, check.latest_version);
    }
    if (changelog && check.changelog) {
      changelog.hidden = false;
      changelog.textContent = String(check.changelog).replace(/^##\s*Changelog\s*/i, "").trim().slice(0, 12000);
    } else if (changelog) {
      changelog.hidden = true;
      changelog.textContent = "";
    }
    if (continueButton) continueButton.hidden = !check.update_available;
    if (!check.update_available) spinner?.setAttribute("hidden", "");
    close?.removeAttribute("disabled");
  }

  async function startOpenCodeUpdateFromOverlay(overlay, button) {
    const detail = overlay.querySelector(".ocp-drawer__update-detail");
    const close = overlay.querySelector(".ocp-drawer__update-close");
    const continueButton = overlay.querySelector(".ocp-drawer__update-continue");
    const spinner = overlay.querySelector(".ocp-drawer__restart-spinner");
    if (continueButton) continueButton.hidden = true;
    spinner?.removeAttribute("hidden");
    close?.setAttribute("disabled", "");
    if (detail) detail.textContent = "Starting OpenCode update...";
    button.disabled = true;
    try {
      await updateOpenCode();
      waitForOpenCodeUpdateStatus(overlay);
    } catch (error) {
      if (detail) detail.textContent = `Update failed to start: ${error instanceof Error ? error.message : String(error)}`;
      close?.removeAttribute("disabled");
    } finally {
      button.disabled = false;
    }
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

  async function setupSystemControls(root, container, settings) {
    const keyStatus = container.querySelector(".ocp-drawer__system-key-status");
    const generateButton = container.querySelector(".ocp-drawer__system-key-generate");
    const regenerateButton = container.querySelector(".ocp-drawer__system-key-regenerate");
    const moduleList = container.querySelector(".ocp-drawer__system-module-list");
    const nativeCollapsed = container.querySelector(".ocp-drawer__plus-native-collapsed");
    const drawerOpen = container.querySelector(".ocp-drawer__plus-drawer-open");

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

    if (moduleList) {
      MODULES.forEach((module) => {
        moduleList.append(createModuleRow(module, settings, (selectedModule) => openModuleConfig(root, selectedModule)));
      });
    }
    nativeCollapsed?.addEventListener("change", () => {
      settings.nativeControlsCollapsed = nativeCollapsed.checked;
      writeSettings(settings);
    });
    drawerOpen?.addEventListener("change", () => {
      setOpen(root, settings, drawerOpen.checked);
    });
    setupGatewayControls(container);
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

  function wireUpdateButton(button) {
    button?.addEventListener("click", async () => {
      const root = document.getElementById("opencode-plus-drawer");
      const overlay = root ? showUpdateOverlay(root) : null;
      if (!overlay) return;
      const detail = overlay.querySelector(".ocp-drawer__update-detail");
      const close = overlay.querySelector(".ocp-drawer__update-close");
      const continueButton = overlay.querySelector(".ocp-drawer__update-continue");
      const log = overlay.querySelector(".ocp-drawer__update-log");
      if (continueButton) continueButton.hidden = true;
      if (log) log.hidden = true;
      close?.setAttribute("disabled", "");
      if (detail) detail.textContent = "Checking OpenCode releases...";
      button.disabled = true;
      try {
        const check = await checkOpenCodeUpdate();
        renderUpdateCheck(overlay, check);
        if (continueButton) {
          continueButton.onclick = () => startOpenCodeUpdateFromOverlay(overlay, continueButton);
        }
      } catch (error) {
        if (detail) detail.textContent = `Update check failed: ${error instanceof Error ? error.message : String(error)}`;
        close?.removeAttribute("disabled");
      } finally {
        button.disabled = false;
      }
    });
  }

  function openUpdateOverlayWithCheck(root, check) {
    const overlay = showUpdateOverlay(root);
    renderUpdateCheck(overlay, check);
    const continueButton = overlay.querySelector(".ocp-drawer__update-continue");
    if (continueButton) {
      continueButton.onclick = () => startOpenCodeUpdateFromOverlay(overlay, continueButton);
    }
  }

  function systemConfigMarkup() {
    return `
      <div class="ocp-drawer__system-section">
        <h4>Gateway</h4>
        ${gatewayConfigMarkup()}
      </div>
      <div class="ocp-drawer__system-section">
        <h4>Statusline Modules</h4>
        <p class="ocp-drawer__field-detail">Enable or disable each statusline module. Provider gears open credentials and module-specific settings.</p>
        <div class="ocp-drawer__module-list ocp-drawer__system-module-list"></div>
      </div>
      <div class="ocp-drawer__system-section">
        <h4>OpenCode Plus UI</h4>
        <label class="ocp-drawer__hidden-toggle">
          <input class="ocp-drawer__plus-native-collapsed" type="checkbox" ${readSettings().nativeControlsCollapsed ? "checked" : ""}>
          <span>
            <strong>Always collapse built-in composer controls</strong>
            <small>Keep the native Mode, Model, and Effort controls tucked behind the statusline chevron after refreshes.</small>
          </span>
        </label>
        <label class="ocp-drawer__hidden-toggle">
          <input class="ocp-drawer__plus-drawer-open" type="checkbox" ${readSettings().open ? "checked" : ""}>
          <span>
            <strong>Keep OpenCode Plus drawer open</strong>
            <small>Persist the drawer in its open state across page refreshes until you hide it.</small>
          </span>
        </label>
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

  function hiddenSettingsMarkup(settings) {
    return `
      <p class="ocp-drawer__modal-intro">These controls write OpenCode config-file settings that are not persistently exposed by the standard OpenCode Web UI.</p>
      <div class="ocp-drawer__system-section">
        <label class="ocp-drawer__hidden-toggle">
          <input class="ocp-drawer__hidden-auto-accept" type="checkbox" disabled>
          <span>
            <strong>Always auto-accept permissions</strong>
            <small>Persists auto-accept by writing OpenCode permission config and syncing the WebUI preference for this workspace.</small>
          </span>
        </label>
        <p class="ocp-drawer__field-detail ocp-drawer__hidden-config-detail">Checking OpenCode config...</p>
      </div>
    `;
  }

  function soulSyncMarkup() {
    return `
      <p class="ocp-drawer__modal-intro">OpenCode Plus Soul Sync will use PocketBase as the source of truth and render normal OpenCode files like <code>AGENTS.md</code>, skills, commands, tools, and plugins.</p>
      <div class="ocp-drawer__system-section">
        <h4>Database</h4>
        <p class="ocp-drawer__field-detail ocp-drawer__soul-db-status">Checking PocketBase...</p>
        <p class="ocp-drawer__field-detail ocp-drawer__soul-schema-status">Checking schema...</p>
      </div>
      <div class="ocp-drawer__system-section">
        <h4>Deployment</h4>
        <p class="ocp-drawer__field-detail ocp-drawer__soul-deployment-status">Checking deployment identity...</p>
        <div class="ocp-drawer__instance-list">Loading known instances...</div>
      </div>
      <div class="ocp-drawer__system-section">
        <h4>What Sync Means Today</h4>
        <div class="ocp-drawer__sync-scope-list">
          <div><strong>Shared via PocketBase:</strong> deployment heartbeat, schema readiness, metadata records.</div>
          <div><strong>Local to this instance:</strong> OpenCode memory files, rendered files, secrets, browser state.</div>
          <div><strong>Not active yet:</strong> automatic file rendering for <code>AGENTS.md</code>, skills, commands, tools, plugins, or projects.</div>
        </div>
      </div>
      <div class="ocp-drawer__system-section">
        <h4>Synced Features</h4>
        <div class="ocp-drawer__soul-feature-list">
          <p class="ocp-drawer__field-detail">Loading feature readiness...</p>
        </div>
      </div>
      <div class="ocp-drawer__system-section">
        <h4>Synced Projects</h4>
        <p class="ocp-drawer__field-detail ocp-drawer__soul-project-gate">Checking requirements...</p>
        <div class="ocp-drawer__button-row">
          <button type="button" class="ocp-drawer__button ocp-drawer__soul-create-project" disabled title="Requires PocketBase connection and at least one named space.">Create Synced Project</button>
        </div>
      </div>
    `;
  }

  function renderSoulStatus(container, status) {
    const db = status?.pocketbase || {};
    const deployment = status?.deployment || {};
    const dbStatus = container.querySelector(".ocp-drawer__soul-db-status");
    const schemaStatus = container.querySelector(".ocp-drawer__soul-schema-status");
    const deploymentStatus = container.querySelector(".ocp-drawer__soul-deployment-status");
    const instanceList = container.querySelector(".ocp-drawer__instance-list");
    const featureList = container.querySelector(".ocp-drawer__soul-feature-list");
    const projectGate = container.querySelector(".ocp-drawer__soul-project-gate");
    const createProject = container.querySelector(".ocp-drawer__soul-create-project");

    if (dbStatus) {
      dbStatus.textContent = status?.enabled
        ? `PocketBase ${db.connected ? "connected" : "unavailable"}: ${db.url || "not configured"}. ${db.connected ? "Sync prerequisites can be checked." : "Sync features remain disabled until the database is reachable."}`
        : "Soul Sync database features are disabled; OpenCode continues normally.";
    }
    if (deploymentStatus) {
      const stableText = deployment.stable_identity === false ? "unstable Docker hostname fallback" : "stable identity";
      const commit = deployment.git_commit ? ` Build ${deployment.git_commit}.` : "";
      deploymentStatus.textContent = `This instance: ${deployment.name || "unknown"} (${deployment.id || "unknown"}) · ${stableText}.${commit}`;
    }
    if (instanceList) {
      const deployments = Array.isArray(status?.deployments?.items) ? status.deployments.items : [];
      if (!status?.deployments?.registered && status?.deployments?.error) {
        instanceList.innerHTML = `<p class="ocp-drawer__field-detail">Instance heartbeat could not be written: ${escapeHtml(status.deployments.error)}</p>`;
      } else if (!deployments.length) {
        instanceList.innerHTML = `<p class="ocp-drawer__field-detail">No peer instances have checked in yet.</p>`;
      } else {
        instanceList.innerHTML = deployments.map((item) => {
          const meta = item.metadata || {};
          const isCurrent = item.deployment_id === deployment.id;
          const stable = meta.stable_identity !== false;
          const commit = meta.git_commit || "unknown build";
          const seen = formatRelativeTime(deploymentLastSeen(item));
          return `
            <div class="ocp-drawer__instance-row ${isCurrent ? "ocp-drawer__instance-row--current" : ""}">
              <span>
                <strong>${escapeHtml(item.name || item.deployment_id || "unknown")}${isCurrent ? " · this instance" : ""}</strong>
                <small>${escapeHtml(item.url || meta.url || "no URL recorded")} · ${escapeHtml(commit)} · seen ${escapeHtml(seen)}</small>
              </span>
              <em class="${stable ? "" : "ocp-drawer__sync-warn"}">${stable ? "stable" : "fix identity"}</em>
            </div>
          `;
        }).join("");
      }
    }
    if (schemaStatus) {
      if (!status?.enabled) {
        schemaStatus.textContent = "Schema checks skipped because database sync is disabled.";
      } else if (!db.connected) {
        schemaStatus.textContent = "Schema checks skipped until PocketBase is reachable.";
      } else if (status.schema_ready) {
        schemaStatus.textContent = `Schema initialized. Named spaces configured: ${status.named_space_count || 0}.`;
      } else {
        schemaStatus.textContent = "Schema not initialized. Sync modules remain safely disabled.";
      }
    }
    if (featureList) {
      const features = status?.features || {};
      featureList.innerHTML = Object.entries(features).map(([key, value]) => `
        <div class="ocp-drawer__config-row">
          <span class="ocp-drawer__config-copy">
            <strong>${escapeHtml(key.replace(/_/g, " "))}</strong>
            <small>${escapeHtml(value)}</small>
          </span>
        </div>
      `).join("") || `<p class="ocp-drawer__field-detail">No synced features reported yet.</p>`;
    }
    if (projectGate) {
      if (!db.connected) {
        projectGate.textContent = "Create Synced Project is safely disabled because it requires PocketBase connection and at least one named space.";
      } else if (!status.schema_ready) {
        projectGate.textContent = "Create Synced Project is safely disabled until the Soul Sync schema is initialized.";
      } else if (!status.named_space_count) {
        projectGate.textContent = "Create Synced Project is safely disabled until at least one Named Space exists.";
      } else {
        projectGate.textContent = "Synced Project prerequisites are ready. Creation UI is coming next.";
      }
    }
    if (createProject) {
      createProject.disabled = true;
      createProject.title = db.connected
        ? "Next step: initialize Soul Sync schema and create a named space."
        : "Requires PocketBase connection and at least one named space.";
    }
  }

  async function setupSoulSyncControls(container) {
    try {
      const status = await fetchSoulStatus();
      renderSoulStatus(container, status);
      const root = document.getElementById("opencode-plus-drawer");
      if (root) updateInstanceBadge(root, status);
    } catch (error) {
      const dbStatus = container.querySelector(".ocp-drawer__soul-db-status");
      if (dbStatus) dbStatus.textContent = `Soul Sync status unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function setupHiddenSettingsControls(container) {
    const autoAccept = container.querySelector(".ocp-drawer__hidden-auto-accept");
    const detail = container.querySelector(".ocp-drawer__hidden-config-detail");
    if (!autoAccept) return;

    try {
      const response = await fetchOpenCodeConfig();
      autoAccept.checked = Boolean(response?.config?.auto_accept_permissions);
      if (autoAccept.checked) syncOpenCodeAutoAcceptPreference(true);
      if (detail) detail.textContent = `Config file: ${response?.config?.config_file || "OpenCode config"}. Restart OpenCode for server-loaded config changes to fully apply.`;
      autoAccept.disabled = false;
    } catch (error) {
      if (detail) detail.textContent = `OpenCode config unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }

    autoAccept.addEventListener("change", async () => {
      autoAccept.disabled = true;
      if (detail) detail.textContent = "Saving OpenCode permission config...";
      try {
        const response = await updateOpenCodeConfig({ auto_accept_permissions: autoAccept.checked });
        autoAccept.checked = Boolean(response?.config?.auto_accept_permissions);
        syncOpenCodeAutoAcceptPreference(autoAccept.checked);
        if (detail) detail.textContent = "Saved. Restart OpenCode for server-loaded config changes to fully apply.";
      } catch (error) {
        autoAccept.checked = !autoAccept.checked;
        if (detail) detail.textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        autoAccept.disabled = false;
      }
    });
  }

  function mountStatusLabel(status) {
    return String(status || "disconnected").replace(/_/g, " ");
  }

  function mountManagerMarkup(mode = "all") {
    const showProviders = mode === "all" || mode === "providers";
    const showLinks = mode === "all" || mode === "links";
    return `
      <p class="ocp-drawer__modal-intro">${showProviders && !showLinks ? "Connect reusable storage accounts and servers." : "Map connected storage into this workspace."}</p>
      ${showProviders ? `
      <div class="ocp-drawer__system-section">
        <h4>Storage Providers</h4>
        <div class="ocp-drawer__credential-form ocp-drawer__provider-form">
          <label title="A friendly name for this reusable account or server. This name appears in Workspace Links.">
            <span>Provider name</span>
            <input class="ocp-drawer__field ocp-drawer__provider-name" type="text" placeholder="e.g. 'gdrive' or 'production-server'" title="A friendly name for this reusable account or server. This name appears in Workspace Links.">
          </label>
          <label title="The kind of storage connection to save. Provider-specific fields appear below.">
            <span>Type</span>
            <select class="ocp-drawer__field ocp-drawer__provider-type" title="The kind of storage connection to save. Provider-specific fields appear below.">
              <option value="google_drive">Google Drive</option>
              <option value="ssh">SSH/SFTP</option>
              <option value="smb">SMB</option>
            </select>
          </label>
          <label data-provider-field="host" title="Server hostname or IP address for this storage provider. Do not include a folder path here.">
            <span>Host</span>
            <input class="ocp-drawer__field ocp-drawer__provider-host" type="text" placeholder="server.local" title="Server hostname or IP address for this storage provider. Do not include a folder path here.">
          </label>
          <p class="ocp-drawer__field-detail ocp-drawer__provider-detail"></p>
          <div class="ocp-drawer__credential-form ocp-drawer__provider-google-connect">
            <div class="ocp-drawer__field-detail ocp-drawer__mount-google-steps">
              <strong>Connect steps</strong>
              <span>1. On your Device, install rclone if needed: <a href="https://rclone.org/downloads/" target="_blank" rel="noopener noreferrer">rclone downloads</a>.</span>
              <span>2. Run this in Terminal or PowerShell: <code>rclone authorize "drive"</code></span>
              <span>3. A Google login page opens. Sign in and allow access.</span>
              <span>4. Copy the JSON block rclone prints, then paste it below.</span>
              <span>Token-based Google Drive providers are manual-only: Workspace Links copy files locally only when you click <strong>Sync</strong>. They do not live-mount or auto-sync in the background.</span>
              <span>If you see Google API quota errors, create your own Google OAuth Client ID/Secret and authorize with <code>rclone authorize "drive" CLIENT_ID CLIENT_SECRET</code>.</span>
            </div>
            <label title="Optional Google OAuth client ID. Only needed if the shared rclone Google app hits quota limits.">
              <span>Google OAuth Client ID (optional)</span>
              <input class="ocp-drawer__field ocp-drawer__provider-google-client-id" type="text" autocomplete="off" placeholder="Only needed if rclone default quota is exceeded" title="Optional Google OAuth client ID. Only needed if the shared rclone Google app hits quota limits.">
            </label>
            <label title="Optional Google OAuth client secret matching the client ID used to generate the token.">
              <span>Google OAuth Client Secret (optional)</span>
              <input class="ocp-drawer__field ocp-drawer__provider-google-client-secret" type="password" autocomplete="off" title="Optional Google OAuth client secret matching the client ID used to generate the token.">
            </label>
            <label title="Paste the full JSON token printed by rclone authorize. This connects the Google Drive account to this provider. Token-based Google Drive links are manual Sync only.">
              <span>Authorization token JSON</span>
              <textarea class="ocp-drawer__field ocp-drawer__provider-google-token" autocomplete="off" spellcheck="false" placeholder='{"access_token":"...","refresh_token":"..."}' title="Paste the full JSON token printed by rclone authorize. This connects the Google Drive account to this provider. Token-based Google Drive links are manual Sync only."></textarea>
            </label>
          </div>
          <label data-provider-field="port" title="Network port for SSH/SFTP. Leave blank to use the default port 22.">
            <span>Port</span>
            <input class="ocp-drawer__field ocp-drawer__provider-port" type="text" placeholder="22" title="Network port for SSH/SFTP. Leave blank to use the default port 22.">
          </label>
          <label data-provider-field="username" title="Username for the storage account or server login.">
            <span>Username</span>
            <input class="ocp-drawer__field ocp-drawer__provider-username" type="text" autocomplete="off" title="Username for the storage account or server login.">
          </label>
          <label data-provider-field="password" title="Password for the storage account or server login. Leave blank if using an SSH private key.">
            <span>Password</span>
            <input class="ocp-drawer__field ocp-drawer__provider-password" type="password" autocomplete="off" title="Password for the storage account or server login. Leave blank if using an SSH private key.">
          </label>
          <label data-provider-field="private_key" title="Optional SSH private key for SSH/SFTP providers. Use this instead of, or in addition to, a password.">
            <span>Private key</span>
            <textarea class="ocp-drawer__field ocp-drawer__provider-private-key" autocomplete="off" spellcheck="false" placeholder="Optional SSH private key" title="Optional SSH private key for SSH/SFTP providers. Use this instead of, or in addition to, a password."></textarea>
          </label>
          <div class="ocp-drawer__button-row">
            <button type="button" class="ocp-drawer__button ocp-drawer__provider-save">Save Storage Provider</button>
          </div>
          <p class="ocp-drawer__field-detail ocp-drawer__provider-save-detail">Storage providers save reusable account/server details only.</p>
        </div>
        <div class="ocp-drawer__provider-list">Loading providers...</div>
      </div>
      ` : ""}
      ${showLinks ? `
      <div class="ocp-drawer__system-section">
        <h4>Workspace Links</h4>
        <div class="ocp-drawer__credential-form ocp-drawer__mount-form">
          <input class="ocp-drawer__mount-edit-id" type="hidden">
          <label title="Choose one saved Storage Provider. The link will use that provider's saved account/server details.">
            <span>Storage provider</span>
            <select class="ocp-drawer__field ocp-drawer__mount-provider-select" title="Choose one saved Storage Provider. The link will use that provider's saved account/server details."></select>
          </label>
          <label title="Folder/path inside the selected provider. Examples: Google Drive folder 'opencode-plus' or SSH path '/home/robert/project'.">
            <span>Remote folder/path</span>
            <input class="ocp-drawer__field ocp-drawer__mount-path" type="text" placeholder="opencode-plus or /home/robert/project" title="Folder/path inside the selected provider. Examples: Google Drive folder 'opencode-plus' or SSH path '/home/robert/project'.">
          </label>
          <label title="Local folder name created under this workspace's mounts folder. Use a simple folder name, not a full path.">
            <span>Local workspace folder</span>
            <input class="ocp-drawer__field ocp-drawer__mount-name" type="text" placeholder="work-files" title="Local folder name created under this workspace's mounts folder. Use a simple folder name, not a full path.">
          </label>
          <label data-mount-field="sync_mode" class="ocp-drawer__mount-field--hidden" title="Google Drive can be mounted live when the container has FUSE permissions, or copied manually as a fallback.">
            <span>Google Drive mode</span>
            <select class="ocp-drawer__field ocp-drawer__mount-sync-mode" title="Google Drive can be mounted live when the container has FUSE permissions, or copied manually as a fallback.">
              <option value="mount">Live mount</option>
              <option value="copy">Manual copy only</option>
            </select>
          </label>
          <p class="ocp-drawer__field-detail">Created under <code>${escapeHtml(currentOpenCodeDirectory())}/mounts</code>.</p>
          <label class="ocp-drawer__hidden-toggle" title="When enabled, agents should treat this linked storage as read-only where supported.">
            <input class="ocp-drawer__mount-read-only" type="checkbox" checked title="When enabled, agents should treat this linked storage as read-only where supported.">
            <span><strong>Read-only</strong><small>Recommended until you are ready for agents to write to this remote.</small></span>
          </label>
          <label class="ocp-drawer__hidden-toggle" title="Automatically retry this Workspace Link later if the provider or network is temporarily unavailable.">
            <input class="ocp-drawer__mount-auto-reconnect" type="checkbox" checked title="Automatically retry this Workspace Link later if the provider or network is temporarily unavailable.">
            <span><strong>Auto-reconnect</strong><small>Retry unreachable SSH/SMB links later. Disabled for token-based Google Drive manual Sync.</small></span>
          </label>
          <div class="ocp-drawer__button-row">
            <button type="button" class="ocp-drawer__button ocp-drawer__mount-save">Save Workspace Link</button>
            <button type="button" class="ocp-drawer__button ocp-drawer__mount-cancel-edit ocp-drawer__mount-field--hidden">Cancel Edit</button>
          </div>
          <p class="ocp-drawer__field-detail ocp-drawer__mount-save-detail">Choose a storage provider first.</p>
        </div>
        <div class="ocp-drawer__mount-list">Loading mounts...</div>
      </div>
      ` : ""}
    `;
  }

  function renderMountList(container, mounts) {
    const list = container.querySelector(".ocp-drawer__mount-list");
    if (!list) return;
    if (!Array.isArray(mounts) || mounts.length === 0) {
      list.innerHTML = `<p class="ocp-drawer__empty-config">No file mounts configured yet.</p>`;
      return;
    }
    list.innerHTML = mounts.map((mount) => {
      const state = mount.state || {};
      const remoteFolder = mount.remote?.path || mount.remote?.share || "";
      const detail = state.last_error
        ? escapeHtml(shorten(state.last_error, 180))
        : `<small>Storage provider folder: ${escapeHtml(remoteFolder || "(root)")}</small><small>Local workspace folder: ${escapeHtml(mount.mount_path || "")}</small>`;
      const nextRetry = state.next_retry_at ? `<small>Next retry: ${escapeHtml(state.next_retry_at)}</small>` : "";
      const isGoogleDrive = mount.type === "google_drive";
      const isGoogleDriveCopy = isGoogleDrive && mount.options?.sync_mode === "copy";
      const connectLabel = isGoogleDriveCopy ? "Sync" : "Connect";
      const disconnectButton = isGoogleDriveCopy ? "" : `<button type="button" class="ocp-drawer__button ocp-drawer__mount-action" data-action="disconnect">Disconnect</button>`;
      return `
        <div class="ocp-drawer__config-row ocp-drawer__mount-row" data-mount-id="${escapeHtml(mount.id)}">
          <span class="ocp-drawer__config-copy">
            <strong>${escapeHtml(mount.name || mount.id)} · ${escapeHtml(mount.type || "mount")} · ${escapeHtml(mountStatusLabel(state.status))}</strong>
            ${detail}
            ${nextRetry}
          </span>
          <div class="ocp-drawer__button-row">
            <button type="button" class="ocp-drawer__button ocp-drawer__mount-action" data-action="test">Test</button>
            <button type="button" class="ocp-drawer__button ocp-drawer__mount-action" data-action="connect">${connectLabel}</button>
            ${disconnectButton}
            <button type="button" class="ocp-drawer__button ocp-drawer__mount-edit">Edit</button>
            <button type="button" class="ocp-drawer__button ocp-drawer__button--danger ocp-drawer__mount-delete">Delete</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderStorageProviders(container, providers) {
    const list = container.querySelector(".ocp-drawer__provider-list");
    const select = container.querySelector(".ocp-drawer__mount-provider-select");
    if (select) {
      if (!Array.isArray(providers) || providers.length === 0) {
        select.innerHTML = `<option value="">No storage providers configured</option>`;
      } else {
        select.innerHTML = providers.map((provider) => `<option value="${escapeHtml(provider.id)}" data-provider-type="${escapeHtml(provider.type)}">${escapeHtml(provider.name)} · ${escapeHtml(provider.type)}</option>`).join("");
      }
    }
    if (!list) return;
    if (!Array.isArray(providers) || providers.length === 0) {
      list.innerHTML = `<p class="ocp-drawer__empty-config">No storage providers configured yet.</p>`;
      return;
    }
    list.innerHTML = providers.map((provider) => `
      <div class="ocp-drawer__config-row ocp-drawer__provider-row" data-provider-id="${escapeHtml(provider.id)}">
        <span class="ocp-drawer__config-copy">
          <strong>${escapeHtml(provider.name)} · ${escapeHtml(provider.type)}</strong>
          <small>${escapeHtml(provider.remote?.host || provider.remote?.rclone_remote || provider.remote?.share || "Connected provider")}</small>
        </span>
        <div class="ocp-drawer__button-row">
          <button type="button" class="ocp-drawer__button ocp-drawer__button--danger ocp-drawer__provider-delete">Delete</button>
        </div>
      </div>
    `).join("");
  }

  async function refreshStorageProviders(container) {
    const list = container.querySelector(".ocp-drawer__provider-list");
    try {
      const response = await fetchStorageProviders();
      const providers = response.providers || [];
      renderStorageProviders(container, providers);
      updateWorkspaceLinkProviderFields(container);
      return providers;
    } catch (error) {
      if (list) list.innerHTML = `<p class="ocp-drawer__empty-config">Storage providers unavailable: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
      return [];
    }
  }

  function beginWorkspaceLinkEdit(container, mount) {
    if (!mount) return;
    const editId = container.querySelector(".ocp-drawer__mount-edit-id");
    const nameInput = container.querySelector(".ocp-drawer__mount-name");
    const pathInput = container.querySelector(".ocp-drawer__mount-path");
    const readOnly = container.querySelector(".ocp-drawer__mount-read-only");
    const autoReconnect = container.querySelector(".ocp-drawer__mount-auto-reconnect");
    const syncMode = container.querySelector(".ocp-drawer__mount-sync-mode");
    const saveButton = container.querySelector(".ocp-drawer__mount-save");
    const cancelButton = container.querySelector(".ocp-drawer__mount-cancel-edit");
    if (editId) editId.value = mount.id || "";
    if (nameInput) nameInput.value = mount.name || "";
    if (pathInput) pathInput.value = mount.remote?.path || mount.remote?.share || "";
    if (readOnly) readOnly.checked = Boolean(mount.options?.read_only);
    if (autoReconnect) autoReconnect.checked = Boolean(mount.options?.auto_reconnect);
    if (syncMode) syncMode.value = mount.options?.sync_mode || "mount";
    if (saveButton) saveButton.textContent = "Update Workspace Link";
    cancelButton?.classList.remove("ocp-drawer__mount-field--hidden");
    const detail = container.querySelector(".ocp-drawer__mount-save-detail");
    if (detail) detail.textContent = `Editing ${mount.name || mount.id}. Update the provider folder or local workspace folder, then save.`;
    updateWorkspaceLinkProviderFields(container);
  }

  function clearWorkspaceLinkEdit(container) {
    const editId = container.querySelector(".ocp-drawer__mount-edit-id");
    if (editId) editId.value = "";
    const saveButton = container.querySelector(".ocp-drawer__mount-save");
    if (saveButton) saveButton.textContent = "Save Workspace Link";
    container.querySelector(".ocp-drawer__mount-cancel-edit")?.classList.add("ocp-drawer__mount-field--hidden");
  }

  async function refreshMounts(container) {
    const list = container.querySelector(".ocp-drawer__mount-list");
    try {
      const response = await fetchMounts();
      const mounts = response.mounts || [];
      renderMountList(container, mounts);
      return mounts;
    } catch (error) {
      if (list) list.innerHTML = `<p class="ocp-drawer__empty-config">Mount status unavailable: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
      return [];
    }
  }

  async function refreshMountsUntilSettled(container, id) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const mounts = await refreshMounts(container);
      const mount = mounts.find((item) => item.id === id);
      const status = mount?.state?.status || "";
      if (status && status !== "connecting") return;
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
    await refreshMounts(container);
  }

  function setMountFieldVisible(container, field, visible) {
    container.querySelector(`[data-mount-field='${field}']`)?.classList.toggle("ocp-drawer__mount-field--hidden", !visible);
  }

  function setProviderFieldVisible(container, field, visible) {
    container.querySelector(`[data-provider-field='${field}']`)?.classList.toggle("ocp-drawer__mount-field--hidden", !visible);
  }

  function updateStorageProviderFields(container) {
    const type = container.querySelector(".ocp-drawer__provider-type")?.value || "google_drive";
    const hostLabel = container.querySelector("[data-provider-field='host'] span");
    const hostInput = container.querySelector(".ocp-drawer__provider-host");
    const googleConnect = container.querySelector(".ocp-drawer__provider-google-connect");
    const detail = container.querySelector(".ocp-drawer__provider-detail");
    setProviderFieldVisible(container, "host", type !== "google_drive");
    setProviderFieldVisible(container, "port", type === "ssh");
    setProviderFieldVisible(container, "username", type === "ssh" || type === "smb");
    setProviderFieldVisible(container, "password", type === "ssh" || type === "smb");
    setProviderFieldVisible(container, "private_key", type === "ssh");
    googleConnect?.classList.toggle("ocp-drawer__mount-field--hidden", type !== "google_drive");
    if (type === "smb") {
      if (hostLabel) hostLabel.textContent = "SMB host";
      if (hostInput) hostInput.placeholder = "nas.local";
      if (detail) detail.textContent = "Save the SMB server/account here. Choose the share path in Workspace Links.";
    } else if (type === "ssh") {
      if (hostLabel) hostLabel.textContent = "Host";
      if (hostInput) hostInput.placeholder = "server.local";
      if (detail) detail.textContent = "Save the SSH/SFTP server here. Choose the remote folder in Workspace Links.";
    } else if (detail) {
      detail.textContent = "Save the Google Drive account here. Choose the Drive folder in Workspace Links.";
    }
  }

  function updateWorkspaceLinkProviderFields(container) {
    const providerSelect = container.querySelector(".ocp-drawer__mount-provider-select");
    const type = providerSelect?.selectedOptions?.[0]?.dataset?.providerType || "";
    const autoReconnect = container.querySelector(".ocp-drawer__mount-auto-reconnect");
    const syncMode = container.querySelector(".ocp-drawer__mount-sync-mode");
    const mode = syncMode?.value || "mount";
    const detail = container.querySelector(".ocp-drawer__mount-save-detail");
    setMountFieldVisible(container, "sync_mode", type === "google_drive");
    if (!autoReconnect) return;
    if (type === "google_drive") {
      autoReconnect.disabled = mode === "copy";
      if (mode === "copy") autoReconnect.checked = false;
      if (detail && !container.querySelector(".ocp-drawer__mount-edit-id")?.value) {
        detail.textContent = mode === "copy"
          ? "Manual copy only runs when you click Sync. It does not live-mount or auto-sync."
          : "Live mount makes Google Drive appear as a local folder. It requires container FUSE/SYS_ADMIN permissions.";
      }
    } else {
      autoReconnect.disabled = false;
      if (detail && !container.querySelector(".ocp-drawer__mount-edit-id")?.value) {
        detail.textContent = type ? "Save the workspace link, then use Test or Connect below." : "Choose a storage provider first.";
      }
    }
  }

  function updateMountProviderFields(container) {
    const type = container.querySelector(".ocp-drawer__mount-type")?.value || "ssh";
    const hostLabel = container.querySelector("[data-mount-field='host'] span");
    const hostInput = container.querySelector(".ocp-drawer__mount-host");
    const pathLabel = container.querySelector("[data-mount-field='path'] span");
    const pathInput = container.querySelector(".ocp-drawer__mount-path");
    const portInput = container.querySelector(".ocp-drawer__mount-port");
    const providerDetail = container.querySelector(".ocp-drawer__mount-provider-detail");
    const googleConnect = container.querySelector(".ocp-drawer__mount-google-connect");
    const detail = container.querySelector(".ocp-drawer__mount-save-detail");

    setMountFieldVisible(container, "host", true);
    setMountFieldVisible(container, "path", true);
    setMountFieldVisible(container, "port", type === "ssh");
    setMountFieldVisible(container, "username", type === "ssh" || type === "smb");
    setMountFieldVisible(container, "password", type === "ssh" || type === "smb");
    setMountFieldVisible(container, "private_key", type === "ssh");
    googleConnect?.classList.toggle("ocp-drawer__mount-field--hidden", type !== "google_drive");

    if (type === "google_drive") {
      if (hostLabel) hostLabel.textContent = "Google Drive Account";
      if (hostInput) hostInput.placeholder = "gdrive";
      if (pathLabel) pathLabel.textContent = "Remote Folder";
      if (pathInput) pathInput.placeholder = "Projects/OpenCode";
      if (providerDetail) providerDetail.textContent = "Use an existing connected account name, or connect a new account below.";
      if (detail) detail.textContent = "Google Drive copies files from the remote folder into the local folder above. No Docker/FUSE mount is required.";
    } else if (type === "smb") {
      if (hostInput) hostInput.disabled = false;
      if (hostLabel) hostLabel.textContent = "SMB host or rclone remote";
      if (hostInput) hostInput.placeholder = "nas.local or smbremote";
      if (pathLabel) pathLabel.textContent = "Share/path";
      if (pathInput) pathInput.placeholder = "share/path";
      if (providerDetail) providerDetail.textContent = "";
      if (detail) detail.textContent = "SMB mounts use rclone when a remote name is provided; direct SMB probing checks port 445.";
    } else {
      if (hostInput) hostInput.disabled = false;
      if (hostLabel) hostLabel.textContent = "Host";
      if (hostInput) hostInput.placeholder = "server.local";
      if (pathLabel) pathLabel.textContent = "Remote path";
      if (pathInput) pathInput.placeholder = "/home/robert/project";
      if (portInput && !portInput.value) portInput.placeholder = "22";
      if (providerDetail) providerDetail.textContent = "";
      if (detail) detail.textContent = "SSH/SFTP mounts use SSHFS and can authenticate with a password or private key.";
    }
  }

  async function refreshGoogleDriveAccounts(container) {
    const hostInput = container.querySelector(".ocp-drawer__mount-host");
    const detail = container.querySelector(".ocp-drawer__mount-provider-detail");
    try {
      const response = await fetchGoogleDriveAccounts();
      const accounts = Array.isArray(response.accounts) ? response.accounts : [];
      if (accounts.length > 0) {
        if (hostInput && !hostInput.value) hostInput.value = accounts[0];
        if (detail) detail.textContent = `Connected Google Drive account${accounts.length === 1 ? "" : "s"}: ${accounts.join(", ")}`;
      }
    } catch (error) {
      if (detail) detail.textContent = `Google Drive account status unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function setupMountManagerControls(container) {
    refreshMounts(container);
    refreshStorageProviders(container);
    updateStorageProviderFields(container);
    refreshGoogleDriveAccounts(container);
    container.querySelector(".ocp-drawer__provider-type")?.addEventListener("change", () => updateStorageProviderFields(container));
    container.querySelector(".ocp-drawer__mount-provider-select")?.addEventListener("change", () => updateWorkspaceLinkProviderFields(container));
    container.querySelector(".ocp-drawer__mount-sync-mode")?.addEventListener("change", () => updateWorkspaceLinkProviderFields(container));
    container.querySelector(".ocp-drawer__provider-save")?.addEventListener("click", async () => {
      const detail = container.querySelector(".ocp-drawer__provider-save-detail");
      const type = container.querySelector(".ocp-drawer__provider-type")?.value || "google_drive";
      const name = container.querySelector(".ocp-drawer__provider-name")?.value || "";
      const host = container.querySelector(".ocp-drawer__provider-host")?.value || "";
      const port = container.querySelector(".ocp-drawer__provider-port")?.value || "";
      const username = container.querySelector(".ocp-drawer__provider-username")?.value || "";
      const password = container.querySelector(".ocp-drawer__provider-password")?.value || "";
      const privateKey = container.querySelector(".ocp-drawer__provider-private-key")?.value || "";
      const token = container.querySelector(".ocp-drawer__provider-google-token")?.value || "";
      const clientId = container.querySelector(".ocp-drawer__provider-google-client-id")?.value || "";
      const clientSecret = container.querySelector(".ocp-drawer__provider-google-client-secret")?.value || "";
      const remote = {};
      const secret = {};
      let providerName = name;
      try {
        if (type === "google_drive") {
          providerName = name || "gdrive";
          if (token.trim()) {
            if (detail) detail.textContent = "Connecting Google Drive account...";
            const response = await connectGoogleDriveAccount({ name: providerName, token, clientId, clientSecret });
            providerName = response.account || providerName;
          }
          remote.rclone_remote = providerName;
          remote.host = providerName;
        } else if (type === "ssh") {
          remote.host = host;
          remote.port = port;
          remote.username = username;
          secret.username = username;
          secret.password = password;
          secret.private_key = privateKey;
        } else if (type === "smb") {
          remote.host = host;
          remote.username = username;
          secret.username = username;
          secret.password = password;
        }
        if (detail) detail.textContent = "Saving storage provider...";
        await createStorageProvider({ name: providerName, type, remote, secret });
        container.querySelector(".ocp-drawer__provider-google-token").value = "";
        container.querySelector(".ocp-drawer__provider-google-client-secret").value = "";
        if (detail) detail.textContent = "Storage provider saved.";
        await refreshStorageProviders(container);
      } catch (error) {
        if (detail) detail.textContent = `Provider save failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    container.querySelector(".ocp-drawer__mount-save")?.addEventListener("click", async () => {
      const detail = container.querySelector(".ocp-drawer__mount-save-detail");
      const providerSelect = container.querySelector(".ocp-drawer__mount-provider-select");
      const providerId = providerSelect?.value || "";
      const type = providerSelect?.selectedOptions?.[0]?.dataset?.providerType || "";
      const name = container.querySelector(".ocp-drawer__mount-name")?.value || "";
      const remotePath = container.querySelector(".ocp-drawer__mount-path")?.value || "";
      const readOnly = Boolean(container.querySelector(".ocp-drawer__mount-read-only")?.checked);
      const syncMode = type === "google_drive" ? (container.querySelector(".ocp-drawer__mount-sync-mode")?.value || "mount") : "";
      const autoReconnect = type === "google_drive" && syncMode === "copy" ? false : Boolean(container.querySelector(".ocp-drawer__mount-auto-reconnect")?.checked);
      const editId = container.querySelector(".ocp-drawer__mount-edit-id")?.value || "";
      const remote = { path: remotePath, share: remotePath };
      if (!providerId) {
        if (detail) detail.textContent = "Save a storage provider first.";
        return;
      }
      if (detail) detail.textContent = "Saving workspace link...";
      try {
        const payload = {
          name,
          type,
          provider_id: providerId,
          workspace_root: currentOpenCodeDirectory(),
          mount_name: name,
          remote,
          options: { read_only: readOnly, auto_connect: false, auto_reconnect: autoReconnect, sync_mode: syncMode },
          secret: {},
        };
        if (editId) {
          await updateMount(editId, payload);
        } else {
          await createMount(payload);
        }
        clearWorkspaceLinkEdit(container);
        if (detail) detail.textContent = editId ? "Workspace link updated." : "Workspace link saved. Use Sync or Connect below.";
        await refreshMounts(container);
      } catch (error) {
        if (detail) detail.textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    container.querySelector(".ocp-drawer__mount-cancel-edit")?.addEventListener("click", () => {
      clearWorkspaceLinkEdit(container);
      container.querySelector(".ocp-drawer__mount-save-detail").textContent = "Choose a storage provider first.";
    });
    container.addEventListener("click", async (event) => {
      const providerRow = event.target?.closest?.(".ocp-drawer__provider-row");
      if (providerRow && event.target.closest?.(".ocp-drawer__provider-delete")) {
        if (!window.confirm("Delete this storage provider? Workspace links will not be deleted.")) return;
        try {
          await deleteStorageProvider(providerRow.dataset.providerId);
          await refreshStorageProviders(container);
        } catch (error) {
          window.alert(`Provider delete failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      const row = event.target?.closest?.(".ocp-drawer__mount-row");
      if (!row) return;
      const id = row.dataset.mountId;
      if (!id) return;
      const actionButton = event.target.closest?.(".ocp-drawer__mount-action");
      const editButton = event.target.closest?.(".ocp-drawer__mount-edit");
      const deleteButton = event.target.closest?.(".ocp-drawer__mount-delete");
      try {
        if (editButton) {
          const mounts = await refreshMounts(container);
          beginWorkspaceLinkEdit(container, mounts.find((item) => item.id === id));
          return;
        } else if (deleteButton) {
          if (!window.confirm("Delete this mount configuration? The remote files will not be deleted.")) return;
          await deleteMount(id);
        } else if (actionButton) {
          const action = actionButton.dataset.action;
          const label = action === "test" ? "Testing Workspace Link" : action === "connect" ? (actionButton.textContent.trim() || "Running Workspace Link") : "Updating Workspace Link";
          const overlay = showWorkspaceLinkOverlay(document.querySelector("#opencode-plus-drawer"), label, action === "test" ? "Checking the provider and remote folder..." : "Starting the workspace link action...");
          const result = await mountAction(id, action);
          await refreshMountsUntilSettled(container, id);
          if (action === "test") {
            const status = result?.status || {};
            const ok = result?.ok || status.status === "connected" || status.status === "synced";
            finishWorkspaceLinkOverlay(overlay, ok ? "Test Passed" : "Test Failed", ok ? "The provider and remote folder are reachable." : (status.last_error || `Status: ${mountStatusLabel(status.status || "error")}`));
          } else {
            finishWorkspaceLinkOverlay(overlay, "Action Complete", "Workspace link status has been refreshed.");
          }
          return;
        } else {
          return;
        }
        await refreshMounts(container);
      } catch (error) {
        window.alert(`Mount action failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
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
    modal.classList.remove("ocp-drawer__modal--help");
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
    modal.classList.remove("ocp-drawer__modal--help");
    title.textContent = area.label;

    if (area.id === "restart") {
      body.innerHTML = restartConfigMarkup();
      setupRestartControls(body);
    } else if (area.id === "system") {
      body.innerHTML = systemConfigMarkup();
      setupSystemControls(root, body, settings);
    } else if (area.id === "gateway") {
      body.innerHTML = gatewayConfigMarkup();
      setupGatewayControls(body);
    } else if (area.id === "statusline") {
      body.innerHTML = `<p class="ocp-drawer__modal-intro">Enable or disable each statusline module. Provider gears open credentials and module-specific settings.</p><div class="ocp-drawer__module-list"></div>`;
      const moduleList = body.querySelector(".ocp-drawer__module-list");
      MODULES.forEach((module) => {
        moduleList.append(createModuleRow(module, settings, (selectedModule) => openModuleConfig(root, selectedModule)));
      });
    } else if (area.id === "hidden") {
      body.innerHTML = hiddenSettingsMarkup(settings);
      setupHiddenSettingsControls(body);
    } else if (area.id === "soul") {
      body.innerHTML = soulSyncMarkup();
      setupSoulSyncControls(body);
    } else if (area.id === "storage-providers") {
      body.innerHTML = mountManagerMarkup("providers");
      setupMountManagerControls(body);
    } else if (area.id === "workspace-links") {
      body.innerHTML = mountManagerMarkup("links");
      setupMountManagerControls(body);
    } else {
      body.innerHTML = `<p class="ocp-drawer__empty-config">No configuration is available for ${area.label} yet.</p>`;
    }

    modal.hidden = false;
    modal.querySelector(".ocp-drawer__modal-close").focus();
  }

  function openHelp(root) {
    const modal = root.querySelector(".ocp-drawer__modal");
    const title = modal.querySelector(".ocp-drawer__modal-title");
    const body = modal.querySelector(".ocp-drawer__modal-body");
    modal.classList.add("ocp-drawer__modal--help");
    title.textContent = "OpenCode Plus Help";
    body.innerHTML = `
      <div class="ocp-drawer__about">
        <p class="ocp-drawer__modal-intro">OpenCode Plus adds the fold-down controls, statusline provider usage chips, gateway controls, restart tools, and local quota integrations on top of OpenCode Server.</p>
        <dl class="ocp-drawer__about-list">
          <div>
            <dt>OpenCode Plus</dt>
            <dd>${escapeHtml(OPENCODE_PLUS_VERSION)}</dd>
          </div>
          <div>
            <dt>OpenCode</dt>
            <dd class="ocp-drawer__about-opencode-row">
              <span class="ocp-drawer__mini-spinner ocp-drawer__about-version-spinner" aria-hidden="true"></span>
              <span class="ocp-drawer__about-opencode-version">${escapeHtml(OPENCODE_VERSION)}</span>
              <button type="button" class="ocp-drawer__button ocp-drawer__button--compact ocp-drawer__about-changelog" hidden>Changelog</button>
              <button type="button" class="ocp-drawer__button ocp-drawer__button--compact ocp-drawer__about-update" hidden>Update Now</button>
            </dd>
          </div>
          <div>
            <dt>Repository</dt>
            <dd><a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">github.com/datbird/opencode-plus</a></dd>
          </div>
        </dl>
        <div class="ocp-drawer__about-console-wrap">
          <button type="button" class="ocp-drawer__button ocp-drawer__button--compact ocp-drawer__about-copy">Copy</button>
          <pre class="ocp-drawer__about-console"><span class="ocp-drawer__mini-spinner" aria-hidden="true"></span> $ loading support package versions...</pre>
        </div>
        <p class="ocp-drawer__field-detail">OpenCode Plus is an unofficial local enhancement layer. It is not part of, affiliated with, sponsored by, or endorsed by the upstream OpenCode project.</p>
      </div>
    `;
    modal.hidden = false;
    modal.querySelector(".ocp-drawer__modal-close").focus();
    Promise.allSettled([fetchGatewayInfo(), checkOpenCodeUpdate()])
      .then(([infoResult, checkResult]) => {
        const info = infoResult.status === "fulfilled" ? infoResult.value : null;
        body.querySelector(".ocp-drawer__about-version-spinner")?.remove();
        const version = body.querySelector(".ocp-drawer__about-opencode-version");
        if (version) {
          version.textContent = info?.opencode_version || (infoResult.status === "rejected" ? `unavailable: ${infoResult.reason instanceof Error ? infoResult.reason.message : String(infoResult.reason)}` : "unknown");
        }
        const consoleView = body.querySelector(".ocp-drawer__about-console");
        if (consoleView) {
          consoleView.textContent = info ? formatSupportConsole(info) : `$ support info unavailable: ${infoResult.reason instanceof Error ? infoResult.reason.message : String(infoResult.reason)}`;
        }

        const updateButton = body.querySelector(".ocp-drawer__about-update");
        const changelogButton = body.querySelector(".ocp-drawer__about-changelog");
        if (checkResult.status === "fulfilled") {
          const check = checkResult.value;
          if (version) {
            version.textContent = check.update_available
              ? formatOpenCodeVersionTransition(check.current_version || info?.opencode_version, check.latest_version)
              : `${check.current_version || info?.opencode_version || "unknown"} (current)`;
          }
          if (changelogButton) {
            changelogButton.hidden = !check.update_available || !check.changelog;
            changelogButton.onclick = () => openUpdateOverlayWithCheck(root, check);
          }
          if (updateButton) {
            updateButton.hidden = !check.update_available;
            updateButton.onclick = () => openUpdateOverlayWithCheck(root, check);
          }
        } else if (version) {
          version.textContent = `${version.textContent} (update check unavailable)`;
        }

        const copyButton = body.querySelector(".ocp-drawer__about-copy");
        if (copyButton && consoleView) {
          copyButton.onclick = async () => {
            const original = copyButton.textContent;
            try {
              await copyTextToClipboard(consoleView.textContent || "");
              copyButton.textContent = "Copied";
            } catch (error) {
              copyButton.textContent = "Copy failed";
            }
            window.setTimeout(() => copyButton.textContent = original, 1200);
          };
        }
      });
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
    root.querySelector(".ocp-drawer__handle-text").textContent = "OpenCode Plus";
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
    handle.innerHTML = `<span class="ocp-drawer__handle-dot"></span><span class="ocp-drawer__handle-text">OpenCode Plus</span><span class="ocp-drawer__handle-instance">...</span><span class="ocp-drawer__chevron">⌄</span>`;
    handle.addEventListener("click", () => setOpen(root, settings, !settings.open));
    enableHandleDrag(root, handle, settings);

    const panel = document.createElement("div");
    panel.className = "ocp-drawer__panel";
    panel.innerHTML = `
      <div class="ocp-drawer__header">
        <div>
          <div class="ocp-drawer__eyebrow">Enhancement Suite</div>
          <h2>OpenCode Plus Controls</h2>
          <div class="ocp-drawer__instance-badge">Instance <strong class="ocp-drawer__instance-name">checking...</strong></div>
        </div>
        <div class="ocp-drawer__header-actions">
          <button type="button" class="ocp-drawer__icon-button ocp-drawer__opencode-restart-header" aria-label="Restart OpenCode server" title="Restart OpenCode server">↻</button>
          <button type="button" class="ocp-drawer__help" aria-label="OpenCode Plus help" title="OpenCode Plus help">?</button>
          <button type="button" class="ocp-drawer__close" aria-label="Close OpenCode Plus controls" title="Close">X</button>
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
          <button type="button" class="ocp-drawer__close ocp-drawer__modal-close" aria-label="Close dialog" title="Close" data-modal-close>X</button>
        </div>
        <div class="ocp-drawer__modal-body"></div>
      </div>
    `;

    const configList = panel.querySelector(".ocp-drawer__config-list");
    CONFIG_AREAS.forEach((area) => {
      configList.append(createConfigAreaRow(area, (selectedArea) => openConfigArea(root, selectedArea, settings)));
    });

    panel.querySelector(".ocp-drawer__close").addEventListener("click", () => setOpen(root, settings, false));
    panel.querySelector(".ocp-drawer__help").addEventListener("click", () => openHelp(root));
    wireRestartButton(panel.querySelector(".ocp-drawer__opencode-restart-header"));
    modal.querySelectorAll("[data-modal-close]").forEach((element) => {
      element.addEventListener("click", () => closeModuleConfig(root));
    });
    root.append(panel, modal, handle);
    document.documentElement.append(root);
    fetchSoulStatus().then((status) => updateInstanceBadge(root, status)).catch(() => {
      const badge = root.querySelector(".ocp-drawer__instance-badge");
      if (badge) badge.title = "Instance status unavailable";
    });
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

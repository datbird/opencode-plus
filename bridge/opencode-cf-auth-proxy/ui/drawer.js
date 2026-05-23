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
  const SYNCED_SESSION_AUTO_DEBOUNCE_MS = 3 * 1000;
  const SYNCED_SESSION_AUTO_COOLDOWN_MS = 45 * 1000;
  const SYNCED_SESSION_SAFETY_SYNC_MS = 5 * 60 * 1000;
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
    { id: "soul", label: "Synchronization", description: "Share project folders across OpenCode instances; session sync will use the same foundation." },
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
    return Boolean(node.closest?.("#opencode-plus-drawer, #oc-webui-sidecar, .ocp-synced-project-sessions, .ocp-stale-thinking, .ocp-recovery-notice"));
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

  function setOpenCodePlusHeaderNotice(root, message, tone = "info") {
    const notice = root?.querySelector?.(".ocp-drawer__header-notice");
    if (!notice) return;
    notice.textContent = message || "";
    notice.hidden = !message;
    notice.dataset.tone = tone;
    updateDrawerPanelHeight(root);
  }

  function updateDrawerPanelHeight(root) {
    const panel = root?.querySelector?.(".ocp-drawer__panel");
    if (panel) root.style.setProperty("--ocp-drawer-panel-height", `${panel.offsetHeight}px`);
  }

  function withTimeout(promise, timeoutMs, label) {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
  }

  function scheduleOpenCodeViewRefreshAfterImport(root, sessionSync) {
    if (!Number(sessionSync?.imported || 0)) return;
    setOpenCodePlusHeaderNotice(root, "Sessions imported. Refreshing OpenCode view...", "success");
    window.setTimeout(() => window.location.reload(), 900);
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

  function maskSecretValue(value) {
    return String(value || "").replace(/[^\n]/g, "•");
  }

  function secretFieldValue(field) {
    return field?.dataset?.secretValue || "";
  }

  function rememberPlaceholder(field) {
    if (!field || field.dataset.defaultPlaceholder !== undefined) return;
    field.dataset.defaultPlaceholder = field.getAttribute("placeholder") || "";
  }

  function restorePlaceholder(field) {
    if (!field) return;
    rememberPlaceholder(field);
    field.setAttribute("placeholder", field.dataset.defaultPlaceholder || "");
  }

  function showSavedSecretPlaceholder(field) {
    if (!field) return;
    rememberPlaceholder(field);
    if (field.classList?.contains("ocp-drawer__masked-secret")) field.dataset.secretValue = "";
    field.value = "";
    field.setAttribute("placeholder", "•••••••• saved; leave blank to keep");
    showSavedSecretIndicator(field);
  }

  function showSavedSecretIndicator(field) {
    const label = field?.closest?.("label");
    if (!label) return;
    let indicator = label.querySelector(".ocp-drawer__saved-secret-indicator");
    if (!indicator) {
      indicator = document.createElement("small");
      indicator.className = "ocp-drawer__saved-secret-indicator";
      field.insertAdjacentElement("afterend", indicator);
    }
    indicator.textContent = "•••••••• saved; leave blank to keep";
    indicator.hidden = false;
    if (field.dataset.savedSecretListener !== "true") {
      field.dataset.savedSecretListener = "true";
      field.addEventListener("input", () => hideSavedSecretIndicator(field));
    }
  }

  function hideSavedSecretIndicator(field) {
    field?.closest?.("label")?.querySelector(".ocp-drawer__saved-secret-indicator")?.setAttribute("hidden", "");
  }

  function clearSecretField(field) {
    if (!field) return;
    field.dataset.secretValue = "";
    field.value = "";
    restorePlaceholder(field);
    hideSavedSecretIndicator(field);
  }

  function setupMaskedSecretFields(container) {
    container.querySelectorAll(".ocp-drawer__masked-secret").forEach((field) => {
      rememberPlaceholder(field);
      if (field.dataset.maskReady === "true") return;
      field.dataset.maskReady = "true";
      field.dataset.secretValue = "";
      field.addEventListener("beforeinput", (event) => {
        const current = field.dataset.secretValue || "";
        const start = field.selectionStart ?? field.value.length;
        const end = field.selectionEnd ?? start;
        let next = current;
        let cursor = start;
        if (event.inputType === "insertText" || event.inputType === "insertCompositionText") {
          next = current.slice(0, start) + (event.data || "") + current.slice(end);
          cursor = start + (event.data || "").length;
        } else if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
          next = current.slice(0, start) + "\n" + current.slice(end);
          cursor = start + 1;
        } else if (event.inputType === "deleteContentBackward") {
          next = start === end ? current.slice(0, Math.max(0, start - 1)) + current.slice(end) : current.slice(0, start) + current.slice(end);
          cursor = start === end ? Math.max(0, start - 1) : start;
        } else if (event.inputType === "deleteContentForward") {
          next = start === end ? current.slice(0, start) + current.slice(end + 1) : current.slice(0, start) + current.slice(end);
          cursor = start;
        } else {
          return;
        }
        event.preventDefault();
        field.dataset.secretValue = next;
        field.value = maskSecretValue(next);
        hideSavedSecretIndicator(field);
        field.setSelectionRange(cursor, cursor);
      });
      field.addEventListener("paste", (event) => {
        event.preventDefault();
        const pasted = event.clipboardData?.getData("text") || "";
        const current = field.dataset.secretValue || "";
        const start = field.selectionStart ?? field.value.length;
        const end = field.selectionEnd ?? start;
        const next = current.slice(0, start) + pasted + current.slice(end);
        field.dataset.secretValue = next;
        field.value = maskSecretValue(next);
        hideSavedSecretIndicator(field);
        const cursor = start + pasted.length;
        field.setSelectionRange(cursor, cursor);
      });
      field.addEventListener("drop", (event) => event.preventDefault());
    });
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
      if (decoded.startsWith("/")) return decoded;
      if (decoded.startsWith("root/")) return `/${decoded}`;
      return "/root/aiplayground";
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

  async function decorateSyncedProjectChrome() {
    let project = null;
    try {
      project = await currentSyncedProject();
    } catch {
      return;
    }
    document.querySelectorAll(".ocp-synced-project-rail-avatar").forEach((button) => {
      button.classList.remove("ocp-synced-project-rail-avatar");
      button.style.removeProperty("--ocp-synced-project-icon");
    });
    if (!project?.icon_url) return;
    const railButton = document.querySelector("aside button, nav button, [role='navigation'] button");
    if (railButton instanceof HTMLElement) {
      railButton.classList.add("ocp-synced-project-rail-avatar");
      railButton.style.setProperty("--ocp-synced-project-icon", `url("${project.icon_url}")`);
      railButton.title = project.name ? `${project.name} synced project` : "Synced project";
    }
  }

  function installSyncedProjectAvatarEnhancer() {
    if (window.__opencodePlusSyncedProjectAvatarInstalled) return;
    window.__opencodePlusSyncedProjectAvatarInstalled = true;
    let timer = 0;
    const schedule = (delay = 150) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => decorateSyncedProjectChrome().catch(() => {}), delay);
    };
    const observer = new MutationObserver(() => schedule(250));
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", () => schedule(0));
    window.addEventListener("focus", () => schedule(0));
    window.addEventListener("pageshow", () => schedule(0));
    schedule(0);
  }

  function syncedProjectSessionURL(project, session) {
    const base = (project?.open_url || `/${base64UrlEncode(project?.local_path || currentOpenCodeDirectory())}/session`).replace(/\/+$/, "");
    return session?.id ? `${base}/${encodeURIComponent(session.id)}` : base;
  }

  function syncedProjectSessionTitle(session) {
    return session?.title || session?.summary || session?.id || "Untitled session";
  }

  function syncedProjectSessionTime(session) {
    const value = session?.time?.updated || session?.time?.created || session?.updated || session?.created || "";
    if (typeof value === "number") {
      const timestamp = value > 1e12 ? value : value * 1000;
      return formatRelativeTime(new Date(timestamp).toISOString());
    }
    return formatRelativeTime(value);
  }

  function ensureSyncedProjectSessionPanel() {
    let panel = document.querySelector(".ocp-synced-project-sessions");
    if (panel) return panel;
    panel = document.createElement("aside");
    panel.className = "ocp-synced-project-sessions";
    panel.setAttribute("aria-label", "Synced project sessions");
    panel.innerHTML = `
      <div class="ocp-synced-project-sessions__header">
        <span><strong>Synced project</strong><small>Loading sessions...</small></span>
      </div>
      <div class="ocp-synced-project-sessions__list">Loading sessions...</div>
    `;
    document.documentElement.append(panel);
    return panel;
  }

  function visibleElementRect(element) {
    if (!(element instanceof HTMLElement) || isOwnUiNode(element)) return null;
    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return null;
    return rect;
  }

  function syncedProjectSidebarBounds() {
    const railRects = Array.from(document.querySelectorAll("button,a,[role='button'],div,span"))
      .map((element) => ({ element, rect: visibleElementRect(element) }))
      .filter((item) => item.rect && item.rect.left >= 0 && item.rect.left < 72 && item.rect.top > 36 && item.rect.width >= 20 && item.rect.width <= 48 && item.rect.height >= 20 && item.rect.height <= 48)
      .filter((item) => (item.element.textContent || "").trim() !== "+");
    const activeRailBottom = railRects.reduce((bottom, item) => Math.max(bottom, item.rect.bottom), 0);

    const verticalEdges = Array.from(document.querySelectorAll("body *"))
      .map(visibleElementRect)
      .filter((rect) => rect && rect.top < 90 && rect.bottom > window.innerHeight * 0.55 && rect.left > 250 && rect.left < 430 && rect.width <= 4)
      .map((rect) => rect.left)
      .sort((a, b) => a - b);
    const rightEdge = verticalEdges[0] || 366;
    const left = 88;
    const margin = 12;
    const top = Math.max(54, activeRailBottom ? activeRailBottom + margin : 54);
    return { left, top, width: Math.max(220, Math.min(260, rightEdge - left - margin)) };
  }

  function layoutSyncedProjectSessionPanel(panel) {
    if (!(panel instanceof HTMLElement) || window.matchMedia?.("(max-width: 720px)").matches) return;
    const bounds = syncedProjectSidebarBounds();
    panel.style.left = `${bounds.left}px`;
    panel.style.top = `${bounds.top}px`;
    panel.style.width = `${bounds.width}px`;
  }

  function removeSyncedProjectSessionPanel() {
    document.querySelector(".ocp-synced-project-sessions")?.remove();
  }

  async function refreshSyncedProjectSessionPanel(force = false) {
    let project = null;
    try {
      project = await currentSyncedProject();
    } catch {
      removeSyncedProjectSessionPanel();
      return;
    }
    if (!project) {
      removeSyncedProjectSessionPanel();
      return;
    }
    const hiddenKey = `ocp-synced-project-sessions-hidden:${project.local_path}`;
    if (!force && sessionStorage.getItem(hiddenKey) === "1") {
      removeSyncedProjectSessionPanel();
      return;
    }
    const panel = ensureSyncedProjectSessionPanel();
    layoutSyncedProjectSessionPanel(panel);
    const key = `${project.local_path}|${location.pathname}`;
    if (!force && panel.dataset.loadedFor === key) return;
    panel.dataset.loadedFor = key;
    panel.dataset.localPath = project.local_path || "";
    const heading = panel.querySelector(".ocp-synced-project-sessions__header span:first-child");
    const list = panel.querySelector(".ocp-synced-project-sessions__list");
    if (heading) heading.innerHTML = `<strong>${escapeHtml(project.name || "Synced project")}</strong><small>${escapeHtml(project.local_path || "")}</small>`;
    if (list) list.textContent = "Loading sessions...";
    try {
      const sessions = await fetchSyncedProjectSessions(project.local_path);
      if (!list) return;
      if (!sessions.length) {
        list.innerHTML = `<div class="ocp-synced-project-sessions__empty">No saved sessions for this synced project yet.</div>`;
        return;
      }
      list.innerHTML = sessions.map((session) => {
        const active = session.id && currentSessionId() === session.id;
        return `
          <button type="button" class="ocp-synced-project-sessions__row ${active ? "ocp-synced-project-sessions__row--active" : ""}" data-session-url="${escapeHtml(syncedProjectSessionURL(project, session))}">
            <strong>${escapeHtml(shorten(syncedProjectSessionTitle(session), 42))}</strong>
            <small>${escapeHtml(syncedProjectSessionTime(session))}</small>
          </button>
        `;
      }).join("");
    } catch (error) {
      if (list) list.innerHTML = `<div class="ocp-synced-project-sessions__empty">Sessions unavailable: ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
    }
  }

  function installSyncedProjectChromeEnhancer() {
    if (window.__opencodePlusSyncedProjectChromeInstalled) return;
    window.__opencodePlusSyncedProjectChromeInstalled = true;
    let timer = 0;
    let autoSyncTimer = 0;
    let lastAutoSyncAt = 0;
    let autoSyncInFlight = false;
    const schedule = (force = false, delay = 180) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        refreshSyncedProjectSessionPanel(force).then(() => {
          const panel = document.querySelector(".ocp-synced-project-sessions");
          if (panel) layoutSyncedProjectSessionPanel(panel);
        }).catch(() => {});
      }, delay);
    };
    const scheduleAutoSync = (force = false, delay = SYNCED_SESSION_AUTO_DEBOUNCE_MS) => {
      window.clearTimeout(autoSyncTimer);
      autoSyncTimer = window.setTimeout(async () => {
        if (autoSyncInFlight) return;
        const now = Date.now();
        if (!force && now - lastAutoSyncAt < SYNCED_SESSION_AUTO_COOLDOWN_MS) return;
        let project = null;
        try {
          project = await currentSyncedProject();
        } catch {
          return;
        }
        if (!project) return;
        autoSyncInFlight = true;
        try {
          await syncSyncedProjectSessions();
          lastAutoSyncAt = Date.now();
        } catch {
          // Opportunistic sync should never interrupt normal OpenCode usage.
        } finally {
          autoSyncInFlight = false;
        }
      }, delay);
    };
    const wrapHistory = (name) => {
      const original = history[name];
      if (typeof original !== "function") return;
      history[name] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        scheduleAutoSync(true, 800);
        schedule(false);
        return result;
      };
    };
    wrapHistory("pushState");
    wrapHistory("replaceState");
    document.addEventListener("click", (event) => {
      const row = event.target.closest?.(".ocp-synced-project-sessions__row");
      if (row) {
        const url = row.dataset.sessionUrl || "";
        if (url) window.location.href = url;
        return;
      }
      const refresh = event.target.closest?.(".ocp-synced-project-sessions__refresh");
      if (refresh) {
        const panel = refresh.closest(".ocp-synced-project-sessions");
        if (panel?.dataset.localPath) sessionStorage.removeItem(`ocp-synced-project-sessions-hidden:${panel.dataset.localPath}`);
        scheduleAutoSync(true, 0);
        schedule(true, 0);
        return;
      }
      const close = event.target.closest?.(".ocp-synced-project-sessions__close");
      if (close) {
        const panel = close.closest(".ocp-synced-project-sessions");
        if (panel?.dataset.localPath) sessionStorage.setItem(`ocp-synced-project-sessions-hidden:${panel.dataset.localPath}`, "1");
        removeSyncedProjectSessionPanel();
        return;
      }
      scheduleAutoSync(false);
      schedule(false, 300);
    });
    window.addEventListener("popstate", () => {
      scheduleAutoSync(true, 800);
      schedule(false);
    });
    window.addEventListener("hashchange", () => {
      scheduleAutoSync(true, 800);
      schedule(false);
    });
    window.addEventListener("focus", () => {
      scheduleAutoSync(true, 800);
      schedule(true);
    });
    window.addEventListener("pageshow", () => {
      scheduleAutoSync(true, 800);
      schedule(true);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      scheduleAutoSync(true, 800);
      schedule(true);
    });
    window.addEventListener("online", () => {
      scheduleAutoSync(true, 800);
      schedule(true);
    });
    window.addEventListener("resize", () => schedule(false, 80));
    window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      scheduleAutoSync(true, 0);
    }, SYNCED_SESSION_SAFETY_SYNC_MS);
    const observer = new MutationObserver((mutations) => {
      if (mutations.every((mutation) => {
        const nodes = [mutation.target, ...mutation.addedNodes, ...mutation.removedNodes];
        return nodes.every((node) => node.nodeType !== Node.ELEMENT_NODE || isOwnUiNode(node));
      })) return;
      scheduleAutoSync(false);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleAutoSync(true, 800);
    schedule(true, 0);
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
    const response = await fetch("/__opencode-plus/health?support=1", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function fetchSoulStatus() {
    const query = new URLSearchParams({ local_path: currentOpenCodeDirectory() });
    const response = await fetch(`/__opencode-plus/soul/status?${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function createSynchronizedProject(payload) {
    const response = await fetch("/__opencode-plus/soul/project", {
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

  async function createNewSynchronizedProject(payload) {
    const response = await fetch("/__opencode-plus/soul/project/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (body.error === "project_path_exists") {
        throw new Error(`A folder already exists at ${body.detail || "that location"}. Use the synced project list below to open it, or choose a different folder name.`);
      }
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function fetchSyncedProjects() {
    const response = await fetch("/__opencode-plus/soul/projects", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function currentSyncedProject() {
    const response = await fetchSyncedProjects();
    const projects = Array.isArray(response?.projects) ? response.projects : [];
    const current = currentOpenCodeDirectory();
    return projects.find((project) => isCurrentSyncedProject(project, current)) || null;
  }

  function isCurrentSyncedProject(project, current) {
    const localPath = project?.local_path || "";
    if (!localPath) return false;
    if (localPath === current) return true;
    if (project?.open_url === location.pathname.replace(/\/session(?:\/.*)?$/, "/session")) return true;
    const shortcutName = `#OCP-SyncedProject-${localPath.split("/").pop()}`;
    return current === shortcutName || current.endsWith(`/${shortcutName}`);
  }

  async function syncSyncedProjectSessions() {
    const response = await fetch("/__opencode-plus/soul/sessions/sync", { method: "POST", cache: "no-store", credentials: "same-origin" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function fetchSyncedProjectSessions(localPath) {
    await syncSyncedProjectSessions();
    const response = await fetch("/session", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const sessions = await response.json();
    return (Array.isArray(sessions) ? sessions : [])
      .filter((session) => session.directory === localPath || session.path === localPath.replace(/^\/+/, "") || session.directory?.endsWith?.(`#OCP-SyncedProject-${localPath.split("/").pop()}`))
      .filter((session) => !session.time?.archived)
      .sort((a, b) => (b.time?.updated || b.time?.created || 0) - (a.time?.updated || a.time?.created || 0));
  }

  async function deleteSyncedProjectMapping(id) {
    const response = await fetch(`/__opencode-plus/soul/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function updateSyncedProjectMapping(id, payload) {
    const response = await fetch(`/__opencode-plus/soul/projects/${encodeURIComponent(id)}`, {
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

  async function uploadSyncedProjectIcon(id, file) {
    const form = new FormData();
    form.append("icon", file);
    const response = await fetch(`/__opencode-plus/soul/projects/${encodeURIComponent(id)}/icon`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function fetchNamedWorkspaces() {
    const response = await fetch("/__opencode-plus/soul/workspaces", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function refreshNativeOpenCodeProjects() {
    const response = await fetch("/__opencode-plus/opencode/projects/refresh", { method: "POST" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function deleteDeploymentRecord(id) {
    const response = await fetch(`/__opencode-plus/soul/deployments/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
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

  async function restartGateway() {
    const response = await fetch("/__opencode-plus/gateway/restart", { method: "POST" });
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

  async function updateStorageProvider(id, payload) {
    const response = await fetch(`/__opencode-plus/storage-providers/${encodeURIComponent(id)}`, {
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

  async function deleteStorageProvider(id) {
    const response = await fetch(`/__opencode-plus/storage-providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function testStorageProvider(id) {
    const response = await fetch(`/__opencode-plus/storage-providers/${encodeURIComponent(id)}/test`, { method: "POST" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function browseStorageProvider(id, path = "") {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    const query = params.toString();
    const response = await fetch(`/__opencode-plus/storage-providers/${encodeURIComponent(id)}/browse${query ? `?${query}` : ""}`, { cache: "no-store" });
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
    while (Date.now() - started < 75_000) {
      try {
        const response = await fetch("/__health", { cache: "no-store" });
        if (response.ok) {
          const status = await response.json();
          if (status?.ok) {
            if (detail) detail.textContent = "OpenCode socket is back. Waiting for sessions...";
            const sessions = await fetch("/session", { cache: "no-store", credentials: "same-origin" });
            if (sessions.ok) {
              const body = await sessions.json().catch(() => null);
              if (Array.isArray(body)) {
                if (detail) detail.textContent = "OpenCode is ready. Refreshing...";
                window.setTimeout(() => window.location.reload(), 900);
                return;
              }
            }
          }
        }
      } catch {
        // The upstream can briefly disappear or reject DB-backed requests while restarting.
      }
      if (detail && !detail.textContent.includes("Waiting for sessions")) detail.textContent = "Restarting OpenCode server...";
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

  function showWorkspaceFolderMappingOverlay(root, titleText, detailText) {
    let overlay = root.querySelector(".ocp-drawer__link-action-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "ocp-drawer__restart-overlay ocp-drawer__link-action-overlay";
      overlay.innerHTML = `
        <div class="ocp-drawer__restart-card ocp-drawer__link-action-card" role="status" aria-live="polite">
          <span class="ocp-drawer__restart-spinner" aria-hidden="true"></span>
          <strong class="ocp-drawer__link-action-title"></strong>
          <p class="ocp-drawer__restart-detail ocp-drawer__link-action-detail"></p>
          <button type="button" class="ocp-drawer__button ocp-drawer__link-action-close" disabled>OK</button>
        </div>
      `;
      root.append(overlay);
      overlay.querySelector(".ocp-drawer__link-action-close")?.addEventListener("click", () => overlay.remove());
    }
    overlay.hidden = false;
    overlay.querySelector(".ocp-drawer__restart-spinner")?.removeAttribute("hidden");
    const close = overlay.querySelector(".ocp-drawer__link-action-close");
    close?.setAttribute("disabled", "");
    if (close) close.textContent = "OK";
    overlay.querySelector(".ocp-drawer__link-action-title").textContent = titleText;
    overlay.querySelector(".ocp-drawer__link-action-detail").textContent = detailText;
    return overlay;
  }

  function finishWorkspaceFolderMappingOverlay(overlay, titleText, detailText) {
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
    setupMaskedSecretFields(container);
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
      const value = secretFieldValue(geminiInput).trim();
      if (!value) {
        geminiInput.focus();
        return;
      }
      geminiButton.disabled = true;
      try {
        await saveGeminiCredentials(value);
        clearSecretField(geminiInput);
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
    const instanceInput = container.querySelector(".ocp-drawer__plus-instance-name");
    const instanceSave = container.querySelector(".ocp-drawer__plus-instance-save");
    const gatewayRestart = container.querySelector(".ocp-drawer__plus-gateway-restart");
    const instanceDetail = container.querySelector(".ocp-drawer__plus-instance-detail");

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

    try {
      const response = await fetchPlusConfig();
      const instanceName = response?.config?.instance_name || "";
      if (instanceInput) instanceInput.value = instanceName;
      if (instanceDetail) {
        instanceDetail.textContent = instanceName
          ? `Current configured instance name: ${instanceName}. Restart OpenCode Plus after saving changes so synchronization uses it as the stable instance ID and name.`
          : "Set this once to give synchronization a stable instance ID/name. If blank, OpenCode Plus falls back to the Docker hostname.";
      }
    } catch (error) {
      if (instanceDetail) instanceDetail.textContent = `Instance name unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }

    instanceSave?.addEventListener("click", async () => {
      const name = (instanceInput?.value || "").trim();
      if (!name) {
        if (instanceDetail) instanceDetail.textContent = "Enter an instance name first.";
        return;
      }
      instanceSave.disabled = true;
      if (instanceDetail) instanceDetail.textContent = "Saving instance name...";
      try {
        const response = await updatePlusConfig({ instance_name: name });
        const savedName = response?.config?.instance_name || name;
        if (instanceInput) instanceInput.value = savedName;
        if (instanceDetail) instanceDetail.textContent = `Saved ${savedName}. Restart OpenCode Plus to apply it to synchronization identity.`;
      } catch (error) {
        if (instanceDetail) instanceDetail.textContent = `Instance name save failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        instanceSave.disabled = false;
      }
    });

    gatewayRestart?.addEventListener("click", async () => {
      const confirmed = window.confirm("Restart the OpenCode Plus gateway now? The drawer may disconnect briefly while the new instance identity loads.");
      if (!confirmed) return;
      gatewayRestart.disabled = true;
      if (instanceDetail) instanceDetail.textContent = "Restarting OpenCode Plus gateway... Refresh this page in a few seconds.";
      try {
        await restartGateway();
      } catch (error) {
        if (instanceDetail) instanceDetail.textContent = `OpenCode Plus restart failed: ${error instanceof Error ? error.message : String(error)}`;
        gatewayRestart.disabled = false;
      }
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
        <label>
          <span>Instance name</span>
          <input class="ocp-drawer__field ocp-drawer__plus-instance-name" type="text" placeholder="e.g. opencode2" autocomplete="off">
        </label>
        <p class="ocp-drawer__field-detail ocp-drawer__plus-instance-detail">Checking instance name...</p>
        <div class="ocp-drawer__button-row">
          <button type="button" class="ocp-drawer__button ocp-drawer__plus-instance-save">Save Instance Name</button>
          <button type="button" class="ocp-drawer__button ocp-drawer__plus-gateway-restart">Restart OpenCode Plus</button>
        </div>
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
      <div class="ocp-drawer__modal-intro ocp-drawer__sync-summary">
        <strong>Keep the same OpenCode project available everywhere.</strong>
        <span>Synchronization connects every OpenCode instance to the same project folders. The sync index tracks which instances and projects exist; the shared folder holds the actual files.</span>
        <span>Session synchronization will build on this same model: PocketBase indexes sessions, while each synced project stores the session payload in its hidden <code>.opencode-plus/</code> folder.</span>
        <span>Normal setup is: connect the sync index, connect shared storage, map a synced workspace folder, then create synced projects inside it.</span>
      </div>
      <div class="ocp-drawer__system-section ocp-drawer__sync-actions">
        <h4>Setup Progress</h4>
        <div class="ocp-drawer__sync-checklist">
          <details class="ocp-drawer__sync-check" data-sync-check="database"><summary><span><strong>Sync index connected</strong><small>Checking PocketBase...</small></span><span class="ocp-drawer__sync-check-arrow" aria-hidden="true"></span><button type="button" class="ocp-drawer__button" data-sync-section="database-settings">Configure Index</button></summary><p>PocketBase is the lightweight index for instances, projects, and future synced sessions. It does not store project files.</p></details>
          <details class="ocp-drawer__sync-check" data-sync-check="schema"><summary><span><strong>Sync index ready</strong><small>Checking tables...</small></span><span class="ocp-drawer__sync-check-arrow" aria-hidden="true"></span><button type="button" class="ocp-drawer__button" data-sync-section="database-settings">Configure Index</button></summary><p>Creates the small tables OpenCode Plus needs to identify synced workspaces, projects, instances, and later session indexes.</p></details>
          <details class="ocp-drawer__sync-check" data-sync-check="provider"><summary><span><strong>Shared storage connected</strong><small>Add Google Drive, SSH/SFTP, or SMB.</small></span><span class="ocp-drawer__sync-check-arrow" aria-hidden="true"></span><button type="button" class="ocp-drawer__button" data-sync-section="storage-providers">Connect Storage</button></summary><p>This is where the actual synced project folders live, so every OpenCode instance can open the same files.</p></details>
          <details class="ocp-drawer__sync-check" data-sync-check="mapping"><summary><span><strong>Synced workspace folder mapped</strong><small>Choose where synced projects live on this instance.</small></span><span class="ocp-drawer__sync-check-arrow" aria-hidden="true"></span><button type="button" class="ocp-drawer__button" data-sync-section="workspace-folders">Map Folder</button></summary><p>Maps shared storage into a local folder on this instance. Each server can use a different local path for the same synced workspace.</p></details>
          <details class="ocp-drawer__sync-check" data-sync-check="space"><summary><span><strong>Synced workspace registered</strong><small>Will be created automatically if missing.</small></span><span class="ocp-drawer__sync-check-arrow" aria-hidden="true"></span><button type="button" class="ocp-drawer__button ocp-drawer__soul-create-project">Register Current Project</button></summary><p>Names the shared workspace so all instances agree which local folder represents the same synced area.</p></details>
          <details class="ocp-drawer__sync-check" data-sync-check="project"><summary><span><strong>Synced project registered</strong><small>Create a synced project below.</small></span><span class="ocp-drawer__sync-check-arrow" aria-hidden="true"></span><button type="button" class="ocp-drawer__button" data-sync-section="synced-projects">View Projects</button></summary><p>Registers at least one project inside a synced workspace folder on this instance. Removing the mapping makes this step pending again.</p></details>
        </div>
        <div class="ocp-drawer__button-row"><button type="button" class="ocp-drawer__button" data-sync-action="refresh">Refresh synchronization status</button></div>
        <p class="ocp-drawer__field-detail ocp-drawer__sync-action-detail">Ready to check this workspace.</p>
      </div>
      <div class="ocp-drawer__system-section" data-sync-panel="synced-projects">
        <h4>Synced Projects</h4>
        <div class="ocp-drawer__profile-shell ocp-drawer__profile-shell--projects ocp-drawer__profile-shell--list-only">
          <div class="ocp-drawer__profile-list-panel ocp-drawer__profile-list-panel--projects">
            <div class="ocp-drawer__profile-panel-header">
              <span><strong>Create a synced project</strong><small>Make a new project folder inside a synced workspace. Session-sync scaffolding is created at the same time.</small></span>
              <button type="button" class="ocp-drawer__button ocp-drawer__sync-project-new">New Synced Project</button>
            </div>
            <p class="ocp-drawer__field-detail">Existing OpenCode projects stay in the native OpenCode UI. This flow is only for new projects that should be shared across instances.</p>
            <p class="ocp-drawer__field-detail">OpenCode Plus also creates a <code>#OCP-SyncedProject-...</code> shortcut at the workspace root for the native Open Project picker. The first open may briefly show a native stale-read reload warning while the mount settles.</p>
            <p class="ocp-drawer__field-detail">Session sync updates OpenCode's local session database. Native OpenCode does not live-requery sessions imported or archived by OpenCode Plus, so the page may briefly auto-refresh after sync to show the updated sidebar.</p>
            <div class="ocp-drawer__synced-project-list">Loading synced projects...</div>
          </div>
          <div class="ocp-drawer__profile-editor-panel ocp-drawer__profile-editor-panel--projects" hidden>
            <div class="ocp-drawer__profile-editor-heading">
              <span><strong class="ocp-drawer__sync-project-editor-title">New synced project</strong><small>Create a folder inside a synced workspace and register it for this instance.</small></span>
            </div>
            <input class="ocp-drawer__sync-project-edit-id" type="hidden" value="">
            <label>
              <span>Project name</span>
              <input class="ocp-drawer__field ocp-drawer__new-sync-project-name" type="text" placeholder="e.g. My New Project" autocomplete="off">
            </label>
            <label class="ocp-drawer__sync-project-create-only">
              <span>Folder name</span>
              <input class="ocp-drawer__field ocp-drawer__new-sync-project-folder" type="text" placeholder="e.g. my-new-project" autocomplete="off">
            </label>
            <label class="ocp-drawer__sync-project-create-only">
              <span>Synced workspace folder</span>
              <select class="ocp-drawer__field ocp-drawer__new-sync-project-workspace" disabled>
                <option value="">Checking mapped workspaces...</option>
              </select>
            </label>
            <div class="ocp-drawer__button-row">
              <button type="button" class="ocp-drawer__button ocp-drawer__new-sync-project-create">Save Synced Project</button>
              <button type="button" class="ocp-drawer__button ocp-drawer__sync-project-cancel-edit">Cancel</button>
              <button type="button" class="ocp-drawer__button ocp-drawer__new-sync-project-open" hidden>Open New Project</button>
            </div>
            <p class="ocp-drawer__field-detail ocp-drawer__new-sync-project-detail">Available after a synced workspace folder is mapped on this instance. The native picker shortcut may show one stale-read warning the first time it is opened.</p>
          </div>
        </div>
      </div>
      <div class="ocp-drawer__system-section">
        <h4>Instances</h4>
        <p class="ocp-drawer__field-detail ocp-drawer__soul-db-status">Checking PocketBase...</p>
        <p class="ocp-drawer__field-detail ocp-drawer__soul-schema-status">Checking schema...</p>
        <p class="ocp-drawer__field-detail ocp-drawer__soul-deployment-status">Checking deployment identity...</p>
        <div class="ocp-drawer__instance-list">Loading known instances...</div>
      </div>
      <div class="ocp-drawer__system-section">
        <h4>Sync Index Database</h4>
        <div class="ocp-drawer__profile-shell ocp-drawer__profile-shell--sync-index ocp-drawer__profile-shell--list-only">
          <div class="ocp-drawer__profile-list-panel ocp-drawer__profile-list-panel--sync-index">
            <div class="ocp-drawer__profile-panel-header">
              <span><strong>PocketBase sync index</strong><small>Control-plane index for instances, synced workspaces, synced projects, and future synced sessions.</small></span>
              <button type="button" class="ocp-drawer__icon-action ocp-drawer__sync-db-edit" aria-label="Edit sync index database" title="Edit sync index database">✎</button>
            </div>
            <div class="ocp-drawer__profile-list">
              <div class="ocp-drawer__profile-card ocp-drawer__sync-db-card">
                <span class="ocp-drawer__profile-card-copy">
                  <strong class="ocp-drawer__sync-db-card-title">Checking sync index...</strong>
                  <em class="ocp-drawer__sync-db-card-status">Checking PocketBase...</em>
                  <small class="ocp-drawer__sync-db-card-url">Project files stay in shared storage.</small>
                </span>
              </div>
            </div>
            <p class="ocp-drawer__field-detail ocp-drawer__sync-db-card-detail">Checking database settings...</p>
          </div>
          <div class="ocp-drawer__profile-editor-panel ocp-drawer__profile-editor-panel--sync-index" hidden>
            <div class="ocp-drawer__profile-editor-heading">
              <span><strong>Configure sync index database</strong><small>Save changes, then restart OpenCode Plus to apply them.</small></span>
            </div>
            <label class="ocp-drawer__hidden-toggle">
              <input class="ocp-drawer__sync-db-enabled" type="checkbox">
              <span>
                <strong>Use PocketBase sync index</strong>
                <small>Project files stay in shared storage; PocketBase stores the lightweight index.</small>
              </span>
            </label>
            <label>
              <span>PocketBase URL</span>
              <input class="ocp-drawer__field ocp-drawer__sync-db-url" type="url" placeholder="http://pocketbase:8080" autocomplete="off">
            </label>
            <div class="ocp-drawer__button-row">
              <button type="button" class="ocp-drawer__button ocp-drawer__sync-db-save">Save Database Settings</button>
              <button type="button" class="ocp-drawer__button ocp-drawer__sync-db-restart">Restart OpenCode Plus</button>
              <button type="button" class="ocp-drawer__button ocp-drawer__sync-db-cancel-edit">Cancel</button>
            </div>
            <p class="ocp-drawer__field-detail ocp-drawer__sync-db-detail">Checking database settings...</p>
          </div>
        </div>
      </div>
      <div class="ocp-drawer__system-section ocp-drawer__sync-storage-providers" data-sync-panel="storage-providers">
        <h4>Shared Storage Accounts</h4>
        ${mountManagerMarkup("providers")}
      </div>
      <div class="ocp-drawer__system-section ocp-drawer__sync-workspace-folders" data-sync-panel="workspace-folders">
        <h4>Synced Workspace Folders</h4>
        ${mountManagerMarkup("links")}
      </div>
    `;
  }

  function synchronizationFeatureLabel(key) {
    const labels = {
      souls: "Shared session data",
      skills: "Skills",
      commands: "Commands",
      tools: "Tools",
      plugins_hooks: "Plugins and hooks",
      named_spaces: "Named spaces",
      synced_projects: "Project synchronization",
      synced_sessions: "Session synchronization",
    };
    return labels[key] || key.replace(/_/g, " ");
  }

  function setSyncCheck(container, key, complete, detail) {
    const row = container.querySelector(`.ocp-drawer__sync-check[data-sync-check='${key}']`);
    if (!row) return;
    row.classList.toggle("ocp-drawer__sync-check--done", Boolean(complete));
    row.classList.toggle("ocp-drawer__sync-check--pending", !complete);
    row.setAttribute("aria-label", `${row.querySelector("strong")?.textContent || key}: ${complete ? "complete" : "needs setup"}`);
    const small = row.querySelector("small");
    if (small) small.textContent = detail;
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
    const dbEnabled = container.querySelector(".ocp-drawer__sync-db-enabled");
    const dbURL = container.querySelector(".ocp-drawer__sync-db-url");
    const dbDetail = container.querySelector(".ocp-drawer__sync-db-detail");
    const dbCardTitle = container.querySelector(".ocp-drawer__sync-db-card-title");
    const dbCardStatus = container.querySelector(".ocp-drawer__sync-db-card-status");
    const dbCardURL = container.querySelector(".ocp-drawer__sync-db-card-url");
    const dbCardDetail = container.querySelector(".ocp-drawer__sync-db-card-detail");

    setSyncCheck(container, "database", Boolean(status?.enabled && db.connected), db.connected ? "PocketBase is reachable." : "PocketBase is not reachable yet.");
    setSyncCheck(container, "schema", Boolean(status?.schema_ready), status?.schema_ready ? "Required sync-index tables exist." : "Sync-index tables are not initialized yet.");
    setSyncCheck(container, "space", Boolean(status?.named_space_count), status?.named_space_count ? `${status.named_space_count} synced workspace${status.named_space_count === 1 ? "" : "s"} ready.` : "No synced workspace record yet. Register will create one.");
    setSyncCheck(container, "project", false, "Checking synced projects registered on this instance...");

    if (dbStatus) {
      dbStatus.textContent = status?.enabled
        ? `PocketBase ${db.connected ? "connected" : "unavailable"}: ${db.url || "not configured"}. ${db.connected ? "The sync index can track instances and projects." : "Synced-project setup waits until the index is reachable."}`
        : "The PocketBase sync index is disabled; OpenCode continues normally.";
    }
    if (dbEnabled) dbEnabled.checked = Boolean(status?.enabled);
    if (dbURL) dbURL.value = db.url || "";
    if (dbCardTitle) dbCardTitle.textContent = status?.enabled ? "PocketBase sync index" : "Sync index disabled";
    if (dbCardStatus) {
      dbCardStatus.textContent = status?.enabled
        ? (db.connected ? "Connected" : "Unavailable")
        : "Disabled";
    }
    if (dbCardURL) dbCardURL.textContent = db.url || "No PocketBase URL configured";
    if (dbCardDetail) {
      dbCardDetail.textContent = status?.enabled
        ? `Using ${db.url || "no PocketBase URL configured"}. Project payloads stay in shared storage.`
        : "The sync index is disabled. OpenCode continues normally.";
    }
    if (dbDetail) {
      dbDetail.textContent = status?.enabled
        ? `Using ${db.url || "no PocketBase URL configured"}. Save changes, then restart OpenCode Plus to apply them.`
        : "The sync index is disabled. Save changes, then restart OpenCode Plus to apply them.";
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
          const deleteButton = isCurrent ? "" : `<button type="button" class="ocp-drawer__icon-action ocp-drawer__icon-action--danger ocp-drawer__instance-delete" data-deployment-record-id="${escapeHtml(item.id || "")}" aria-label="Delete stale instance ${escapeHtml(item.name || item.deployment_id || "unknown")}" title="Delete stale instance">×</button>`;
          return `
            <div class="ocp-drawer__instance-row ${isCurrent ? "ocp-drawer__instance-row--current" : ""}">
              <span>
                <strong>${escapeHtml(item.name || item.deployment_id || "unknown")}${isCurrent ? " · this instance" : ""}</strong>
                <small>${escapeHtml(item.url || meta.url || "no URL recorded")} · ${escapeHtml(commit)} · seen ${escapeHtml(seen)}</small>
              </span>
              <span class="ocp-drawer__instance-actions">
                <em class="${stable ? "" : "ocp-drawer__sync-warn"}">${stable ? "stable" : "fix identity"}</em>
                ${deleteButton}
              </span>
            </div>
          `;
        }).join("");
      }
    }
    if (schemaStatus) {
      if (!status?.enabled) {
        schemaStatus.textContent = "Schema checks skipped because database synchronization is disabled.";
      } else if (!db.connected) {
        schemaStatus.textContent = "Schema checks skipped until PocketBase is reachable.";
      } else if (status.schema_ready) {
        schemaStatus.textContent = `Sync index initialized. Synced workspaces configured: ${status.named_space_count || 0}.`;
      } else {
        schemaStatus.textContent = "Sync index not initialized. Synced-project setup remains safely disabled.";
      }
    }
    if (featureList) {
      const features = status?.features || {};
      featureList.innerHTML = Object.entries(features).map(([key, value]) => `
        <div class="ocp-drawer__config-row">
          <span class="ocp-drawer__config-copy">
            <strong>${escapeHtml(synchronizationFeatureLabel(key))}</strong>
            <small>${escapeHtml(value)}</small>
          </span>
        </div>
      `).join("") || `<p class="ocp-drawer__field-detail">No synchronization features reported yet.</p>`;
    }
    if (projectGate) {
      if (!db.connected) {
        projectGate.textContent = "Register project is disabled until PocketBase is reachable.";
      } else if (!status.schema_ready) {
        projectGate.textContent = "Register project is disabled until the sync-index schema is initialized.";
      } else if (!status.named_space_count) {
        projectGate.textContent = "Register project will create the first synced workspace record.";
      } else {
        projectGate.textContent = "Synced-project prerequisites are ready.";
      }
    }
    if (createProject) {
      createProject.disabled = !(db.connected && status?.schema_ready);
      createProject.title = createProject.disabled
        ? "Requires PocketBase connection and initialized sync-index schema."
        : "Create or update the synced project record for this current project path.";
    }
  }

  async function setupSoulSyncControls(container, root, settings) {
    let fullSyncReady = false;
    function showSyncIndexEditor() {
      container.querySelector(".ocp-drawer__profile-shell--sync-index")?.classList.remove("ocp-drawer__profile-shell--list-only");
      const listPanel = container.querySelector(".ocp-drawer__profile-list-panel--sync-index");
      const editorPanel = container.querySelector(".ocp-drawer__profile-editor-panel--sync-index");
      if (listPanel) listPanel.hidden = true;
      if (editorPanel) editorPanel.hidden = false;
    }

    function hideSyncIndexEditor() {
      container.querySelector(".ocp-drawer__profile-shell--sync-index")?.classList.add("ocp-drawer__profile-shell--list-only");
      const listPanel = container.querySelector(".ocp-drawer__profile-list-panel--sync-index");
      const editorPanel = container.querySelector(".ocp-drawer__profile-editor-panel--sync-index");
      if (listPanel) listPanel.hidden = false;
      if (editorPanel) editorPanel.hidden = true;
    }

    function showProjectSyncEditor(editing = false) {
      container.querySelector(".ocp-drawer__profile-shell--projects")?.classList.remove("ocp-drawer__profile-shell--list-only");
      const listPanel = container.querySelector(".ocp-drawer__profile-list-panel--projects");
      const editorPanel = container.querySelector(".ocp-drawer__profile-editor-panel--projects");
      if (listPanel) listPanel.hidden = true;
      if (editorPanel) editorPanel.hidden = false;
      container.querySelectorAll(".ocp-drawer__sync-project-create-only").forEach((item) => { item.hidden = editing; });
      const title = container.querySelector(".ocp-drawer__sync-project-editor-title");
      if (title) title.textContent = editing ? "Edit synced project" : "New synced project";
      const save = container.querySelector(".ocp-drawer__new-sync-project-create");
      if (save) save.textContent = editing ? "Save Project" : "Save Synced Project";
    }

    function hideProjectSyncEditor() {
      container.querySelector(".ocp-drawer__profile-shell--projects")?.classList.add("ocp-drawer__profile-shell--list-only");
      const listPanel = container.querySelector(".ocp-drawer__profile-list-panel--projects");
      const editorPanel = container.querySelector(".ocp-drawer__profile-editor-panel--projects");
      if (listPanel) listPanel.hidden = false;
      if (editorPanel) editorPanel.hidden = true;
    }

    function clearProjectSyncEditor() {
      const editID = container.querySelector(".ocp-drawer__sync-project-edit-id");
      if (editID) editID.value = "";
      const name = container.querySelector(".ocp-drawer__new-sync-project-name");
      const folder = container.querySelector(".ocp-drawer__new-sync-project-folder");
      if (name) name.value = "";
      if (folder) folder.value = "";
      const open = container.querySelector(".ocp-drawer__new-sync-project-open");
      if (open) open.hidden = true;
    }

    async function refreshSyncedProjectList() {
      const list = container.querySelector(".ocp-drawer__synced-project-list");
      try {
        const response = await fetchSyncedProjects();
        const projects = Array.isArray(response?.projects) ? response.projects : [];
        setSyncCheck(container, "project", projects.length > 0, projects.length ? `${projects.length} synced project${projects.length === 1 ? "" : "s"} registered on this instance.` : "No synced projects are registered on this instance.");
        if (!list) return projects;
        if (!projects.length) {
          list.innerHTML = `<p class="ocp-drawer__field-detail">No synced projects are registered here yet.</p>`;
          return projects;
        }
        list.innerHTML = projects.map((project) => `
          <div class="ocp-drawer__synced-project-row" data-project-mapping-id="${escapeHtml(project.id || "")}" data-project-name="${escapeHtml(project.name || "")}" data-open-url="${escapeHtml(project.open_url || "")}">
            <span class="ocp-drawer__synced-project-avatar" aria-hidden="true">${project.icon_url ? `<img src="${escapeHtml(project.icon_url)}" alt="">` : escapeHtml((project.name || project.local_path || "S").trim().slice(0, 1).toUpperCase())}</span>
            <span>
              <strong>${escapeHtml(project.name || project.local_path || "Synced project")}</strong>
              <small>${escapeHtml(project.local_path || "")}</small>
            </span>
            <span class="ocp-drawer__instance-actions">
              <button type="button" class="ocp-drawer__button ocp-drawer__synced-project-open" data-open-url="${escapeHtml(project.open_url || "")}">Open</button>
              <button type="button" class="ocp-drawer__button ocp-drawer__synced-project-icon">Profile Pic</button>
              <button type="button" class="ocp-drawer__icon-action ocp-drawer__synced-project-edit" aria-label="Edit synced project" title="Edit synced project">✎</button>
              <button type="button" class="ocp-drawer__icon-action ocp-drawer__icon-action--danger ocp-drawer__synced-project-delete" aria-label="Remove synced project mapping" title="Remove from this instance">×</button>
            </span>
          </div>
        `).join("");
        return projects;
      } catch (error) {
        setSyncCheck(container, "project", false, "Synced project list unavailable.");
        if (list) list.innerHTML = `<p class="ocp-drawer__field-detail">Synced projects unavailable: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
        return [];
      }
    }

    async function refreshStatus() {
      const actionDetail = container.querySelector(".ocp-drawer__sync-action-detail");
      if (actionDetail) actionDetail.textContent = "Refreshing synchronization status...";
      try {
        const status = await fetchSoulStatus();
        renderSoulStatus(container, status);
        let providerReady = false;
        let mappingReady = false;
        try {
          const [providersResponse, mountsResponse] = await Promise.all([fetchStorageProviders(), fetchMounts()]);
          const providers = Array.isArray(providersResponse?.providers) ? providersResponse.providers : [];
          const mounts = Array.isArray(mountsResponse?.mounts) ? mountsResponse.mounts : [];
          providerReady = providers.length > 0;
          mappingReady = mounts.length > 0;
          setSyncCheck(container, "provider", providers.length > 0, providers.length ? `${providers.length} shared storage account${providers.length === 1 ? "" : "s"} connected.` : "Click to connect Google Drive, SSH/SFTP, or SMB.");
          setSyncCheck(container, "mapping", mounts.length > 0, mounts.length ? `${mounts.length} synced workspace folder${mounts.length === 1 ? "" : "s"} mapped.` : "Click to map a shared folder into this instance.");
        } catch (error) {
          setSyncCheck(container, "provider", false, "Storage provider status unavailable.");
          setSyncCheck(container, "mapping", false, "Workspace folder mapping status unavailable.");
        }
        fullSyncReady = Boolean(status?.enabled && status?.pocketbase?.connected && status?.schema_ready && providerReady && mappingReady);
        await refreshNamedWorkspaceOptions(fullSyncReady);
        await refreshSyncedProjectList();
        if (root) updateInstanceBadge(root, status);
        if (actionDetail) actionDetail.textContent = "Synchronization status refreshed.";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const dbStatus = container.querySelector(".ocp-drawer__soul-db-status");
        if (dbStatus) dbStatus.textContent = `Synchronization status unavailable: ${message}`;
        if (actionDetail) actionDetail.textContent = `Refresh failed: ${message}`;
      }
    }

    if (root) root.__ocpRefreshSoulSync = refreshStatus;

    async function refreshNamedWorkspaceOptions(enabled) {
      const select = container.querySelector(".ocp-drawer__new-sync-project-workspace");
      const createButton = container.querySelector(".ocp-drawer__new-sync-project-create");
      const detail = container.querySelector(".ocp-drawer__new-sync-project-detail");
      if (!select || !createButton) return;
      createButton.disabled = true;
      select.disabled = true;
      if (!enabled) {
        select.innerHTML = `<option value="">Map a synced workspace folder first</option>`;
        if (detail) detail.textContent = "Connect shared storage and map a synced workspace folder before creating a project inside it.";
        return;
      }
      try {
        const response = await fetchNamedWorkspaces();
        const workspaces = Array.isArray(response?.workspaces) ? response.workspaces : [];
        if (!workspaces.length) {
          select.innerHTML = `<option value="">No synced workspace folders</option>`;
          if (detail) detail.textContent = "Map a shared storage folder into this instance first.";
          return;
        }
        select.innerHTML = workspaces.map((workspace) => `<option value="${escapeHtml(workspace.id || "")}">${escapeHtml(workspace.name || "Workspace")} · ${escapeHtml(workspace.remote_path || workspace.local_path || "")}</option>`).join("");
        select.disabled = false;
        createButton.disabled = false;
        if (detail) detail.textContent = "New projects are created inside the selected synced workspace folder.";
      } catch (error) {
        select.innerHTML = `<option value="">Named workspaces unavailable</option>`;
        if (detail) detail.textContent = `Named workspace lookup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    container.querySelectorAll("[data-sync-open]").forEach((button) => {
      button.addEventListener("click", () => {
        const area = CONFIG_AREAS.find((item) => item.id === button.dataset.syncOpen);
        if (root && area) openConfigArea(root, area, settings);
      });
    });
    container.querySelectorAll("[data-sync-section]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const panel = container.querySelector(`[data-sync-panel='${button.dataset.syncSection}']`);
        if (panel instanceof HTMLDetailsElement) panel.open = true;
        panel?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    container.querySelector("[data-sync-action='refresh']")?.addEventListener("click", () => refreshSyncedWorkspaceHeader(root));
    container.querySelector("[data-sync-action='identity-help']")?.addEventListener("click", () => {
      const area = CONFIG_AREAS.find((item) => item.id === "system");
      if (root && area) openConfigArea(root, area, settings);
    });
    container.querySelector(".ocp-drawer__sync-db-edit")?.addEventListener("click", showSyncIndexEditor);
    container.querySelector(".ocp-drawer__sync-db-cancel-edit")?.addEventListener("click", hideSyncIndexEditor);
    container.querySelector(".ocp-drawer__instance-list")?.addEventListener("click", async (event) => {
      const button = event.target.closest?.(".ocp-drawer__instance-delete");
      if (!button) return;
      const id = button.dataset.deploymentRecordId || "";
      if (!id) return;
      if (!window.confirm("Delete this stale instance record? This only removes the sync heartbeat row; it does not stop or change that OpenCode instance.")) return;
      const actionDetail = container.querySelector(".ocp-drawer__sync-action-detail");
      button.disabled = true;
      if (actionDetail) actionDetail.textContent = "Deleting stale instance record...";
      try {
        await deleteDeploymentRecord(id);
        if (actionDetail) actionDetail.textContent = "Stale instance record deleted.";
        await refreshStatus();
      } catch (error) {
        if (actionDetail) actionDetail.textContent = `Delete failed: ${error instanceof Error ? error.message : String(error)}`;
        button.disabled = false;
      }
    });
    container.querySelector(".ocp-drawer__synced-project-list")?.addEventListener("click", async (event) => {
      const openButton = event.target.closest?.(".ocp-drawer__synced-project-open");
      if (openButton) {
        const url = openButton.dataset.openUrl || "";
        if (url) window.location.href = url;
        return;
      }
      const iconButton = event.target.closest?.(".ocp-drawer__synced-project-icon");
      if (iconButton) {
        const row = iconButton.closest(".ocp-drawer__synced-project-row");
        const id = row?.dataset.projectMappingId || "";
        if (!id) return;
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png,image/jpeg,image/gif";
        input.addEventListener("change", async () => {
          const file = input.files?.[0];
          if (!file) return;
          iconButton.disabled = true;
          iconButton.textContent = "Uploading...";
          try {
            await uploadSyncedProjectIcon(id, file);
            await refreshNativeOpenCodeProjects();
            await refreshSyncedProjectList();
          } catch (error) {
            window.alert(`Profile picture upload failed: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            iconButton.disabled = false;
            iconButton.textContent = "Profile Pic";
          }
        }, { once: true });
        input.click();
        return;
      }
      const editButton = event.target.closest?.(".ocp-drawer__synced-project-edit");
      if (editButton) {
        const row = editButton.closest(".ocp-drawer__synced-project-row");
        const editID = container.querySelector(".ocp-drawer__sync-project-edit-id");
        const name = container.querySelector(".ocp-drawer__new-sync-project-name");
        if (editID) editID.value = row?.dataset.projectMappingId || "";
        if (name) name.value = row?.dataset.projectName || "";
        showProjectSyncEditor(true);
        return;
      }
      const deleteButton = event.target.closest?.(".ocp-drawer__synced-project-delete");
      if (!deleteButton) return;
      const row = deleteButton.closest(".ocp-drawer__synced-project-row");
      const id = row?.dataset.projectMappingId || "";
      if (!id) return;
      if (!window.confirm("Remove this synced project from this OpenCode instance? This does not delete files or remove it from other instances.")) return;
      deleteButton.disabled = true;
      try {
        await deleteSyncedProjectMapping(id);
        await refreshSyncedProjectList();
      } catch (error) {
        window.alert(`Remove failed: ${error instanceof Error ? error.message : String(error)}`);
        deleteButton.disabled = false;
      }
    });
    container.querySelector(".ocp-drawer__sync-project-new")?.addEventListener("click", () => {
      clearProjectSyncEditor();
      showProjectSyncEditor(false);
    });
    container.querySelector(".ocp-drawer__sync-project-cancel-edit")?.addEventListener("click", () => {
      clearProjectSyncEditor();
      hideProjectSyncEditor();
    });
    const newProjectName = container.querySelector(".ocp-drawer__new-sync-project-name");
    const newProjectFolder = container.querySelector(".ocp-drawer__new-sync-project-folder");
    const newProjectDetail = container.querySelector(".ocp-drawer__new-sync-project-detail");
    const newProjectOpen = container.querySelector(".ocp-drawer__new-sync-project-open");
    newProjectName?.addEventListener("input", () => {
      if (!newProjectFolder || newProjectFolder.value.trim()) return;
      newProjectFolder.value = newProjectName.value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    });
    container.querySelector(".ocp-drawer__new-sync-project-create")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const editID = container.querySelector(".ocp-drawer__sync-project-edit-id")?.value || "";
      const name = newProjectName?.value.trim() || "";
      const folderName = newProjectFolder?.value.trim() || "";
      const workspaceID = container.querySelector(".ocp-drawer__new-sync-project-workspace")?.value || "";
      if (!name) {
        if (newProjectDetail) newProjectDetail.textContent = "Enter a project name first.";
        return;
      }
      if (!editID && (!fullSyncReady || !workspaceID)) {
        if (newProjectDetail) newProjectDetail.textContent = "Choose a synced workspace folder first.";
        return;
      }
      button.disabled = true;
      if (newProjectOpen) newProjectOpen.hidden = true;
      if (newProjectDetail) newProjectDetail.textContent = "Creating synced project...";
      try {
        if (editID) {
          await updateSyncedProjectMapping(editID, { name });
          if (newProjectDetail) newProjectDetail.textContent = "Synced project updated.";
        } else {
          const result = await createNewSynchronizedProject({ name, folder_name: folderName, workspace_id: workspaceID });
          if (newProjectOpen) {
            newProjectOpen.hidden = false;
            newProjectOpen.onclick = () => { window.location.href = result.open_url; };
          }
          const actionDetail = container.querySelector(".ocp-drawer__sync-action-detail");
          if (actionDetail) actionDetail.textContent = `Created synced project ${result.local_path}.`;
          await refreshNativeOpenCodeProjects();
          window.alert("Synced project created and added to OpenCode's local project list. If the native Open project picker is already open, close and reopen it to reload OpenCode's folder list.");
        }
        await refreshSyncedProjectList();
        await refreshStatus();
        clearProjectSyncEditor();
        hideProjectSyncEditor();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("folder already exists")) {
          await refreshSyncedProjectList();
          hideProjectSyncEditor();
          const actionDetail = container.querySelector(".ocp-drawer__sync-action-detail");
          if (actionDetail) actionDetail.textContent = "That folder already exists. Open it from the synced project list.";
        } else if (newProjectDetail) {
          newProjectDetail.textContent = `Create failed: ${message}`;
        }
      } finally {
        button.disabled = false;
      }
    });
    container.querySelectorAll(".ocp-drawer__soul-create-project").forEach((setupButton) => setupButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const button = event.currentTarget;
      const buttons = Array.from(container.querySelectorAll(".ocp-drawer__soul-create-project"));
      const actionDetail = container.querySelector(".ocp-drawer__sync-action-detail");
      const workspace = currentOpenCodeDirectory();
      const projectName = workspace.split("/").filter(Boolean).pop() || "OpenCode Project";
      buttons.forEach((item) => { item.disabled = true; });
      if (actionDetail) actionDetail.textContent = "Creating or updating synced project records...";
      try {
        const result = await createSynchronizedProject({ name: projectName, local_path: workspace });
        setSyncCheck(container, "space", true, result.created_space ? "Created synced workspace record." : "Synced workspace record already existed.");
        setSyncCheck(container, "project", true, result.created_project ? "Registered current project." : "Updated current project mapping.");
        if (actionDetail) actionDetail.textContent = "Synced project is set up for this workspace.";
        await refreshStatus();
        setSyncCheck(container, "project", true, `Registered ${workspace}.`);
      } catch (error) {
        if (actionDetail) actionDetail.textContent = `Setup failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        buttons.forEach((item) => { item.disabled = false; });
      }
    }));
    container.querySelector(".ocp-drawer__sync-db-save")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const enabled = Boolean(container.querySelector(".ocp-drawer__sync-db-enabled")?.checked);
      const pbURL = (container.querySelector(".ocp-drawer__sync-db-url")?.value || "").trim();
      const detail = container.querySelector(".ocp-drawer__sync-db-detail");
      if (!pbURL) {
        if (detail) detail.textContent = "Enter a PocketBase URL first.";
        return;
      }
      button.disabled = true;
      if (detail) detail.textContent = "Saving database settings...";
      try {
        const response = await updatePlusConfig({ soul_db_enabled: enabled, soul_pb_url: pbURL });
        const saved = response?.config || {};
        const urlInput = container.querySelector(".ocp-drawer__sync-db-url");
        if (urlInput) urlInput.value = saved.soul_pb_url || pbURL;
        if (detail) detail.textContent = "Saved. Restart OpenCode Plus to apply the database settings.";
        await refreshStatus();
      } catch (error) {
        if (detail) detail.textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        button.disabled = false;
      }
    });
    container.querySelector(".ocp-drawer__sync-db-restart")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const detail = container.querySelector(".ocp-drawer__sync-db-detail");
      const confirmed = window.confirm("Restart the OpenCode Plus gateway now? The drawer may disconnect briefly while database settings reload.");
      if (!confirmed) return;
      button.disabled = true;
      if (detail) detail.textContent = "Restarting OpenCode Plus gateway... Refresh this page in a few seconds.";
      try {
        await restartGateway();
      } catch (error) {
        if (detail) detail.textContent = `OpenCode Plus restart failed: ${error instanceof Error ? error.message : String(error)}`;
        button.disabled = false;
      }
    });

    await refreshStatus();
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
      <p class="ocp-drawer__modal-intro">${showProviders && !showLinks ? "Connect the shared storage account that will hold synced OpenCode project folders." : "Choose which shared storage folder appears locally as the synced workspace folder on this instance."}</p>
      ${showProviders ? `
      <div class="ocp-drawer__profile-shell ocp-drawer__profile-shell--providers ocp-drawer__profile-shell--list-only">
        <div class="ocp-drawer__profile-list-panel ocp-drawer__profile-list-panel--providers">
          <div class="ocp-drawer__profile-panel-header">
            <span><strong>Shared storage accounts</strong><small>Google Drive, SSH/SFTP, or SMB accounts that hold synced projects.</small></span>
            <button type="button" class="ocp-drawer__icon-action ocp-drawer__provider-new" aria-label="Add shared storage account" title="Add shared storage account">+</button>
          </div>
          <div class="ocp-drawer__provider-list ocp-drawer__profile-list">Loading providers...</div>
        </div>
        <div class="ocp-drawer__profile-editor-panel ocp-drawer__profile-editor-panel--providers" hidden>
          <div class="ocp-drawer__profile-editor-heading">
            <span><strong class="ocp-drawer__provider-editor-title">New shared storage account</strong><small>Save credentials once, then choose which folder to sync.</small></span>
          </div>
          <div class="ocp-drawer__credential-form ocp-drawer__provider-form">
          <input class="ocp-drawer__provider-edit-id" type="hidden">
          <label title="A friendly name for this shared storage account. This name appears when mapping synced workspace folders.">
            <span>Storage account name</span>
            <input class="ocp-drawer__field ocp-drawer__provider-name" type="text" placeholder="e.g. 'gdrive' or 'project-server'" title="A friendly name for this shared storage account. This name appears when mapping synced workspace folders.">
          </label>
          <label title="The kind of storage connection to save. Provider-specific fields appear below.">
            <span>Type</span>
            <select class="ocp-drawer__field ocp-drawer__provider-type" title="The kind of storage connection to save. Provider-specific fields appear below.">
              <option value="google_drive">Google Drive</option>
              <option value="ssh">SSH/SFTP</option>
              <option value="smb">SMB</option>
            </select>
          </label>
          <label data-provider-field="host" title="Server hostname or IP address for this shared storage account. Do not include a folder path here.">
            <span>Host</span>
            <input class="ocp-drawer__field ocp-drawer__provider-host" type="text" placeholder="server.local" title="Server hostname or IP address for this shared storage account. Do not include a folder path here.">
          </label>
          <p class="ocp-drawer__field-detail ocp-drawer__provider-detail"></p>
          <div class="ocp-drawer__credential-form ocp-drawer__provider-google-connect">
            <div class="ocp-drawer__field-detail ocp-drawer__mount-google-steps">
              <strong>Google Drive connection setup</strong>
              <details class="ocp-drawer__setup-step" open>
                <summary>1. Create a Google OAuth app</summary>
                <span>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud Credentials</a>, choose or create a project, then select <strong>Create Credentials</strong> → <strong>OAuth client ID</strong>.</span>
                <span>If Google asks for an OAuth consent screen first, use <a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank" rel="noopener noreferrer">OAuth consent screen</a>, choose <strong>External</strong> for personal Google accounts, add your email as a test user, and save.</span>
              </details>
              <details class="ocp-drawer__setup-step">
                <summary>2. Choose Desktop app</summary>
                <span>For Application type, choose <strong>Desktop app</strong>. Name it something like <strong>OpenCode Plus rclone</strong>, then create it.</span>
                <span>Copy the generated Client ID and Client Secret into the required fields below.</span>
              </details>
              <details class="ocp-drawer__setup-step">
                <summary>3. Authorize rclone with that app</summary>
                <span>Install rclone if needed: <a href="https://rclone.org/downloads/" target="_blank" rel="noopener noreferrer">rclone downloads</a>.</span>
                <span>Run <code>rclone authorize "drive" CLIENT_ID CLIENT_SECRET</code> using the exact Client ID and Client Secret from Google Cloud.</span>
              </details>
              <details class="ocp-drawer__setup-step">
                <summary>4. Paste the token JSON</summary>
                <span>A Google login page opens. Sign in, allow access, then copy the full JSON block rclone prints.</span>
                <span>Paste that JSON below. When editing an existing provider, leave token and secret blank to keep the saved Google account.</span>
              </details>
            </div>
            <label title="Required Google OAuth desktop app client ID from Google Cloud Credentials.">
              <span>Google OAuth Client ID</span>
              <input class="ocp-drawer__field ocp-drawer__provider-google-client-id" type="text" autocomplete="off" placeholder="Required Google OAuth desktop client ID" title="Required Google OAuth desktop app client ID from Google Cloud Credentials.">
            </label>
            <label title="Required Google OAuth desktop app client secret matching the client ID used to generate the token.">
              <span>Google OAuth Client Secret</span>
              <input class="ocp-drawer__field ocp-drawer__provider-google-client-secret" type="password" autocomplete="off" placeholder="Required for new Google Drive providers" title="Required Google OAuth desktop app client secret matching the client ID used to generate the token.">
            </label>
            <label title="Paste the full JSON token printed by rclone authorize. This connects the Google Drive account to this provider.">
              <span>Authorization token JSON</span>
              <textarea class="ocp-drawer__field ocp-drawer__provider-google-token ocp-drawer__masked-secret" autocomplete="off" spellcheck="false" placeholder='{"access_token":"...","refresh_token":"..."}' title="Paste the full JSON token printed by rclone authorize. This connects the Google Drive account to this provider."></textarea>
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
            <textarea class="ocp-drawer__field ocp-drawer__provider-private-key ocp-drawer__masked-secret" autocomplete="off" spellcheck="false" placeholder="Optional SSH private key" title="Optional SSH private key for SSH/SFTP providers. Use this instead of, or in addition to, a password."></textarea>
          </label>
          <div class="ocp-drawer__button-row">
            <button type="button" class="ocp-drawer__button ocp-drawer__provider-save">Save Storage Account</button>
            <button type="button" class="ocp-drawer__button ocp-drawer__provider-cancel-edit ocp-drawer__mount-field--hidden">Cancel Edit</button>
          </div>
          <p class="ocp-drawer__field-detail ocp-drawer__provider-save-detail">Storage accounts save reusable credentials only. Choose the synced folder in the next section.</p>
        </div>
        </div>
      </div>
      ` : ""}
      ${showLinks ? `
      <div class="ocp-drawer__profile-shell ocp-drawer__profile-shell--links ocp-drawer__profile-shell--list-only">
        <div class="ocp-drawer__profile-list-panel ocp-drawer__profile-list-panel--links">
          <div class="ocp-drawer__profile-panel-header">
            <span><strong>Synced workspace folders</strong><small>Shared folders mounted into this OpenCode instance.</small></span>
            <button type="button" class="ocp-drawer__icon-action ocp-drawer__mount-new" aria-label="Add synced workspace folder" title="Add synced workspace folder">+</button>
          </div>
          <div class="ocp-drawer__mount-list ocp-drawer__profile-list">Loading mounts...</div>
        </div>
        <div class="ocp-drawer__profile-editor-panel ocp-drawer__profile-editor-panel--links" hidden>
          <div class="ocp-drawer__profile-editor-heading">
            <span><strong class="ocp-drawer__mount-editor-title">New synced workspace folder</strong><small>Pick a shared storage account, then choose the remote folder and local mount path.</small></span>
          </div>
          <div class="ocp-drawer__credential-form ocp-drawer__mount-form">
          <input class="ocp-drawer__mount-edit-id" type="hidden">
          <label title="Choose one saved shared storage account. The mapping uses that account's saved credentials.">
            <span>Shared storage account</span>
            <select class="ocp-drawer__field ocp-drawer__mount-provider-select" title="Choose one saved shared storage account. The mapping uses that account's saved credentials."></select>
          </label>
          <label title="Folder/path inside the selected provider. Examples: Google Drive folder 'opencode-plus' or SSH path '/srv/project'.">
            <span>Remote folder/path</span>
            <input class="ocp-drawer__field ocp-drawer__mount-path" type="text" placeholder="e.g. opencode-plus or /srv/project" title="Folder/path inside the selected provider. Examples: Google Drive folder 'opencode-plus' or SSH path '/srv/project'.">
          </label>
          <details class="ocp-drawer__browse-panel ocp-drawer__mount-field--hidden" data-mount-field="browse">
            <summary>Browse remote folders</summary>
            <div class="ocp-drawer__browse-header">
              <span><strong>Google Drive folders</strong><small>Select the Drive folder that will contain synced projects.</small></span>
              <button type="button" class="ocp-drawer__button ocp-drawer__browse-load">Load folders</button>
            </div>
            <div class="ocp-drawer__browse-path" hidden></div>
            <div class="ocp-drawer__browse-list" hidden></div>
          </details>
          <label title="Local folder name created under this workspace's mounts folder. Use a simple folder name, not a full path.">
            <span>Local workspace folder</span>
            <input class="ocp-drawer__field ocp-drawer__mount-name" type="text" placeholder="work-files" title="Local folder name created under this workspace's mounts folder. Use a simple folder name, not a full path.">
          </label>
          <details class="ocp-drawer__local-panel">
            <summary>Local workspace folder details</summary>
            <p class="ocp-drawer__field-detail">Created under <code>${escapeHtml(currentOpenCodeDirectory())}/mounts</code>. Use a short folder name such as <code>client-files</code>; do not enter a full path.</p>
          </details>
          <label class="ocp-drawer__hidden-toggle" title="When enabled, agents should treat this mapped storage as read-only where supported.">
            <input class="ocp-drawer__mount-read-only" type="checkbox" checked title="When enabled, agents should treat this mapped storage as read-only where supported.">
            <span><strong>Read-only</strong><small>Recommended until you are ready for agents to write to this remote.</small></span>
          </label>
          <label class="ocp-drawer__hidden-toggle" title="Automatically retry this synced workspace folder later if the provider or network is temporarily unavailable.">
            <input class="ocp-drawer__mount-auto-reconnect" type="checkbox" checked title="Automatically retry this synced workspace folder later if the provider or network is temporarily unavailable.">
            <span><strong>Auto-reconnect</strong><small>Retry unreachable SSH/SMB mappings later.</small></span>
          </label>
          <div class="ocp-drawer__button-row">
            <button type="button" class="ocp-drawer__button ocp-drawer__mount-save">Save Mapping</button>
            <button type="button" class="ocp-drawer__button ocp-drawer__mount-cancel-edit ocp-drawer__mount-field--hidden">Cancel Edit</button>
          </div>
          <p class="ocp-drawer__field-detail ocp-drawer__mount-save-detail">Choose a shared storage account first.</p>
        </div>
        </div>
      </div>
      ` : ""}
    `;
  }

  function renderMountList(container, mounts) {
    const list = container.querySelector(".ocp-drawer__mount-list");
    if (!list) return;
    if (!Array.isArray(mounts) || mounts.length === 0) {
      list.innerHTML = `<p class="ocp-drawer__empty-config">No synced workspace folders yet. Choose + to map one.</p>`;
      return;
    }
    list.innerHTML = mounts.map((mount) => {
      const state = mount.state || {};
      const remoteFolder = mount.remote?.path || mount.remote?.share || "";
      const localFolder = localWorkspaceFolderName(mount);
      const providerName = mount.remote?.rclone_remote || mount.remote?.host || mount.type || "provider";
      const status = mountStatusLabel(state.status);
      const nextRetry = state.next_retry_at ? `<small>Next retry: ${escapeHtml(state.next_retry_at)}</small>` : "";
      const error = state.last_error ? `<small class="ocp-drawer__link-error">${escapeHtml(shorten(state.last_error, 180))}</small>` : "";
      const connectLabel = "Connect";
      const disconnectTitle = "Disconnect synced workspace folder";
      const disconnectButton = `<button type="button" class="ocp-drawer__icon-action ocp-drawer__mount-action" data-action="disconnect" aria-label="${disconnectTitle}" title="${disconnectTitle}">⏏</button>`;
      return `
        <div class="ocp-drawer__profile-card ocp-drawer__link-card ocp-drawer__mount-row" data-mount-id="${escapeHtml(mount.id)}">
          <div class="ocp-drawer__link-grid">
            <span><small>Synced workspace</small><strong>${escapeHtml(mount.name || mount.id)}</strong></span>
            <span><small>Local folder</small><strong>${escapeHtml(localFolder || "mount")}</strong></span>
            <span><small>Remote folder</small><strong>${escapeHtml(remoteFolder || "(root)")}</strong></span>
            <span><small>Provider</small><strong>${escapeHtml(providerName)}</strong><em>${escapeHtml(mount.type || "mount")} · ${escapeHtml(status)}</em></span>
          </div>
          ${error}${nextRetry}
          <div class="ocp-drawer__profile-card-actions">
            <button type="button" class="ocp-drawer__icon-action ocp-drawer__mount-action" data-action="test" aria-label="Test synced workspace folder" title="Test synced workspace folder">✓</button>
            <button type="button" class="ocp-drawer__icon-action ocp-drawer__mount-action" data-action="connect" aria-label="${connectLabel} synced workspace folder" title="${connectLabel} synced workspace folder">↻</button>
            ${disconnectButton}
            <button type="button" class="ocp-drawer__icon-action ocp-drawer__mount-edit" aria-label="Edit synced workspace folder" title="Edit synced workspace folder">✎</button>
            <button type="button" class="ocp-drawer__icon-action ocp-drawer__icon-action--danger ocp-drawer__mount-delete" aria-label="Delete synced workspace folder" title="Delete synced workspace folder">×</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function localWorkspaceFolderName(mount) {
    const value = mount?.mount_path || mount?.name || "";
    const parts = String(value).split("/").filter(Boolean);
    return parts[parts.length - 1] || value;
  }

  function renderStorageProviders(container, providers) {
    const list = container.querySelector(".ocp-drawer__provider-list");
    const select = container.querySelector(".ocp-drawer__mount-provider-select");
    if (select) {
      if (!Array.isArray(providers) || providers.length === 0) {
        select.innerHTML = `<option value="">No shared storage accounts configured</option>`;
      } else {
        select.innerHTML = providers.map((provider) => `<option value="${escapeHtml(provider.id)}" data-provider-type="${escapeHtml(provider.type)}">${escapeHtml(provider.name)} · ${escapeHtml(provider.type)}</option>`).join("");
      }
    }
    if (!list) return;
    if (!Array.isArray(providers) || providers.length === 0) {
      list.innerHTML = `<p class="ocp-drawer__empty-config">No shared storage accounts yet. Choose + to add one.</p>`;
      return;
    }
    list.innerHTML = providers.map((provider) => `
      <div class="ocp-drawer__profile-card ocp-drawer__provider-row" data-provider-id="${escapeHtml(provider.id)}">
        <span class="ocp-drawer__profile-card-copy">
          <strong>${escapeHtml(provider.name)}</strong>
          <em>${escapeHtml(provider.type)}</em>
          <small>${escapeHtml(provider.remote?.host || provider.remote?.rclone_remote || provider.remote?.share || "Connected storage")}</small>
        </span>
        <div class="ocp-drawer__profile-card-actions">
          <button type="button" class="ocp-drawer__icon-action ocp-drawer__provider-test" aria-label="Test ${escapeHtml(provider.name)}" title="Test shared storage account">✓</button>
          <button type="button" class="ocp-drawer__icon-action ocp-drawer__provider-edit" aria-label="Edit ${escapeHtml(provider.name)}" title="Edit shared storage account">✎</button>
          <button type="button" class="ocp-drawer__icon-action ocp-drawer__icon-action--danger ocp-drawer__provider-delete" aria-label="Delete ${escapeHtml(provider.name)}" title="Delete shared storage account">×</button>
        </div>
        <small class="ocp-drawer__provider-test-status" hidden></small>
      </div>
    `).join("");
  }

  async function refreshStorageProviders(container) {
    const list = container.querySelector(".ocp-drawer__provider-list");
    try {
      const response = await fetchStorageProviders();
      const providers = response.providers || [];
      container.__ocpStorageProviders = providers;
      renderStorageProviders(container, providers);
      updateWorkspaceFolderMappingProviderFields(container);
      return providers;
    } catch (error) {
      if (list) list.innerHTML = `<p class="ocp-drawer__empty-config">Shared storage accounts unavailable: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
      return [];
    }
  }

  function beginStorageProviderEdit(container, provider) {
    if (!provider) return;
    showStorageProviderEditor(container);
    const editId = container.querySelector(".ocp-drawer__provider-edit-id");
    const nameInput = container.querySelector(".ocp-drawer__provider-name");
    const typeInput = container.querySelector(".ocp-drawer__provider-type");
    const hostInput = container.querySelector(".ocp-drawer__provider-host");
    const portInput = container.querySelector(".ocp-drawer__provider-port");
    const usernameInput = container.querySelector(".ocp-drawer__provider-username");
    const passwordInput = container.querySelector(".ocp-drawer__provider-password");
    const privateKeyInput = container.querySelector(".ocp-drawer__provider-private-key");
    const tokenInput = container.querySelector(".ocp-drawer__provider-google-token");
    const clientIdInput = container.querySelector(".ocp-drawer__provider-google-client-id");
    const clientSecretInput = container.querySelector(".ocp-drawer__provider-google-client-secret");
    const saveButton = container.querySelector(".ocp-drawer__provider-save");
    if (editId) editId.value = provider.id || "";
    if (nameInput) nameInput.value = provider.name || "";
    if (typeInput) typeInput.value = provider.type || "google_drive";
    if (hostInput) hostInput.value = provider.remote?.host || provider.remote?.rclone_remote || "";
    if (portInput) portInput.value = provider.remote?.port || "";
    if (usernameInput) usernameInput.value = provider.remote?.username || "";
    showSavedSecretPlaceholder(passwordInput);
    showSavedSecretPlaceholder(privateKeyInput);
    showSavedSecretPlaceholder(tokenInput);
    if (clientIdInput) clientIdInput.value = provider.remote?.client_id || "";
    showSavedSecretPlaceholder(clientSecretInput);
    if (saveButton) saveButton.textContent = "Update Storage Account";
    container.querySelector(".ocp-drawer__provider-cancel-edit")?.classList.remove("ocp-drawer__mount-field--hidden");
    const title = container.querySelector(".ocp-drawer__provider-editor-title");
    if (title) title.textContent = "Edit shared storage account";
    const detail = container.querySelector(".ocp-drawer__provider-save-detail");
    if (detail) detail.textContent = `Editing ${provider.name || provider.id}. Leave password, private key, token, or client secret blank to keep saved secrets.`;
    updateStorageProviderFields(container);
  }

  function clearStorageProviderEdit(container) {
    showStorageProviderEditor(container);
    const fields = [
      ".ocp-drawer__provider-edit-id",
      ".ocp-drawer__provider-name",
      ".ocp-drawer__provider-host",
      ".ocp-drawer__provider-port",
      ".ocp-drawer__provider-username",
      ".ocp-drawer__provider-password",
      ".ocp-drawer__provider-private-key",
      ".ocp-drawer__provider-google-client-id",
      ".ocp-drawer__provider-google-client-secret",
      ".ocp-drawer__provider-google-token",
    ];
    fields.forEach((selector) => {
      const field = container.querySelector(selector);
      if (field?.classList?.contains("ocp-drawer__masked-secret")) {
        clearSecretField(field);
      } else if (field) {
        field.value = "";
        restorePlaceholder(field);
      }
    });
    const typeInput = container.querySelector(".ocp-drawer__provider-type");
    if (typeInput) typeInput.value = "google_drive";
    const saveButton = container.querySelector(".ocp-drawer__provider-save");
    if (saveButton) saveButton.textContent = "Save Storage Account";
    container.querySelector(".ocp-drawer__provider-cancel-edit")?.classList.add("ocp-drawer__mount-field--hidden");
    const title = container.querySelector(".ocp-drawer__provider-editor-title");
    if (title) title.textContent = "New shared storage account";
    const detail = container.querySelector(".ocp-drawer__provider-save-detail");
    if (detail) detail.textContent = "Storage accounts save reusable credentials only. Choose the synced folder in the next section.";
    updateStorageProviderFields(container);
  }

  function showStorageProviderEditor(container) {
    container.querySelector(".ocp-drawer__profile-shell--providers")?.classList.remove("ocp-drawer__profile-shell--list-only");
    container.querySelector(".ocp-drawer__profile-shell--providers")?.classList.add("ocp-drawer__profile-shell--editing");
    const listPanel = container.querySelector(".ocp-drawer__profile-list-panel--providers");
    if (listPanel) listPanel.hidden = true;
    const editor = container.querySelector(".ocp-drawer__profile-editor-panel--providers");
    if (editor) editor.hidden = false;
  }

  function hideStorageProviderEditor(container) {
    container.querySelector(".ocp-drawer__profile-shell--providers")?.classList.add("ocp-drawer__profile-shell--list-only");
    container.querySelector(".ocp-drawer__profile-shell--providers")?.classList.remove("ocp-drawer__profile-shell--editing");
    const listPanel = container.querySelector(".ocp-drawer__profile-list-panel--providers");
    if (listPanel) listPanel.hidden = false;
    const editor = container.querySelector(".ocp-drawer__profile-editor-panel--providers");
    if (editor) editor.hidden = true;
  }

  function beginWorkspaceFolderMappingEdit(container, mount) {
    if (!mount) return;
    showWorkspaceFolderMappingEditor(container);
    const editId = container.querySelector(".ocp-drawer__mount-edit-id");
    const nameInput = container.querySelector(".ocp-drawer__mount-name");
    const pathInput = container.querySelector(".ocp-drawer__mount-path");
    const readOnly = container.querySelector(".ocp-drawer__mount-read-only");
    const autoReconnect = container.querySelector(".ocp-drawer__mount-auto-reconnect");
    const saveButton = container.querySelector(".ocp-drawer__mount-save");
    const cancelButton = container.querySelector(".ocp-drawer__mount-cancel-edit");
    if (editId) editId.value = mount.id || "";
    if (nameInput) nameInput.value = mount.name || "";
    if (pathInput) pathInput.value = mount.remote?.path || mount.remote?.share || "";
    if (readOnly) readOnly.checked = Boolean(mount.options?.read_only);
    if (autoReconnect) autoReconnect.checked = Boolean(mount.options?.auto_reconnect);
    if (saveButton) saveButton.textContent = "Update Synced Folder";
    cancelButton?.classList.remove("ocp-drawer__mount-field--hidden");
    const title = container.querySelector(".ocp-drawer__mount-editor-title");
    if (title) title.textContent = "Edit synced workspace folder";
    const detail = container.querySelector(".ocp-drawer__mount-save-detail");
    if (detail) detail.textContent = `Editing ${mount.name || mount.id}. Update the shared folder or local mount folder, then save.`;
    updateWorkspaceFolderMappingProviderFields(container);
  }

  function clearWorkspaceFolderMappingEdit(container) {
    showWorkspaceFolderMappingEditor(container);
    const editId = container.querySelector(".ocp-drawer__mount-edit-id");
    if (editId) editId.value = "";
    const nameInput = container.querySelector(".ocp-drawer__mount-name");
    const pathInput = container.querySelector(".ocp-drawer__mount-path");
    if (nameInput) nameInput.value = "";
    if (pathInput) pathInput.value = "";
    const saveButton = container.querySelector(".ocp-drawer__mount-save");
    if (saveButton) saveButton.textContent = "Save Synced Folder";
    container.querySelector(".ocp-drawer__mount-cancel-edit")?.classList.add("ocp-drawer__mount-field--hidden");
    const title = container.querySelector(".ocp-drawer__mount-editor-title");
    if (title) title.textContent = "New synced workspace folder";
  }

  function showWorkspaceFolderMappingEditor(container) {
    container.querySelector(".ocp-drawer__profile-shell--links")?.classList.remove("ocp-drawer__profile-shell--list-only");
    container.querySelector(".ocp-drawer__profile-shell--links")?.classList.add("ocp-drawer__profile-shell--editing");
    const listPanel = container.querySelector(".ocp-drawer__profile-list-panel--links");
    if (listPanel) listPanel.hidden = true;
    const editor = container.querySelector(".ocp-drawer__profile-editor-panel--links");
    if (editor) editor.hidden = false;
  }

  function hideWorkspaceFolderMappingEditor(container) {
    container.querySelector(".ocp-drawer__profile-shell--links")?.classList.add("ocp-drawer__profile-shell--list-only");
    container.querySelector(".ocp-drawer__profile-shell--links")?.classList.remove("ocp-drawer__profile-shell--editing");
    const listPanel = container.querySelector(".ocp-drawer__profile-list-panel--links");
    if (listPanel) listPanel.hidden = false;
    const editor = container.querySelector(".ocp-drawer__profile-editor-panel--links");
    if (editor) editor.hidden = true;
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
      if (detail) detail.textContent = "Save the SMB server/account here. Choose the shared folder in Synced Workspace Folders.";
    } else if (type === "ssh") {
      if (hostLabel) hostLabel.textContent = "Host";
      if (hostInput) hostInput.placeholder = "server.local";
      if (detail) detail.textContent = "Save the SSH/SFTP server here. Choose the shared folder in Synced Workspace Folders.";
    } else if (detail) {
      detail.textContent = "Save the Google Drive account here. Choose the Drive folder in Synced Workspace Folders.";
    }
  }

  function updateWorkspaceFolderMappingProviderFields(container) {
    const providerSelect = container.querySelector(".ocp-drawer__mount-provider-select");
    const type = providerSelect?.selectedOptions?.[0]?.dataset?.providerType || "";
    const autoReconnect = container.querySelector(".ocp-drawer__mount-auto-reconnect");
    const detail = container.querySelector(".ocp-drawer__mount-save-detail");
    setMountFieldVisible(container, "browse", type === "google_drive");
    if (!autoReconnect) return;
    if (type === "google_drive") {
      autoReconnect.disabled = false;
      if (detail && !container.querySelector(".ocp-drawer__mount-edit-id")?.value) {
        detail.textContent = "Live mount makes Google Drive appear as a local folder. It requires container FUSE/SYS_ADMIN permissions.";
      }
    } else {
      autoReconnect.disabled = false;
      if (detail && !container.querySelector(".ocp-drawer__mount-edit-id")?.value) {
        detail.textContent = type ? "Save the synced workspace folder, then use Test or Connect below." : "Choose a shared storage account first.";
      }
    }
  }

  function renderBrowseFolders(container, providerId, path, folders) {
    const pathView = container.querySelector(".ocp-drawer__browse-path");
    const list = container.querySelector(".ocp-drawer__browse-list");
    if (!pathView || !list) return;
    const cleanPath = String(path || "").replace(/^\/+|\/+$/g, "");
    const pathInput = container.querySelector(".ocp-drawer__mount-path");
    if (pathInput) pathInput.value = cleanPath;
    pathView.hidden = false;
    const breadcrumb = cleanPath
      ? [`<button type="button" class="ocp-drawer__browse-open" data-path="">My Drive</button>`, ...cleanPath.split("/").map((part, index, parts) => {
        const crumbPath = parts.slice(0, index + 1).join("/");
        return `<button type="button" class="ocp-drawer__browse-open" data-path="${escapeHtml(crumbPath)}">${escapeHtml(part)}</button>`;
      })].join("<span>/</span>")
      : `<strong>My Drive</strong>`;
    pathView.innerHTML = `<span class="ocp-drawer__browse-path-label">Location</span><span class="ocp-drawer__browse-crumbs">${breadcrumb}</span>`;
    list.hidden = false;
    const upPath = cleanPath.split("/").slice(0, -1).join("/");
    const currentButton = `<div class="ocp-drawer__browse-toolbar"><button type="button" class="ocp-drawer__button ocp-drawer__browse-select" data-path="${escapeHtml(cleanPath)}">Choose this folder</button></div>`;
    const upRow = cleanPath ? `<button type="button" class="ocp-drawer__browse-row ocp-drawer__browse-open" data-path="${escapeHtml(upPath)}"><span class="ocp-drawer__browse-icon">↰</span><strong>Parent folder</strong><small>${escapeHtml(upPath || "My Drive")}</small></button>` : "";
    if (!Array.isArray(folders) || folders.length === 0) {
      list.innerHTML = `${currentButton}${upRow}<p class="ocp-drawer__browse-empty">This folder has no subfolders. Choose this folder or type a path manually.</p>`;
      return;
    }
    list.innerHTML = `${currentButton}${upRow}${folders.map((folder) => {
      const folderPath = folder.path || folder.name || "";
      return `<div class="ocp-drawer__browse-row"><button type="button" class="ocp-drawer__browse-folder ocp-drawer__browse-open" data-path="${escapeHtml(folderPath)}"><span class="ocp-drawer__browse-icon">📁</span><strong>${escapeHtml(folder.name || folderPath)}</strong><small>${escapeHtml(folderPath)}</small></button><button type="button" class="ocp-drawer__button ocp-drawer__browse-select" data-path="${escapeHtml(folderPath)}">Choose</button></div>`;
    }).join("")}`;
    list.dataset.providerId = providerId;
    list.dataset.path = cleanPath;
  }

  async function loadBrowseFolders(container, path = "") {
    const providerSelect = container.querySelector(".ocp-drawer__mount-provider-select");
    const providerId = providerSelect?.value || "";
    const list = container.querySelector(".ocp-drawer__browse-list");
    const pathView = container.querySelector(".ocp-drawer__browse-path");
    if (!providerId) {
      if (list) {
        list.hidden = false;
        list.innerHTML = `<p class="ocp-drawer__browse-empty">Choose a shared storage account first.</p>`;
      }
      return;
    }
    if (pathView) {
      pathView.hidden = false;
      pathView.textContent = "Loading folders...";
    }
    if (list) {
      list.hidden = false;
      list.innerHTML = `<p class="ocp-drawer__browse-empty">Loading...</p>`;
    }
    try {
      const response = await browseStorageProvider(providerId, path);
      renderBrowseFolders(container, providerId, response.path || path, response.folders || []);
    } catch (error) {
      if (list) list.innerHTML = `<p class="ocp-drawer__browse-empty">Browse failed: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
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
      if (pathInput) pathInput.placeholder = "/srv/project";
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
    setupMaskedSecretFields(container);
    refreshMounts(container);
    refreshStorageProviders(container);
    updateStorageProviderFields(container);
    refreshGoogleDriveAccounts(container);
    container.querySelector(".ocp-drawer__provider-type")?.addEventListener("change", () => updateStorageProviderFields(container));
    container.querySelector(".ocp-drawer__mount-provider-select")?.addEventListener("change", () => {
      updateWorkspaceFolderMappingProviderFields(container);
      const list = container.querySelector(".ocp-drawer__browse-list");
      const pathView = container.querySelector(".ocp-drawer__browse-path");
      if (list) {
        list.hidden = true;
        list.innerHTML = "";
      }
      if (pathView) {
        pathView.hidden = true;
        pathView.textContent = "";
      }
    });
    container.querySelector(".ocp-drawer__browse-load")?.addEventListener("click", () => loadBrowseFolders(container, container.querySelector(".ocp-drawer__mount-path")?.value || ""));
    container.querySelector(".ocp-drawer__provider-new")?.addEventListener("click", () => clearStorageProviderEdit(container));
    container.querySelector(".ocp-drawer__provider-cancel-edit")?.addEventListener("click", () => {
      clearStorageProviderEdit(container);
      hideStorageProviderEditor(container);
    });
    container.querySelector(".ocp-drawer__mount-new")?.addEventListener("click", () => {
      clearWorkspaceFolderMappingEdit(container);
      const detail = container.querySelector(".ocp-drawer__mount-save-detail");
      if (detail) detail.textContent = "Choose a shared storage account first.";
      updateWorkspaceFolderMappingProviderFields(container);
    });
    container.querySelector(".ocp-drawer__provider-save")?.addEventListener("click", async () => {
      const detail = container.querySelector(".ocp-drawer__provider-save-detail");
      const type = container.querySelector(".ocp-drawer__provider-type")?.value || "google_drive";
      const name = container.querySelector(".ocp-drawer__provider-name")?.value || "";
      const editId = container.querySelector(".ocp-drawer__provider-edit-id")?.value || "";
      const existingProvider = editId ? (container.__ocpStorageProviders || []).find((provider) => provider.id === editId) : null;
      const host = container.querySelector(".ocp-drawer__provider-host")?.value || "";
      const port = container.querySelector(".ocp-drawer__provider-port")?.value || "";
      const username = container.querySelector(".ocp-drawer__provider-username")?.value || "";
      const password = container.querySelector(".ocp-drawer__provider-password")?.value || "";
      const privateKey = secretFieldValue(container.querySelector(".ocp-drawer__provider-private-key"));
      const token = secretFieldValue(container.querySelector(".ocp-drawer__provider-google-token"));
      const clientId = container.querySelector(".ocp-drawer__provider-google-client-id")?.value || "";
      const clientSecret = container.querySelector(".ocp-drawer__provider-google-client-secret")?.value || "";
      const remote = {};
      const secret = {};
      let providerName = name;
      try {
        if (type === "google_drive") {
          providerName = name || "gdrive";
          if (!editId && !token.trim()) {
            if (detail) detail.textContent = "Paste the authorization token JSON from rclone authorize before saving.";
            return;
          }
          if ((!editId || token.trim()) && (!clientId.trim() || !clientSecret.trim())) {
            if (detail) detail.textContent = "Google OAuth Client ID and Client Secret are required for Google Drive providers.";
            return;
          }
          if (token.trim()) {
            if (detail) detail.textContent = "Connecting Google Drive account...";
            const response = await connectGoogleDriveAccount({ name: providerName, token, clientId, clientSecret });
            providerName = response.account || providerName;
          }
          const remoteName = token.trim() ? providerName : (existingProvider?.remote?.rclone_remote || existingProvider?.remote?.host || providerName);
          remote.rclone_remote = remoteName;
          remote.host = remoteName;
          if (clientId.trim()) remote.client_id = clientId.trim();
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
        if (detail) detail.textContent = "Saving shared storage account...";
        if (editId) {
          await updateStorageProvider(editId, { name: providerName, type, remote, secret });
        } else {
          await createStorageProvider({ name: providerName, type, remote, secret });
        }
        clearStorageProviderEdit(container);
        hideStorageProviderEditor(container);
        clearSecretField(container.querySelector(".ocp-drawer__provider-google-token"));
        container.querySelector(".ocp-drawer__provider-google-client-secret").value = "";
        if (detail) detail.textContent = editId ? "Shared storage account updated." : "Shared storage account saved.";
        await refreshStorageProviders(container);
      } catch (error) {
        if (detail) detail.textContent = `Shared storage save failed: ${error instanceof Error ? error.message : String(error)}`;
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
      const syncMode = type === "google_drive" ? "mount" : "";
      const autoReconnect = Boolean(container.querySelector(".ocp-drawer__mount-auto-reconnect")?.checked);
      const editId = container.querySelector(".ocp-drawer__mount-edit-id")?.value || "";
      const remote = { path: remotePath, share: remotePath };
      if (!providerId) {
        if (detail) detail.textContent = "Save a shared storage account first.";
        return;
      }
      if (detail) detail.textContent = "Saving synced workspace folder...";
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
        clearWorkspaceFolderMappingEdit(container);
        hideWorkspaceFolderMappingEditor(container);
        if (detail) detail.textContent = editId ? "Synced workspace folder updated." : "Synced workspace folder saved. Use Connect below.";
        await refreshMounts(container);
      } catch (error) {
        if (detail) detail.textContent = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    container.querySelector(".ocp-drawer__mount-cancel-edit")?.addEventListener("click", () => {
      clearWorkspaceFolderMappingEdit(container);
      hideWorkspaceFolderMappingEditor(container);
      container.querySelector(".ocp-drawer__mount-save-detail").textContent = "Choose a shared storage account first.";
    });
    container.addEventListener("click", async (event) => {
      const providerRow = event.target?.closest?.(".ocp-drawer__provider-row");
      if (providerRow && event.target.closest?.(".ocp-drawer__provider-edit")) {
        beginStorageProviderEdit(container, (container.__ocpStorageProviders || []).find((provider) => provider.id === providerRow.dataset.providerId));
        return;
      }
      if (providerRow && event.target.closest?.(".ocp-drawer__provider-test")) {
        const button = event.target.closest(".ocp-drawer__provider-test");
        const statusLine = providerRow.querySelector(".ocp-drawer__provider-test-status");
        const original = button?.textContent || "✓";
        if (button) {
          button.disabled = true;
          button.textContent = "…";
        }
        if (statusLine) {
          statusLine.hidden = false;
          statusLine.classList.remove("ocp-drawer__provider-test-status--ok", "ocp-drawer__provider-test-status--error");
            statusLine.textContent = "Testing shared storage account...";
        }
        try {
          const result = await testStorageProvider(providerRow.dataset.providerId);
          const status = result?.status || {};
          const ok = result?.ok || status.status === "connected";
          if (statusLine) {
            statusLine.classList.toggle("ocp-drawer__provider-test-status--ok", ok);
            statusLine.classList.toggle("ocp-drawer__provider-test-status--error", !ok);
            statusLine.textContent = ok ? "Shared storage test passed." : `Shared storage test failed: ${status.last_error || mountStatusLabel(status.status || "error")}`;
          }
        } catch (error) {
          if (statusLine) {
            statusLine.classList.add("ocp-drawer__provider-test-status--error");
            statusLine.textContent = `Shared storage test failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        } finally {
          if (button) {
            button.disabled = false;
            button.textContent = original;
          }
        }
        return;
      }
      if (providerRow && event.target.closest?.(".ocp-drawer__provider-delete")) {
          if (!window.confirm("Delete this shared storage account? Existing synced workspace folders will not be deleted.")) return;
        try {
          await deleteStorageProvider(providerRow.dataset.providerId);
          await refreshStorageProviders(container);
        } catch (error) {
          window.alert(`Shared storage delete failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      const browseOpen = event.target.closest?.(".ocp-drawer__browse-open");
      if (browseOpen) {
        await loadBrowseFolders(container, browseOpen.dataset.path || "");
        return;
      }
      const browseSelect = event.target.closest?.(".ocp-drawer__browse-select");
      if (browseSelect) {
        const pathInput = container.querySelector(".ocp-drawer__mount-path");
        if (pathInput) pathInput.value = browseSelect.dataset.path || "";
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
          beginWorkspaceFolderMappingEdit(container, mounts.find((item) => item.id === id));
          return;
        } else if (deleteButton) {
          if (!window.confirm("Delete this synced workspace folder? The remote files will not be deleted.")) return;
          await deleteMount(id);
        } else if (actionButton) {
          const action = actionButton.dataset.action;
          const label = action === "test" ? "Testing Synced Workspace Folder" : action === "connect" ? (actionButton.textContent.trim() || "Connecting Synced Workspace Folder") : "Updating Synced Workspace Folder";
          const overlay = showWorkspaceFolderMappingOverlay(document.querySelector("#opencode-plus-drawer"), label, action === "test" ? "Checking the shared storage account and remote folder..." : "Starting the synced workspace folder action...");
          try {
            const result = await mountAction(id, action);
            await refreshMountsUntilSettled(container, id);
            if (action === "test") {
              const status = result?.status || {};
              const ok = result?.ok || status.status === "connected" || status.status === "synced";
              finishWorkspaceFolderMappingOverlay(overlay, ok ? "Test Passed" : "Test Failed", ok ? "The shared storage account and remote folder are reachable." : (status.last_error || `Status: ${mountStatusLabel(status.status || "error")}`));
            } else {
              finishWorkspaceFolderMappingOverlay(overlay, "Action Complete", "Synced workspace folder status has been refreshed.");
            }
          } catch (error) {
            finishWorkspaceFolderMappingOverlay(overlay, action === "test" ? "Test Failed" : "Action Failed", error instanceof Error ? error.message : String(error));
          }
          return;
        } else {
          return;
        }
        await refreshMounts(container);
      } catch (error) {
        window.alert(`Synced workspace folder action failed: ${error instanceof Error ? error.message : String(error)}`);
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
          <textarea class="ocp-drawer__field ocp-drawer__gemini-creds ocp-drawer__masked-secret" autocomplete="off" spellcheck="false" placeholder='{"refresh_token":"..."}'></textarea>
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
    modal.classList.remove("ocp-drawer__modal--help", "ocp-drawer__modal--storage");
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

  function collapseSettingsSections(container) {
    container.querySelectorAll(".ocp-drawer__system-section").forEach((section) => {
      if (section.dataset.collapsibleReady === "true") return;
      const heading = Array.from(section.children).find((child) => child.tagName === "H4");
      if (!heading) return;
      const details = document.createElement("details");
      Array.from(section.attributes).forEach((attribute) => details.setAttribute(attribute.name, attribute.value));
      details.dataset.collapsibleReady = "true";
      const summary = document.createElement("summary");
      summary.className = "ocp-drawer__system-section-summary";
      summary.textContent = heading.textContent || "Settings";
      const content = document.createElement("div");
      content.className = "ocp-drawer__system-section-content";
      Array.from(section.childNodes).forEach((node) => {
        if (node !== heading) content.append(node);
      });
      details.append(summary, content);
      section.replaceWith(details);
    });
  }

  function openConfigArea(root, area, settings) {
    const modal = root.querySelector(".ocp-drawer__modal");
    const title = modal.querySelector(".ocp-drawer__modal-title");
    const body = modal.querySelector(".ocp-drawer__modal-body");
    modal.classList.remove("ocp-drawer__modal--help", "ocp-drawer__modal--storage");
    title.textContent = area.label;

    if (area.id === "restart") {
      body.innerHTML = restartConfigMarkup();
      collapseSettingsSections(body);
      setupRestartControls(body);
    } else if (area.id === "system") {
      body.innerHTML = systemConfigMarkup();
      collapseSettingsSections(body);
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
      collapseSettingsSections(body);
      setupHiddenSettingsControls(body);
    } else if (area.id === "soul") {
      modal.classList.add("ocp-drawer__modal--storage");
      body.innerHTML = soulSyncMarkup();
      collapseSettingsSections(body);
      setupSoulSyncControls(body, root, settings);
      setupMountManagerControls(body);
    } else if (area.id === "storage-providers") {
      modal.classList.add("ocp-drawer__modal--storage");
      body.innerHTML = mountManagerMarkup("providers");
      setupMountManagerControls(body);
    } else if (area.id === "workspace-links") {
      modal.classList.add("ocp-drawer__modal--storage");
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
    modal.classList.remove("ocp-drawer__modal--storage");
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

  async function refreshSyncedWorkspaceHeader(root) {
    const button = root.querySelector(".ocp-drawer__sync-refresh-header");
    const syncDetail = root.querySelector(".ocp-drawer__sync-action-detail");
    if (button) {
      button.disabled = true;
      button.classList.add("ocp-drawer__icon-button--spinning");
    }
    if (syncDetail) syncDetail.textContent = "Refreshing OpenCode Plus...";
    setOpenCodePlusHeaderNotice(root, "Refreshing OpenCode Plus...", "info");
    try {
      const refreshSync = root.__ocpRefreshSoulSync;
      const sessionSync = await withTimeout(syncSyncedProjectSessions(), 75_000, "Session sync");
      if (typeof refreshSync === "function") {
        await withTimeout(refreshSync(), 20_000, "Synchronization status refresh");
      } else {
        const status = await withTimeout(fetchSoulStatus(), 10_000, "Synchronization status refresh");
        updateInstanceBadge(root, status);
        await Promise.allSettled([withTimeout(fetchNamedWorkspaces(), 10_000, "Workspace refresh"), withTimeout(fetchSyncedProjects(), 10_000, "Project refresh")]);
      }
      await withTimeout(refreshNativeOpenCodeProjects(), 10_000, "OpenCode project refresh");
      if (syncDetail) {
        const changed = Number(sessionSync?.exported || 0) + Number(sessionSync?.imported || 0) + Number(sessionSync?.indexed || 0);
        const message = changed
          ? `OpenCode Plus refreshed. Sessions exported ${sessionSync.exported || 0}, imported ${sessionSync.imported || 0}, indexed ${sessionSync.indexed || 0}.`
          : "OpenCode Plus refreshed. No session changes needed.";
        syncDetail.textContent = message;
        setOpenCodePlusHeaderNotice(root, message, "success");
      }
      scheduleOpenCodeViewRefreshAfterImport(root, sessionSync);
    } catch (error) {
      const message = `OpenCode Plus refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      if (syncDetail) syncDetail.textContent = message;
      setOpenCodePlusHeaderNotice(root, message, "error");
      throw error;
    } finally {
      if (button) {
        button.disabled = false;
        button.classList.remove("ocp-drawer__icon-button--spinning");
      }
    }
  }

  function closeModuleConfig(root) {
    const modal = root.querySelector(".ocp-drawer__modal");
    if (modal) modal.hidden = true;
  }

  function setOpen(root, settings, open) {
    settings.open = open;
    updateDrawerPanelHeight(root);
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
          <div class="ocp-drawer__header-notice" role="status" hidden></div>
        </div>
        <div class="ocp-drawer__header-actions">
          <button type="button" class="ocp-drawer__icon-button ocp-drawer__sync-refresh-header" aria-label="Refresh OpenCode Plus" title="Refresh OpenCode Plus"><span class="ocp-drawer__icon-glyph" aria-hidden="true">⇄</span></button>
          <button type="button" class="ocp-drawer__icon-button ocp-drawer__opencode-restart-header" aria-label="Restart OpenCode server" title="Restart OpenCode server"><span class="ocp-drawer__icon-glyph" aria-hidden="true">⏻</span></button>
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
    panel.querySelector(".ocp-drawer__sync-refresh-header")?.addEventListener("click", () => refreshSyncedWorkspaceHeader(root));
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
    installSyncedProjectAvatarEnhancer();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();

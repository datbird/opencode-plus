(() => {
  if (window.__ocesContentScriptLoaded) return;
  window.__ocesContentScriptLoaded = true;

  const SIDECAR_ID = "oc-webui-sidecar";
  const SPACER_ATTR = "data-oc-sidecar-spacer";
  const UPDATE_INTERVAL_MS = 1_000;
  const STORAGE_KEY = "opencodePlusDrawerSettings";
  const DEBUG_STORAGE_KEY = "opencodePlusStatuslineDebug";
  const TYPE_CHEVRON = "oc-sidecar-type-chevron";
  const TYPE_DROPDOWN = "oc-sidecar-type-dropdown";
  const TYPE_SMALL_CHIP = "oc-sidecar-type-small-chip";
  const TYPE_LARGE_CHIP = "oc-sidecar-type-large-chip";
  const COMPOSER_CONTROL_SELECTOR = [
    "[data-component='prompt-agent-control']",
    "[data-action='prompt-agent']",
    "[data-component='prompt-model-control']",
    "[data-component='prompt-variant-control']",
    "[data-action='prompt-model-variant']",
    ".oc-webui-sidecar-control-row",
  ].join(", ");
  const DEFAULT_QUOTA_URL = "/__opencode-plus/quota";
  const WRAPPED_BASE_RESERVE_PX = 72;
  const WRAPPED_EXTRA_ROW_RESERVE_PX = 38;
  const CF_AUTH_REDIRECT_COOLDOWN_MS = 15_000;
  const ANCHOR_MISS_GRACE_MS = 2_500;
  const QUOTA_FETCH_TIMEOUT_MS = 10_000;
  const browserApi = globalThis.browser || globalThis.chrome;
  const isExtensionRuntime = Boolean(browserApi?.runtime?.id && browserApi?.runtime?.sendMessage);
  const defaultModuleOrder = ["openai", "openrouter", "gemini", "claude", "deepseek", "siliconflow", "moonshot", "fireworks", "xai"];
  const defaultModuleRows = { openai: 1, openrouter: 1, gemini: 1, claude: 2, deepseek: 2, siliconflow: 2, moonshot: 2, fireworks: 2, xai: 2 };
  const defaultSettings = { modules: { openai: true, openrouter: false, gemini: true, claude: false, deepseek: false, siliconflow: false, moonshot: false, fireworks: false, xai: false }, moduleOrder: defaultModuleOrder, moduleRows: defaultModuleRows, refreshIntervalSeconds: 30, quotaUrl: DEFAULT_QUOTA_URL, keepOpenCodeAlive: true, nativeControlsCollapsed: false };
  let settings = defaultSettings;
  let quotaState = { updatedAt: null, providers: [], status: "loading" };
  let lastQuotaFetch = 0;
  let lastSuccessfulQuotaState = null;
  let lastCfAuthRedirect = 0;
  const mountTimers = new Set();
  let lastPageStatusUpdate = 0;
  let lastAnchoredAt = 0;

  console.info("[OpenCode Enhancement Suite] content script loaded", location.href);

  function debugStatusline(event, details = {}) {
    if (localStorage.getItem(DEBUG_STORAGE_KEY) !== "true") return;
    const row = findEffortDropdown()?.closest?.(".oc-webui-sidecar-control-row") || document.querySelector(".oc-webui-sidecar-control-row");
    const sidecar = document.getElementById(SIDECAR_ID);
    const chevron = row?.querySelector?.(`.${TYPE_CHEVRON}`);
    const rowRect = row?.getBoundingClientRect?.();
    const sidecarRect = sidecar?.getBoundingClientRect?.();
    const chevronRect = chevron?.getBoundingClientRect?.();
    const payload = {
      collapsed: Boolean(settings.nativeControlsCollapsed),
      rowClasses: row?.className || null,
      visualRows: row?.dataset?.ocSidecarVisualRows || null,
      row: rowRect ? { top: Math.round(rowRect.top), height: Math.round(rowRect.height), bottom: Math.round(rowRect.bottom) } : null,
      sidecar: sidecarRect ? { top: Math.round(sidecarRect.top), height: Math.round(sidecarRect.height), bottom: Math.round(sidecarRect.bottom), parent: sidecar.parentElement?.className || sidecar.parentElement?.tagName } : null,
      chevron: chevronRect ? { top: Math.round(chevronRect.top), height: Math.round(chevronRect.height), bottom: Math.round(chevronRect.bottom), previous: chevron.previousElementSibling?.className || chevron.previousElementSibling?.tagName, next: chevron.nextElementSibling?.id || chevron.nextElementSibling?.className || chevron.nextElementSibling?.tagName } : null,
      ...details,
    };
    console.info("[OpenCode Plus statusline]", event, JSON.stringify(payload));
  }

  function storageGet() {
    if (!isExtensionRuntime || !browserApi?.storage?.local) {
      try {
        return Promise.resolve({ [STORAGE_KEY]: JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || defaultSettings });
      } catch {
        return Promise.resolve({ [STORAGE_KEY]: defaultSettings });
      }
    }
    if (browserApi.storage.local.get.length <= 1) return browserApi.storage.local.get(STORAGE_KEY);
    return new Promise((resolve) => browserApi.storage.local.get(STORAGE_KEY, resolve));
  }

  function mergeSettings(value) {
    const quotaUrl = isExtensionRuntime ? value?.quotaUrl || defaultSettings.quotaUrl : DEFAULT_QUOTA_URL;
    return {
      modules: {
        ...defaultSettings.modules,
        ...(value?.modules || {}),
      },
      moduleOrder: Array.isArray(value?.moduleOrder)
        ? [...value.moduleOrder, ...defaultModuleOrder.filter((id) => !value.moduleOrder.includes(id))]
        : defaultSettings.moduleOrder,
      moduleRows: {
        ...defaultSettings.moduleRows,
        ...(value?.moduleRows || {}),
      },
      refreshIntervalSeconds: value?.refreshIntervalSeconds || defaultSettings.refreshIntervalSeconds,
      quotaUrl,
      keepOpenCodeAlive: value?.keepOpenCodeAlive ?? defaultSettings.keepOpenCodeAlive,
      nativeControlsCollapsed: value?.nativeControlsCollapsed ?? defaultSettings.nativeControlsCollapsed,
    };
  }

  function storageSet(value) {
    if (!isExtensionRuntime || !browserApi?.storage?.local) {
      const next = value?.[STORAGE_KEY] || value;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...(settings || {}), ...(next || {}) }));
      window.dispatchEvent(new CustomEvent("opencode-plus:settings", { detail: settings }));
      return Promise.resolve();
    }
    if (browserApi.storage.local.set.length <= 1) return browserApi.storage.local.set(value);
    return new Promise((resolve) => browserApi.storage.local.set(value, resolve));
  }

  async function saveSettings() {
    await storageSet({ [STORAGE_KEY]: settings });
  }

  async function fetchQuotaData(force = false) {
    const intervalMs = Math.max(5, Number(settings.refreshIntervalSeconds || 30)) * 1000;
    if (!force && Date.now() - lastQuotaFetch < intervalMs) return false;
    lastQuotaFetch = Date.now();

    const previousSignature = JSON.stringify(quotaState);
    try {
      if (isExtensionRuntime) {
        const response = await browserApi.runtime.sendMessage({
          type: "quota.fetch",
          url: settings.quotaUrl || DEFAULT_QUOTA_URL,
        });
        if (!response?.ok) throw new Error(response?.error || "Quota bridge unavailable");
        quotaState = { ...response.data, status: "ok" };
      } else {
        quotaState = { ...await fetchQuotaJson(settings.quotaUrl || DEFAULT_QUOTA_URL), status: "ok" };
      }
      lastSuccessfulQuotaState = quotaState;
    } catch (error) {
      quotaState = lastSuccessfulQuotaState ? { ...lastSuccessfulQuotaState, status: "stale", error: error instanceof Error ? error.message : String(error) } : {
        updatedAt: new Date().toISOString(),
        providers: [],
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const sidecar = document.getElementById(SIDECAR_ID);
    if (sidecar) delete sidecar.dataset.signature;
    return force || previousSignature !== JSON.stringify(quotaState);
  }

  async function fetchQuotaJson(url) {
    try {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timeout = controller ? window.setTimeout(() => controller.abort(), QUOTA_FETCH_TIMEOUT_MS) : 0;
      const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal: controller?.signal });
      if (timeout) window.clearTimeout(timeout);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (fetchError) {
      return fetchQuotaJsonWithXHR(url, fetchError);
    }
  }

  function fetchQuotaJsonWithXHR(url, originalError) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.timeout = QUOTA_FETCH_TIMEOUT_MS;
      xhr.withCredentials = true;
      xhr.setRequestHeader("Cache-Control", "no-store");
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(`Quota bridge unavailable: HTTP ${xhr.status}`));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText || "{}"));
        } catch (error) {
          reject(error);
        }
      };
      xhr.onerror = () => reject(originalError instanceof Error ? originalError : new Error(String(originalError || "Quota fetch failed")));
      xhr.ontimeout = () => reject(new Error("Quota bridge unavailable: request timed out"));
      xhr.send();
    });
  }

  async function loadSettings() {
    const result = await storageGet();
    settings = mergeSettings(result?.[STORAGE_KEY]);
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textOf(element) {
    return (element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findEffortDropdown() {
    const explicit = Array.from(document.querySelectorAll("[data-component='prompt-variant-control'] button, button[data-action='prompt-model-variant']"))
      .filter(isVisible)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
    if (explicit) return explicit;

    const candidates = Array.from(document.querySelectorAll("button, [role='button'], div, span"))
      .filter(isVisible)
      .filter((element) => {
        const text = textOf(element);
        const rect = element.getBoundingClientRect();
        return (
          /^Default\b/.test(text) &&
          rect.top > window.innerHeight * 0.45 &&
          rect.height > 0 &&
          rect.height <= 48 &&
          rect.width > 0 &&
          rect.width <= 180
        );
      });

    return candidates
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return bRect.bottom - aRect.bottom || bRect.width - aRect.width;
      })[0] || null;
  }

  function findControlsBounds(anchor) {
    const anchorRect = anchor.getBoundingClientRect();
    const controls = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(isVisible)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => Math.abs(rect.top - anchorRect.top) <= 10 && rect.height <= 48 && rect.width > 0);

    if (controls.length === 0) return anchorRect;
    return controls.reduce((bounds, { rect }) => ({
      left: Math.min(bounds.left, rect.left),
      right: Math.max(bounds.right, rect.right),
      top: Math.min(bounds.top, rect.top),
      bottom: Math.max(bounds.bottom, rect.bottom),
      width: Math.max(bounds.right, rect.right) - Math.min(bounds.left, rect.left),
      height: Math.max(bounds.bottom, rect.bottom) - Math.min(bounds.top, rect.top),
    }), {
      left: anchorRect.left,
      right: anchorRect.right,
      top: anchorRect.top,
      bottom: anchorRect.bottom,
      width: anchorRect.width,
      height: anchorRect.height,
    });
  }

  function decorateControlRow(anchor) {
    document.querySelectorAll(`.${TYPE_CHEVRON}`).forEach((element) => {
      if (!findControlRow(anchor)?.contains(element)) element.remove();
    });
    document.querySelectorAll("[data-oc-sidecar-native-control]").forEach((element) => {
      element.removeAttribute("data-oc-sidecar-native-control");
    });
    document.querySelectorAll(".oc-webui-sidecar-native-chip").forEach((element) => {
      element.classList.remove("oc-webui-sidecar-native-chip");
      element.classList.remove("oc-webui-sidecar-native-chip--mode");
    });
    document.querySelectorAll("[data-oc-sidecar-mode-chip]").forEach((element) => {
      element.removeAttribute("data-oc-sidecar-mode-chip");
      ["width", "min-width", "flex-basis", "padding-left", "padding-right"].forEach((property) => {
        element.style.removeProperty(property);
      });
    });

    const row = findControlRow(anchor);
    const effortRoot = row?.querySelector("[data-component='prompt-variant-control']") || anchor.closest("[data-component='prompt-variant-control']") || anchor.closest("button, [role='button']") || anchor;
    markNativeControl(effortRoot);
    decorateModelDropdown(anchor);
    decorateModeButton(anchor);
    decorateNativeChevron(row, { effortRoot });
  }

  function markNativeControl(root) {
    if (!root) return;
    root.classList.add("oc-webui-sidecar-native-chip", TYPE_DROPDOWN);
    root.dataset.ocSidecarNativeControl = "true";
  }

  function hideNativeChevronTooltip() {
    document.getElementById("oc-webui-sidecar-native-tooltip")?.remove();
  }

  function showNativeChevronTooltip(anchor, text) {
    hideNativeChevronTooltip();
    if (!text) return;
    const tooltip = document.createElement("div");
    tooltip.id = "oc-webui-sidecar-native-tooltip";
    tooltip.className = "oc-webui-sidecar-native-tooltip";
    tooltip.textContent = text;
    document.body.append(tooltip);

    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - tooltipRect.width - 8, Math.max(8, anchorRect.left));
    const top = Math.max(8, anchorRect.top - tooltipRect.height - 8);
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  function decorateNativeChevron(row, controls = {}) {
    if (!row) return;
    const modeRoot = row.querySelector("[data-component='prompt-agent-control'] button[data-action='prompt-agent'], button[data-action='prompt-agent']");
    const modelRoot = row.querySelector("[data-component='prompt-model-control']");
    const effortRoot = controls.effortRoot || row.querySelector("[data-component='prompt-variant-control']") || row.querySelector("button[data-action='prompt-model-variant']")?.closest("[data-component='prompt-variant-control']");
    if (!modeRoot || !modelRoot || !effortRoot) return;

    row.classList.toggle("oc-webui-sidecar-control-row--native-collapsed", Boolean(settings.nativeControlsCollapsed));

    const chevron = row.querySelector(`.${TYPE_CHEVRON}`) || document.createElement("button");
    chevron.type = "button";
    chevron.className = `oc-webui-sidecar-native-chevron ${TYPE_CHEVRON} ${settings.nativeControlsCollapsed ? "oc-webui-sidecar-native-chevron--collapsed" : "oc-webui-sidecar-native-chevron--expanded"}`;
    chevron.setAttribute("aria-label", "Toggle built-in OpenCode settings");
    chevron.setAttribute("aria-pressed", String(Boolean(settings.nativeControlsCollapsed)));
    const chevronTooltip = [
      `Mode: ${textOf(modeRoot) || "Unknown"}`,
      `Model: ${textOf(modelRoot) || "Unknown"}`,
      `Effort: ${textOf(effortRoot) || "Unknown"}`,
    ].join("\n");
    chevron.title = chevronTooltip;
    chevron.dataset.ocSidecarTooltip = chevronTooltip;
    if (!chevron.querySelector(".oc-webui-sidecar-native-chevron__glyph")) {
      const chevronGlyph = document.createElement("span");
      chevronGlyph.className = "oc-webui-sidecar-native-chevron__glyph";
      chevron.replaceChildren(chevronGlyph);
    }
    if (chevron.dataset.ocSidecarHandlers !== "true") {
      chevron.dataset.ocSidecarHandlers = "true";
      chevron.addEventListener("mouseenter", () => showNativeChevronTooltip(chevron, chevron.dataset.ocSidecarTooltip));
      chevron.addEventListener("mouseleave", hideNativeChevronTooltip);
      chevron.addEventListener("focus", () => showNativeChevronTooltip(chevron, chevron.dataset.ocSidecarTooltip));
      chevron.addEventListener("blur", hideNativeChevronTooltip);
      chevron.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        hideNativeChevronTooltip();
        settings.nativeControlsCollapsed = !settings.nativeControlsCollapsed;
        row.classList.toggle("oc-webui-sidecar-control-row--native-collapsed", Boolean(settings.nativeControlsCollapsed));
        debugStatusline("collapse-toggle", { immediate: true });
        saveSettings();
        scheduleMount(0);
      }, true);
      chevron.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      }, true);
    }

    const firstNative = [modeRoot, modelRoot, effortRoot]
      .map((element) => Array.from(row.children).find((child) => child === element || child.contains(element)))
      .filter(Boolean)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    [modeRoot, modelRoot, effortRoot]
      .map((element) => Array.from(row.children).find((child) => child === element || child.contains(element)))
      .filter(Boolean)
      .forEach((element) => {
        element.dataset.ocSidecarNativeControl = "true";
      });
    if (firstNative?.parentElement === row && firstNative.previousElementSibling !== chevron) firstNative.before(chevron);
  }

  function decorateModelDropdown(anchor) {
    const row = findControlRow(anchor);
    if (!row) return;
    const modelRoot = row.querySelector("[data-component='prompt-model-control']");
    markNativeControl(modelRoot);
  }

  function decorateModeButton(anchor) {
    const row = findControlRow(anchor);
    const modeButton = row?.querySelector("[data-component='prompt-agent-control'] button[data-action='prompt-agent'], button[data-action='prompt-agent']");
    if (!modeButton) return;
    applyModeChipStyles(modeButton);
    const modeFlexItem = Array.from(row.children).find((child) => child === modeButton || child.contains(modeButton));
    if (modeFlexItem) modeFlexItem.dataset.ocSidecarNativeControl = "true";
  }

  function applyModeChipStyles(root) {
    root.classList.add("oc-webui-sidecar-native-chip", "oc-webui-sidecar-native-chip--mode");
    root.dataset.ocSidecarModeChip = "true";
    root.dataset.ocSidecarNativeControl = "true";
    root.style.setProperty("width", "100px", "important");
    root.style.setProperty("min-width", "100px", "important");
    root.style.setProperty("flex-basis", "100px", "important");
    root.style.setProperty("padding-left", "18px", "important");
    root.style.setProperty("padding-right", "18px", "important");
  }

  function clearLayoutSpacer() {
    document.querySelectorAll(`[${SPACER_ATTR}]`).forEach((element) => {
      element.style.paddingBottom = "";
      element.removeAttribute(SPACER_ATTR);
    });
  }

  function findControlRow(anchor) {
    let element = anchor;
    let best = anchor.parentElement;
    for (let i = 0; i < 8 && element; i += 1) {
      const rect = element.getBoundingClientRect();
      const containsEffort = Boolean(element.querySelector("[data-component='prompt-variant-control'], button[data-action='prompt-model-variant']"));
      const visibleChildren = Array.from(element.children).filter(isVisible);
      if (containsEffort && visibleChildren.length >= 3 && rect.height > 0 && rect.height <= 160) {
        best = element;
        break;
      }
      element = element.parentElement;
    }
    return best;
  }

  function updateControlRowWrapState(row) {
    const isNativeCollapsed = row.classList.contains("oc-webui-sidecar-control-row--native-collapsed");
    const chevron = row.querySelector(".oc-webui-sidecar-native-chevron");
    chevron?.style.removeProperty("transform");
    row.classList.remove("oc-webui-sidecar-control-row--wrapped");
    row.style.removeProperty("--oc-sidecar-wrap-reserve");
    delete row.dataset.ocSidecarVisualRows;
    const elements = Array.from(row.querySelectorAll(isNativeCollapsed ? `.${TYPE_CHEVRON}, .oc-webui-sidecar__chip` : `.${TYPE_CHEVRON}, .oc-webui-sidecar-native-chip, .oc-webui-sidecar__chip`))
      .filter(isVisible);
    elements.forEach((element) => {
      element.classList.remove("oc-webui-sidecar__chip--row-has-tall");
      element.classList.remove("oc-webui-sidecar__chip--row-has-native");
      element.classList.remove("oc-webui-sidecar__chip--visual-row-after-2");
      element.classList.remove("oc-webui-sidecar__chip--visual-row-1");
    });
    if (elements.length === 0) {
      row.classList.remove("oc-webui-sidecar-control-row--wrapped");
      row.style.removeProperty("--oc-sidecar-wrap-reserve");
      return;
    }
    const items = elements.map((element) => ({ element, rect: element.getBoundingClientRect() }));
    const firstCenter = Math.min(...items.map(({ rect }) => rect.top + rect.height / 2));
    const isWrapped = items.some(({ rect }) => (rect.top + rect.height / 2) - firstCenter > 18);
    row.classList.toggle("oc-webui-sidecar-control-row--wrapped", isWrapped);

    const visualRows = [];
    for (const item of items.sort((a, b) => (a.rect.top + a.rect.height / 2) - (b.rect.top + b.rect.height / 2))) {
      const center = item.rect.top + item.rect.height / 2;
      let visualRow = visualRows.find((candidate) => Math.abs(candidate.center - center) <= 18);
      if (!visualRow) {
        visualRow = { top: item.rect.top, center, items: [] };
        visualRows.push(visualRow);
      }
      visualRow.items.push(item.element);
    }

    visualRows.forEach((visualRow, index) => {
      if (index === 0) {
        visualRow.items.forEach((element) => element.classList.add("oc-webui-sidecar__chip--visual-row-1"));
      }
      if (index >= 2) {
        visualRow.items.forEach((element) => element.classList.add("oc-webui-sidecar__chip--visual-row-after-2"));
      }
      if (visualRow.items.some((element) => element.classList.contains(TYPE_LARGE_CHIP))) {
        visualRow.items.forEach((element) => element.classList.add("oc-webui-sidecar__chip--row-has-tall"));
      }
      if (!row.classList.contains("oc-webui-sidecar-control-row--native-collapsed") && visualRow.items.some((element) => element.classList.contains("oc-webui-sidecar-native-chip"))) {
        visualRow.items.forEach((element) => element.classList.add("oc-webui-sidecar__chip--row-has-native"));
      }
    });
    if (isWrapped) {
      const reserve = WRAPPED_BASE_RESERVE_PX + Math.max(0, visualRows.length - 2) * WRAPPED_EXTRA_ROW_RESERVE_PX;
      row.style.setProperty("--oc-sidecar-wrap-reserve", `${isNativeCollapsed ? Math.max(reserve, WRAPPED_BASE_RESERVE_PX) : reserve}px`);
      row.dataset.ocSidecarVisualRows = String(visualRows.length);
    } else {
      row.style.removeProperty("--oc-sidecar-wrap-reserve");
      delete row.dataset.ocSidecarVisualRows;
    }
    debugStatusline("wrap-state", {
      isWrapped,
      rowCount: visualRows.length,
      rowTops: visualRows.map((visualRow) => Math.round(visualRow.top)),
      rows: visualRows.map((visualRow) => visualRow.items.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          className: element.className || null,
          id: element.id || null,
          tag: element.tagName,
          module: element.dataset?.module || null,
          type: Array.from(element.classList || []).find((className) => className.startsWith("oc-sidecar-type-")) || null,
          top: Math.round(rect.top),
          center: Math.round(rect.top + rect.height / 2),
          height: Math.round(rect.height),
          transform: getComputedStyle(element).transform,
        };
      })),
    });
  }

  function reserveSidecarRow(anchor, sidecar) {
    clearLayoutSpacer();
    const spacerTarget = anchor.parentElement;
    if (!spacerTarget || sidecar.dataset.empty === "true") return;
    const sidecarHeight = sidecar.getBoundingClientRect().height || 26;
    spacerTarget.setAttribute(SPACER_ATTR, "true");
    spacerTarget.style.paddingBottom = `${Math.ceil(Math.max(0, sidecarHeight - anchor.getBoundingClientRect().height) + 16)}px`;
  }

  function makeMetric(label, value, title) {
    const metric = document.createElement("span");
    metric.className = "oc-webui-sidecar__metric";
    metric.title = title;

    const labelElement = document.createElement("span");
    labelElement.className = "oc-webui-sidecar__label";
    labelElement.textContent = label;

    const bar = document.createElement("span");
    bar.className = "oc-webui-sidecar__bar";

    const fill = document.createElement("span");
    fill.className = "oc-webui-sidecar__fill";
    fill.style.width = `${Math.max(0, Math.min(100, value))}%`;

    const valueElement = document.createElement("span");
    valueElement.className = "oc-webui-sidecar__value";
    valueElement.textContent = `${value}%`;

    bar.append(fill);
    metric.append(labelElement, bar, valueElement);
    return metric;
  }

  function makeStackBar(label, value, title) {
    const metric = document.createElement("span");
    metric.className = "oc-webui-sidecar__metric oc-webui-sidecar__metric--stack-bar";
    metric.title = title;

    const labelElement = document.createElement("span");
    labelElement.className = "oc-webui-sidecar__label oc-webui-sidecar__label--stack";
    labelElement.textContent = label;

    const bar = document.createElement("span");
    bar.className = "oc-webui-sidecar__bar oc-webui-sidecar__bar--stack";

    const fill = document.createElement("span");
    fill.className = "oc-webui-sidecar__fill";
    fill.style.width = `${Math.max(0, Math.min(100, value))}%`;

    const valueElement = document.createElement("span");
    valueElement.className = "oc-webui-sidecar__value oc-webui-sidecar__value--in-bar";
    valueElement.textContent = `${value}%`;

    bar.append(fill, valueElement);
    metric.append(labelElement, bar);
    return metric;
  }

  function getProvider(providerId) {
    return quotaState.providers?.find((provider) => provider.id === providerId);
  }

  function getProviderStatusData(providerId) {
    const provider = getProvider(providerId);
    return (provider?.windows || []).map((quotaWindow) => ({
      label: quotaWindow.label,
      value: quotaWindow.percentRemaining,
      title: `${quotaWindow.label} quota remaining${quotaWindow.resetsIn ? `, resets in ${quotaWindow.resetsIn}` : ""}`,
    }));
  }

  function displayLabel(config, label) {
    return config.labelMap?.[label] || label;
  }

  function providerTooltipLabel(config, providerData) {
    const label = providerData?.label || config.label;
    if (config.id !== "gemini") return label;

    const authValue = providerData?.values?.find((item) => item.label === "Auth")?.value || "";
    if (/vertex/i.test(label) || /vertex/i.test(authValue)) return "Gemini (Vertex usage)";
    if (/api/i.test(label) || /api key/i.test(authValue)) return "Gemini (API key usage)";
    if (/oauth/i.test(label) || /oauth/i.test(authValue)) return "Gemini (OAuth provider usage)";
    if (/code assist/i.test(label) || providerData?.windows?.length > 0) return "Gemini (Code Assist subscription usage)";
    return "Gemini (usage source unknown)";
  }

  function makeValue(label, value, title) {
    const metric = document.createElement("span");
    metric.className = "oc-webui-sidecar__metric oc-webui-sidecar__metric--value";
    metric.title = title || "";

    const labelElement = document.createElement("span");
    labelElement.className = "oc-webui-sidecar__label";
    labelElement.textContent = label;

    const valueElement = document.createElement("span");
    valueElement.className = "oc-webui-sidecar__value oc-webui-sidecar__value--wide";
    valueElement.textContent = value;

    metric.append(labelElement, valueElement);
    return metric;
  }

  function renderProviderModule(config) {
    const chip = document.createElement("span");
    chip.className = "oc-webui-sidecar__module oc-webui-sidecar__chip";
    if (config.layout) chip.classList.add(`oc-webui-sidecar__chip--${config.layout}`);
    chip.dataset.module = config.id;
    chip.draggable = true;
    chip.dataset.row = String(settings.moduleRows?.[config.id] || 1);

    const handle = document.createElement("span");
    handle.className = "oc-webui-sidecar__drag-handle";
    handle.title = "Drag to reorder";
    handle.textContent = "⋮";

    const providerData = getProvider(config.providerId);
    const providerUnavailable = providerData?.status && providerData.status !== "ok";
    const valueData = config.showValues === false || providerUnavailable ? [] : providerData?.values || [];
    const tooltipParts = [
      providerTooltipLabel(config, providerData),
      providerData?.values?.map((item) => `${item.label}: ${item.value}`).join("\n"),
      providerData?.windows?.map((item) => `${item.label}: ${item.percentRemaining}% remaining${item.resetsIn ? `, resets in ${item.resetsIn}` : ""}`).join("\n"),
    ].filter(Boolean);
    if (tooltipParts.length > 0) chip.title = tooltipParts.join("\n");

    if (quotaState.status === "error" || providerData?.status === "error") {
      chip.classList.add("oc-webui-sidecar__chip--error");
      chip.title = providerData?.error || quotaState.error || "Quota bridge unavailable";
    }

    const provider = document.createElement("span");
    provider.className = "oc-webui-sidecar__provider";
    if (config.icon) {
      const image = document.createElement("img");
      image.className = "oc-webui-sidecar__provider-icon";
      image.alt = config.label;
      image.src = browserApi?.runtime?.getURL ? browserApi.runtime.getURL(config.icon) : `/__opencode-plus/${config.icon}`;
      provider.append(image);
    } else {
      provider.textContent = config.label;
    }

    const metrics = document.createElement("span");
    metrics.className = "oc-webui-sidecar__metrics";
    if (config.layout) metrics.classList.add(`oc-webui-sidecar__metrics--${config.layout}`);
    const statusData = getProviderStatusData(config.providerId);
    if (quotaState.status === "loading") {
      if (config.layout === "stack") {
        const rows = placeholderStackRows(config, "loading");
        metrics.append(...rows);
        classifyChipByRenderedShape(chip, rows.length);
      } else {
        metrics.textContent = "loading";
        classifyChipByRenderedShape(chip, 1);
      }
    } else if (statusData.length === 0 && valueData.length === 0) {
      if (config.layout === "stack") {
        const placeholder = quotaState.status === "error" ? "retrying" : providerData?.status === "not_configured" ? "not set" : "no data";
        const rows = placeholderStackRows(config, placeholder);
        metrics.append(...rows);
        classifyChipByRenderedShape(chip, rows.length);
      } else {
        metrics.textContent = quotaState.status === "error" ? "retrying" : providerData?.status === "not_configured" ? "not set" : "no data";
        classifyChipByRenderedShape(chip, 1);
      }
    } else if (config.layout === "stack") {
      metrics.append(...statusData.map((item) => makeStackBar(displayLabel(config, item.label), item.value, item.title)));
      metrics.append(...valueData.map((item) => makeValue(displayLabel(config, item.label), item.value, item.resetsIn ? `resets in ${item.resetsIn}` : undefined)));
      classifyChipByRenderedShape(chip, statusData.length + valueData.length);
    } else {
      metrics.append(...statusData.map((item) => makeMetric(item.label, item.value, item.title)));
      metrics.append(...valueData.map((item) => makeValue(item.label, item.value, item.resetsIn ? `resets in ${item.resetsIn}` : undefined)));
      classifyChipByRenderedShape(chip, statusData.length + valueData.length);
    }

    chip.append(handle, provider, metrics);
    return chip;
  }

  function classifyChipByRenderedShape(chip, rowCount) {
    chip.classList.remove(TYPE_SMALL_CHIP, TYPE_LARGE_CHIP);
    chip.classList.add(rowCount >= 3 ? TYPE_LARGE_CHIP : TYPE_SMALL_CHIP);
  }

  function placeholderStackRows(config, text) {
    const labels = config.placeholderLabels || [config.label];
    return labels.map((label) => makeStackPlaceholder(displayLabel(config, label), text));
  }

  function makeStackPlaceholder(label, value) {
    const metric = document.createElement("span");
    metric.className = "oc-webui-sidecar__metric oc-webui-sidecar__metric--stack-bar";

    const labelElement = document.createElement("span");
    labelElement.className = "oc-webui-sidecar__label oc-webui-sidecar__label--stack";
    labelElement.textContent = label;

    const valueElement = document.createElement("span");
    valueElement.className = "oc-webui-sidecar__value oc-webui-sidecar__value--stack-placeholder";
    valueElement.textContent = value;

    metric.append(labelElement, valueElement);
    return metric;
  }

  const modules = [
    { id: "openai", providerId: "openai", label: "OpenAI", icon: "provider-openai.svg", order: 100, layout: "stack", showValues: false, labelMap: { H: "Hourly", W: "Weekly", R: "Review" }, placeholderLabels: ["Hourly", "Weekly"], render() { return renderProviderModule(this); } },
    { id: "openrouter", providerId: "openrouter", label: "OpenRouter", icon: "provider-openrouter.svg", order: 200, layout: "stack", placeholderLabels: ["Left", "Used"], render() { return renderProviderModule(this); } },
    { id: "gemini", providerId: "gemini", label: "Gemini", icon: "provider-gemini.svg", order: 300, layout: "stack", showValues: false, placeholderLabels: ["Pro", "Flash", "Lite"], render() { return renderProviderModule(this); } },
    { id: "claude", providerId: "claude", label: "Claude", icon: "provider-claude.svg", order: 400, layout: "stack", placeholderLabels: ["5h", "7d"], render() { return renderProviderModule(this); } },
    { id: "deepseek", providerId: "deepseek", label: "DeepSeek", icon: "provider-deepseek.svg", order: 500, layout: "stack", placeholderLabels: ["Bal", "API"], render() { return renderProviderModule(this); } },
    { id: "siliconflow", providerId: "siliconflow", label: "SiliconFlow", icon: "provider-siliconflow.svg", order: 600, layout: "stack", placeholderLabels: ["Bal", "API"], render() { return renderProviderModule(this); } },
    { id: "moonshot", providerId: "moonshot", label: "Kimi/Moonshot", icon: "provider-moonshot.svg", order: 700, layout: "stack", placeholderLabels: ["Avail", "Cash"], render() { return renderProviderModule(this); } },
    { id: "fireworks", providerId: "fireworks", label: "Fireworks AI", icon: "provider-fireworks.svg", order: 800, layout: "stack", placeholderLabels: ["Spend", "Limit"], render() { return renderProviderModule(this); } },
    { id: "xai", providerId: "xai", label: "xAI/Grok", icon: "provider-xai.svg", order: 900, layout: "stack", placeholderLabels: ["Pre", "Team"], render() { return renderProviderModule(this); } },
  ];

  function sortModulesBySettings(items) {
    const order = new Map((settings.moduleOrder || defaultModuleOrder).map((id, index) => [id, index]));
    return [...items].sort((a, b) => (order.get(a.id) ?? a.order) - (order.get(b.id) ?? b.order));
  }

  function moduleIdFromDrag(event) {
    return event.dataTransfer?.getData("text/plain") || event.dataTransfer?.getData("application/x-opencode-sidecar-module");
  }

  function persistMove(draggedId, targetId, targetRow) {
    const current = settings.moduleOrder || defaultModuleOrder;
    const next = current.filter((id) => id !== draggedId);
    if (targetId) {
      next.splice(Math.max(0, next.indexOf(targetId)), 0, draggedId);
    } else {
      const rowIds = next.filter((id) => (settings.moduleRows?.[id] || defaultModuleRows[id] || 1) === targetRow);
      const lastInRow = rowIds.at(-1);
      if (lastInRow) next.splice(next.indexOf(lastInRow) + 1, 0, draggedId);
      else next.push(draggedId);
    }
    settings = {
      ...settings,
      moduleOrder: next,
      moduleRows: { ...settings.moduleRows, [draggedId]: targetRow },
    };
    return saveSettings();
  }

  function installRowDropHandlers(sidecar) {
    for (const row of sidecar.querySelectorAll(".oc-webui-sidecar__row")) {
      row.addEventListener("dragover", (event) => {
        if (!moduleIdFromDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        row.classList.add("oc-webui-sidecar__row--drop");
      });
      row.addEventListener("dragleave", (event) => {
        if (row.contains(event.relatedTarget)) return;
        row.classList.remove("oc-webui-sidecar__row--drop");
      });
      row.addEventListener("drop", async (event) => {
        if (event.target.closest(".oc-webui-sidecar__chip")) return;
        const draggedId = moduleIdFromDrag(event);
        if (!draggedId) return;
        event.preventDefault();
        row.classList.remove("oc-webui-sidecar__row--drop");
        await persistMove(draggedId, null, Number(row.dataset.row || 1));
        const currentSidecar = document.getElementById(SIDECAR_ID);
        if (currentSidecar) delete currentSidecar.dataset.signature;
        mount();
      });
    }
  }

  function installReorderHandlers(sidecar) {
    for (const chip of sidecar.querySelectorAll(".oc-webui-sidecar__chip")) {
      chip.addEventListener("dragstart", (event) => {
        chip.classList.add("oc-webui-sidecar__chip--dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", chip.dataset.module || "");
        event.dataTransfer.setData("application/x-opencode-sidecar-module", chip.dataset.module || "");
      });

      chip.addEventListener("dragend", () => {
        chip.classList.remove("oc-webui-sidecar__chip--dragging");
        sidecar.querySelectorAll(".oc-webui-sidecar__chip--drop-before").forEach((item) => item.classList.remove("oc-webui-sidecar__chip--drop-before"));
      });

      chip.addEventListener("dragover", (event) => {
        if (!moduleIdFromDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        sidecar.querySelectorAll(".oc-webui-sidecar__chip--drop-before").forEach((item) => item.classList.remove("oc-webui-sidecar__chip--drop-before"));
        chip.classList.add("oc-webui-sidecar__chip--drop-before");
      });

      chip.addEventListener("dragleave", () => {
        chip.classList.remove("oc-webui-sidecar__chip--drop-before");
      });

      chip.addEventListener("drop", async (event) => {
        const draggedId = moduleIdFromDrag(event);
        const targetId = chip.dataset.module;
        if (!draggedId || !targetId || draggedId === targetId) return;
        event.preventDefault();
        chip.classList.remove("oc-webui-sidecar__chip--drop-before");
        await persistMove(draggedId, targetId, Number(chip.dataset.row || 1));
        const currentSidecar = document.getElementById(SIDECAR_ID);
        if (currentSidecar) delete currentSidecar.dataset.signature;
        mount();
      });
    }
  }

  function relativeLuminance(rgb) {
    const channels = [rgb.r, rgb.g, rgb.b].map((value) => {
      const normalized = value / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function parseRgb(value) {
    const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return null;
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
  }

  function applyTheme(sidecar) {
    const computed = getComputedStyle(document.body);
    const background = parseRgb(computed.backgroundColor) || { r: 0, g: 0, b: 0 };
    const text = computed.color || "CanvasText";
    const isLight = relativeLuminance(background) > 0.45;

    sidecar.style.color = text;
    sidecar.style.setProperty("--oc-sidecar-chip-bg", isLight ? "rgba(255, 255, 255, 0.72)" : "rgba(0, 0, 0, 0.18)");
    sidecar.style.setProperty("--oc-sidecar-border", isLight ? "rgba(0, 0, 0, 0.18)" : "rgba(255, 255, 255, 0.16)");
    sidecar.style.setProperty("--oc-sidecar-track", isLight ? "rgba(0, 0, 0, 0.16)" : "rgba(255, 255, 255, 0.14)");
    sidecar.style.setProperty("--oc-sidecar-label", isLight ? "rgba(0, 0, 0, 0.58)" : "rgba(255, 255, 255, 0.56)");
    sidecar.style.setProperty("--oc-sidecar-value", isLight ? "rgba(0, 0, 0, 0.78)" : "rgba(255, 255, 255, 0.84)");
    sidecar.style.setProperty("--oc-sidecar-fill-start", isLight ? "#047857" : "#34d399");
    sidecar.style.setProperty("--oc-sidecar-fill-end", isLight ? "#0369a1" : "#22d3ee");
  }

  function renderSidecar() {
    let sidecar = document.getElementById(SIDECAR_ID);
    if (!sidecar) {
      sidecar = document.createElement("span");
      sidecar.id = SIDECAR_ID;
      sidecar.className = "oc-webui-sidecar";
    }

    applyTheme(sidecar);

    const enabledModules = modules
      .filter((module) => settings.modules[module.id]);
    const orderedModules = sortModulesBySettings(enabledModules);
    const nextSignature = JSON.stringify({ settings, quotaState });

    if (sidecar.dataset.signature !== nextSignature) {
      sidecar.dataset.signature = nextSignature;
      sidecar.replaceChildren(...orderedModules.map((module) => module.render()));
      installReorderHandlers(sidecar);
    }

    sidecar.dataset.empty = String(orderedModules.length === 0);
    return sidecar;
  }

  function mount() {
    debugStatusline("mount-start");
    if (!/opencode|127\.0\.0\.1|localhost/i.test(location.href)) return;

    if (quotaState.status === "loading" && Date.now() - lastQuotaFetch > 1_500) {
      fetchQuotaData(true).then(() => scheduleMount(0));
    }

    const sidecar = renderSidecar();

    const anchor = findEffortDropdown();
    if (anchor && sidecar.dataset.empty !== "true") {
      clearLayoutSpacer();
      decorateControlRow(anchor);
      const row = findControlRow(anchor);
      if (row) {
        const anchorRoot = anchor.closest("button, [role='button']") || anchor;
        const chevron = settings.nativeControlsCollapsed ? row.querySelector(".oc-webui-sidecar-native-chevron") : null;
        const insertAfter = chevron || Array.from(row.children).find((child) => child === anchorRoot || child.contains(anchorRoot));
        if (insertAfter?.parentElement === row) insertAfter.after(sidecar);
        else row.append(sidecar);
      }
      row?.classList.add("oc-webui-sidecar-control-row");
      if (row) updateControlRowWrapState(row);
      sidecar.classList.remove("oc-webui-sidecar--anchored");
      sidecar.hidden = false;
      sidecar.style.left = "";
      sidecar.style.top = "";
      sidecar.style.maxWidth = "";
      sidecar.style.transform = "";
      lastAnchoredAt = Date.now();
      debugStatusline("mount-anchored", { anchor: anchor?.outerHTML?.slice?.(0, 180) || null });
      publishPageStatus();
      return;
    }

    if (sidecar && !sidecar.hidden && Date.now() - lastAnchoredAt < ANCHOR_MISS_GRACE_MS) {
      scheduleMount(180);
      scheduleMount(520);
      debugStatusline("anchor-miss-grace");
      publishPageStatus();
      return;
    }

    clearLayoutSpacer();
    if (!document.documentElement.contains(sidecar)) document.body.append(sidecar);
    document.querySelectorAll(".oc-webui-sidecar-control-row").forEach((element) => {
      element.classList.remove("oc-webui-sidecar-control-row");
      element.classList.remove("oc-webui-sidecar-control-row--wrapped");
      element.classList.remove("oc-webui-sidecar-control-row--native-collapsed");
      element.style.removeProperty("--oc-sidecar-wrap-reserve");
      delete element.dataset.ocSidecarVisualRows;
    });
    document.querySelectorAll(".oc-webui-sidecar-native-chevron").forEach((element) => element.remove());
    document.querySelectorAll(".oc-webui-sidecar-native-chip").forEach((element) => {
      element.classList.remove("oc-webui-sidecar-native-chip");
      element.classList.remove("oc-webui-sidecar-native-chip--mode");
    });
    document.querySelectorAll("[data-oc-sidecar-native-control]").forEach((element) => {
      element.removeAttribute("data-oc-sidecar-native-control");
    });
    sidecar.classList.remove("oc-webui-sidecar--anchored");
    sidecar.hidden = true;
    sidecar.style.left = "";
    sidecar.style.top = "";
    sidecar.style.maxWidth = "";
    sidecar.style.transform = "";
    publishPageStatus();
    debugStatusline("mount-hidden");
  }

  function scheduleMount(delay = 80) {
    if (mountTimers.has(delay)) return;
    debugStatusline("schedule-mount", { delay });
    const timer = window.setTimeout(() => {
      mountTimers.delete(delay);
      mount();
    }, delay);
    mountTimers.add(delay);
  }

  function mutationOnlyTouchesSidecar(mutation) {
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes]
      .filter((node) => node.nodeType === Node.ELEMENT_NODE);
    return nodes.length > 0 && nodes.every((node) => isOpenCodePlusOwnedNode(node) || isHoverOverlayNode(node));
  }

  function isOpenCodePlusOwnedNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.id === SIDECAR_ID || node.id === "opencode-plus-drawer" || node.id === "oc-webui-sidecar-native-tooltip") return true;
    if (node.closest?.(`#${SIDECAR_ID}, #opencode-plus-drawer, #oc-webui-sidecar-native-tooltip`)) return true;
    if (Array.from(node.classList || []).some((className) => className.startsWith("oc-webui-sidecar") || className.startsWith("ocp-"))) return true;
    return Boolean(node.querySelector?.(`#${SIDECAR_ID}, #opencode-plus-drawer, #oc-webui-sidecar-native-tooltip, [class^="oc-webui-sidecar"], [class*=" oc-webui-sidecar"], [class^="ocp-"], [class*=" ocp-"]`));
  }

  function isHoverOverlayNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.matches?.("[role='tooltip'], [data-radix-popper-content-wrapper], [data-floating-ui-portal], [data-floating-ui-root]")) return true;
    if (node.closest?.("[role='tooltip'], [data-radix-popper-content-wrapper], [data-floating-ui-portal], [data-floating-ui-root]")) return true;
    return Boolean(node.querySelector?.("[role='tooltip'], [data-radix-popper-content-wrapper], [data-floating-ui-portal], [data-floating-ui-root]"));
  }

  function mutationTouchesComposerControls(mutation) {
    return [...mutation.addedNodes, ...mutation.removedNodes]
      .filter((node) => node.nodeType === Node.ELEMENT_NODE)
      .some((node) => node.matches?.(COMPOSER_CONTROL_SELECTOR) || node.querySelector?.(COMPOSER_CONTROL_SELECTOR));
  }

  function watchComposerDom() {
    const observer = new MutationObserver((mutations) => {
      if (mutations.every(mutationOnlyTouchesSidecar)) return;
      if (!mutations.some(mutationTouchesComposerControls)) return;
      debugStatusline("observer-composer-mutation", {
        count: mutations.length,
        targets: mutations.slice(0, 5).map((mutation) => mutation.target?.nodeType === Node.ELEMENT_NODE ? mutation.target.className || mutation.target.id || mutation.target.tagName : mutation.target?.nodeName),
        added: mutations.reduce((sum, mutation) => sum + mutation.addedNodes.length, 0),
        removed: mutations.reduce((sum, mutation) => sum + mutation.removedNodes.length, 0),
      });
      if (!document.getElementById(SIDECAR_ID) && !findEffortDropdown()) return;
      scheduleMount();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function isRemoteOpenCode() {
    return location.protocol === "https:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
  }

  function maybeRedirectForCloudflareAuthFailure() {
    if (!isRemoteOpenCode()) return;
    const now = Date.now();
    if (now - lastCfAuthRedirect < CF_AUTH_REDIRECT_COOLDOWN_MS) return;

    const bodyText = textOf(document.body);
    const hasPromptFailure = /Failed to (send prompt|create session)/i.test(bodyText);
    const hasNetworkFailure = /NetworkError when attempting to fetch resource|Unable to retrieve session/i.test(bodyText);
    if (!hasPromptFailure || !hasNetworkFailure) return;

    lastCfAuthRedirect = now;
    const redirectUrl = `${location.pathname}${location.search}${location.hash}` || "/";
    console.warn("[OpenCode Enhancement Suite] OpenCode request failed like expired Cloudflare Access; redirecting to re-auth", {
      redirectUrl,
    });
    location.assign(`${location.origin}${redirectUrl}`);
  }

  function redirectForCloudflareAuthFailure(reason) {
    if (!isRemoteOpenCode()) return;
    const now = Date.now();
    if (now - lastCfAuthRedirect < CF_AUTH_REDIRECT_COOLDOWN_MS) return;

    lastCfAuthRedirect = now;
    console.warn("[OpenCode Enhancement Suite] OpenCode request failed like expired Cloudflare Access; redirecting to re-auth", {
      reason,
    });
    location.assign(`${location.origin}${location.pathname}${location.search}${location.hash}`);
  }

  function installCloudflareAuthFetchGuard() {
    if (!isRemoteOpenCode() || window.__ocesCloudflareAuthFetchGuardInstalled) return;
    window.__ocesCloudflareAuthFetchGuardInstalled = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      try {
        const response = await originalFetch(...args);
        const requestUrl = String(args[0]?.url || args[0] || "");
        const sameOrigin = requestUrl.startsWith("/") || requestUrl.startsWith(location.origin);
        if (sameOrigin && (response.status === 401 || response.status === 403)) {
          redirectForCloudflareAuthFailure(`HTTP ${response.status} from ${requestUrl}`);
        }
        return response;
      } catch (error) {
        const requestUrl = String(args[0]?.url || args[0] || "");
        const sameOrigin = requestUrl.startsWith("/") || requestUrl.startsWith(location.origin) || !/^https?:/i.test(requestUrl);
        const message = error instanceof Error ? error.message : String(error);
        if (sameOrigin && /NetworkError|Failed to fetch|fetch/i.test(message)) {
          redirectForCloudflareAuthFailure(`fetch failed from ${requestUrl}: ${message}`);
        }
        throw error;
      }
    };
  }

  function watchCloudflareAuthFailures() {
    if (!isRemoteOpenCode()) return;
    const observer = new MutationObserver(() => {
      window.setTimeout(maybeRedirectForCloudflareAuthFailure, 0);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function watchSettings() {
    if (isExtensionRuntime) browserApi?.storage?.onChanged?.addListener?.((changes, area) => {
      if (area !== "local" || !changes[STORAGE_KEY]) return;
      settings = mergeSettings(changes[STORAGE_KEY].newValue);
      lastQuotaFetch = 0;
      const sidecar = document.getElementById(SIDECAR_ID);
      if (sidecar) delete sidecar.dataset.signature;
      scheduleMount();
    });
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY) return;
      settings = mergeSettings(JSON.parse(event.newValue || "{}"));
      lastQuotaFetch = 0;
      const sidecar = document.getElementById(SIDECAR_ID);
      if (sidecar) delete sidecar.dataset.signature;
      scheduleMount();
    });
    window.addEventListener("opencode-plus:settings", (event) => {
      settings = mergeSettings(event.detail || {});
      lastQuotaFetch = 0;
      const sidecar = document.getElementById(SIDECAR_ID);
      if (sidecar) delete sidecar.dataset.signature;
      scheduleMount();
    });
  }

  function currentPageStatus() {
    const sidecar = document.getElementById(SIDECAR_ID);
    return {
      href: location.href,
      isOpenCodePage: /opencode|127\.0\.0\.1|localhost/i.test(location.href),
      sidecarPresent: Boolean(sidecar && document.documentElement.contains(sidecar)),
      composerPresent: Boolean(findEffortDropdown()),
    };
  }

  function publishPageStatus(force = false) {
    if (!isExtensionRuntime) return;
    const now = Date.now();
    if (!force && now - lastPageStatusUpdate < 2_000) return;
    lastPageStatusUpdate = now;
    browserApi.runtime.sendMessage({
      type: "oces.pageStatus.update",
      status: currentPageStatus(),
    }).catch?.(() => {});
  }

  if (isExtensionRuntime) browserApi?.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (message?.type !== "oces.pageStatus") return false;
    sendResponse({ ok: true, ...currentPageStatus() });
    return false;
  });

  window.addEventListener("resize", () => {
    scheduleMount(80);
    scheduleMount(240);
    scheduleMount(620);
    scheduleMount(1_200);
  });
  window.addEventListener("focus", () => fetchQuotaData(true).then(() => scheduleMount(0)));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") fetchQuotaData(true).then(() => scheduleMount(0));
  });

  loadSettings().then(() => {
    watchSettings();
    watchComposerDom();
    installCloudflareAuthFetchGuard();
    watchCloudflareAuthFailures();
    publishPageStatus(true);
    window.setTimeout(() => publishPageStatus(true), 1_000);
    window.setTimeout(() => publishPageStatus(true), 3_000);
    fetchQuotaData(true).then(() => scheduleMount());
    window.setTimeout(() => fetchQuotaData(true).then(() => scheduleMount(0)), 1_500);
    window.setTimeout(() => fetchQuotaData(true).then(() => scheduleMount(0)), 4_000);
    setInterval(async () => {
      if (await fetchQuotaData()) scheduleMount();
    }, UPDATE_INTERVAL_MS);
  });
})();

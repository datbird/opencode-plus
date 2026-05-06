(() => {
  const marker = "opencodePlusTerminalRescueAppliedV2";

  try {
    if (sessionStorage.getItem(marker)) return;
    sessionStorage.setItem(marker, String(Date.now()));

    const stores = [localStorage, sessionStorage].filter(Boolean);
    for (const store of stores) {
      for (let index = store.length - 1; index >= 0; index -= 1) {
        const key = store.key(index) || "";
        const value = store.getItem(key) || "";
        if (key === marker) continue;
        if (/ghostty/i.test(key) || /ghostty-vt\.wasm|Connection Lost|wasm validation/i.test(value)) {
          store.removeItem(key);
        }
      }
    }
  } catch (error) {
    console.warn("[OpenCode Plus] terminal rescue failed", error);
  }
})();

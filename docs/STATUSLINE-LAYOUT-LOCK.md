# Statusline Layout Lock

The OpenCode Plus statusline is ported from the OpenCode Enhancement Suite extension. The layout work is considered locked.

Do not change `bridge/opencode-cf-auth-proxy/ui/statusline.css` or statusline DOM geometry casually. The current CSS was tuned visually across one-row, two-row, and three-or-more-row composer widths. Small transform, margin, padding, display, flex, or row-detection changes can break alignment.

## Source Of Truth

- Original extension CSS: `/root/aiplayground/opencode-enhancement-suite/sidecar.css`
- OpenCode Plus CSS: `bridge/opencode-cf-auth-proxy/ui/statusline.css`
- Current verified state: these files are byte-for-byte identical.

Proxy-specific changes belong in `statusline.js` only when they adapt data access, settings storage, or asset URLs. They must not alter the visual layout model unless a fresh screenshot validation pass is done.

## Mounting Model

- `statusline.js` inserts generated provider chips into the native OpenCode composer control row after the `Default` dropdown.
- `.oc-webui-sidecar { display: contents; }` is critical. It makes generated chips participate directly as flex items in OpenCode's native row instead of creating a nested box that would shift alignment.
- Native OpenCode controls remain real clickable controls. The sidecar decorates them with `.oc-webui-sidecar-native-chip` instead of replacing them.
- The extension/proxy does not overlay fake dropdowns over OpenCode controls.

## Supported Chip Classes

The locked CSS supports exactly three practical visual classes:

- Native dropdown hybrid chips: `Build`, model, and `Default`.
- Small generated provider chips: OpenAI/OpenRouter-style.
- Large generated provider chips: Gemini-style max-height stack chips, keyed by `data-module="gemini"`.

Any new chip height, multiline structure, generated dropdown, or new provider shape is a layout-risk change.

## Baseline Centering

Every wrapped visual row after row 1 must center visible chips against the large-chip center even if the currently enabled providers only render small, `not set`, `no data`, or error chips. Row 1 and single-row layouts use the original locked extension transforms and must not receive additional correction. The proxy statusline computes a per-chip `--oc-sidecar-row-center-offset` after real flex rows are detected, but only for row 2 and later. This offset is added to the locked transform rules for wrapped lower rows, so native-only rows and generated-chip rows align against the large-chip center without adding extra flex items that can wrap unpredictably at line edges.

Why it exists:

- Flex row cross-size is based on the tallest flex item in that row.
- When Gemini has no quota data, the visible Gemini chip can collapse to a short `no data` chip.
- Without a large-row centering offset, OpenCode/native chips and generated chips get visually smooshed toward the top of the composer footer when no visible large chip is present.
- The row center must be based on the potential large chip, not on whatever provider data happens to be available.

Locked centering rule:

```js
const LARGE_CHIP_ROW_HEIGHT_PX = 42;

function applyRowCenterOffsets(visualRows) {
  for (const visualRow of visualRows) {
    for (const element of visualRow.items) {
      const rect = element.getBoundingClientRect();
      const offset = Math.max(0, (LARGE_CHIP_ROW_HEIGHT_PX - rect.height) / 2);
      element.style.setProperty("--oc-sidecar-row-center-offset", `${Math.round(offset * 10) / 10}px`);
    }
  }
}
```

The `42px` height corresponds to the large stack-chip row geometry: three 12px stack-bar rows, two 1px internal gaps, and 4px vertical chip padding.

`applyRowCenterOffsets(visualRows)` must run inside `updateControlRowWrapState(row)` after visual rows are grouped and row classes are applied. It intentionally skips row 1 to preserve the extension's original first-row alignment. The offset is added to each locked CSS transform with `var(--oc-sidecar-row-center-offset, 0px)` for row 2 and later. This guarantees row 2, row 3, row 4, and every later flex line center visible chips against the same large-chip reference height while leaving row 1 untouched.

Single-row centering depends on this shared transform:

```css
.oc-webui-sidecar-control-row > .oc-webui-sidecar,
.oc-webui-sidecar-control-row .oc-webui-sidecar-native-chip,
.oc-webui-sidecar-control-row .oc-webui-sidecar__chip {
  transform: translateY(-8px) !important;
}
```

Why it exists:

- OpenCode's composer footer row visually sits lower than the card center.
- Native dropdowns and generated chips have different real box heights.
- A visual-only `translateY(-8px)` centers all statusline participants without changing flex-line layout math.

Do not replace this with margins. Margins affect row height and wrapping.

## Wrapped Row Reserve

Wrapped mode uses reserved bottom padding on the native row:

```css
.oc-webui-sidecar-control-row--wrapped {
  align-items: flex-start !important;
  padding-top: 0 !important;
  padding-bottom: var(--oc-sidecar-wrap-reserve, 72px) !important;
}
```

The reserve is computed in JS:

```js
const WRAPPED_BASE_RESERVE_PX = 72;
const WRAPPED_EXTRA_ROW_RESERVE_PX = 38;
```

Formula:

```text
72px + max(0, rowCount - 2) * 38px
```

Why it exists:

- Two-row wrapping needs a fixed visual reserve so the composer card remains balanced.
- Three-or-more-row wrapping needs incremental reserve so lower generated chips do not collide with the composer border.
- The reserve is intentionally on the control row, not individual chips, because it preserves flex wrapping behavior.

## Visual Row Detection

`updateControlRowWrapState(row)` groups visible native/generated chips into visual rows by top coordinate within `8px`.

It applies these classes:

- `.oc-webui-sidecar-control-row--wrapped`: at least one chip is more than `8px` below the first visual top.
- `.oc-webui-sidecar__chip--visual-row-1`: chips in the first visual row.
- `.oc-webui-sidecar__chip--visual-row-after-2`: chips in row 3 and later.
- `.oc-webui-sidecar__chip--row-has-tall`: rows containing Gemini.
- `.oc-webui-sidecar__chip--row-has-native`: rows containing native dropdown controls.

Why it exists:

- Flex wrapping is browser-calculated and depends on actual rendered widths.
- Hardcoding row counts from viewport width is brittle.
- Top-coordinate grouping reflects the real layout after OpenCode and the browser finish layout.

## Wrapped Native Control Alignment

Native dropdowns keep the baseline transform in wrapped mode except for row 1:

```css
.oc-webui-sidecar-control-row.oc-webui-sidecar-control-row--wrapped .oc-webui-sidecar-native-chip {
  margin-bottom: 0 !important;
  margin-top: 0 !important;
  transform: translateY(-8px) !important;
}

.oc-webui-sidecar-control-row.oc-webui-sidecar-control-row--wrapped .oc-webui-sidecar-native-chip.oc-webui-sidecar__chip--visual-row-1 {
  margin-bottom: 4px !important;
  transform: translateY(-2px) !important;
}
```

Why it exists:

- Row-1 native controls need less vertical lift once the row wraps.
- Later native rows need the original lift to align with generated chips.
- The `4px` margin is intentional row-height reserve, not cosmetic spacing.

## Generated Chip Centering Rules

```css
.oc-webui-sidecar-control-row--wrapped .oc-webui-sidecar__chip--stack.oc-webui-sidecar__chip--row-has-tall:not([data-module="gemini"]) {
  margin-top: 7px !important;
}

.oc-webui-sidecar-control-row--wrapped .oc-webui-sidecar__chip--stack.oc-webui-sidecar__chip--visual-row-1:not([data-module="gemini"]) {
  margin-top: 7px !important;
}

.oc-webui-sidecar-control-row.oc-webui-sidecar-control-row--wrapped .oc-webui-sidecar__chip.oc-webui-sidecar__chip--row-has-native:not(.oc-webui-sidecar__chip--visual-row-1) {
  transform: translateY(-12px) !important;
}

.oc-webui-sidecar-control-row.oc-webui-sidecar-control-row--wrapped .oc-webui-sidecar__chip.oc-webui-sidecar__chip--row-has-native:not(.oc-webui-sidecar__chip--visual-row-1):not([data-module="gemini"]) {
  transform: translateY(-7px) !important;
}

.oc-webui-sidecar-control-row.oc-webui-sidecar-control-row--wrapped .oc-webui-sidecar__chip.oc-webui-sidecar__chip--visual-row-after-2 {
  transform: translateY(-10px) !important;
}
```

Why they exist:

- Gemini is the tall reference chip.
- Non-Gemini stack chips need margin compensation when sharing a row with Gemini.
- Rows with native dropdowns need different visual lift than rows of only generated chips.
- Row 3+ needs its own lift so infinite wrapping remains visually aligned.

## Health Layer

The statusline avoids unnecessary remount churn:

- Quota polling checks every second but fetches only on the configured refresh interval.
- `mount()` runs after quota polling only when quota state changes.
- Resize and settings changes schedule a debounced remount.
- A child-list `MutationObserver` watches OpenCode composer DOM replacement.
- Sidecar-only mutations are ignored to avoid self-triggered remount loops.
- `window.__ocesContentScriptLoaded` prevents duplicate initialization.

## Validation Required Before Layout Changes

Before changing layout CSS, chip DOM shape, visual row logic, or centering constants, validate screenshots for:

- One-row layout.
- Two-row layout with native controls in row 1 and generated chips in row 2.
- Two-row layout with mixed native/generated chips in both rows.
- Three-or-more-row layout.
- Rows containing only generated small chips.
- Rows containing native controls plus small generated chips.
- Rows containing native controls plus Gemini.
- Rows where all generated chips are below native controls.

If a change only adapts proxy behavior, settings storage, quota fetching, auth endpoints, or asset URLs, it must not modify `statusline.css` or row geometry.

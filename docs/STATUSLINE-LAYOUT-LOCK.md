# Statusline Layout Lock

The OpenCode Plus statusline is ported from the OpenCode Enhancement Suite extension. The layout work is considered locked.

Do not change `bridge/opencode-cf-auth-proxy/ui/statusline.css` or statusline DOM geometry casually. The current CSS was tuned visually across one-row, two-row, and three-or-more-row composer widths. Small transform, margin, padding, display, flex, or row-detection changes can break alignment.

## Source Of Truth

- OpenCode Plus CSS: `bridge/opencode-cf-auth-proxy/ui/statusline.css`
- Layout taxonomy and geometry rules in this document are the source of truth for OpenCode Plus statusline changes.

Proxy-specific changes belong in `statusline.js` only when they adapt data access, settings storage, or asset URLs. They must not alter the visual layout model unless they use the element type taxonomy below and a fresh screenshot validation pass is done.

## Mounting Model

- `statusline.js` inserts generated provider chips into the native OpenCode composer control row after the `Default` dropdown.
- `.oc-webui-sidecar { display: contents; }` is critical. It makes generated chips participate directly as flex items in OpenCode's native row instead of creating a nested box that would shift alignment.
- Native OpenCode controls remain real clickable controls. The sidecar classifies them as `.oc-sidecar-type-dropdown` instead of replacing them.
- The extension/proxy does not overlay fake dropdowns over OpenCode controls.

## Element Type Taxonomy

All layout-affecting tweaks must target exactly one of these element type classes, or an interaction between these classes:

- Collapse/expansion chevron: `.oc-sidecar-type-chevron`.
- Native OpenCode dropdown controls: `.oc-sidecar-type-dropdown`.
- Small generated chips: `.oc-sidecar-type-small-chip`.
- Large generated stack chips: `.oc-sidecar-type-large-chip`.

Provider IDs, module IDs, text labels, icons, auth source names, or individual OpenCode control names must not appear in layout selectors or row geometry decisions. Those identifiers are allowed only for content, data lookup, reorder persistence, provider-specific tooltip wording, or API behavior.

Any new visual shape must first be assigned to one of the four element types above. If it does not fit, it is a layout-risk change and needs a deliberate taxonomy update before implementation.

## Baseline Centering

Every wrapped visual row after row 1 must center visible chips against the large-chip center even if the currently enabled providers only render small, `not set`, `no data`, or error chips. Row 1 and single-row layouts use the original locked transforms and must not receive provider-specific correction.

Why it exists:

- Flex row cross-size is based on the tallest flex item in that row.
- When a large generated stack chip has no quota data, it can collapse to placeholder content.
- Without a large-row centering offset, OpenCode/native chips and generated chips get visually smooshed toward the top of the composer footer when no visible large chip is present.
- The row center must be based on the potential large chip, not on whatever provider data happens to be available.

The `42px` height corresponds to the large stack-chip row geometry: three 12px stack-bar rows, two 1px internal gaps, and 4px vertical chip padding.

Single-row centering depends on this shared transform:

```css
.oc-webui-sidecar-control-row > .oc-webui-sidecar,
.oc-webui-sidecar-control-row .oc-sidecar-type-chevron,
.oc-webui-sidecar-control-row .oc-sidecar-type-dropdown,
.oc-webui-sidecar-control-row .oc-sidecar-type-small-chip,
.oc-webui-sidecar-control-row .oc-sidecar-type-large-chip {
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
  align-items: center !important;
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

`updateControlRowWrapState(row)` groups visible native/generated controls into visual rows by rendered center within `18px`.

It applies these classes:

- `.oc-webui-sidecar-control-row--wrapped`: at least one chip is more than `8px` below the first visual top.
- `.oc-webui-sidecar__chip--visual-row-1`: chips in the first visual row.
- `.oc-webui-sidecar__chip--visual-row-after-2`: chips in row 3 and later.
- `.oc-webui-sidecar__chip--row-has-tall`: rows containing `.oc-sidecar-type-large-chip`.
- `.oc-webui-sidecar__chip--row-has-native`: rows containing `.oc-sidecar-type-dropdown`.

Why it exists:

- Flex wrapping is browser-calculated and depends on actual rendered widths.
- Hardcoding row counts from viewport width is brittle.
- Center-coordinate grouping reflects the real layout after OpenCode and the browser finish layout.

## Wrapped Native Control Alignment

Dropdowns keep the baseline transform in wrapped mode except for row 1:

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
.oc-webui-sidecar-control-row--wrapped .oc-webui-sidecar__chip--stack.oc-webui-sidecar__chip--row-has-tall:not(.oc-sidecar-type-large-chip) {
  margin-top: 7px !important;
}

.oc-webui-sidecar-control-row--wrapped .oc-webui-sidecar__chip--stack.oc-webui-sidecar__chip--visual-row-1:not(.oc-sidecar-type-large-chip) {
  margin-top: 7px !important;
}

.oc-webui-sidecar-control-row.oc-webui-sidecar-control-row--wrapped .oc-sidecar-type-chevron {
  transform: translateY(-4px) !important;
}

.oc-webui-sidecar-control-row.oc-webui-sidecar-control-row--wrapped .oc-sidecar-type-small-chip.oc-webui-sidecar__chip--visual-row-1 {
  transform: translateY(-8px) !important;
}

.oc-webui-sidecar-control-row.oc-webui-sidecar-control-row--wrapped .oc-sidecar-type-small-chip:not(.oc-webui-sidecar__chip--visual-row-1) {
  transform: translateY(-11px) !important;
}

.oc-webui-sidecar-control-row.oc-webui-sidecar-control-row--wrapped .oc-webui-sidecar__chip.oc-webui-sidecar__chip--visual-row-after-2 {
  transform: translateY(-10px) !important;
}

.oc-webui-sidecar-control-row.oc-webui-sidecar-control-row--wrapped[data-oc-sidecar-visual-rows="3"] .oc-webui-sidecar__chip.oc-sidecar-type-small-chip:not(.oc-webui-sidecar__chip--visual-row-1) {
  transform: translateY(-8px) !important;
}

.oc-webui-sidecar-control-row.oc-webui-sidecar-control-row--wrapped[data-oc-sidecar-visual-rows="3"] .oc-webui-sidecar__chip.oc-webui-sidecar__chip--visual-row-after-2 {
  transform: translateY(-7px) !important;
}
```

Why they exist:

- Large chips are the tall reference shape.
- Non-large stack chips need margin compensation when sharing rows with large-chip geometry.
- Chevron, first-row small chips, later-row small chips, and three-row wraps each have locked type/class transforms.
- Row 3+ needs its own lift so infinite wrapping remains visually aligned.
- Mobile Safari must use the same type/class transform cascade as desktop. The previous `@media (max-width: 640px)` chevron override with `translateY(-2px)` made Safari bypass the locked math and caused the chevron/statusline rows to sit too low.

Do not add provider/module exceptions here. If a future chip breaks these rules, classify its visual shape correctly or adjust the class-level rule for all elements of that class.

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
- Rows containing dropdown controls plus large generated chips.
- Rows where all generated chips are below native controls.

If a change only adapts proxy behavior, settings storage, quota fetching, auth endpoints, or asset URLs, it must not modify `statusline.css` or row geometry.

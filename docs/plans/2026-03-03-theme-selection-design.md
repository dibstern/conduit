# Theme Selection System Design

## Summary

Replicate claude-relay's full theme selection system in opencode-relay: 22 bundled Base16 themes, theme picker UI in sidebar footer, custom user themes from `~/.opencode-relay/themes/`, flash prevention, and integration with xterm.js, highlight.js, and Mermaid.

## Architecture

Svelte-native approach: a `theme.svelte.ts` store (Svelte 5 runes) holds theme state and exposes pure functions for computing CSS variables from Base16 palettes. A `ThemePicker.svelte` component provides the selection UI. Themes map Base16 colors to the existing `--color-*` Tailwind CSS custom properties so all existing utility classes continue working unchanged.

## Data Model

### Base16 Theme Format

Each theme is a JSON file with 16 hex color keys + metadata:

```json
{
  "name": "Dracula",
  "author": "Jamy Golden",
  "variant": "dark",
  "base00": "282a36", "base01": "363447", "base02": "44475a", "base03": "6272a4",
  "base04": "9ea8c7", "base05": "f8f8f2", "base06": "f0f1f4", "base07": "ffffff",
  "base08": "ff5555", "base09": "ffb86c", "base0A": "f1fa8c", "base0B": "50fa7b",
  "base0C": "8be9fd", "base0D": "80bfff", "base0E": "ff79c6", "base0F": "bd93f9"
}
```

### File Locations

- Bundled: `src/lib/themes/*.json` (22 files, copied from claude-relay)
- Custom: `~/.opencode-relay/themes/*.json` (user-created, discovered at runtime)

### Server Endpoint

`GET /api/themes` in `http-router.ts` — reads both directories, validates, returns `{ bundled: {...}, custom: {...} }`.

### CSS Variable Mapping

`computeVars()` maps Base16 → existing `--color-*` Tailwind tokens:

| Tailwind token | Base16 source | Notes |
|---|---|---|
| `--color-bg` | base00 | Main background |
| `--color-bg-alt` | base01 | Alt background |
| `--color-bg-surface` | base01 | Surface |
| `--color-text` | base06 | Primary text |
| `--color-text-secondary` | base05 | Secondary text |
| `--color-text-muted` | base04 | Muted text |
| `--color-text-dimmer` | base03 | Dimmer text |
| `--color-accent` | base09 | Accent color |
| `--color-accent-hover` | base09 ± 12% | Hover state |
| `--color-accent-bg` | base09 at 6% alpha | Accent background |
| `--color-code-bg` | base00 darkened | Code block bg |
| `--color-border` | base02 | Borders |
| `--color-border-subtle` | base02 at 12% alpha | Subtle borders |
| `--color-input-bg` | base00 | Input background |
| `--color-user-bubble` | base01 | User message bg |
| `--color-error` | base08 | Error red |
| `--color-success` | base0B | Success green |
| `--color-thinking` | base0A | Thinking yellow |
| `--color-thinking-bg` | base0A at 6% alpha | Thinking bg |
| `--color-tool` | base0D | Tool blue |
| `--color-tool-bg` | base0D at 4% alpha | Tool bg |

Additional computed variables for syntax highlighting (`--hl-*`), overlay RGB values, sidebar bg, etc.

## Theme Store

**File:** `src/lib/public/stores/theme.svelte.ts`

```typescript
export const themeState = $state({
  currentThemeId: "default",
  themes: {},
  customThemeIds: new Set(),
  themesLoaded: false,
  pickerOpen: false,
  computedVars: {},
  variant: "light" as "light" | "dark",
});
```

**Key functions:**
- `loadThemes()` — fetch `/api/themes`, validate, store
- `computeVars(theme)` — pure function, Base16 → CSS vars
- `applyTheme(themeId)` — compute + apply + persist
- `initTheme()` — called from `app-entry.ts`, load + apply saved theme
- `computeTerminalTheme(theme)` — Base16 → xterm.js theme object
- `computeMermaidVars(theme)` — Base16 → mermaid theme variables

**localStorage keys:**
- `opencode-relay-theme` — theme ID
- `opencode-relay-theme-vars` — JSON of all CSS vars (flash prevention)
- `opencode-relay-theme-variant` — "dark" or "light"

**Color utility functions** (ported from claude-relay):
- `hexToRgb`, `rgbToHex`, `darken`, `lighten`, `hexToRgba`, `mixColors`, `luminance`

## Flash Prevention

Inline blocking `<script>` in `index.html`, before CSS loads:

```html
<script>
(function(){
  var v = localStorage.getItem("opencode-relay-theme-vars");
  if (!v) return;
  try {
    var o = JSON.parse(v);
    var root = document.documentElement;
    for (var p in o) root.style.setProperty(p, o[p]);
    var vt = localStorage.getItem("opencode-relay-theme-variant");
    if (vt === "light") root.classList.add("light-theme");
    else if (vt === "dark") root.classList.add("dark-theme");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && o["--color-bg"]) meta.setAttribute("content", o["--color-bg"]);
  } catch(e) {}
})();
</script>
```

## Theme Picker UI

**File:** `src/lib/public/components/overlays/ThemePicker.svelte`

- Palette icon button in sidebar footer (next to "OpenCode Relay" text)
- Fixed-position popup above the footer
- 3 sections with sticky headers: Dark, Light, Custom
- Each item: 5 color swatches (base00, base01, base09, base0B, base0D) + name + active checkmark
- Click to apply immediately (live preview)
- Click outside to close
- Animated: fade in + slide up

## Subsystem Integration

### Terminal (xterm.js)
- Add `setTheme(theme)` method to `XtermAdapter`
- `$effect` in terminal component reacts to theme changes, updates all open terminals

### Syntax Highlighting (highlight.js)
- Replace static `github.css` import with CSS-variable-based highlight theme
- Write `highlight-theme.css` mapping `--hl-*` variables to `.hljs-*` classes
- Variables update automatically when theme changes

### Mermaid Diagrams
- Replace hardcoded `themeVariables` in `AssistantMessage.svelte` with `computeMermaidVars()`
- Re-initialize mermaid when theme changes

### Hardcoded Colors
- Replace scattered `rgba(0,0,0,...)` values with CSS variables
- Replace diff colors (`#1a7f23`, `#c0392b`) with theme-aware tokens
- Replace scrollbar colors, plan mode colors, link colors

## Default Behavior

- New users see the current warm-neutral light theme (no localStorage = `@theme` block values apply)
- Theme selection persists across sessions via localStorage
- Custom themes in `~/.opencode-relay/themes/` appear in a "Custom" section
- Custom themes with same filename as bundled themes override them

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Svelte-native store + component | Idiomatic to codebase, testable, reactive |
| Theme format | Base16 JSON | Proven, shared with claude-relay, extensive ecosystem |
| CSS mapping | Override existing `--color-*` tokens | Zero changes to Tailwind classes needed |
| Default theme | Current light palette | Preserve existing experience |
| Picker location | Sidebar footer | Matches claude-relay, unobtrusive |
| Flash prevention | Inline script + localStorage | Same proven approach as claude-relay |

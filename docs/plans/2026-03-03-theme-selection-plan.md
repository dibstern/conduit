# Theme Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a full Base16 theme selection system to opencode-relay with 22 bundled themes, a picker UI, custom user themes, and integration with xterm.js, highlight.js, and Mermaid.

**Architecture:** Svelte 5 store (`theme.svelte.ts`) computes CSS variables from Base16 palettes and applies them to `:root`. A `ThemePicker.svelte` component provides selection UI in the sidebar footer. Server-side endpoint serves bundled + custom theme JSON files.

**Tech Stack:** Svelte 5, TypeScript, Tailwind CSS v4, Vite, Node.js

---

### Task 1: Copy Bundled Theme JSON Files

**Files:**
- Create: `src/lib/themes/` directory
- Create: `src/lib/themes/claude.json` (and 21 other theme files)

**Step 1: Create themes directory**

Run: `mkdir -p src/lib/themes`

**Step 2: Copy all 22 theme JSON files from claude-relay**

Run: `cp ~/src/personal/opencode-relay/claude-relay/lib/themes/*.json src/lib/themes/`

**Step 3: Verify files copied**

Run: `ls src/lib/themes/ | wc -l`
Expected: 22

**Step 4: Commit**

```bash
git add src/lib/themes/
git commit -m "feat: add 22 bundled Base16 theme files"
```

---

### Task 2: Add `/api/themes` Server Endpoint

**Files:**
- Modify: `src/lib/http-router.ts` (add endpoint around line 232)
- Modify: `src/lib/env.ts` (import for config dir, already has `DEFAULT_CONFIG_DIR`)

**Step 1: Write the failing test**

Create: `tests/unit/theme-endpoint.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Test the theme loading logic directly (extracted function)
import { loadThemeFiles } from "../../src/lib/theme-loader.js";

describe("loadThemeFiles", () => {
    it("loads bundled theme files from the themes directory", async () => {
        const result = await loadThemeFiles();
        expect(result.bundled).toBeDefined();
        expect(Object.keys(result.bundled).length).toBeGreaterThanOrEqual(22);
        expect(result.bundled["claude"]).toBeDefined();
        expect(result.bundled["claude"].name).toBe("Claude Dark");
        expect(result.bundled["claude"].base00).toBe("2F2E2B");
    });

    it("returns empty custom object when no custom themes exist", async () => {
        const result = await loadThemeFiles();
        expect(result.custom).toBeDefined();
        expect(typeof result.custom).toBe("object");
    });

    it("validates theme files have required base16 keys", async () => {
        const result = await loadThemeFiles();
        const theme = result.bundled["claude"];
        const keys = ["base00","base01","base02","base03","base04","base05","base06","base07",
                      "base08","base09","base0A","base0B","base0C","base0D","base0E","base0F"];
        for (const key of keys) {
            expect(theme[key]).toMatch(/^[0-9a-fA-F]{6}$/);
        }
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/theme-endpoint.test.ts`
Expected: FAIL — `loadThemeFiles` does not exist

**Step 3: Create theme-loader module**

Create: `src/lib/theme-loader.ts`

```typescript
import { readdir, readFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_DIR } from "./env.js";

const BASE16_KEYS = [
    "base00","base01","base02","base03","base04","base05","base06","base07",
    "base08","base09","base0A","base0B","base0C","base0D","base0E","base0F",
] as const;

export interface Base16Theme {
    name: string;
    author?: string;
    variant: "dark" | "light";
    [key: string]: string | undefined;
}

function validateTheme(t: unknown): t is Base16Theme {
    if (!t || typeof t !== "object") return false;
    const obj = t as Record<string, unknown>;
    if (!obj.name || typeof obj.name !== "string") return false;
    for (const key of BASE16_KEYS) {
        if (!obj[key] || typeof obj[key] !== "string") return false;
        if (!/^[0-9a-fA-F]{6}$/.test(obj[key] as string)) return false;
    }
    if (obj.variant && obj.variant !== "dark" && obj.variant !== "light") return false;
    if (!obj.variant) {
        // Auto-detect from base00 luminance
        const hex = obj.base00 as string;
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        (obj as Record<string, string>).variant = lum > 0.5 ? "light" : "dark";
    }
    return true;
}

async function readThemesFromDir(dir: string): Promise<Record<string, Base16Theme>> {
    const themes: Record<string, Base16Theme> = {};
    let files: string[];
    try {
        files = await readdir(dir);
    } catch {
        return themes;
    }
    for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
            const raw = await readFile(join(dir, file), "utf-8");
            const parsed = JSON.parse(raw);
            if (validateTheme(parsed)) {
                const id = basename(file, ".json");
                themes[id] = parsed as Base16Theme;
            }
        } catch {
            // Skip invalid files
        }
    }
    return themes;
}

/** Resolve the bundled themes directory (adjacent to this module in the dist). */
function getBundledThemesDir(): string {
    // In dist, themes are at dist/src/lib/themes/ (copied by build)
    // At dev time, they're at src/lib/themes/
    const thisFile = fileURLToPath(import.meta.url);
    return join(thisFile, "..", "themes");
}

/** User custom themes directory: ~/.opencode-relay/themes/ */
function getCustomThemesDir(): string {
    return join(DEFAULT_CONFIG_DIR, "themes");
}

export async function loadThemeFiles(): Promise<{
    bundled: Record<string, Base16Theme>;
    custom: Record<string, Base16Theme>;
}> {
    const [bundled, custom] = await Promise.all([
        readThemesFromDir(getBundledThemesDir()),
        readThemesFromDir(getCustomThemesDir()),
    ]);
    return { bundled, custom };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/theme-endpoint.test.ts`
Expected: PASS

**Step 5: Add the endpoint to http-router.ts**

Modify: `src/lib/http-router.ts`

After the `/info` endpoint (around line 232), add:

```typescript
// Theme list API
if (pathname === "/api/themes" && req.method === "GET") {
    try {
        const { loadThemeFiles } = await import("./theme-loader.js");
        const themes = await loadThemeFiles();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(themes));
    } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to load themes" }));
    }
    return;
}
```

**Step 6: Ensure themes directory is copied in build**

Check the build config. The `src/lib/themes/` directory needs to be available at runtime. Since the server uses `tsc` output in `dist/`, we need to ensure the JSON files get copied. Add a copy step or adjust `tsconfig.json` to include JSON files.

Modify: `tsconfig.json` — ensure `"resolveJsonModule": true` is set. Alternatively, add a build script step to copy `src/lib/themes/*.json` → `dist/src/lib/themes/`.

**Step 7: Commit**

```bash
git add src/lib/theme-loader.ts src/lib/http-router.ts tests/unit/theme-endpoint.test.ts
git commit -m "feat: add /api/themes endpoint with theme loader"
```

---

### Task 3: Create Color Utility Functions

**Files:**
- Create: `src/lib/public/utils/color.ts`
- Create: `tests/unit/color.test.ts`

**Step 1: Write the failing test**

Create: `tests/unit/color.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { hexToRgb, rgbToHex, darken, lighten, hexToRgba, mixColors, luminance } from "../../src/lib/public/utils/color.js";

describe("color utilities", () => {
    it("hexToRgb converts hex to RGB", () => {
        expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
        expect(hexToRgb("#2F2E2B")).toEqual({ r: 47, g: 46, b: 43 });
    });

    it("rgbToHex converts RGB to hex", () => {
        expect(rgbToHex(255, 0, 0)).toBe("#ff0000");
        expect(rgbToHex(47, 46, 43)).toBe("#2f2e2b");
    });

    it("darken reduces brightness", () => {
        const result = darken("#ffffff", 0.5);
        expect(result).toBe("#808080");
    });

    it("lighten increases brightness", () => {
        const result = lighten("#000000", 0.5);
        expect(result).toBe("#808080");
    });

    it("hexToRgba creates rgba string", () => {
        expect(hexToRgba("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    });

    it("mixColors blends two colors", () => {
        const result = mixColors("#ffffff", "#000000", 0.5);
        expect(result).toBe("#808080");
    });

    it("luminance returns value between 0 and 1", () => {
        expect(luminance("#000000")).toBeCloseTo(0, 1);
        expect(luminance("#ffffff")).toBeCloseTo(1, 1);
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/color.test.ts`
Expected: FAIL

**Step 3: Implement color utilities**

Create: `src/lib/public/utils/color.ts`

```typescript
export interface RGB {
    r: number;
    g: number;
    b: number;
}

export function hexToRgb(hex: string): RGB {
    const h = hex.replace("#", "");
    return {
        r: parseInt(h.substring(0, 2), 16),
        g: parseInt(h.substring(2, 4), 16),
        b: parseInt(h.substring(4, 6), 16),
    };
}

export function rgbToHex(r: number, g: number, b: number): string {
    return (
        "#" +
        [r, g, b]
            .map((v) => {
                const c = Math.max(0, Math.min(255, Math.round(v)));
                return c.toString(16).padStart(2, "0");
            })
            .join("")
    );
}

export function darken(hex: string, amount: number): string {
    const c = hexToRgb(hex);
    const f = 1 - amount;
    return rgbToHex(c.r * f, c.g * f, c.b * f);
}

export function lighten(hex: string, amount: number): string {
    const c = hexToRgb(hex);
    return rgbToHex(
        c.r + (255 - c.r) * amount,
        c.g + (255 - c.g) * amount,
        c.b + (255 - c.b) * amount,
    );
}

export function mixColors(hex1: string, hex2: string, weight: number): string {
    const c1 = hexToRgb(hex1);
    const c2 = hexToRgb(hex2);
    return rgbToHex(
        c1.r * weight + c2.r * (1 - weight),
        c1.g * weight + c2.g * (1 - weight),
        c1.b * weight + c2.b * (1 - weight),
    );
}

export function hexToRgba(hex: string, alpha: number): string {
    const c = hexToRgb(hex);
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

export function luminance(hex: string): number {
    const c = hexToRgb(hex);
    return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/color.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/public/utils/color.ts tests/unit/color.test.ts
git commit -m "feat: add color utility functions for theme computation"
```

---

### Task 4: Create Theme Store

**Files:**
- Create: `src/lib/public/stores/theme.svelte.ts`
- Create: `tests/unit/theme-compute.test.ts`

**Step 1: Write the failing test for computeVars**

Create: `tests/unit/theme-compute.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { computeVars, computeTerminalTheme, computeMermaidVars } from "../../src/lib/public/stores/theme-compute.js";

// Claude Dark theme for testing
const claudeDark = {
    name: "Claude Dark",
    variant: "dark" as const,
    base00: "2F2E2B", base01: "35332F", base02: "3E3C37", base03: "6D6860",
    base04: "908B81", base05: "B5B0A6", base06: "E8E5DE", base07: "FFFFFF",
    base08: "E5534B", base09: "DA7756", base0A: "E5A84B", base0B: "57AB5A",
    base0C: "4EC9B0", base0D: "569CD6", base0E: "C586C0", base0F: "D7BA7D",
};

describe("computeVars", () => {
    it("maps base16 to CSS custom properties", () => {
        const vars = computeVars(claudeDark);
        expect(vars["--color-bg"]).toBe("#2F2E2B");
        expect(vars["--color-text"]).toBe("#E8E5DE");
        expect(vars["--color-accent"]).toBe("#DA7756");
        expect(vars["--color-error"]).toBe("#E5534B");
        expect(vars["--color-success"]).toBe("#57AB5A");
    });

    it("computes derived colors for dark themes", () => {
        const vars = computeVars(claudeDark);
        expect(vars["--color-accent-hover"]).toBeDefined();
        expect(vars["--color-code-bg"]).toBeDefined();
        expect(vars["--color-border-subtle"]).toBeDefined();
    });

    it("includes syntax highlighting variables", () => {
        const vars = computeVars(claudeDark);
        expect(vars["--hl-comment"]).toBe("#6D6860");
        expect(vars["--hl-keyword"]).toBe("#C586C0");
        expect(vars["--hl-string"]).toBe("#57AB5A");
    });
});

describe("computeTerminalTheme", () => {
    it("returns xterm-compatible theme object", () => {
        const theme = computeTerminalTheme(claudeDark);
        expect(theme.background).toBeDefined();
        expect(theme.foreground).toBeDefined();
        expect(theme.red).toBe("#E5534B");
        expect(theme.green).toBe("#57AB5A");
    });
});

describe("computeMermaidVars", () => {
    it("returns mermaid theme variables", () => {
        const vars = computeMermaidVars(claudeDark);
        expect(vars.darkMode).toBe(true);
        expect(vars.primaryColor).toBeDefined();
        expect(vars.primaryTextColor).toBeDefined();
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/theme-compute.test.ts`
Expected: FAIL

**Step 3: Create pure computation module**

Create: `src/lib/public/stores/theme-compute.ts`

This file contains the pure functions (no Svelte runes, no DOM access):

```typescript
import { darken, lighten, hexToRgba, mixColors } from "../utils/color.js";

const BASE16_KEYS = [
    "base00","base01","base02","base03","base04","base05","base06","base07",
    "base08","base09","base0A","base0B","base0C","base0D","base0E","base0F",
] as const;

export interface Base16Theme {
    name: string;
    author?: string;
    variant: "dark" | "light";
    [key: string]: string | undefined;
}

export function computeVars(theme: Base16Theme): Record<string, string> {
    const b: Record<string, string> = {};
    for (const key of BASE16_KEYS) {
        b[key] = "#" + theme[key];
    }

    const isLight = theme.variant === "light";

    return {
        "--color-bg":             b.base00,
        "--color-bg-alt":         b.base01,
        "--color-bg-surface":     b.base01,
        "--color-text":           b.base06,
        "--color-text-secondary": b.base05,
        "--color-text-muted":     b.base04,
        "--color-text-dimmer":    b.base03,
        "--color-accent":         b.base09,
        "--color-accent-hover":   isLight ? darken(b.base09, 0.12) : lighten(b.base09, 0.12),
        "--color-accent-bg":      hexToRgba(b.base09, 0.12),
        "--color-code-bg":        isLight ? darken(b.base00, 0.03) : darken(b.base00, 0.15),
        "--color-border":         b.base02,
        "--color-border-subtle":  mixColors(b.base00, b.base02, 0.6),
        "--color-input-bg":       mixColors(b.base01, b.base02, 0.5),
        "--color-user-bubble":    isLight ? darken(b.base01, 0.03) : mixColors(b.base01, b.base02, 0.3),
        "--color-error":          b.base08,
        "--color-success":        b.base0B,
        "--color-thinking":       b.base0A,
        "--color-thinking-bg":    hexToRgba(b.base0A, 0.06),
        "--color-tool":           b.base0D,
        "--color-tool-bg":        hexToRgba(b.base0D, 0.04),
        "--color-sidebar-bg":     isLight ? darken(b.base00, 0.02) : darken(b.base00, 0.10),
        "--color-sidebar-hover":  isLight ? darken(b.base00, 0.06) : mixColors(b.base00, b.base01, 0.5),
        "--color-sidebar-active": isLight ? darken(b.base01, 0.05) : mixColors(b.base01, b.base02, 0.5),
        "--color-warning":        b.base0A,
        "--color-warning-bg":     hexToRgba(b.base0A, 0.12),
        "--overlay-rgb":          isLight ? "0,0,0" : "255,255,255",
        "--shadow-rgb":           "0,0,0",
        // Syntax highlighting
        "--hl-comment":           b.base03,
        "--hl-keyword":           b.base0E,
        "--hl-string":            b.base0B,
        "--hl-number":            b.base09,
        "--hl-function":          b.base0D,
        "--hl-variable":          b.base08,
        "--hl-type":              b.base0A,
        "--hl-constant":          b.base09,
        "--hl-tag":               b.base08,
        "--hl-attr":              b.base0D,
        "--hl-regexp":            b.base0C,
        "--hl-meta":              b.base0F,
        "--hl-builtin":           b.base09,
        "--hl-symbol":            b.base0F,
        "--hl-addition":          b.base0B,
        "--hl-deletion":          b.base08,
    };
}

export function computeTerminalTheme(theme: Base16Theme): Record<string, string> {
    const b: Record<string, string> = {};
    for (const key of BASE16_KEYS) {
        b[key] = "#" + theme[key];
    }

    const isLight = theme.variant === "light";
    return {
        background:          isLight ? darken(b.base00, 0.03) : darken(b.base00, 0.15),
        foreground:          b.base05,
        cursor:              b.base06,
        selectionBackground: hexToRgba(b.base02, 0.5),
        black:               isLight ? b.base07 : b.base00,
        red:                 b.base08,
        green:               b.base0B,
        yellow:              b.base0A,
        blue:                b.base0D,
        magenta:             b.base0E,
        cyan:                b.base0C,
        white:               isLight ? b.base00 : b.base05,
        brightBlack:         b.base03,
        brightRed:           isLight ? darken(b.base08, 0.1) : lighten(b.base08, 0.1),
        brightGreen:         isLight ? darken(b.base0B, 0.1) : lighten(b.base0B, 0.1),
        brightYellow:        isLight ? darken(b.base0A, 0.1) : lighten(b.base0A, 0.1),
        brightBlue:          isLight ? darken(b.base0D, 0.1) : lighten(b.base0D, 0.1),
        brightMagenta:       isLight ? darken(b.base0E, 0.1) : lighten(b.base0E, 0.1),
        brightCyan:          isLight ? darken(b.base0C, 0.1) : lighten(b.base0C, 0.1),
        brightWhite:         b.base07,
    };
}

export function computeMermaidVars(theme: Base16Theme): {
    darkMode: boolean;
    background: string;
    primaryColor: string;
    primaryTextColor: string;
    primaryBorderColor: string;
    lineColor: string;
    secondaryColor: string;
    tertiaryColor: string;
    fontFamily: string;
} {
    const vars = computeVars(theme);
    const isLight = theme.variant === "light";
    return {
        darkMode: !isLight,
        background: vars["--color-code-bg"],
        primaryColor: vars["--color-accent"],
        primaryTextColor: vars["--color-text"],
        primaryBorderColor: vars["--color-border"],
        lineColor: vars["--color-text-muted"],
        secondaryColor: vars["--color-bg-alt"],
        tertiaryColor: vars["--color-bg"],
        fontFamily: "'Berkeley Mono', 'IBM Plex Mono', ui-monospace, monospace",
    };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/theme-compute.test.ts`
Expected: PASS

**Step 5: Create the Svelte theme store**

Create: `src/lib/public/stores/theme.svelte.ts`

```typescript
import { computeVars, computeTerminalTheme, computeMermaidVars } from "./theme-compute.js";
import type { Base16Theme } from "./theme-compute.js";

// Re-export for consumers
export { computeTerminalTheme, computeMermaidVars };
export type { Base16Theme };

const STORAGE_KEY_THEME = "opencode-relay-theme";
const STORAGE_KEY_VARS = "opencode-relay-theme-vars";
const STORAGE_KEY_VARIANT = "opencode-relay-theme-variant";

export const themeState = $state({
    currentThemeId: "default",
    themes: {} as Record<string, Base16Theme>,
    customThemeIds: new Set<string>(),
    themesLoaded: false,
    pickerOpen: false,
    computedVars: {} as Record<string, string>,
    variant: "light" as "light" | "dark",
});

type ThemeChangeCallback = (themeId: string, vars: Record<string, string>) => void;
const changeCallbacks: ThemeChangeCallback[] = [];

export function onThemeChange(cb: ThemeChangeCallback): void {
    changeCallbacks.push(cb);
}

export function toggleThemePicker(): void {
    themeState.pickerOpen = !themeState.pickerOpen;
}

export function closeThemePicker(): void {
    themeState.pickerOpen = false;
}

export function applyTheme(themeId: string): void {
    if (themeId === "default") {
        // Remove all inline style overrides — fall back to @theme block defaults
        const root = document.documentElement;
        for (const key of Object.keys(themeState.computedVars)) {
            root.style.removeProperty(key);
        }
        root.classList.remove("light-theme", "dark-theme");
        root.classList.add("light-theme");
        themeState.currentThemeId = "default";
        themeState.computedVars = {};
        themeState.variant = "light";
        // Update meta theme-color
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute("content", "#fdfdfc");
        // Persist
        localStorage.setItem(STORAGE_KEY_THEME, "default");
        localStorage.removeItem(STORAGE_KEY_VARS);
        localStorage.setItem(STORAGE_KEY_VARIANT, "light");
        for (const cb of changeCallbacks) cb("default", {});
        return;
    }

    const theme = themeState.themes[themeId];
    if (!theme) return;

    const vars = computeVars(theme);
    const root = document.documentElement;

    // Apply all CSS variables
    for (const [key, value] of Object.entries(vars)) {
        root.style.setProperty(key, value);
    }

    // Toggle light/dark class
    const isLight = theme.variant === "light";
    root.classList.toggle("light-theme", isLight);
    root.classList.toggle("dark-theme", !isLight);

    // Update meta theme-color
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", vars["--color-bg"]);

    // Update state
    themeState.currentThemeId = themeId;
    themeState.computedVars = vars;
    themeState.variant = theme.variant;

    // Persist
    localStorage.setItem(STORAGE_KEY_THEME, themeId);
    localStorage.setItem(STORAGE_KEY_VARS, JSON.stringify(vars));
    localStorage.setItem(STORAGE_KEY_VARIANT, theme.variant);

    // Fire callbacks
    for (const cb of changeCallbacks) cb(themeId, vars);
}

export async function loadThemes(): Promise<void> {
    try {
        const res = await fetch("/api/themes");
        if (!res.ok) return;
        const data = await res.json();
        const all: Record<string, Base16Theme> = {};
        const customIds = new Set<string>();

        if (data.bundled) {
            for (const [id, theme] of Object.entries(data.bundled)) {
                all[id] = theme as Base16Theme;
            }
        }
        if (data.custom) {
            for (const [id, theme] of Object.entries(data.custom)) {
                all[id] = theme as Base16Theme;
                customIds.add(id);
            }
        }

        themeState.themes = all;
        themeState.customThemeIds = customIds;
        themeState.themesLoaded = true;
    } catch {
        // Failed to load themes — leave empty
    }
}

export async function initTheme(): Promise<void> {
    await loadThemes();

    // Apply saved theme
    const saved = localStorage.getItem(STORAGE_KEY_THEME);
    if (saved && saved !== "default" && themeState.themes[saved]) {
        applyTheme(saved);
    } else if (saved === "default" || !saved) {
        themeState.currentThemeId = "default";
        themeState.variant = "light";
    }
}

/** Get the current theme object (or undefined for default) */
export function getCurrentTheme(): Base16Theme | undefined {
    return themeState.themes[themeState.currentThemeId];
}

/** Get sorted theme lists for the picker */
export function getThemeLists(): {
    dark: Array<{ id: string; theme: Base16Theme }>;
    light: Array<{ id: string; theme: Base16Theme }>;
    custom: Array<{ id: string; theme: Base16Theme }>;
} {
    const dark: Array<{ id: string; theme: Base16Theme }> = [];
    const light: Array<{ id: string; theme: Base16Theme }> = [];
    const custom: Array<{ id: string; theme: Base16Theme }> = [];

    for (const [id, theme] of Object.entries(themeState.themes)) {
        const entry = { id, theme };
        if (themeState.customThemeIds.has(id)) {
            custom.push(entry);
        } else if (theme.variant === "dark") {
            dark.push(entry);
        } else {
            light.push(entry);
        }
    }

    // Pin claude/claude-light first in their sections
    const pinFirst = (list: typeof dark, pinnedId: string) => {
        const idx = list.findIndex((e) => e.id === pinnedId);
        if (idx > 0) list.unshift(...list.splice(idx, 1));
    };
    pinFirst(dark, "claude");
    pinFirst(light, "claude-light");

    return { dark, light, custom };
}
```

**Step 6: Commit**

```bash
git add src/lib/public/stores/theme.svelte.ts src/lib/public/stores/theme-compute.ts tests/unit/theme-compute.test.ts
git commit -m "feat: add theme store with compute functions and reactive state"
```

---

### Task 5: Add Flash Prevention to index.html

**Files:**
- Modify: `src/lib/public/index.html`

**Step 1: Add inline blocking script**

Add the following `<script>` tag inside `<head>`, before the `<link rel="stylesheet" href="/style.css">` line:

```html
<script>
(function(){
  var v=localStorage.getItem("opencode-relay-theme-vars");
  if(!v)return;
  try{
    var o=JSON.parse(v),root=document.documentElement,p;
    for(p in o)root.style.setProperty(p,o[p]);
    var vt=localStorage.getItem("opencode-relay-theme-variant");
    if(vt==="light")root.classList.add("light-theme");
    else if(vt==="dark")root.classList.add("dark-theme");
    var meta=document.querySelector('meta[name="theme-color"]');
    if(meta&&o["--color-bg"])meta.setAttribute("content",o["--color-bg"]);
  }catch(e){}
})();
</script>
```

**Step 2: Verify no FOUC**

Run: dev server, select a dark theme, reload page. Should not flash white.

**Step 3: Commit**

```bash
git add src/lib/public/index.html
git commit -m "feat: add flash-prevention inline script for theme persistence"
```

---

### Task 6: Initialize Theme in app-entry.ts

**Files:**
- Modify: `src/lib/public/app-entry.ts`

**Step 1: Add initTheme call**

```typescript
import { mount } from "svelte";
import App from "./App.svelte";
import { initTheme } from "./stores/theme.svelte.js";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app mount point");

// Initialize theme (loads from server + applies saved preference)
initTheme();

mount(App, { target });
```

**Step 2: Commit**

```bash
git add src/lib/public/app-entry.ts
git commit -m "feat: initialize theme system on app startup"
```

---

### Task 7: Create highlight-theme.css

Replace the static `highlight.js/styles/github.css` import with a CSS-variable-driven highlight theme.

**Files:**
- Create: `src/lib/public/highlight-theme.css`
- Modify: `src/lib/public/style.css` (import the new file)
- Modify: `src/lib/public/components/features/FileViewer.svelte` (remove github.css import)

**Step 1: Create the CSS-variable-driven highlight theme**

Create: `src/lib/public/highlight-theme.css`

```css
/* Syntax highlighting driven by theme CSS variables (--hl-*) */
.hljs { color: var(--color-text); background: var(--color-code-bg); }
.hljs-comment, .hljs-quote { color: var(--hl-comment); font-style: italic; }
.hljs-keyword, .hljs-selector-tag { color: var(--hl-keyword); }
.hljs-string, .hljs-doctag { color: var(--hl-string); }
.hljs-number, .hljs-literal { color: var(--hl-number); }
.hljs-title, .hljs-title.function_ { color: var(--hl-function); }
.hljs-variable, .hljs-template-variable { color: var(--hl-variable); }
.hljs-type, .hljs-title.class_ { color: var(--hl-type); }
.hljs-built_in { color: var(--hl-builtin); }
.hljs-tag { color: var(--hl-tag); }
.hljs-attr, .hljs-attribute { color: var(--hl-attr); }
.hljs-regexp { color: var(--hl-regexp); }
.hljs-meta { color: var(--hl-meta); }
.hljs-symbol, .hljs-bullet { color: var(--hl-symbol); }
.hljs-addition { color: var(--hl-addition); background: rgba(87, 171, 90, 0.1); }
.hljs-deletion { color: var(--hl-deletion); background: rgba(229, 83, 75, 0.1); }
.hljs-name { color: var(--hl-tag); }
.hljs-selector-id, .hljs-selector-class { color: var(--hl-variable); }
.hljs-section, .hljs-strong { font-weight: bold; }
.hljs-emphasis { font-style: italic; }
.hljs-link { color: var(--hl-function); text-decoration: underline; }
```

**Step 2: Import in style.css**

Add to the top of `src/lib/public/style.css` (after existing imports):

```css
@import "./highlight-theme.css";
```

**Step 3: Remove static github.css import from FileViewer.svelte**

Remove: `import "highlight.js/styles/github.css";`

**Step 4: Add default --hl-* values to @theme block**

Add to the `@theme` block in `style.css` (these are the default light theme values):

```css
    /* Syntax highlighting defaults (light theme) */
    --hl-comment: hsl(0, 1%, 60%);
    --hl-keyword: hsl(300, 30%, 55%);
    --hl-string: hsl(130, 40%, 42%);
    --hl-number: hsl(20, 60%, 55%);
    --hl-function: hsl(210, 50%, 55%);
    --hl-variable: hsl(0, 65%, 55%);
    --hl-type: hsl(38, 55%, 55%);
    --hl-constant: hsl(20, 60%, 55%);
    --hl-tag: hsl(0, 65%, 55%);
    --hl-attr: hsl(210, 50%, 55%);
    --hl-regexp: hsl(180, 50%, 45%);
    --hl-meta: hsl(38, 50%, 55%);
    --hl-builtin: hsl(20, 60%, 55%);
    --hl-symbol: hsl(38, 50%, 55%);
    --hl-addition: hsl(130, 40%, 42%);
    --hl-deletion: hsl(0, 65%, 55%);
```

**Step 5: Commit**

```bash
git add src/lib/public/highlight-theme.css src/lib/public/style.css src/lib/public/components/features/FileViewer.svelte
git commit -m "feat: replace static hljs theme with CSS-variable-driven highlight theme"
```

---

### Task 8: Create ThemePicker Component

**Files:**
- Create: `src/lib/public/components/overlays/ThemePicker.svelte`
- Modify: `src/lib/public/components/layout/Sidebar.svelte`

**Step 1: Create ThemePicker.svelte**

Create: `src/lib/public/components/overlays/ThemePicker.svelte`

```svelte
<script lang="ts">
    import {
        themeState,
        getThemeLists,
        applyTheme,
        closeThemePicker,
    } from "../../stores/theme.svelte.js";

    let pickerEl: HTMLDivElement;

    const lists = $derived(getThemeLists());

    function handleClickOutside(e: MouseEvent) {
        if (pickerEl && !pickerEl.contains(e.target as Node)) {
            closeThemePicker();
        }
    }

    function selectTheme(id: string) {
        applyTheme(id);
    }

    $effect(() => {
        if (themeState.pickerOpen) {
            // Delay to avoid immediately closing from the same click
            setTimeout(() => {
                document.addEventListener("click", handleClickOutside);
            }, 0);
        }
        return () => {
            document.removeEventListener("click", handleClickOutside);
        };
    });
</script>

{#if themeState.pickerOpen}
    <div
        bind:this={pickerEl}
        class="theme-picker"
        role="listbox"
        aria-label="Select theme"
    >
        {#if lists.dark.length > 0}
            <div class="theme-picker-section">
                <div class="theme-picker-header">Dark</div>
                {#each lists.dark as { id, theme }}
                    <button
                        class="theme-picker-item"
                        class:active={themeState.currentThemeId === id}
                        onclick={() => selectTheme(id)}
                        role="option"
                        aria-selected={themeState.currentThemeId === id}
                    >
                        <div class="theme-swatches">
                            <span class="theme-swatch" style="background:#{theme.base00}"></span>
                            <span class="theme-swatch" style="background:#{theme.base01}"></span>
                            <span class="theme-swatch" style="background:#{theme.base09}"></span>
                            <span class="theme-swatch" style="background:#{theme.base0B}"></span>
                            <span class="theme-swatch" style="background:#{theme.base0D}"></span>
                        </div>
                        <span class="theme-picker-label">{theme.name}</span>
                        {#if themeState.currentThemeId === id}
                            <span class="theme-picker-check">&#10003;</span>
                        {/if}
                    </button>
                {/each}
            </div>
        {/if}

        {#if lists.light.length > 0}
            <div class="theme-picker-section">
                <div class="theme-picker-header">Light</div>
                <button
                    class="theme-picker-item"
                    class:active={themeState.currentThemeId === "default"}
                    onclick={() => selectTheme("default")}
                    role="option"
                    aria-selected={themeState.currentThemeId === "default"}
                >
                    <div class="theme-swatches">
                        <span class="theme-swatch" style="background:#fdfdfc"></span>
                        <span class="theme-swatch" style="background:#f7f6f5"></span>
                        <span class="theme-swatch" style="background:#1d1b1b"></span>
                        <span class="theme-swatch" style="background:#12c905"></span>
                        <span class="theme-swatch" style="background:#5c9cf5"></span>
                    </div>
                    <span class="theme-picker-label">Default Light</span>
                    {#if themeState.currentThemeId === "default"}
                        <span class="theme-picker-check">&#10003;</span>
                    {/if}
                </button>
                {#each lists.light as { id, theme }}
                    <button
                        class="theme-picker-item"
                        class:active={themeState.currentThemeId === id}
                        onclick={() => selectTheme(id)}
                        role="option"
                        aria-selected={themeState.currentThemeId === id}
                    >
                        <div class="theme-swatches">
                            <span class="theme-swatch" style="background:#{theme.base00}"></span>
                            <span class="theme-swatch" style="background:#{theme.base01}"></span>
                            <span class="theme-swatch" style="background:#{theme.base09}"></span>
                            <span class="theme-swatch" style="background:#{theme.base0B}"></span>
                            <span class="theme-swatch" style="background:#{theme.base0D}"></span>
                        </div>
                        <span class="theme-picker-label">{theme.name}</span>
                        {#if themeState.currentThemeId === id}
                            <span class="theme-picker-check">&#10003;</span>
                        {/if}
                    </button>
                {/each}
            </div>
        {/if}

        {#if lists.custom.length > 0}
            <div class="theme-picker-section">
                <div class="theme-picker-header">Custom</div>
                {#each lists.custom as { id, theme }}
                    <button
                        class="theme-picker-item"
                        class:active={themeState.currentThemeId === id}
                        onclick={() => selectTheme(id)}
                        role="option"
                        aria-selected={themeState.currentThemeId === id}
                    >
                        <div class="theme-swatches">
                            <span class="theme-swatch" style="background:#{theme.base00}"></span>
                            <span class="theme-swatch" style="background:#{theme.base01}"></span>
                            <span class="theme-swatch" style="background:#{theme.base09}"></span>
                            <span class="theme-swatch" style="background:#{theme.base0B}"></span>
                            <span class="theme-swatch" style="background:#{theme.base0D}"></span>
                        </div>
                        <span class="theme-picker-label">{theme.name}</span>
                        {#if themeState.currentThemeId === id}
                            <span class="theme-picker-check">&#10003;</span>
                        {/if}
                    </button>
                {/each}
            </div>
        {/if}
    </div>
{/if}

<style>
    .theme-picker {
        position: fixed;
        bottom: 56px;
        left: 8px;
        width: 260px;
        max-height: 400px;
        overflow-y: auto;
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        padding: 4px;
        z-index: 1000;
        box-shadow: 0 4px 24px rgba(var(--shadow-rgb, 0,0,0), 0.15);
        animation: theme-picker-in 0.15s ease-out;
    }

    @keyframes theme-picker-in {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
    }

    .theme-picker-header {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--color-text-muted);
        padding: 8px 8px 4px;
        position: sticky;
        top: 0;
        background: var(--color-bg);
    }

    .theme-picker-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 8px;
        border: none;
        background: transparent;
        border-radius: 4px;
        cursor: pointer;
        font-family: inherit;
        font-size: 12px;
        color: var(--color-text-secondary);
        text-align: left;
    }

    .theme-picker-item:hover {
        background: var(--color-bg-alt);
    }

    .theme-picker-item.active {
        color: var(--color-text);
        font-weight: 500;
    }

    .theme-swatches {
        display: flex;
        gap: 2px;
        flex-shrink: 0;
    }

    .theme-swatch {
        width: 12px;
        height: 12px;
        border-radius: 2px;
        border: 1px solid rgba(var(--overlay-rgb, 0,0,0), 0.1);
    }

    .theme-picker-label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .theme-picker-check {
        color: var(--color-success);
        font-size: 14px;
        flex-shrink: 0;
    }
</style>
```

**Step 2: Update Sidebar.svelte footer**

Modify `Sidebar.svelte` — import theme store, add palette button, render ThemePicker:

Add to imports:
```typescript
import { Palette } from "@lucide/svelte";
import ThemePicker from "../overlays/ThemePicker.svelte";
import { toggleThemePicker } from "../../stores/theme.svelte.js";
```

Replace the footer div:
```svelte
<!-- Sidebar footer -->
<div
    id="sidebar-footer"
    class="px-3.5 py-3 border-t border-border-subtle shrink-0 flex items-center justify-between"
>
    <span class="sidebar-footer-text text-xs text-text-dimmer">OpenCode Relay</span>
    <button
        onclick={toggleThemePicker}
        class="p-1 rounded hover:bg-bg-alt text-text-dimmer hover:text-text-secondary transition-colors"
        title="Change theme"
    >
        <Palette size={14} />
    </button>
</div>
<ThemePicker />
```

**Step 3: Commit**

```bash
git add src/lib/public/components/overlays/ThemePicker.svelte src/lib/public/components/layout/Sidebar.svelte
git commit -m "feat: add theme picker component in sidebar footer"
```

---

### Task 9: Integrate with Terminal (xterm.js)

**Files:**
- Modify: `src/lib/public/utils/xterm-adapter.ts` (add setTheme method)
- Modify: `src/lib/public/components/features/TerminalPanel.svelte` (react to theme changes)

**Step 1: Add setTheme method to XtermAdapter**

In `xterm-adapter.ts`, add after the constructor:

```typescript
/** Update the terminal theme at runtime */
setTheme(theme: Record<string, string>): void {
    this.terminal.options.theme = theme;
}
```

**Step 2: Update TerminalPanel to react to theme changes**

In the terminal component/store that creates XtermAdapter instances, add an `$effect` that reacts to `themeState.currentThemeId` and calls `setTheme()` on all active adapters with the result of `computeTerminalTheme(getCurrentTheme())`.

Identify the exact component that manages terminal instances (likely `TerminalPanel.svelte` or the terminal store). Import `themeState`, `getCurrentTheme`, `computeTerminalTheme` from the theme store.

```typescript
$effect(() => {
    // Reactive dependency on theme ID
    const _themeId = themeState.currentThemeId;
    const theme = getCurrentTheme();
    if (theme) {
        const xtermTheme = computeTerminalTheme(theme);
        // Update all open terminal instances
        for (const adapter of activeAdapters) {
            adapter.setTheme(xtermTheme);
        }
    } else {
        // Default theme — use ANSI_THEME
        for (const adapter of activeAdapters) {
            adapter.setTheme(ANSI_THEME);
        }
    }
});
```

**Step 3: Commit**

```bash
git add src/lib/public/utils/xterm-adapter.ts src/lib/public/components/features/TerminalPanel.svelte
git commit -m "feat: integrate theme system with xterm.js terminal"
```

---

### Task 10: Integrate with Mermaid

**Files:**
- Modify: `src/lib/public/components/chat/AssistantMessage.svelte`

**Step 1: Replace hardcoded mermaid theme variables**

In `AssistantMessage.svelte`, replace the hardcoded `mermaid.initialize()` call with one that uses theme-computed values:

```typescript
import { themeState, getCurrentTheme, computeMermaidVars } from "../../stores/theme.svelte.js";

// Replace the hardcoded mermaid.initialize with:
function initializeMermaid() {
    const theme = getCurrentTheme();
    const vars = theme
        ? computeMermaidVars(theme)
        : {
            darkMode: false,
            background: "#fdfdfc",
            primaryColor: "#1d1b1b",
            primaryTextColor: "#1d1b1b",
            primaryBorderColor: "#e0dfde",
            lineColor: "#999999",
            secondaryColor: "#f7f6f5",
            tertiaryColor: "#fdfdfc",
            fontFamily: "'Berkeley Mono', 'IBM Plex Mono', ui-monospace, monospace",
        };

    mermaid.initialize({
        startOnLoad: false,
        theme: vars.darkMode ? "dark" : "default",
        themeVariables: vars,
    });
}
```

**Step 2: Add theme change listener to re-render mermaid diagrams**

Add an `$effect` that re-initializes mermaid when theme changes:

```typescript
$effect(() => {
    const _themeId = themeState.currentThemeId;
    initializeMermaid();
    // Re-render existing mermaid diagrams if any
    // (they use inline SVGs that don't auto-update)
});
```

**Step 3: Commit**

```bash
git add src/lib/public/components/chat/AssistantMessage.svelte
git commit -m "feat: integrate mermaid diagrams with theme system"
```

---

### Task 11: Add light-theme/dark-theme CSS Support

**Files:**
- Modify: `src/lib/public/style.css`

**Step 1: Add dark-theme scrollbar styles**

The current scrollbar style uses hardcoded `rgba(0,0,0,0.15)`. Add variant-aware overrides:

```css
.dark-theme *,
.dark-theme *::before,
.dark-theme *::after {
    scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
}
```

**Step 2: Add any other dark-variant overrides**

Search for hardcoded `rgba(0,0,0,...)` values in the stylesheet and component files. Replace with CSS-variable-based alternatives or add `.dark-theme` overrides.

Key places to check:
- Scrollbar colors in `@layer base`
- `.header-icon-btn:hover` background
- Diff view colors (should use `--hl-addition`/`--hl-deletion`)
- Plan mode colors in `plan-mode.css`

**Step 3: Add sidebar background variables**

If `--color-sidebar-bg`, `--color-sidebar-hover`, `--color-sidebar-active` aren't already in the `@theme` block, add defaults:

```css
    --color-sidebar-bg: hsl(0, 12%, 97%);
    --color-sidebar-hover: hsl(0, 8%, 94%);
    --color-sidebar-active: hsl(0, 8%, 91%);
```

**Step 4: Commit**

```bash
git add src/lib/public/style.css src/lib/public/plan-mode.css
git commit -m "feat: add dark-theme CSS overrides and sidebar theme variables"
```

---

### Task 12: Ensure Build Copies Theme JSON Files

**Files:**
- Modify: `package.json` (build script)
- Possibly modify: `tsconfig.json`

**Step 1: Check current build process**

Run: `cat package.json | grep -A5 '"build"'`

Understand how the server-side code is built and where `dist/` files end up.

**Step 2: Add copy step for theme JSON files**

The theme JSON files need to be available at the path that `theme-loader.ts` resolves. Add a post-build copy step or configure TypeScript to copy JSON files.

Option A — add to build script:
```json
"build:themes": "cp -r src/lib/themes dist/src/lib/themes"
```

Option B — use `tsconfig.json` with `"resolveJsonModule": true` and ensure JSON files are included.

**Step 3: Verify build works**

Run: `npm run build`
Verify: `ls dist/src/lib/themes/` shows 22 JSON files.

**Step 4: Commit**

```bash
git add package.json tsconfig.json
git commit -m "build: ensure theme JSON files are copied to dist"
```

---

### Task 13: End-to-End Verification

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Verify theme picker opens**

Navigate to the app, click the palette icon in the sidebar footer. The picker should show Dark, Light, and (if applicable) Custom sections.

**Step 3: Test theme switching**

Click a dark theme (e.g., Dracula). The entire UI should update:
- Background, text, and accent colors change
- Sidebar changes
- Code blocks use new syntax highlighting colors
- Terminal (if open) uses dark-on-dark colors

**Step 4: Test persistence**

Reload the page. The selected theme should persist (no flash).

**Step 5: Test default theme**

Click "Default Light" in the picker. The original light palette should restore.

**Step 6: Run existing tests**

Run: `npx vitest run`
Verify: All existing tests still pass (no regressions).

**Step 7: Run build**

Run: `npm run build`
Verify: Build succeeds without errors.

# README Media Generation Pipeline

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Create a `pnpm generate:media` script that generates all 5 README media assets (3 PNGs + 2 GIFs) using Playwright with mocked WebSocket data — no live relay or OpenCode server needed.

**Architecture:** A standalone TypeScript script drives Playwright against the built frontend (`vite preview`). Each media asset is a "scene" — a sequence of named **phases** and **assertions** that configure viewport, set up WS mocking with canned messages, drive the UI to the target state, and capture output (screenshot for PNGs, video recording + ffmpeg conversion for GIFs). A thin composition HTML page handles the side-by-side SPLIT GIF layout.

**Resilience design:** Scenes never screenshot blindly. Every scene declares DOM assertions that must pass before capture. The scene runner logs each phase with timing, captures debug screenshots on failure, collects browser console errors, and tracks all WS messages exchanged. Mock fixtures use the strict `RelayMessage` union type from `shared-types.ts` for compile-time validation.

**Tech Stack:** Playwright (Chromium, video recording), existing WS mock infrastructure (`ws-mock.ts`, `mockup-state.ts`), ffmpeg (WebM→GIF conversion), vite preview (serves built frontend on a free loopback port).

**Current verification:** `pnpm test:media` runs `test/media/media-generation.test.ts`
as an opt-in lane. It rebuilds `dist/frontend`; it is outside the integration
suite. The implementation sketches below predate dynamic preview ports. The
runner now uses `--port 0 --strictPort` and stops only its own preview process group.

---

## File Structure

All new files live under `scripts/generate-media/`:

```
scripts/generate-media/
  index.ts              # Entry point — builds frontend, starts preview, runs scenes
  scene-runner.ts       # Playwright lifecycle, video capture helpers
  scenes/
    main-ui.ts          # GENERATE-MAIN-UI.png — iPhone chat screenshot
    approval.ts         # GENERATE-APPROVAL.png — iPhone permission prompt
    dashboard.ts        # GENERATE-DASHBOARD.png — Desktop multi-project dashboard
    setup.ts            # GENERATE-SETUP.gif — iPhone wizard walkthrough
    split.ts            # GENERATE-SPLIT.gif — Side-by-side composition
  fixtures/
    media-state.ts      # WS mock messages tailored for media scenes
    composition.html    # Two-panel layout for SPLIT GIF
    dummy-site-v1.html  # Landing page — before AI changes
    dummy-site-v2.html  # Landing page — after AI adds hero section
media/                  # Output directory (created by script)
```

Reused from existing codebase (import, don't copy):
- `test/e2e/helpers/ws-mock.ts` — `mockRelayWebSocket`, `WsMockControl`
- `test/e2e/helpers/visual-helpers.ts` — `freezeAnimations`, `waitForFonts`, `waitForIcons`
- `test/e2e/helpers/viewport-presets.ts` — `VIEWPORTS`
- `test/e2e/fixtures/mockup-state.ts` — `MockMessage` type, message patterns

---

## Task 1: Script Entry Point and Scene Runner

**Files:**
- Create: `scripts/generate-media/index.ts`
- Create: `scripts/generate-media/scene-runner.ts`
- Modify: `package.json` (add `generate:media` script)

### Step 1: Create the scene runner module

`scripts/generate-media/scene-runner.ts` handles Playwright setup, preview server lifecycle, phase execution with logging, assertion checking, debug artifact collection, and capture utilities.

```typescript
// ─── Scene Runner ─────────────────────────────────────────────────────────────
// Playwright lifecycle, phase execution, assertions, debug collection,
// video capture, and screenshot helpers for media generation.

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const MEDIA_DIR = path.join(PROJECT_ROOT, "media");
const DEBUG_DIR = path.join(MEDIA_DIR, "_debug");
const PREVIEW_PORT = 4173;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SceneConfig {
  name: string;
  /** Output filename (e.g., "GENERATE-MAIN-UI.png") */
  outputFile: string;
  /** Viewport width and height */
  viewport: { width: number; height: number };
  /** Whether this is a GIF (uses video recording) */
  animated: boolean;
  /** Mobile emulation */
  isMobile?: boolean;
  hasTouch?: boolean;
  /** Device scale factor (default: 2 for retina) */
  deviceScaleFactor?: number;
}

export interface SceneContext {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  config: SceneConfig;
  previewUrl: string;
  mediaDir: string;
  projectRoot: string;
  /** Log a named phase with timing. Use for actions (navigate, click, etc.) */
  phase: (name: string, fn: () => Promise<void>) => Promise<void>;
  /** Assert a DOM condition. Fails the scene with a descriptive message if not met. */
  assert: (name: string, fn: () => Promise<void>) => Promise<void>;
  /** Intentional hold for GIF pacing — only use in animated scenes. */
  hold: (ms: number, label?: string) => Promise<void>;
}

type SceneFn = (ctx: SceneContext) => Promise<void>;

export interface SceneDefinition {
  config: SceneConfig;
  run: SceneFn;
}

// ─── Build & Preview ────────────────────────────────────────────────────────

/** Build the frontend (vite build). */
export function buildFrontend(): void {
  console.log("  Building frontend...");
  execSync("pnpm build:frontend", { cwd: PROJECT_ROOT, stdio: "pipe" });
}

/** Start vite preview and wait for it to be ready. */
export async function startPreview(): Promise<ChildProcess> {
  console.log("  Starting preview server...");
  const proc = spawn("npx", ["vite", "preview", "--port", String(PREVIEW_PORT), "--strictPort"], {
    cwd: PROJECT_ROOT,
    stdio: "pipe",
    env: { ...process.env },
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Preview server timeout")), 15_000);
    proc.stdout?.on("data", (data: Buffer) => {
      if (data.toString().includes(String(PREVIEW_PORT))) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return proc;
}

// ─── Scene Execution ────────────────────────────────────────────────────────

/** Run all scenes sequentially with phase logging and debug collection. */
export async function runScenes(scenes: SceneDefinition[]): Promise<void> {
  mkdirSync(MEDIA_DIR, { recursive: true });
  mkdirSync(DEBUG_DIR, { recursive: true });

  const browser = await chromium.launch();
  let failCount = 0;

  for (const scene of scenes) {
    console.log(`\n  Generating ${scene.config.outputFile}...`);
    const { config } = scene;

    const contextOptions: BrowserContextOptions = {
      viewport: config.viewport,
      deviceScaleFactor: config.deviceScaleFactor ?? 2,
      isMobile: config.isMobile ?? false,
      hasTouch: config.hasTouch ?? false,
      colorScheme: "dark",
      ...(config.animated && {
        recordVideo: {
          dir: path.join(MEDIA_DIR, "_video_tmp"),
          size: config.viewport,
        },
      }),
    };

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // ── Debug collection ──────────────────────────────────────────────
    const consoleLogs: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      consoleLogs.push(`[pageerror] ${err.message}`);
    });

    // ── Phase runner ──────────────────────────────────────────────────
    const phase = async (name: string, fn: () => Promise<void>): Promise<void> => {
      const start = Date.now();
      try {
        await fn();
        console.log(`    [${name}] done (${Date.now() - start}ms)`);
      } catch (err) {
        console.error(`    [${name}] FAILED after ${Date.now() - start}ms`);
        throw err;
      }
    };

    const assert = async (name: string, fn: () => Promise<void>): Promise<void> => {
      const start = Date.now();
      try {
        await fn();
        console.log(`    [assert: ${name}] passed (${Date.now() - start}ms)`);
      } catch (err) {
        const elapsed = Date.now() - start;
        console.error(`    [assert: ${name}] FAILED after ${elapsed}ms`);
        console.error(`      ${err instanceof Error ? err.message : err}`);
        throw new Error(`Assertion "${name}" failed: ${err instanceof Error ? err.message : err}`);
      }
    };

    const hold = async (ms: number, label?: string): Promise<void> => {
      if (label) console.log(`    [hold: ${label}] ${ms}ms`);
      await page.waitForTimeout(ms);
    };

    const ctx: SceneContext = {
      browser, context, page, config,
      previewUrl: PREVIEW_URL,
      mediaDir: MEDIA_DIR,
      projectRoot: PROJECT_ROOT,
      phase, assert, hold,
    };

    try {
      await scene.run(ctx);

      if (config.animated) {
        await page.close();
        const video = page.video();
        if (!video) throw new Error("No video recorded");
        const videoPath = await video.path();
        const outputPath = path.join(MEDIA_DIR, config.outputFile);
        await phase("convert-gif", () => convertToGif(videoPath, outputPath, config.viewport));
        console.log(`    ✓ ${config.outputFile}`);
      } else {
        const outputPath = path.join(MEDIA_DIR, config.outputFile);
        await page.screenshot({ path: outputPath, type: "png" });
        await page.close();
        console.log(`    ✓ ${config.outputFile}`);
      }
    } catch (err) {
      failCount++;
      console.error(`    ✗ ${config.outputFile}: ${err instanceof Error ? err.message : err}`);

      // Save debug screenshot
      try {
        const debugPath = path.join(DEBUG_DIR, `${config.name}-failure.png`);
        await page.screenshot({ path: debugPath, type: "png" });
        console.error(`    Debug screenshot: ${debugPath}`);
      } catch { /* page may already be closed */ }

      // Dump console errors
      if (consoleLogs.length > 0) {
        console.error("    Browser console:");
        for (const log of consoleLogs.slice(-20)) {
          console.error(`      ${log}`);
        }
        // Also write full log to file
        const logPath = path.join(DEBUG_DIR, `${config.name}-console.log`);
        writeFileSync(logPath, consoleLogs.join("\n"));
      }

      await page.close().catch(() => {});
    }

    await context.close();
  }

  await browser.close();

  if (failCount > 0) {
    console.error(`\n  ${failCount} scene(s) failed. Debug artifacts in: ${DEBUG_DIR}`);
    process.exitCode = 1;
  }
}

// ─── GIF Conversion ─────────────────────────────────────────────────────────

/** Convert WebM video to GIF using ffmpeg. Throws with stderr on failure. */
async function convertToGif(
  inputPath: string,
  outputPath: string,
  size: { width: number; height: number },
): Promise<void> {
  const palettePath = inputPath.replace(".webm", "-palette.png");
  const fps = 15;
  const filters = `fps=${fps},scale=${size.width}:-1:flags=lanczos`;

  try {
    execSync(
      `ffmpeg -y -i "${inputPath}" -vf "${filters},palettegen=stats_mode=diff" "${palettePath}"`,
      { stdio: "pipe" },
    );
    execSync(
      `ffmpeg -y -i "${inputPath}" -i "${palettePath}" -lavfi "${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" "${outputPath}"`,
      { stdio: "pipe" },
    );
  } catch (err: unknown) {
    // Extract stderr from ExecSyncError for diagnosability
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? "";
    throw new Error(`ffmpeg failed: ${stderr.slice(-500)}`);
  }

  // Cleanup temp files
  try { unlinkSync(palettePath); } catch {}
  try { unlinkSync(inputPath); } catch {}
}

export { PREVIEW_URL, MEDIA_DIR, DEBUG_DIR, PROJECT_ROOT };
```

### Step 2: Create the entry point

`scripts/generate-media/index.ts`:

```typescript
// ─── README Media Generator ──────────────────────────────────────────────────
// Generates all media assets referenced in README.md.
//
// Usage:
//   pnpm generate:media           # Build + generate all
//   pnpm generate:media -- main-ui  # Generate single scene
//
// Prerequisites:
//   - ffmpeg (brew install ffmpeg) — required for GIF generation

import { rmSync } from "node:fs";
import path from "node:path";
import { buildFrontend, MEDIA_DIR, runScenes, startPreview } from "./scene-runner.js";
import { approvalScene } from "./scenes/approval.js";
import { dashboardScene } from "./scenes/dashboard.js";
import { mainUiScene } from "./scenes/main-ui.js";
import { setupScene } from "./scenes/setup.js";
import { splitScene } from "./scenes/split.js";

const ALL_SCENES = [mainUiScene, approvalScene, dashboardScene, setupScene, splitScene];

async function main(): Promise<void> {
  console.log("README Media Generator\n");

  // Parse optional filter arg
  const filter = process.argv[2];
  const scenes = filter
    ? ALL_SCENES.filter((s) => s.config.name === filter)
    : ALL_SCENES;

  if (scenes.length === 0) {
    console.error(`Unknown scene: ${filter}`);
    console.error(`Available: ${ALL_SCENES.map((s) => s.config.name).join(", ")}`);
    process.exit(1);
  }

  // Clean video temp dir
  rmSync(path.join(MEDIA_DIR, "_video_tmp"), { recursive: true, force: true });

  // Build frontend
  buildFrontend();

  // Start preview server
  const previewProc = await startPreview();

  try {
    await runScenes(scenes);
  } finally {
    previewProc.kill();
    // Clean video temp dir
    rmSync(path.join(MEDIA_DIR, "_video_tmp"), { recursive: true, force: true });
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Step 3: Add npm script to package.json

Add to `package.json` scripts:

```json
"generate:media": "tsx scripts/generate-media/index.ts"
```

### Step 4: Add temp directories to `.gitignore`

Append to `.gitignore`:

```
media/_video_tmp/
media/_debug/
```

### Step 5: Verify the script scaffolding runs

Run: `pnpm generate:media -- --help` (will fail because scenes don't exist yet, but entry point should load)

Expected: Process starts, prints "README Media Generator", then errors about missing scene modules.

### Step 6: Commit

```bash
git add scripts/generate-media/index.ts scripts/generate-media/scene-runner.ts package.json .gitignore
git commit -m "feat: scaffold media generation script entry point and scene runner"
```

---

## Task 2: Media Fixtures — WS Mock Messages for Each Scene

**Files:**
- Create: `scripts/generate-media/fixtures/media-state.ts`

This file provides WS mock message sequences tailored for each scene. It uses the strict `RelayMessage` union type from `shared-types.ts` for compile-time validation of all message shapes. The `ws-mock.ts` helper accepts the loose `MockMessage` type, but our fixtures are typed strictly — TypeScript catches field typos, missing required fields, and wrong types at compile time.

### Step 1: Create the media fixtures

```typescript
// ─── Media Generation Fixtures ───────────────────────────────────────────────
// Canned WebSocket messages for README media screenshots and GIFs.
// Uses the strict RelayMessage type for compile-time validation.
// Cast to MockMessage[] at the export boundary for ws-mock.ts compatibility.

import type { PermissionId, RelayMessage } from "../../../src/lib/shared-types.js";
import type { MockMessage } from "../../../test/e2e/fixtures/mockup-state.js";

/** Type-safe message array. The ws-mock helper accepts MockMessage (supertype). */
function msgs(...messages: RelayMessage[]): MockMessage[] {
  return messages as MockMessage[];
}

// ─── Shared ──────────────────────────────────────────────────────────────────

const modelList: RelayMessage = {
  type: "model_list",
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      configured: true,
      models: [
        { id: "claude-sonnet-4", name: "claude-sonnet-4", provider: "anthropic" },
        { id: "claude-haiku-3.5", name: "claude-haiku-3.5", provider: "anthropic" },
      ],
    },
  ],
};

const agentList: RelayMessage = {
  type: "agent_list",
  agents: [{ id: "code", name: "Code", description: "General coding assistant" }],
};

// ─── Main UI Scene ───────────────────────────────────────────────────────────
// Shows a completed conversation with thinking, tool calls, and markdown response.

export const mainUiInit: MockMessage[] = msgs(
  { type: "session_switched", id: "sess-media-001" },
  { type: "status", status: "idle" },
  { type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
  { type: "client_count", count: 1 },
  {
    type: "session_list",
    roots: true,
    sessions: [
      { id: "sess-media-001", title: "Build landing page", updatedAt: Date.now(), messageCount: 4 },
      { id: "sess-media-002", title: "Fix mobile layout", updatedAt: Date.now() - 3600_000, messageCount: 6 },
      { id: "sess-media-003", title: "Add contact form", updatedAt: Date.now() - 7200_000, messageCount: 3 },
    ],
  },
  modelList,
  agentList,
);

/** Turn 1: complete conversation about building a landing page. */
export const mainUiTurn1: MockMessage[] = msgs(
  { type: "status", status: "processing" },
  { type: "thinking_start" },
  {
    type: "thinking_delta",
    text: "Let me examine the existing project structure and create a modern landing page with a hero section, features grid, and responsive layout.",
  },
  { type: "thinking_stop" },

  // Read existing file
  { type: "tool_start", id: "call_read_m1", name: "Read" },
  { type: "tool_executing", id: "call_read_m1", name: "Read", input: { file_path: "src/pages/index.html" } },
  { type: "tool_result", id: "call_read_m1", content: "<!DOCTYPE html>...", is_error: false },

  // Write new landing page
  { type: "tool_start", id: "call_write_m1", name: "Write" },
  { type: "tool_executing", id: "call_write_m1", name: "Write", input: { file_path: "src/pages/index.html" } },
  { type: "tool_result", id: "call_write_m1", content: "File written successfully", is_error: false },

  // Write styles
  { type: "tool_start", id: "call_write_m2", name: "Write" },
  { type: "tool_executing", id: "call_write_m2", name: "Write", input: { file_path: "src/styles/landing.css" } },
  { type: "tool_result", id: "call_write_m2", content: "File written successfully", is_error: false },

  // Response
  { type: "delta", text: "I've created the landing page. Here's what I built:\n\n" },
  { type: "delta", text: "- **Hero section** with gradient background and CTA button\n" },
  { type: "delta", text: "- **Features grid** — 3-column responsive layout\n" },
  { type: "delta", text: "- **Footer** with links and social icons\n\n" },
  { type: "delta", text: "The page is fully responsive and looks great on mobile.\n" },

  { type: "result", usage: { input: 1100, output: 750, cache_read: 0, cache_creation: 0 }, cost: 0.0098, duration: 3800, sessionId: "sess-media-001" },
  { type: "done", code: 0 },
  { type: "status", status: "idle" },
);

// ─── Approval Scene ──────────────────────────────────────────────────────────
// Shows a permission request card for a bash command.

export const approvalInit: MockMessage[] = msgs(
  { type: "session_switched", id: "sess-media-approval" },
  { type: "status", status: "idle" },
  { type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
  { type: "client_count", count: 1 },
  {
    type: "session_list",
    roots: true,
    sessions: [
      { id: "sess-media-approval", title: "Build landing page", updatedAt: Date.now(), messageCount: 2 },
    ],
  },
  modelList,
  agentList,
);

/** A permission request for running a bash command. Type-safe against RelayMessage. */
export const approvalPermission: MockMessage = {
  type: "permission_request",
  requestId: "perm-media-001" as PermissionId,
  sessionId: "sess-media-approval",
  toolName: "Bash",
  toolInput: { command: "npm run build && npm run deploy" },
  always: ["npm run *"],
} satisfies RelayMessage as MockMessage;

// ─── Dashboard Scene ─────────────────────────────────────────────────────────
// Shows the project dashboard with multiple projects across two instances.

export const dashboardInit: MockMessage[] = [
  { type: "session_switched", id: "sess-media-dash" },
  { type: "status", status: "idle" },
  { type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
  { type: "client_count", count: 1 },
  {
    type: "session_list",
    roots: true,
    sessions: [{ id: "sess-media-dash", title: "Test", updatedAt: Date.now(), messageCount: 0 }],
  },
  modelList,
  agentList,
];

// Dashboard is rendered from /api/projects — we mock the fetch response, not WS.
// See the dashboard scene for how this is done.

export const dashboardProjects = [
  { slug: "saas-landing", path: "~/src/saas-landing", title: "SaaS Landing Page", status: "ready", sessions: 3, clients: 1, isProcessing: false },
  { slug: "api-server", path: "~/src/api-server", title: "API Server", status: "ready", sessions: 7, clients: 0, isProcessing: true },
  { slug: "mobile-app", path: "~/src/mobile-app", title: "Mobile App", status: "ready", sessions: 2, clients: 1, isProcessing: false },
  { slug: "docs-site", path: "~/src/docs-site", title: "Documentation", status: "ready", sessions: 1, clients: 0, isProcessing: false },
];

// ─── Setup Scene ─────────────────────────────────────────────────────────────
// No WS messages needed — setup page fetches /api/setup-info via REST.
// We mock the fetch response in the scene.

// hasCert: false avoids the certificate verification step, which blocks with
// a disabled "Next" button when HTTPS verification fails in headless Chromium.
// With hasCert: false, the wizard shows: pwa → push → done (desktop flow).
export const setupInfo = {
  httpsUrl: "https://100.64.1.42:2633",
  httpUrl: "http://100.64.1.42:2633",
  hasCert: false,
  lanMode: false,
};

// ─── Split Scene ─────────────────────────────────────────────────────────────
// Shows the Conduit chat UI on the left, a dummy landing page on the right.
// The WS messages simulate a conversation about modifying the landing page.

export const splitInit: MockMessage[] = msgs(
  { type: "session_switched", id: "sess-media-split" },
  { type: "status", status: "idle" },
  { type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
  { type: "client_count", count: 1 },
  {
    type: "session_list",
    roots: true,
    sessions: [
      { id: "sess-media-split", title: "Build landing page", updatedAt: Date.now(), messageCount: 2 },
    ],
  },
  modelList,
  agentList,
);

/** Split scene: AI response about adding a hero section. Streamed with delays. */
export const splitResponse: MockMessage[] = msgs(
  { type: "status", status: "processing" },
  { type: "thinking_start" },
  {
    type: "thinking_delta",
    text: "I'll add a gradient hero section with a headline, subtitle, and call-to-action button. The gradient will use warm tones for a modern feel.",
  },
  { type: "thinking_stop" },

  // Read current page
  { type: "tool_start", id: "call_read_s1", name: "Read" },
  { type: "tool_executing", id: "call_read_s1", name: "Read", input: { file_path: "index.html" } },
  { type: "tool_result", id: "call_read_s1", content: "<!DOCTYPE html>...", is_error: false },

  // Write updated page with hero
  { type: "tool_start", id: "call_write_s1", name: "Write" },
  { type: "tool_executing", id: "call_write_s1", name: "Write", input: { file_path: "index.html" } },
  { type: "tool_result", id: "call_write_s1", content: "File written successfully", is_error: false },

  // Response
  { type: "delta", text: "Done! I've added a hero section with:\n\n" },
  { type: "delta", text: "- **Gradient background** — warm coral to violet\n" },
  { type: "delta", text: "- **Responsive layout** — stacks on mobile\n" },
  { type: "delta", text: "- **CTA button** — \"Get Started\" with hover effect\n" },

  { type: "result", usage: { input: 800, output: 420, cache_read: 0, cache_creation: 0 }, cost: 0.0067, duration: 2800, sessionId: "sess-media-split" },
  { type: "done", code: 0 },
  { type: "status", status: "idle" },
);
```

### Step 2: Commit

```bash
git add scripts/generate-media/fixtures/media-state.ts
git commit -m "feat: add WS mock fixtures for media generation scenes"
```

---

## Task 3: Static Screenshot Scenes (MAIN-UI, APPROVAL, DASHBOARD)

**Files:**
- Create: `scripts/generate-media/scenes/main-ui.ts`
- Create: `scripts/generate-media/scenes/approval.ts`
- Create: `scripts/generate-media/scenes/dashboard.ts`

### Step 1: Create the main-ui scene

Shows a completed chat conversation on an iPhone viewport. The sidebar is hidden on mobile, so we see the chat with messages, tool calls, and the input area.

```typescript
// ─── Main UI Scene ───────────────────────────────────────────────────────────
// GENERATE-MAIN-UI.png — iPhone chat with completed conversation.

import { mockRelayWebSocket } from "../../../test/e2e/helpers/ws-mock.js";
import { freezeAnimations, waitForFonts, waitForIcons } from "../../../test/e2e/helpers/visual-helpers.js";
import { mainUiInit, mainUiTurn1 } from "../fixtures/media-state.js";
import type { SceneContext } from "../scene-runner.js";

export const mainUiScene = {
  config: {
    name: "main-ui",
    outputFile: "GENERATE-MAIN-UI.png",
    viewport: { width: 393, height: 852 },
    animated: false,
    isMobile: true,
    hasTouch: true,
  },
  async run(ctx: SceneContext): Promise<void> {
    const { page, previewUrl, phase, assert } = ctx;

    await phase("setup-ws-mock", async () => {
      await mockRelayWebSocket(page, {
        initMessages: mainUiInit,
        responses: new Map([
          ["Build me a landing page with a hero section, features grid, and footer", mainUiTurn1],
        ]),
      });
    });

    await phase("navigate", async () => {
      await page.goto(`${previewUrl}/p/myapp/`, { waitUntil: "networkidle" });
      await waitForFonts(page);
      await waitForIcons(page);
    });

    await assert("chat-ready", async () => {
      await page.locator("textarea").first().waitFor({ state: "visible", timeout: 5000 });
    });

    await phase("send-message", async () => {
      const input = page.locator("textarea").first();
      await input.fill("Build me a landing page with a hero section, features grid, and footer");
      await page.keyboard.press("Enter");
    });

    await assert("response-rendered", async () => {
      // Wait for at least one tool call and the assistant response text
      await page.locator("[data-tool-id]").first().waitFor({ state: "visible", timeout: 5000 });
      // Wait for the "done" status (idle indicator after response completes)
      await page.waitForFunction(
        () => !document.querySelector("[data-status='processing']"),
        { timeout: 10_000 },
      );
    });

    await phase("freeze-animations", async () => {
      await freezeAnimations(page);
      await page.waitForTimeout(200);
    });
  },
};
```

### Step 2: Create the approval scene

Shows a permission request card on an iPhone. The card has Allow/Deny buttons.

```typescript
// ─── Approval Scene ──────────────────────────────────────────────────────────
// GENERATE-APPROVAL.png — iPhone showing a permission request card.

import { mockRelayWebSocket } from "../../../test/e2e/helpers/ws-mock.js";
import { freezeAnimations, waitForFonts, waitForIcons } from "../../../test/e2e/helpers/visual-helpers.js";
import { approvalInit, approvalPermission } from "../fixtures/media-state.js";
import type { SceneContext } from "../scene-runner.js";

export const approvalScene = {
  config: {
    name: "approval",
    outputFile: "GENERATE-APPROVAL.png",
    viewport: { width: 393, height: 852 },
    animated: false,
    isMobile: true,
    hasTouch: true,
  },
  async run(ctx: SceneContext): Promise<void> {
    const { page, previewUrl, phase, assert } = ctx;
    let wsMock: Awaited<ReturnType<typeof mockRelayWebSocket>>;

    await phase("setup-ws-mock", async () => {
      wsMock = await mockRelayWebSocket(page, {
        initMessages: approvalInit,
        responses: new Map(),
      });
    });

    await phase("navigate", async () => {
      await page.goto(`${previewUrl}/p/myapp/`, { waitUntil: "networkidle" });
      await waitForFonts(page);
      await waitForIcons(page);
    });

    await assert("chat-ready", async () => {
      await page.locator("textarea").first().waitFor({ state: "visible", timeout: 5000 });
    });

    await phase("inject-permission", async () => {
      wsMock!.sendMessage(approvalPermission);
    });

    await assert("permission-card-visible", async () => {
      const card = page.locator("[data-request-id]");
      await card.waitFor({ state: "visible", timeout: 5000 });
      // Verify it shows the expected tool name
      await page.locator("text=Bash").first().waitFor({ state: "visible", timeout: 2000 });
    });

    await phase("freeze-animations", async () => {
      await freezeAnimations(page);
      await page.waitForTimeout(200);
    });
  },
};
```

### Step 3: Create the dashboard scene

Shows the project dashboard with multiple projects. This scene needs to mock the REST API response for `/api/projects` instead of (or in addition to) WebSocket messages.

```typescript
// ─── Dashboard Scene ─────────────────────────────────────────────────────────
// GENERATE-DASHBOARD.png — Desktop project dashboard with multiple projects.

import { freezeAnimations, waitForFonts, waitForIcons } from "../../../test/e2e/helpers/visual-helpers.js";
import { dashboardProjects } from "../fixtures/media-state.js";
import type { SceneContext } from "../scene-runner.js";

export const dashboardScene = {
  config: {
    name: "dashboard",
    outputFile: "GENERATE-DASHBOARD.png",
    viewport: { width: 1440, height: 900 },
    animated: false,
    isMobile: false,
    hasTouch: false,
  },
  async run(ctx: SceneContext): Promise<void> {
    const { page, previewUrl, phase, assert } = ctx;

    await phase("setup-routes", async () => {
      await page.route("**/api/projects", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            projects: dashboardProjects,
            version: "0.1.0",
          }),
        });
      });
    });

    await phase("navigate", async () => {
      await page.goto(`${previewUrl}/`, { waitUntil: "networkidle" });
      await page.evaluate(() => localStorage.setItem("setup-done", "1"));
      await page.reload({ waitUntil: "networkidle" });
      await waitForFonts(page);
      await waitForIcons(page);
    });

    await assert("project-cards-rendered", async () => {
      // Wait for all 4 project cards to render
      const cards = page.locator("a[href*='/p/']");
      await cards.first().waitFor({ state: "visible", timeout: 5000 });
      const count = await cards.count();
      if (count < dashboardProjects.length) {
        throw new Error(`Expected ${dashboardProjects.length} project cards, found ${count}`);
      }
    });

    await phase("freeze-animations", async () => {
      await freezeAnimations(page);
      await page.waitForTimeout(200);
    });
  },
};
```

### Step 4: Test each static scene individually

Run each scene one at a time:

```bash
pnpm generate:media main-ui
pnpm generate:media approval
pnpm generate:media dashboard
```

Expected: Each generates a PNG in `media/`. Verify the images look correct by opening them.

### Step 5: Commit

```bash
git add scripts/generate-media/scenes/main-ui.ts scripts/generate-media/scenes/approval.ts scripts/generate-media/scenes/dashboard.ts
git commit -m "feat: add static screenshot scenes for main-ui, approval, and dashboard"
```

---

## Task 4: Setup Wizard GIF Scene

**Files:**
- Create: `scripts/generate-media/scenes/setup.ts`

The setup wizard fetches `/api/setup-info` on mount. We mock this REST response to simulate an iPhone on Tailscale with a certificate (so we get: cert → pwa → push → done steps). The scene walks through each step with pauses between them.

### Step 1: Create the setup scene

```typescript
// ─── Setup Scene ─────────────────────────────────────────────────────────────
// GENERATE-SETUP.gif — iPhone walking through the setup wizard.

import { waitForFonts, waitForIcons } from "../../../test/e2e/helpers/visual-helpers.js";
import { setupInfo } from "../fixtures/media-state.js";
import type { SceneContext } from "../scene-runner.js";

export const setupScene = {
  config: {
    name: "setup",
    outputFile: "GENERATE-SETUP.gif",
    viewport: { width: 393, height: 852 },
    animated: true,
    isMobile: true,
    hasTouch: true,
  },
  async run(ctx: SceneContext): Promise<void> {
    const { page, previewUrl, phase, assert, hold } = ctx;

    await phase("setup-routes", async () => {
      await page.route("**/api/setup-info", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(setupInfo),
        });
      });
    });

    await phase("navigate", async () => {
      await page.goto(`${previewUrl}/setup`, { waitUntil: "networkidle" });
      await page.evaluate(() => {
        localStorage.removeItem("setup-done");
        localStorage.removeItem("setup-pending");
      });
      await page.reload({ waitUntil: "networkidle" });
      await waitForFonts(page);
      await waitForIcons(page);
    });

    await assert("wizard-loaded", async () => {
      // Verify the wizard rendered with at least one step heading
      await page.locator("text=Conduit").first().waitFor({ state: "visible", timeout: 5000 });
    });

    await hold(2000, "first-step");

    // Click through steps with assertions between each transition
    await phase("walk-wizard", async () => {
      const maxSteps = 5;
      for (let i = 0; i < maxSteps; i++) {
        // Capture current step heading for transition detection
        const headingBefore = await page.locator("h2, h3").first().textContent().catch(() => "");

        // Priority: skip/finish > next/open (avoid "Enable" which fails headlessly)
        const skipBtn = page.locator("button").filter({ hasText: /skip|finish anyway/i }).first();
        const nextBtn = page.locator("button").filter({ hasText: /next|open conduit/i }).first();

        const skipVisible = await skipBtn.isVisible().catch(() => false);
        const nextVisible = await nextBtn.isVisible().catch(() => false);

        if (skipVisible) {
          await skipBtn.click();
        } else if (nextVisible) {
          await nextBtn.click();
        } else {
          break;
        }

        // Wait for step transition — heading text should change or "All set!" appears
        await page.waitForFunction(
          (prev) => {
            const h = document.querySelector("h2, h3");
            return h && h.textContent !== prev;
          },
          headingBefore,
          { timeout: 5000 },
        ).catch(() => {
          // Step may not change heading (e.g., last step → done)
        });

        await hold(1800, `step-${i + 1}`);
      }
    });

    await assert("wizard-complete", async () => {
      await page.locator("text=All set").waitFor({ state: "visible", timeout: 5000 });
    });

    await hold(1500, "done-screen");
  },
};
```

### Step 2: Test the setup GIF scene

Run: `pnpm generate:media setup`

Expected: Generates `media/GENERATE-SETUP.gif`. Verify:
- GIF shows the setup wizard stepping through pages
- Each step is visible for ~2 seconds
- The final "All set!" screen appears

### Step 3: Commit

```bash
git add scripts/generate-media/scenes/setup.ts
git commit -m "feat: add setup wizard GIF scene"
```

---

## Task 5: Dummy Landing Page HTML Files

**Files:**
- Create: `scripts/generate-media/fixtures/dummy-site-v1.html`
- Create: `scripts/generate-media/fixtures/dummy-site-v2.html`

These are the "before" and "after" versions of a simple SaaS landing page. The AI is shown modifying the page by adding a gradient hero section. The visual difference should be immediately obvious.

### Step 1: Create the "before" landing page (v1)

A minimal, unstyled landing page — just a nav, some text content, and a basic footer. No hero section.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Acme — Ship faster</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0a0f;
      color: #e4e4e7;
      line-height: 1.6;
    }
    nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 32px;
      border-bottom: 1px solid #27272a;
    }
    .logo { font-weight: 700; font-size: 18px; color: #fff; }
    .nav-links { display: flex; gap: 24px; list-style: none; }
    .nav-links a { color: #a1a1aa; text-decoration: none; font-size: 14px; }
    main { padding: 48px 32px; max-width: 800px; }
    h2 { font-size: 20px; color: #fff; margin-bottom: 12px; }
    .features {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      margin-top: 32px;
      padding: 0 32px 48px;
      max-width: 900px;
    }
    .feature-card {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 20px;
    }
    .feature-card h3 { font-size: 14px; color: #fff; margin-bottom: 6px; }
    .feature-card p { font-size: 13px; color: #71717a; }
    footer {
      border-top: 1px solid #27272a;
      padding: 24px 32px;
      font-size: 12px;
      color: #52525b;
    }
  </style>
</head>
<body>
  <nav>
    <span class="logo">Acme</span>
    <ul class="nav-links">
      <li><a href="#">Features</a></li>
      <li><a href="#">Pricing</a></li>
      <li><a href="#">Docs</a></li>
    </ul>
  </nav>
  <main>
    <h2>Welcome to Acme</h2>
    <p>The developer platform for shipping fast. Build, deploy, iterate.</p>
  </main>
  <div class="features">
    <div class="feature-card">
      <h3>Fast builds</h3>
      <p>Incremental compilation. Sub-second hot reload. Zero config.</p>
    </div>
    <div class="feature-card">
      <h3>Edge deploy</h3>
      <p>Deploy globally in seconds. Automatic SSL. Custom domains.</p>
    </div>
    <div class="feature-card">
      <h3>Team tools</h3>
      <p>Preview branches. Shared secrets. Role-based access.</p>
    </div>
  </div>
  <footer>&copy; 2026 Acme Inc. All rights reserved.</footer>
</body>
</html>
```

### Step 2: Create the "after" landing page (v2)

Same page but with a prominent gradient hero section added between the nav and features. The hero has a headline, subtitle, and CTA button.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Acme — Ship faster</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0a0f;
      color: #e4e4e7;
      line-height: 1.6;
    }
    nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 32px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      position: relative;
      z-index: 10;
    }
    .logo { font-weight: 700; font-size: 18px; color: #fff; }
    .nav-links { display: flex; gap: 24px; list-style: none; }
    .nav-links a { color: #a1a1aa; text-decoration: none; font-size: 14px; }
    .hero {
      text-align: center;
      padding: 80px 32px 64px;
      background: linear-gradient(135deg, #1a0533 0%, #0f172a 25%, #0a0a0f 50%, #1a0a0a 75%, #1a0533 100%);
      position: relative;
      overflow: hidden;
    }
    .hero::before {
      content: "";
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse at 50% 0%, rgba(139, 92, 246, 0.15), transparent 60%),
                  radial-gradient(ellipse at 80% 50%, rgba(244, 63, 94, 0.08), transparent 50%);
    }
    .hero * { position: relative; }
    .hero h1 {
      font-size: 40px;
      font-weight: 800;
      color: #fff;
      margin-bottom: 12px;
      letter-spacing: -0.025em;
    }
    .hero h1 span {
      background: linear-gradient(135deg, #a78bfa, #f472b6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .hero p {
      font-size: 16px;
      color: #a1a1aa;
      max-width: 480px;
      margin: 0 auto 28px;
    }
    .hero-cta {
      display: inline-flex;
      padding: 10px 28px;
      background: linear-gradient(135deg, #8b5cf6, #ec4899);
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      border-radius: 8px;
      text-decoration: none;
      border: none;
      cursor: pointer;
    }
    .features {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      margin-top: 32px;
      padding: 0 32px 48px;
      max-width: 900px;
    }
    .feature-card {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 20px;
    }
    .feature-card h3 { font-size: 14px; color: #fff; margin-bottom: 6px; }
    .feature-card p { font-size: 13px; color: #71717a; }
    footer {
      border-top: 1px solid #27272a;
      padding: 24px 32px;
      font-size: 12px;
      color: #52525b;
    }
  </style>
</head>
<body>
  <nav>
    <span class="logo">Acme</span>
    <ul class="nav-links">
      <li><a href="#">Features</a></li>
      <li><a href="#">Pricing</a></li>
      <li><a href="#">Docs</a></li>
    </ul>
  </nav>
  <section class="hero">
    <h1>Ship <span>faster</span> than ever</h1>
    <p>The developer platform that gets out of your way. Build, deploy, and iterate at the speed of thought.</p>
    <button class="hero-cta">Get Started</button>
  </section>
  <div class="features">
    <div class="feature-card">
      <h3>Fast builds</h3>
      <p>Incremental compilation. Sub-second hot reload. Zero config.</p>
    </div>
    <div class="feature-card">
      <h3>Edge deploy</h3>
      <p>Deploy globally in seconds. Automatic SSL. Custom domains.</p>
    </div>
    <div class="feature-card">
      <h3>Team tools</h3>
      <p>Preview branches. Shared secrets. Role-based access.</p>
    </div>
  </div>
  <footer>&copy; 2026 Acme Inc. All rights reserved.</footer>
</body>
</html>
```

### Step 3: Verify the visual difference

Open both HTML files in a browser. The v1→v2 difference should be immediately obvious:
- v1: nav + small text + features + footer (sparse, plain)
- v2: nav + large gradient hero with "Ship faster than ever" + CTA button + features + footer (polished)

### Step 4: Commit

```bash
git add scripts/generate-media/fixtures/dummy-site-v1.html scripts/generate-media/fixtures/dummy-site-v2.html
git commit -m "feat: add dummy landing page HTML files for SPLIT GIF"
```

---

## Task 6: Composition HTML and Split GIF Scene

**Files:**
- Create: `scripts/generate-media/fixtures/composition.html`
- Create: `scripts/generate-media/scenes/split.ts`

The composition page renders two side-by-side panels that look like browser windows. The left panel contains an iframe showing the Conduit chat UI. The right panel contains an iframe showing the dummy landing page. The scene orchestrates: load both → wait → send user message in Conduit → stream response → swap right iframe to v2 at the right moment.

### Step 1: Create the composition HTML

This is a standalone page served by the split scene. It uses inline styles, no external deps.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Media Composition</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0c0c14;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      gap: 20px;
      padding: 24px;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .panel {
      flex: 1;
      height: 100%;
      display: flex;
      flex-direction: column;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid #27272a;
      background: #18181b;
    }
    .panel-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: #1e1e24;
      border-bottom: 1px solid #27272a;
    }
    .dots {
      display: flex;
      gap: 6px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .dot-red { background: #ef4444; }
    .dot-yellow { background: #eab308; }
    .dot-green { background: #22c55e; }
    .url-bar {
      flex: 1;
      background: #0a0a0f;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 11px;
      color: #71717a;
      text-align: center;
    }
    .panel iframe {
      flex: 1;
      border: none;
      width: 100%;
    }
  </style>
</head>
<body>
  <div class="panel" id="left-panel">
    <div class="panel-bar">
      <div class="dots">
        <div class="dot dot-red"></div>
        <div class="dot dot-yellow"></div>
        <div class="dot dot-green"></div>
      </div>
      <div class="url-bar">localhost:2633/p/saas-landing</div>
    </div>
    <iframe id="conduit-frame" src="about:blank"></iframe>
  </div>
  <div class="panel" id="right-panel">
    <div class="panel-bar">
      <div class="dots">
        <div class="dot dot-red"></div>
        <div class="dot dot-yellow"></div>
        <div class="dot dot-green"></div>
      </div>
      <div class="url-bar">localhost:3000</div>
    </div>
    <iframe id="site-frame" src="about:blank"></iframe>
  </div>
</body>
</html>
```

### Step 2: Create the split scene

This is the most complex scene. It:
1. Serves the composition page, dummy site files, and the Conduit frontend
2. Loads both in iframes
3. Orchestrates the WS mock inside the Conduit iframe
4. Times the dummy site swap to coincide with the AI response

```typescript
// ─── Split Scene ─────────────────────────────────────────────────────────────
// GENERATE-SPLIT.gif — Side-by-side: Conduit chat + dummy landing page.
// Shows user asking to add a hero section, AI streaming response, and the
// landing page updating with the new hero.

import { readFileSync } from "node:fs";
import path from "node:path";
import { waitForFonts } from "../../../test/e2e/helpers/visual-helpers.js";
import { splitInit, splitResponse } from "../fixtures/media-state.js";
import type { SceneContext } from "../scene-runner.js";

export const splitScene = {
  config: {
    name: "split",
    outputFile: "GENERATE-SPLIT.gif",
    viewport: { width: 1400, height: 800 },
    animated: true,
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
  },
  async run(ctx: SceneContext): Promise<void> {
    const { page, previewUrl, projectRoot, phase, assert, hold } = ctx;
    const fixtureDir = path.join(projectRoot, "scripts/generate-media/fixtures");

    await phase("read-fixtures", async () => {
      const compositionHtml = readFileSync(path.join(fixtureDir, "composition.html"), "utf-8");
      const dummySiteV1 = readFileSync(path.join(fixtureDir, "dummy-site-v1.html"), "utf-8");
      const dummySiteV2 = readFileSync(path.join(fixtureDir, "dummy-site-v2.html"), "utf-8");

      // Serve via route interception
      await page.route("**/composition.html", (route) => {
        route.fulfill({ status: 200, contentType: "text/html", body: compositionHtml });
      });
      await page.route("**/dummy-site-v1.html", (route) => {
        route.fulfill({ status: 200, contentType: "text/html", body: dummySiteV1 });
      });
      await page.route("**/dummy-site-v2.html", (route) => {
        route.fulfill({ status: 200, contentType: "text/html", body: dummySiteV2 });
      });
    });

    await phase("setup-ws-mock", async () => {
      // Use CONTEXT (not page) so iframe WS connections are intercepted too
      await ctx.context.routeWebSocket(/\/ws/, (ws) => {
        for (const msg of splitInit) {
          ws.send(JSON.stringify(msg));
        }

        ws.onMessage((data) => {
          try {
            const parsed = typeof data === "string" ? JSON.parse(data) : null;
            if (!parsed) return;

            if (parsed.type === "message") {
              void (async () => {
                for (const msg of splitResponse) {
                  ws.send(JSON.stringify(msg));
                  await new Promise((r) => setTimeout(r, 150));
                }
              })();
            }

            // Auto-respond to frontend init-time requests
            if (parsed.type === "get_models") {
              const ml = splitInit.find((m) => m.type === "model_list");
              if (ml) ws.send(JSON.stringify(ml));
            }
            if (parsed.type === "get_agents") {
              const al = splitInit.find((m) => m.type === "agent_list");
              if (al) ws.send(JSON.stringify(al));
            }
            if (parsed.type === "load_more_history") {
              ws.send(JSON.stringify({ type: "history_page", sessionId: "", messages: [], hasMore: false }));
            }
            if (parsed.type === "list_sessions") {
              const sl = splitInit.find((m) => m.type === "session_list");
              if (sl) ws.send(JSON.stringify(sl));
            }
          } catch {}
        });
      });
    });

    await phase("navigate-composition", async () => {
      await page.goto(`${previewUrl}/composition.html`, { waitUntil: "domcontentloaded" });
    });

    await phase("load-iframes", async () => {
      await page.evaluate((url) => {
        (document.getElementById("conduit-frame") as HTMLIFrameElement).src = `${url}/p/saas-landing/`;
      }, previewUrl);
      await page.evaluate((url) => {
        (document.getElementById("site-frame") as HTMLIFrameElement).src = `${url}/dummy-site-v1.html`;
      }, previewUrl);
    });

    await assert("iframes-loaded", async () => {
      const conduitFrame = page.frameLocator("#conduit-frame");
      // Wait for the Conduit chat textarea to appear inside the iframe
      await conduitFrame.locator("textarea").first().waitFor({ state: "visible", timeout: 10_000 });
      // Wait for the dummy site content to render
      const siteFrame = page.frameLocator("#site-frame");
      await siteFrame.locator("text=Acme").waitFor({ state: "visible", timeout: 5000 });
    });

    await hold(2000, "initial-state");

    await phase("type-message", async () => {
      const conduitFrame = page.frameLocator("#conduit-frame");
      const input = conduitFrame.locator("textarea").first();
      await input.click();
      await input.pressSequentially("Add a gradient hero section with a CTA button", { delay: 30 });
    });

    await hold(500, "before-send");

    await phase("send-message", async () => {
      const conduitFrame = page.frameLocator("#conduit-frame");
      await conduitFrame.locator("textarea").first().press("Enter");
    });

    // Wait for the streamed response — the WS mock sends with 150ms delays
    await hold(3000, "response-streaming");

    await phase("swap-to-v2", async () => {
      await page.evaluate((url) => {
        (document.getElementById("site-frame") as HTMLIFrameElement).src = `${url}/dummy-site-v2.html`;
      }, previewUrl);
    });

    await assert("hero-section-visible", async () => {
      const siteFrame = page.frameLocator("#site-frame");
      await siteFrame.locator("text=Ship").waitFor({ state: "visible", timeout: 5000 });
    });

    await hold(3000, "final-result");
  },
};
```

### Step 3: Test the split GIF scene

Run: `pnpm generate:media split`

Expected: Generates `media/GENERATE-SPLIT.gif` showing:
1. Initial state: Conduit chat (left) + plain landing page (right)
2. User types "Add a gradient hero section with a CTA button"
3. AI streams response with thinking + tool calls
4. Right panel swaps to show the landing page with the new hero section
5. Holds on the final result

### Step 4: Commit

```bash
git add scripts/generate-media/fixtures/composition.html scripts/generate-media/scenes/split.ts
git commit -m "feat: add composition HTML and split scene for side-by-side GIF"
```

---

## Task 7: Polish and Integration

**Files:**
- Modify: `scripts/generate-media/scene-runner.ts` (adjust video settings)
- Modify: `.gitignore` (ensure media/ files are tracked but temp files aren't)

### Step 1: Run all scenes together

Run: `pnpm generate:media`

Verify all 5 assets are generated in `media/`:
- `GENERATE-MAIN-UI.png`
- `GENERATE-APPROVAL.png`
- `GENERATE-DASHBOARD.png`
- `GENERATE-SETUP.gif`
- `GENERATE-SPLIT.gif`

### Step 2: Verify README renders correctly

Open README.md in a markdown previewer (or push to a branch and check GitHub). All 5 images should render at their specified widths.

### Step 3: Tune visual quality

Inspect the generated assets and iterate:
- **PNGs**: Check viewport sizing, content visibility, font rendering
- **GIFs**: Check frame rate, timing, file size, color quality
- Adjust `deviceScaleFactor` (2 for retina PNGs, 1 for GIFs to keep file size reasonable)
- Adjust `waitForTimeout` values in scenes for better pacing
- Adjust ffmpeg palette/dither settings if GIF colors are banding

### Step 4: Add README prerequisite note

The script requires ffmpeg. Add a comment in `scripts/generate-media/index.ts` header and check for ffmpeg availability at startup:

```typescript
// Check for ffmpeg
try {
  execSync("which ffmpeg", { stdio: "pipe" });
} catch {
  console.error("Error: ffmpeg is required for GIF generation.");
  console.error("Install: brew install ffmpeg");
  process.exit(1);
}
```

### Step 5: Run verification

```bash
pnpm check
pnpm lint
```

Fix any type errors or lint issues in the new files.

### Step 6: Commit

```bash
git add .
git commit -m "feat: complete README media generation pipeline"
```

---

## Notes for the Implementing Agent

### Key Patterns

1. **Phase/Assert/Hold**: Every scene uses `ctx.phase()` for actions, `ctx.assert()` for DOM verification, and `ctx.hold()` for intentional GIF pacing. Never use bare `waitForTimeout` for "wait until UI is ready" — use `assert` with a DOM condition instead. Keep `hold` only for animated scenes where you need visible time on a state.

2. **Type-safe fixtures**: Fixtures use `RelayMessage` from `shared-types.ts` and the `msgs()` helper for compile-time validation. The `satisfies RelayMessage as MockMessage` pattern validates individual messages (like `approvalPermission`). TypeScript catches field typos, missing required fields, and wrong types.

3. **WS mocking**: Use `mockRelayWebSocket` from `test/e2e/helpers/ws-mock.ts` for scenes that show the chat UI. The mock intercepts `page.routeWebSocket(/\/ws/)` and sends canned messages. Set up *before* `page.goto()`.

4. **Iframe WS routing**: For the split scene, use `context.routeWebSocket()` (NOT `page.routeWebSocket()`) to intercept WS connections from iframes. The page-level API only intercepts the main frame; the context-level API intercepts all frames in the context.

5. **Debug on failure**: The scene runner automatically captures a debug screenshot, dumps browser console errors, and writes a full console log file when any phase or assertion fails. All artifacts go to `media/_debug/`.

6. **GIF conversion**: Use two-pass ffmpeg: first generate an optimized palette, then encode the GIF using that palette. ffmpeg errors include stderr output for diagnosability.

7. **REST mocking**: For dashboard and setup scenes, use `page.route()` to intercept REST API calls (`/api/projects`, `/api/setup-info`). These are standard Playwright route handlers.

### What Success Looks Like

```
README Media Generator

  Building frontend...
  Starting preview server...

  Generating GENERATE-MAIN-UI.png...
    [setup-ws-mock] done (15ms)
    [navigate] done (820ms)
    [assert: chat-ready] passed (50ms)
    [send-message] done (180ms)
    [assert: response-rendered] passed (1200ms)
    [freeze-animations] done (55ms)
    ✓ GENERATE-MAIN-UI.png
  ...
```

### What Failure Looks Like

```
  Generating GENERATE-MAIN-UI.png...
    [setup-ws-mock] done (15ms)
    [navigate] done (820ms)
    [assert: chat-ready] passed (50ms)
    [send-message] done (180ms)
    [assert: response-rendered] FAILED after 10000ms
      Assertion "response-rendered" failed: Timeout 10000ms exceeded.
    Debug screenshot: media/_debug/main-ui-failure.png
    Browser console:
      [error] WebSocket connection failed: ws://localhost:4173/p/myapp/ws
    ✗ GENERATE-MAIN-UI.png

  1 scene(s) failed. Debug artifacts in: media/_debug
```

### Potential Issues

- **tsconfig coverage**: The root `tsconfig.json` includes `["src/**/*.ts", "test/**/*.ts"]` — it does NOT include `scripts/`. This means `pnpm check` won't type-check the new scripts. This is acceptable since `tsx` does runtime type-stripping, and the scripts are not part of the build output. If you want type-checking, add `"scripts/**/*.ts"` to the include array.
- **Iframe cross-origin**: Both iframes load from the same origin (vite preview on localhost:4173), so there are no cross-origin issues.
- **Setup wizard step detection**: The wizard builds its step list dynamically based on platform detection and setup info. When running in headless Chromium, `navigator.userAgent` won't match iOS. The wizard will detect "desktop" and show desktop-appropriate steps. This is fine — the GIF still shows the wizard flow. If iOS-specific steps are needed, use `page.evaluate()` to override platform detection, or accept the desktop wizard flow.
- **Composition page routing**: The composition HTML references relative iframe URLs. These are served via `page.route()` interceptors. Make sure the routes are set up before navigating.
- **Video temp directory**: Videos are recorded to `media/_video_tmp/`. This directory is created by scene-runner and cleaned up by the entry point. Add it to `.gitignore`.
- **Debug directory**: `media/_debug/` is created on every run. Add it to `.gitignore`.

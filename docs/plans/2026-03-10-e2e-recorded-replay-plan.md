# E2E Recorded Session Replay — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace unsafe real-OpenCode E2E tests with recorded session replay, eliminating the bug where teardown deletes real production sessions.

**Architecture:** A recording script spawns an ephemeral OpenCode instance, records full WS event sequences from the relay, and saves them as fixture files. Converted E2E specs load these fixtures via the existing `ws-mock.ts` infrastructure. One minimal live smoke test remains, using safe session tracking.

**Tech Stack:** Playwright, Vitest, ws-mock.ts, OpenCode CLI (`opencode serve`), Big Pickle model

**Design doc:** `docs/plans/2026-03-10-e2e-recorded-replay-design.md`

---

### Task 1: Immediate Safety Fix — Remove Unsafe Teardown

Fix the bug NOW before any larger refactoring. The current `e2e-harness.ts` teardown deletes real sessions.

**Files:**
- Modify: `test/e2e/helpers/e2e-harness.ts:67-96`

**Step 1: Replace snapshot-based deletion with explicit tracking**

Change the harness to track only the sessions it creates, instead of "delete everything not in my snapshot":

```typescript
// BEFORE (unsafe):
const sessionsAtStartup = await stack.client.listSessions();
const preExistingIds = new Set(sessionsAtStartup.map((s) => s.id));
if (initialSessionId) preExistingIds.delete(initialSessionId);

// AFTER (safe):
const createdSessionIds: string[] = [];
if (initialSessionId) createdSessionIds.push(initialSessionId);
```

And the teardown:

```typescript
// BEFORE (unsafe):
async stop(): Promise<void> {
    try {
        const allSessions = await stack.client.listSessions();
        for (const s of allSessions) {
            if (!preExistingIds.has(s.id)) {
                await stack.client.deleteSession(s.id);
            }
        }
    } catch {}
    await stack.stop();
}

// AFTER (safe):
async stop(): Promise<void> {
    for (const id of createdSessionIds) {
        try { await stack.client.deleteSession(id); } catch {}
    }
    await stack.stop();
},
// Expose for specs that create sessions to register them:
trackSession(id: string): void {
    createdSessionIds.push(id);
}
```

**Step 2: Run existing E2E tests to verify nothing breaks**

```bash
pnpm test:e2e -- test/e2e/specs/smoke.spec.ts
```

Expected: Tests pass as before (if OpenCode is running). If not running, they skip — that's fine.

**Step 3: Commit**

```bash
git add test/e2e/helpers/e2e-harness.ts
git commit -m "fix: stop E2E teardown from deleting real sessions

Replace 'delete everything not in snapshot' with explicit tracking of
sessions created during the test run. Fixes a bug where the 100-session
API limit caused the snapshot to be incomplete, leading to deletion of
real user sessions during test teardown."
```

---

### Task 2: RecordedScenario Type and Fixture Loader

Create the recorded scenario type and a loader utility.

**Files:**
- Create: `test/e2e/fixtures/recorded/types.ts`
- Create: `test/e2e/helpers/recorded-loader.ts`

**Step 1: Define the RecordedScenario interface**

File: `test/e2e/fixtures/recorded/types.ts`

```typescript
import type { MockMessage } from "../mockup-state.js";

/** A fully recorded session scenario captured from a real OpenCode instance. */
export interface RecordedScenario {
  /** Human-readable scenario name (e.g. "chat-simple") */
  name: string;
  /** Model used during recording */
  model: string;
  /** ISO timestamp of when this was recorded */
  recordedAt: string;
  /** Messages sent on WS connect (session_switched, status, model_info, session_list, etc.) */
  initMessages: MockMessage[];
  /** Sequence of prompt → response event sequences */
  turns: RecordedTurn[];
}

export interface RecordedTurn {
  /** Exact prompt text sent by the user */
  prompt: string;
  /** Full sequence of WS messages from server in response */
  events: MockMessage[];
}
```

**Step 2: Create the loader utility**

File: `test/e2e/helpers/recorded-loader.ts`

```typescript
import { readFileSync } from "node:fs";
import path from "node:path";
import type { RecordedScenario } from "../fixtures/recorded/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures/recorded");

/** Load a recorded scenario by name (without .json extension). */
export function loadRecordedScenario(name: string): RecordedScenario {
  const filePath = path.join(FIXTURES_DIR, `${name}.json`);
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as RecordedScenario;
}

/**
 * Build a responses Map from a recorded scenario, keyed by prompt text.
 * Compatible with ws-mock.ts's WsMockOptions.responses.
 */
export function buildResponseMap(
  scenario: RecordedScenario,
): Map<string, import("../fixtures/mockup-state.js").MockMessage[]> {
  return new Map(scenario.turns.map((t) => [t.prompt, t.events]));
}
```

**Step 3: Commit**

```bash
git add test/e2e/fixtures/recorded/types.ts test/e2e/helpers/recorded-loader.ts
git commit -m "feat: add RecordedScenario type and fixture loader for replay-based E2E tests"
```

---

### Task 3: OpenCode Spawner Utility for Tests

Create a utility that spawns an ephemeral OpenCode instance with an isolated database.

**Files:**
- Create: `test/e2e/helpers/opencode-spawner.ts`
- Test: `test/unit/e2e-helpers/opencode-spawner.test.ts` (optional unit test for port/cleanup logic)

**Step 1: Create the spawner**

File: `test/e2e/helpers/opencode-spawner.ts`

```typescript
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";

/** Get a random available port. */
async function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Failed to get ephemeral port")));
      }
    });
    srv.on("error", reject);
  });
}

/** Wait for OpenCode to become healthy. */
async function waitForHealth(
  port: number,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/path`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`OpenCode did not become healthy on port ${port} within ${timeoutMs}ms`);
}

export interface SpawnedOpenCode {
  port: number;
  url: string;
  process: ChildProcess;
  tmpDir: string;
  /** Kill the process and clean up the temp directory. */
  stop(): void;
}

/**
 * Spawn an ephemeral OpenCode instance on a random port with an isolated
 * database directory. Call stop() to kill it and clean up.
 */
export async function spawnOpenCode(opts?: {
  timeoutMs?: number;
  env?: Record<string, string>;
}): Promise<SpawnedOpenCode> {
  const port = await getEphemeralPort();
  const tmpDir = mkdtempSync(path.join(tmpdir(), "opencode-e2e-"));

  const proc = spawn("opencode", ["serve", "--port", String(port)], {
    env: {
      ...process.env,
      XDG_DATA_HOME: tmpDir,
      ...opts?.env,
    },
    stdio: "pipe",
    detached: false,
  });

  // Propagate spawn errors
  const spawnError = new Promise<never>((_, reject) => {
    proc.once("error", reject);
  });

  try {
    await Promise.race([
      waitForHealth(port, opts?.timeoutMs ?? 30_000),
      spawnError,
    ]);
  } catch (err) {
    proc.kill("SIGTERM");
    rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }

  return {
    port,
    url: `http://localhost:${port}`,
    process: proc,
    tmpDir,
    stop() {
      proc.removeAllListeners();
      proc.kill("SIGTERM");
      // Give it a moment to exit gracefully, then force
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 3000);
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    },
  };
}
```

**Step 2: Commit**

```bash
git add test/e2e/helpers/opencode-spawner.ts
git commit -m "feat: add OpenCode spawner utility for isolated E2E test instances"
```

---

### Task 4: Recording Script

Create the script that records real WS sessions and saves them as fixture files.

**Files:**
- Create: `test/e2e/scripts/record-snapshots.ts`
- Modify: `package.json` (add `test:record-snapshots` script)

**Step 1: Create the recording script**

File: `test/e2e/scripts/record-snapshots.ts`

This script:
1. Spawns ephemeral OpenCode via the spawner utility
2. Creates a RelayStack pointed at it
3. Connects a WS client for each scenario
4. Sends prompts, records all server→client messages
5. Saves to `test/e2e/fixtures/recorded/<name>.json`
6. Validates OpenAPI spec against committed snapshot

The script should define the 17 prompts organized into scenarios matching the fixture file plan from the design doc. Each scenario captures init messages + per-turn events.

Key implementation notes:
- Use the relay's WS server (not OpenCode directly) to capture the exact protocol the frontend sees
- Switch to Big Pickle model via WS `switch_model` message after connecting
- For permission tests, auto-approve permissions when `ask_user` messages arrive
- For multi-turn tests, wait for `done` + `status: idle` before sending next prompt
- Record the full event sequence including `status: processing`, all deltas, tool events, `result`, `done`, `status: idle`

See the prompt catalog in the design doc for the full list.

**Step 2: Add npm script**

Add to `package.json` scripts:

```json
"test:record-snapshots": "tsx test/e2e/scripts/record-snapshots.ts"
```

**Step 3: Run the recording script to generate initial fixtures**

```bash
pnpm test:record-snapshots
```

Expected: Fixture JSON files appear in `test/e2e/fixtures/recorded/`

**Step 4: Commit the script and generated fixtures**

```bash
git add test/e2e/scripts/record-snapshots.ts test/e2e/fixtures/recorded/ package.json
git commit -m "feat: add snapshot recording script and initial recorded fixtures

Spawns ephemeral OpenCode with Big Pickle model, records full WS event
sequences for all 17 E2E test prompts, saves as JSON fixtures for
replay-based testing."
```

---

### Task 5: Playwright Config for Recorded Replay Tests

Create a new Playwright config for the recorded replay tests. These use Vite preview + WS mock (like visual/multi-instance tests), not a real relay stack.

**Files:**
- Create: `test/e2e/playwright-replay.config.ts`
- Modify: `package.json` (add `test:e2e:replay` script)

**Step 1: Create the config**

File: `test/e2e/playwright-replay.config.ts`

Follow the pattern of `playwright-question-flow.config.ts`:
- Serve built frontend via `vite preview --port 4173`
- Desktop-only viewport (1440x900) for LLM-dependent tests
- All 5 viewports for structural-only tests
- `testMatch` should include the converted spec files

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  testMatch: [
    "chat.spec.ts",
    "chat-lifecycle.spec.ts",
    "permissions.spec.ts",
    "advanced-ui.spec.ts",
    "smoke.spec.ts",
    "sessions.spec.ts",
    "sidebar-layout.spec.ts",
    "ui-features.spec.ts",
    "dashboard.spec.ts",
    "pin-page.spec.ts",
  ],
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: process.env["CI"]
    ? [["github"], ["html", { open: "never" }]]
    : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 900 }, isMobile: false },
    },
  ],
  webServer: {
    command: "npx vite preview --port 4173 --strictPort",
    cwd: "../../",
    port: 4173,
    reuseExistingServer: !process.env["CI"],
    timeout: 15_000,
  },
});
```

**Step 2: Add npm script**

```json
"test:e2e:replay": "pnpm build:frontend && npx playwright test --config test/e2e/playwright-replay.config.ts"
```

**Step 3: Commit**

```bash
git add test/e2e/playwright-replay.config.ts package.json
git commit -m "feat: add Playwright config for recorded replay E2E tests"
```

---

### Task 6: Convert Structural-Only Specs to WS Mock

Convert the 6 specs that need no LLM responses. These are the lowest-risk conversions.

**⚠️ Addresses audit issues:** #1 (isNarrow), #2 (HTTP endpoints), #3 (new_session), #5 (project_list), #7 (mobile viewports), #8 (redirect), #9 (get_commands)

**Files:**
- Modify: `test/e2e/specs/smoke.spec.ts`
- Modify: `test/e2e/specs/sessions.spec.ts`
- Modify: `test/e2e/specs/sidebar-layout.spec.ts`
- Modify: `test/e2e/specs/ui-features.spec.ts`
- Modify: `test/e2e/specs/dashboard.spec.ts`
- Modify: `test/e2e/specs/pin-page.spec.ts`

For each spec:

**Step 1: Replace `test-fixtures.ts` import with Playwright's base `test`**

Change:
```typescript
import { test, expect } from "../helpers/test-fixtures.js";
```
To:
```typescript
import { test, expect } from "@playwright/test";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";
import { initMessages } from "../fixtures/mockup-state.js";
```

**Step 2: Replace `isNarrow` fixture with inline computation**

Specs that use `isNarrow` (sessions, sidebar-layout) need:
```typescript
// BEFORE (from test-fixtures.ts fixture):
test("my test", async ({ page, baseUrl, isNarrow }) => {

// AFTER (inline):
test("my test", async ({ page, baseURL }) => {
  const isNarrow = (page.viewportSize()?.width ?? 1440) < 769;
```

**Step 3: Add WS mock setup before each test**

Navigate to a project-slug URL (like question-flow.spec.ts does) to set SPA routing context:

```typescript
const PROJECT_URL = "/p/test-project/";

test.beforeEach(async ({ page }) => {
  await mockRelayWebSocket(page, {
    initMessages,
    responses: new Map(),
  });
});

// In each test:
await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
```

**Step 4: Handle `new_session` in sessions.spec.ts**

The "create new session" test clicks a sidebar button which sends `{ type: "new_session" }`. Add `onClientMessage` handler:

```typescript
await mockRelayWebSocket(page, {
  initMessages,
  responses: new Map(),
  onClientMessage: (msg, control) => {
    if (msg.type === "new_session") {
      control.sendMessage({
        type: "session_switched",
        id: "sess-new-001",
      });
      control.sendMessage({
        type: "session_list",
        sessions: [
          // Original sessions + the new one
          { id: "sess-new-001", title: "New Session", updatedAt: Date.now(), messageCount: 0 },
          ...initMessages.find(m => m.type === "session_list")?.sessions ?? [],
        ],
      });
    }
  },
});
```

**Step 5: Handle dashboard.spec.ts and pin-page.spec.ts HTTP tests**

These specs test HTTP endpoints (`/health`, `/setup`, `/auth`) via `fetch()` in the Node test process — `page.route()` can't intercept these. Two options:

**Option A (recommended):** Keep these tests in the live smoke suite (`playwright-live.config.ts`). They test server behavior, not frontend behavior, so they belong with the real-server tests.

**Option B:** Refactor the tests to use `page.evaluate(() => fetch(...))` so they run in the browser context where `page.route()` can intercept. This is more work and less natural.

Move these test files' HTTP-endpoint tests to `live-smoke.spec.ts` or a separate `live-endpoints.spec.ts`. Keep any DOM-only tests from dashboard/pin-page in the replay suite.

**Step 6: Run converted specs**

```bash
pnpm test:e2e:replay -- test/e2e/specs/smoke.spec.ts
pnpm test:e2e:replay -- test/e2e/specs/sessions.spec.ts
pnpm test:e2e:replay -- test/e2e/specs/sidebar-layout.spec.ts
pnpm test:e2e:replay -- test/e2e/specs/ui-features.spec.ts
```

Expected: All tests pass with mocked WS.

**Step 7: Commit each converted spec**

```bash
git add test/e2e/specs/smoke.spec.ts
git commit -m "refactor: convert smoke E2E spec to WS mock (no real OpenCode needed)"
```

Repeat for each spec.

---

### Task 7: Convert LLM-Dependent Specs to Recorded Replay

Convert the 4 specs that send real prompts to use recorded fixture replay.

**Files:**
- Modify: `test/e2e/specs/chat.spec.ts`
- Modify: `test/e2e/specs/chat-lifecycle.spec.ts`
- Modify: `test/e2e/specs/permissions.spec.ts`
- Modify: `test/e2e/specs/advanced-ui.spec.ts`

For each spec:

**Step 1: Replace test-fixtures import with recorded loader**

```typescript
import { test, expect } from "@playwright/test";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";
import { loadRecordedScenario, buildResponseMap } from "../helpers/recorded-loader.js";
```

**Step 2: Load recorded scenario and set up WS mock**

```typescript
const scenario = loadRecordedScenario("chat-simple");

test.beforeEach(async ({ page }) => {
  await mockRelayWebSocket(page, {
    initMessages: scenario.initMessages,
    responses: buildResponseMap(scenario),
  });
});
```

**Step 3: Keep test assertions unchanged**

The test code that calls `app.sendMessage()`, `chat.waitForAssistantMessage()`, etc. stays the same — the only change is WHERE the responses come from.

**Step 4: Handle permission tests (audit issue #4)**

Permission specs need **split response sequences**. The `ws-mock.ts` sends all response events at once, but permission flows need to pause at the `ask_user`/`permission_request` boundary, wait for the user to click Allow/Deny, then send the rest.

**Fix:** Split the recorded fixture's events into pre-approval and post-approval arrays. Use `onClientMessage` to detect the frontend's response:

```typescript
const scenario = loadRecordedScenario("permissions-read");
const turn = scenario.turns[0];
// Split at the ask_user event
const askIdx = turn.events.findIndex(e => e.type === "ask_user");
const preApproval = turn.events.slice(0, askIdx + 1);
const postApproval = turn.events.slice(askIdx + 1);

await mockRelayWebSocket(page, {
  initMessages: scenario.initMessages,
  responses: new Map([[turn.prompt, preApproval]]),
  onClientMessage: (msg, control) => {
    if (msg.type === "ask_user_response" || msg.type === "permission_response") {
      void control.sendMessages(postApproval);
    }
  },
});
```

The recorded fixture should also mark the split point (e.g., add a `"_splitPoint": true` field to the `ask_user` event) so the loader can auto-split.

**Step 5: Handle multi-turn tests**

The `chat-multi-turn.json` fixture has 2 turns. The mock's `responses` map handles this — each prompt maps to its own response sequence. The test sends prompts sequentially and the mock replays the correct response for each.

**Step 6: Run each converted spec**

```bash
pnpm test:e2e:replay -- test/e2e/specs/chat.spec.ts
pnpm test:e2e:replay -- test/e2e/specs/chat-lifecycle.spec.ts
pnpm test:e2e:replay -- test/e2e/specs/permissions.spec.ts
pnpm test:e2e:replay -- test/e2e/specs/advanced-ui.spec.ts
```

Expected: All tests pass with recorded replay data.

**Step 7: Commit each converted spec**

```bash
git commit -m "refactor: convert chat E2E spec to recorded replay (no real OpenCode needed)"
```

---

### Task 8: Live Smoke Test with Ephemeral OpenCode

Create one minimal live E2E test that validates the full pipeline using a self-spawned OpenCode instance.

**Files:**
- Create: `test/e2e/specs/live-smoke.spec.ts`
- Create: `test/e2e/playwright-live.config.ts`
- Modify: `package.json` (add `test:e2e:live` script)

**Step 1: Create the live smoke spec**

File: `test/e2e/specs/live-smoke.spec.ts`

```typescript
import { test, expect } from "@playwright/test";
import path from "node:path";
import { spawnOpenCode } from "../helpers/opencode-spawner.js";
import { createRelayStack, type RelayStack } from "../../../src/lib/relay/relay-stack.js";

let oc: Awaited<ReturnType<typeof spawnOpenCode>>;
let stack: RelayStack;
let relayBaseUrl: string;

test.beforeAll(async () => {
  oc = await spawnOpenCode();
  const staticDir = path.resolve(import.meta.dirname, "../../../dist/frontend");
  stack = await createRelayStack({
    port: 0,
    host: "127.0.0.1",
    opencodeUrl: oc.url,
    projectDir: process.cwd(),
    slug: "live-test",
    sessionTitle: "Live Smoke Test",
    staticDir,
    log: () => {},
  });
  relayBaseUrl = `http://127.0.0.1:${stack.getPort()}`;

  // Switch to Big Pickle (free zen model)
  // Implementation depends on how model switching works via the relay
});

test.afterAll(async () => {
  await stack?.stop();
  oc?.stop();  // Kills process + removes temp dir — no session cleanup needed
});

test("send message and receive response from real OpenCode", async ({ page }) => {
  await page.goto(relayBaseUrl);
  // Wait for connection
  await expect(page.locator("#connect-overlay")).toBeHidden({ timeout: 15_000 });
  // Send a simple prompt
  await page.locator("#input").fill("Reply with just the word pong");
  await page.locator("#send").click();
  // Wait for assistant response
  const assistant = page.locator(".msg-assistant .md-content:not(:empty)");
  await expect(assistant.first()).toBeVisible({ timeout: 60_000 });
  const text = await assistant.first().textContent();
  expect(text?.toLowerCase()).toContain("pong");
});
```

**Step 2: Create Playwright config for live tests**

File: `test/e2e/playwright-live.config.ts`

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  testMatch: "live-smoke.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,  // Live tests need more time
  expect: { timeout: 60_000 },
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 900 }, isMobile: false },
    },
  ],
});
```

**Step 3: Add npm script**

```json
"test:e2e:live": "pnpm build:frontend && npx playwright test --config test/e2e/playwright-live.config.ts"
```

**Step 4: Run**

```bash
pnpm test:e2e:live
```

Expected: Spawns OpenCode, sends one prompt, verifies response, cleans up.

**Step 5: Commit**

```bash
git add test/e2e/specs/live-smoke.spec.ts test/e2e/playwright-live.config.ts package.json
git commit -m "feat: add live smoke test with self-spawned ephemeral OpenCode instance"
```

---

### Task 9: Retire Old Infrastructure

Remove the old harness and update the primary `test:e2e` script to use replay by default.

**Files:**
- Modify: `package.json` (update `test:e2e` to use `playwright-replay.config.ts`)
- Modify: `test/e2e/playwright.config.ts` (archive or delete)
- Modify: `test/e2e/helpers/test-fixtures.ts` (archive or delete)
- Modify: `test/e2e/helpers/e2e-harness.ts` (archive or delete — keep only if live-smoke needs it)
- Modify: `docs/agent-guide/testing.md` (update guidance)

**Step 1: Update `test:e2e` to use replay config**

```json
"test:e2e": "pnpm build:frontend && npx playwright test --config test/e2e/playwright-replay.config.ts"
```

Keep the old config available as `test:e2e:legacy` during transition if needed.

**Step 2: Update testing docs**

Add to `docs/agent-guide/testing.md`:

```markdown
### Recorded Replay E2E

Default E2E tests use recorded session replay — no real OpenCode needed.
Fixtures are in `test/e2e/fixtures/recorded/`. To update them:

\`\`\`bash
pnpm test:record-snapshots
\`\`\`

### Live E2E (spawns ephemeral OpenCode)

For full pipeline validation with a real OpenCode instance:

\`\`\`bash
pnpm test:e2e:live
\`\`\`
```

**Step 3: Remove old files if no longer referenced**

```bash
git rm test/e2e/helpers/test-fixtures.ts  # Only if nothing imports it
git rm test/e2e/helpers/e2e-harness.ts    # Only if live-smoke uses opencode-spawner instead
```

**Step 4: Commit**

```bash
git commit -m "refactor: retire old E2E harness, make replay the default test:e2e target

Old harness deleted sessions from live OpenCode. New default uses
recorded replay fixtures (no OpenCode dependency). Live tests available
via test:e2e:live with ephemeral instance."
```

---

### Task 10: Validation — Full Test Suite

Run the complete verification to confirm everything works.

**Step 1: Default verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 2: Replay E2E tests**

```bash
pnpm test:e2e
```

Expected: All converted specs pass with recorded replay.

**Step 3: Live smoke test**

```bash
pnpm test:e2e:live
```

Expected: Spawns ephemeral OpenCode, passes, cleans up.

**Step 4: Existing mock-based tests still work**

```bash
pnpm test:visual
pnpm test:multi-instance
```

Expected: Unchanged, still pass.

---

---

## Audit Findings — Issues to Address During Implementation

These issues were found by auditing the plan against the actual codebase. Each is annotated with the task it affects.

### Critical Issues

1. **`isNarrow` fixture unavailable** (Task 6): `sessions.spec.ts` and `sidebar-layout.spec.ts` destructure `isNarrow` from the `test-fixtures.ts` fixture. After switching to `@playwright/test`, this fixture doesn't exist. **Fix:** Add an inline `isNarrow` computed from `page.viewportSize()`, matching the pattern in `AppPage.isMobileViewport()`. Example:
   ```typescript
   const isNarrow = (page.viewportSize()?.width ?? 1440) < 769;
   ```

2. **HTTP endpoint tests can't use `page.route()`** (Task 6): `dashboard.spec.ts` tests `/health` and `/setup` using `fetch()` from the Node test process, not from the browser. `page.route()` only intercepts browser-originated requests. **Fix:** Either (a) keep these 2-3 HTTP tests in a separate "live" suite that uses the relay harness or the live smoke config, or (b) refactor the tests to use `page.evaluate(() => fetch(...))` so `page.route()` can intercept.

3. **WS mock needs `new_session` handling** (Task 6): `sessions.spec.ts` clicks the "New Session" button, which sends `{ type: "new_session" }` via WS. The mock needs to respond with `session_switched` + updated `session_list`. **Fix:** Add `onClientMessage` handler for `new_session` in the mock setup:
   ```typescript
   onClientMessage: (msg, control) => {
     if (msg.type === "new_session") {
       control.sendMessage({ type: "session_switched", id: "sess-new-001" });
       control.sendMessage({ type: "session_list", sessions: [...updatedList] });
     }
   }
   ```

4. **Permission replay needs pause/resume** (Task 7): For permission tests, the response sequence includes `ask_user` events. The frontend must interact (click Allow), then the rest of the events should follow. The current `ws-mock.ts` sends all response events at once. **Fix:** Use `onClientMessage` callback to detect `ask_user_response` and send the post-approval events:
   ```typescript
   onClientMessage: (msg, control) => {
     if (msg.type === "ask_user_response") {
       control.sendMessages(postApprovalEvents);
     }
   }
   ```
   And split the recorded fixture's events into pre-approval and post-approval arrays.

5. **`initMessages` needs `project_list`** (Task 6): The SPA expects a `project_list` WS message to render correctly. The standard `initMessages` from `mockup-state.ts` doesn't include it, but the mock-based specs that work (visual-mockup, question-flow) navigate to `/p/myapp/` which sets the project context via URL. **Fix:** Either navigate to a project-slug URL (like question-flow does) or add a `project_list` message to the recorded scenario's `initMessages`.

6. **Big Pickle model name** (Task 4, 8): "Big Pickle" is not referenced anywhere in the codebase. **Fix:** The implementing engineer needs to verify the exact model ID and provider ID for Big Pickle when recording. The recording script should accept `E2E_MODEL` and `E2E_PROVIDER` env vars (already supported by `switchToFreeModel()` in the old harness) with Big Pickle as the default.

### Warnings

7. **No mobile viewports in replay config** (Task 5): The plan's `playwright-replay.config.ts` only defines desktop viewport. Mobile tests in `sidebar-layout.spec.ts` and `sessions.spec.ts` will be skipped. **Mitigation:** Add mobile viewports to the config if mobile coverage is desired; otherwise, document this as intentional.

8. **Dashboard redirect test** (Task 6): `dashboard.spec.ts` tests URL redirect from `/` to `/p/e2e-test/`. With Vite preview, no server-side redirect occurs. **Fix:** Keep this specific test in the live suite, or skip it in replay mode.

9. **`get_commands` / slash commands** (Task 6): `ui-features.spec.ts` types `/` and checks the command menu. The mock doesn't serve command data. **Fix:** Add `get_commands` handling to the `onClientMessage` callback if this test is being converted, or note that the command menu test may show an empty menu.

10. **Ephemeral port race** (Task 3): The spawner allocates a port, releases it, then passes it to `opencode serve`. Another process could grab it between release and bind. **Mitigation:** This is rare; retry logic in the recording script handles it. Alternatively, check if `opencode serve --port 0` supports auto-assignment.

---

## Task Dependency Order

```
Task 1 (safety fix) — URGENT, do first
  ↓
Task 2 (types + loader)
  ↓
Task 3 (spawner utility)
  ↓
Task 4 (recording script) — depends on 2 + 3
  ↓
Task 5 (replay Playwright config) — depends on 2
  ↓
Task 6 (convert structural specs) — depends on 5, addresses audit issues 1-3, 5, 7-9
  ↓
Task 7 (convert LLM specs) — depends on 4 + 5, addresses audit issue 4
  ↓
Task 8 (live smoke test) — depends on 3, addresses audit issue 6
  ↓
Task 9 (retire old infra) — depends on 6 + 7 + 8
  ↓
Task 10 (full validation)
```

Tasks 2 and 3 can run in parallel. Tasks 6 and 8 can run in parallel after their dependencies.

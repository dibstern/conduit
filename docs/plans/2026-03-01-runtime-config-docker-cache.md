# Runtime Config, Docker Fix, and Cache Relocation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the broken Dockerfile entrypoint, centralize all env var reads into a single module, and move the per-project MessageCache to `~/.opencode-relay/cache/<slug>/`.

**Architecture:** Create `src/lib/env.ts` as the single source of truth for all environment variables. Update the Dockerfile to use the real CLI entry point. Change `MessageCache` directory resolution from `<projectDir>/.opencode-relay/sessions/` to `<configDir>/cache/<slug>/sessions/`.

**Tech Stack:** Node.js, TypeScript, Docker, Vitest

**Context from investigation:**
- `skeleton.ts` was intentionally deleted; Dockerfile still references it
- 12 env vars read across 5 files; `OPENCODE_RELAY_*` vars are parent→child IPC
- `DEFAULT_CONFIG_DIR` is duplicated in 6 places
- MessageCache currently writes to `<projectDir>/.opencode-relay/sessions/`
- OpenCode already scopes sessions by project via `x-opencode-directory` header (no relay-side mapping needed)
- Session leak across projects is a separate bug (not addressed here)

---

## Task 1: Create `src/lib/env.ts` — centralized environment config

**Files:**
- Create: `src/lib/env.ts`
- Test: `test/unit/env.test.ts`

**Step 1: Write the tests**

```typescript
// test/unit/env.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("env module", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.resetModules();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("exports DEFAULT_CONFIG_DIR from homedir", async () => {
		const { DEFAULT_CONFIG_DIR } = await import("../../src/lib/env.js");
		expect(DEFAULT_CONFIG_DIR).toMatch(/\.opencode-relay$/);
	});

	it("respects XDG_CONFIG_HOME when set", async () => {
		process.env.XDG_CONFIG_HOME = "/tmp/xdg-test";
		const { DEFAULT_CONFIG_DIR } = await import("../../src/lib/env.js");
		expect(DEFAULT_CONFIG_DIR).toBe("/tmp/xdg-test/opencode-relay");
	});

	it("DEFAULT_PORT is 2633", async () => {
		const { DEFAULT_PORT } = await import("../../src/lib/env.js");
		expect(DEFAULT_PORT).toBe(2633);
	});

	it("DEFAULT_OC_PORT is 4096", async () => {
		const { DEFAULT_OC_PORT } = await import("../../src/lib/env.js");
		expect(DEFAULT_OC_PORT).toBe(4096);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/env.test.ts`
Expected: FAIL (module not found)

**Step 3: Write the implementation**

```typescript
// src/lib/env.ts
// ─── Centralized Environment Configuration ──────────────────────────────────
// Single source of truth for all environment variables read by the relay.
// Import from here instead of reading process.env directly.

import { homedir } from "node:os";
import { join } from "node:path";

// ─── Helpers ────────────────────────────────────────────────────────────────

function toInt(val: string | undefined, fallback: number): number {
	if (val === undefined) return fallback;
	const n = Number.parseInt(val, 10);
	return Number.isNaN(n) ? fallback : n;
}

// ─── Config Directory ───────────────────────────────────────────────────────

/** Base config directory. Respects XDG_CONFIG_HOME if set. */
export const DEFAULT_CONFIG_DIR: string = process.env.XDG_CONFIG_HOME
	? join(process.env.XDG_CONFIG_HOME, "opencode-relay")
	: join(homedir(), ".opencode-relay");

// ─── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_PORT = 2633;
export const DEFAULT_OC_PORT = 4096;

// ─── Daemon IPC Environment Variables ───────────────────────────────────────
// These are set by the parent process (via daemon-spawn.ts) and read by the
// child daemon process (via cli-core.ts). They are an internal IPC mechanism,
// not user-facing configuration.

export const RELAY_ENV_KEYS = {
	PORT: "OPENCODE_RELAY_PORT",
	HOST: "OPENCODE_RELAY_HOST",
	CONFIG_DIR: "OPENCODE_RELAY_CONFIG_DIR",
	PIN_HASH: "OPENCODE_RELAY_PIN_HASH",
	KEEP_AWAKE: "OPENCODE_RELAY_KEEP_AWAKE",
	TLS: "OPENCODE_RELAY_TLS",
	OC_URL: "OPENCODE_RELAY_OC_URL",
} as const;

// ─── User-Facing Environment Variables ──────────────────────────────────────
// Read at process startup. Override via CLI flags or docker-compose environment.

export const ENV = {
	/** Bind address (default: 127.0.0.1). Set to 0.0.0.0 for all interfaces. */
	host: process.env.HOST ?? "127.0.0.1",
	/** OpenCode server URL */
	opencodeUrl: process.env.OPENCODE_URL,
	/** OpenCode server HTTP Basic Auth password */
	opencodePassword: process.env.OPENCODE_SERVER_PASSWORD,
	/** OpenCode server HTTP Basic Auth username (default: "opencode") */
	opencodeUsername: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
	/** Enable debug logging */
	debug: process.env.DEBUG === "1",
} as const;
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/env.test.ts`
Expected: PASS

**Step 5: Commit**

```
git add src/lib/env.ts test/unit/env.test.ts
git commit -m "feat: add centralized env config module"
```

---

## Task 2: Replace scattered `DEFAULT_CONFIG_DIR` definitions with import from `env.ts`

**Files:**
- Modify: `src/bin/cli-utils.ts:15` — remove `DEFAULT_CONFIG_DIR`, import from env
- Modify: `src/lib/daemon.ts:51` — remove `DEFAULT_CONFIG_DIR`, import from env
- Modify: `src/lib/daemon-spawn.ts:15` — remove `DEFAULT_CONFIG_DIR`, import from env
- Modify: `src/lib/config-persistence.ts:49` — remove `DEFAULT_CONFIG_DIR`, import from env
- Modify: `src/lib/tls.ts:41-43` — remove `defaultConfigDir()`, import from env
- Modify: `src/lib/push.ts:72` — use `DEFAULT_CONFIG_DIR` from env

**Step 1: Replace each definition**

In each file, replace the local `DEFAULT_CONFIG_DIR` constant (or `defaultConfigDir()` function) with:
```typescript
import { DEFAULT_CONFIG_DIR } from "./env.js";  // or "../lib/env.js" for bin/
```

Remove the now-unused `homedir` and `join` imports if they were only used for the config dir.

For `tls.ts`, the `defaultConfigDir()` function should be replaced with a direct import — callers already use the same pattern.

For `push.ts` line 72, change:
```typescript
// Before:
this.configDir = options?.configDir ?? join(homedir(), ".opencode-relay");
// After:
this.configDir = options?.configDir ?? DEFAULT_CONFIG_DIR;
```

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: All 1925+ tests pass (no behavior change, just import consolidation)

**Step 3: Commit**

```
git add -u
git commit -m "refactor: consolidate DEFAULT_CONFIG_DIR into env.ts"
```

---

## Task 3: Replace scattered `process.env` reads with imports from `env.ts`

**Files:**
- Modify: `src/bin/cli-utils.ts:54` — use `ENV.host` instead of `process.env.HOST`
- Modify: `src/lib/server.ts:63` — use `ENV.host` instead of `process.env.HOST`
- Modify: `src/lib/opencode-client.ts:166-170` — use `ENV.opencodePassword`, `ENV.opencodeUsername`
- Modify: `src/lib/opencode-client.ts:281` — use `ENV.debug` instead of `process.env.DEBUG`
- Modify: `src/bin/cli-core.ts:96-112` — use `RELAY_ENV_KEYS` constants for env var names
- Modify: `src/lib/daemon-spawn.ts:28-36,76-84` — use `RELAY_ENV_KEYS` constants for env var names

**Step 1: Update cli-utils.ts**

```typescript
// Before (line 54):
host: process.env.HOST ?? "127.0.0.1",
// After:
host: ENV.host,
```

Add import: `import { ENV, DEFAULT_PORT, DEFAULT_OC_PORT } from "../lib/env.js";`

Also replace the local `DEFAULT_PORT` and `DEFAULT_OC_PORT` constants if they exist.

**Step 2: Update server.ts**

```typescript
// Before (line 63):
this.host = options.host ?? process.env.HOST ?? "127.0.0.1";
// After:
this.host = options.host ?? ENV.host;
```

Add import: `import { ENV } from "./env.js";`

**Step 3: Update opencode-client.ts**

```typescript
// Before (lines 165-170):
const password = options.auth?.password ?? process.env.OPENCODE_SERVER_PASSWORD;
const username = options.auth?.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
// After:
const password = options.auth?.password ?? ENV.opencodePassword;
const username = options.auth?.username ?? ENV.opencodeUsername;
```

For the debug check (~line 281), replace `process.env.DEBUG` with `ENV.debug`.

Add import: `import { ENV } from "./env.js";`

**Step 4: Update cli-core.ts daemon env reads**

```typescript
// Before (lines 96-112):
const daemonPort = Number.parseInt(process.env.OPENCODE_RELAY_PORT ?? ..., 10);
const daemonHost = process.env.OPENCODE_RELAY_HOST || "127.0.0.1";
// After:
const daemonPort = Number.parseInt(process.env[RELAY_ENV_KEYS.PORT] ?? ..., 10);
const daemonHost = process.env[RELAY_ENV_KEYS.HOST] || "127.0.0.1";
```

Add import: `import { RELAY_ENV_KEYS, DEFAULT_PORT, DEFAULT_CONFIG_DIR } from "../lib/env.js";`

**Step 5: Update daemon-spawn.ts env writes**

```typescript
// Before (lines 28-36):
OPENCODE_RELAY_PORT: String(port),
OPENCODE_RELAY_CONFIG_DIR: configDir,
// After:
[RELAY_ENV_KEYS.PORT]: String(port),
[RELAY_ENV_KEYS.CONFIG_DIR]: configDir,
```

And similarly for the conditional env vars. Do this in BOTH `buildSpawnConfig()` and `spawnDaemon()`.

Add import: `import { RELAY_ENV_KEYS, DEFAULT_PORT, DEFAULT_CONFIG_DIR } from "./env.js";`

**Step 6: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 7: Commit**

```
git add -u
git commit -m "refactor: replace scattered process.env reads with env.ts imports"
```

---

## Task 4: Fix Dockerfile entrypoint

**Files:**
- Modify: `Dockerfile`

**Step 1: Update the Dockerfile**

Three changes:

1. Replace the stale frontend COPY (lines 37-39):
```dockerfile
# Before:
# Frontend must be at dist/src/lib/public/ because skeleton.js resolves
# staticDir as new URL("./lib/public", import.meta.url) → dist/src/lib/public/
COPY --from=frontend /app/dist/public/ dist/src/lib/public/

# After:
# Frontend assets — daemon resolves staticDir as join(cwd, "dist", "public")
COPY --from=frontend /app/dist/public/ dist/public/
```

2. Replace the entrypoint (line 48):
```dockerfile
# Before:
ENTRYPOINT ["node", "dist/src/skeleton.js"]

# After:
ENTRYPOINT ["node", "dist/src/bin/cli.js", "--foreground"]
```

**Step 2: Verify the build compiles**

Run: `docker build --target build -t relay-build-test . 2>&1 | tail -5`
Expected: Build succeeds (validates TypeScript compilation and frontend build stages)

Note: Full `docker build` may fail if Docker daemon isn't running. The CI/CD pipeline will catch full container issues. The key validation is that the paths are correct.

**Step 3: Commit**

```
git add Dockerfile
git commit -m "fix: update Dockerfile entrypoint from deleted skeleton.js to cli.js"
```

---

## Task 5: Relocate MessageCache to `~/.opencode-relay/cache/<slug>/`

**Files:**
- Modify: `src/lib/relay-stack.ts:122-129` — change cache dir resolution
- Modify: `src/lib/relay-stack.ts:595-606` — change cache dir in addProjectRelay
- Modify: `src/lib/relay-stack.ts:627-638` — change cache dir in initial relay
- Modify: `src/lib/daemon.ts:427-434` — pass configDir to createProjectRelay
- Modify: `src/lib/types.ts` — add `configDir` to `ProjectRelayConfig`

**Step 1: Add `configDir` to `ProjectRelayConfig`**

In `src/lib/types.ts`, find `ProjectRelayConfig` and add:
```typescript
/** Config directory for cache storage (default: ~/.opencode-relay) */
configDir?: string;
```

**Step 2: Update `createProjectRelay` cache dir resolution**

In `src/lib/relay-stack.ts`, change lines 122-129:

```typescript
// Before:
const cacheDir = join(
    config.projectDir ?? process.cwd(),
    ".opencode-relay",
    "sessions",
);

// After:
import { DEFAULT_CONFIG_DIR } from "./env.js";

const configDir = config.configDir ?? DEFAULT_CONFIG_DIR;
const cacheDir = join(configDir, "cache", config.slug, "sessions");
```

**Step 3: Pass configDir from daemon**

In `src/lib/daemon.ts` line 427, add `configDir: this.configDir` to the `createProjectRelay` call:

```typescript
const relay = await createProjectRelay({
    httpServer: this.httpServer,
    opencodeUrl: this.opencodeUrl,
    projectDir: directory,
    slug: resolvedSlug,
    noServer: true,
    configDir: this.configDir,   // <-- ADD
    sessionTitle: "Relay Session",
    ...
});
```

**Step 4: Update `createRelayStack` cache dirs too**

In `src/lib/relay-stack.ts`, the `addProjectRelay()` function (~line 595) and the initial relay (~line 627) both call `createProjectRelay`. They should pass `configDir` if available from `RelayStackConfig`. Add `configDir?: string` to `RelayStackConfig` and thread it through.

**Step 5: Run full test suite**

Run: `pnpm test`
Expected: All tests pass. MessageCache tests use injected directories so should be unaffected.

**Step 6: Commit**

```
git add -u
git commit -m "feat: relocate MessageCache to ~/.opencode-relay/cache/<slug>/"
```

---

## Task 6: Final verification

**Step 1: Run full build**

Run: `pnpm run build`
Expected: TypeScript compilation + Vite build succeed with exit 0

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 3: Verify env.ts is the single source of truth**

Run: `grep -rn "process\.env\." src/ --include="*.ts" | grep -v node_modules | grep -v "\.d\.ts"`

Expected: The only remaining `process.env` reads should be:
- `src/lib/env.ts` (the centralized module itself)
- `src/lib/daemon-spawn.ts` (writes env vars to child process, but uses `RELAY_ENV_KEYS` constants)
- `src/bin/cli-core.ts` (reads `OPENCODE_RELAY_*` in daemon child process, uses `RELAY_ENV_KEYS`)
- `src/bin/cli-core.ts` line 124: reads `process.env.OPENCODE_URL` in foreground mode (should also use `ENV.opencodeUrl`)

Any stray `process.env` reads in other files → fix them.

**Step 4: Commit any fixes, then verify git status**

```
git status
git log --oneline -6
```

Expected: 5-6 clean commits covering the full changeset.

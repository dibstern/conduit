# Lint Warnings & Flaky Media Test Fixes

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the 4 biome lint warnings in `unified-rendering.spec.ts` and fix the flaky media generation integration test that fails when port 4173 is occupied by an orphaned Vite process.

**Architecture:** The biome warnings are in two permanently-skipped tests — fix the code despite the skip so the lint is clean. The media test timeout is caused by orphaned Vite preview processes from previous runs surviving because `execSync` only kills the direct child, not grandchildren. Fix by killing stale processes on the port before starting and adding stderr monitoring for immediate error reporting.

**Tech Stack:** Biome linter, Vitest, Playwright, Vite preview server

---

### Task 1: Fix `noNonNullAssertion` warnings (lines 290, 294, 299)

**Files:**
- Modify: `test/e2e/specs/unified-rendering.spec.ts:285-299`

**Context:** `sessionId` is typed `string | undefined` from `sessions[0]?.id`. There's an `expect(sessionId).toBeDefined()` guard at line 286, but TypeScript doesn't narrow after `expect()`. The fix is to add an early return after the assertion.

**Step 1: Fix the non-null assertions**

Replace:
```typescript
const sessionId = sessions[0]?.id;
expect(sessionId).toBeDefined();

// Get full message cache (populated by SSE during harness creation)
const cachedEvents =
    (await harness.stack.messageCache.getEvents(sessionId!)) ?? [];
// Fall back to mock REST for the full list if no cached events
const allMsgs =
    cachedEvents.length > 0
        ? await harness.stack.client.getMessages(sessionId!)
        : [];
if (allMsgs.length > 50) {
    const page1 = allMsgs.slice(-50); // most recent 50
    const page2 = allMsgs.slice(0, allMsgs.length - 50);
    harness.mock.setMessagePages(sessionId!, page1, page2);
}
```

With:
```typescript
const sessionId = sessions[0]?.id;
expect(sessionId).toBeDefined();
if (!sessionId) return; // TS narrowing (expect above catches test failures)

// Get full message cache (populated by SSE during harness creation)
const cachedEvents =
    (await harness.stack.messageCache.getEvents(sessionId)) ?? [];
// Fall back to mock REST for the full list if no cached events
const allMsgs =
    cachedEvents.length > 0
        ? await harness.stack.client.getMessages(sessionId)
        : [];
if (allMsgs.length > 50) {
    const page1 = allMsgs.slice(-50); // most recent 50
    const page2 = allMsgs.slice(0, allMsgs.length - 50);
    harness.mock.setMessagePages(sessionId, page1, page2);
}
```

**Step 2: Run lint to verify warnings are gone**

Run: `pnpm lint 2>&1 | grep noNonNullAssertion`
Expected: No output (warnings eliminated)

---

### Task 2: Fix `noUnusedFunctionParameters` warning (line 330)

**Files:**
- Modify: `test/e2e/specs/unified-rendering.spec.ts:327-331`

**Context:** The second skipped test destructures `harness` from the Playwright test context but never uses it. Playwright fixtures match by destructured property name — renaming to `_harness` would fail because there's no fixture called `_harness`. The `relayUrl` fixture depends on `harness` internally (it's instantiated via the fixture dependency chain in `replay-fixture.ts:51`), so removing `harness` from destructuring is safe — it's still instantiated by Playwright for `relayUrl`.

**Step 1: Remove unused parameter from destructuring**

Replace:
```typescript
test("scrolling up loads more history and 'Beginning of session' appears", async ({
    page,
    relayUrl,
    harness,
}) => {
```

With:
```typescript
test("scrolling up loads more history and 'Beginning of session' appears", async ({
    page,
    relayUrl,
}) => {
```

**Step 2: Run lint to verify warning is gone**

Run: `pnpm lint 2>&1 | grep noUnusedFunctionParameters`
Expected: No output

**Step 3: Run check to ensure types still pass**

Run: `pnpm check`
Expected: Clean

**Step 4: Commit**

```bash
git add test/e2e/specs/unified-rendering.spec.ts
git commit -m "fix: resolve biome lint warnings in unified-rendering.spec.ts

Add guard-return after expect().toBeDefined() so TypeScript narrows
sessionId without non-null assertions. Remove unused harness parameter
from a skipped test."
```

---

### Task 3: Fix media generation preview server orphaned process & timeout

**Files:**
- Modify: `scripts/generate-media/scene-runner.ts:70-101`
- Modify: `scripts/generate-media/index.ts:92-104`

**Context:** The `startPreview` function fails when port 4173 is occupied by an orphaned Vite process from a previous run. Two problems:

1. **Root cause — cleanup doesn't kill the whole tree:** `previewProc.kill()` in the `finally` block sends SIGTERM to the direct child (`npx`), but npx may exit without forwarding it to its child (`vite`). Fix by spawning into a process group (`detached: true`) and killing the group (`-pid`).
2. **No safety net for external kills:** When the integration test's `execSync` times out, it kills the direct child but the `finally` block in `index.ts` may never run, leaving orphans. Fix by adding `killStalePreview()` to clean up stale processes before starting.
3. **Silent failure:** stderr is unmonitored, so port-in-use errors manifest as a 15-second timeout. Fix by monitoring stderr and `proc.on("close")`.

**Step 1: Fix the process group spawn and cleanup in scene-runner.ts**

Replace the `startPreview` function (lines 71-101):
```typescript
export async function startPreview(): Promise<ChildProcess> {
	console.log("  Starting preview server...");
	const proc = spawn(
		"npx",
		["vite", "preview", "--port", String(PREVIEW_PORT), "--strictPort"],
		{
			cwd: PROJECT_ROOT,
			stdio: "pipe",
			env: { ...process.env },
		},
	);

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("Preview server timeout")),
			15_000,
		);
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
```

With:
```typescript
/** Kill any process listening on PREVIEW_PORT (orphan from a previous run). */
function killStalePreview(): void {
	try {
		const out = execSync(`lsof -ti :${PREVIEW_PORT}`, { stdio: "pipe" })
			.toString()
			.trim();
		if (out) {
			for (const pid of out.split("\n")) {
				try {
					process.kill(Number(pid), "SIGTERM");
				} catch {
					/* already exited */
				}
			}
			// Brief pause for the port to be released
			execSync("sleep 0.5", { stdio: "pipe" });
			console.log(
				`  Killed stale process(es) on port ${PREVIEW_PORT}: ${out.replace(/\n/g, ", ")}`,
			);
		}
	} catch {
		/* No process on port — expected path */
	}
}

/**
 * Kill a preview server process group.
 * The process is spawned with `detached: true`, making it a process group
 * leader. Killing the negative PID sends SIGTERM to the entire group
 * (npx + vite + any children), preventing orphaned Vite servers.
 */
export function killPreviewGroup(proc: ChildProcess): void {
	if (proc.pid != null) {
		try {
			process.kill(-proc.pid, "SIGTERM");
		} catch {
			/* already exited */
		}
	}
}

/** Start vite preview and wait for it to be ready. */
export async function startPreview(): Promise<ChildProcess> {
	killStalePreview();
	console.log("  Starting preview server...");
	const proc = spawn(
		"npx",
		["vite", "preview", "--port", String(PREVIEW_PORT), "--strictPort"],
		{
			cwd: PROJECT_ROOT,
			stdio: "pipe",
			detached: true,
			env: { ...process.env },
		},
	);

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("Preview server timeout (15s)")),
			15_000,
		);
		let stderrChunks = "";
		proc.stdout?.on("data", (data: Buffer) => {
			if (data.toString().includes(String(PREVIEW_PORT))) {
				clearTimeout(timeout);
				resolve();
			}
		});
		proc.stderr?.on("data", (data: Buffer) => {
			stderrChunks += data.toString();
		});
		proc.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});
		proc.on("close", (code) => {
			if (code !== 0) {
				clearTimeout(timeout);
				reject(
					new Error(
						`Preview server exited with code ${code}: ${stderrChunks.trim() || "(no stderr)"}`,
					),
				);
			}
		});
	});

	return proc;
}
```

**Step 2: Update index.ts to use process group kill**

In `scripts/generate-media/index.ts`, update the import and the `finally` block.

Import: add `killPreviewGroup` to the import from `./scene-runner.js`.

Replace:
```typescript
	} finally {
		previewProc.kill();
```

With:
```typescript
	} finally {
		killPreviewGroup(previewProc);
```

**Step 3: Kill the orphaned process currently on port 4173**

Run: `lsof -ti :4173 | xargs kill 2>/dev/null; echo "done"`

**Step 4: Run the integration test to verify it passes**

Run: `pnpm test:integration -- --grep "media generation" 2>&1 | tail -10`
Expected: Test passes now that the port is free and the stale-cleanup logic prevents future failures.

**Step 5: Commit**

```bash
git add scripts/generate-media/scene-runner.ts scripts/generate-media/index.ts
git commit -m "fix: kill preview server process group to prevent orphaned Vite processes

The preview server is spawned via npx → vite, but previewProc.kill()
only sends SIGTERM to npx — vite survives as an orphan on port 4173.
Spawn with detached:true to create a process group and use negative-PID
kill to terminate the entire tree.

Also add killStalePreview() to clean up orphans from previous runs
where the finally block never executed (e.g. test runner timeout),
and monitor stderr/exit-code so port-in-use errors are immediate
instead of a 15s timeout."
```

---

### Task 4: Final verification

**Step 1: Run default verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

Expected: All pass, zero lint warnings (only the pre-existing info about subagent-snapshot.json file size).

**Step 2: Run integration tests**

```bash
pnpm test:integration
```

Expected: All pass.

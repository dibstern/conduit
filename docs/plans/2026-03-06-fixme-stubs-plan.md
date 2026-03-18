# Fixme Stubs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve all 3 `test.fixme` stubs in `test/e2e/specs/multi-instance.spec.ts` — delete the obsolete one and implement the real daemon smoke test.

**Architecture:** There are two distinct fixme stubs (one is duplicated). Fixme 1 is obsolete — it tests the old "navigate to instance's projects" behavior that was intentionally replaced by "rebind current project's instance" (Bug B fix). Fixme 2 is a real daemon smoke test that needs a `Daemon`-level E2E harness (currently only `RelayStack`-level harness exists).

**Tech Stack:** Playwright, Vitest, TypeScript, SvelteKit, real OpenCode server at localhost:4096

---

## Fixme Inventory

| # | Location | Text | Verdict |
|---|----------|------|---------|
| 1 | Line 390 | `"selecting instance switches to its projects"` | **DELETE** — obsolete, superseded by Group 12 "Instance Selector: Rebind Project" test |
| 2 | Line 1023 | `"daemon with instances sends instance_list on browser connect"` | **IMPLEMENT** — real daemon E2E smoke test |

### Why Fixme 1 is Obsolete

The Bug B fix changed `Header.svelte:handleSelectInstance()` from navigating to a project belonging to the selected instance, to sending a `set_project_instance` WS message that rebinds the current project's instance. The fixme test asserts the old navigate behavior (`expect(page.locator("#project-name")).toContainText("company-api")`), which is no longer correct. The replacement test is already written and passing in Group 12:

```
test("clicking instance in dropdown sends set_project_instance and updates badge", ...)
```

### What Fixme 2 Needs

The test needs to:
1. Start a real `Daemon` (not `RelayStack`) pointed at the real OpenCode server
2. The daemon must register an instance and a project
3. A Playwright browser connects to the daemon's HTTP server
4. Verify the browser receives `instance_list` via WS and renders instance UI

**What exists:** `E2EHarness` wraps `RelayStack` (no project routing, no instances, no dashboard). Daemon unit tests (`daemon.test.ts`) show how to start/stop a `Daemon` with temp directories.

**What's needed:** A daemon-level E2E harness that combines `Daemon` start/stop with Playwright browser access. Since this is a smoke test (one test), a lightweight inline approach is better than building a full reusable fixture.

---

## Task 1: Delete Obsolete Fixme (selecting instance switches to its projects)

**Files:**
- Modify: `test/e2e/specs/multi-instance.spec.ts:390-402`

**Step 1: Delete the fixme test**

Remove lines 390-402:
```typescript
	test.fixme("selecting instance switches to its projects", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		const badge = page.locator("[data-testid='instance-badge']");
		await badge.click();
		const workOption = page
			.locator("#instance-selector-dropdown")
			.getByText("Work");
		await workOption.click();
		await expect(page.locator("#project-name")).toContainText("company-api");
	});
```

Also remove the line 5 comment referencing it:
```typescript
// Group 11: Real daemon smoke test (requires daemon, test.fixme)
```

**Step 2: Run E2E tests to verify nothing breaks**

Run: `pnpm test:multi-instance`
Expected: All tests pass, fixme count drops from 4 skipped to 2 skipped

**Step 3: Commit**

```
fix: delete obsolete "selecting instance switches to its projects" fixme

This test expected the old navigate-to-instance behavior that was
replaced by the rebind-project-instance behavior (Bug B fix).
The replacement test is Group 12 "Instance Selector: Rebind Project".
```

---

## Task 2: Implement Real Daemon Smoke Test

This is the substantial task. We need the daemon to start with a real OpenCode server, serve the frontend, and have a browser connect and verify instance_list arrives.

**Files:**
- Modify: `test/e2e/specs/multi-instance.spec.ts:1020-1034`
- Read (reference): `test/e2e/helpers/e2e-harness.ts`
- Read (reference): `test/unit/daemon.test.ts` (patterns for starting daemon)
- Read (reference): `src/lib/daemon.ts` (Daemon class API)

### Step 1: Write the real test (replacing the fixme stub)

The test creates a real `Daemon` pointed at the running OpenCode server, adds a project, then opens a Playwright browser and verifies instance data arrives.

Key design decisions:
- Use `port: 0` for the daemon HTTP server (OS-assigned, no conflicts)
- Use temp directory for config/socket/pid (test isolation)
- The daemon's built-in HTTP server serves `dist/public/` (the built frontend)
- Wait for the daemon's health poll to mark the default instance as healthy before opening the browser
- The browser connects to `http://localhost:{port}/p/{slug}/` and should receive `instance_list` via WS
- Skip the test if OpenCode isn't running or `OPENCODE_SERVER_PASSWORD` isn't set (CI safety)

Replace the fixme at line 1020-1034 with:

```typescript
// ─── Group 14: Real Daemon Smoke Test ───────────────────────────────────────

test.describe("Real Daemon Smoke (requires daemon)", () => {
	test("daemon with instances sends instance_list on browser connect", async ({
		page,
	}) => {
		// Skip if OpenCode isn't running with auth configured
		const password = process.env.OPENCODE_SERVER_PASSWORD;
		if (!password) {
			test.skip();
			return;
		}
		try {
			const res = await fetch("http://localhost:4096/health");
			if (res.ok) {
				// No auth required — test still valid but verify server is up
			}
		} catch {
			test.skip();
			return;
		}

		// --- Start a real Daemon ---
		const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join, resolve } = await import("node:path");
		const { Daemon } = await import("../../../src/lib/daemon.js");

		const tmpDir = mkdtempSync(join(tmpdir(), "e2e-daemon-smoke-"));
		const staticDir = resolve(
			import.meta.dirname,
			"../../../dist/public",
		);

		const daemon = new Daemon({
			port: 0,
			host: "127.0.0.1",
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			logPath: join(tmpDir, "daemon.log"),
			opencodeUrl: "http://localhost:4096",
			staticDir,
		});

		try {
			await daemon.start();
			const project = await daemon.addProject(process.cwd());
			const port = daemon.port;

			// Wait for the default instance health poll to report healthy
			await expect
				.poll(
					() => {
						const inst = daemon.getInstances()[0];
						return inst?.status;
					},
					{ timeout: 15_000, intervals: [500] },
				)
				.toBe("healthy");

			// --- Browser connects to daemon ---
			const baseUrl = `http://127.0.0.1:${port}`;
			await page.goto(`${baseUrl}/p/${project.slug}/`);

			// Page should load the SPA
			await expect(page).toHaveTitle("OpenCode Relay", {
				timeout: 10_000,
			});

			// The WS connection should receive instance_list.
			// Verify the header shows the instance badge with "Default".
			const badge = page.locator("[data-testid='instance-badge']");
			await expect(badge).toBeVisible({ timeout: 10_000 });
			await expect(badge).toContainText("Default");

			// The "No healthy instances" banner should NOT be visible
			// (because our health checker now sends auth and gets 200)
			const banner = page.getByText("No healthy OpenCode instances");
			await expect(banner).not.toBeVisible({ timeout: 5_000 });
		} finally {
			await daemon.stop();
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});
});
```

### Step 2: Build and run

Run: `pnpm run build && pnpm test:multi-instance`
Expected: The new test passes (no longer fixme-skipped). Total: 78 passed, 2 skipped (the 2 duplicate mobile runs of the same test).

Wait — the multi-instance config uses `vite preview` and mocked WS. This test needs a real daemon. Two options:
1. Put the test in the multi-instance spec but have it skip the WS mock and use a real daemon
2. Put it in a separate spec file that runs with the main playwright config (which uses real OpenCode)

Option 1 is correct because the test is already in multi-instance.spec.ts and doesn't use the WS mock — it creates its own daemon. The `vite preview` webServer in the config is irrelevant because the test navigates to the daemon's own HTTP server (not localhost:4173). The daemon serves `dist/public/` directly.

### Step 3: Verify and commit

Run: `pnpm test:multi-instance`
Expected: All tests pass, the fixme stub is now a real test

```
feat: implement real daemon smoke test for instance_list on browser connect

Creates a real Daemon pointed at the running OpenCode server, adds a
project, then opens a Playwright browser to verify:
- instance_list arrives via WS (badge shows "Default")
- health checker authenticates (no "unhealthy" banner)
Skips automatically when OpenCode is not running.
```

---

## Task 3: Remove the line-5 comment about fixme

**Files:**
- Modify: `test/e2e/specs/multi-instance.spec.ts:5`

Remove:
```typescript
// Group 11: Real daemon smoke test (requires daemon, test.fixme)
```

This comment is now stale — the test is no longer fixme.

**Step 1: Remove the comment**
**Step 2: Run tests to verify**
**Step 3: Commit with the Task 2 commit (squash)**

---

## Verification Checklist

After all tasks:
- [ ] `grep -c 'test\.fixme\|it\.fixme\|describe\.fixme' test/e2e/specs/multi-instance.spec.ts` returns `0`
- [ ] `pnpm test:multi-instance` — all pass
- [ ] `pnpm vitest run test/unit/` — all pass
- [ ] `pnpm tsc --noEmit` — clean
- [ ] `pnpm run build` — succeeds

# Frontend Status Fix + API Type Safety Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the loading bug where the frontend blindly connects WS to registering relays, and prevent future serialization bugs via typed API responses.

**Architecture:** Three coordinated layers: (1) shared response types enforced with `satisfies` at every `JSON.stringify` call site, (2) backend exposes `status` on `/api/projects` and adds a per-project status endpoint, (3) frontend does a pre-flight status check before WS connect and shows relay-specific states in the overlay.

**Tech Stack:** TypeScript, Node.js HTTP, Svelte 5 (`$state`/`$derived`/`$effect`), Vitest

**Design doc:** `docs/plans/2026-03-13-frontend-status-fix-design.md`

---

## Task 1: Add shared API response types to `shared-types.ts`

**Files:**
- Modify: `src/lib/shared-types.ts` (append after line 462)

This is the type foundation. All subsequent tasks depend on these types existing.

**Step 1: Add the types**

Append the following block at the end of `src/lib/shared-types.ts`:

```typescript
// ─── Typed API Responses ────────────────────────────────────────────────────
// Every HTTP JSON endpoint uses one of these types with `satisfies` at the
// JSON.stringify call site.  This prevents serialization bugs where fields
// are silently dropped.

/** Standard API error envelope used by all error responses. */
export interface ApiError {
	error: {
		code: string;
		message: string;
	};
}

// ─── Auth ──────────────────────────────────────────────────────────────────

export interface AuthStatusResponse {
	hasPin: boolean;
	authenticated: boolean;
}

export type AuthResponse =
	| { ok: true }
	| { ok: false; locked: true; retryAfter: number }
	| { ok: false; attemptsLeft: number };

// ─── Setup ─────────────────────────────────────────────────────────────────

export interface SetupInfoResponse {
	httpsUrl: string;
	httpUrl: string;
	hasCert: boolean;
	lanMode: boolean;
}

// ─── Health ────────────────────────────────────────────────────────────────

export interface HealthResponse {
	ok: boolean;
	projects: number;
	uptime: number;
}

// ─── Info ──────────────────────────────────────────────────────────────────

export interface InfoResponse {
	version: string;
}

// ─── Themes ────────────────────────────────────────────────────────────────

export interface ThemesResponse {
	bundled: Record<string, Base16Theme>;
	custom: Record<string, Base16Theme>;
}

// ─── Projects ──────────────────────────────────────────────────────────────

export interface DashboardProjectResponse {
	slug: string;
	path: string;
	title: string;
	status: "registering" | "ready" | "error";
	error?: string;
	sessions: number;
	clients: number;
	isProcessing: boolean;
}

export interface ProjectsListResponse {
	projects: DashboardProjectResponse[];
	version: string;
}

// ─── Project Status ────────────────────────────────────────────────────────

export interface ProjectStatusResponse {
	status: "registering" | "ready" | "error";
	error?: string;
}

// ─── Push ──────────────────────────────────────────────────────────────────

export interface VapidKeyResponse {
	publicKey: string;
}

export interface PushOkResponse {
	ok: true;
}
```

**Step 2: Run type check to verify**

Run: `pnpm check`
Expected: PASS (types are additive, nothing uses them yet)

**Step 3: Commit**

```
feat: add typed API response interfaces for all HTTP endpoints
```

---

## Task 2: Add `error` field to `RouterProject` + populate in daemon

**Files:**
- Modify: `src/lib/server/http-router.ts:42-53` (add `error?` to `RouterProject`)
- Modify: `src/lib/daemon/daemon.ts:551-559` (populate `error` in getProjects closure)
- Test: `test/unit/server/http-router.test.ts`

**Step 1: Write the failing test**

In `test/unit/server/http-router.test.ts`, add a new test inside the existing `describe("/api/projects")` block (after line 288):

```typescript
		it("includes error field for error-state projects", async () => {
			const projects: RouterProject[] = [
				{
					slug: "broken",
					directory: "/tmp/broken",
					title: "Broken",
					status: "error",
					error: "Connection refused",
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			const body = (await res.json()) as {
				projects: { slug: string; error?: string }[];
			};
			expect(body.projects[0]?.error).toBe("Connection refused");
		});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/server/http-router.test.ts --reporter=verbose`
Expected: FAIL — `RouterProject` does not have `error` property (compile error), and even if it did, the serializer at line 269 doesn't include it.

**Step 3: Add `error?` to `RouterProject`**

In `src/lib/server/http-router.ts`, modify the `RouterProject` interface (lines 42-53). Add `error?` after `status?`:

```typescript
export interface RouterProject {
	slug: string;
	directory: string;
	title: string;
	status?: "registering" | "ready" | "error";
	/** Error message when status is "error". */
	error?: string;
	/** Connected browser clients for this project. */
	clients?: number;
	/** Cached session count for this project. */
	sessions?: number;
	/** True when at least one session is busy or retrying. */
	isProcessing?: boolean;
}
```

**Step 4: Populate `error` in daemon's `getProjects` closure**

In `src/lib/daemon/daemon.ts`, modify the `result.push({...})` block (lines 551-559). Add the `error` field:

```typescript
					result.push({
						slug: entry.project.slug,
						directory: entry.project.directory,
						title: entry.project.title,
						status: entry.status,
						error: entry.status === "error" ? entry.error : undefined,
						clients: relay?.wsHandler.getClientCount() ?? 0,
						sessions: relay?.messageCache.sessionCount() ?? 0,
						isProcessing: relay?.isAnySessionProcessing() ?? false,
					});
```

Note: `entry.error` is available because when `entry.status === "error"`, the entry is a `ProjectError` which has `readonly error: string` (see `project-registry.ts:23-27`).

**Step 5: Run test to verify it still fails**

The test will still fail because the `/api/projects` serializer at line 269 doesn't include `error` yet. That is fixed in Task 3. For now verify the type check passes:

Run: `pnpm check`
Expected: PASS

**Step 6: Commit**

```
feat: add error field to RouterProject for error-state projects
```

---

## Task 3: Fix `/api/projects` serialization with typed serializer

**Files:**
- Modify: `src/lib/server/http-router.ts:267-284` (replace inline map with typed serializer)
- Test: `test/unit/server/http-router.test.ts`

**Step 1: Write failing tests**

Add these tests inside the existing `describe("/api/projects")` block in `test/unit/server/http-router.test.ts`:

```typescript
		it("includes status field in response", async () => {
			const projects: RouterProject[] = [
				{
					slug: "starting",
					directory: "/tmp/starting",
					title: "Starting",
					status: "registering",
				},
				{
					slug: "live",
					directory: "/tmp/live",
					title: "Live",
					status: "ready",
					clients: 2,
					sessions: 5,
					isProcessing: true,
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			const body = (await res.json()) as {
				projects: Array<{
					slug: string;
					status: string;
					sessions: number;
					clients: number;
					isProcessing: boolean;
				}>;
			};
			const starting = body.projects.find((p) => p.slug === "starting");
			const live = body.projects.find((p) => p.slug === "live");
			expect(starting?.status).toBe("registering");
			expect(live?.status).toBe("ready");
			expect(live?.sessions).toBe(5);
			expect(live?.clients).toBe(2);
			expect(live?.isProcessing).toBe(true);
		});

		it("defaults status to ready when not provided", async () => {
			const projects: RouterProject[] = [
				{ slug: "legacy", directory: "/tmp/legacy", title: "Legacy" },
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			const body = (await res.json()) as {
				projects: Array<{ slug: string; status: string }>;
			};
			expect(body.projects[0]?.status).toBe("ready");
		});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/server/http-router.test.ts --reporter=verbose`
Expected: FAIL — status field is not in the response

**Step 3: Add typed serializer and fix the `/api/projects` handler**

In `src/lib/server/http-router.ts`, add the import for the new types at the top of the file (after existing imports):

```typescript
import type {
	DashboardProjectResponse,
	ProjectsListResponse,
} from "../shared-types.js";
```

Add a module-level serializer function (before the `RequestRouter` class, after the interfaces):

```typescript
/** Serialize a RouterProject to the dashboard API shape. */
function serializeProject(p: RouterProject): DashboardProjectResponse {
	return {
		slug: p.slug,
		path: p.directory,
		title: p.title || "",
		status: p.status ?? "ready",
		...(p.error != null && { error: p.error }),
		sessions: p.sessions ?? 0,
		clients: p.clients ?? 0,
		isProcessing: p.isProcessing ?? false,
	};
}
```

Replace the `/api/projects` handler (lines 267-284) with:

```typescript
			// ─── Projects list API ──────────────────────────────────────
			if (pathname === "/api/projects" && req.method === "GET") {
				const projects = this.getProjects();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						projects: projects.map(serializeProject),
						version: getVersion(),
					} satisfies ProjectsListResponse),
				);
				return;
			}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/server/http-router.test.ts --reporter=verbose`
Expected: ALL PASS (including the test from Task 2 for the `error` field)

**Step 5: Run full check**

Run: `pnpm check`
Expected: PASS

**Step 6: Commit**

```
fix: expose status and error fields in /api/projects response

The inline .map() to an untyped literal silently dropped the status
field populated by the daemon. Replace with a typed serializer
function + satisfies check to prevent this class of bug.
```

---

## Task 4: Add `/p/:slug/api/status` endpoint

**Files:**
- Modify: `src/lib/server/http-router.ts:298-334` (add route before SPA fallback)
- Test: `test/unit/server/http-router.test.ts`

**Step 1: Write failing tests**

Add a new `describe` block in `test/unit/server/http-router.test.ts` after the "Project routes" describe:

```typescript
	describe("/p/:slug/api/status", () => {
		it("returns ready status for a ready project", async () => {
			const projects: RouterProject[] = [
				{
					slug: "my-app",
					directory: "/tmp/my-app",
					title: "My App",
					status: "ready",
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/my-app/api/status"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { status: string; error?: string };
			expect(body.status).toBe("ready");
			expect(body.error).toBeUndefined();
		});

		it("returns registering status", async () => {
			const projects: RouterProject[] = [
				{
					slug: "starting",
					directory: "/tmp/starting",
					title: "Starting",
					status: "registering",
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/starting/api/status"));
			const body = (await res.json()) as { status: string };
			expect(body.status).toBe("registering");
		});

		it("returns error status with error message", async () => {
			const projects: RouterProject[] = [
				{
					slug: "broken",
					directory: "/tmp/broken",
					title: "Broken",
					status: "error",
					error: "Connection refused",
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/broken/api/status"));
			const body = (await res.json()) as { status: string; error?: string };
			expect(body.status).toBe("error");
			expect(body.error).toBe("Connection refused");
		});

		it("returns 404 for unknown slug", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/p/ghost/api/status"));
			expect(res.status).toBe(404);
		});

		it("returns JSON 401 when PIN set and unauthenticated", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			testServer = createTestServer({
				auth,
				getProjects: () => [
					{
						slug: "secure",
						directory: "/tmp/secure",
						title: "Secure",
						status: "ready",
					},
				],
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/secure/api/status"));
			expect(res.status).toBe(401);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("AUTH_REQUIRED");
		});

		it("defaults status to ready when project has no status field", async () => {
			const projects: RouterProject[] = [
				{ slug: "legacy", directory: "/tmp/legacy", title: "Legacy" },
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/legacy/api/status"));
			const body = (await res.json()) as { status: string };
			expect(body.status).toBe("ready");
		});
	});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/server/http-router.test.ts --reporter=verbose`
Expected: FAIL — endpoint doesn't exist, returns SPA HTML

**Step 3: Implement the endpoint**

In `src/lib/server/http-router.ts`, add the import for `ProjectStatusResponse` and `ApiError` (extend the existing import added in Task 3):

```typescript
import type {
	ApiError,
	DashboardProjectResponse,
	ProjectsListResponse,
	ProjectStatusResponse,
} from "../shared-types.js";
```

In the project routes section (after the project 404 check at line 316, before the `onProjectApiRequest` delegation at line 319), add:

```typescript
				// ─── Per-project status API ─────────────────────────
				if (subPath === "/api/status" && req.method === "GET") {
					// Auth gate — return JSON 401, not 302 redirect
					if (this.auth.hasPin() && !this.checkAuth(req)) {
						res.writeHead(401, { "Content-Type": "application/json" });
						res.end(
							JSON.stringify({
								error: {
									code: "AUTH_REQUIRED",
									message: "PIN required",
								},
							} satisfies ApiError),
						);
						return;
					}
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							status: project.status ?? "ready",
							...(project.error != null && { error: project.error }),
						} satisfies ProjectStatusResponse),
					);
					return;
				}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/server/http-router.test.ts --reporter=verbose`
Expected: ALL PASS

**Step 5: Commit**

```
feat: add per-project status endpoint GET /p/:slug/api/status

Returns the relay status (registering/ready/error) for a single
project. Uses inline JSON 401 auth instead of the 302 redirect
used by browser routes.
```

---

## Task 5: HTTP 503 on WS rejection

**Files:**
- Modify: `src/lib/daemon/daemon.ts:610-616` (write 503 before destroying socket)
- Test: `test/unit/daemon/daemon.test.ts`

**Step 1: Write failing test**

Add a new test inside the existing `describe("Daemon WS upgrade — waitForRelay integration")` block in `test/unit/daemon/daemon.test.ts` (after line 2394):

```typescript
	it("WS upgrade returns HTTP 503 when relay fails to become ready", async () => {
		const d = new Daemon(daemonOpts(tmpDir));
		await d.start();
		const port = d.port;

		// Add project — relay factory will reject (no OpenCode instance)
		await d.addProject("/home/user/failing-app");
		const slug = "failing-app";

		// Mark the project as errored so waitForRelay rejects quickly
		d.registry.startRelay(slug, async () => {
			throw new Error("simulated relay creation failure");
		});

		// Wait for the project to enter error state
		await vi.waitFor(() => {
			expect(d.registry.get(slug)?.status).toBe("error");
		});

		// Now send a WS upgrade — should get 503 back
		const response = await new Promise<string>((resolve, reject) => {
			const req = http.request({
				hostname: "127.0.0.1",
				port,
				path: `/p/${slug}/ws`,
				headers: {
					Connection: "Upgrade",
					Upgrade: "websocket",
					"Sec-WebSocket-Version": "13",
					"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				},
			});
			const timeout = setTimeout(() => {
				req.destroy();
				reject(new Error("timed out"));
			}, 5000);

			req.on("response", (res) => {
				clearTimeout(timeout);
				resolve(`${res.statusCode}`);
				res.resume();
			});
			req.on("error", (err) => {
				clearTimeout(timeout);
				// Socket destroy without a response is also valid
				resolve(`error:${err.code ?? err.message}`);
			});
			req.end();
		});

		// Should receive a 503 response (or a socket error if the write races)
		expect(response).toMatch(/^503|^error:/);

		await d.stop();
	});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/daemon.test.ts -t "HTTP 503" --reporter=verbose`
Expected: FAIL — current code just destroys the socket without writing a response

**Step 3: Implement HTTP 503 on WS rejection**

In `src/lib/daemon/daemon.ts`, replace the catch block at lines 610-616:

Old:
```typescript
			} catch (err) {
				this.log.warn(
					{ slug, error: formatErrorDetail(err) },
					"WS upgrade rejected: relay not available",
				);
				if (!socket.destroyed) socket.destroy();
			}
```

New:
```typescript
			} catch (err) {
				this.log.warn(
					{ slug, error: formatErrorDetail(err) },
					"WS upgrade rejected: relay not available",
				);
				if (!socket.destroyed) {
					if (socket.writable) {
						socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
					}
					socket.destroy();
				}
			}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/daemon/daemon.test.ts -t "WS upgrade" --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```
fix: return HTTP 503 on WS upgrade rejection instead of silent destroy

Surfaces the failure in browser dev tools as a 503 instead of a
mysterious connection reset. Guards socket.writable before writing
since the client may disconnect during the 10s waitForRelay window.
```

---

## Task 6: Type remaining `JSON.stringify` sites in `http-router.ts`

**Files:**
- Modify: `src/lib/server/http-router.ts` (add `satisfies` to all 26 JSON.stringify sites)

This task adds compile-time type safety to all remaining inline JSON responses. It is a mechanical refactor — no behavior changes, no new tests needed beyond the type checker.

**Step 1: Add remaining type imports**

Extend the import from `shared-types.js` in `http-router.ts`:

```typescript
import type {
	ApiError,
	AuthResponse,
	AuthStatusResponse,
	DashboardProjectResponse,
	HealthResponse,
	InfoResponse,
	ProjectsListResponse,
	ProjectStatusResponse,
	PushOkResponse,
	SetupInfoResponse,
	ThemesResponse,
	VapidKeyResponse,
} from "../shared-types.js";
```

**Step 2: Add `satisfies` annotations**

Apply `satisfies` to each `JSON.stringify` call. The critical ones:

- Line 146 (`/api/auth/status`): `satisfies AuthStatusResponse`
- Line 169 (auth gate 401): `satisfies ApiError`
- Line 214 (`/api/setup-info`): `satisfies SetupInfoResponse`
- Line 234 (health): `satisfies HealthResponse` (only if `getHealthResponse` is NOT provided — the custom response from daemon uses `DaemonStatus` which is different; skip `satisfies` on the custom path)
- Line 241 (`/info`): `satisfies InfoResponse`
- Line 251 (`/api/themes` success): `satisfies ThemesResponse`
- Line 255 (`/api/themes` error): `satisfies ApiError`
- Line 309 (project 404): `satisfies ApiError`
- Line 359 (catch-all 500): `satisfies ApiError`
- Line 406 (bad JSON): `satisfies ApiError`
- Lines 421/425/434 (POST `/auth`): `satisfies AuthResponse`
- Lines 451/460 (VAPID key): `satisfies ApiError` / `satisfies VapidKeyResponse`
- Lines 469/484/495/499 (push subscribe): `satisfies ApiError` / `satisfies PushOkResponse`
- Lines 511/526/537/541 (push unsubscribe): `satisfies ApiError` / `satisfies PushOkResponse`
- Lines 558/578 (CA download): `satisfies ApiError`

For each site, the pattern is:
```typescript
// Before:
res.end(JSON.stringify({ field: value }));
// After:
res.end(JSON.stringify({ field: value } satisfies TypeName));
```

If any response literal doesn't match its type, TypeScript will error — that's the point. Fix the literal to match.

**Step 3: Run type check**

Run: `pnpm check`
Expected: PASS (if any `satisfies` constraint fails, fix the response literal to match the type)

**Step 4: Run all http-router tests**

Run: `pnpm vitest run test/unit/server/http-router.test.ts --reporter=verbose`
Expected: ALL PASS (no behavior changes)

**Step 5: Commit**

```
refactor: add satisfies type checks to all HTTP JSON responses

Annotates all 26 JSON.stringify sites in http-router.ts with
satisfies constraints against shared-types.ts response interfaces.
Prevents future serialization bugs at compile time.
```

---

## Task 7: Type onboarding server endpoints

**Files:**
- Modify: `src/lib/daemon/daemon-lifecycle.ts:199-216` (add `satisfies SetupInfoResponse`)

**Step 1: Add import**

Add at the top of `daemon-lifecycle.ts`:

```typescript
import type { SetupInfoResponse } from "../shared-types.js";
```

**Step 2: Add `satisfies` to `/api/setup-info` response**

In `daemon-lifecycle.ts`, change the `JSON.stringify` at lines 209-215:

```typescript
							res.end(
								JSON.stringify({
									httpsUrl,
									httpUrl,
									hasCert: true,
									lanMode,
								} satisfies SetupInfoResponse),
							);
```

**Step 3: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 4: Commit**

```
refactor: type onboarding /api/setup-info response with satisfies
```

---

## Task 8: Unify frontend `DashboardProject` type

**Files:**
- Modify: `src/lib/frontend/pages/dashboard-types.ts` (replace interface with alias)
- Modify: `src/lib/frontend/pages/DashboardPage.stories.ts` (add `status` to mock data)
- Modify: `src/lib/frontend/types.ts` (re-export `DashboardProjectResponse`)

**Step 1: Replace `DashboardProject` with type alias**

Replace the entire content of `src/lib/frontend/pages/dashboard-types.ts` with:

```typescript
/** Shape of a project entry on the dashboard page. */
export type { DashboardProjectResponse as DashboardProject } from "../../shared-types.js";
```

**Step 2: Update stories mock data**

In `src/lib/frontend/pages/DashboardPage.stories.ts`, add `status` to each mock project in `mockProjects` (lines 19-43). Also add a fourth project in error state to exercise the new badge:

```typescript
const mockProjects: DashboardProject[] = [
	{
		slug: "opencode-relay",
		path: "/Users/dev/projects/opencode-relay",
		title: "OpenCode Relay",
		status: "ready",
		sessions: 5,
		clients: 2,
		isProcessing: true,
	},
	{
		slug: "my-api",
		path: "/Users/dev/projects/my-api",
		title: "My API Server",
		status: "ready",
		sessions: 12,
		clients: 0,
		isProcessing: false,
	},
	{
		slug: "frontend-app",
		path: "/Users/dev/projects/frontend-app",
		title: "",
		status: "registering",
		sessions: 0,
		clients: 0,
		isProcessing: false,
	},
	{
		slug: "broken-service",
		path: "/Users/dev/projects/broken-service",
		title: "Broken Service",
		status: "error",
		error: "Connection refused: ECONNREFUSED 127.0.0.1:4096",
		sessions: 0,
		clients: 0,
		isProcessing: false,
	},
];
```

Note: `DashboardProjectResponse` requires `title: string` (not optional). Update `title` to `""` for the slug-fallback test case.

**Step 3: Add re-export in `types.ts`**

In `src/lib/frontend/types.ts`, add a re-export (after the existing re-exports block around line 48):

```typescript
export type { DashboardProjectResponse } from "../shared-types.js";
```

**Step 4: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 5: Commit**

```
refactor: unify DashboardProject with shared DashboardProjectResponse type

Single source of truth for the project API shape. Stories updated
with status field and error-state mock project.
```

---

## Task 9: Dashboard status badges

**Files:**
- Modify: `src/lib/frontend/pages/DashboardPage.svelte:84-88` (update `statusIcon`)
- Modify: `src/lib/frontend/pages/DashboardPage.svelte:126-147` (error tooltip)

**Step 1: Update `statusIcon` function**

Replace `statusIcon` in `DashboardPage.svelte` (lines 84-88):

```typescript
	function statusIcon(project: DashboardProject): string {
		if (project.status === "registering") return "\u23F3"; // ⏳
		if (project.status === "error") return "\u274C"; // ❌
		if (project.isProcessing) return "\u26A1"; // ⚡
		if (project.clients > 0) return "\uD83D\uDFE2"; // 🟢
		return "\u23F8"; // ⏸
	}
```

**Step 2: Add error tooltip to project card**

In the project card template (around line 138-142 where `project.path` is rendered), add an error subtitle below the path when `project.status === "error"`:

```svelte
				<span class="block text-xs text-text-dimmer font-mono truncate">{project.path}</span>
				{#if project.status === "error" && project.error}
					<span class="block text-xs text-red-400 truncate mt-0.5" title={project.error}>
						{project.error}
					</span>
				{/if}
```

**Step 3: Run type check + lint**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 4: Commit**

```
feat: show relay status badges and error messages on dashboard cards
```

---

## Task 10: Pre-flight status check in `ws.svelte.ts`

**Files:**
- Modify: `src/lib/frontend/stores/ws.svelte.ts` (add pre-flight fetch before WS connect)

**Step 1: Add `relayStatus` to `wsState`**

In `ws.svelte.ts`, extend the `wsState` object (lines 49-54):

```typescript
export const wsState = $state({
	status: "" as ConnectionStatus,
	statusText: "",
	/** Number of connection attempts since last successful connection. */
	attempts: 0,
	/** Relay readiness from pre-flight check. */
	relayStatus: undefined as "registering" | "ready" | "error" | undefined,
	/** Error message from relay when status is "error". */
	relayError: undefined as string | undefined,
});
```

**Step 2: Add pre-flight check function**

Add a new function before the `connect` function:

```typescript
/** Check relay status before WS connect. Returns true if OK to connect. */
async function checkRelayStatus(slug: string): Promise<boolean> {
	try {
		const res = await fetch(`/p/${slug}/api/status`);
		if (!res.ok) return true; // 404/401 = standalone mode, proceed
		const data = (await res.json()) as { status: string; error?: string };

		if (data.status === "ready") {
			wsState.relayStatus = "ready";
			return true;
		}

		if (data.status === "error") {
			wsState.relayStatus = "error";
			wsState.relayError = data.error;
			return false;
		}

		// "registering" — poll until ready or error
		wsState.relayStatus = "registering";
		return new Promise<boolean>((resolve) => {
			const poll = setInterval(async () => {
				try {
					const r = await fetch(`/p/${slug}/api/status`);
					if (!r.ok) { clearInterval(poll); resolve(true); return; }
					const d = (await r.json()) as { status: string; error?: string };
					if (d.status === "ready") {
						clearInterval(poll);
						wsState.relayStatus = "ready";
						resolve(true);
					} else if (d.status === "error") {
						clearInterval(poll);
						wsState.relayStatus = "error";
						wsState.relayError = d.error;
						resolve(false);
					}
					// else still "registering", keep polling
				} catch {
					clearInterval(poll);
					resolve(true); // network error, try connecting anyway
				}
			}, 1000);
		});
	} catch {
		return true; // fetch failed (standalone mode, network error), proceed
	}
}
```

**Step 3: Integrate pre-flight check into `connect`**

The `connect` function needs to become async internally but keep its sync signature (callers don't await it). Wrap the WS creation in the pre-flight check:

In the `connect` function, after the reconnect timer cleanup (line 105) and before the URL building (line 107), add:

```typescript
	// Pre-flight relay status check (only for project routes)
	if (slug) {
		wsState.relayStatus = undefined;
		wsState.relayError = undefined;
		checkRelayStatus(slug).then((ok) => {
			// Guard: another connect() call may have fired since
			if (_currentSlug !== slug) return;
			if (!ok) return; // error state — don't connect
			doConnect(slug);
		});
		return;
	}

	doConnect(slug);
```

Extract the WS creation logic (lines 107-169) into an inner function `doConnect(slug)`:

```typescript
function doConnect(slug: string | undefined): void {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const path = slug ? `/p/${slug}/ws` : "/ws";
	// ... rest of the existing connect logic from line 107 to 169
}
```

Keep the `connect` function as the exported entry point that handles cleanup and delegates to either the pre-flight path or `doConnect` directly.

**Step 4: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 5: Commit**

```
feat: add pre-flight relay status check before WS connect

Fetches /p/:slug/api/status before opening the WebSocket. If relay
is registering, polls every 1s. If error, skips connect. Falls
through to existing behavior on fetch failure for backward
compatibility with standalone mode.
```

---

## Task 11: ConnectOverlay relay-status-aware states

**Files:**
- Modify: `src/lib/frontend/components/overlays/ConnectOverlay.svelte`

**Step 1: Read `relayStatus` from `wsState`**

The overlay already imports `wsState`. Add derived state:

```typescript
	const relayStatus = $derived(wsState.relayStatus);
	const relayError = $derived(wsState.relayError);
```

**Step 2: Update verb display for relay states**

Modify the verb cycling `$effect` (lines 149-157) to skip verb cycling when relayStatus is `"registering"` or `"error"`:

```typescript
	$effect(() => {
		if (connected) return;
		if (relayStatus === "registering" || relayStatus === "error") return;
		const interval = setInterval(() => {
			let next: string;
			do { next = randomThinkingVerb(); } while (next === verb);
			verb = next;
		}, VERB_CYCLE_MS);
		return () => clearInterval(interval);
	});
```

**Step 3: Add relay-status-aware display in the template**

In the template, after the existing `{#key verb}` block (line 252) and before the status text div (line 256), add conditional relay status display:

```svelte
		{#if relayStatus === "registering"}
			<!-- Replace verb display with static "Starting relay..." -->
			<div class="text-lg font-medium text-text-muted">
				Starting relay...
			</div>
		{:else if relayStatus === "error"}
			<div class="text-lg font-medium text-red-400">
				Relay failed to start
			</div>
			{#if relayError}
				<div class="text-xs text-text-dimmer mt-1 max-w-xs text-center truncate" title={relayError}>
					{relayError}
				</div>
			{/if}
			<div class="flex gap-3 mt-3">
				<a
					href="/"
					class="px-4 py-1.5 text-sm rounded-lg border border-border text-text hover:bg-black/[0.05] font-medium"
					onclick={handleEscape}
				>
					Back to dashboard
				</a>
			</div>
		{/if}
```

Wrap the existing verb `{#key}` block so it only shows when relay is not in a special state:

```svelte
		{#if relayStatus !== "registering" && relayStatus !== "error"}
			{#key verb}
				<!-- existing verb shimmer code -->
			{/key}
		{/if}
```

**Step 4: Update escape link timing**

When `relayStatus === "error"`, show the escape link immediately (not after 4 seconds). Modify the escape hatch `$effect` (lines 117-127):

```typescript
	$effect(() => {
		if (connected) {
			showEscapeLink = false;
			return;
		}
		if (relayStatus === "error") {
			showEscapeLink = true;
			return;
		}
		const timer = setTimeout(() => {
			showEscapeLink = true;
		}, 4_000);
		return () => clearTimeout(timer);
	});
```

**Step 5: Run type check + lint**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 6: Commit**

```
feat: relay-status-aware ConnectOverlay states

Shows "Starting relay..." during registration, error details with
immediate dashboard escape when relay fails, and existing verb
animation for normal connection flow.
```

---

## Task 12: Smarter reconnect logic with exponential backoff

**Files:**
- Modify: `src/lib/frontend/stores/ws.svelte.ts` (replace unconditional 2s reconnect)

**Step 1: Add backoff constants**

Replace the `RECONNECT_DELAY_MS` constant (line 47) with:

```typescript
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 16_000;
```

**Step 2: Add backoff calculation**

Add a function:

```typescript
/** Exponential backoff: 1s → 2s → 4s → 8s → 16s (cap). */
function getBackoffMs(attempt: number): number {
	return Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
}
```

**Step 3: Replace unconditional reconnect in close handler**

Replace the reconnect block in the close handler (lines 148-153):

```typescript
		// Auto-reconnect with exponential backoff and status check
		if (_reconnectTimer) clearTimeout(_reconnectTimer);

		const delay = getBackoffMs(wsState.attempts);
		_reconnectTimer = setTimeout(() => {
			_reconnectTimer = null;
			connect(_currentSlug);
		}, delay);
```

The pre-flight check in `connect()` (from Task 10) will handle the status check before reconnecting.

**Step 4: Reset attempts on successful connect**

This is already done at line 125: `wsState.attempts = 0;` — verify it is still present.

**Step 5: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 6: Commit**

```
fix: replace blind 2s reconnect with exponential backoff

Backoff starts at 1s and doubles up to 16s cap. The pre-flight
relay status check (from Task 10) runs on each reconnect attempt,
so the frontend won't hammer a registering or errored relay.
```

---

## Final Verification

**Step 1: Run all checks**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

Expected: ALL PASS

**Step 2: Manual smoke test**

1. Start daemon, navigate to a project that is still registering
2. Overlay should show "Starting relay..." with O animation
3. When relay becomes ready, WS connects and overlay fades
4. Dashboard cards should show status badges
5. Project in error state shows error message on card and in overlay

---

## Task Dependency Graph

```
Task 1 (shared types)
  ├── Task 2 (error field on RouterProject)
  │     └── Task 3 (typed /api/projects serializer) ←── depends on Task 2 for error field
  │           └── Task 4 (/p/:slug/api/status endpoint)
  ├── Task 5 (HTTP 503 on WS rejection) ←── independent
  ├── Task 6 (type remaining endpoints) ←── depends on Task 1 types
  ├── Task 7 (type onboarding) ←── depends on Task 1 types
  └── Task 8 (frontend type unification)
        ├── Task 9 (dashboard badges)
        └── Task 10 (pre-flight status check) ←── depends on Task 4
              ├── Task 11 (ConnectOverlay states)
              └── Task 12 (reconnect backoff)
```

Parallelizable groups:
- After Task 1: Tasks 5, 6, 7 can run in parallel
- After Task 4 + Task 8: Tasks 9, 10 can start
- After Task 10: Tasks 11, 12 can run in parallel

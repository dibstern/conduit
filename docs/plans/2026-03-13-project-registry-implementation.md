# ProjectRegistry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace three independent data structures (`projects`, `projectRelays`, `pendingRelaySlugs`) with a single `ProjectRegistry` class using discriminated union types, eliminating the race condition that caused forever-loading screens.

**Architecture:** A `ProjectRegistry` class encapsulates all project lifecycle in a single `Map<string, ProjectEntry>` where `ProjectEntry` is a `"registering" | "ready" | "error"` discriminated union. It extends `EventEmitter<ProjectRegistryEvents>` for lifecycle notifications. The daemon consumes it via `waitForRelay()` (promise-based, no polling) and event subscriptions (auto-persist config). See `docs/plans/2026-03-13-project-registry-design.md` for full design.

**Tech Stack:** TypeScript, Vitest, fast-check (property-based testing), Node.js EventEmitter

**Approach:** TDD — write tests first, then implement to make them pass. Each task is a commit-sized unit of work.

---

### Task 1: Test Infrastructure — Mock Factories and Relay Helpers

**Files:**
- Modify: `test/helpers/mock-factories.ts`

**Step 1: Add `createMockProjectRelay` and relay factory helpers to mock-factories.ts**

Add these exports at the end of `test/helpers/mock-factories.ts`:

```typescript
import type { ProjectRelay } from "../../src/lib/relay/relay-stack.js";

// ─── ProjectRelay mock factory ──────────────────────────────────────────────

export function createMockProjectRelay(
	overrides?: Partial<ProjectRelay>,
): ProjectRelay {
	return {
		wsHandler: createMockWsHandlerFull(),
		sseConsumer: { connect: vi.fn(), disconnect: vi.fn() } as any,
		client: createMockClient(),
		sessionMgr: createMockSessionMgr(),
		translator: {} as any,
		permissionBridge: createMockPermissionBridge(),
		messageCache: createMockMessageCache(),
		isAnySessionProcessing: vi.fn().mockReturnValue(false),
		stop: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

// ─── Relay factory helpers for ProjectRegistry tests ────────────────────────

/** Factory that resolves immediately with a mock relay */
export function immediateRelayFactory(
	relay?: ProjectRelay,
): (signal: AbortSignal) => Promise<ProjectRelay> {
	return async () => relay ?? createMockProjectRelay();
}

/** Factory that resolves after `ms` milliseconds (abortable) */
export function delayedRelayFactory(
	ms: number,
	relay?: ProjectRelay,
): (signal: AbortSignal) => Promise<ProjectRelay> {
	return async (signal: AbortSignal) => {
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(resolve, ms);
			signal.addEventListener("abort", () => {
				clearTimeout(t);
				reject(new DOMException("Aborted", "AbortError"));
			});
		});
		return relay ?? createMockProjectRelay();
	};
}

/** Factory that rejects with the given error message */
export function failingRelayFactory(
	errorMsg: string,
): (signal: AbortSignal) => Promise<ProjectRelay> {
	return async () => {
		throw new Error(errorMsg);
	};
}

/** Factory controlled by a Deferred — resolves/rejects when you tell it to */
export interface DeferredRelay {
	factory: (signal: AbortSignal) => Promise<ProjectRelay>;
	resolve: (relay?: ProjectRelay) => void;
	reject: (error: Error) => void;
}

export function deferredRelayFactory(): DeferredRelay {
	let resolvePromise!: (relay: ProjectRelay) => void;
	let rejectPromise!: (error: Error) => void;

	const factory: (signal: AbortSignal) => Promise<ProjectRelay> = (signal) =>
		new Promise<ProjectRelay>((res, rej) => {
			resolvePromise = res;
			rejectPromise = rej;
			signal.addEventListener("abort", () =>
				rej(new DOMException("Aborted", "AbortError")),
			);
		});

	return {
		factory,
		resolve: (relay?: ProjectRelay) =>
			resolvePromise(relay ?? createMockProjectRelay()),
		reject: (error: Error) => rejectPromise(error),
	};
}
```

Note: `createMockWsHandlerFull`, `createMockClient`, `createMockSessionMgr`, `createMockMessageCache`, and `createMockPermissionBridge` already exist in this file as internal helpers. If any are not exported, that's fine — they're used internally by `createMockProjectRelay`.

**Step 2: Verify no syntax errors**

Run: `pnpm check`
Expected: Passes (the new code only adds exports, no consumers yet)

**Step 3: Commit**

```bash
git add test/helpers/mock-factories.ts
git commit -m "test: add ProjectRelay mock factory and relay factory helpers"
```

---

### Task 2: Create Minimal ProjectRegistry Skeleton (Types Only)

**Files:**
- Create: `src/lib/daemon/project-registry.ts`

**Step 1: Write the type definitions and minimal class skeleton**

Create `src/lib/daemon/project-registry.ts` with types and an empty class that compiles:

```typescript
// ─── Project Registry ───────────────────────────────────────────────────────
// Single source of truth for project lifecycle in the daemon. Replaces the
// three independent data structures (projects, projectRelays, pendingRelaySlugs)
// with a typed discriminated union.

import { EventEmitter } from "node:events";
import type { ProjectRelay } from "../relay/relay-stack.js";
import type { StoredProject } from "../types.js";

// ─── Discriminated union ────────────────────────────────────────────────────

export interface ProjectRegistering {
	readonly status: "registering";
	readonly project: StoredProject;
}

export interface ProjectReady {
	readonly status: "ready";
	readonly project: StoredProject;
	readonly relay: ProjectRelay;
}

export interface ProjectError {
	readonly status: "error";
	readonly project: StoredProject;
	readonly error: string;
}

export type ProjectEntry = ProjectRegistering | ProjectReady | ProjectError;

// ─── Events ─────────────────────────────────────────────────────────────────

export interface ProjectRegistryEvents {
	project_added: [slug: string, project: StoredProject];
	project_ready: [slug: string, relay: ProjectRelay];
	project_error: [slug: string, error: string];
	project_updated: [slug: string, project: StoredProject];
	project_removed: [slug: string];
}

// ─── Registry class ─────────────────────────────────────────────────────────

export class ProjectRegistry extends EventEmitter<ProjectRegistryEvents> {
	private readonly entries = new Map<string, ProjectEntry>();
	private readonly abortControllers = new Map<string, AbortController>();

	// ── Queries ──────────────────────────────────────────────────────────

	get(slug: string): ProjectEntry | undefined {
		return this.entries.get(slug);
	}

	getProject(slug: string): StoredProject | undefined {
		return this.entries.get(slug)?.project;
	}

	getRelay(slug: string): ProjectRelay | undefined {
		const entry = this.entries.get(slug);
		return entry?.status === "ready" ? entry.relay : undefined;
	}

	has(slug: string): boolean {
		return this.entries.has(slug);
	}

	isReady(slug: string): boolean {
		return this.entries.get(slug)?.status === "ready";
	}

	findByDirectory(directory: string): ProjectEntry | undefined {
		for (const entry of this.entries.values()) {
			if (entry.project.directory === directory) return entry;
		}
		return undefined;
	}

	allProjects(): StoredProject[] {
		return Array.from(this.entries.values()).map((e) => e.project);
	}

	readyEntries(): Array<[string, ProjectReady]> {
		const result: Array<[string, ProjectReady]> = [];
		for (const [slug, entry] of this.entries) {
			if (entry.status === "ready") {
				result.push([slug, entry]);
			}
		}
		return result;
	}

	slugs(): IterableIterator<string> {
		return this.entries.keys();
	}

	get size(): number {
		return this.entries.size;
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	add(
		project: StoredProject,
		createRelay: (signal: AbortSignal) => Promise<ProjectRelay>,
	): void {
		const { slug } = project;
		if (this.entries.has(slug)) {
			throw new Error(`Project "${slug}" is already registered`);
		}

		this.entries.set(slug, { status: "registering", project });
		this.emit("project_added", slug, project);

		const ac = new AbortController();
		this.abortControllers.set(slug, ac);

		createRelay(ac.signal).then(
			(relay) => {
				// If removed or replaced while creating, discard
				if (!this.abortControllers.has(slug) || ac.signal.aborted) {
					relay.stop().catch(() => {});
					return;
				}
				this.abortControllers.delete(slug);
				this.entries.set(slug, { status: "ready", project, relay });
				this.emit("project_ready", slug, relay);
			},
			(err) => {
				if (ac.signal.aborted) return; // Expected — remove() was called
				this.abortControllers.delete(slug);
				const message =
					err instanceof Error ? err.message : String(err);
				this.entries.set(slug, { status: "error", project, error: message });
				this.emit("project_error", slug, message);
			},
		);
	}

	addWithoutRelay(project: StoredProject): void {
		const { slug } = project;
		if (this.entries.has(slug)) {
			throw new Error(`Project "${slug}" is already registered`);
		}
		this.entries.set(slug, { status: "registering", project });
		this.emit("project_added", slug, project);
	}

	startRelay(
		slug: string,
		createRelay: (signal: AbortSignal) => Promise<ProjectRelay>,
	): void {
		const entry = this.entries.get(slug);
		if (!entry) {
			throw new Error(`Project "${slug}" not found`);
		}
		if (entry.status === "ready") {
			throw new Error(`Project "${slug}" already has a relay`);
		}

		// Reset to registering (from error state or existing registering)
		this.entries.set(slug, { status: "registering", project: entry.project });

		const ac = new AbortController();
		this.abortControllers.set(slug, ac);

		createRelay(ac.signal).then(
			(relay) => {
				if (!this.abortControllers.has(slug) || ac.signal.aborted) {
					relay.stop().catch(() => {});
					return;
				}
				this.abortControllers.delete(slug);
				this.entries.set(slug, {
					status: "ready",
					project: entry.project,
					relay,
				});
				this.emit("project_ready", slug, relay);
			},
			(err) => {
				if (ac.signal.aborted) return;
				this.abortControllers.delete(slug);
				const message =
					err instanceof Error ? err.message : String(err);
				this.entries.set(slug, {
					status: "error",
					project: entry.project,
					error: message,
				});
				this.emit("project_error", slug, message);
			},
		);
	}

	async remove(slug: string): Promise<void> {
		const entry = this.entries.get(slug);
		if (!entry) return;

		// Abort any in-flight relay creation
		const ac = this.abortControllers.get(slug);
		if (ac) {
			ac.abort();
			this.abortControllers.delete(slug);
		}

		// Stop relay if ready
		if (entry.status === "ready") {
			await entry.relay.stop();
		}

		this.entries.delete(slug);
		this.emit("project_removed", slug);
	}

	async replaceRelay(
		slug: string,
		createRelay: (signal: AbortSignal) => Promise<ProjectRelay>,
	): Promise<void> {
		const entry = this.entries.get(slug);
		if (!entry) {
			throw new Error(`Project "${slug}" not found`);
		}

		// Abort any in-flight creation
		const ac = this.abortControllers.get(slug);
		if (ac) {
			ac.abort();
			this.abortControllers.delete(slug);
		}

		// Stop current relay if ready
		if (entry.status === "ready") {
			await entry.relay.stop();
		}

		// Transition to registering and start new relay
		this.entries.set(slug, { status: "registering", project: entry.project });
		this.startRelay(slug, createRelay);
	}

	updateProject(
		slug: string,
		updates: Partial<Pick<StoredProject, "title" | "instanceId">>,
	): void {
		const entry = this.entries.get(slug);
		if (!entry) {
			throw new Error(`Project "${slug}" not found`);
		}

		const updatedProject = { ...entry.project, ...updates };

		// Rebuild the entry with the same status but updated project
		if (entry.status === "ready") {
			this.entries.set(slug, {
				status: "ready",
				project: updatedProject,
				relay: entry.relay,
			});
		} else if (entry.status === "error") {
			this.entries.set(slug, {
				status: "error",
				project: updatedProject,
				error: entry.error,
			});
		} else {
			this.entries.set(slug, {
				status: "registering",
				project: updatedProject,
			});
		}

		this.emit("project_updated", slug, updatedProject);
	}

	// ── WS upgrade helper ───────────────────────────────────────────────

	waitForRelay(slug: string, timeoutMs = 10_000): Promise<ProjectRelay> {
		return new Promise((resolve, reject) => {
			const entry = this.entries.get(slug);

			if (!entry) {
				reject(new Error(`Project "${slug}" not found`));
				return;
			}
			if (entry.status === "ready") {
				resolve(entry.relay);
				return;
			}
			if (entry.status === "error") {
				reject(
					new Error(
						`Project "${slug}" relay failed: ${entry.error}`,
					),
				);
				return;
			}

			// status === "registering" — wait for resolution
			const cleanup = () => {
				this.off("project_ready", onReady);
				this.off("project_error", onError);
				this.off("project_removed", onRemoved);
				clearTimeout(timer);
			};

			const onReady = (readySlug: string, relay: ProjectRelay) => {
				if (readySlug !== slug) return;
				cleanup();
				resolve(relay);
			};
			const onError = (errorSlug: string, error: string) => {
				if (errorSlug !== slug) return;
				cleanup();
				reject(
					new Error(
						`Project "${slug}" relay failed: ${error}`,
					),
				);
			};
			const onRemoved = (removedSlug: string) => {
				if (removedSlug !== slug) return;
				cleanup();
				reject(new Error(`Project "${slug}" was removed`));
			};

			this.on("project_ready", onReady);
			this.on("project_error", onError);
			this.on("project_removed", onRemoved);

			const timer = setTimeout(() => {
				cleanup();
				reject(
					new Error(
						`Timed out waiting for relay "${slug}" (${timeoutMs}ms)`,
					),
				);
			}, timeoutMs);
		});
	}

	// ── Teardown ────────────────────────────────────────────────────────

	async stopAll(): Promise<void> {
		const stops: Promise<void>[] = [];

		for (const [slug, ac] of this.abortControllers) {
			ac.abort();
			this.abortControllers.delete(slug);
		}

		for (const [slug, entry] of this.entries) {
			if (entry.status === "ready") {
				stops.push(entry.relay.stop().catch(() => {}));
			}
			this.entries.delete(slug);
		}

		await Promise.all(stops);
	}
}
```

**Step 2: Verify it compiles**

Run: `pnpm check`
Expected: Passes (no consumers yet, just type-checking the new file)

**Step 3: Commit**

```bash
git add src/lib/daemon/project-registry.ts
git commit -m "feat: add ProjectRegistry class with discriminated union types"
```

---

### Task 3: Layer 1 Tests — Lifecycle, Queries, waitForRelay, Concurrency

**Files:**
- Create: `test/unit/daemon/project-registry.test.ts`

**Step 1: Write comprehensive Layer 1 tests**

Create `test/unit/daemon/project-registry.test.ts`. This is a large test file covering all the categories from the design doc's testing strategy. Group tests by category using nested `describe` blocks.

Key test categories and what they verify:

**Lifecycle basics:**
- `add()` sets status to `"registering"`, emits `project_added`
- Relay factory resolves → status `"ready"`, emits `project_ready`
- Relay factory rejects → status `"error"`, emits `project_error`
- `remove()` on ready project calls `relay.stop()`, emits `project_removed`
- `remove()` on registering project aborts factory, discards result
- `updateProject()` updates project fields, emits `project_updated`
- `addWithoutRelay()` sets status to `"registering"` with no factory
- `startRelay()` on `"registering"` entry starts relay creation
- `startRelay()` on `"error"` entry retries, can become `"ready"`
- `replaceRelay()` stops old relay, transitions through `"registering"` to `"ready"`

**Queries:**
- `getRelay()` returns relay only for `"ready"` entries, `undefined` otherwise
- `getProject()` returns project regardless of status
- `allProjects()` returns all projects, `readyEntries()` returns only ready
- `findByDirectory()` finds entry by path
- `has()` and `isReady()` reflect current state
- `size` getter is accurate
- `slugs()` returns all registered slugs

**waitForRelay:**
- Already ready → resolves immediately
- Registering → resolves when factory completes
- Error → rejects immediately with error message
- Non-existent slug → rejects immediately
- Timeout while registering → rejects with timeout error, cleans up listeners
- Project removed while waiting → rejects
- Multiple concurrent waiters all resolve when relay becomes ready

**Concurrency:**
- `add()` for existing slug throws
- `remove()` during registering, factory resolves after → relay stopped and discarded
- `replaceRelay()` aborts old factory, starts new

**Edge cases:**
- `stopAll()` stops all ready relays, aborts all registering, empties map
- `remove()` on non-existent slug is a no-op (no throw)
- `add()` then immediate `remove()` before factory resolves

All tests use the factory helpers from Task 1: `immediateRelayFactory`, `delayedRelayFactory`, `failingRelayFactory`, `deferredRelayFactory`. Use `vi.fn()` for event listeners to assert emission.

Import pattern:

```typescript
import { describe, expect, it, vi } from "vitest";
import type { StoredProject } from "../../../src/lib/types.js";
import {
	ProjectRegistry,
	type ProjectEntry,
} from "../../../src/lib/daemon/project-registry.js";
import {
	createMockProjectRelay,
	deferredRelayFactory,
	delayedRelayFactory,
	failingRelayFactory,
	immediateRelayFactory,
} from "../../helpers/mock-factories.js";
```

Helper for creating test projects:

```typescript
function makeProject(slug: string, dir?: string): StoredProject {
	return {
		slug,
		directory: dir ?? `/test/${slug}`,
		title: slug,
		lastUsed: Date.now(),
	};
}
```

**Step 2: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/daemon/project-registry.test.ts`
Expected: ALL PASS (because the implementation was written in Task 2 — this is technically not pure TDD since we wrote types+impl together, but the registry was designed first and tests validate the design)

Note: If any tests fail, this reveals bugs in the implementation from Task 2. Fix the implementation to match the design, not the other way around.

**Step 3: Commit**

```bash
git add test/unit/daemon/project-registry.test.ts
git commit -m "test: add comprehensive Layer 1 unit tests for ProjectRegistry"
```

---

### Task 4: Layer 2-3 Tests — Property-Based and Stateful Model

**Files:**
- Modify: `test/unit/daemon/project-registry.test.ts` (append to existing file)

**Step 1: Check fast-check is available**

Run: `pnpm list fast-check`
Expected: Shows fast-check in devDependencies. If not found, run `pnpm add -D fast-check`.

The existing `daemon.test.ts` already uses fast-check, so it should be installed.

**Step 2: Add property-based tests (Layer 2)**

Append a new `describe("property-based invariants")` block to the test file. Use `fc.asyncProperty` with random sequences of operations:

Operations: `add`, `remove`, `updateProject`, `addWithoutRelay`, `startRelay`

Invariants to assert after every operation sequence:
1. Every entry with status `"ready"` has a relay accessible via `getRelay(slug)`
2. Every entry with status `"registering"` or `"error"` returns `undefined` from `getRelay(slug)`
3. `registry.size` equals `allProjects().length`
4. `readyEntries().length <= size`
5. No slug appears twice in `allProjects()`
6. After `stopAll()`, `size === 0`

Use `immediateRelayFactory()` for adds (so ready state is reached within the operation) to keep the property tests synchronous-ish. Use `fc.scheduler()` if needed for async coordination.

**Step 3: Add stateful model test (Layer 3)**

Append a `describe("stateful model")` block. Define a simple model:

```typescript
type ModelEntry = { slug: string; directory: string; status: "registering" | "ready" | "error" };
type Model = Map<string, ModelEntry>;
```

Define `fc.commands` that operate on both the model and the real registry:
- `AddCommand`: adds to both, asserts consistency
- `RemoveCommand`: removes from both
- `UpdateCommand`: updates title in both
- `CheckCommand`: asserts model matches registry state

Run model-based test with `fc.asyncModelRun`.

**Step 4: Run all property-based tests**

Run: `pnpm vitest run test/unit/daemon/project-registry.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add test/unit/daemon/project-registry.test.ts
git commit -m "test: add property-based and stateful model tests for ProjectRegistry"
```

---

### Task 5: Update types.ts — Add `signal` to ProjectRelayConfig

**Files:**
- Modify: `src/lib/types.ts` (line ~172, `ProjectRelayConfig` interface)

**Step 1: Add `signal?: AbortSignal` to ProjectRelayConfig**

In `src/lib/types.ts`, add `signal?: AbortSignal` to the `ProjectRelayConfig` interface, after the `configDir` field:

```typescript
// Add to ProjectRelayConfig:
/** Abort signal for cancelling relay creation mid-flight */
signal?: AbortSignal;
```

**Step 2: Verify it compiles**

Run: `pnpm check`
Expected: Passes (adding an optional field is backward-compatible)

**Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add signal?: AbortSignal to ProjectRelayConfig"
```

---

### Task 6: Add AbortSignal Checks in relay-stack.ts

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` (function `createProjectRelay`, lines 135-736)

**Step 1: Add signal abort checks at await boundaries**

In `createProjectRelay()`, add abort checks before the expensive async operations. The function has 4 `await` boundaries:

1. Before `await client.getHealth()` (~line 237):
```typescript
if (config.signal?.aborted) throw new Error("Relay creation aborted");
```

2. Before `await client.getConfig()` (~line 245):
```typescript
if (config.signal?.aborted) throw new Error("Relay creation aborted");
```

3. Before `await sessionMgr.initialize()` (~line 271):
```typescript
if (config.signal?.aborted) throw new Error("Relay creation aborted");
```

4. Before `await sseConsumer.connect()` (~line 484):
```typescript
if (config.signal?.aborted) throw new Error("Relay creation aborted");
```

**Step 2: Verify it compiles**

Run: `pnpm check`
Expected: Passes

**Step 3: Run existing relay tests to check nothing breaks**

Run: `pnpm vitest run test/unit/relay/`
Expected: ALL PASS (abort checks are only triggered when signal is aborted; no existing tests pass signals)

**Step 4: Commit**

```bash
git add src/lib/relay/relay-stack.ts
git commit -m "feat: check AbortSignal at await boundaries in createProjectRelay"
```

---

### Task 7: Update RouterProject in http-router.ts

**Files:**
- Modify: `src/lib/server/http-router.ts` (line ~42, `RouterProject` interface)

**Step 1: Add `status` field to RouterProject**

Add `status` as an optional field (for backward compatibility with standalone server mode):

```typescript
export interface RouterProject {
	slug: string;
	directory: string;
	title: string;
	status?: "registering" | "ready" | "error";
	clients?: number;
	sessions?: number;
	isProcessing?: boolean;
}
```

**Step 2: Verify it compiles**

Run: `pnpm check`
Expected: Passes

**Step 3: Commit**

```bash
git add src/lib/server/http-router.ts
git commit -m "feat: add status field to RouterProject interface"
```

---

### Task 8: Integrate ProjectRegistry into Daemon — Field Replacement

**Files:**
- Modify: `src/lib/daemon/daemon.ts`

This is the largest task. It replaces the three fields with a single registry instance and rewires all internal access patterns. Changes are listed by section of daemon.ts.

**Step 1: Update imports**

Replace:
```typescript
import {
	addProject as addProjectImpl,
	type DaemonProjectContext,
	discoverProjects as discoverProjectsImpl,
	getProjectOpencodeUrl as getProjectOpencodeUrlImpl,
	getProjects as getProjectsImpl,
	removeProject as removeProjectImpl,
	setProjectInstance as setProjectInstanceImpl,
	startProjectRelay as startProjectRelayImpl,
} from "./daemon-projects.js";
```

With:
```typescript
import { ProjectRegistry } from "./project-registry.js";
import { generateSlug } from "../utils.js";
import { syncRecentProjects } from "./config-persistence.js";
```

Also add:
```typescript
import { formatErrorDetail } from "../errors.js";
```
(if not already imported — it is, at line 25)

**Step 2: Replace the three fields**

Replace:
```typescript
private projects: Map<string, StoredProject> = new Map();
// ...
private projectRelays: Map<string, ProjectRelay> = new Map();
private pendingRelaySlugs = new Set<string>();
```

With:
```typescript
readonly registry = new ProjectRegistry();
```

Make it `readonly` so the reference can't be reassigned, and non-private so tests and IPC can access it. The `ProjectRegistry` class controls mutation.

**Step 3: Update constructor — instanceManager status_changed handler (lines ~285-293)**

Replace:
```typescript
this.instanceManager.on("status_changed", (instance: OpenCodeInstance) => {
	for (const relay of this.projectRelays.values()) {
		relay.wsHandler.broadcast({
			type: "instance_status",
			instanceId: instance.id,
			status: instance.status,
		});
	}
});
```

With:
```typescript
this.instanceManager.on("status_changed", (instance: OpenCodeInstance) => {
	for (const [, entry] of this.registry.readyEntries()) {
		entry.relay.wsHandler.broadcast({
			type: "instance_status",
			instanceId: instance.id,
			status: instance.status,
		});
	}
});
```

**Step 4: Update start() — router getProjects closure (lines ~525-539)**

Replace:
```typescript
getProjects: () =>
	this.getProjects().map((p) => {
		const relay = this.projectRelays.get(p.slug);
		return {
			slug: p.slug,
			directory: p.directory,
			title: p.title,
			clients: relay?.wsHandler.getClientCount() ?? 0,
			sessions: relay?.messageCache.sessionCount() ?? 0,
			isProcessing: relay?.isAnySessionProcessing() ?? false,
		};
	}),
```

With:
```typescript
getProjects: () => {
	const result: import("../server/http-router.js").RouterProject[] = [];
	for (const slug of this.registry.slugs()) {
		const entry = this.registry.get(slug)!;
		const relay = entry.status === "ready" ? entry.relay : undefined;
		result.push({
			slug: entry.project.slug,
			directory: entry.project.directory,
			title: entry.project.title,
			status: entry.status,
			clients: relay?.wsHandler.getClientCount() ?? 0,
			sessions: relay?.messageCache.sessionCount() ?? 0,
			isProcessing: relay?.isAnySessionProcessing() ?? false,
		});
	}
	return result;
},
```

**Step 5: Update start() — WS upgrade handler (lines ~558-608)**

Replace the entire `this.httpServer!.on("upgrade", ...)` handler:

```typescript
this.httpServer!.on("upgrade", async (req, socket, head) => {
	const match = req.url?.match(/^\/p\/([^/]+)\/ws(?:\?|$)/);
	if (!match) {
		this.log.debug(
			{ url: req.url },
			"WS upgrade rejected: URL does not match /p/{slug}/ws",
		);
		socket.destroy();
		return;
	}
	const slug = match[1]!;

	// Auth gate
	if (this.auth.hasPin() && !this.router!.checkAuth(req)) {
		this.log.warn({ slug }, "WS upgrade rejected: auth failed");
		socket.destroy();
		return;
	}

	try {
		const relay = await this.registry.waitForRelay(slug, 10_000);
		if (socket.destroyed) return;
		this.log.debug({ slug }, "WS upgrade accepted");
		relay.wsHandler.handleUpgrade(req, socket, head);
	} catch (err) {
		this.log.warn(
			{ slug, error: formatErrorDetail(err) },
			"WS upgrade rejected: relay not available",
		);
		socket.destroy();
	}
});
```

**Step 6: Update start() — rehydration loop (lines ~420-435 for projects rehydration)**

Replace:
```typescript
if (savedConfig?.projects) {
	for (const proj of savedConfig.projects) {
		if (!proj.path || !proj.slug) continue;
		if (this.projects.has(proj.slug)) continue;
		this.projects.set(proj.slug, {
			slug: proj.slug,
			directory: proj.path,
			title: proj.title ?? proj.slug,
			lastUsed: proj.addedAt ?? Date.now(),
			...(proj.instanceId != null && { instanceId: proj.instanceId }),
		});
	}
	if (this.projects.size > 0) {
		this.log.info(
			`Rehydrated ${this.projects.size} project(s) from saved config`,
		);
	}
}
```

With:
```typescript
if (savedConfig?.projects) {
	for (const proj of savedConfig.projects) {
		if (!proj.path || !proj.slug) continue;
		if (this.registry.has(proj.slug)) continue;
		const project: StoredProject = {
			slug: proj.slug,
			directory: proj.path,
			title: proj.title ?? proj.slug,
			lastUsed: proj.addedAt ?? Date.now(),
			...(proj.instanceId != null && { instanceId: proj.instanceId }),
		};
		this.registry.addWithoutRelay(project);
	}
	if (this.registry.size > 0) {
		this.log.info(
			`Rehydrated ${this.registry.size} project(s) from saved config`,
		);
	}
}
```

**Step 7: Update start() — relay startup for rehydrated projects (lines ~620-638)**

Replace:
```typescript
for (const project of this.projects.values()) {
	if (this.projectRelays.has(project.slug)) continue;
	const opencodeUrl = getProjectOpencodeUrlImpl(
		this.asProjectContext(),
		project.instanceId,
	);
	if (opencodeUrl) {
		await startProjectRelayImpl(
			this.asProjectContext(),
			project,
			opencodeUrl,
		);
	}
}
```

With:
```typescript
for (const slug of this.registry.slugs()) {
	const entry = this.registry.get(slug)!;
	if (entry.status === "ready") continue;
	const opencodeUrl = this.resolveOpencodeUrl(entry.project.instanceId);
	if (opencodeUrl) {
		this.registry.startRelay(slug, this.buildRelayFactory(entry.project, opencodeUrl));
	}
}
```

**Step 8: Update start() — versionChecker broadcast (lines ~655-670)**

Replace:
```typescript
for (const relay of this.projectRelays.values()) {
	relay.wsHandler.broadcast({
		type: "update_available",
		version: latest,
	});
}
```

With:
```typescript
for (const [, entry] of this.registry.readyEntries()) {
	entry.relay.wsHandler.broadcast({
		type: "update_available",
		version: latest,
	});
}
```

**Step 9: Update start() — storageMonitor eviction loop and scanner broadcast**

Replace all `for (const relay of this.projectRelays.values())` loops in the storageMonitor and scanner event handlers with:
```typescript
for (const [, entry] of this.registry.readyEntries()) {
	// ... use entry.relay instead of relay
}
```

**Step 10: Add event subscriptions for auto-config persistence**

After creating the registry (at the end of the constructor or early in `start()`), add:

```typescript
// Persist config on project mutations
this.registry.on("project_added", () => this.persistConfig());
this.registry.on("project_ready", () => this.persistConfig());
this.registry.on("project_updated", () => this.persistConfig());
this.registry.on("project_removed", () => this.persistConfig());
```

Where `persistConfig()` is a new private method:

```typescript
private persistConfig(): void {
	saveDaemonConfig(this.buildConfig(), this.configDir);
}
```

**Step 11: Update stop() method (lines ~809-822)**

Replace:
```typescript
for (const relay of this.projectRelays.values()) {
	try {
		await relay.stop();
	} catch (err) {
		this.log.warn(`Error stopping relay during shutdown: ${err}`);
	}
}
this.projectRelays.clear();
// ...
this.projects.clear();
```

With:
```typescript
await this.registry.stopAll();
```

**Step 12: Add new daemon methods — addProject, removeProject, setProjectInstance, etc.**

Replace the delegating methods:

```typescript
async addProject(
	directory: string,
	slug?: string,
	instanceId?: string,
): Promise<StoredProject> {
	// Expand ~ to home directory
	const { homedir } = await import("node:os");
	const { resolve } = await import("node:path");
	if (directory.startsWith("~/") || directory === "~") {
		directory = directory.replace("~", homedir());
	}
	directory = resolve(directory);

	// Dedup by directory
	const existing = this.registry.findByDirectory(directory);
	if (existing) return existing.project;

	const existingSlugs = new Set(this.registry.slugs());
	const resolvedSlug = slug ?? generateSlug(directory, existingSlugs);
	const parts = directory.replace(/\\/g, "/").split("/").filter(Boolean);
	const title = parts[parts.length - 1] ?? "project";

	const resolvedInstanceId =
		instanceId ??
		this.instanceManager.getInstances().find((i) => i.status === "healthy")?.id ??
		this.instanceManager.getInstances()[0]?.id;

	const project: StoredProject = {
		slug: resolvedSlug,
		directory,
		title,
		lastUsed: Date.now(),
		...(resolvedInstanceId != null && { instanceId: resolvedInstanceId }),
	};

	const opencodeUrl = this.resolveOpencodeUrl(project.instanceId);
	if (opencodeUrl) {
		this.registry.add(project, this.buildRelayFactory(project, opencodeUrl));
	} else {
		this.registry.addWithoutRelay(project);
	}

	// Sync recent projects
	syncRecentProjects(
		this.registry.allProjects().map((p) => ({
			path: p.directory,
			slug: p.slug,
			title: p.title,
		})),
		this.configDir,
	);

	return project;
}

async removeProject(slug: string): Promise<void> {
	if (!this.registry.has(slug)) {
		throw new Error(`Project "${slug}" not found`);
	}
	await this.registry.remove(slug);

	syncRecentProjects(
		this.registry.allProjects().map((p) => ({
			path: p.directory,
			slug: p.slug,
			title: p.title,
		})),
		this.configDir,
	);
}

getProjects(): StoredProject[] {
	return this.registry.allProjects();
}

async setProjectInstance(slug: string, instanceId: string): Promise<void> {
	this.registry.updateProject(slug, { instanceId });
	const opencodeUrl = this.resolveOpencodeUrl(instanceId);
	if (opencodeUrl) {
		await this.registry.replaceRelay(slug, this.buildRelayFactory(
			this.registry.getProject(slug)!,
			opencodeUrl,
		));
	}
}

private resolveOpencodeUrl(instanceId?: string): string | null {
	if (!instanceId) {
		const instances = this.instanceManager.getInstances();
		if (instances.length === 0) return null;
		try {
			return this.instanceManager.getInstanceUrl(instances[0]!.id);
		} catch {
			return null;
		}
	}
	try {
		return this.instanceManager.getInstanceUrl(instanceId);
	} catch {
		return null;
	}
}

async discoverProjects(): Promise<void> {
	const discoveryUrl = this.resolveOpencodeUrl();
	if (!discoveryUrl) return;

	const discoveryLog = createLogger("relay").child("discovery");
	try {
		const { OpenCodeClient } = await import("../instance/opencode-client.js");
		const client = new OpenCodeClient({ baseUrl: discoveryUrl });
		const projects = await client.listProjects();

		let added = 0;
		for (const p of projects) {
			const dir = p.worktree ?? p.path;
			if (dir && dir !== "/") {
				try {
					await this.addProject(dir);
					added++;
				} catch {
					// Non-fatal
				}
			}
		}
		discoveryLog.info(
			`Discovered ${projects.length} project(s) from OpenCode, registered ${added}`,
		);
	} catch (err) {
		discoveryLog.warn(
			"Failed to discover projects from OpenCode:",
			formatErrorDetail(err),
		);
	}
}
```

**Step 13: Add buildRelayFactory method**

```typescript
private buildRelayFactory(
	project: StoredProject,
	opencodeUrl: string,
): (signal: AbortSignal) => Promise<ProjectRelay> {
	return async (signal: AbortSignal) => {
		const { createProjectRelay } = await import("../relay/relay-stack.js");
		return createProjectRelay({
			httpServer: this.httpServer!,
			opencodeUrl,
			projectDir: project.directory,
			slug: project.slug,
			noServer: true,
			signal,
			log: createLogger("relay"),
			getProjects: () =>
				this.registry.allProjects().map((p) => ({
					slug: p.slug,
					title: p.title,
					directory: p.directory,
					...(p.instanceId != null && { instanceId: p.instanceId }),
				})),
			addProject: async (dir: string) => {
				const p = await this.addProject(dir);
				return {
					slug: p.slug,
					title: p.title,
					directory: p.directory,
					...(p.instanceId != null && { instanceId: p.instanceId }),
				};
			},
			getInstances: () => this.getInstances(),
			addInstance: (id, config) =>
				this.instanceManager.addInstance(id, config),
			removeInstance: (id) => this.instanceManager.removeInstance(id),
			startInstance: (id) => this.instanceManager.startInstance(id),
			stopInstance: (id) => this.instanceManager.stopInstance(id),
			updateInstance: (id, updates) =>
				this.instanceManager.updateInstance(id, updates),
			persistConfig: () => this.persistConfig(),
			...(this.scanner != null && {
				triggerScan: () => this.scanner!.scan(),
			}),
			setProjectInstance: (slug, instanceId) =>
				this.setProjectInstance(slug, instanceId),
			...(this.pushManager != null && {
				pushManager: this.pushManager,
			}),
			configDir: this.configDir,
		});
	};
}
```

**Step 14: Delete asProjectContext()**

Remove the `asProjectContext()` method entirely — it's no longer needed.

**Step 15: Update getStatus()**

Replace `projectCount: this.projects.size` with `projectCount: this.registry.size`.

Replace `projects: this.getProjects().map(...)` — this already uses `getProjects()` which now delegates to `this.registry.allProjects()`, so no change needed there.

**Step 16: Update buildConfig()**

Replace `projects: this.getProjects().map(...)` — same as above, `getProjects()` now uses the registry. No change needed.

**Step 17: Update startIPCServer() context**

Replace:
```typescript
getProjectBySlug: (slug) => this.projects.get(slug),
setProjectTitle: (slug, title) => {
	const project = this.projects.get(slug);
	if (project) project.title = title;
},
```

With:
```typescript
getProjectBySlug: (slug) => this.registry.getProject(slug),
setProjectTitle: (slug, title) => {
	if (this.registry.has(slug)) {
		this.registry.updateProject(slug, { title });
	}
},
```

**Step 18: Verify it compiles**

Run: `pnpm check`
Expected: May have errors — fix until it passes.

**Step 19: Run all tests**

Run: `pnpm vitest run`
Expected: Fix any failures. Existing tests that reference `daemon.projects` or `daemon.projectRelays` will fail — those are updated in Task 9.

**Step 20: Commit**

```bash
git add src/lib/daemon/daemon.ts
git commit -m "feat: integrate ProjectRegistry into Daemon class, replace 3 data structures"
```

---

### Task 9: Delete daemon-projects.ts and Update Tests

**Files:**
- Delete: `src/lib/daemon/daemon-projects.ts`
- Delete: `test/unit/daemon/daemon-projects-wiring.test.ts`
- Modify: `test/unit/daemon/daemon.test.ts`

**Step 1: Delete daemon-projects.ts**

```bash
rm src/lib/daemon/daemon-projects.ts
```

All its functionality has been absorbed into `ProjectRegistry` and daemon methods.

**Step 2: Delete daemon-projects-wiring.test.ts**

```bash
rm test/unit/daemon/daemon-projects-wiring.test.ts
```

Its relay-config-wiring tests are replaced by the ProjectRegistry tests (Task 3) and will be supplemented by daemon integration tests.

**Step 3: Update daemon.test.ts**

The test file has ~2900 lines. Most tests should still work because they use `daemon.addProject()`, `daemon.removeProject()`, `daemon.getProjects()`, and `daemon.getStatus()` — all public methods that still exist. Changes needed:

1. **Remove any `vi.mock` for `daemon-projects.js`** — this module no longer exists.

2. **Fix tests that directly access `daemon.projects`** — search for `(daemon as any).projects` or similar patterns. Replace with `daemon.registry.getProject(slug)` or `daemon.registry.size`.

3. **Fix tests that access `daemon.projectRelays`** — replace with `daemon.registry.getRelay(slug)` or `daemon.registry.readyEntries()`.

4. **Fix tests that access `daemon.pendingRelaySlugs`** — no replacement needed; the registry handles this internally.

5. **Fix `projectCount` assertions in getStatus tests** — these should still work since `getStatus()` now uses `this.registry.size`.

Search patterns to find what needs updating:
```bash
grep -n "projectRelays\|pendingRelaySlugs\|daemon-projects\|asProjectContext\|DaemonProjectContext" test/unit/daemon/daemon.test.ts
```

**Step 4: Verify everything compiles and tests pass**

Run: `pnpm check && pnpm vitest run test/unit/daemon/`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete daemon-projects.ts, update daemon tests for registry API"
```

---

### Task 10: Opportunistic EventEmitter Cleanup

**Files:**
- Modify: `src/lib/daemon/port-scanner.ts`
- Modify: `src/lib/daemon/storage-monitor.ts`
- Modify: `src/lib/daemon/version-check.ts`
- Modify: `src/lib/daemon/keep-awake.ts`
- Modify: `src/lib/instance/instance-manager.ts`

**Step 1: PortScanner — define events interface, wire to generic**

Add events interface:
```typescript
export interface PortScannerEvents {
	scan: [result: ScanResult];
}
```

Change class declaration:
```typescript
export class PortScanner extends EventEmitter<PortScannerEvents> {
```

**Step 2: StorageMonitor — wire existing interface**

Change class declaration:
```typescript
interface StorageMonitorEvents {
	low_disk_space: [event: LowDiskSpaceEvent];
	disk_space_ok: [event: DiskSpaceOkEvent];
}

export class StorageMonitor extends EventEmitter<StorageMonitorEvents> {
```

**Step 3: VersionChecker — wire existing interface**

Change class declaration:
```typescript
export class VersionChecker extends EventEmitter<VersionCheckEvents> {
```

Remove the `satisfies` annotations on `emit` calls if they conflict.

**Step 4: KeepAwake — wire existing interface**

Change class declaration:
```typescript
export class KeepAwake extends EventEmitter<KeepAwakeEvents> {
```

**Step 5: InstanceManager — switch to generic, delete manual overloads**

Change class declaration:
```typescript
export class InstanceManager extends EventEmitter<InstanceManagerEvents> {
```

Delete the `override emit` and `override on` method overloads (lines 53-65).

**Step 6: Verify**

Run: `pnpm check && pnpm vitest run`
Expected: ALL PASS. The generic EventEmitter enforces the same types the manual overloads did.

**Step 7: Commit**

```bash
git add src/lib/daemon/port-scanner.ts src/lib/daemon/storage-monitor.ts src/lib/daemon/version-check.ts src/lib/daemon/keep-awake.ts src/lib/instance/instance-manager.ts
git commit -m "refactor: wire typed EventEmitter<T> generics for 5 daemon subsystems"
```

---

### Task 11: Final Verification

**Step 1: Run full verification suite**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

Expected: ALL PASS

**Step 2: Check for any remaining references to old APIs**

```bash
grep -rn "projectRelays\|pendingRelaySlugs\|DaemonProjectContext\|asProjectContext\|daemon-projects" src/ test/ --include="*.ts" | grep -v "node_modules" | grep -v ".d.ts"
```

Expected: No matches (all old references cleaned up)

**Step 3: Verify no leaked imports**

```bash
grep -rn "from.*daemon-projects" src/ test/ --include="*.ts"
```

Expected: No matches

**Step 4: Commit any final fixups**

If any fixes were needed, commit them:
```bash
git add -A
git commit -m "chore: final cleanup of old project management APIs"
```

---

## Execution Order Summary

| Task | Description | Depends On |
|------|-------------|------------|
| 1 | Test infrastructure (mock factories) | — |
| 2 | ProjectRegistry class (types + implementation) | — |
| 3 | Layer 1 unit tests | 1, 2 |
| 4 | Layer 2-3 property-based + model tests | 3 |
| 5 | Update types.ts (AbortSignal) | — |
| 6 | AbortSignal checks in relay-stack.ts | 5 |
| 7 | Update RouterProject (status field) | — |
| 8 | Daemon integration | 2, 5, 6, 7 |
| 9 | Delete old files, update tests | 8 |
| 10 | EventEmitter cleanup | — |
| 11 | Final verification | All |

Tasks 1-2, 5, 7, 10 are independent and can be done in parallel.
Tasks 3-4 depend on 1-2.
Task 8 depends on 2, 5, 6, 7.
Task 9 depends on 8.
Task 11 depends on all.

---

## Post-Audit Amendments

### A. Interactions Left Out

**A1. `setProjectTitle` IPC handler bypasses registry (CRITICAL)**

The handler in `daemon-ipc.ts` (lines 141-149) does NOT call `ctx.setProjectTitle()`. Instead it calls `ctx.getProjectBySlug(slug)` to get a reference, then directly mutates `project.title = title`, then calls `saveDaemonConfig()` explicitly. The `ctx.setProjectTitle` method on `DaemonIPCContext` is **dead code** — defined on the interface (line 29) but never invoked.

After the plan's changes:
- `ctx.getProjectBySlug(slug)` returns `registry.getProject(slug)` — a reference to the `StoredProject` inside the registry entry
- Direct mutation `project.title = title` works by reference but **bypasses** `registry.updateProject()`, so `project_updated` is never emitted
- The explicit `saveDaemonConfig` on line 148 still saves correctly
- Net: works but loses event-driven consistency

**Fix:** Modify the `setProjectTitle` IPC handler in `daemon-ipc.ts` to delegate to `ctx.setProjectTitle(slug, title)` instead of doing direct mutation. Then remove the explicit `saveDaemonConfig` from the handler (the event subscription handles it):

```typescript
// daemon-ipc.ts handler — BEFORE:
const project = ctx.getProjectBySlug(slug);
if (!project) return { ok: false, error: ... };
project.title = title;
saveDaemonConfig(ctx.buildConfig(), ctx.configDir);

// AFTER:
ctx.setProjectTitle(slug, title);
```

This also means `daemon-ipc.ts` must be added to Task 8's modified files list. The explicit `saveDaemonConfig` call on line 148 should be removed (event-driven persistence handles it). Otherwise there will be a double-save (benign but wasteful).

**A2. `stop()` must explicitly save config BEFORE clearing the registry**

Current `stop()` at daemon.ts line 806 calls `saveDaemonConfig(this.buildConfig(), this.configDir)` BEFORE stopping relays. This is the "Fix #11" behavior — config persists through restarts. The plan replaces relay cleanup with `registry.stopAll()` but doesn't mention keeping this explicit save.

`stopAll()` correctly does NOT emit `project_removed` events (otherwise event-based auto-persist would save an empty config, breaking Fix #11). But the explicit `saveDaemonConfig` before `stopAll()` must be preserved:

```typescript
async stop(): Promise<void> {
  // ...
  saveDaemonConfig(this.buildConfig(), this.configDir); // KEEP THIS
  await this.registry.stopAll();
  // ...
}
```

Two existing tests verify this: "stop() preserves daemon.json with instance data (Fix #11)" (line 1396) and "stop() preserves project list in daemon.json (Fix #11)" (line 1411).

**A3. `storageMonitor` low_disk_space handler iterates relays for cache eviction**

daemon.ts lines 685-693 iterate `this.projectRelays.values()` calling `relay.messageCache.evictOldestSession()`. The plan mentions updating broadcast loops but doesn't list this cache-eviction loop as a change site.

Replace:
```typescript
for (const relay of this.projectRelays.values()) {
```
With:
```typescript
for (const [, entry] of this.registry.readyEntries()) {
  // use entry.relay.messageCache.evictOldestSession()
}
```

**A4. WS upgrade handler needs `shuttingDown` check**

Current handler checks `if (socket.destroyed) return;` and `if (this.shuttingDown)` inside `tryUpgrade` (line 586). The plan's new async handler using `waitForRelay` doesn't check `shuttingDown`. Add this check after the `await`:

```typescript
try {
  const relay = await this.registry.waitForRelay(slug, 10_000);
  if (socket.destroyed || this.shuttingDown) return;  // <-- add shuttingDown check
  relay.wsHandler.handleUpgrade(req, socket, head);
}
```

**A5. Event subscriptions must be wired before project rehydration**

The plan says "at the end of the constructor or early in start()." Project rehydration (loading from daemon.json) happens in `start()` before relay startup. `addWithoutRelay()` emits `project_added`. If event subscriptions aren't wired yet, the first `persistConfig()` won't fire for rehydrated projects. Wire subscriptions at the very start of `start()`, before rehydration.

Note: This is actually OK for rehydrated projects — we DON'T want to re-save config during rehydration (it was just loaded). The explicit `saveDaemonConfig(this.buildConfig(), this.configDir)` at line 649 (end of startup) handles the initial save. But to avoid a redundant N saves during rehydration of N projects, consider wiring subscriptions AFTER rehydration but BEFORE the first user-initiated `addProject`.

Best approach: wire subscriptions AFTER the rehydration loop but BEFORE relay startup and `discoverProjects()`.

**A6. `daemon.test.ts` needs NO internal-access fixes**

The audit confirmed zero `(daemon as any).projects`, `.projectRelays`, or `.pendingRelaySlugs` accesses in `daemon.test.ts`. All 2903 lines use only public API methods. No `vi.mock` calls exist for `daemon-projects.js`. Task 9 Step 3's search-and-fix work reduces to "verify tests pass" — no code changes needed in this file.

### B. Missing Wiring

**B1. `daemon-ipc.ts` must be modified (not just the context closures)**

The plan (Task 8) modifies the IPC context closures in `daemon.ts` but does NOT modify `daemon-ipc.ts` itself. The `setProjectTitle` handler's direct mutation pattern (Finding A1) requires changing the handler code:

Add to Task 8 file list:
- Modify: `src/lib/daemon/daemon-ipc.ts` (lines 141-149: `setProjectTitle` handler)

Changes:
1. Replace direct mutation with `ctx.setProjectTitle(slug, title)` delegation
2. Remove explicit `saveDaemonConfig` call (event-driven)
3. Also remove the unused `ctx.getProjectBySlug(slug)` call from this handler

**B2. HTTP router must serve projects regardless of status**

Tests create daemons without `opencodeUrl`, so `addProject` → `addWithoutRelay` → status "registering" forever. The router's `getProjects()` returns ALL entries including "registering" ones. The router matches projects by slug in `projects.find((p) => p.slug === slug)`. Adding `status` to `RouterProject` doesn't affect matching — the router doesn't filter by status. Verified: no code changes needed, but document this invariant.

**B3. `DaemonIPCContext.setProjectTitle` is dead code that the plan revives**

The interface defines `setProjectTitle(slug: string, title: string): void` (line 29) but no handler calls it. The plan rewires the closure (Task 8 Step 17). Finding B1 fixes the handler to actually call it. These must be done together.

**B4. `persistConfig` callback wired through relay factory is correct**

The plan's `buildRelayFactory` (Task 8 Step 13) passes `persistConfig: () => this.persistConfig()`. This is used by browser-side WS handlers (instance CRUD in `handlers/instance.ts` — 4 call sites at lines 80, 107, 197, 228). Verified: the wiring is correct and matches the existing behavior.

### C. Debugging Improvements

**C1. Add `status` to `/api/projects` and `getStatus()` responses**

Currently the `/api/projects` endpoint (http-router.ts line 267) returns `slug`, `path`, `title`, `sessions`, `clients`, `isProcessing` — with no relay status. And `getStatus()` returns `projectCount` and per-project `slug`/`directory`/`title` with no status.

Add `status: "registering" | "ready" | "error"` to both:
- `RouterProject` (already in Task 7)
- `DaemonStatus.projects[*]` (need to add `status` field to the status response)

This lets the dashboard and curl debugging show which projects have working relays.

**C2. Log project state transitions**

Subscribe to registry events and log transitions:

```typescript
this.registry.on("project_added", (slug) =>
  this.log.info({ slug }, "Project registered (relay starting)"));
this.registry.on("project_ready", (slug) =>
  this.log.info({ slug }, "Project relay ready"));
this.registry.on("project_error", (slug, error) =>
  this.log.warn({ slug, error }, "Project relay failed"));
this.registry.on("project_removed", (slug) =>
  this.log.info({ slug }, "Project removed"));
```

This replaces the current silent state transitions and makes the daemon log show the full lifecycle.

**C3. Log `waitForRelay` timing in WS upgrade handler**

When a WS upgrade enters the wait path and when it resolves, log with timing:

```typescript
const start = Date.now();
this.log.debug({ slug }, "WS upgrade waiting for relay");
try {
  const relay = await this.registry.waitForRelay(slug, 10_000);
  const elapsed = Date.now() - start;
  if (elapsed > 100) {
    this.log.info({ slug, elapsed }, "WS upgrade accepted after wait");
  } else {
    this.log.debug({ slug }, "WS upgrade accepted");
  }
}
```

This replaces the opaque "WS upgrade rejected" logging with visibility into wait times.

**C4. Log in `resolveOpencodeUrl` instead of silent empty catches**

Current `getProjectOpencodeUrl` (daemon-projects.ts lines 59, 65) has empty `catch {}` blocks for instance URL resolution. Replace with debug-level logging:

```typescript
private resolveOpencodeUrl(instanceId?: string): string | null {
  // ...
  try {
    return this.instanceManager.getInstanceUrl(instanceId);
  } catch (err) {
    this.log.debug({ instanceId, error: formatErrorDetail(err) },
      "Failed to resolve OpenCode URL for instance");
    return null;
  }
}
```

**C5. Add relay creation timing to `buildRelayFactory`**

```typescript
return async (signal: AbortSignal) => {
  const start = Date.now();
  try {
    const relay = await createProjectRelay({ ... });
    this.log.info({ slug: project.slug, elapsed: Date.now() - start },
      "Relay created");
    return relay;
  } catch (err) {
    this.log.warn({ slug: project.slug, elapsed: Date.now() - start,
      error: formatErrorDetail(err) }, "Relay creation failed");
    throw err;
  }
};
```

This provides visibility into slow relay creation that previously showed up as unexplained delays.

---

## Type-Level and Structural Design Improvements

These amendments address the root causes behind audit findings A1-A5 and B1-B3, using TypeScript's type system and structural changes to make each class of bug impossible or difficult to introduce.

### D1. Make `StoredProject` fields `readonly` — prevents mutation-by-reference

**Root cause addressed:** A1/B1/B3 — the `setProjectTitle` IPC handler got a mutable reference via `getProjectBySlug()` and mutated `project.title = title` directly, bypassing the registry's `updateProject()` and its event emission.

**Change:**

```typescript
// src/lib/types.ts
export interface StoredProject {
  readonly slug: string;
  readonly directory: string;
  readonly title: string;
  readonly lastUsed?: number;
  readonly instanceId?: string;
}
```

**What breaks at compile time:**
- `daemon-ipc.ts:147` — `project.title = title` — **TS2540: Cannot assign to 'title' because it is a read-only property**
- `daemon.ts:1126` — `if (project) project.title = title` — same error
- `daemon-projects.ts:251` — `project.instanceId = instanceId` — same error

All three mutations are caught by the compiler. The only way to change a project's fields is through `ProjectRegistry.updateProject()`, which:
1. Creates a new `StoredProject` via spread: `{ ...entry.project, ...updates }`
2. Replaces the entry in the Map with the new object
3. Emits `project_updated` event
4. Auto-persists via event subscription

**Impact on creation sites:** Object literal creation (daemon-projects.ts:171-177, daemon.ts:386-392) is unaffected — TypeScript allows assigning to `readonly` properties during construction.

### D2. Remove `getProjectBySlug` from `DaemonIPCContext` — eliminate the mutation vector

**Root cause addressed:** A1 — the IPC handler used `getProjectBySlug()` as a gateway to get a mutable reference, then mutated directly instead of using the setter.

**Change:** Remove `getProjectBySlug` from the `DaemonIPCContext` interface. With `StoredProject` readonly (D1), returning a reference is safe at the TypeScript level, but removing the method is defense-in-depth — it makes the "get reference, then mutate" pattern impossible to write.

```typescript
// daemon-ipc.ts — DaemonIPCContext BEFORE:
getProjectBySlug(slug: string): StoredProject | undefined;
setProjectTitle(slug: string, title: string): void;

// AFTER:
setProjectTitle(slug: string, title: string): void;  // the ONLY way to change a title
```

The `setProjectTitle` IPC handler becomes:

```typescript
setProjectTitle: async (slug: string, title: string): Promise<IPCResponse> => {
  try {
    ctx.setProjectTitle(slug, title);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatErrorDetail(err) };
  }
},
```

The `setProjectTitle` context method throws if the slug doesn't exist (the registry's `updateProject` already does this). No need for a separate existence check.

Note: If any handler needs to READ a project by slug (e.g., to return it in a response), use `ctx.getProjects().find(p => p.slug === slug)` — this returns a readonly copy. OR add a read-only query: `getProjectBySlug(slug: string): Readonly<StoredProject> | undefined`. The key is that the returned object is inert — mutations don't propagate.

### D3. Remove `saveDaemonConfig`, `buildConfig`, and `configDir` from `DaemonIPCContext`

**Root cause addressed:** Inconsistent persistence responsibility — 6 IPC handlers call `saveDaemonConfig` explicitly, 2 rely on the `ctx` method to self-persist. This split creates a "forgot to save" bug class.

**Change:** Every context command that changes persisted state handles its own persistence. Handlers never call `saveDaemonConfig` directly. Remove all three from the interface:

```typescript
// DaemonIPCContext — REMOVE:
// buildConfig(): DaemonConfig;
// configDir: string;

// ALSO REMOVE from daemon-ipc.ts:
// import { saveDaemonConfig } from "./config-persistence.js";
```

Each context command becomes self-persisting:

```typescript
// For project mutations — handled by registry event subscriptions (already in plan)
setProjectTitle(slug: string, title: string): void;
// Implementation: this.registry.updateProject(slug, { title })
// -> emits project_updated -> this.persistConfig()

// For non-project mutations — make each method self-persist
setPinHash(hash: string): void;
// Implementation: this.pinHash = hash; this.auth.setPinHash(hash); this.persistConfig();

setKeepAwake(enabled: boolean): void;
// Implementation: this.keepAwake = enabled; this.keepAwakeManager?.setEnabled(enabled); this.persistConfig();

addInstance(id: string, config: InstanceConfig): OpenCodeInstance;
// Implementation: const inst = this.instanceManager.addInstance(id, config); this.persistConfig(); return inst;

removeInstance(id: string): void;
// Implementation: this.instanceManager.removeInstance(id); this.persistConfig();

updateInstance(id: string, updates: ...): OpenCodeInstance;
// Implementation: const inst = this.instanceManager.updateInstance(id, updates); this.persistConfig(); return inst;
```

**What this eliminates:** The entire category of "handler forgot to call saveDaemonConfig." Handlers become pure delegation + error wrapping. The `saveDaemonConfig` import is removed from `daemon-ipc.ts` entirely.

**For `instanceAdd` specifically:** The slug generation logic currently lives in the handler (daemon-ipc.ts:198-225). This must move into the daemon method that backs `ctx.addInstance`, since the handler can no longer access `ctx.getInstance` for the uniqueness loop. Alternative: keep `getInstance` as a read-only query on the context and keep the slug generation in the handler, but call `ctx.addInstance(id, config)` which self-persists.

Best approach: Keep `getInstance` as a query. The handler generates the unique ID, then calls `ctx.addInstance(id, config)` which self-persists. The handler only needs `getInstance` (read-only query) and `addInstance` (self-persisting command).

### D4. Add `broadcastToAll(message)` to `ProjectRegistry`

**Root cause addressed:** A3 — scattered relay iteration loops. Three identical `for (const relay of this.projectRelays.values()) { relay.wsHandler.broadcast(msg); }` patterns that each need updating independently.

**Change:** Add a convenience method to `ProjectRegistry`:

```typescript
class ProjectRegistry extends EventEmitter<ProjectRegistryEvents> {
  /** Broadcast a message to all connected browser clients across all ready relays. */
  broadcastToAll(message: Record<string, unknown>): void {
    for (const [, entry] of this.readyEntries()) {
      entry.relay.wsHandler.broadcast(message);
    }
  }

  /** Evict oldest cached sessions across all ready relays to free memory/disk. */
  evictOldestSessions(maxPerRelay: number): string[] {
    const evicted: string[] = [];
    for (const [, entry] of this.readyEntries()) {
      for (let i = 0; i < maxPerRelay; i++) {
        const sessionId = entry.relay.messageCache.evictOldestSession();
        if (!sessionId) break;
        evicted.push(sessionId);
      }
    }
    return evicted;
  }
}
```

The 4 daemon event handlers collapse to:

```typescript
// Site 1: instanceManager status_changed
this.instanceManager.on("status_changed", (instance) => {
  this.registry.broadcastToAll({
    type: "instance_status", instanceId: instance.id, status: instance.status,
  });
});

// Site 2: versionChecker update_available
this.versionChecker.on("update_available", ({ latest }) => {
  this.registry.broadcastToAll({ type: "update_available", version: latest });
});

// Site 3: storageMonitor low_disk_space (cache eviction)
this.storageMonitor.on("low_disk_space", ({ availableBytes, thresholdBytes }) => {
  this.log.warn(`Low disk space: ${availableBytes / 1024 / 1024}MB available`);
  const evicted = this.registry.evictOldestSessions(3);
  for (const id of evicted) {
    this.log.info(`Evicted cached session "${id}" to free disk space`);
  }
});

// Site 4: scanner instance_list broadcast
this.scanner.on("scan", (result) => {
  // ... instance add/remove logic ...
  if (result.discovered.length > 0 || result.lost.length > 0) {
    this.registry.broadcastToAll({
      type: "instance_list", instances: this.instanceManager.getInstances(),
    });
  }
});
```

New broadcast/eviction sites are impossible to write without the registry — there's no raw `projectRelays` Map to iterate.

### D5. Add `{ silent?: boolean }` to `addWithoutRelay` — solve rehydration event ordering

**Root cause addressed:** A5 — event subscription timing. Wiring subscriptions before rehydration triggers N redundant `persistConfig()` calls (once per rehydrated project). Wiring after risks missing user-initiated adds.

**Change:** Add a `silent` option that suppresses event emission:

```typescript
addWithoutRelay(project: StoredProject, options?: { silent?: boolean }): void {
  const { slug } = project;
  if (this.entries.has(slug)) {
    throw new Error(`Project "${slug}" is already registered`);
  }
  this.entries.set(slug, { status: "registering", project });
  if (!options?.silent) {
    this.emit("project_added", slug, project);
  }
}
```

Daemon rehydration uses `{ silent: true }`:

```typescript
// In start(), rehydration loop:
for (const proj of savedConfig.projects) {
  this.registry.addWithoutRelay(project, { silent: true });
}
// Event subscriptions are wired in constructor — always active — but rehydration
// doesn't trigger them. The explicit saveDaemonConfig at end of start() handles it.
```

This lets event subscriptions be wired in the constructor (always safe, no ordering concern):

```typescript
constructor(options?: DaemonOptions) {
  // ...
  this.registry = new ProjectRegistry();
  this.registry.on("project_added", () => this.persistConfig());
  this.registry.on("project_ready", () => this.persistConfig());
  this.registry.on("project_updated", () => this.persistConfig());
  this.registry.on("project_removed", () => this.persistConfig());
}
```

### D6. Type the relay factory to include `signal` — make abort handling mandatory

**Root cause addressed:** A4 — the plan's WS upgrade handler missed the `shuttingDown` check. More broadly, any code that awaits a relay must handle the signal/shutdown case.

The `waitForRelay` return type is already `Promise<ProjectRelay>`, and the caller must handle rejection (timeout, error, removed). But the `shuttingDown` check is a separate concern — the socket may become invalid during the await.

**Change:** Add a post-await guard pattern as a documented convention and enforce it in the WS upgrade handler:

```typescript
this.httpServer!.on("upgrade", async (req, socket, head) => {
  // ... slug extraction, auth check ...
  try {
    const relay = await this.registry.waitForRelay(slug, 10_000);
    // Post-await guard: socket or daemon state may have changed
    if (socket.destroyed || this.shuttingDown) return;
    relay.wsHandler.handleUpgrade(req, socket, head);
  } catch {
    if (!socket.destroyed) socket.destroy();
  }
});
```

For the factory itself, `signal?: AbortSignal` on `ProjectRelayConfig` (Task 5) is already optional. Make it required in the registry's factory type signature:

```typescript
// In ProjectRegistry:
add(
  project: StoredProject,
  createRelay: (signal: AbortSignal) => Promise<ProjectRelay>,  // signal is NOT optional
): void;
```

The registry always creates an AbortController and passes the signal. The factory cannot accidentally ignore it because the parameter is required in its signature.

### D7. Make `DaemonIPCContext` query methods return `Readonly<T>`

**Root cause addressed:** Defense-in-depth against mutation through returned references, even with `StoredProject` being readonly. Apply the same treatment to `OpenCodeInstance`.

```typescript
export interface DaemonIPCContext {
  // Queries return readonly types
  getProjects(): ReadonlyArray<Readonly<StoredProject>>;
  getInstances(): ReadonlyArray<Readonly<OpenCodeInstance>>;
  getInstance(id: string): Readonly<OpenCodeInstance> | undefined;
  
  // Commands (self-persisting)
  addProject(directory: string): Promise<Readonly<StoredProject>>;
  removeProject(slug: string): Promise<void>;
  setProjectTitle(slug: string, title: string): void;
  // ... etc
}
```

`ReadonlyArray` prevents `.push()`, `.splice()`, etc. on the returned array. `Readonly<OpenCodeInstance>` prevents field mutation on instance objects.

### Summary: Which audit finding each improvement addresses

| Improvement | Addresses | Mechanism |
|---|---|---|
| D1. Readonly `StoredProject` | A1, B1, B3 | Compiler error on direct field mutation |
| D2. Remove `getProjectBySlug` from IPC | A1 | Eliminates the mutation vector entirely |
| D3. Remove `saveDaemonConfig` from IPC | A1 (double-save), inconsistent persistence | Commands self-persist; handlers can't forget |
| D4. `broadcastToAll` + `evictOldestSessions` | A3, scattered loops | Single method replaces 4 loops |
| D5. `{ silent: true }` for rehydration | A5 | Decouples subscription wiring from call ordering |
| D6. Required `signal` in factory type | A4 | Can't write a factory that ignores abort |
| D7. `Readonly<T>` on query returns | Defense-in-depth | Prevents mutation through any returned reference |

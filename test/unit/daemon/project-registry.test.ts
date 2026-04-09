import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { ProjectRegistry } from "../../../src/lib/daemon/project-registry.js";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import type { ProjectRelay } from "../../../src/lib/relay/relay-stack.js";
import type { StoredProject } from "../../../src/lib/types.js";
import {
	createMockProjectRelay,
	deferredRelayFactory,
	failingRelayFactory,
	immediateRelayFactory,
} from "../../helpers/mock-factories.js";

function makeProject(slug: string, dir?: string): StoredProject {
	return {
		slug,
		directory: dir ?? `/test/${slug}`,
		title: slug,
		lastUsed: Date.now(),
	};
}

/**
 * A deferred factory that does NOT wire an abort listener, so calling
 * resolve() after abort actually delivers the relay to the .then() success
 * handler (which calls relay.stop() on discarded relays).
 */
function deferredRelayFactoryNoAbort() {
	let resolvePromise!: (
		relay: import("../../../src/lib/relay/relay-stack.js").ProjectRelay,
	) => void;
	let rejectPromise!: (error: Error) => void;

	const factory = (_signal: AbortSignal) =>
		new Promise<import("../../../src/lib/relay/relay-stack.js").ProjectRelay>(
			(res, rej) => {
				resolvePromise = res;
				rejectPromise = rej;
			},
		);

	return {
		factory,
		resolve: (
			relay?: import("../../../src/lib/relay/relay-stack.js").ProjectRelay,
		) => resolvePromise(relay ?? createMockProjectRelay()),
		reject: (error: Error) => rejectPromise(error),
	};
}

// ─── Lifecycle basics ───────────────────────────────────────────────────────

describe("ProjectRegistry — Lifecycle basics", () => {
	it("add() sets status to 'registering', emits project_added", () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const listener = vi.fn();
		reg.on("project_added", listener);

		const deferred = deferredRelayFactory();
		const project = makeProject("alpha");
		reg.add(project, deferred.factory);

		expect(reg.get("alpha")?.status).toBe("registering");
		expect(listener).toHaveBeenCalledWith("alpha", project);
	});

	it("relay factory resolves → status 'ready', emits project_ready", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const readyListener = vi.fn();
		reg.on("project_ready", readyListener);

		const relay = createMockProjectRelay();
		reg.add(makeProject("alpha"), immediateRelayFactory(relay));

		await vi.waitFor(() => {
			expect(reg.get("alpha")?.status).toBe("ready");
		});

		expect(readyListener).toHaveBeenCalledWith("alpha", relay);
		const entry = reg.get("alpha");
		expect(entry?.status === "ready" && entry.relay).toBe(relay);
	});

	it("relay factory rejects → status 'error', emits project_error", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const errorListener = vi.fn();
		reg.on("project_error", errorListener);

		reg.add(makeProject("alpha"), failingRelayFactory("boom"));

		await vi.waitFor(() => {
			expect(reg.get("alpha")?.status).toBe("error");
		});

		expect(errorListener).toHaveBeenCalledWith("alpha", "boom");
		const entry = reg.get("alpha");
		expect(entry?.status === "error" && entry.error).toBe("boom");
	});

	it("remove() on ready project calls relay.stop(), emits project_removed", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const relay = createMockProjectRelay();
		reg.add(makeProject("alpha"), immediateRelayFactory(relay));

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		const removedListener = vi.fn();
		reg.on("project_removed", removedListener);
		await reg.remove("alpha");

		expect(relay.stop).toHaveBeenCalled();
		expect(removedListener).toHaveBeenCalledWith("alpha");
		expect(reg.has("alpha")).toBe(false);
	});

	it("remove() on registering project aborts factory, discards result", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		// Use the no-abort variant so resolve() after removal delivers the relay
		// to the success handler, which calls relay.stop() to discard it.
		const deferred = deferredRelayFactoryNoAbort();
		reg.add(makeProject("alpha"), deferred.factory);

		expect(reg.get("alpha")?.status).toBe("registering");
		await reg.remove("alpha");
		expect(reg.has("alpha")).toBe(false);

		// Factory resolves after removal — relay should be stopped and discarded
		const relay = createMockProjectRelay();
		deferred.resolve(relay);
		await vi.waitFor(() => {
			expect(relay.stop).toHaveBeenCalled();
		});
	});

	it("updateProject() updates project fields, emits project_updated", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		reg.add(makeProject("alpha"), immediateRelayFactory());

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		const updatedListener = vi.fn();
		reg.on("project_updated", updatedListener);
		reg.updateProject("alpha", { title: "Alpha v2" });

		expect(reg.getProject("alpha")?.title).toBe("Alpha v2");
		expect(updatedListener).toHaveBeenCalledWith(
			"alpha",
			expect.objectContaining({ title: "Alpha v2" }),
		);
	});

	it("addWithoutRelay() sets status to 'registering' with no factory", () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const listener = vi.fn();
		reg.on("project_added", listener);

		const project = makeProject("alpha");
		reg.addWithoutRelay(project);

		expect(reg.get("alpha")?.status).toBe("registering");
		expect(listener).toHaveBeenCalledWith("alpha", project);
	});

	it("addWithoutRelay({ silent: true }) does NOT emit project_added", () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const listener = vi.fn();
		reg.on("project_added", listener);

		reg.addWithoutRelay(makeProject("alpha"), { silent: true });

		expect(reg.get("alpha")?.status).toBe("registering");
		expect(listener).not.toHaveBeenCalled();
	});

	it("startRelay() on 'registering' entry starts relay creation", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		reg.addWithoutRelay(makeProject("alpha"));

		const relay = createMockProjectRelay();
		const readyListener = vi.fn();
		reg.on("project_ready", readyListener);

		reg.startRelay("alpha", immediateRelayFactory(relay));

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		expect(readyListener).toHaveBeenCalledWith("alpha", relay);
	});

	it("startRelay() on 'error' entry retries, can become 'ready'", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		reg.add(makeProject("alpha"), failingRelayFactory("first-fail"));

		await vi.waitFor(() => {
			expect(reg.get("alpha")?.status).toBe("error");
		});

		const relay = createMockProjectRelay();
		reg.startRelay("alpha", immediateRelayFactory(relay));

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		const entry = reg.get("alpha");
		expect(entry?.status === "ready" && entry.relay).toBe(relay);
	});

	it("replaceRelay() stops old relay, transitions through 'registering' to 'ready'", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const oldRelay = createMockProjectRelay();
		reg.add(makeProject("alpha"), immediateRelayFactory(oldRelay));

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		const newRelay = createMockProjectRelay();
		await reg.replaceRelay("alpha", immediateRelayFactory(newRelay));

		expect(oldRelay.stop).toHaveBeenCalled();

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		const entry = reg.get("alpha");
		expect(entry?.status === "ready" && entry.relay).toBe(newRelay);
	});
});

// ─── Queries ────────────────────────────────────────────────────────────────

describe("ProjectRegistry — Queries", () => {
	it("getRelay() returns relay only for 'ready' entries, undefined otherwise", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const deferred = deferredRelayFactory();
		reg.add(makeProject("alpha"), deferred.factory);

		// While registering
		expect(reg.getRelay("alpha")).toBeUndefined();

		const relay = createMockProjectRelay();
		deferred.resolve(relay);

		await vi.waitFor(() => {
			expect(reg.getRelay("alpha")).toBe(relay);
		});
	});

	it("getRelay() returns undefined for error entries", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		reg.add(makeProject("alpha"), failingRelayFactory("fail"));

		await vi.waitFor(() => {
			expect(reg.get("alpha")?.status).toBe("error");
		});

		expect(reg.getRelay("alpha")).toBeUndefined();
	});

	it("getProject() returns project regardless of status", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const project = makeProject("alpha");
		const deferred = deferredRelayFactory();
		reg.add(project, deferred.factory);

		// Registering
		expect(reg.getProject("alpha")).toEqual(project);

		deferred.resolve();
		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		// Ready
		expect(reg.getProject("alpha")).toEqual(project);
	});

	it("allProjects() returns all projects, readyEntries() returns only ready", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const deferred = deferredRelayFactory();
		reg.add(makeProject("alpha"), immediateRelayFactory());
		reg.add(makeProject("beta"), deferred.factory);

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		const all = reg.allProjects();
		expect(all).toHaveLength(2);

		const ready = reg.readyEntries();
		expect(ready).toHaveLength(1);
		expect(ready[0]?.[0]).toBe("alpha");
	});

	it("findByDirectory() finds entry by path", () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		reg.addWithoutRelay(makeProject("alpha", "/custom/path"));

		const entry = reg.findByDirectory("/custom/path");
		expect(entry).toBeDefined();
		expect(entry?.project.slug).toBe("alpha");

		expect(reg.findByDirectory("/nonexistent")).toBeUndefined();
	});

	it("has() and isReady() reflect current state", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		expect(reg.has("alpha")).toBe(false);
		expect(reg.isReady("alpha")).toBe(false);

		const deferred = deferredRelayFactory();
		reg.add(makeProject("alpha"), deferred.factory);

		expect(reg.has("alpha")).toBe(true);
		expect(reg.isReady("alpha")).toBe(false);

		deferred.resolve();
		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});
	});

	it("size getter is accurate", () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		expect(reg.size).toBe(0);

		reg.addWithoutRelay(makeProject("alpha"));
		expect(reg.size).toBe(1);

		reg.addWithoutRelay(makeProject("beta"));
		expect(reg.size).toBe(2);
	});

	it("slugs() returns all registered slugs", () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		reg.addWithoutRelay(makeProject("alpha"));
		reg.addWithoutRelay(makeProject("beta"));
		reg.addWithoutRelay(makeProject("gamma"));

		const slugs = Array.from(reg.slugs());
		expect(slugs).toEqual(["alpha", "beta", "gamma"]);
	});
});

// ─── waitForRelay ───────────────────────────────────────────────────────────

describe("ProjectRegistry — waitForRelay", () => {
	it("already ready → resolves immediately", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const relay = createMockProjectRelay();
		reg.add(makeProject("alpha"), immediateRelayFactory(relay));

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		const result = await reg.waitForRelay("alpha");
		expect(result).toBe(relay);
	});

	it("registering → resolves when factory completes", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const deferred = deferredRelayFactory();
		reg.add(makeProject("alpha"), deferred.factory);

		const promise = reg.waitForRelay("alpha");

		const relay = createMockProjectRelay();
		deferred.resolve(relay);

		const result = await promise;
		expect(result).toBe(relay);
	});

	it("error → rejects immediately with error message", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		reg.add(makeProject("alpha"), failingRelayFactory("broken"));

		await vi.waitFor(() => {
			expect(reg.get("alpha")?.status).toBe("error");
		});

		await expect(reg.waitForRelay("alpha")).rejects.toThrow(
			'Project "alpha" relay failed: broken',
		);
	});

	it("non-existent slug → rejects immediately", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());

		await expect(reg.waitForRelay("ghost")).rejects.toThrow(
			'Project "ghost" not found',
		);
	});

	it("timeout while registering → rejects with timeout error, cleans up listeners", async () => {
		vi.useFakeTimers();
		try {
			const reg = new ProjectRegistry(new ServiceRegistry());
			const deferred = deferredRelayFactory();
			reg.add(makeProject("alpha"), deferred.factory);

			const promise = reg.waitForRelay("alpha", 100);

			vi.advanceTimersByTime(100);

			await expect(promise).rejects.toThrow(
				'Timed out waiting for relay "alpha" (100ms)',
			);

			// Listeners should be cleaned up
			expect(reg.listenerCount("project_ready")).toBe(0);
			expect(reg.listenerCount("project_error")).toBe(0);
			expect(reg.listenerCount("project_removed")).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("project removed while waiting → rejects", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const deferred = deferredRelayFactory();
		reg.add(makeProject("alpha"), deferred.factory);

		const promise = reg.waitForRelay("alpha");

		await reg.remove("alpha");

		await expect(promise).rejects.toThrow('Project "alpha" was removed');
	});

	it("multiple concurrent waiters all resolve when relay becomes ready", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const deferred = deferredRelayFactory();
		reg.add(makeProject("alpha"), deferred.factory);

		const p1 = reg.waitForRelay("alpha");
		const p2 = reg.waitForRelay("alpha");
		const p3 = reg.waitForRelay("alpha");

		const relay = createMockProjectRelay();
		deferred.resolve(relay);

		const results = await Promise.all([p1, p2, p3]);
		expect(results).toEqual([relay, relay, relay]);
	});

	it("registering → factory rejects while waiter is blocked → rejects waiter", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const deferred = deferredRelayFactory();
		reg.add(makeProject("alpha"), deferred.factory);

		const promise = reg.waitForRelay("alpha");

		// Factory rejects while waiter is blocked
		deferred.reject(new Error("factory-boom"));

		await expect(promise).rejects.toThrow(
			'Project "alpha" relay failed: factory-boom',
		);
	});
});

// ─── Concurrency ────────────────────────────────────────────────────────────

describe("ProjectRegistry — Concurrency", () => {
	it("add() for existing slug throws", () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		reg.addWithoutRelay(makeProject("alpha"));

		expect(() => {
			reg.add(makeProject("alpha"), immediateRelayFactory());
		}).toThrow('Project "alpha" is already registered');
	});

	it("remove() during registering, factory resolves after → relay stopped and discarded", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		// Use no-abort variant so resolve() after removal still delivers the relay
		const deferred = deferredRelayFactoryNoAbort();
		reg.add(makeProject("alpha"), deferred.factory);

		// Remove while still registering
		await reg.remove("alpha");
		expect(reg.has("alpha")).toBe(false);

		// Factory resolves after removal — relay should be discarded (stop called)
		const relay = createMockProjectRelay();
		deferred.resolve(relay);

		await vi.waitFor(() => {
			expect(relay.stop).toHaveBeenCalled();
		});

		// Should not be re-added
		expect(reg.has("alpha")).toBe(false);
	});

	it("replaceRelay() aborts old factory, starts new", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const deferred1 = deferredRelayFactory();
		reg.add(makeProject("alpha"), deferred1.factory);

		const newRelay = createMockProjectRelay();
		await reg.replaceRelay("alpha", immediateRelayFactory(newRelay));

		// Old factory is aborted — resolving it should not affect state
		const oldRelay = createMockProjectRelay();
		deferred1.resolve(oldRelay);

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		// The ready relay should be the new one
		expect(reg.getRelay("alpha")).toBe(newRelay);
	});
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("ProjectRegistry — Edge cases", () => {
	it("stopAll() stops all ready relays, aborts all registering, empties map", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const readyRelay = createMockProjectRelay();
		reg.add(makeProject("alpha"), immediateRelayFactory(readyRelay));

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		const deferred = deferredRelayFactory();
		reg.add(makeProject("beta"), deferred.factory);

		await reg.stopAll();

		expect(readyRelay.stop).toHaveBeenCalled();
		expect(reg.size).toBe(0);
		expect(reg.has("alpha")).toBe(false);
		expect(reg.has("beta")).toBe(false);
	});

	it("remove() on non-existent slug is a no-op (no throw)", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		// Should not throw
		await reg.remove("nonexistent");
	});

	it("add() then immediate remove() before factory resolves", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		// Use no-abort variant so resolve() after removal delivers the relay
		const deferred = deferredRelayFactoryNoAbort();
		const addedListener = vi.fn();
		const removedListener = vi.fn();

		reg.on("project_added", addedListener);
		reg.on("project_removed", removedListener);

		reg.add(makeProject("alpha"), deferred.factory);
		expect(addedListener).toHaveBeenCalledOnce();

		await reg.remove("alpha");
		expect(removedListener).toHaveBeenCalledWith("alpha");
		expect(reg.has("alpha")).toBe(false);

		// Even after factory resolves, project stays gone and relay is discarded
		const relay = createMockProjectRelay();
		deferred.resolve(relay);

		await vi.waitFor(() => {
			expect(relay.stop).toHaveBeenCalled();
		});
		expect(reg.has("alpha")).toBe(false);
	});

	it("stopAll() with no entries is a no-op", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		await reg.stopAll();
		expect(reg.size).toBe(0);
	});

	it("drain() stops all relays, aborts pending creations, and drains tracked promises", async () => {
		const registry = new ServiceRegistry();
		const reg = new ProjectRegistry(registry);

		// Add a ready relay
		const readyRelay = createMockProjectRelay();
		reg.add(makeProject("alpha"), immediateRelayFactory(readyRelay));

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		// Add a pending (registering) relay
		const deferred = deferredRelayFactory();
		reg.add(makeProject("beta"), deferred.factory);
		expect(reg.get("beta")?.status).toBe("registering");

		// drain() should stop all relays and abort pending creations
		await reg.drain();

		expect(readyRelay.stop).toHaveBeenCalled();
		expect(reg.size).toBe(0);
		expect(reg.has("alpha")).toBe(false);
		expect(reg.has("beta")).toBe(false);
	});
});

// ─── Negative paths ─────────────────────────────────────────────────────────

describe("ProjectRegistry — Negative paths", () => {
	it("addWithoutRelay() for duplicate slug throws", () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		reg.addWithoutRelay(makeProject("alpha"));

		expect(() => {
			reg.addWithoutRelay(makeProject("alpha"));
		}).toThrow('Project "alpha" is already registered');
	});

	it("startRelay() on already-ready project throws", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		reg.add(makeProject("alpha"), immediateRelayFactory());

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		expect(() => {
			reg.startRelay("alpha", immediateRelayFactory());
		}).toThrow('Project "alpha" already has a relay');
	});

	it("startRelay() on non-existent slug throws", () => {
		const reg = new ProjectRegistry(new ServiceRegistry());

		expect(() => {
			reg.startRelay("ghost", immediateRelayFactory());
		}).toThrow('Project "ghost" not found');
	});

	it("replaceRelay() on non-existent slug throws", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());

		await expect(
			reg.replaceRelay("ghost", immediateRelayFactory()),
		).rejects.toThrow('Project "ghost" not found');
	});

	it("updateProject() on non-existent slug throws", () => {
		const reg = new ProjectRegistry(new ServiceRegistry());

		expect(() => {
			reg.updateProject("ghost", { title: "nope" });
		}).toThrow('Project "ghost" not found');
	});
});

// ─── Cross-relay operations (D4) ────────────────────────────────────────────

describe("ProjectRegistry — Cross-relay operations (D4)", () => {
	it("broadcastToAll() sends to all ready relays' wsHandler", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const relay1 = createMockProjectRelay();
		const relay2 = createMockProjectRelay();

		reg.add(makeProject("alpha"), immediateRelayFactory(relay1));
		reg.add(makeProject("beta"), immediateRelayFactory(relay2));

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
			expect(reg.isReady("beta")).toBe(true);
		});

		const message = { type: "test", payload: "hello" } as unknown as Parameters<
			ProjectRegistry["broadcastToAll"]
		>[0];
		reg.broadcastToAll(message);

		expect(relay1.wsHandler.broadcast).toHaveBeenCalledWith(message);
		expect(relay2.wsHandler.broadcast).toHaveBeenCalledWith(message);
	});

	it("broadcastToAll() skips registering/error entries", async () => {
		const reg = new ProjectRegistry(new ServiceRegistry());
		const readyRelay = createMockProjectRelay();
		reg.add(makeProject("alpha"), immediateRelayFactory(readyRelay));

		await vi.waitFor(() => {
			expect(reg.isReady("alpha")).toBe(true);
		});

		// beta is registering
		const deferred = deferredRelayFactory();
		reg.add(makeProject("beta"), deferred.factory);

		// gamma is in error
		reg.add(makeProject("gamma"), failingRelayFactory("fail"));
		await vi.waitFor(() => {
			expect(reg.get("gamma")?.status).toBe("error");
		});

		const message = { type: "test" } as unknown as Parameters<
			ProjectRegistry["broadcastToAll"]
		>[0];
		reg.broadcastToAll(message);

		expect(readyRelay.wsHandler.broadcast).toHaveBeenCalledWith(message);
		// Only readyRelay should have been called — registering/error have no relay
	});

	it("evictOldestSessions() is a no-op (MessageCache removed, SQLite WAL handles storage)", () => {
		// MessageCache has been removed in Task 50.5. SQLite WAL + EventStoreEviction
		// (Task 51) handles storage pressure. evictOldestSessions is retained for
		// call-site compatibility and always returns [].
		const reg = new ProjectRegistry(new ServiceRegistry());
		const evicted = reg.evictOldestSessions(3);
		expect(evicted).toEqual([]);
	});
});

// ─── Property-based invariants (Layer 2) ────────────────────────────────────

describe("ProjectRegistry — Property-based invariants", () => {
	/** Flush microtasks so immediateRelayFactory promises resolve */
	const flush = () => new Promise((r) => setTimeout(r, 0));

	/** Arbitrary slug from a small pool to encourage collisions */
	const slugArb = fc.constantFrom("a", "b", "c", "d", "e");

	/** Possible operations to perform on a registry */
	type Op =
		| { type: "add"; slug: string }
		| { type: "addFailing"; slug: string }
		| { type: "addWithoutRelay"; slug: string }
		| { type: "remove"; slug: string }
		| { type: "updateTitle"; slug: string; title: string };

	const opArb: fc.Arbitrary<Op> = fc.oneof(
		slugArb.map((slug) => ({ type: "add" as const, slug })),
		slugArb.map((slug) => ({ type: "addFailing" as const, slug })),
		slugArb.map((slug) => ({ type: "addWithoutRelay" as const, slug })),
		slugArb.map((slug) => ({ type: "remove" as const, slug })),
		fc
			.tuple(slugArb, fc.string({ minLength: 1, maxLength: 10 }))
			.map(([slug, title]) => ({ type: "updateTitle" as const, slug, title })),
	);

	async function applyOp(reg: ProjectRegistry, op: Op): Promise<void> {
		switch (op.type) {
			case "add":
				if (!reg.has(op.slug)) {
					reg.add(makeProject(op.slug), immediateRelayFactory());
				}
				break;
			case "addFailing":
				if (!reg.has(op.slug)) {
					reg.add(makeProject(op.slug), failingRelayFactory("prop-fail"));
				}
				break;
			case "addWithoutRelay":
				if (!reg.has(op.slug)) {
					reg.addWithoutRelay(makeProject(op.slug));
				}
				break;
			case "remove":
				await reg.remove(op.slug);
				break;
			case "updateTitle":
				if (reg.has(op.slug)) {
					reg.updateProject(op.slug, { title: op.title });
				}
				break;
		}
	}

	function assertInvariants(reg: ProjectRegistry): void {
		const all = reg.allProjects();
		const ready = reg.readyEntries();

		// Invariant 1: Every "ready" entry has a relay accessible via getRelay()
		for (const [slug, entry] of ready) {
			expect(reg.getRelay(slug)).toBeDefined();
			expect(reg.getRelay(slug)).toBe(entry.relay);
		}

		// Invariant 2: Non-ready entries return undefined from getRelay()
		for (const project of all) {
			const entry = reg.get(project.slug);
			if (entry && entry.status !== "ready") {
				expect(reg.getRelay(project.slug)).toBeUndefined();
			}
		}

		// Invariant 3: size equals allProjects().length
		expect(reg.size).toBe(all.length);

		// Invariant 4: readyEntries().length <= size
		expect(ready.length).toBeLessThanOrEqual(reg.size);

		// Invariant 5: No slug appears twice in allProjects()
		const slugSet = new Set(all.map((p) => p.slug));
		expect(slugSet.size).toBe(all.length);

		// Invariant 6: No leaked event listeners after operations
		// Each waitForRelay() call registers listeners on project_ready, project_error,
		// project_removed. After resolution/rejection they must be cleaned up.
		// In normal operation (no active waiters), counts should be 0.
		expect(reg.listenerCount("project_ready")).toBe(0);
		expect(reg.listenerCount("project_error")).toBe(0);
		expect(reg.listenerCount("project_removed")).toBe(0);
	}

	it("invariants hold after random operation sequences", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 30 }),
				async (ops) => {
					const reg = new ProjectRegistry(new ServiceRegistry());

					for (const op of ops) {
						await applyOp(reg, op);
						await flush();
					}

					assertInvariants(reg);
				},
			),
			{ numRuns: 30 },
		);
	});

	it("after stopAll(), size is always 0", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 20 }),
				async (ops) => {
					const reg = new ProjectRegistry(new ServiceRegistry());

					for (const op of ops) {
						await applyOp(reg, op);
						await flush();
					}

					// Invariant 6: After stopAll(), size === 0
					await reg.stopAll();
					expect(reg.size).toBe(0);
				},
			),
			{ numRuns: 30 },
		);
	});

	it("invariants hold even with interleaved flushes", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 20 }),
				async (ops) => {
					const reg = new ProjectRegistry(new ServiceRegistry());

					for (const op of ops) {
						await applyOp(reg, op);
						// Flush after every operation
						await flush();
						// Assert invariants at each step
						assertInvariants(reg);
					}
				},
			),
			{ numRuns: 50 },
		);
	});
});

// ─── Stateful model tests (Layer 3) ─────────────────────────────────────────

describe("ProjectRegistry — Stateful model tests", () => {
	/** Flush microtasks so immediateRelayFactory promises resolve */
	const flush = () => new Promise((r) => setTimeout(r, 0));

	type ModelEntry = {
		slug: string;
		directory: string;
		title: string;
		status: "registering" | "ready" | "error";
	};
	type Model = Map<string, ModelEntry>;

	class AddCommand implements fc.AsyncCommand<Model, ProjectRegistry> {
		constructor(readonly slug: string) {}

		check(m: Readonly<Model>): boolean {
			// Only add if not already present
			return !m.has(this.slug);
		}

		async run(m: Model, reg: ProjectRegistry): Promise<void> {
			const dir = `/test/${this.slug}`;
			reg.add(makeProject(this.slug, dir), immediateRelayFactory());
			// Model: add as registering (will become ready after flush)
			m.set(this.slug, {
				slug: this.slug,
				directory: dir,
				title: this.slug,
				status: "registering",
			});

			// Flush so the immediate factory resolves
			await flush();

			// Now it should be ready
			const entry = m.get(this.slug);
			if (entry) entry.status = "ready";

			// Assert consistency
			expect(reg.has(this.slug)).toBe(true);
			expect(reg.get(this.slug)?.status).toBe("ready");
			expect(reg.getRelay(this.slug)).toBeDefined();
		}

		toString(): string {
			return `Add(${this.slug})`;
		}
	}

	class AddFailingCommand implements fc.AsyncCommand<Model, ProjectRegistry> {
		constructor(readonly slug: string) {}

		check(m: Readonly<Model>): boolean {
			return !m.has(this.slug);
		}

		async run(m: Model, reg: ProjectRegistry): Promise<void> {
			const dir = `/test/${this.slug}`;
			reg.add(makeProject(this.slug, dir), failingRelayFactory("model-fail"));
			m.set(this.slug, {
				slug: this.slug,
				directory: dir,
				title: this.slug,
				status: "registering",
			});

			await flush();

			// Now it should be in error state
			const entry = m.get(this.slug);
			if (entry) entry.status = "error";

			expect(reg.has(this.slug)).toBe(true);
			expect(reg.get(this.slug)?.status).toBe("error");
			expect(reg.getRelay(this.slug)).toBeUndefined();
		}

		toString(): string {
			return `AddFailing(${this.slug})`;
		}
	}

	class StartRelayCommand implements fc.AsyncCommand<Model, ProjectRegistry> {
		constructor(readonly slug: string) {}

		check(m: Readonly<Model>): boolean {
			// Only valid when entry exists and is NOT ready
			const entry = m.get(this.slug);
			return entry != null && entry.status !== "ready";
		}

		async run(m: Model, reg: ProjectRegistry): Promise<void> {
			const relay = createMockProjectRelay();
			reg.startRelay(this.slug, immediateRelayFactory(relay));

			await flush();

			// Model transitions to ready
			const entry = m.get(this.slug);
			if (entry) entry.status = "ready";

			expect(reg.has(this.slug)).toBe(true);
			expect(reg.get(this.slug)?.status).toBe("ready");
			expect(reg.getRelay(this.slug)).toBe(relay);
		}

		toString(): string {
			return `StartRelay(${this.slug})`;
		}
	}

	class ReplaceRelayCommand implements fc.AsyncCommand<Model, ProjectRegistry> {
		constructor(readonly slug: string) {}

		check(m: Readonly<Model>): boolean {
			// Only valid when entry exists and is ready
			const entry = m.get(this.slug);
			return entry != null && entry.status === "ready";
		}

		async run(m: Model, reg: ProjectRegistry): Promise<void> {
			const newRelay = createMockProjectRelay();
			await reg.replaceRelay(this.slug, immediateRelayFactory(newRelay));

			await flush();

			// Model stays ready (with new relay)
			const entry = m.get(this.slug);
			if (entry) entry.status = "ready";

			expect(reg.has(this.slug)).toBe(true);
			expect(reg.get(this.slug)?.status).toBe("ready");
			expect(reg.getRelay(this.slug)).toBe(newRelay);
		}

		toString(): string {
			return `ReplaceRelay(${this.slug})`;
		}
	}

	class RemoveCommand implements fc.AsyncCommand<Model, ProjectRegistry> {
		constructor(readonly slug: string) {}

		check(_m: Readonly<Model>): boolean {
			// Can always try to remove (no-op if not present)
			return true;
		}

		async run(m: Model, reg: ProjectRegistry): Promise<void> {
			await reg.remove(this.slug);
			m.delete(this.slug);

			expect(reg.has(this.slug)).toBe(false);
			expect(reg.getRelay(this.slug)).toBeUndefined();
		}

		toString(): string {
			return `Remove(${this.slug})`;
		}
	}

	class UpdateTitleCommand implements fc.AsyncCommand<Model, ProjectRegistry> {
		constructor(
			readonly slug: string,
			readonly title: string,
		) {}

		check(m: Readonly<Model>): boolean {
			// Only update if the slug exists
			return m.has(this.slug);
		}

		async run(m: Model, reg: ProjectRegistry): Promise<void> {
			reg.updateProject(this.slug, { title: this.title });
			const entry = m.get(this.slug);
			if (entry) entry.title = this.title;

			expect(reg.getProject(this.slug)?.title).toBe(this.title);
		}

		toString(): string {
			return `UpdateTitle(${this.slug}, ${this.title})`;
		}
	}

	class CheckCommand implements fc.AsyncCommand<Model, ProjectRegistry> {
		check(_m: Readonly<Model>): boolean {
			return true;
		}

		async run(m: Model, reg: ProjectRegistry): Promise<void> {
			// Size must match
			expect(reg.size).toBe(m.size);

			// Every model entry must be reflected in registry
			for (const [slug, entry] of m) {
				expect(reg.has(slug)).toBe(true);

				const regEntry = reg.get(slug);
				expect(regEntry).toBeDefined();
				expect(regEntry?.status).toBe(entry.status);
				expect(regEntry?.project.title).toBe(entry.title);
				expect(regEntry?.project.directory).toBe(entry.directory);

				if (entry.status === "ready") {
					expect(reg.getRelay(slug)).toBeDefined();
				} else {
					expect(reg.getRelay(slug)).toBeUndefined();
				}
			}

			// No extra entries in registry
			const allProjects = reg.allProjects();
			expect(allProjects.length).toBe(m.size);

			// readyEntries <= size
			const readyEntries = reg.readyEntries();
			const modelReadyCount = Array.from(m.values()).filter(
				(e) => e.status === "ready",
			).length;
			expect(readyEntries.length).toBe(modelReadyCount);
		}

		toString(): string {
			return "Check";
		}
	}

	const slugArb = fc.constantFrom("x", "y", "z", "w");

	const commandArbs = [
		slugArb.map((s) => new AddCommand(s)),
		slugArb.map((s) => new AddFailingCommand(s)),
		slugArb.map((s) => new StartRelayCommand(s)),
		slugArb.map((s) => new ReplaceRelayCommand(s)),
		slugArb.map((s) => new RemoveCommand(s)),
		fc
			.tuple(slugArb, fc.string({ minLength: 1, maxLength: 8 }))
			.map(([s, t]) => new UpdateTitleCommand(s, t)),
		fc.constant(new CheckCommand()),
	];

	it("model and registry stay in sync across random command sequences", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.commands(commandArbs, { maxCommands: 30 }),
				async (cmds) => {
					const model: Model = new Map();
					const reg = new ProjectRegistry(new ServiceRegistry());

					await fc.asyncModelRun(() => ({ model, real: reg }), cmds);
				},
			),
			{ numRuns: 30 },
		);
	});
});

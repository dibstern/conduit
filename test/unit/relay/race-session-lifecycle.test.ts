// ─── Race Condition: session_lifecycle create→delete interleaving ────────────
//
// Tests the REAL wireSessionLifecycle function from session-lifecycle-wiring.ts.
// Mocks only I/O boundaries: client.getMessages (network), pollerManager (HTTP
// polling loops), statusPoller, sseTracker, wsHandler, monitoring state.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../../src/lib/logger.js";
import type { MonitoringState } from "../../../src/lib/relay/monitoring-types.js";
import {
	type SessionLifecycleWiringDeps,
	wireSessionLifecycle,
} from "../../../src/lib/relay/session-lifecycle-wiring.js";
import type { SessionManagerEvents } from "../../../src/lib/session/session-manager.js";

/**
 * Build minimal deps for wireSessionLifecycle, with controllable
 * client.getMessages for the race condition tests.
 */
function buildDeps(overrides?: {
	getMessages?: (id: string) => Promise<unknown>;
}) {
	const sessionMgr = new EventEmitter() as EventEmitter<SessionManagerEvents>;

	let monitoringState: MonitoringState = { sessions: new Map() };

	const deps: SessionLifecycleWiringDeps = {
		sessionMgr: sessionMgr as SessionLifecycleWiringDeps["sessionMgr"],
		wsHandler: {
			broadcast: vi.fn(),
		} as unknown as SessionLifecycleWiringDeps["wsHandler"],
		client: {
			getMessages:
				overrides?.getMessages ?? vi.fn().mockResolvedValue(undefined),
		} as unknown as SessionLifecycleWiringDeps["client"],
		translator: {
			reset: vi.fn(),
			translate: vi.fn().mockReturnValue({ ok: false, reason: "test" }),
			rebuildStateFromHistory: vi.fn(),
		} as unknown as SessionLifecycleWiringDeps["translator"],
		pollerManager: {
			startPolling: vi.fn(),
			stopPolling: vi.fn(),
		} as unknown as SessionLifecycleWiringDeps["pollerManager"],
		statusPoller: {
			clearMessageActivity: vi.fn(),
		} as unknown as SessionLifecycleWiringDeps["statusPoller"],
		sseTracker: {
			remove: vi.fn(),
		} as unknown as SessionLifecycleWiringDeps["sseTracker"],
		getMonitoringState: () => monitoringState,
		setMonitoringState: (s: MonitoringState) => {
			monitoringState = s;
		},
		sessionLog: createSilentLogger(),
	};

	return { deps, sessionMgr };
}

describe("session_lifecycle race: create→delete interleaving", () => {
	it("does NOT call startPolling when delete arrives during rebuild await", async () => {
		// Controllable promise — lets us interleave events before resolution
		let resolveGetMessages!: (value: unknown) => void;
		const getMessagesPromise = new Promise((res) => {
			resolveGetMessages = res;
		});

		const { deps, sessionMgr } = buildDeps({
			getMessages: vi.fn().mockReturnValue(getMessagesPromise),
		});

		// Wire the REAL handler
		wireSessionLifecycle(deps);

		const sid = "ses_test_123";

		// 1. Fire "created" — starts the async rebuild
		sessionMgr.emit("session_lifecycle", {
			type: "created",
			sessionId: sid,
		});

		// 2. Fire "deleted" BEFORE rebuild resolves (simulates the race)
		sessionMgr.emit("session_lifecycle", {
			type: "deleted",
			sessionId: sid,
		});

		expect(deps.pollerManager.stopPolling).toHaveBeenCalledWith(sid);

		// 3. Resolve getMessages (returns messages, so without guard it would start polling)
		resolveGetMessages([{ role: "assistant", parts: [] }]);
		await getMessagesPromise;
		// Let microtasks settle
		await new Promise((r) => setTimeout(r, 0));

		// startPolling must NOT be called — session was deleted during await
		expect(deps.pollerManager.startPolling).not.toHaveBeenCalled();
	});

	it("DOES call startPolling when no delete arrives during rebuild", async () => {
		const { deps, sessionMgr } = buildDeps({
			getMessages: vi
				.fn()
				.mockResolvedValue([{ role: "assistant", parts: [] }]),
		});

		wireSessionLifecycle(deps);

		const sid = "ses_normal";

		sessionMgr.emit("session_lifecycle", {
			type: "created",
			sessionId: sid,
		});

		// Let async handler resolve
		await new Promise((r) => setTimeout(r, 0));

		expect(deps.pollerManager.startPolling).toHaveBeenCalledWith(
			sid,
			expect.any(Array),
		);
		expect(deps.pollerManager.stopPolling).not.toHaveBeenCalled();
	});

	it("skips startPolling when getMessages returns no messages", async () => {
		const { deps, sessionMgr } = buildDeps({
			getMessages: vi.fn().mockResolvedValue(undefined),
		});

		wireSessionLifecycle(deps);

		sessionMgr.emit("session_lifecycle", {
			type: "created",
			sessionId: "ses_empty",
		});

		await new Promise((r) => setTimeout(r, 0));

		expect(deps.pollerManager.startPolling).not.toHaveBeenCalled();
	});

	it("clears stale deleted flag when session ID is recycled (create→delete→create)", async () => {
		const resolvers: Array<(v: unknown) => void> = [];

		const { deps, sessionMgr } = buildDeps({
			getMessages: vi.fn().mockImplementation(() => {
				return new Promise((res) => {
					resolvers.push(res);
				});
			}),
		});

		wireSessionLifecycle(deps);

		const sid = "ses_recycled";
		const msgs = [{ role: "assistant", parts: [] }];

		// 1. First create
		sessionMgr.emit("session_lifecycle", {
			type: "created",
			sessionId: sid,
		});

		// 2. Delete before first rebuild resolves
		sessionMgr.emit("session_lifecycle", {
			type: "deleted",
			sessionId: sid,
		});

		// 3. Second create (recycled ID) — should clear the stale deleted flag
		sessionMgr.emit("session_lifecycle", {
			type: "created",
			sessionId: sid,
		});

		// Resolve first rebuild (should be guarded — session was deleted)
		resolvers[0]?.(msgs);
		await new Promise((r) => setTimeout(r, 0));

		// Resolve second rebuild
		resolvers[1]?.(msgs);
		await new Promise((r) => setTimeout(r, 0));

		// The second create should start polling
		expect(deps.pollerManager.startPolling).toHaveBeenCalledWith(
			sid,
			expect.any(Array),
		);
	});

	it("cleans up monitoring state on session delete", async () => {
		const { deps, sessionMgr } = buildDeps();

		// Pre-populate monitoring state with a session
		deps.setMonitoringState({
			sessions: new Map([["ses_delete_me", {} as never]]),
		});

		wireSessionLifecycle(deps);

		sessionMgr.emit("session_lifecycle", {
			type: "deleted",
			sessionId: "ses_delete_me",
		});

		// Monitoring state should no longer contain the deleted session
		expect(deps.getMonitoringState().sessions.has("ses_delete_me")).toBe(false);
		expect(deps.statusPoller.clearMessageActivity).toHaveBeenCalledWith(
			"ses_delete_me",
		);
		expect(deps.sseTracker.remove).toHaveBeenCalledWith("ses_delete_me");
	});
});

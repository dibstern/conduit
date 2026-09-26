import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusPollerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	makePollerStateLive,
	type SessionStatusPollerService,
} from "../../../src/lib/domain/relay/Services/session-status-poller.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	wireMonitoring,
	wireMonitoringEffect,
} from "../../../src/lib/relay/monitoring-wiring.js";

type ChangedCallback = Parameters<SessionStatusPollerService["on"]>[1];

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

function createHarness() {
	let changed: ChangedCallback | undefined;
	let resolveMessages: ((messages: []) => void) | undefined;
	const messages = vi.fn(
		() =>
			new Promise<[]>((resolve) => {
				resolveMessages = resolve;
			}),
	);
	const startPolling = vi.fn();
	const getClientsForSession = vi.fn((_sessionId: string): string[] => []);

	const result = wireMonitoring({
		client: {
			session: { messages },
		},
		wsHandler: {
			broadcast: vi.fn(),
			sendToSession: vi.fn(),
			getClientsForSession,
			broadcastPerSessionEvent: vi.fn(),
		},
		sessionService: {
			sendSessionLists: vi.fn(async () => {}),
			getSessionParentMap: () => new Map(),
		},
		processingTimeouts: {
			clearProcessingTimeout: vi.fn(),
			resetProcessingTimeout: vi.fn(),
		},
		statusPoller: {
			on: vi.fn((_event, callback) => {
				changed = callback;
			}),
			start: vi.fn(),
			stop: vi.fn(),
			drain: vi.fn(async () => {}),
			getCurrentStatuses: vi.fn(() => ({})),
			isProcessing: vi.fn(() => false),
			markMessageActivity: vi.fn(),
			clearMessageActivity: vi.fn(),
			notifySSEIdle: vi.fn(),
			reconcileNow: vi.fn(async () => {}),
		},
		pollerManager: {
			startPolling,
			stopPolling: vi.fn(),
		},
		sseStream: {
			isConnected: () => false,
		},
		config: {
			pollerGatingConfig: {
				sseGracePeriodMs: 0,
				sseActiveThresholdMs: 0,
			},
			slug: "test",
		},
		statusLog: createSilentLogger(),
		sseLog: createSilentLogger(),
		pipelineLog: createSilentLogger(),
	});

	return {
		result,
		messages,
		startPolling,
		getClientsForSession,
		resolveMessages: () => resolveMessages?.([]),
		emitStatus: async (message: Record<string, { type: "busy" | "idle" }>) => {
			await changed?.(message, false);
		},
	};
}

describe("wireMonitoring shutdown", () => {
	// The harnesses use a zero grace period, which expires only once the clock
	// has moved. Two ticks can read the same real millisecond, so give each
	// reading its own.
	beforeEach(() => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => ++now);
	});
	afterEach(() => vi.restoreAllMocks());

	it("assembles contexts only for non-settled sessions", async () => {
		const harness = createHarness();
		const idle = Object.fromEntries(
			Array.from({ length: 4000 }, (_, i) => [
				`idle-${i}`,
				{ type: "idle" as const },
			]),
		);
		await harness.emitStatus({ ...idle, active: { type: "busy" } });
		expect(harness.getClientsForSession.mock.calls).toEqual([["active"]]);
		expect([...harness.result.getMonitoringState().sessions.keys()]).toEqual([
			"active",
		]);
	});
	it("does not start a message poller after monitoring has stopped", async () => {
		const harness = createHarness();
		harness.result.setMonitoringState({
			sessions: new Map([
				["s1", { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 0 }],
			]),
		});

		await harness.emitStatus({ s1: { type: "busy" } });
		expect(harness.messages).toHaveBeenCalledWith("s1");

		harness.result.stopMonitoring();
		harness.resolveMessages();
		await flushPromises();

		expect(harness.startPolling).not.toHaveBeenCalled();
	});

	it("ignores status updates after monitoring has stopped", async () => {
		const harness = createHarness();
		harness.result.stopMonitoring();
		harness.result.setMonitoringState({
			sessions: new Map([
				["s1", { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 0 }],
			]),
		});

		await harness.emitStatus({ s1: { type: "busy" } });

		expect(harness.messages).not.toHaveBeenCalled();
		expect(harness.startPolling).not.toHaveBeenCalled();
	});

	it("effect-owned production wiring does not start a poller after monitoring has stopped", async () => {
		const harness = await createEffectHarness();
		harness.result.setMonitoringState({
			sessions: new Map([
				["s1", { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 0 }],
			]),
		});
		harness.emitStatus({ s1: { type: "busy" } });
		await flushPromises();
		expect(harness.messages).toHaveBeenCalledWith("s1");
		harness.result.stopMonitoring();
		harness.resolveMessages();
		await flushPromises();
		expect(harness.startPolling).not.toHaveBeenCalled();
	});

	it("production wiring assembles contexts only for candidates", async () => {
		const harness = await createEffectHarness();
		const idle = Object.fromEntries(
			Array.from({ length: 4000 }, (_, i) => [
				`idle-${i}`,
				{ type: "idle" as const },
			]),
		);
		harness.emitStatus({ ...idle, active: { type: "busy" } });
		await flushPromises();
		expect(harness.getClientsForSession.mock.calls).toEqual([["active"]]);
		expect([...harness.result.getMonitoringState().sessions.keys()]).toEqual([
			"active",
		]);
		harness.result.stopMonitoring();
	});

	it("handles later ticks while an earlier broadcast is pending", async () => {
		let releaseBroadcast: (() => void) | undefined;
		const broadcast = new Promise<void>((resolve) => {
			releaseBroadcast = resolve;
		});
		const harness = await createEffectHarness(() =>
			Effect.promise(() => broadcast),
		);
		harness.result.setMonitoringState({
			sessions: new Map([
				["s1", { phase: "busy-polling", busySince: 0, pollerStartedAt: 1 }],
			]),
		});
		harness.emitStatus({ s1: { type: "idle" } }, true);
		await flushPromises();
		harness.emitStatus({ s1: { type: "idle" } });
		await flushPromises();
		expect(harness.pollerEvents).toEqual(["stop:s1"]);
		expect(harness.delivered).toEqual(["done"]);
		releaseBroadcast?.();
		await flushPromises();
		expect(harness.delivered).toEqual(["done"]);
		expect(harness.result.getMonitoringState().sessions.size).toBe(0);
		harness.result.stopMonitoring();
	});

	it("drops a pending seed after a later idle tick and delivers done once", async () => {
		const harness = await createEffectHarness();
		harness.result.setMonitoringState({
			sessions: new Map([
				["s1", { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 0 }],
			]),
		});
		harness.emitStatus({ s1: { type: "busy" } });
		await flushPromises();
		expect(harness.messages).toHaveBeenCalledWith("s1");
		harness.emitStatus({ s1: { type: "idle" } });
		await flushPromises();
		expect(harness.pollerEvents).toEqual(["stop:s1"]);
		harness.resolveMessages();
		await flushPromises();
		expect(harness.pollerEvents).toEqual(["stop:s1"]);
		expect(harness.result.getMonitoringState().sessions.size).toBe(0);
		expect(harness.delivered).toEqual(["done"]);
		harness.emitStatus({ s1: { type: "idle" } });
		await flushPromises();
		expect(harness.delivered).toEqual(["done"]);
		harness.result.stopMonitoring();
	});

	it("stops B and broadcasts its completion while A's seed never resolves", async () => {
		const broadcast = vi.fn(() => Effect.void);
		const harness = await createEffectHarness(broadcast);
		harness.result.setMonitoringState({
			sessions: new Map([
				["A", { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 0 }],
				["B", { phase: "busy-polling", busySince: 0, pollerStartedAt: 1 }],
			]),
		});
		harness.emitStatus({ A: { type: "busy" }, B: { type: "busy" } });
		await flushPromises();
		expect(harness.messages).toHaveBeenCalledWith("A");
		harness.emitStatus({ A: { type: "busy" }, B: { type: "idle" } }, true);
		await flushPromises();
		expect(harness.pollerEvents).toEqual(["stop:B"]);
		expect(harness.delivered).toEqual(["done"]);
		expect(broadcast).toHaveBeenCalledOnce();
		expect(harness.result.getMonitoringState().sessions.has("B")).toBe(false);
		harness.result.stopMonitoring();
	});

	it("stops B in the same tick that starts A's never-resolving seed", async () => {
		const harness = await createEffectHarness();
		harness.result.setMonitoringState({
			sessions: new Map([
				["A", { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 0 }],
				["B", { phase: "busy-polling", busySince: 0, pollerStartedAt: 1 }],
			]),
		});
		harness.emitStatus({ A: { type: "busy" }, B: { type: "idle" } }, true);
		await flushPromises();
		expect(harness.messages).toHaveBeenCalledWith("A");
		expect(harness.pollerEvents).toEqual(["stop:B"]);
		expect(harness.delivered).toEqual(["done"]);
		harness.result.stopMonitoring();
	});

	it("drops an older busy snapshot that reaches reduction after a newer idle one", async () => {
		let releaseFirst: (() => void) | undefined;
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const broadcast = vi
			.fn(() => Effect.void)
			.mockImplementationOnce(() => Effect.promise(() => first));
		const harness = await createEffectHarness(broadcast);
		harness.result.setMonitoringState({
			sessions: new Map([
				["s1", { phase: "busy-polling", busySince: 0, pollerStartedAt: 1 }],
			]),
		});
		harness.emitStatus({ s1: { type: "busy" } }, true);
		await flushPromises();
		harness.emitStatus({ s1: { type: "idle" } }, true);
		await flushPromises();
		expect(harness.pollerEvents).toEqual(["stop:s1"]);
		expect(harness.delivered).toEqual(["done"]);
		releaseFirst?.();
		await flushPromises();
		expect(harness.pollerEvents).toEqual(["stop:s1"]);
		expect(harness.result.getMonitoringState().sessions.size).toBe(0);
		harness.result.stopMonitoring();
	});

	it("keeps a seed valid across continuing busy ticks", async () => {
		const harness = await createEffectHarness();
		harness.result.setMonitoringState({
			sessions: new Map([
				["s1", { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 0 }],
			]),
		});
		harness.emitStatus({ s1: { type: "busy" } });
		await flushPromises();
		harness.emitStatus({ s1: { type: "busy" } });
		await flushPromises();
		harness.resolveMessages();
		await flushPromises();
		expect(harness.pollerEvents).toEqual(["start:s1"]);
		expect(harness.messages).toHaveBeenCalledOnce();
		harness.result.stopMonitoring();
	});

	it("rejects an old seed after deletion and a new polling cycle", async () => {
		const harness = await createEffectHarness();
		harness.result.setMonitoringState({
			sessions: new Map([
				["s1", { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 0 }],
			]),
		});
		harness.emitStatus({ s1: { type: "busy" } });
		await flushPromises();
		harness.emitStatus({});
		await flushPromises();
		expect(harness.pollerEvents).toEqual(["stop:s1"]);
		expect(harness.delivered).toEqual(["done"]);
		// The next cycle can start while the old cycle's request is pending.
		harness.messages.mockResolvedValueOnce([]);
		harness.emitStatus({ s1: { type: "busy" } });
		await flushPromises();
		harness.emitStatus({ s1: { type: "busy" } });
		await flushPromises();
		expect(harness.pollerEvents).toEqual(["stop:s1", "start:s1"]);
		harness.resolveMessages();
		await flushPromises();
		expect(harness.pollerEvents).toEqual(["stop:s1", "start:s1"]);
		harness.result.stopMonitoring();
	});
});

async function createEffectHarness(sendSessionLists = () => Effect.void) {
	let changed: ChangedCallback | undefined;
	let resolveMessages: ((messages: []) => void) | undefined;
	const messages = vi.fn(
		() =>
			new Promise<[]>((resolve) => {
				resolveMessages = resolve;
			}),
	);
	const pollerEvents: string[] = [];
	const delivered: string[] = [];
	const startPolling = vi.fn((id: string) => {
		pollerEvents.push(`start:${id}`);
	});
	const getClientsForSession = vi.fn((_id: string): string[] => []);
	const unused = () => Effect.die("Unexpected service call");
	const layer = Layer.mergeAll(
		Layer.succeed(SessionManagerServiceTag, {
			initialize: unused,
			getDefaultSessionId: unused,
			getSessionFamily: unused,
			getLastKnownSessionCount: unused,
			listSessions: unused,
			createSession: unused,
			deleteSession: unused,
			renameSession: unused,
			markSessionRead: unused,
			markSessionUnread: unused,
			setSessionSettled: unused,
			setSessionPinned: unused,
			snoozeSession: unused,
			unsnoozeSession: unused,
			clearPaginationCursor: unused,
			seedPaginationCursor: unused,
			loadPreRenderedHistory: unused,
			recordMessageActivity: unused,
			addToParentMap: unused,
			incrementPendingQuestionCount: unused,
			decrementPendingQuestionCount: unused,
			setPendingQuestionCounts: unused,
			setForkEntry: unused,
			sendSessionLists,
			getSessionParentMap: () => Effect.succeed(new Map<string, string>()),
		}),
		Layer.succeed(StatusPollerTag, {
			on: (_event, callback) =>
				Effect.sync(() => {
					changed = callback;
				}),
			start: () => Effect.void,
			stop: unused,
			drain: unused,
			getCurrentStatuses: unused,
			isProcessing: unused,
			markMessageActivity: unused,
			clearMessageActivity: unused,
			notifySSEIdle: unused,
			reconcileNow: unused,
		}),
		makePollerStateLive(),
		makeOverridesStateLive(),
	);
	const result = await Effect.runPromise(
		wireMonitoringEffect({
			client: { session: { messages } },
			wsHandler: {
				broadcast: vi.fn(),
				sendToSession: (_id, message) => {
					if (message.type === "status") delivered.push(message.status);
				},
				getClientsForSession,
				broadcastPerSessionEvent: (_id, message) => {
					if (message.type === "done") delivered.push("done");
				},
			},
			pollerManager: {
				startPolling,
				stopPolling: (id) => {
					pollerEvents.push(`stop:${id}`);
				},
			},
			sseStream: { isConnected: () => false },
			config: {
				slug: "test",
				pollerGatingConfig: { sseGracePeriodMs: 0, sseActiveThresholdMs: 0 },
			},
			statusLog: createSilentLogger(),
			sseLog: createSilentLogger(),
			pipelineLog: createSilentLogger(),
		}).pipe(Effect.provide(layer)),
	);
	return {
		result,
		messages,
		startPolling,
		getClientsForSession,
		pollerEvents,
		delivered,
		resolveMessages: () => resolveMessages?.([]),
		emitStatus: (
			statuses: Record<string, { type: "busy" | "idle" }>,
			statusesChanged = false,
		) => changed?.(statuses, statusesChanged),
	};
}

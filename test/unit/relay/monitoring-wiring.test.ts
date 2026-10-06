import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import {
	Chunk,
	Effect,
	Layer,
	ManagedRuntime,
	PubSub,
	Queue,
	Scope,
} from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert } from "../../../src/lib/contracts/ws-rpc.js";
import { AlertLedgerLive } from "../../../src/lib/domain/relay/Services/alert-ledger.js";
import { AlertsTag } from "../../../src/lib/domain/relay/Services/alerts.js";
import { StatusPollerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	makePollerStateLive,
	type SessionStatusPollerService,
} from "../../../src/lib/domain/relay/Services/session-status-poller.js";
import type { Message } from "../../../src/lib/instance/sdk-types.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	wireMonitoring,
	wireMonitoringEffect,
} from "../../../src/lib/relay/monitoring-wiring.js";
import { sendPushForEventEffect } from "../../../src/lib/relay/sse-wiring.js";
import type { PushNotificationSender } from "../../../src/lib/server/push.js";

type ChangedCallback = Parameters<SessionStatusPollerService["on"]>[1];

const flushPromises = () =>
	new Promise<void>((resolve) => setImmediate(resolve));

function createHarness(
	parentMap = new Map<string, string>(),
	providers = new Map<string, string>(),
) {
	const broadcastPerSessionEvent = vi.fn();
	const clearProcessingTimeout = vi.fn();
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
	const broadcast = vi.fn();
	const publishAlert = vi.fn<(alert: Alert) => void>();

	const result = wireMonitoring({
		client: {
			session: { messages },
		},
		wsHandler: {
			broadcast,
			sendToSession: vi.fn(),
			getClientsForSession,
			broadcastPerSessionEvent,
		},
		sessionService: {
			pushViewerFamilies: vi.fn(async () => {}),
			getSessionParentMap: () => parentMap,
		},
		processingTimeouts: {
			clearProcessingTimeout,
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
			getSessionProviders: () => providers,
			isProcessing: vi.fn(() => false),
			markMessageActivity: vi.fn(),
			clearMessageActivity: vi.fn(),
			notifySSEIdle: vi.fn(),
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
		publishAlert,
	});

	return {
		broadcast,
		publishAlert,
		broadcastPerSessionEvent,
		clearProcessingTimeout,
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

it("broadcasts a synthetic root done when its session has no viewer", async () => {
	const harness = createHarness();
	harness.result.setMonitoringState({
		sessions: new Map([
			["root", { phase: "busy-polling", busySince: 0, pollerStartedAt: 1 }],
		]),
	});
	await harness.emitStatus({ root: { type: "idle" } });
	expect(harness.publishAlert).toHaveBeenCalledWith(
		expect.objectContaining({ _tag: "alert", kind: "done", sessionId: "root" }),
	);
});

it("uses the busy cycle to identify anonymous poller broadcasts", async () => {
	const harness = createHarness();
	for (const busySince of [101, 202]) {
		harness.result.setMonitoringState({
			sessions: new Map([
				[
					"root",
					{ phase: "busy-polling", busySince, pollerStartedAt: busySince },
				],
			]),
		});
		await harness.emitStatus({ root: { type: "idle" } });
	}
	expect(
		harness.publishAlert.mock.calls.map(([alert]) => alert.alertId),
	).toEqual(['["root","poller",101,"done"]', '["root","poller",202,"done"]']);
});

it("defers parent completion and synthetic done until its last busy child finishes", async () => {
	const harness = createHarness(new Map([["child", "parent"]]));
	await harness.emitStatus({
		parent: { type: "busy" },
		child: { type: "busy" },
	});
	await harness.emitStatus({
		parent: { type: "idle" },
		child: { type: "busy" },
	});
	expect(
		harness.result.getMonitoringState().sessions.get("parent")?.phase,
	).not.toBe("idle");
	expect(harness.broadcastPerSessionEvent).not.toHaveBeenCalledWith(
		"parent",
		expect.objectContaining({ type: "done" }),
	);
	expect(harness.clearProcessingTimeout).not.toHaveBeenCalledWith("parent");
	await harness.emitStatus({
		parent: { type: "idle" },
		child: { type: "idle" },
	});
	await harness.emitStatus({
		parent: { type: "idle" },
		child: { type: "idle" },
	});
	expect(
		harness.broadcastPerSessionEvent.mock.calls.filter(
			([id, event]) => id === "parent" && event.type === "done",
		),
	).toHaveLength(1);
});

describe("wireMonitoring shutdown", () => {
	// The harnesses use a zero grace period, which expires only once the clock
	// has moved. Two ticks can read the same real millisecond, so give each
	// reading its own.
	beforeEach(() => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => ++now);
	});
	afterEach(() => vi.restoreAllMocks());

	it.each([
		"opencode",
		"unknown",
		"",
	])("keeps polling for an OpenCode or unresolved provider: %s", async (provider) => {
		const harness = createHarness(new Map(), new Map([["s1", provider]]));
		await harness.emitStatus({ s1: { type: "busy" } });
		await harness.emitStatus({ s1: { type: "busy" } });
		expect(harness.messages).toHaveBeenCalledWith("s1");
		harness.result.stopMonitoring();
	});

	it("legacy wiring clears Claude idle state without emitting a done", async () => {
		const harness = createHarness(new Map(), new Map([["claude-1", "claude"]]));
		await harness.emitStatus({ "claude-1": { type: "busy" } });
		await harness.emitStatus({ "claude-1": { type: "busy" } });
		await harness.emitStatus({ "claude-1": { type: "idle" } });
		expect(harness.messages).not.toHaveBeenCalled();
		expect(harness.clearProcessingTimeout).toHaveBeenCalledWith("claude-1");
		expect(harness.broadcastPerSessionEvent).not.toHaveBeenCalled();
		expect(harness.publishAlert).not.toHaveBeenCalled();
		harness.result.stopMonitoring();
	});

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

	it("production wiring broadcasts a synthetic root done without a viewer", async () => {
		const harness = await createEffectHarness();
		harness.result.setMonitoringState({
			sessions: new Map([
				["root", { phase: "busy-polling", busySince: 0, pollerStartedAt: 1 }],
			]),
		});
		harness.emitStatus({ root: { type: "idle" } }, true);
		await flushPromises();
		expect(harness.alerts()).toContainEqual(
			expect.objectContaining({
				_tag: "alert",
				kind: "done",
				sessionId: "root",
			}),
		);
		harness.result.stopMonitoring();
	});

	it("production poller pushes a root completion once using the primary alert identity", async () => {
		const directory = mkdtempSync(join(tmpdir(), "conduit-poller-alert-"));
		const dbPath = join(directory, "events.db");
		const sendToAll = vi.fn(async () => ({
			delivered: ["device"],
			failed: [],
			expired: [],
		}));
		const pushManager = {
			getPublicKey: () => null,
			addSubscription: vi.fn(),
			removeSubscription: vi.fn(),
			sendToAll,
		};
		try {
			for (let relay = 0; relay < 2; relay++) {
				const harness = await createEffectHarness(
					() => Effect.void,
					pushManager,
					dbPath,
					relay === 0,
				);
				try {
					harness.result.setMonitoringState({
						sessions: new Map([
							[
								"root",
								{ phase: "busy-polling", busySince: 0, pollerStartedAt: 1 },
							],
						]),
					});
					harness.emitStatus({ root: { type: "idle" } });
					await flushPromises();
					if (!harness.runtime) throw new Error("Missing test runtime");
					await harness.runtime.runPromise(
						sendPushForEventEffect(
							pushManager,
							{
								type: "done",
								sessionId: "root",
								code: 0,
								alertId: '["root","message-1","done"]',
							},
							createSilentLogger(),
							{ sessionId: "root" },
						),
					);
					expect(sendToAll).toHaveBeenCalledOnce();
					expect(harness.alerts()).toContainEqual(
						expect.objectContaining({ alertId: '["root","message-1","done"]' }),
					);
				} finally {
					harness.result.stopMonitoring();
					await harness.dispose();
				}
			}
			expect(sendToAll).toHaveBeenCalledWith(
				expect.objectContaining({ alertId: '["root","message-1","done"]' }),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("matches a primary error completion whose origin is the event ID", async () => {
		const sendToAll = vi.fn(async () => ({
			delivered: ["device"],
			failed: [],
			expired: [],
		}));
		const pushManager = {
			getPublicKey: () => null,
			addSubscription: vi.fn(),
			removeSubscription: vi.fn(),
			sendToAll,
		};
		const harness = await createEffectHarness(() => Effect.void, pushManager);
		try {
			if (!harness.runtime) throw new Error("Missing test runtime");
			await harness.runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO events
						(event_id, session_id, stream_version, type, data, provider, created_at)
						VALUES ('error-event', 'root', 1, 'turn.error', '{"messageId":""}', 'opencode', 2)`;
				}),
			);
			harness.result.setMonitoringState({
				sessions: new Map([
					["root", { phase: "busy-polling", busySince: 1, pollerStartedAt: 1 }],
				]),
			});
			harness.emitStatus({ root: { type: "idle" } });
			await flushPromises();
			expect(sendToAll).toHaveBeenCalledWith(
				expect.objectContaining({ alertId: '["root","error-event","done"]' }),
			);
		} finally {
			harness.result.stopMonitoring();
			await harness.dispose();
		}
	});

	it("uses the provider message when the completion has not reached the store", async () => {
		const sendToAll = vi.fn(async () => ({
			delivered: ["device"],
			failed: [],
			expired: [],
		}));
		const pushManager = {
			getPublicKey: () => null,
			addSubscription: vi.fn(),
			removeSubscription: vi.fn(),
			sendToAll,
		};
		const harness = await createEffectHarness(() => Effect.void, pushManager);
		try {
			if (!harness.runtime) throw new Error("Missing test runtime");
			await harness.runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`DELETE FROM turns WHERE session_id = 'root'`;
				}),
			);
			harness.messages.mockResolvedValue([
				{ id: "provider-message", role: "assistant", sessionID: "root" },
			]);
			harness.result.setMonitoringState({
				sessions: new Map([
					["root", { phase: "busy-polling", busySince: 1, pollerStartedAt: 1 }],
				]),
			});
			harness.emitStatus({ root: { type: "idle" } });
			await vi.waitFor(() =>
				expect(sendToAll).toHaveBeenCalledWith(
					expect.objectContaining({
						alertId: '["root","provider-message","done"]',
					}),
				),
			);
			await harness.runtime.runPromise(
				sendPushForEventEffect(
					pushManager,
					{
						type: "done",
						sessionId: "root",
						code: 0,
						alertId: '["root","provider-message","done"]',
					},
					createSilentLogger(),
					{ sessionId: "root" },
				),
			);
			expect(sendToAll).toHaveBeenCalledOnce();
		} finally {
			harness.result.stopMonitoring();
			await harness.dispose();
		}
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

	it("never seeds an OpenCode message poller for a Claude-owned session", async () => {
		const pushManager = {
			getPublicKey: () => null,
			addSubscription: vi.fn(),
			removeSubscription: vi.fn(),
			sendToAll: vi.fn(async () => ({
				delivered: [],
				failed: [],
				expired: [],
			})),
		};
		const harness = await createEffectHarness(
			() => Effect.void,
			pushManager,
			":memory:",
			false,
		);
		try {
			await harness.runtime?.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO sessions (id, title, provider, created_at, updated_at)
						VALUES ('claude-1', 'c', 'claude', 1, 1)`;
				}),
			);
			// OpenCode answers 404 for sessions it does not own (live: NotFoundError).
			harness.messages.mockRejectedValue(
				new Error("Session not found: claude-1"),
			);
			harness.emitStatus({ "claude-1": { type: "busy" } });
			await flushPromises();
			harness.emitStatus({ "claude-1": { type: "busy" } });
			await flushPromises();
			expect(harness.messages).not.toHaveBeenCalled();
			expect(harness.delivered).toEqual(["processing"]);
			expect(harness.startPolling).not.toHaveBeenCalled();
			if (!harness.runtime) throw new Error("Missing test runtime");
			await harness.runtime.runPromise(
				startProcessingTimeout("claude-1", "1 minute", () => Effect.void),
			);
			expect(
				await harness.runtime.runPromise(
					hasActiveProcessingTimeout("claude-1"),
				),
			).toBe(true);
			harness.emitStatus({ "claude-1": { type: "idle" } });
			await flushPromises();
			expect(harness.delivered).toEqual(["processing"]);
			expect(harness.alerts()).toEqual([]);
			expect(pushManager.sendToAll).not.toHaveBeenCalled();
			expect(
				await harness.runtime.runPromise(
					hasActiveProcessingTimeout("claude-1"),
				),
			).toBe(false);
			expect(harness.result.getMonitoringState().sessions.size).toBe(0);
		} finally {
			harness.result.stopMonitoring();
			await harness.dispose();
		}
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

async function createEffectHarness(
	pushViewerFamilies = () => Effect.void,
	pushManager?: PushNotificationSender,
	dbPath = ":memory:",
	seedTurn = true,
) {
	let changed: ChangedCallback | undefined;
	let resolveMessages: ((messages: Message[]) => void) | undefined;
	const messages = vi.fn(
		() =>
			new Promise<Message[]>((resolve) => {
				resolveMessages = resolve;
			}),
	);
	const pollerEvents: string[] = [];
	const delivered: string[] = [];
	const startPolling = vi.fn((id: string) => {
		pollerEvents.push(`start:${id}`);
	});
	const getClientsForSession = vi.fn((_id: string): string[] => []);
	const alerts = Effect.runSync(PubSub.unbounded<Alert>());
	const alertsSeen = Effect.runSync(
		PubSub.subscribe(alerts).pipe(Scope.extend(Effect.runSync(Scope.make()))),
	);
	const unused = () => Effect.die("Unexpected service call");
	const getSessionProviders = vi.fn<
		SessionStatusPollerService["getSessionProviders"]
	>(() => Effect.succeed(new Map()));
	const layer = Layer.mergeAll(
		Layer.succeed(AlertsTag, alerts),
		Layer.succeed(SessionManagerServiceTag, {
			initialize: unused,
			getDefaultSessionId: unused,
			getSessionFamily: unused,
			getLastKnownSessionCount: unused,
			sessionExists: unused,
			listSessions: unused,
			establishOpenCodeSession: unused,
			createSession: unused,
			deleteSession: unused,
			renameSession: unused,
			markSessionRead: unused,
			markSessionUnread: unused,
			markSessionSeen: unused,
			setSessionSettled: unused,
			setSessionAutoSettleDisabled: unused,
			setSessionPinned: unused,
			snoozeSession: unused,
			unsnoozeSession: unused,
			loadPreRenderedHistory: unused,
			recordMessageActivity: unused,
			addToParentMap: unused,
			setForkEntry: unused,
			pushViewerFamilies,
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
			getSessionProviders,
			isProcessing: unused,
			markMessageActivity: unused,
			clearMessageActivity: unused,
			notifySSEIdle: unused,
		}),
		makePollerStateLive(),
		makeOverridesStateLive(),
	);
	const persistence = makePersistenceEffectLayer(dbPath);
	const monitoring = wireMonitoringEffect({
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
			...(pushManager && { pushManager }),
		},
		statusLog: createSilentLogger(),
		sseLog: createSilentLogger(),
		pipelineLog: createSilentLogger(),
	});
	const runtime = pushManager
		? ManagedRuntime.make(
				Layer.merge(layer, Layer.provideMerge(AlertLedgerLive, persistence)),
			)
		: undefined;
	const result = runtime
		? await runtime.runPromise(
				Effect.gen(function* () {
					const readQuery = yield* ReadQueryEffectTag;
					getSessionProviders.mockImplementation(() =>
						readQuery.getAllSessionStatusesWithProviders().pipe(
							Effect.map(
								(rows) => new Map(rows.map((row) => [row.id, row.provider])),
							),
							Effect.orDie,
						),
					);
					if (seedTurn) {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`INSERT INTO sessions (id, title, provider, created_at, updated_at)
							VALUES ('root', 'root', 'opencode', 1, 1)`;
						yield* sql`INSERT INTO turns (id, session_id, state, assistant_message_id, requested_at)
							VALUES ('turn-1', 'root', 'completed', 'message-1', 1)`;
					}
					return yield* monitoring;
				}),
			)
		: await Effect.runPromise(monitoring.pipe(Effect.provide(layer)));
	return {
		alerts: () => Chunk.toArray(Effect.runSync(Queue.takeAll(alertsSeen))),
		result,
		runtime,
		dispose: () => runtime?.dispose() ?? Promise.resolve(),
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

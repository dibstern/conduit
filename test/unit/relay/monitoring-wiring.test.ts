import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { Effect, Layer, ManagedRuntime, Option, PubSub, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import type { Alert } from "../../../src/lib/contracts/ws-rpc.js";
import {
	AccountDirectory,
	makeAccountDirectory,
} from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeUnavailable } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
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
import { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Message } from "../../../src/lib/instance/sdk-types.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	wireMonitoring,
	wireMonitoringEffect,
} from "../../../src/lib/relay/monitoring-wiring.js";
import { sendPushForEventEffect } from "../../../src/lib/relay/sse-wiring.js";
import { turnEndedAlert } from "../../../src/lib/relay/turn-ended-alert.js";
import type { PushNotificationSender } from "../../../src/lib/server/push.js";

type ChangedCallback = Parameters<SessionStatusPollerService["on"]>[1];

const flushPromises = () =>
	new Promise<void>((resolve) => setImmediate(resolve));

let isolatedRoot: string;
beforeEach(() => {
	isolatedRoot = mkdtempSync(join(tmpdir(), "conduit-monitor-login-"));
	vi.stubEnv("HOME", isolatedRoot);
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(isolatedRoot, "inherited-login"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(isolatedRoot, { recursive: true, force: true });
});
const accountDirectory = () =>
	makeAccountDirectory(
		Effect.succeed(
			accountsStateFromInstances(
				[
					{
						id: "personal",
						name: "Personal",
						driver: "claude",
						configDir: join(isolatedRoot, "personal-login"),
					},
					{ id: "opencode", name: "OpenCode", driver: "opencode" },
				],
				configuredClaudeConfigDir(join(isolatedRoot, "launch-login")),
			),
		),
	);

function createHarness(
	parentMap = new Map<string, string>(),
	providers = new Map<string, string>(),
) {
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
	const accounts = accountDirectory();

	const result = wireMonitoring({
		resolveAccount: (ref) =>
			Effect.runPromise(
				accounts
					.resolve(ref)
					.pipe(Effect.option, Effect.map(Option.getOrUndefined)),
			),
		client: {
			session: { messages },
		},
		wsHandler: {
			getClientsForSession,
		},
		sessionService: {
			refreshSessionLineage: vi.fn(async () => {}),
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
	});

	return {
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

it("uses the busy cycle to identify anonymous poller alerts", async () => {
	const harness = await createEffectHarness();
	const alertIds: string[] = [];
	for (const busySince of [101, 202]) {
		harness.result.setMonitoringState({
			sessions: new Map([
				[
					"root",
					{ phase: "busy-polling", busySince, pollerStartedAt: busySince },
				],
			]),
		});
		harness.emitStatus({ root: { type: "idle" } });
		await flushPromises();
		alertIds.push(...harness.alerts().map((alert) => alert.alertId));
	}
	expect(alertIds).toEqual([
		'["root","poller",101,"done"]',
		'["root","poller",202,"done"]',
	]);
	harness.result.stopMonitoring();
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
	expect(harness.clearProcessingTimeout).not.toHaveBeenCalledWith("parent");
	await harness.emitStatus({
		parent: { type: "idle" },
		child: { type: "idle" },
	});
	await harness.emitStatus({
		parent: { type: "idle" },
		child: { type: "idle" },
	});
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

	it("synchronous wiring clears Claude idle state", async () => {
		const harness = createHarness(
			new Map(),
			new Map([["claude-1", "claude-sdk"]]),
		);
		await harness.emitStatus({ "claude-1": { type: "busy" } });
		await harness.emitStatus({ "claude-1": { type: "busy" } });
		await harness.emitStatus({ "claude-1": { type: "idle" } });
		expect(harness.messages).not.toHaveBeenCalled();
		expect(harness.clearProcessingTimeout).toHaveBeenCalledWith("claude-1");
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

	it("holds later ticks until an earlier lineage refresh finishes", async () => {
		let releaseRefresh: (() => void) | undefined;
		const lineageRefresh = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const harness = await createEffectHarness(() =>
			Effect.promise(() => lineageRefresh),
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
		expect(harness.pollerEvents).toEqual([]);
		expect(harness.alerts()).toEqual([]);
		releaseRefresh?.();
		await flushPromises();
		expect(harness.pollerEvents).toEqual(["stop:s1"]);
		expect(harness.alerts().map((alert) => alert.kind)).toEqual(["done"]);
		expect(harness.result.getMonitoringState().sessions.size).toBe(0);
		harness.result.stopMonitoring();
	});

	it("drops a pending seed after a later idle tick and publishes one completion alert", async () => {
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
		expect(harness.alerts().map((alert) => alert.kind)).toEqual(["done"]);
		harness.emitStatus({ s1: { type: "idle" } });
		await flushPromises();
		expect(harness.alerts()).toEqual([]);
		harness.result.stopMonitoring();
	});

	it("production wiring publishes a synthetic completion alert without a viewer", async () => {
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
					const primary = turnEndedAlert(
						canonicalEvent("turn.completed", "root", {
							messageId: "message-1",
						}),
					);
					if (!primary) throw new Error("Missing turn-ended alert");
					await harness.runtime.runPromise(
						sendPushForEventEffect(pushManager, primary, createSilentLogger(), {
							sessionId: "root",
						}),
					);
					expect(sendToAll).toHaveBeenCalledOnce();
					expect(harness.alerts()).toContainEqual(
						expect.objectContaining({ alertId: primary.alertId }),
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

	it("stops B and publishes its completion alert while A's seed never resolves", async () => {
		const refreshSessionLineage = vi.fn(() => Effect.void);
		const harness = await createEffectHarness(refreshSessionLineage);
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
		expect(harness.alerts().map((alert) => alert.kind)).toEqual(["done"]);
		expect(refreshSessionLineage).toHaveBeenCalledOnce();
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
		expect(harness.alerts().map((alert) => alert.kind)).toEqual(["done"]);
		harness.result.stopMonitoring();
	});

	it("reports done for a busy tick whose lineage refresh outlasts the next idle tick", async () => {
		let releaseFirst: (() => void) | undefined;
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const refreshSessionLineage = vi
			.fn(() => Effect.void)
			.mockImplementationOnce(() => Effect.promise(() => first));
		const harness = await createEffectHarness(refreshSessionLineage);
		harness.emitStatus({ s1: { type: "busy" } }, true);
		await flushPromises();
		harness.emitStatus({ s1: { type: "idle" } }, true);
		await flushPromises();
		// The idle tick waits for the busy one rather than overtaking it.
		expect(harness.alerts()).toEqual([]);
		releaseFirst?.();
		await flushPromises();
		expect(harness.alerts().map((alert) => alert.kind)).toEqual(["done"]);
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
					yield* sql`INSERT INTO sessions (id, title, provider, created_at, updated_at, project_id)
						VALUES ('claude-1', 'c', 'claude-sdk', 1, 1, 'test-project')`;
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

	it("does not warn when poller seeding reaches a stopped OpenCode SDK client", async () => {
		const harness = await createEffectHarness();
		const unavailable = new OpenCodeUnavailable({
			instanceId: "stopped",
			reason: "not-running",
			message: "OpenCode is not running",
		});
		const fetch = vi.fn(() => Effect.runPromise(Effect.fail(unavailable)));
		const api = new OpenCodeAPI({
			sdk: createOpencodeClient({ baseUrl: "http://opencode.invalid", fetch }),
			baseUrl: "http://opencode.invalid",
			authHeaders: {},
		});
		harness.messages.mockImplementationOnce(() => api.session.messages("s1"));
		harness.result.setMonitoringState({
			sessions: new Map([
				["s1", { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 0 }],
			]),
		});
		try {
			harness.emitStatus({ s1: { type: "busy" } });
			await flushPromises();
			expect(harness.messages).toHaveBeenCalledWith("s1");
			expect(fetch).toHaveBeenCalledOnce();
			expect(harness.statusWarn).not.toHaveBeenCalled();
			expect(harness.startPolling).not.toHaveBeenCalled();
		} finally {
			harness.result.stopMonitoring();
		}
	});

	it("warns with the original error when poller seeding genuinely fails", async () => {
		const harness = await createEffectHarness();
		harness.messages.mockRejectedValueOnce(new Error("seed request failed"));
		harness.result.setMonitoringState({
			sessions: new Map([
				["s1", { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 0 }],
			]),
		});
		try {
			harness.emitStatus({ s1: { type: "busy" } });
			await flushPromises();
			expect(harness.messages).toHaveBeenCalledWith("s1");
			expect(harness.statusWarn).toHaveBeenCalledExactlyOnceWith(
				"Failed to seed poller for s1, will retry: seed request failed",
			);
			expect(harness.startPolling).not.toHaveBeenCalled();
		} finally {
			harness.result.stopMonitoring();
		}
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
		expect(harness.alerts().map((alert) => alert.kind)).toEqual(["done"]);
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
	refreshSessionLineage = () => Effect.void,
	pushManager?: PushNotificationSender,
	dbPath = ":memory:",
	seedTurn = true,
) {
	let changed: ChangedCallback | undefined;
	let resolveMessages: ((messages: Message[]) => void) | undefined;
	const messages = vi.fn(
		(_sessionId: string) =>
			new Promise<Message[]>((resolve) => {
				resolveMessages = resolve;
			}),
	);
	const pollerEvents: string[] = [];
	const startPolling = vi.fn((id: string) => {
		pollerEvents.push(`start:${id}`);
	});
	const getClientsForSession = vi.fn((_id: string): string[] => []);
	const alerts = Effect.runSync(PubSub.unbounded<Alert>());
	const alertsSeen = Effect.runSync(
		PubSub.subscribe(alerts).pipe(Scope.provide(Effect.runSync(Scope.make()))),
	);
	const unused = () => Effect.die("Unexpected service call");
	const getSessionProviders = vi.fn<
		SessionStatusPollerService["getSessionProviders"]
	>(() => Effect.succeed(new Map()));
	const layer = Layer.mergeAll(
		Layer.succeed(AccountDirectory)(accountDirectory()),
		Layer.succeed(AlertsTag)(alerts),
		Layer.succeed(SessionManagerServiceTag)({
			initialize: unused,
			getDefaultSessionId: unused,
			getLastKnownSessionCount: unused,
			sessionExists: unused,
			listSessions: unused,
			establishOpenCodeSession: unused,
			createSession: unused,
			deleteSession: unused,
			deleteArchivedSessions: unused,
			renameSession: unused,
			markSessionRead: unused,
			markSessionUnread: unused,
			markSessionSeen: unused,
			setSessionSettled: unused,
			setSessionArchived: unused,
			restoreSessionForSend: unused,
			setSessionAutoSettleDisabled: unused,
			setSessionPinned: unused,
			snoozeSession: unused,
			unsnoozeSession: unused,
			loadPreRenderedHistory: unused,
			recordMessageActivity: unused,
			addToParentMap: unused,
			setForkEntry: unused,
			refreshSessionLineage,
			getSessionParentMap: () => Effect.succeed(new Map<string, string>()),
		}),
		Layer.succeed(StatusPollerTag)({
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
	const persistence = makePersistenceEffectLayer(dbPath, "test-project");
	const statusLog = createSilentLogger();
	const statusWarn = vi.spyOn(statusLog, "warn");
	const monitoring = wireMonitoringEffect({
		readMessages: (sessionId) =>
			Effect.tryPromise({
				try: () => messages(sessionId),
				catch: (cause) => cause,
			}),
		wsHandler: {
			getClientsForSession,
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
		statusLog,
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
						readQuery
							.getAllSessionStatusesWithProviders({
								projectIds: ["test-project"],
							})
							.pipe(
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
		alerts: () => [
			...Effect.runSync(PubSub.takeUpTo(alertsSeen, Number.POSITIVE_INFINITY)),
		],
		result,
		runtime,
		dispose: () => runtime?.dispose() ?? Promise.resolve(),
		messages,
		statusWarn,
		startPolling,
		getClientsForSession,
		pollerEvents,
		resolveMessages: () => resolveMessages?.([]),
		emitStatus: (
			statuses: Record<string, { type: "busy" | "idle" }>,
			statusesChanged = false,
		) => changed?.(statuses, statusesChanged),
	};
}

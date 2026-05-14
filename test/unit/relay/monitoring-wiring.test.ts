import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
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

	const result = wireMonitoring({
		client: {
			session: { messages },
		},
		wsHandler: {
			broadcast: vi.fn(),
			sendToSession: vi.fn(),
			getClientsForSession: () => [],
			broadcastPerSessionEvent: vi.fn(),
		},
		sessionService: {
			sendDualSessionLists: vi.fn(async () => {}),
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
		resolveMessages: () => resolveMessages?.([]),
		emitStatus: async (message: Record<string, { type: "busy" | "idle" }>) => {
			await changed?.(message, false);
		},
	};
}

describe("wireMonitoring shutdown", () => {
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
		let changed: ChangedCallback | undefined;
		let resolveMessages: ((messages: []) => void) | undefined;
		const messages = vi.fn(
			() =>
				new Promise<[]>((resolve) => {
					resolveMessages = resolve;
				}),
		);
		const startPolling = vi.fn();
		const statusPoller = {
			on: vi.fn((_event, callback) =>
				Effect.sync(() => {
					changed = callback;
				}),
			),
			start: vi.fn(() => Effect.void),
		};
		const layer = Layer.mergeAll(
			Layer.succeed(SessionManagerServiceTag, {
				sendDualSessionLists: () => Effect.void,
				getSessionParentMap: () => Effect.succeed(new Map()),
			} as never),
			Layer.succeed(StatusPollerTag, statusPoller as never),
			makePollerStateLive(),
			makeOverridesStateLive(),
		);

		const result = await Effect.runPromise(
			wireMonitoringEffect({
				client: {
					session: { messages },
				},
				wsHandler: {
					broadcast: vi.fn(),
					sendToSession: vi.fn(),
					getClientsForSession: () => [],
					broadcastPerSessionEvent: vi.fn(),
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
			}).pipe(Effect.provide(layer)),
		);

		result.setMonitoringState({
			sessions: new Map([
				["s1", { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 0 }],
			]),
		});

		changed?.({ s1: { type: "busy" } }, false);
		await flushPromises();
		expect(messages).toHaveBeenCalledWith("s1");

		result.stopMonitoring();
		resolveMessages?.([]);
		await flushPromises();

		expect(startPolling).not.toHaveBeenCalled();
	});
});

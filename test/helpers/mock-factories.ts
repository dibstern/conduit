/**
 * Shared typed mock factories for test dependency objects.
 *
 * Eliminates `as unknown as` double-casts by providing fully-typed mocks
 * with sensible defaults for every field. Each factory accepts a
 * Partial<T> override to customize per-test.
 *
 * ## Effect Layer helpers
 *
 * Effect-based test helpers live at the bottom of this file. They compose
 * the service Tags from `src/lib/effect/services.ts` into reusable Layers
 * that can be used with `@effect/vitest`'s `it.effect` / `it.scoped`.
 *
 * Existing imperative helpers are preserved — many tests still depend on them.
 */
import { Layer } from "effect";
import { vi } from "vitest";
import type { ClientInitDeps } from "../../src/lib/bridges/client-init.js";
import type { PermissionBridge } from "../../src/lib/bridges/permission-bridge.js";
import type { QuestionBridge } from "../../src/lib/bridges/question-bridge.js";
import { DaemonEventBusLive } from "../../src/lib/effect/daemon-pubsub.js";
import {
	type DaemonState,
	makeDaemonStateLive,
} from "../../src/lib/effect/daemon-state.js";
import {
	type InstanceManagerConfig,
	makeInstanceManagerStateLive,
} from "../../src/lib/effect/instance-manager-service.js";
import { makePollerManagerStateLive } from "../../src/lib/effect/message-poller.js";
import { RateLimiterLive } from "../../src/lib/effect/rate-limiter-layer.js";
import {
	ConfigTag,
	type ConnectPtyUpstreamShape,
	ConnectPtyUpstreamTag,
	LoggerTag,
	OpenCodeAPITag,
	OpenCodeFileServiceLive,
	OpenCodeModelServiceLive,
	OpenCodeSettingsServiceLive,
	PermissionBridgeTag,
	type PollerManagerShape,
	PollerManagerTag,
	PtyManagerTag,
	QuestionBridgeTag,
	type SessionManagerShape,
	SessionManagerTag,
	SessionOverridesTag,
	type StatusPollerShape,
	StatusPollerTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../src/lib/effect/services.js";
import {
	makeSessionManagerStateLive,
	type SessionManagerState,
} from "../../src/lib/effect/session-manager-state.js";
import { makeSessionRegistryStateLive } from "../../src/lib/effect/session-registry-state.js";
import { makePollerStateLive } from "../../src/lib/effect/session-status-poller.js";
import type { HandlerDeps } from "../../src/lib/handlers/types.js";
import type { OpenCodeAPI } from "../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../src/lib/logger.js";
import { createSilentLogger } from "../../src/lib/logger.js";
import type { OrchestrationLayer } from "../../src/lib/provider/orchestration-wiring.js";
import type { PtyManager } from "../../src/lib/relay/pty-manager.js";
import type { ProjectRelay } from "../../src/lib/relay/relay-stack.js";
import type { SSEWiringDeps } from "../../src/lib/relay/sse-wiring.js";
import type { SessionOverrides } from "../../src/lib/session/session-overrides.js";
import type { ProjectRelayConfig, RelayMessage } from "../../src/lib/types.js";

// ─── Sub-component factories ────────────────────────────────────────────────

function createMockWsHandlerFull(): HandlerDeps["wsHandler"] {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(),
		getClientsForSession: vi.fn().mockReturnValue([]),
		sendToSession: vi.fn(),
	};
}

function createMockClient(): HandlerDeps["client"] {
	// Structured to match OpenCodeAPI's namespace shape.
	// The cast is contained here so no test file needs it.
	return {
		session: {
			list: vi.fn().mockResolvedValue([]),
			get: vi.fn().mockResolvedValue({
				id: "s1",
				modelID: "gpt-4",
				providerID: "openai",
			}),
			create: vi.fn().mockResolvedValue({ id: "session-new" }),
			delete: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			statuses: vi.fn().mockResolvedValue({}),
			messages: vi.fn().mockResolvedValue([]),
			messagesPage: vi.fn().mockResolvedValue([]),
			message: vi.fn().mockResolvedValue({ id: "msg-1", time: { created: 0 } }),
			prompt: vi.fn().mockResolvedValue(undefined),
			abort: vi.fn().mockResolvedValue(undefined),
			fork: vi.fn().mockResolvedValue({ id: "ses_forked" }),
			revert: vi.fn().mockResolvedValue(undefined),
			unrevert: vi.fn().mockResolvedValue(undefined),
			share: vi.fn().mockResolvedValue(undefined),
			summarize: vi.fn().mockResolvedValue(undefined),
			diff: vi.fn().mockResolvedValue(undefined),
			children: vi.fn().mockResolvedValue([]),
		},
		permission: {
			list: vi.fn().mockResolvedValue([]),
			reply: vi.fn().mockResolvedValue(undefined),
		},
		question: {
			list: vi.fn().mockResolvedValue([]),
			reply: vi.fn().mockResolvedValue(undefined),
			reject: vi.fn().mockResolvedValue(undefined),
		},
		config: {
			get: vi.fn().mockResolvedValue({}),
			update: vi.fn().mockResolvedValue({}),
		},
		provider: {
			list: vi.fn().mockResolvedValue({
				providers: [],
				defaults: {},
				connected: [],
			}),
		},
		pty: {
			list: vi.fn().mockResolvedValue([]),
			create: vi
				.fn()
				.mockResolvedValue({ id: "pty-1", title: "Terminal", pid: 42 }),
			delete: vi.fn().mockResolvedValue(undefined),
			resize: vi.fn().mockResolvedValue(undefined),
		},
		file: {
			list: vi.fn().mockResolvedValue([]),
			read: vi
				.fn()
				.mockResolvedValue({ content: "file content", binary: false }),
			status: vi.fn().mockResolvedValue({}),
		},
		find: {
			text: vi.fn().mockResolvedValue([]),
			files: vi.fn().mockResolvedValue([]),
			symbols: vi.fn().mockResolvedValue([]),
		},
		app: {
			agents: vi.fn().mockResolvedValue([]),
			commands: vi.fn().mockResolvedValue([]),
			skills: vi.fn().mockResolvedValue([]),
			path: vi.fn().mockResolvedValue(""),
			vcs: vi.fn().mockResolvedValue({}),
			projects: vi.fn().mockResolvedValue([]),
			currentProject: vi.fn().mockResolvedValue({}),
		},
		event: {
			subscribe: vi
				.fn()
				.mockResolvedValue({ stream: (async function* () {})() }),
		},
		getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
		getAuthHeaders: vi.fn().mockReturnValue({}),
	} as unknown as HandlerDeps["client"];
}

function createMockSessionMgr(): HandlerDeps["sessionMgr"] {
	return {
		getDefaultSessionId: vi.fn().mockResolvedValue("session-1"),
		createSession: vi.fn().mockResolvedValue({ id: "session-new" }),
		deleteSession: vi.fn().mockResolvedValue(undefined),
		renameSession: vi.fn().mockResolvedValue(undefined),
		listSessions: vi
			.fn()
			.mockResolvedValue([
				{ id: "s1", title: "Session 1", updatedAt: 0, messageCount: 0 },
			]),
		sendDualSessionLists: vi.fn().mockImplementation(async (send) => {
			send({
				type: "session_list",
				sessions: [
					{ id: "s1", title: "Session 1", updatedAt: 0, messageCount: 0 },
				],
				roots: true,
			});
			send({
				type: "session_list",
				sessions: [
					{ id: "s1", title: "Session 1", updatedAt: 0, messageCount: 0 },
				],
				roots: false,
			});
		}),
		searchSessions: vi.fn().mockResolvedValue([]),
		loadHistory: vi.fn().mockResolvedValue({
			messages: [],
			hasMore: false,
			total: 0,
		}),
		loadPreRenderedHistory: vi.fn().mockResolvedValue({
			messages: [],
			hasMore: false,
			total: 0,
		}),
		recordMessageActivity: vi.fn(),
		getSessionParentMap: vi.fn().mockReturnValue(new Map()),
		getLastMessageAtMap: vi.fn().mockReturnValue(new Map()),
		getLastKnownSessionCount: vi.fn().mockReturnValue(0),
		initialize: vi.fn().mockResolvedValue("session-1"),
		incrementPendingQuestionCount: vi.fn(),
		decrementPendingQuestionCount: vi.fn(),
		setPendingQuestionCounts: vi.fn(),
		clearPaginationCursor: vi.fn(),
		seedPaginationCursor: vi.fn(),
		getForkEntry: vi.fn().mockReturnValue(undefined),
		setForkEntry: vi.fn(),
		addToParentMap: vi.fn(),
		on: vi.fn().mockReturnThis(),
	} as unknown as HandlerDeps["sessionMgr"];
}

function createMockPermissionBridge(): HandlerDeps["permissionBridge"] {
	return {
		onPermissionResponse: vi.fn().mockReturnValue(null),
		onPermissionRequest: vi.fn(),
		onPermissionReplied: vi.fn(),
		getPending: vi.fn().mockReturnValue([]),
		checkTimeouts: vi.fn().mockReturnValue([]),
		findPendingForSession: vi.fn().mockReturnValue([]),
		recoverPending: vi.fn(),
	} as unknown as HandlerDeps["permissionBridge"];
}

function createMockQuestionBridge(): HandlerDeps["questionBridge"] {
	return {
		trackPending: vi.fn(),
		onResolved: vi.fn().mockReturnValue(false),
		getPending: vi.fn().mockReturnValue([]),
		size: 0,
	} as unknown as HandlerDeps["questionBridge"];
}

function createMockOverrides(): HandlerDeps["overrides"] {
	return {
		agent: undefined,
		model: undefined,
		variant: "",
		contextWindow: "",
		defaultModel: undefined,
		defaultVariant: "",
		defaultContextWindow: "",
		modelUserSelected: false,
		setAgent: vi.fn(),
		setModel: vi.fn(),
		setModelDefault: vi.fn(),
		setDefaultModel: vi.fn(),
		setVariant: vi.fn(),
		setContextWindow: vi.fn(),
		getModel: vi.fn().mockReturnValue(undefined),
		getAgent: vi.fn().mockReturnValue(undefined),
		clearAgent: vi.fn(),
		getVariant: vi.fn().mockReturnValue(""),
		getContextWindow: vi.fn().mockReturnValue(""),
		isModelUserSelected: vi.fn().mockReturnValue(false),
		clear: vi.fn(),
		clearSession: vi.fn(),
		startProcessingTimeout: vi.fn(),
		clearProcessingTimeout: vi.fn(),
		resetProcessingTimeout: vi.fn(),
		hasActiveProcessingTimeout: vi.fn().mockReturnValue(false),
		dispose: vi.fn(),
	} as unknown as HandlerDeps["overrides"];
}

function createMockPtyManager(): HandlerDeps["ptyManager"] {
	return {
		sendInput: vi.fn(),
		closeSession: vi.fn(),
		hasSession: vi.fn().mockReturnValue(false),
		listSessions: vi.fn().mockReturnValue([]),
		getScrollback: vi.fn().mockReturnValue(""),
		getSession: vi.fn().mockReturnValue(undefined),
		registerSession: vi.fn(),
		sessionCount: 0,
	} as unknown as HandlerDeps["ptyManager"];
}

function createMockConfig(): HandlerDeps["config"] {
	return {
		httpServer: {} as HandlerDeps["config"]["httpServer"],
		opencodeUrl: "http://localhost:4096",
		projectDir: "/test/project",
		slug: "test-project",
	} as unknown as HandlerDeps["config"];
}

function createMockTranslator(): SSEWiringDeps["translator"] {
	return {
		translate: vi.fn().mockReturnValue({ ok: false, reason: "mock" }),
		reset: vi.fn(),
		getSeenParts: vi.fn().mockReturnValue(new Map()),
		rebuildStateFromHistory: vi.fn(),
	} as SSEWiringDeps["translator"];
}

// ─── Top-level factories ────────────────────────────────────────────────────

export function createMockHandlerDeps(
	overrides?: Partial<HandlerDeps>,
): HandlerDeps {
	return {
		wsHandler: createMockWsHandlerFull(),
		client: createMockClient(),
		sessionMgr: createMockSessionMgr(),
		permissionBridge: createMockPermissionBridge(),
		questionBridge: createMockQuestionBridge(),
		overrides: createMockOverrides(),
		ptyManager: createMockPtyManager(),
		config: createMockConfig(),
		log: createSilentLogger(),
		connectPtyUpstream: vi.fn().mockResolvedValue(undefined),
		statusPoller: {
			isProcessing: vi.fn().mockReturnValue(false),
		},
		registry: {
			hasViewers: vi.fn().mockReturnValue(false),
			addViewer: vi.fn(),
			removeClient: vi.fn(),
		} as unknown as HandlerDeps["registry"],
		pollerManager: {
			isPolling: vi.fn().mockReturnValue(true),
			startPolling: vi.fn(),
			stopPolling: vi.fn(),
		},
		...overrides,
	};
}

export function createMockSSEWiringDeps(
	overrides?: Partial<SSEWiringDeps>,
): SSEWiringDeps {
	return {
		translator: createMockTranslator(),
		sessionMgr:
			createMockSessionMgr() as unknown as SSEWiringDeps["sessionMgr"],
		permissionBridge:
			createMockPermissionBridge() as unknown as SSEWiringDeps["permissionBridge"],
		overrides: createMockOverrides() as unknown as SSEWiringDeps["overrides"],
		wsHandler: {
			broadcast: vi.fn(),
			sendToSession: vi.fn(),
			getClientsForSession: vi.fn().mockReturnValue(["c1"]),
			broadcastPerSessionEvent: vi.fn(),
		},
		log: createSilentLogger(),
		pipelineLog: createSilentLogger(),
		slug: "test-project",
		...overrides,
	};
}

export function createMockClientInitDeps(
	overrides?: Partial<ClientInitDeps>,
): ClientInitDeps {
	return {
		wsHandler: {
			broadcast: vi.fn(),
			sendTo: vi.fn(),
			setClientSession: vi.fn(),
			markClientBootstrapped: vi.fn(),
		},
		client: createMockClient() as unknown as ClientInitDeps["client"],
		sessionMgr:
			createMockSessionMgr() as unknown as ClientInitDeps["sessionMgr"],
		overrides: createMockOverrides() as unknown as ClientInitDeps["overrides"],
		ptyManager:
			createMockPtyManager() as unknown as ClientInitDeps["ptyManager"],
		permissionBridge: {
			getPending: vi.fn().mockReturnValue([]),
			recoverPending: vi.fn().mockReturnValue([]),
		},
		log: createSilentLogger(),
		...overrides,
	};
}

// ─── ProjectRelay mock factory ──────────────────────────────────────────────

export function createMockProjectRelay(
	overrides?: Partial<ProjectRelay>,
): ProjectRelay {
	return {
		wsHandler:
			createMockWsHandlerFull() as unknown as ProjectRelay["wsHandler"],
		sseStream: {
			connect: vi.fn(),
			disconnect: vi.fn(),
		} as unknown as ProjectRelay["sseStream"],
		client: createMockClient() as unknown as ProjectRelay["client"],
		sessionMgr: createMockSessionMgr() as unknown as ProjectRelay["sessionMgr"],
		translator: {} as unknown as ProjectRelay["translator"],
		permissionBridge:
			createMockPermissionBridge() as unknown as ProjectRelay["permissionBridge"],
		orchestration: {
			engine: {
				dispatch: vi.fn().mockResolvedValue({
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				}),
				bindSession: vi.fn(),
				unbindSession: vi.fn(),
				getProviderForSession: vi.fn().mockReturnValue(undefined),
				listBoundSessions: vi.fn().mockReturnValue([]),
				shutdown: vi.fn().mockResolvedValue(undefined),
			},
			registry: {} as OrchestrationLayer["registry"],
			adapter: {} as OrchestrationLayer["adapter"],
			wireSSEToAdapter: vi.fn(),
		} as unknown as OrchestrationLayer,
		effectRuntime: {
			runtime: {} as ProjectRelay["effectRuntime"]["runtime"],
			dispose: vi.fn().mockResolvedValue(undefined),
		},
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

// ═══════════════════════════════════════════════════════════════════════════
// Effect Layer Test Helpers
// ═══════════════════════════════════════════════════════════════════════════
//
// These helpers compose the Effect service Tags from src/lib/effect/services.ts
// into reusable Layers for @effect/vitest tests. They complement (not replace)
// the imperative factories above.
//
// Usage with @effect/vitest:
//
//   import { describe, it } from "@effect/vitest";
//   import { Effect, Layer } from "effect";
//   import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";
//
//   it.effect("my test", () => {
//     const mockApi = makeMockOpenCodeAPI();
//     return Effect.gen(function* () {
//       // ... test logic using Effect service Tags ...
//     }).pipe(Effect.provide(Layer.fresh(makeTestHandlerLayer({ api: mockApi }))));
//   });
//
// ═══════════════════════════════════════════════════════════════════════════

// ─── Effect mock service factories ─────────────────────────────────────────
// Each returns a minimal mock that satisfies its service Tag's type.

/** Create a mock OpenCodeAPI for Effect tests. */
export function makeMockOpenCodeAPI(
	overrides?: Partial<OpenCodeAPI>,
): OpenCodeAPI {
	return {
		session: {
			list: vi.fn(async () => []),
			get: vi.fn(async () => ({
				id: "s1",
				modelID: "gpt-4",
				providerID: "openai",
			})),
			create: vi.fn(async () => ({ id: "session-new" })),
			delete: vi.fn(async () => undefined),
			update: vi.fn(async () => undefined),
			statuses: vi.fn(async () => ({})),
			messages: vi.fn(async () => []),
			messagesPage: vi.fn(async () => []),
			message: vi.fn(async () => ({ id: "msg-1", time: { created: 0 } })),
			prompt: vi.fn(async () => undefined),
			abort: vi.fn(async () => undefined),
			fork: vi.fn(async () => ({ id: "ses_forked" })),
			revert: vi.fn(async () => undefined),
			unrevert: vi.fn(async () => undefined),
			share: vi.fn(async () => undefined),
			summarize: vi.fn(async () => undefined),
			diff: vi.fn(async () => undefined),
			children: vi.fn(async () => []),
		},
		permission: {
			list: vi.fn(async () => []),
			reply: vi.fn(async () => undefined),
		},
		question: {
			list: vi.fn(async () => []),
			reply: vi.fn(async () => undefined),
			reject: vi.fn(async () => undefined),
		},
		config: {
			get: vi.fn(async () => ({})),
			update: vi.fn(async () => ({})),
		},
		provider: {
			list: vi.fn(async () => ({
				providers: [],
				defaults: {},
				connected: [],
			})),
		},
		pty: {
			list: vi.fn(async () => []),
			create: vi.fn(async () => ({ id: "pty-1", title: "Terminal", pid: 42 })),
			delete: vi.fn(async () => undefined),
			resize: vi.fn(async () => undefined),
		},
		file: {
			list: vi.fn(async () => []),
			read: vi.fn(async () => ({ content: "file content", binary: false })),
			status: vi.fn(async () => ({})),
		},
		find: {
			text: vi.fn(async () => []),
			files: vi.fn(async () => []),
			symbols: vi.fn(async () => []),
		},
		app: {
			agents: vi.fn(async () => []),
			commands: vi.fn(async () => []),
			skills: vi.fn(async () => []),
			path: vi.fn(async () => ""),
			vcs: vi.fn(async () => ({})),
			projects: vi.fn(async () => []),
			currentProject: vi.fn(async () => ({})),
		},
		event: {
			subscribe: vi.fn(async () => ({
				stream: (async function* (): AsyncGenerator<never, void, unknown> {})(),
			})),
		},
		getBaseUrl: vi.fn(() => "http://localhost:4096"),
		getAuthHeaders: vi.fn(() => ({})),
		...overrides,
	} as unknown as OpenCodeAPI;
}

/** Create a mock WebSocketHandlerShape for Effect tests. */
export function makeMockWebSocketHandler(
	overrides?: Partial<WebSocketHandlerShape>,
): WebSocketHandlerShape {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => undefined),
		getClientsForSession: vi.fn(() => []),
		sendToSession: vi.fn(),
		broadcastPerSessionEvent: vi.fn(),
		markClientBootstrapped: vi.fn(),
		getClientCount: vi.fn(() => 0),
		getClientIds: vi.fn(() => []),
		handleUpgrade: vi.fn(),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
		on: vi.fn(),
		once: vi.fn(),
		...overrides,
	};
}

export type RecordedWebSocketCall =
	| {
			readonly channel: "broadcast";
			readonly message: RelayMessage;
	  }
	| {
			readonly channel: "sendTo";
			readonly clientId: string;
			readonly message: RelayMessage;
	  }
	| {
			readonly channel: "sendToSession";
			readonly sessionId: string;
			readonly message: RelayMessage;
	  }
	| {
			readonly channel: "broadcastPerSessionEvent";
			readonly sessionId: string;
			readonly message: RelayMessage;
	  };

/** Create a WebSocket handler mock that records outbound envelopes. */
export function makeRecordingWebSocketHandler(
	overrides?: Partial<WebSocketHandlerShape>,
): {
	readonly wsHandler: WebSocketHandlerShape;
	readonly calls: RecordedWebSocketCall[];
} {
	const calls: RecordedWebSocketCall[] = [];
	const onBroadcast = overrides?.broadcast;
	const onSendTo = overrides?.sendTo;
	const onSendToSession = overrides?.sendToSession;
	const onBroadcastPerSessionEvent = overrides?.broadcastPerSessionEvent;

	return {
		calls,
		wsHandler: makeMockWebSocketHandler({
			...overrides,
			broadcast: vi.fn((message: RelayMessage) => {
				calls.push({ channel: "broadcast", message });
				onBroadcast?.(message);
			}),
			sendTo: vi.fn((clientId: string, message: RelayMessage) => {
				calls.push({ channel: "sendTo", clientId, message });
				onSendTo?.(clientId, message);
			}),
			sendToSession: vi.fn((sessionId: string, message: RelayMessage) => {
				calls.push({ channel: "sendToSession", sessionId, message });
				onSendToSession?.(sessionId, message);
			}),
			broadcastPerSessionEvent: vi.fn(
				(sessionId: string, message: RelayMessage) => {
					calls.push({
						channel: "broadcastPerSessionEvent",
						sessionId,
						message,
					});
					onBroadcastPerSessionEvent?.(sessionId, message);
				},
			),
		}),
	};
}

/** Create a mock SessionManagerShape for Effect tests. */
export function makeMockSessionManagerShape(
	overrides?: Partial<SessionManagerShape>,
): SessionManagerShape {
	return {
		getDefaultSessionId: vi.fn(async () => "session-1"),
		createSession: vi.fn(async () => ({ id: "session-new" })),
		deleteSession: vi.fn(async () => undefined),
		renameSession: vi.fn(async () => undefined),
		listSessions: vi.fn(async () => [
			{ id: "s1", title: "Session 1", updatedAt: 0, messageCount: 0 },
		]),
		sendDualSessionLists: vi.fn(async (send) => {
			send({
				type: "session_list",
				sessions: [
					{ id: "s1", title: "Session 1", updatedAt: 0, messageCount: 0 },
				],
				roots: true,
			});
		}),
		searchSessions: vi.fn(async () => []),
		loadPreRenderedHistory: vi.fn(async () => ({
			messages: [],
			hasMore: false,
			total: 0,
		})),
		recordMessageActivity: vi.fn(),
		getSessionParentMap: vi.fn(() => new Map()),
		getLastMessageAtMap: vi.fn(() => new Map()),
		getLastKnownSessionCount: vi.fn(() => 0),
		initialize: vi.fn(async () => "session-1"),
		incrementPendingQuestionCount: vi.fn(),
		decrementPendingQuestionCount: vi.fn(),
		setPendingQuestionCounts: vi.fn(),
		clearPaginationCursor: vi.fn(),
		seedPaginationCursor: vi.fn(),
		getForkEntry: vi.fn(() => undefined),
		setForkEntry: vi.fn(),
		addToParentMap: vi.fn(),
		on: vi.fn().mockReturnThis(),
		...overrides,
	} as unknown as SessionManagerShape;
}

/** Create a mock Logger for Effect tests. */
export function makeMockLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger;
}

/** Create a mock SessionOverrides for Effect tests. */
export function makeMockSessionOverrides(
	overrides?: Partial<SessionOverrides>,
): SessionOverrides {
	return {
		agent: undefined,
		model: undefined,
		variant: "",
		contextWindow: "",
		defaultModel: undefined,
		defaultVariant: "",
		defaultContextWindow: "",
		modelUserSelected: false,
		setAgent: vi.fn(),
		setModel: vi.fn(),
		setModelDefault: vi.fn(),
		setDefaultModel: vi.fn(),
		setVariant: vi.fn(),
		setContextWindow: vi.fn(),
		getModel: vi.fn(() => undefined),
		getAgent: vi.fn(() => undefined),
		getVariant: vi.fn(() => ""),
		getContextWindow: vi.fn(() => ""),
		isModelUserSelected: vi.fn(() => false),
		clear: vi.fn(),
		clearSession: vi.fn(),
		startProcessingTimeout: vi.fn(),
		clearProcessingTimeout: vi.fn(),
		resetProcessingTimeout: vi.fn(),
		hasActiveProcessingTimeout: vi.fn(() => false),
		dispose: vi.fn(),
		...overrides,
	} as unknown as SessionOverrides;
}

/** Create a mock PermissionBridge for Effect tests. */
export function makeMockPermissionBridge(
	overrides?: Partial<PermissionBridge>,
): PermissionBridge {
	return {
		onPermissionResponse: vi.fn(() => null),
		onPermissionRequest: vi.fn(),
		onPermissionReplied: vi.fn(),
		getPending: vi.fn(() => []),
		checkTimeouts: vi.fn(() => []),
		findPendingForSession: vi.fn(() => []),
		recoverPending: vi.fn(),
		...overrides,
	} as unknown as PermissionBridge;
}

/** Create a mock QuestionBridge for Effect tests. */
export function makeMockQuestionBridge(
	overrides?: Partial<QuestionBridge>,
): QuestionBridge {
	return {
		trackPending: vi.fn(),
		onResolved: vi.fn(() => false),
		getPending: vi.fn(() => []),
		size: 0,
		...overrides,
	} as unknown as QuestionBridge;
}

/** Create a mock PtyManager for Effect tests. */
export function makeMockPtyManager(
	overrides?: Partial<PtyManager>,
): PtyManager {
	return {
		sendInput: vi.fn(),
		closeSession: vi.fn(),
		hasSession: vi.fn(() => false),
		listSessions: vi.fn(() => []),
		getScrollback: vi.fn(() => ""),
		getSession: vi.fn(() => undefined),
		registerSession: vi.fn(),
		sessionCount: 0,
		...overrides,
	} as unknown as PtyManager;
}

/** Create a mock ProjectRelayConfig for Effect tests. */
export function makeMockConfig(
	overrides?: Partial<ProjectRelayConfig>,
): ProjectRelayConfig {
	return {
		httpServer: {} as ProjectRelayConfig["httpServer"],
		opencodeUrl: "http://localhost:4096",
		projectDir: "/test/project",
		slug: "test-project",
		...overrides,
	} as unknown as ProjectRelayConfig;
}

// ─── Effect Layer composers ────────────────────────────────────────────────

/**
 * Options for building the handler-level test Layer.
 * Every field is optional — defaults are used for omitted fields.
 */
export interface TestHandlerLayerOptions {
	api?: OpenCodeAPI;
	wsHandler?: WebSocketHandlerShape;
	sessionMgr?: SessionManagerShape;
	overrides?: SessionOverrides;
	permissionBridge?: PermissionBridge;
	questionBridge?: QuestionBridge;
	ptyManager?: PtyManager;
	config?: ProjectRelayConfig;
	log?: Logger;
	statusPoller?: StatusPollerShape;
	pollerManager?: PollerManagerShape;
	connectPtyUpstream?: ConnectPtyUpstreamShape;
}

/**
 * Build a composed Layer providing all core handler service Tags.
 *
 * Intended for `it.effect` tests that exercise Effect handlers. Each service
 * gets a vi.fn()-backed mock by default; pass overrides to customise.
 *
 * Usage:
 *   const layer = makeTestHandlerLayer({ api: myMockApi });
 *   return myEffect.pipe(Effect.provide(Layer.fresh(layer)));
 */
export function makeTestHandlerLayer(
	opts?: TestHandlerLayerOptions,
	// biome-ignore lint/suspicious/noExplicitAny: Layer type union is too wide to spell out
): Layer.Layer<any> {
	const api = opts?.api ?? makeMockOpenCodeAPI();
	const wsHandler = opts?.wsHandler ?? makeMockWebSocketHandler();
	const sessionMgr = opts?.sessionMgr ?? makeMockSessionManagerShape();
	const sessionOverrides = opts?.overrides ?? makeMockSessionOverrides();
	const permissionBridge = opts?.permissionBridge ?? makeMockPermissionBridge();
	const questionBridge = opts?.questionBridge ?? makeMockQuestionBridge();
	const ptyManager = opts?.ptyManager ?? makeMockPtyManager();
	const config = opts?.config ?? makeMockConfig();
	const log = opts?.log ?? makeMockLogger();
	const statusPoller: StatusPollerShape = opts?.statusPoller ?? {
		isProcessing: vi.fn(() => false),
		clearMessageActivity: vi.fn(),
	};
	const pollerManager: PollerManagerShape = opts?.pollerManager ?? {
		isPolling: vi.fn(() => true),
		startPolling: vi.fn(),
		stopPolling: vi.fn(),
	};
	const connectPtyUpstream: ConnectPtyUpstreamShape =
		opts?.connectPtyUpstream ?? vi.fn(async () => undefined);
	const openCodeApiLayer = Layer.succeed(OpenCodeAPITag, api);
	const openCodeFileServiceLayer = OpenCodeFileServiceLive.pipe(
		Layer.provide(openCodeApiLayer),
	);
	const openCodeModelServiceLayer = OpenCodeModelServiceLive.pipe(
		Layer.provide(openCodeApiLayer),
	);
	const openCodeSettingsServiceLayer = OpenCodeSettingsServiceLive.pipe(
		Layer.provide(openCodeApiLayer),
	);

	return Layer.mergeAll(
		openCodeApiLayer,
		openCodeFileServiceLayer,
		openCodeModelServiceLayer,
		openCodeSettingsServiceLayer,
		Layer.succeed(WebSocketHandlerTag, wsHandler),
		Layer.succeed(SessionManagerTag, sessionMgr),
		Layer.succeed(SessionOverridesTag, sessionOverrides),
		Layer.succeed(PermissionBridgeTag, permissionBridge),
		Layer.succeed(QuestionBridgeTag, questionBridge),
		Layer.succeed(PtyManagerTag, ptyManager),
		Layer.succeed(ConfigTag, config),
		Layer.succeed(LoggerTag, log),
		Layer.succeed(StatusPollerTag, statusPoller),
		Layer.succeed(PollerManagerTag, pollerManager),
		Layer.succeed(ConnectPtyUpstreamTag, connectPtyUpstream),
	);
}

// ─── State-layer test helpers ──────────────────────────────────────────────
// Convenience wrappers around the Effect state Layer factories from
// src/lib/effect/. They provide zero-config defaults suitable for tests.

/**
 * Options for building the daemon-level state test Layer.
 */
export interface TestDaemonStateLayerOptions {
	daemonState?: Partial<DaemonState>;
	sessionManagerState?: Partial<SessionManagerState>;
	instanceManagerConfig?: Partial<InstanceManagerConfig>;
	rateLimiter?: { maxRequests: number; windowMs: number };
}

/**
 * Build a composed Layer providing all daemon state Tags.
 *
 * Intended for `it.scoped` tests that exercise daemon-level Effect code.
 * Mirrors the composition in test/unit/daemon/full-layer-composition.test.ts
 * but with sensible test defaults.
 *
 * Usage:
 *   const layer = makeTestDaemonStateLayer();
 *   return myEffect.pipe(Effect.provide(Layer.fresh(layer)));
 */
export function makeTestDaemonStateLayer(
	opts?: TestDaemonStateLayerOptions,
	// biome-ignore lint/suspicious/noExplicitAny: Layer type union is too wide to spell out
): Layer.Layer<any> {
	return Layer.mergeAll(
		makeDaemonStateLive(opts?.daemonState),
		makeSessionManagerStateLive(opts?.sessionManagerState),
		makePollerStateLive(),
		makePollerManagerStateLive(),
		makeInstanceManagerStateLive(opts?.instanceManagerConfig),
		makeSessionRegistryStateLive(),
		RateLimiterLive(
			opts?.rateLimiter ?? { maxRequests: 100, windowMs: 60_000 },
		),
		DaemonEventBusLive,
	);
}

/**
 * Build a Layer combining handler-level mock services with daemon state.
 *
 * Useful for integration-style Effect tests that need both mock services
 * (OpenCodeAPI, WebSocketHandler, etc.) and real Effect state (Ref-backed
 * SessionManagerState, InstanceManagerState, etc.).
 */
export function makeTestFullLayer(
	opts?: TestHandlerLayerOptions & TestDaemonStateLayerOptions,
	// biome-ignore lint/suspicious/noExplicitAny: Layer type union is too wide to spell out
): Layer.Layer<any> {
	return Layer.merge(
		makeTestHandlerLayer(opts),
		makeTestDaemonStateLayer(opts),
	);
}

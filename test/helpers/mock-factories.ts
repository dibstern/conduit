/**
 * Shared typed mock factories for test dependency objects.
 *
 * Eliminates `as unknown as` double-casts by providing fully-typed mocks
 * with sensible defaults for every field. Each factory accepts a
 * Partial<T> override to customize per-test.
 */
import { vi } from "vitest";
import type { ClientInitDeps } from "../../src/lib/bridges/client-init.js";
import type { HandlerDeps } from "../../src/lib/handlers/types.js";
import { createSilentLogger } from "../../src/lib/logger.js";
import type { OrchestrationLayer } from "../../src/lib/provider/orchestration-wiring.js";
import type { ProjectRelay } from "../../src/lib/relay/relay-stack.js";
import type { SSEWiringDeps } from "../../src/lib/relay/sse-wiring.js";

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
		getForkEntry: vi.fn().mockReturnValue(undefined),
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

function createMockOverrides(): HandlerDeps["overrides"] {
	return {
		agent: undefined,
		model: undefined,
		variant: "",
		defaultModel: undefined,
		defaultVariant: "",
		modelUserSelected: false,
		setAgent: vi.fn(),
		setModel: vi.fn(),
		setModelDefault: vi.fn(),
		setDefaultModel: vi.fn(),
		setVariant: vi.fn(),
		getModel: vi.fn().mockReturnValue(undefined),
		getAgent: vi.fn().mockReturnValue(undefined),
		getVariant: vi.fn().mockReturnValue(""),
		isModelUserSelected: vi.fn().mockReturnValue(false),
		clear: vi.fn(),
		clearSession: vi.fn(),
		startProcessingTimeout: vi.fn(),
		clearProcessingTimeout: vi.fn(),
		resetProcessingTimeout: vi.fn(),
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
		overrides: createMockOverrides(),
		ptyManager: createMockPtyManager(),
		config: createMockConfig(),
		log: createSilentLogger(),
		connectPtyUpstream: vi.fn().mockResolvedValue(undefined),
		statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
		registry: {
			hasViewers: vi.fn().mockReturnValue(false),
			addViewer: vi.fn(),
			removeClient: vi.fn(),
		} as unknown as HandlerDeps["registry"],
		pollerManager: {
			isPolling: vi.fn().mockReturnValue(true),
			startPolling: vi.fn(),
		},
		forkMeta: {
			setForkEntry: vi.fn(),
			getForkEntry: vi.fn().mockReturnValue(undefined),
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

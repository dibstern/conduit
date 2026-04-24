import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { PermissionBridge } from "../../../src/lib/bridges/permission-bridge.js";
import type { QuestionBridge } from "../../../src/lib/bridges/question-bridge.js";
import {
	type HandlerLayerDeps,
	makeClaudeEventPersistLive,
	makeConfigLive,
	makeConnectPtyUpstreamLive,
	makeForkMetaLive,
	makeHandlerLayer,
	makeInstanceMgmtLive,
	makeLoggerLive,
	makeOpenCodeAPILive,
	makeOrchestrationEngineLive,
	makePermissionBridgeLive,
	makePollerManagerLive,
	makeProjectMgmtLive,
	makeProviderStateServiceLive,
	makePtyManagerLive,
	makeQuestionBridgeLive,
	makeReadQueryLive,
	makeScanDepsLive,
	makeSessionManagerLive,
	makeSessionOverridesLive,
	makeSessionRegistryLive,
	makeStatusPollerLive,
	makeWebSocketHandlerLive,
} from "../../../src/lib/effect/layers.js";
import {
	ClaudeEventPersistTag,
	ConfigTag,
	ConnectPtyUpstreamTag,
	ForkMetaTag,
	InstanceMgmtTag,
	LoggerTag,
	OpenCodeAPITag,
	OrchestrationEngineTag,
	PermissionBridgeTag,
	PollerManagerTag,
	ProjectMgmtTag,
	ProviderStateServiceTag,
	PtyManagerTag,
	QuestionBridgeTag,
	ReadQueryTag,
	ScanDepsTag,
	SessionManagerTag,
	SessionOverridesTag,
	SessionRegistryTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import type {
	InstanceManagementDeps,
	ProjectManagementDeps,
	ScanDeps,
} from "../../../src/lib/handlers/types.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../../src/lib/logger.js";
import type { ProviderStateService } from "../../../src/lib/persistence/provider-state-service.js";
import type { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import type { RelayEventSinkPersist } from "../../../src/lib/provider/relay-event-sink.js";
import type { PtyManager } from "../../../src/lib/relay/pty-manager.js";
import type { SessionManager } from "../../../src/lib/session/session-manager.js";
import type { SessionOverrides } from "../../../src/lib/session/session-overrides.js";
import type { SessionRegistry } from "../../../src/lib/session/session-registry.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";

// ─── Minimal mock objects ───────────────────────────────────────────────────
// Partial implementations cast to the required type. These are NOT functional
// — just enough structure to verify Layer wiring passes the correct instance.

const mockApi = { sdk: {} } as unknown as OpenCodeAPI;
const mockSessionMgr = { initialize: () => {} } as unknown as SessionManager;
const mockWsHandler = {
	broadcast: () => {},
	sendTo: () => {},
	setClientSession: () => {},
	getClientSession: () => undefined,
	getClientsForSession: () => [],
	sendToSession: () => {},
};
const mockPermissionBridge = {
	trackPending: () => {},
} as unknown as PermissionBridge;
const mockQuestionBridge = {
	trackPending: () => {},
} as unknown as QuestionBridge;
const mockOverrides = {
	setDefaultModel: () => {},
} as unknown as SessionOverrides;
const mockPtyManager = { closeAll: () => {} } as unknown as PtyManager;
const mockConfig = {
	opencodeUrl: "http://localhost:3000",
} as unknown as ProjectRelayConfig;
const mockLogger = { info: () => {}, error: () => {} } as unknown as Logger;
const mockStatusPoller = { isProcessing: () => false };
const mockRegistry = { hasViewers: () => false } as unknown as SessionRegistry;
const mockPollerManager = { isPolling: () => false, startPolling: () => {} };
const mockConnectPtyUpstream = async () => {};
const mockForkMeta = {
	setForkEntry: () => {},
	getForkEntry: () => undefined,
};
const mockOrchestrationEngine = {
	dispatch: () => {},
} as unknown as OrchestrationEngine;
const mockReadQuery = { query: () => {} } as unknown as ReadQueryService;
const mockEventPersist = { eventStore: {} } as unknown as RelayEventSinkPersist;
const mockProviderState = {
	getCursor: () => {},
} as unknown as ProviderStateService;
const mockInstanceMgmt = {
	getInstances: () => [],
} as unknown as InstanceManagementDeps;
const mockProjectMgmt = {
	getProjects: () => [],
} as unknown as ProjectManagementDeps;
const mockScanDeps = { triggerScan: async () => ({}) } as unknown as ScanDeps;

/** Shared base deps for makeHandlerLayer tests. */
function makeBaseDeps(): HandlerLayerDeps {
	return {
		wsHandler: mockWsHandler,
		client: mockApi,
		sessionMgr: mockSessionMgr,
		permissionBridge: mockPermissionBridge,
		questionBridge: mockQuestionBridge,
		overrides: mockOverrides,
		ptyManager: mockPtyManager,
		config: mockConfig,
		log: mockLogger,
		statusPoller: mockStatusPoller,
		registry: mockRegistry,
		pollerManager: mockPollerManager,
		connectPtyUpstream: mockConnectPtyUpstream,
		forkMeta: mockForkMeta,
		orchestrationEngine: mockOrchestrationEngine,
	};
}

// ─── Individual Layer tests ──────────────────────────────────────────────────

describe("Individual Layer factories", () => {
	it("makeOpenCodeAPILive provides OpenCodeAPITag", async () => {
		const program = Effect.gen(function* () {
			return yield* OpenCodeAPITag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeOpenCodeAPILive(mockApi))),
		);
		expect(result).toBe(mockApi);
	});

	it("makeSessionManagerLive provides SessionManagerTag", async () => {
		const program = Effect.gen(function* () {
			return yield* SessionManagerTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeSessionManagerLive(mockSessionMgr))),
		);
		expect(result).toBe(mockSessionMgr);
	});

	it("makeWebSocketHandlerLive provides WebSocketHandlerTag", async () => {
		const program = Effect.gen(function* () {
			return yield* WebSocketHandlerTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeWebSocketHandlerLive(mockWsHandler))),
		);
		expect(result).toBe(mockWsHandler);
	});

	it("makePermissionBridgeLive provides PermissionBridgeTag", async () => {
		const program = Effect.gen(function* () {
			return yield* PermissionBridgeTag;
		});
		const result = await Effect.runPromise(
			program.pipe(
				Effect.provide(makePermissionBridgeLive(mockPermissionBridge)),
			),
		);
		expect(result).toBe(mockPermissionBridge);
	});

	it("makeQuestionBridgeLive provides QuestionBridgeTag", async () => {
		const program = Effect.gen(function* () {
			return yield* QuestionBridgeTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeQuestionBridgeLive(mockQuestionBridge))),
		);
		expect(result).toBe(mockQuestionBridge);
	});

	it("makeSessionOverridesLive provides SessionOverridesTag", async () => {
		const program = Effect.gen(function* () {
			return yield* SessionOverridesTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeSessionOverridesLive(mockOverrides))),
		);
		expect(result).toBe(mockOverrides);
	});

	it("makePtyManagerLive provides PtyManagerTag", async () => {
		const program = Effect.gen(function* () {
			return yield* PtyManagerTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makePtyManagerLive(mockPtyManager))),
		);
		expect(result).toBe(mockPtyManager);
	});

	it("makeConfigLive provides ConfigTag", async () => {
		const program = Effect.gen(function* () {
			return yield* ConfigTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeConfigLive(mockConfig))),
		);
		expect(result).toBe(mockConfig);
	});

	it("makeLoggerLive provides LoggerTag", async () => {
		const program = Effect.gen(function* () {
			return yield* LoggerTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeLoggerLive(mockLogger))),
		);
		expect(result).toBe(mockLogger);
	});

	it("makeStatusPollerLive provides StatusPollerTag", async () => {
		const program = Effect.gen(function* () {
			return yield* StatusPollerTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeStatusPollerLive(mockStatusPoller))),
		);
		expect(result).toBe(mockStatusPoller);
	});

	it("makeSessionRegistryLive provides SessionRegistryTag", async () => {
		const program = Effect.gen(function* () {
			return yield* SessionRegistryTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeSessionRegistryLive(mockRegistry))),
		);
		expect(result).toBe(mockRegistry);
	});

	it("makePollerManagerLive provides PollerManagerTag", async () => {
		const program = Effect.gen(function* () {
			return yield* PollerManagerTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makePollerManagerLive(mockPollerManager))),
		);
		expect(result).toBe(mockPollerManager);
	});

	it("makeConnectPtyUpstreamLive provides ConnectPtyUpstreamTag", async () => {
		const program = Effect.gen(function* () {
			return yield* ConnectPtyUpstreamTag;
		});
		const result = await Effect.runPromise(
			program.pipe(
				Effect.provide(makeConnectPtyUpstreamLive(mockConnectPtyUpstream)),
			),
		);
		expect(result).toBe(mockConnectPtyUpstream);
	});

	it("makeForkMetaLive provides ForkMetaTag", async () => {
		const program = Effect.gen(function* () {
			return yield* ForkMetaTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeForkMetaLive(mockForkMeta))),
		);
		expect(result).toBe(mockForkMeta);
	});

	it("makeOrchestrationEngineLive provides OrchestrationEngineTag", async () => {
		const program = Effect.gen(function* () {
			return yield* OrchestrationEngineTag;
		});
		const result = await Effect.runPromise(
			program.pipe(
				Effect.provide(makeOrchestrationEngineLive(mockOrchestrationEngine)),
			),
		);
		expect(result).toBe(mockOrchestrationEngine);
	});

	// ── Persistence extension Layers ─────────────────────────────────────────

	it("makeReadQueryLive provides ReadQueryTag", async () => {
		const program = Effect.gen(function* () {
			return yield* ReadQueryTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeReadQueryLive(mockReadQuery))),
		);
		expect(result).toBe(mockReadQuery);
	});

	it("makeClaudeEventPersistLive provides ClaudeEventPersistTag", async () => {
		const program = Effect.gen(function* () {
			return yield* ClaudeEventPersistTag;
		});
		const result = await Effect.runPromise(
			program.pipe(
				Effect.provide(makeClaudeEventPersistLive(mockEventPersist)),
			),
		);
		expect(result).toBe(mockEventPersist);
	});

	it("makeProviderStateServiceLive provides ProviderStateServiceTag", async () => {
		const program = Effect.gen(function* () {
			return yield* ProviderStateServiceTag;
		});
		const result = await Effect.runPromise(
			program.pipe(
				Effect.provide(makeProviderStateServiceLive(mockProviderState)),
			),
		);
		expect(result).toBe(mockProviderState);
	});

	// ── Daemon-only Layers ───────────────────────────────────────────────────

	it("makeInstanceMgmtLive provides InstanceMgmtTag", async () => {
		const program = Effect.gen(function* () {
			return yield* InstanceMgmtTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeInstanceMgmtLive(mockInstanceMgmt))),
		);
		expect(result).toBe(mockInstanceMgmt);
	});

	it("makeProjectMgmtLive provides ProjectMgmtTag", async () => {
		const program = Effect.gen(function* () {
			return yield* ProjectMgmtTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeProjectMgmtLive(mockProjectMgmt))),
		);
		expect(result).toBe(mockProjectMgmt);
	});

	it("makeScanDepsLive provides ScanDepsTag", async () => {
		const program = Effect.gen(function* () {
			return yield* ScanDepsTag;
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(makeScanDepsLive(mockScanDeps))),
		);
		expect(result).toBe(mockScanDeps);
	});
});

// ─── makeHandlerLayer composition tests ──────────────────────────────────────

describe("makeHandlerLayer", () => {
	it("provides all 15 core Tags", async () => {
		const layer = makeHandlerLayer(makeBaseDeps());

		const program = Effect.gen(function* () {
			const api = yield* OpenCodeAPITag;
			const sm = yield* SessionManagerTag;
			const ws = yield* WebSocketHandlerTag;
			const pb = yield* PermissionBridgeTag;
			const qb = yield* QuestionBridgeTag;
			const so = yield* SessionOverridesTag;
			const pm = yield* PtyManagerTag;
			const cfg = yield* ConfigTag;
			const log = yield* LoggerTag;
			const sp = yield* StatusPollerTag;
			const reg = yield* SessionRegistryTag;
			const plm = yield* PollerManagerTag;
			const cpu = yield* ConnectPtyUpstreamTag;
			const fm = yield* ForkMetaTag;
			const oe = yield* OrchestrationEngineTag;
			return [api, sm, ws, pb, qb, so, pm, cfg, log, sp, reg, plm, cpu, fm, oe];
		});

		const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
		expect(result).toHaveLength(15);
		expect(result.every((v) => v !== undefined)).toBe(true);
	});

	it("provides the exact instances that were passed in", async () => {
		const deps = makeBaseDeps();
		const layer = makeHandlerLayer(deps);

		const program = Effect.gen(function* () {
			const api = yield* OpenCodeAPITag;
			const ws = yield* WebSocketHandlerTag;
			return { api, ws };
		});

		const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
		expect(result.api).toBe(deps.client);
		expect(result.ws).toBe(deps.wsHandler);
	});

	it("includes optional persistence Tags when provided", async () => {
		const layer = makeHandlerLayer({
			...makeBaseDeps(),
			readQuery: mockReadQuery,
			claudeEventPersist: mockEventPersist,
			providerStateService: mockProviderState,
		});

		const program = Effect.gen(function* () {
			const rq = yield* ReadQueryTag;
			const cep = yield* ClaudeEventPersistTag;
			const ps = yield* ProviderStateServiceTag;
			return { rq, cep, ps };
		});

		const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
		expect(result.rq).toBe(mockReadQuery);
		expect(result.cep).toBe(mockEventPersist);
		expect(result.ps).toBe(mockProviderState);
	});

	it("includes optional daemon Tags when provided", async () => {
		const layer = makeHandlerLayer({
			...makeBaseDeps(),
			instanceMgmt: mockInstanceMgmt,
			projectMgmt: mockProjectMgmt,
			scanDeps: mockScanDeps,
		});

		const program = Effect.gen(function* () {
			const im = yield* InstanceMgmtTag;
			const pm = yield* ProjectMgmtTag;
			const sd = yield* ScanDepsTag;
			return { im, pm, sd };
		});

		const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
		expect(result.im).toBe(mockInstanceMgmt);
		expect(result.pm).toBe(mockProjectMgmt);
		expect(result.sd).toBe(mockScanDeps);
	});

	it("omits optional Tags when not provided", async () => {
		const layer = makeHandlerLayer(makeBaseDeps());

		// Accessing an optional Tag that was not provided should fail
		const program = Effect.gen(function* () {
			const rq = yield* ReadQueryTag;
			return rq;
		});

		await expect(
			Effect.runPromise(
				program.pipe(Effect.provide(layer)) as Effect.Effect<unknown>,
			),
		).rejects.toThrow();
	});
});

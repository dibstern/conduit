import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
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
	it.effect("makeOpenCodeAPILive provides OpenCodeAPITag", () =>
		Effect.gen(function* () {
			const result = yield* OpenCodeAPITag;
			expect(result).toBe(mockApi);
		}).pipe(Effect.provide(makeOpenCodeAPILive(mockApi))),
	);

	it.effect("makeSessionManagerLive provides SessionManagerTag", () =>
		Effect.gen(function* () {
			const result = yield* SessionManagerTag;
			expect(result).toBe(mockSessionMgr);
		}).pipe(Effect.provide(makeSessionManagerLive(mockSessionMgr))),
	);

	it.effect("makeWebSocketHandlerLive provides WebSocketHandlerTag", () =>
		Effect.gen(function* () {
			const result = yield* WebSocketHandlerTag;
			expect(result).toBe(mockWsHandler);
		}).pipe(Effect.provide(makeWebSocketHandlerLive(mockWsHandler))),
	);

	it.effect("makePermissionBridgeLive provides PermissionBridgeTag", () =>
		Effect.gen(function* () {
			const result = yield* PermissionBridgeTag;
			expect(result).toBe(mockPermissionBridge);
		}).pipe(Effect.provide(makePermissionBridgeLive(mockPermissionBridge))),
	);

	it.effect("makeQuestionBridgeLive provides QuestionBridgeTag", () =>
		Effect.gen(function* () {
			const result = yield* QuestionBridgeTag;
			expect(result).toBe(mockQuestionBridge);
		}).pipe(Effect.provide(makeQuestionBridgeLive(mockQuestionBridge))),
	);

	it.effect("makeSessionOverridesLive provides SessionOverridesTag", () =>
		Effect.gen(function* () {
			const result = yield* SessionOverridesTag;
			expect(result).toBe(mockOverrides);
		}).pipe(Effect.provide(makeSessionOverridesLive(mockOverrides))),
	);

	it.effect("makePtyManagerLive provides PtyManagerTag", () =>
		Effect.gen(function* () {
			const result = yield* PtyManagerTag;
			expect(result).toBe(mockPtyManager);
		}).pipe(Effect.provide(makePtyManagerLive(mockPtyManager))),
	);

	it.effect("makeConfigLive provides ConfigTag", () =>
		Effect.gen(function* () {
			const result = yield* ConfigTag;
			expect(result).toBe(mockConfig);
		}).pipe(Effect.provide(makeConfigLive(mockConfig))),
	);

	it.effect("makeLoggerLive provides LoggerTag", () =>
		Effect.gen(function* () {
			const result = yield* LoggerTag;
			expect(result).toBe(mockLogger);
		}).pipe(Effect.provide(makeLoggerLive(mockLogger))),
	);

	it.effect("makeStatusPollerLive provides StatusPollerTag", () =>
		Effect.gen(function* () {
			const result = yield* StatusPollerTag;
			expect(result).toBe(mockStatusPoller);
		}).pipe(Effect.provide(makeStatusPollerLive(mockStatusPoller))),
	);

	it.effect("makeSessionRegistryLive provides SessionRegistryTag", () =>
		Effect.gen(function* () {
			const result = yield* SessionRegistryTag;
			expect(result).toBe(mockRegistry);
		}).pipe(Effect.provide(makeSessionRegistryLive(mockRegistry))),
	);

	it.effect("makePollerManagerLive provides PollerManagerTag", () =>
		Effect.gen(function* () {
			const result = yield* PollerManagerTag;
			expect(result).toBe(mockPollerManager);
		}).pipe(Effect.provide(makePollerManagerLive(mockPollerManager))),
	);

	it.effect("makeConnectPtyUpstreamLive provides ConnectPtyUpstreamTag", () =>
		Effect.gen(function* () {
			const result = yield* ConnectPtyUpstreamTag;
			expect(result).toBe(mockConnectPtyUpstream);
		}).pipe(Effect.provide(makeConnectPtyUpstreamLive(mockConnectPtyUpstream))),
	);

	it.effect("makeForkMetaLive provides ForkMetaTag", () =>
		Effect.gen(function* () {
			const result = yield* ForkMetaTag;
			expect(result).toBe(mockForkMeta);
		}).pipe(Effect.provide(makeForkMetaLive(mockForkMeta))),
	);

	it.effect("makeOrchestrationEngineLive provides OrchestrationEngineTag", () =>
		Effect.gen(function* () {
			const result = yield* OrchestrationEngineTag;
			expect(result).toBe(mockOrchestrationEngine);
		}).pipe(
			Effect.provide(makeOrchestrationEngineLive(mockOrchestrationEngine)),
		),
	);

	// ── Persistence extension Layers ─────────────────────────────────────────

	it.effect("makeReadQueryLive provides ReadQueryTag", () =>
		Effect.gen(function* () {
			const result = yield* ReadQueryTag;
			expect(result).toBe(mockReadQuery);
		}).pipe(Effect.provide(makeReadQueryLive(mockReadQuery))),
	);

	it.effect("makeClaudeEventPersistLive provides ClaudeEventPersistTag", () =>
		Effect.gen(function* () {
			const result = yield* ClaudeEventPersistTag;
			expect(result).toBe(mockEventPersist);
		}).pipe(Effect.provide(makeClaudeEventPersistLive(mockEventPersist))),
	);

	it.effect(
		"makeProviderStateServiceLive provides ProviderStateServiceTag",
		() =>
			Effect.gen(function* () {
				const result = yield* ProviderStateServiceTag;
				expect(result).toBe(mockProviderState);
			}).pipe(Effect.provide(makeProviderStateServiceLive(mockProviderState))),
	);

	// ── Daemon-only Layers ───────────────────────────────────────────────────

	it.effect("makeInstanceMgmtLive provides InstanceMgmtTag", () =>
		Effect.gen(function* () {
			const result = yield* InstanceMgmtTag;
			expect(result).toBe(mockInstanceMgmt);
		}).pipe(Effect.provide(makeInstanceMgmtLive(mockInstanceMgmt))),
	);

	it.effect("makeProjectMgmtLive provides ProjectMgmtTag", () =>
		Effect.gen(function* () {
			const result = yield* ProjectMgmtTag;
			expect(result).toBe(mockProjectMgmt);
		}).pipe(Effect.provide(makeProjectMgmtLive(mockProjectMgmt))),
	);

	it.effect("makeScanDepsLive provides ScanDepsTag", () =>
		Effect.gen(function* () {
			const result = yield* ScanDepsTag;
			expect(result).toBe(mockScanDeps);
		}).pipe(Effect.provide(makeScanDepsLive(mockScanDeps))),
	);
});

// ─── makeHandlerLayer composition tests ──────────────────────────────────────

describe("makeHandlerLayer", () => {
	it.effect("provides all 15 core Tags", () =>
		Effect.gen(function* () {
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
			const result = [
				api,
				sm,
				ws,
				pb,
				qb,
				so,
				pm,
				cfg,
				log,
				sp,
				reg,
				plm,
				cpu,
				fm,
				oe,
			];
			expect(result).toHaveLength(15);
			expect(result.every((v) => v !== undefined)).toBe(true);
		}).pipe(Effect.provide(makeHandlerLayer(makeBaseDeps()))),
	);

	it.effect("provides the exact instances that were passed in", () => {
		const deps = makeBaseDeps();
		return Effect.gen(function* () {
			const api = yield* OpenCodeAPITag;
			const ws = yield* WebSocketHandlerTag;
			expect(api).toBe(deps.client);
			expect(ws).toBe(deps.wsHandler);
		}).pipe(Effect.provide(makeHandlerLayer(deps)));
	});

	it.effect("includes optional persistence Tags when provided", () =>
		Effect.gen(function* () {
			const rq = yield* ReadQueryTag;
			const cep = yield* ClaudeEventPersistTag;
			const ps = yield* ProviderStateServiceTag;
			expect(rq).toBe(mockReadQuery);
			expect(cep).toBe(mockEventPersist);
			expect(ps).toBe(mockProviderState);
		}).pipe(
			Effect.provide(
				makeHandlerLayer({
					...makeBaseDeps(),
					readQuery: mockReadQuery,
					claudeEventPersist: mockEventPersist,
					providerStateService: mockProviderState,
				}),
			),
		),
	);

	it.effect("includes optional daemon Tags when provided", () =>
		Effect.gen(function* () {
			const im = yield* InstanceMgmtTag;
			const pm = yield* ProjectMgmtTag;
			const sd = yield* ScanDepsTag;
			expect(im).toBe(mockInstanceMgmt);
			expect(pm).toBe(mockProjectMgmt);
			expect(sd).toBe(mockScanDeps);
		}).pipe(
			Effect.provide(
				makeHandlerLayer({
					...makeBaseDeps(),
					instanceMgmt: mockInstanceMgmt,
					projectMgmt: mockProjectMgmt,
					scanDeps: mockScanDeps,
				}),
			),
		),
	);

	it.effect("omits optional Tags when not provided", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				Effect.gen(function* () {
					yield* ReadQueryTag;
				}).pipe(
					Effect.provide(makeHandlerLayer(makeBaseDeps())),
				) as Effect.Effect<void>,
			);
			expect(exit._tag).toBe("Failure");
		}),
	);
});

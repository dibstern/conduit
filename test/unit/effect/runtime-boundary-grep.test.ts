import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SRC_LIB = join(REPO_ROOT, "src/lib");

interface AllowedRuntimeBoundary {
	readonly path: string;
	readonly linePattern: RegExp;
	readonly reason: string;
}

const allowedRuntimeBoundaries: readonly AllowedRuntimeBoundary[] = [
	{
		path: "src/lib/domain/server/Layers/http-router-layer.ts",
		linePattern: /Effect\.runSync\($/,
		reason: "server-owned Node HTTP callback from NodeHttpServer.makeHandler",
	},
	{
		path: "src/lib/provider/claude/claude-permission-bridge.ts",
		linePattern: /Effect\.runPromise\($/,
		reason: "Claude SDK canUseTool callback requires a Promise-shaped wait",
	},
	{
		path: "src/lib/instance/sdk-factory.ts",
		linePattern: /Effect\.runPromise\(fetchWithRetry\(/,
		reason: "OpenCode SDK and GapEndpoints require a Promise-shaped fetch",
	},
];

function tsFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...tsFiles(path));
		} else if (path.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

describe("Effect runtime boundary grep", () => {
	it("keeps app-internal Effect runtime bridges on an explicit allowlist", () => {
		const hits = tsFiles(SRC_LIB).flatMap((file) => {
			const relPath = relative(REPO_ROOT, file);
			return readFileSync(file, "utf8")
				.split("\n")
				.flatMap((line, index) =>
					/Effect\.run(?:Promise|Sync)/.test(line)
						? [{ path: relPath, line: index + 1, source: line.trim() }]
						: [],
				);
		});

		const unexpected = hits.filter(
			(hit) =>
				!allowedRuntimeBoundaries.some(
					(boundary) =>
						boundary.path === hit.path && boundary.linePattern.test(hit.source),
				),
		);

		expect(unexpected).toEqual([]);
		expect(hits).toHaveLength(allowedRuntimeBoundaries.length);
	});

	it("does not reintroduce the retired SessionRegistry Effect bridge", () => {
		const retiredBridgePatterns = [
			{
				path: "src/lib/relay/relay-stack.ts",
				pattern: /Layer\.succeed\(SessionRegistryTag,/,
			},
			{
				path: "src/lib/domain/relay/Services/services.ts",
				pattern: /class SessionRegistryTag\b/,
			},
			{
				path: "src/lib/handlers/types.ts",
				pattern: /registry:\s*SessionRegistry\b/,
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ path, pattern }) => {
			const source = readFileSync(join(REPO_ROOT, path), "utf8");
			return source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim() }]
						: [],
				);
		});

		expect(hits).toEqual([]);
	});

	it("does not construct PTY bridge services in relay-stack", () => {
		const retiredBridgePatterns = [
			{
				pattern: /new PtyManager\b/,
				reason: "PtyManager must be constructed by a scoped Layer",
			},
			{
				pattern: /Layer\.succeed\(PtyManagerTag,/,
				reason: "PtyManagerTag must not wrap a prebuilt instance",
			},
			{
				pattern: /Layer\.succeed\(ConnectPtyUpstreamTag,/,
				reason: "ConnectPtyUpstreamTag must be derived by a Layer",
			},
			{
				pattern: /ptyManager\.closeAll\(\)/,
				reason: "PTY cleanup belongs to the PtyManager scoped finalizer",
			},
		] as const;
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim(), reason }]
						: [],
				),
		);

		expect(hits).toEqual([]);
	});

	it("does not construct message poller manager bridge services in relay-stack", () => {
		const retiredBridgePatterns = [
			{
				pattern: /new MessagePollerManager\b/,
				reason: "MessagePollerManager must be constructed by a scoped Layer",
			},
			{
				pattern: /Layer\.succeed\(PollerManagerTag,/,
				reason: "PollerManagerTag must not wrap a prebuilt instance",
			},
			{
				pattern: /pollerManager\.drain\(\)/,
				reason: "Message poller cleanup belongs to the scoped Layer finalizer",
			},
		] as const;
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim(), reason }]
						: [],
				),
		);

		expect(hits).toEqual([]);
	});

	it("does not inject daemon websocket routing bridges from imperative options", () => {
		const retiredBridgePatterns = [
			{
				path: "src/lib/domain/daemon/Layers/daemon-layers.ts",
				pattern: /Layer\.succeed\(\s*WebSocketRelayRouterTag,/,
				reason:
					"WebSocketRelayRouterTag must be built from daemon Effect services",
			},
			{
				path: "src/lib/domain/daemon/Layers/daemon-layers.ts",
				pattern: /\bwsRelayRouter:\s*WebSocketRelayRouter\b/,
				reason: "DaemonLiveOptions must not accept a prebuilt WebSocket router",
			},
			{
				path: "src/lib/domain/daemon/Layers/daemon-main.ts",
				pattern: /\bwsRelayRouter:\s*\{/,
				reason:
					"daemon-main must not bridge legacy project registry callbacks into WebSocket routing",
			},
			{
				path: "src/lib/domain/daemon/Layers/daemon-main.ts",
				pattern: /wsHandler:\s*\{\s*handleUpgrade:\s*\(\)\s*=>\s*\{\s*\}\s*\}/,
				reason: "daemon-main must not install a no-op relay fallback",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ path, pattern, reason }) => {
			const source = readFileSync(join(REPO_ROOT, path), "utf8");
			const index = source.search(pattern);
			if (index < 0) return [];
			const line = source.slice(0, index).split("\n").length;
			return [
				{ path, line, source: source.split("\n")[line - 1]?.trim(), reason },
			];
		});

		expect(hits).toEqual([]);
	});

	it("keeps daemon HTTP router ownership out of daemon-main", () => {
		const retiredBridgePatterns = [
			/effectRouterWithCors/,
			/NodeHttpServer\.makeHandler/,
			/\bctx\.router\s*=/,
			/\bProjectsProvider\b/,
			/\bHealthProvider\b/,
			/\bPushProvider\b/,
			/\bRemoveProjectProvider\b/,
			/\bSetupInfoProvider\b/,
			/\bThemeProvider\b/,
		] as const;
		const path = "src/lib/domain/daemon/Layers/daemon-main.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const hits = retiredBridgePatterns.flatMap((pattern) =>
			source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim() }]
						: [],
				),
		);

		expect(hits).toEqual([]);
	});

	it("does not keep unused monitoring bridge services", () => {
		const retiredNames =
			/\b(?:MonitoringStateLive|MonitoringStateTag|SSETrackerLive|SSETrackerTag)\b/;
		const hits = tsFiles(SRC_LIB).flatMap((file) => {
			const relPath = relative(REPO_ROOT, file);
			return readFileSync(file, "utf8")
				.split("\n")
				.flatMap((line, index) =>
					retiredNames.test(line)
						? [{ path: relPath, line: index + 1, source: line.trim() }]
						: [],
				);
		});

		expect(hits).toEqual([]);
	});

	it("does not read client-init model data through the raw OpenCode client", () => {
		const path = "src/lib/bridges/client-init.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredReadPatterns = [
			{
				pattern: /client\.session\.get\(/,
				reason: "active session model reads belong to OpenCodeModelService",
			},
			{
				pattern: /client\.provider\.list\(/,
				reason: "provider/model list reads belong to OpenCodeModelService",
			},
		] as const;

		const hits = retiredReadPatterns.flatMap(({ pattern, reason }) =>
			source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim(), reason }]
						: [],
				),
		);

		expect(hits).toEqual([]);
	});

	it("does not keep production legacy persistence bridges", () => {
		const retiredBridgePatterns = [
			{
				path: "src/lib/types.ts",
				pattern:
					/\bpersistence\?:\s*import\("\.\/persistence\/persistence-layer\.js"\)\.PersistenceLayer/,
				reason:
					"ProjectRelayConfig should expose the Effect persistence DB path only",
			},
			{
				path: "src/lib/relay/relay-stack.ts",
				pattern:
					/\b(?:config\.persistence|new ReadQueryService|new ProviderStateService|new SessionSeeder|new DualWriteHook|ReadQueryTag|ClaudeEventPersistTag|ProviderStateServiceTag)\b/,
				reason:
					"relay-stack must not bridge legacy persistence objects into Effect services",
			},
			{
				path: "src/lib/handlers/prompt.ts",
				pattern:
					/\b(?:ClaudeEventPersistTag|ProviderStateServiceTag|claudeEventPersistOption|providerStateOption|canonicalEvent)\b/,
				reason: "prompt dispatch must use Effect persistence services only",
			},
			{
				path: "src/lib/domain/relay/Services/session-manager-service.ts",
				pattern: /\bReadQueryTag\b/,
				reason:
					"SessionManagerService must not fall back to the sync ReadQueryService bridge",
			},
			{
				path: "src/lib/bridges/client-init.ts",
				pattern: /\b(?:ReadQueryService|readQuery\?:|deps\.readQuery)\b/,
				reason:
					"client init must not pass sync ReadQueryService into session switching",
			},
			{
				path: "src/lib/session/session-switch.ts",
				pattern:
					/\b(?:ReadQueryService|readQuery\?:|deps\.readQuery|resolveSessionHistoryFromSqlite)\b/,
				reason:
					"session switching must not accept the sync ReadQueryService bridge",
			},
			{
				path: "src/lib/session/session-manager.ts",
				pattern:
					/\b(?:ReadQueryService|readQuery\?:|this\.readQuery|private readonly readQuery)\b/,
				reason:
					"SessionManager must not expose a sync persistence read-query fallback",
			},
			{
				path: "src/lib/session/session-status-sqlite.ts",
				pattern: /./,
				reason:
					"unused sync SessionStatusSqliteReader wrapper should stay deleted",
				optional: true,
			},
			{
				path: "src/lib/domain/relay/Services/services.ts",
				pattern:
					/\b(?:ReadQueryTag|ClaudeEventPersistTag|ProviderStateServiceTag|LegacyRelayEventSinkPersist)\b/,
				reason: "legacy persistence Tags must be deleted",
			},
			{
				path: "src/lib/handlers/types.ts",
				pattern:
					/\b(?:readQuery\?:|claudeEventPersist\?:|providerStateService\?:)\b/,
				reason:
					"HandlerDeps must not advertise retired legacy persistence fields",
			},
			{
				path: "src/lib/provider/relay-event-sink.ts",
				pattern: /\bLegacyRelayEventSinkPersist\b/,
				reason: "RelayEventSink persistence should be Effect-only",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ path, pattern, reason }) => {
			const fullPath = join(REPO_ROOT, path);
			if (!existsSync(fullPath)) return [];
			const source = readFileSync(fullPath, "utf8");
			return source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim(), reason }]
						: [],
				);
		});

		expect(hits).toEqual([]);
	});

	it("does not keep production SessionManager EventEmitter bridges", () => {
		const retiredBridgePatterns = [
			{
				path: "src/lib/relay/relay-stack.ts",
				pattern: /\bSessionEventBridgeLive\b/,
				reason:
					"relay runtime should subscribe directly to DaemonEventBus, not bridge SessionManager EventEmitter events",
			},
			{
				path: "src/lib/relay/session-event-bridge.ts",
				pattern: /./,
				reason:
					"SessionEventBridgeLive should stay deleted after lifecycle publication moved into SessionManagerServiceLive",
				optional: true,
			},
			{
				path: "src/lib/relay/session-lifecycle-wiring.ts",
				pattern:
					/\b(?:wireSessionLifecycle|SessionLifecycleWiringDeps|SessionManagerLike|sessionMgr\.on)\b/,
				reason:
					"session lifecycle wiring should consume DaemonEventBus, not legacy SessionManager EventEmitter callbacks",
			},
			{
				path: "src/lib/domain/relay/Services/services.ts",
				pattern: /\b(?:on|off)\(event: "(?:broadcast|session_lifecycle)"/,
				reason:
					"SessionManagerShape should not expose EventEmitter bridge methods",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ path, pattern, reason }) => {
			const fullPath = join(REPO_ROOT, path);
			if (!existsSync(fullPath)) return [];
			const source = readFileSync(fullPath, "utf8");
			return source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim(), reason }]
						: [],
				);
		});

		expect(hits).toEqual([]);
	});

	it("does not keep the production SessionManagerTag bridge", () => {
		const retiredBridgePatterns = [
			{
				path: "src/lib/relay/relay-stack.ts",
				pattern: /\bSessionManagerTag\b/,
				reason:
					"relay runtime should use SessionManagerServiceTag/SessionManagerStateTag instead of injecting a legacy SessionManager",
			},
			{
				path: "src/lib/domain/relay/Services/session-manager-service.ts",
				pattern: /\bSessionManagerTag\b/,
				reason:
					"SessionManagerServiceLive must not mirror state into the legacy SessionManager bridge",
			},
			{
				path: "src/lib/domain/relay/Services/services.ts",
				pattern: /class SessionManagerTag\b/,
				reason:
					"SessionManagerTag should stay deleted after session state moves behind SessionManagerService",
			},
			{
				path: "src/lib/relay/sse-wiring.ts",
				pattern: /\b(?:SessionManagerLike|sessionMgr)\b/,
				reason:
					"SSE wiring should use a SessionManagerService-shaped port, not the legacy manager shape",
			},
			{
				path: "src/lib/relay/monitoring-wiring.ts",
				pattern: /\b(?:SessionManagerLike|sessionMgr)\b/,
				reason:
					"monitoring wiring should read session lists and parent maps through the service port",
			},
			{
				path: "src/lib/relay/poller-wiring.ts",
				pattern: /\b(?:SessionManagerLike|sessionMgr)\b/,
				reason:
					"poller wiring should read parent maps through the service port",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ path, pattern, reason }) => {
			const fullPath = join(REPO_ROOT, path);
			if (!existsSync(fullPath)) return [];
			const source = readFileSync(fullPath, "utf8");
			return source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim(), reason }]
						: [],
				);
		});

		expect(hits).toEqual([]);
	});

	it("does not inject daemon instance management into relay-stack", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /\bInstanceMgmtTag\b/,
				reason:
					"relay instance management must be derived from relay config, not a daemon tag bridge",
			},
			{
				pattern: /Layer\.succeed\(InstanceMgmtTag,/,
				reason:
					"InstanceMgmtTag must not wrap prebuilt daemon callbacks in relay composition",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim(), reason }]
						: [],
				),
		);

		expect(hits).toEqual([]);
	});

	it("does not inject status poller into relay-stack", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /Layer\.succeed\(StatusPollerTag,/,
				reason: "StatusPollerTag must be constructed by a relay-owned Layer",
			},
			{
				pattern: /\bmakeDeferredStatusPollerRuntime\b/,
				reason:
					"relay-stack must not late-attach a status poller runtime facade",
			},
			{
				pattern: /\bcreateStatusPollerService\b/,
				reason:
					"status poller service construction belongs to the status poller Layer",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim(), reason }]
						: [],
				),
		);

		expect(hits).toEqual([]);
	});

	it("does not construct websocket handler bridge services in relay-stack", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /\bnew EffectWsHandler\b/,
				reason: "WebSocketHandlerTag must be constructed by a scoped Layer",
			},
			{
				pattern: /\bnew SessionRegistry\b/,
				reason:
					"viewer tracking must use the Effect websocket handler state, not a relay-stack registry",
			},
			{
				pattern: /Layer\.succeed\(WebSocketHandlerTag,/,
				reason: "WebSocketHandlerTag must not wrap a prebuilt handler",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim(), reason }]
						: [],
				),
		);

		expect(hits).toEqual([]);
	});

	it("does not inject core relay ports into relay-stack", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /Layer\.succeed\(OpenCodeAPITag,/,
				reason: "OpenCodeAPITag must be constructed by a relay-owned Layer",
			},
			{
				pattern: /Layer\.succeed\(ConfigTag,/,
				reason: "ConfigTag must be provided by the relay config Layer",
			},
			{
				pattern: /Layer\.succeed\(LoggerTag,/,
				reason: "LoggerTag must be derived by the relay logger Layer",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim(), reason }]
						: [],
				),
		);

		expect(hits).toEqual([]);
	});
});

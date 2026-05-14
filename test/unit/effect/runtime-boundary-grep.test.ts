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

	it("does not schedule daemon shutdown by re-entering the daemon runtime", () => {
		const path = "src/lib/domain/daemon/Layers/daemon-main.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const scheduleShutdownIndex = source.indexOf(
			"const scheduleLegacyPostResponseShutdown = () => {",
		);
		expect(scheduleShutdownIndex).toBeGreaterThanOrEqual(0);
		const daemonLiveOptionsIndex = source.indexOf(
			"const daemonLiveOptions: DaemonLiveOptions = {",
			scheduleShutdownIndex,
		);
		expect(daemonLiveOptionsIndex).toBeGreaterThan(scheduleShutdownIndex);
		const scheduleShutdownBlock = source.slice(
			scheduleShutdownIndex,
			daemonLiveOptionsIndex,
		);
		const retiredBridgePatterns = [
			{
				pattern: /daemonRuntime\.runPromise/,
				reason:
					"legacy scheduleShutdown should dispose the owned runtime instead of re-entering it",
			},
			{
				pattern: /ShutdownSignalTag/,
				reason:
					"ShutdownSignalTag is for the Effect-native NodeRuntime entrypoint, not the legacy ManagedRuntime stop path",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			scheduleShutdownBlock.split("\n").flatMap((line, index) =>
				pattern.test(line)
					? [
							{
								path,
								line:
									source.slice(0, scheduleShutdownIndex).split("\n").length +
									index,
								source: line.trim(),
								reason,
							},
						]
					: [],
			),
		);

		expect(hits).toEqual([]);
	});

	it("does not route restart config IPC through daemon-main callbacks", () => {
		const retiredBridgePatterns = [
			{
				path: "src/lib/domain/daemon/Layers/daemon-main.ts",
				pattern: /\bapplyConfig:\s*\(/,
				reason:
					"restart config mutation should run through native Effect IPC handlers",
			},
			{
				path: "src/lib/daemon/daemon-ipc.ts",
				pattern: /\bapplyConfig\??\s*\(/,
				reason: "DaemonIPCContext should not carry restart config callbacks",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ path, pattern, reason }) => {
			const source = readFileSync(join(REPO_ROOT, path), "utf8");
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

	it("does not carry post-response shutdown scheduling on DaemonIPCContext", () => {
		const path = "src/lib/daemon/daemon-ipc.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const contextStart = source.indexOf("export interface DaemonIPCContext");
		const contextEnd = source.indexOf(
			"export interface IPCHandlerMap",
			contextStart,
		);
		expect(contextStart).toBeGreaterThanOrEqual(0);
		expect(contextEnd).toBeGreaterThan(contextStart);

		const contextSource = source.slice(contextStart, contextEnd);
		const hits = contextSource.split("\n").flatMap((line, index) =>
			/\bscheduleShutdown\b/.test(line)
				? [
						{
							path,
							line: source.slice(0, contextStart).split("\n").length + index,
							source: line.trim(),
							reason:
								"shutdown/restart scheduling belongs to the IPC socket post-response hook",
						},
					]
				: [],
		);

		expect(hits).toEqual([]);
	});

	it("does not keep legacy daemon-main session count prefetch", () => {
		const path = "src/lib/domain/daemon/Layers/daemon-main.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /Prefetch session counts/,
				reason: "SessionPrefetchLive owns startup session count prefetch",
			},
			{
				pattern: /\/session\?limit=10000/,
				reason:
					"daemon-main must not run a parallel fetch loop outside the scoped Layer",
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

	it("does not route keep-awake IPC through daemon-main runtime callbacks", () => {
		const retiredBridgePatterns = [
			{
				path: "src/lib/domain/daemon/Layers/daemon-main.ts",
				pattern: /\bKeepAwakeTag\b/,
				reason: "keep-awake IPC should run through native Effect IPC handlers",
			},
			{
				path: "src/lib/domain/daemon/Layers/daemon-main.ts",
				pattern: /\bsetKeepAwake(Command)?:\s*\(/,
				reason:
					"daemon-main should not expose keep-awake mutation callbacks to IPC",
			},
			{
				path: "src/lib/domain/daemon/Layers/daemon-main.ts",
				pattern: /\bgetKeepAwake:\s*\(/,
				reason: "keep-awake status should come from the daemon status snapshot",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ path, pattern, reason }) => {
			const source = readFileSync(join(REPO_ROOT, path), "utf8");
			return source
				.split("\n")
				.flatMap((line, index) =>
					pattern.test(line)
						? [{ path, line: index + 1, source: line.trim(), reason }]
						: [],
				);
		});

		const daemonIpcPath = "src/lib/daemon/daemon-ipc.ts";
		const daemonIpcSource = readFileSync(
			join(REPO_ROOT, daemonIpcPath),
			"utf8",
		);
		const contextStart = daemonIpcSource.indexOf(
			"export interface DaemonIPCContext",
		);
		const contextEnd = daemonIpcSource.indexOf(
			"export interface IPCHandlerMap",
			contextStart,
		);
		expect(contextStart).toBeGreaterThanOrEqual(0);
		expect(contextEnd).toBeGreaterThan(contextStart);
		const contextSource = daemonIpcSource.slice(contextStart, contextEnd);
		const contextHits = contextSource.split("\n").flatMap((line, index) =>
			/\b(getKeepAwake|setKeepAwake|setKeepAwakeCommand)\b/.test(line)
				? [
						{
							path: daemonIpcPath,
							line:
								daemonIpcSource.slice(0, contextStart).split("\n").length +
								index,
							source: line.trim(),
							reason: "DaemonIPCContext should not carry keep-awake callbacks",
						},
					]
				: [],
		);

		expect([...hits, ...contextHits]).toEqual([]);
	});

	it("does not route PIN IPC through daemon-main runtime callbacks", () => {
		const daemonMainPath = "src/lib/domain/daemon/Layers/daemon-main.ts";
		const daemonMainSource = readFileSync(
			join(REPO_ROOT, daemonMainPath),
			"utf8",
		);
		const daemonMainHits = daemonMainSource
			.split("\n")
			.flatMap((line, index) =>
				/\bsetPinHash:\s*\(/.test(line)
					? [
							{
								path: daemonMainPath,
								line: index + 1,
								source: line.trim(),
								reason:
									"daemon-main should not expose PIN mutation callbacks to IPC",
							},
						]
					: [],
			);

		const daemonIpcPath = "src/lib/daemon/daemon-ipc.ts";
		const daemonIpcSource = readFileSync(
			join(REPO_ROOT, daemonIpcPath),
			"utf8",
		);
		const contextStart = daemonIpcSource.indexOf(
			"export interface DaemonIPCContext",
		);
		const contextEnd = daemonIpcSource.indexOf(
			"export interface IPCHandlerMap",
			contextStart,
		);
		expect(contextStart).toBeGreaterThanOrEqual(0);
		expect(contextEnd).toBeGreaterThan(contextStart);
		const contextSource = daemonIpcSource.slice(contextStart, contextEnd);
		const contextHits = contextSource.split("\n").flatMap((line, index) =>
			/\b(getPinHash|setPinHash)\b/.test(line)
				? [
						{
							path: daemonIpcPath,
							line:
								daemonIpcSource.slice(0, contextStart).split("\n").length +
								index,
							source: line.trim(),
							reason: "DaemonIPCContext should not carry PIN callbacks",
						},
					]
				: [],
		);

		expect([...daemonMainHits, ...contextHits]).toEqual([]);
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

	it("does not pass daemon status as a separate IPC Layer callback", () => {
		const retiredBridgePatterns = [
			{
				path: "src/lib/domain/daemon/Layers/daemon-layers.ts",
				pattern: /\bgetStatus:\s*\(\)\s*=>\s*DaemonStatus\b/,
				reason:
					"DaemonLiveOptions should not carry a separate IPC status callback",
			},
			{
				path: "src/lib/domain/daemon/Layers/daemon-layers.ts",
				pattern: /\boptions\.getStatus\b/,
				reason: "IPC status must come from DaemonIPCContext",
			},
			{
				path: "src/lib/daemon/daemon-lifecycle.ts",
				pattern: /\bstartIPCServer\([^)]*getStatus\b/s,
				reason: "startIPCServer should receive one IPC context surface",
			},
			{
				path: "src/lib/daemon/daemon-ipc.ts",
				pattern: /\bbuildIPCHandlers\(\s*ctx:\s*DaemonIPCContext,\s*getStatus:/,
				reason: "buildIPCHandlers should read status from DaemonIPCContext",
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

	it("does not drive relay internals directly from daemon-main IPC handlers", () => {
		const retiredBridgePatterns = [
			{
				pattern: /relay\.effectRuntime\.runtime\.runPromise/,
				reason:
					"daemon-main should use the ProjectRelay public surface, not its runtime internals",
			},
		] as const;
		const path = "src/lib/domain/daemon/Layers/daemon-main.ts";
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

	it("does not keep the deferred status poller runtime facade", () => {
		const path = "src/lib/domain/relay/Services/session-status-poller.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /\bDeferredStatusPollerRuntime\b/,
				reason: "status poller runtime is provided by its scoped Layer",
			},
			{
				pattern: /\bStatusPollerRuntimeNotAttachedError\b/,
				reason: "status poller runtime should not have a late-attach state",
			},
			{
				pattern: /\bmakeDeferredStatusPollerRuntime\b/,
				reason: "status poller runtime late attachment is retired",
			},
			{
				pattern: /\bonAttached\b/,
				reason:
					"status poller callbacks should not wait for runtime attachment",
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

	it("does not build client-init service bridges in relay-stack", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /\bClientInitDeps\b/,
				reason:
					"client init should consume relay Effect services directly, not a Promise-shaped dependency object",
			},
			{
				pattern: /\bclientInitDeps\b/,
				reason:
					"relay-stack should dispatch one Effect at the WebSocket callback boundary",
			},
			{
				pattern: /\bresolveClientInitHistory\b/,
				reason:
					"client-init history resolution belongs to the Effect-owned client-init handler",
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

	it("does not acquire startup relay services through piecemeal runtime calls", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /\bsessionServiceBridge\.initialize\b/,
				reason:
					"relay startup should initialize the session inside the startup Effect acquisition",
			},
			{
				pattern: /relayManagedRuntime\.runSync\(StatusPollerTag\)/,
				reason:
					"relay startup should acquire StatusPollerTag inside the startup Effect acquisition",
			},
			{
				pattern: /const pollerManager = await relayManagedRuntime\.runPromise/,
				reason:
					"relay startup should acquire PollerManagerTag inside the startup Effect acquisition",
			},
			{
				pattern: /relayManagedRuntime\.runSync\(OpenCodeAPITag\)/,
				reason:
					"relay startup should acquire OpenCodeAPITag inside the startup Effect acquisition",
			},
			{
				pattern: /relayManagedRuntime\.runSync\(WebSocketHandlerTag\)/,
				reason:
					"relay startup should acquire WebSocketHandlerTag inside the startup Effect acquisition",
			},
			{
				pattern: /const startupHandles = await relayManagedRuntime\.runPromise/,
				reason:
					"relay startup should not split API/WebSocket acquisition into a separate runtime bridge",
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

	it("keeps relay startup as the only relay-stack runPromise boundary", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const hits = Array.from(
			source.matchAll(/relayManagedRuntime\.runPromise\(/g),
		).map((match) => ({
			path,
			line: source.slice(0, match.index).split("\n").length,
			source: match[0],
		}));
		const marker =
			"External startup boundary for createProjectRelay()'s Promise API.";
		const markerIndex = source.indexOf(marker);
		const boundaryIndex = source.indexOf("relayManagedRuntime.runPromise(");

		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({
			path,
			source: "relayManagedRuntime.runPromise(",
		});
		expect(markerIndex).toBeGreaterThanOrEqual(0);
		expect(markerIndex).toBeLessThan(boundaryIndex);
		expect(boundaryIndex - markerIndex).toBeLessThan(300);
	});

	it("does not connect SSE and mark the command gate ready through separate runtime calls", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern:
					/await relayManagedRuntime\.runPromise\(\s*sseStream\.connectEffect\(\)\s*\);/,
				reason:
					"SSE connection should be sequenced with command-gate readiness inside one Effect program",
			},
			{
				pattern:
					/await relayManagedRuntime\.runPromise\(\s*Effect\.gen\(function\* \(\) \{\s*const gate = yield\* RelayCommandGateTag;\s*yield\* gate\.markReady\(\);\s*\}\),\s*\);/,
				reason:
					"command-gate readiness should not be a standalone runtime bridge",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			Array.from(source.matchAll(new RegExp(pattern, "g"))).map((match) => ({
				path,
				line: source.slice(0, match.index).split("\n").length,
				source: match[0].trim(),
				reason,
			})),
		);

		expect(hits).toEqual([]);
	});

	it("does not split relay startup acquisition from relay wiring setup", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern:
					/await relayManagedRuntime\.runPromise\(\s*Effect\.gen\(function\* \(\) \{\s*yield\* wireRelayWebSocketCallbacksEffect/s,
				reason:
					"relay startup, callback wiring, monitoring, pollers, SSE, and gate readiness should be one setup Effect program",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			Array.from(source.matchAll(new RegExp(pattern, "g"))).map((match) => ({
				path,
				line: source.slice(0, match.index).split("\n").length,
				source: match[0].trim(),
				reason,
			})),
		);

		expect(hits).toEqual([]);
	});

	it("does not drain SSE as a bare shutdown runtime bridge", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern:
					/await relayManagedRuntime\.runPromise\(\s*sseStream\.drainEffect\(\)\s*\);/,
				reason:
					"relay shutdown should sequence SSE drain and command-gate stop inside one Effect program",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			Array.from(source.matchAll(new RegExp(pattern, "g"))).map((match) => ({
				path,
				line: source.slice(0, match.index).split("\n").length,
				source: match[0].trim(),
				reason,
			})),
		);

		expect(hits).toEqual([]);
	});

	it("does not keep a duplicate pending-question bridge for SSE wiring", () => {
		const retiredBridgePatterns = [
			{
				path: "src/lib/relay/relay-stack.ts",
				pattern: /\bpendingQuestionCounts:\s*\{/,
				reason:
					"SSE wiring should update pending question counts through the session service",
			},
			{
				path: "src/lib/relay/sse-wiring.ts",
				pattern: /\bpendingQuestionCounts\b/,
				reason:
					"SSEWiringDeps should expose one session service surface for question counts",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ path, pattern, reason }) => {
			const source = readFileSync(join(REPO_ROOT, path), "utf8");
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

	it("does not keep a bespoke pending-permission bridge for SSE wiring", () => {
		const retiredBridgePatterns = [
			{
				path: "src/lib/relay/relay-stack.ts",
				pattern: /\bpendingPermissions:\s*\{/,
				reason: "SSE wiring should use the pending interaction service surface",
			},
			{
				path: "src/lib/relay/sse-wiring.ts",
				pattern: /\bPendingPermissionsLike\b/,
				reason:
					"SSE wiring should name pending interactions after the owned service",
			},
			{
				path: "src/lib/relay/sse-wiring.ts",
				pattern: /\bdeps\.pendingPermissions\b/,
				reason:
					"SSE wiring should use deps.pendingInteractions for pending state",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ path, pattern, reason }) => {
			const source = readFileSync(join(REPO_ROOT, path), "utf8");
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

	it("does not run pending-interaction SSE writes through relay-stack runtime calls", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /PendingInteractionServiceTag/,
				reason:
					"SSE pending interaction writes should be owned by the SSE Effect handler",
			},
			{
				pattern:
					/recordPermissionRequest:\s*\([^)]*\)\s*=>\s*relayManagedRuntime\.runSync/s,
				reason:
					"permission recording should not use a sync runtime bridge in relay-stack",
			},
			{
				pattern:
					/markPermissionReplied:\s*\([^)]*\)\s*=>\s*relayManagedRuntime\.runSync/s,
				reason:
					"permission reply tracking should not use a sync runtime bridge in relay-stack",
			},
			{
				pattern:
					/recoverPendingPermissions:\s*\([^)]*\)\s*=>\s*relayManagedRuntime\.runSync/s,
				reason:
					"permission recovery should not use a sync runtime bridge in relay-stack",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			Array.from(source.matchAll(new RegExp(pattern, "g"))).map((match) => ({
				path,
				line: source.slice(0, match.index).split("\n").length,
				source: match[0].trim(),
				reason,
			})),
		);

		expect(hits).toEqual([]);
	});

	it("does not wire production message pollers through relay-stack bridge deps", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /import \{ wirePollers \}/,
				reason:
					"production poller wiring should use the Effect-owned poller callback handler",
			},
			{
				pattern: /wirePollers\(\{/,
				reason:
					"production poller wiring should not consume sessionServiceBridge or processingTimeouts directly",
			},
			{
				pattern: /wirePollersEffect\([\s\S]*processingTimeouts/,
				reason:
					"message-poller timeout side effects should run through applyPipelineResultEffect",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			Array.from(source.matchAll(new RegExp(pattern, "g"))).map((match) => ({
				path,
				line: source.slice(0, match.index).split("\n").length,
				source: match[0].trim(),
				reason,
			})),
		);

		expect(hits).toEqual([]);
	});

	it("does not wire production monitoring through relay-stack bridge deps", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /import \{[^}]*\bwireMonitoring\b[^}]*\}/,
				reason:
					"production monitoring should use the Effect-owned status-poller callback handler",
			},
			{
				pattern: /wireMonitoring\(\{/,
				reason:
					"production monitoring should not consume sessionServiceBridge or processingTimeouts directly",
			},
			{
				pattern: /wireMonitoringEffect\([\s\S]*processingTimeouts/,
				reason:
					"monitoring timeout side effects should run through Effect services",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			Array.from(source.matchAll(new RegExp(pattern, "g"))).map((match) => ({
				path,
				line: source.slice(0, match.index).split("\n").length,
				source: match[0].trim(),
				reason,
			})),
		);

		expect(hits).toEqual([]);
	});

	it("does not bridge SSE processing timeouts through relay-stack", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /\bconst processingTimeouts = \{/,
				reason:
					"SSE pipeline timeout side effects should run through the Effect overrides state",
			},
			{
				pattern: /wireSSEConsumerEffect\([\s\S]*processingTimeouts/,
				reason:
					"production SSE wiring should not consume relay-stack timeout bridges",
			},
			{
				pattern:
					/relayManagedRuntime\.runFork\(\s*(?:clear|reset)ProcessingTimeout/,
				reason: "processing timeout mutation must stay inside Effect programs",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			Array.from(source.matchAll(new RegExp(pattern, "g"))).map((match) => ({
				path,
				line: source.slice(0, match.index).split("\n").length,
				source: match[0].trim(),
				reason,
			})),
		);

		expect(hits).toEqual([]);
	});

	it("does not bridge production SSE session service calls through relay-stack", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /const sseWiringDeps = \{[\s\S]*sessionService:/,
				reason:
					"production SSE event handling should consume SessionManagerServiceTag directly",
			},
			{
				pattern: /const sseWiringDeps = \{[\s\S]*getSessionParentMap:/,
				reason:
					"production SSE notification routing should read parent maps through SessionManagerServiceTag",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			Array.from(source.matchAll(new RegExp(pattern, "g"))).map((match) => ({
				path,
				line: source.slice(0, match.index).split("\n").length,
				source: match[0].trim(),
				reason,
			})),
		);

		expect(hits).toEqual([]);
	});

	it("does not keep a relay-stack session service bridge object", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /\bsessionServiceBridge\b/,
				reason:
					"relay-stack should call required SessionManagerService methods explicitly instead of keeping a broad bridge object",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			Array.from(source.matchAll(new RegExp(pattern, "g"))).map((match) => ({
				path,
				line: source.slice(0, match.index).split("\n").length,
				source: match[0].trim(),
				reason,
			})),
		);

		expect(hits).toEqual([]);
	});

	it("does not expose default-session runtime bridges from relay-stack", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /\bgetDefaultSessionId\(title\?: string\)/,
				reason:
					"relay startup should expose the initial session id as data instead of re-entering the session service through a Promise bridge",
			},
			{
				pattern: /\brunSessionServicePromise\b/,
				reason:
					"relay-stack should not keep Promise-shaped session service accessors",
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

	it("does not expose session-count runtime bridges from relay-stack", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /\bgetLastKnownSessionCount\(\)/,
				reason:
					"daemon status should read the relay status snapshot instead of re-entering the session service synchronously",
			},
			{
				pattern: /\brunSessionServiceSync\b/,
				reason: "relay-stack should not keep sync session service accessors",
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

	it("does not fork WebSocket callback programs directly from relay-stack", () => {
		const path = "src/lib/relay/relay-stack.ts";
		const source = readFileSync(join(REPO_ROOT, path), "utf8");
		const retiredBridgePatterns = [
			{
				pattern: /relayManagedRuntime\.runFork\(/,
				reason:
					"WebSocket callback registration should be owned by the relay WebSocket callback wiring effect",
			},
		] as const;

		const hits = retiredBridgePatterns.flatMap(({ pattern, reason }) =>
			Array.from(source.matchAll(new RegExp(pattern, "g"))).map((match) => ({
				path,
				line: source.slice(0, match.index).split("\n").length,
				source: match[0].trim(),
				reason,
			})),
		);

		expect(hits).toEqual([]);
	});
});

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
		path: "src/lib/daemon/daemon-lifecycle.ts",
		linePattern: /Effect\.runPromise\($/,
		reason:
			"Unix socket callback dispatches decoded tagged IPC into Effect RPC",
	},
	{
		path: "src/lib/effect/daemon-main.ts",
		linePattern: /Effect\.runSync\($/,
		reason: "transitional Node HTTP callback from NodeHttpServer.makeHandler",
	},
	{
		path: "src/lib/instance/sdk-factory.ts",
		linePattern: /Effect\.runPromise\(fetchWithRetry\(/,
		reason: "OpenCode SDK and GapEndpoints require a Promise-shaped fetch",
	},
	{
		path: "src/lib/relay/relay-stack.ts",
		linePattern: /Effect\.runSync\($/,
		reason:
			"transitional standalone Node HTTP callback from NodeHttpServer.makeHandler",
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
				path: "src/lib/effect/services.ts",
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
				path: "src/lib/effect/daemon-layers.ts",
				pattern: /Layer\.succeed\(\s*WebSocketRelayRouterTag,/,
				reason:
					"WebSocketRelayRouterTag must be built from daemon Effect services",
			},
			{
				path: "src/lib/effect/daemon-layers.ts",
				pattern: /\bwsRelayRouter:\s*WebSocketRelayRouter\b/,
				reason: "DaemonLiveOptions must not accept a prebuilt WebSocket router",
			},
			{
				path: "src/lib/effect/daemon-main.ts",
				pattern: /\bwsRelayRouter:\s*\{/,
				reason:
					"daemon-main must not bridge legacy project registry callbacks into WebSocket routing",
			},
			{
				path: "src/lib/effect/daemon-main.ts",
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
				path: "src/lib/effect/session-manager-service.ts",
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
				path: "src/lib/effect/services.ts",
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
});

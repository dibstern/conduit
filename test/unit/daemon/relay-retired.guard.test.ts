import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// 82tn.16's structural gate: per-project orchestration must not come back.
// Each map pins every remaining site exactly, so a slice that deletes one
// shrinks its map and nothing can return unseen. Sites marked "relay" are
// the per-project relay still waiting for deletion.

const daemon = "src/lib/domain/daemon";
const relay = "src/lib/relay";

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		if (entry.isDirectory())
			return file === "src/lib/frontend" ? [] : sources(file);
		return file.endsWith(".ts") ? [file] : [];
	});
}
const server = sources("src/lib");

const relayNames = new Set([
	"createProjectRelay",
	"createProjectRelayLayers",
	"startProjectRelay",
	"ProjectRelay",
	"ProjectRelayConfig",
	"createRelayStack",
	"EffectRelayServer",
	"RelayCacheTag",
	"RelayFactoryTag",
]);
const scopeOpeners = new Set(["Scope.make", "Scope.makeUnsafe", "Scope.fork"]);
// The relay's per-project client registry: which tabs view a session and which
// session each tab picked. The daemon's SessionActivity owns both (lane 16p).
const routingNames = new Set([
	"WebSocketHandlerTag",
	"getClientsForSession",
	"getClientSession",
	"registerSessionViewer",
]);
const openCodeHomeNames = new Set([
	"openCodeInstanceTarget",
	"openCodeInstanceId",
	"relayOpenCodeInstances",
	"makeStandaloneOpenCodeInstancesLive",
	// The relay's default OpenCode client, whose requests named the project folder.
	"OpenCodeAPILive",
	"backgroundOpenCodeAPI",
]);

/** Identifiers and called names in code, never in comments or strings. */
function names(text: string): string[] {
	const source = ts.createSourceFile(
		"s.ts",
		text,
		ts.ScriptTarget.Latest,
		true,
	);
	const hits: string[] = [];
	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression)
		)
			hits.push(node.expression.getText(source));
		if (ts.isIdentifier(node)) hits.push(node.text);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return hits;
}

const runTables =
	/\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update|delete\s+from)\s+(?:provider_runs|run_ledger_entries|run_ledger_sessions)\b/gi;
const runStateWrites = (text: string): string[] => text.match(runTables) ?? [];

const tally = (files: readonly string[], hits: (text: string) => string[]) => {
	const counts = new Map<string, number>();
	for (const file of files) {
		const found = hits(readFileSync(file, "utf8")).length;
		if (found > 0) counts.set(file, found);
	}
	return counts;
};
const named = (set: ReadonlySet<string>) => (text: string) =>
	names(text).filter((name) => set.has(name));

describe("per-project relay stays retired (82tn.16)", () => {
	it("builds no per-project Layer graph or runtime", () => {
		expect(tally(server, named(new Set(["ManagedRuntime.make"])))).toEqual(
			new Map([
				// The daemon's one runtime.
				[`${daemon}/Layers/daemon-foreground.ts`, 1],
				// relay
				[`${relay}/project-relay-layers.ts`, 1],
				[`${relay}/relay-stack.ts`, 1],
			]),
		);
		// Every remaining file that names the relay; all are relay.
		expect(tally(server, named(relayNames))).toEqual(
			new Map([
				[`${daemon}/Layers/auto-settle-layer.ts`, 2],
				[`${daemon}/Layers/daemon-foreground.ts`, 3],
				[`${daemon}/Layers/daemon-layers.ts`, 8],
				[`${daemon}/Layers/daemon-ws-rpc-layer.ts`, 4],
				[`${daemon}/Layers/opencode-instances-layer.ts`, 2],
				[`${daemon}/Layers/provider-adapters-layer.ts`, 3],
				[`${daemon}/Layers/relay-factory-layer.ts`, 10],
				[`${daemon}/Layers/worktree-cleanup-layer.ts`, 2],
				[`${daemon}/Services/daemon-handle.ts`, 5],
				[`${daemon}/Services/project-registry-service.ts`, 5],
				[`${daemon}/Services/relay-cache.ts`, 4],
				["src/lib/domain/relay/Layers/relay-core-layers.ts", 2],
				["src/lib/domain/relay/Services/services.ts", 3],
				["src/lib/domain/server/Layers/http-router-layer.ts", 2],
				["src/lib/domain/server/Layers/ws-routing-layer.ts", 3],
				["src/lib/handlers/types.ts", 2],
				[`${relay}/project-relay-layers.ts`, 3],
				[`${relay}/project-relay-startup.ts`, 5],
				[`${relay}/relay-stack.ts`, 24],
				["src/lib/types.ts", 1],
			]),
		);
	});

	it("runs a project's RPCs on the daemon's project context, never a relay's", () => {
		// Lane 16p: no RPC waits for a relay or reads its context. The cache entry
		// still carries the relay's context for relay-only test reads until S6.
		const relayRpc = new Set([
			"rpcWsHandler",
			"waitForRelay",
			"resolveProjectRpcContext",
		]);
		expect(tally(server, named(relayRpc))).toEqual(
			new Map([
				[`${daemon}/Layers/daemon-layers.ts`, 2],
				[`${daemon}/Services/relay-cache.ts`, 1],
				[`${relay}/project-relay-startup.ts`, 4],
				[`${relay}/relay-stack.ts`, 8],
			]),
		);
	});

	it("builds daemon-wide services once, in the daemon's layers", () => {
		const services = new Set([
			"makePortWatcherLive",
			"makeRunLedgerSchedulerLive",
			"makeEventRetentionSchedulerLive",
			"makeStatusPollerCoreLive",
			"makeStatusPollerCore",
			"GoalStuckStopReactorLive",
			"SessionWorkspaceHintReactorLive",
			"resolveOrphanedClaudePermissions",
			"makeOrphanedClaudePermissions",
			"PermissionTimeoutLive",
			"makeLocalPtyServiceLive",
			"makeHostedTerminalsLive",
			"RateLimiterLive",
		]);
		expect(tally(server, named(services))).toEqual(
			new Map([
				["src/lib/domain/persistence/Services/port-watcher.ts", 1],
				["src/lib/domain/persistence/Services/run-ledger-scheduler.ts", 1],
				["src/lib/domain/persistence/Services/event-retention-scheduler.ts", 1],
				// One reactor for every project, on the daemon's one session event bus.
				["src/lib/domain/relay/Services/goal-stuck-stop.ts", 1],
				["src/lib/domain/relay/Services/session-workspace-hint.ts", 1],
				// Each one's import and its one build.
				[`${daemon}/Layers/daemon-layers.ts`, 18],
				// The send limiter: one for the daemon, keyed by tab (lane 16o); its definition, and a
				// standalone relay's own.
				["src/lib/domain/relay/Layers/rate-limiter-layer.ts", 1],
				["src/lib/domain/relay/Layers/relay-layer.ts", 2],
				// Permission timeouts: one loop over every registered project, not one per relay.
				[`${daemon}/Layers/permission-timeout-layer.ts`, 1],
				// The PTY host's client: one for the daemon, which also closes a removed project's
				// terminals; its definition, and a standalone relay's own.
				[`${daemon}/Layers/hosted-terminals-layer.ts`, 3],
				["src/lib/domain/relay/Services/terminal-service.ts", 2],
				// Orphaned Claude asks: cleared for every registered project when the daemon starts, not at relay start.
				[
					"src/lib/domain/relay/Services/resolve-orphaned-claude-permissions.ts",
					1,
				],
				[`${daemon}/Layers/orphaned-permissions-layer.ts`, 3],
				[`${daemon}/Layers/daemon-orchestration-layer.ts`, 2],
				// A store opened without the daemon schedules its own project's retention.
				["src/lib/persistence/effect/live.ts", 2],
				// relay: a standalone relay's own alarm scheduler.
				[`${relay}/project-relay-layers.ts`, 2],
				// The status poller's definition and daemon layer, and a standalone relay's own poller.
				["src/lib/domain/relay/Layers/status-poller-layer.ts", 4],
			]),
		);
	});

	it("builds each project's context in the daemon, from the registry", () => {
		const builders = new Set([
			"makeSessionManagers",
			"ownSessionManagersLive",
			"attachSessionManagerLive",
			"SessionManagersOrOwn",
			"RelayStatusSnapshotLive",
			"makeRelayStatusSnapshot",
			"OpenCodeModelServiceLive",
			"makePersistenceProjectLayer",
			"makeProjectIngestionLive",
			"makeProjectOpenCodeIngressLive",
			"makeProviderRuntimeIngestionLive",
			"makeEffectOpenCodeRuntimeIngress",
			"makeSessionTitleServiceLive",
			"ProjectSettingsLive",
			"ToolContentServiceLive",
			"DirectoryListingServiceLive",
			"AgentLivenessLive",
			"attachProviderTurnsLive",
			"SessionInboxLive",
			"AgentServiceLive",
			"OpenCodeTerminalServiceLive",
			"makePtyRuntimeLive",
			"OpenCodeFileServiceLive",
			"OpenCodeSettingsServiceLive",
			"makeRecapServiceLive",
			"makeGoalSummaryServiceLive",
			"MessagePollerManagerLive",
		]);
		expect(tally(server, named(builders))).toEqual(
			new Map([
				// ProjectServices: each project's session-manager parts and generation,
				// with its ingestion side (82tn.16 slice 4) and its settings and
				// titles (slice 5), and its tool details, directory listing and agent
				// liveness (slice 7), and its turns, inbox and agent service, and its
				// terminals, OpenCode file and catalog readers, and recaps and goal
				// summaries (lane 16o), and its message poller (lane 16p).
				[`${daemon}/Layers/project-services-layer.ts`, 40],
				// The ingestion side's definitions: pending interactions, alert ledger,
				// provider ingestion, the OpenCode ingress with its history ports, and
				// agent liveness.
				["src/lib/domain/relay/Layers/project-ingestion-layer.ts", 7],
				[
					"src/lib/domain/relay/Services/opencode-runtime-ingress-service.ts",
					1,
				],
				[
					"src/lib/domain/relay/Services/provider-runtime-ingestion-service.ts",
					2,
				],
				["src/lib/domain/relay/Services/project-settings.ts", 1],
				["src/lib/domain/relay/Services/session-title-service.ts", 1],
				["src/lib/domain/relay/Services/tool-content-service.ts", 1],
				["src/lib/domain/relay/Services/directory-listing-service.ts", 1],
				["src/lib/domain/relay/Services/provider-turn-service.ts", 2],
				["src/lib/domain/relay/Services/session-inbox.ts", 1],
				["src/lib/domain/relay/Services/agent-service.ts", 1],
				["src/lib/domain/relay/Services/recap-service.ts", 1],
				["src/lib/domain/relay/Services/goal-summary-service.ts", 1],
				["src/lib/domain/relay/Services/terminal-service.ts", 1],
				["src/lib/domain/relay/Layers/pty-manager-layer.ts", 1],
				["src/lib/domain/relay/Layers/message-poller-manager-layer.ts", 1],
				// Definitions, and a store opened without the daemon.
				["src/lib/domain/relay/Services/session-manager-service.ts", 3],
				["src/lib/domain/relay/Services/relay-status-snapshot.ts", 3],
				["src/lib/domain/relay/Services/services.ts", 3],
				["src/lib/persistence/effect/live.ts", 2],
				// relay: a standalone relay's own copies, which a relay of a registered
				// project builds only when the daemon cannot build the project.
				["src/lib/domain/relay/Layers/relay-layer.ts", 7],
				[`${relay}/project-relay-layers.ts`, 42],
			]),
		);
	});

	it("opens project and session lifetimes only in Owner Scopes", () => {
		expect(tally(server, named(scopeOpeners))).toEqual(
			new Map([
				// Owner Scopes opens every project and session scope.
				[`${daemon}/Layers/owner-scopes-layer.ts`, 1],
				// An account's resources and the keep-awake hold: not a project's or session's.
				[`${daemon}/Layers/account-resource-scopes-layer.ts`, 1],
				[`${daemon}/Layers/keep-awake-layer.ts`, 1],
				// One command scope per engine: the daemon's, and relay's standalone fallback.
				["src/lib/provider/orchestration-engine.ts", 1],
				// Runner processes' own lifetimes, outside the daemon.
				["src/lib/provider/codex/codex-runner-payload.ts", 1],
				["src/lib/provider/runner/runner-entry-lifecycle.ts", 1],
				["src/lib/provider/runner/runner-provider-instance.ts", 1],
				["src/lib/provider/runner/send-scope.ts", 1],
				// The HTTP edge's per-request scope.
				["src/lib/domain/server/Layers/http-router-layer.ts", 1],
			]),
		);
	});

	it("routes browser events only through Event Audiences", () => {
		expect(tally(server, named(routingNames))).toEqual(new Map());
	});

	it("writes Run state only in the Run Ledger", () => {
		// No allowlist: only the ledger's store, its projection and schema history.
		expect(tally(server, runStateWrites)).toEqual(
			new Map([
				// Schema history: the session-delete cascade trigger, one backfill and the
				// upgrade's mark on an older build's unstarted claims (0097).
				["src/lib/persistence/effect/migrations.ts", 3],
				["src/lib/persistence/effect/projectors-effect.ts", 8],
				["src/lib/persistence/effect/run-ledger-arm.ts", 4],
			]),
		);
	});

	it("names no per-project or relay OpenCode home", () => {
		expect(tally(server, named(openCodeHomeNames))).toEqual(
			new Map([
				// relay: the standalone instance set.
				[`${daemon}/Layers/opencode-instances-layer.ts`, 1],
				[`${relay}/project-relay-layers.ts`, 2],
			]),
		);
	});

	it("tests reach projects only through the daemon harness", () => {
		const tests = ["test", "scripts"].flatMap(sources);
		expect(
			tests.filter((file) =>
				/helpers\/(relay-harness|project-relay)\.ts$/.test(file),
			),
		).toEqual([]);
		expect(
			tally(
				tests,
				named(new Set(["createTestProjectRelay", "createTestRelayStack"])),
			),
		).toEqual(new Map());
	});

	it.each([
		["const r = ManagedRuntime.make(layer)", "ManagedRuntime.make"],
		["import { createProjectRelay } from 'x'", "createProjectRelay"],
		["const s = yield* Scope.fork(parent)", "Scope.fork"],
		["const s = Scope.makeUnsafe()", "Scope.makeUnsafe"],
		["const ws = yield* WebSocketHandlerTag", "WebSocketHandlerTag"],
		["layer(relayOpenCodeInstances(x))", "relayOpenCodeInstances"],
	])("finds %s in code", (text, hit) => {
		expect(names(text)).toContain(hit);
	});

	it.each([
		"// ManagedRuntime.make(layer) createProjectRelay",
		"const s = 'Scope.fork(parent) WebSocketHandlerTag';",
	])("ignores comments and strings: %s", (text) => {
		const all = new Set([
			...relayNames,
			...scopeOpeners,
			...routingNames,
			"ManagedRuntime.make",
		]);
		expect(names(text).filter((name) => all.has(name))).toEqual([]);
	});

	it.each([
		"sql`UPDATE provider_runs SET status = 'done'`",
		"sql`insert or replace into run_ledger_entries (a) values (1)`",
		"sql`DELETE FROM run_ledger_sessions WHERE session_id = 1`",
	])("finds the run-state write in %s", (text) => {
		expect(runStateWrites(text)).toHaveLength(1);
	});
});

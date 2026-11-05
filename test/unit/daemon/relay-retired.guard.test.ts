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
const routingNames = new Set(["WebSocketHandlerTag", "getClientsForSession"]);
const openCodeHomeNames = new Set([
	"openCodeInstanceTarget",
	"openCodeInstanceId",
	"relayOpenCodeInstances",
	"makeStandaloneOpenCodeInstancesLive",
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
				[`${relay}/project-relay-layers.ts`, 4],
				[`${relay}/project-relay-startup.ts`, 5],
				[`${relay}/relay-stack.ts`, 24],
				["src/lib/types.ts", 1],
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
				// relay
				["src/lib/domain/relay/Layers/message-poller-manager-layer.ts", 1],
				["src/lib/domain/relay/Services/sse-stream-service.ts", 1],
				["src/lib/domain/server/Layers/http-router-layer.ts", 1],
			]),
		);
	});

	it("routes browser events only through Event Audiences", () => {
		expect(tally(server, named(routingNames))).toEqual(
			new Map([
				// relay: the per-project client registry and its readers.
				["src/lib/domain/relay/Layers/websocket-handler-layer.ts", 3],
				["src/lib/domain/relay/Services/services.ts", 2],
				["src/lib/domain/relay/Services/session-registry-state.ts", 1],
				["src/lib/domain/relay/Services/terminal-service.ts", 3],
				["src/lib/handlers/model.ts", 3],
				["src/lib/handlers/permissions.ts", 4],
				["src/lib/handlers/prompt.ts", 2],
				["src/lib/handlers/session.ts", 3],
				["src/lib/handlers/types.ts", 1],
				[`${relay}/monitoring-wiring.ts`, 5],
				[`${relay}/poller-wiring.ts`, 2],
				[`${relay}/project-relay-layers.ts`, 2],
				[`${relay}/project-relay-publisher.ts`, 1],
				[`${relay}/project-relay-startup.ts`, 2],
				[`${relay}/relay-stack.ts`, 1],
				[`${relay}/sse-wiring.ts`, 2],
				["src/lib/server/effect-ws-handler.ts", 1],
				["src/lib/server/ws-handler-shape.ts", 1],
				["src/lib/server/ws-rpc.ts", 2],
				["src/lib/session/worktree-cleanup-sweep.ts", 3],
			]),
		);
	});

	it("writes Run state only in the Run Ledger", () => {
		// No allowlist: only the ledger's store, its projection and schema history.
		expect(tally(server, runStateWrites)).toEqual(
			new Map([
				// Schema history: the session-delete cascade trigger and one backfill.
				["src/lib/persistence/effect/migrations.ts", 2],
				["src/lib/persistence/effect/projectors-effect.ts", 8],
				["src/lib/persistence/effect/run-ledger-arm.ts", 4],
			]),
		);
	});

	it("names no per-project or relay OpenCode home", () => {
		expect(tally(server, named(openCodeHomeNames))).toEqual(
			new Map([
				// relay: the standalone instance set and its directory default.
				[`${daemon}/Layers/opencode-instances-layer.ts`, 1],
				[`${relay}/project-relay-layers.ts`, 4],
			]),
		);
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

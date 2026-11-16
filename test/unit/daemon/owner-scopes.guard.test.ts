import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// These are the daemon-owned destinations for 82tn.10.6, 10.7, 12 and 14.
// Project-services and provider code outside the daemon domain is deliberately
// outside this migration guard.
const root = "src/lib/domain/daemon";
const legacyCalls = new Map([
	[`${root}/Layers/opencode-instances-reconcile.ts:setTimeout`, 1],
	[`${root}/Layers/provider-adapters-layer.ts:Effect.runForkWith`, 1],
	// The subprocess owner now holds worktree timeouts and SIGKILL escalation;
	// both timers are cleared when its child closes or its scope is released.
	// The third paces an owned child's awaited stop() until its group is gone.
	[`${root}/Services/subprocess.ts:setTimeout`, 3],
	[`${root}/Services/local-trace-artifact.ts:setTimeout`, 1],
	[`${root}/Services/turn-timeline.ts:setTimeout`, 1],
]);
const forbidden = new Set([
	"forkDaemon",
	"forkDetach",
	"runFork",
	"runForkWith",
	"setTimeout",
	"setInterval",
	"setImmediate",
]);

function calls(text: string): string[] {
	const source = ts.createSourceFile(
		"source.ts",
		text,
		ts.ScriptTarget.Latest,
		true,
	);
	const aliases = new Map<string, string>();
	const hits: string[] = [];
	const nameOf = (expression: ts.Expression): string | undefined =>
		ts.isIdentifier(expression)
			? (aliases.get(expression.text) ?? expression.text)
			: ts.isPropertyAccessExpression(expression)
				? expression.name.text
				: ts.isElementAccessExpression(expression) &&
						ts.isStringLiteral(expression.argumentExpression)
					? expression.argumentExpression.text
					: undefined;
	const visit = (node: ts.Node) => {
		if (ts.isImportSpecifier(node)) {
			aliases.set(node.name.text, node.propertyName?.text ?? node.name.text);
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer
		) {
			const name = nameOf(node.initializer);
			if (name) aliases.set(node.name.text, name);
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isObjectBindingPattern(node.name)
		) {
			for (const binding of node.name.elements) {
				if (ts.isIdentifier(binding.name))
					aliases.set(
						binding.name.text,
						binding.propertyName?.getText(source) ?? binding.name.text,
					);
			}
		}
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const name = nameOf(callee);
			if (name && forbidden.has(name)) hits.push(callee.getText(source));
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return hits;
}

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory()
			? sources(path)
			: path.endsWith(".ts")
				? [path]
				: [];
	});
}

describe("Owner Scope source boundary", () => {
	// A removed project's running Runs end by their runner's loss when its
	// scope closes, so scope closure settles no Run itself (CONTRACT.md 3.11).
	it("OS23 closes an owner's scope without settling Runs itself", () => {
		const source = readFileSync(`${root}/Layers/owner-scopes-layer.ts`, "utf8");
		expect(source).not.toMatch(/82tn\.32\.12|projectInactive/);
		expect(source).not.toMatch(/import[^;]*run-ledger/);
	});

	it("OS20 composes Owner Scopes into the daemon after SessionDirectory", () => {
		const source = readFileSync(`${root}/Layers/daemon-layers.ts`, "utf8");
		expect(source).toMatch(
			/OwnerScopesLive\.pipe\(\s*Layer\.provideMerge\(withSessionDirectory\)/,
		);
	});

	it("OS24 prevents new detached fibers and raw timers throughout daemon domain modules", () => {
		const actual = new Map<string, number>();
		for (const path of sources(root)) {
			for (const call of calls(readFileSync(path, "utf8"))) {
				const key = `${path}:${call}`;
				actual.set(key, (actual.get(key) ?? 0) + 1);
			}
		}
		expect(actual).toEqual(legacyCalls);
	});

	it.each([
		"Effect.forkDaemon(work)",
		"Effect.forkDetach(work)",
		"Effect.runFork(work)",
		"Effect.runForkWith(context)(work)",
		"runtime.runFork(work)",
		"setTimeout(callback, 1)",
		"globalThis.setInterval(callback, 1)",
		"timers.setImmediate(callback)",
		'import { setTimeout as sleep } from "node:timers/promises"; sleep(1)',
		'import { forkDaemon as launch } from "effect/Effect"; launch(work)',
		"const { setInterval: repeat } = globalThis; repeat(callback, 1)",
		'Effect["runFork"](work)',
		"const launch = Effect.runFork; launch(work)",
		"const later = globalThis.setTimeout; later(callback, 1)",
		"const launch = Effect.runFork; const alias = launch; alias(work)",
	])("OS24 detects forbidden launch %s", (source) => {
		expect(calls(source)).toHaveLength(1);
	});

	it("OS24 permits scoped forks and Effect scheduling instead of raw timers", () => {
		expect(
			calls(
				"Effect.forkIn(ownerScope); Effect.forkScoped(work); Effect.sleep(1)",
			),
		).toEqual([]);
	});
});

// 82tn.10.9: the daemon owns sessions and turns. A project's services lend
// their parts and name no owner's constructor; the standalone fallbacks live in
// the test harness.
const ownerConstructors = new Set([
	"SessionManagerServiceLive",
	"ProviderTurnsLive",
	"DraftPreWarmLive",
	"SessionWorkspaceLive",
	"SessionSetupLive",
	"DaemonTurnsLive",
]);
const scopeOpeners = new Set([
	"Scope.make",
	"Scope.makeUnsafe",
	"Scope.fork",
	"Scope.forkUnsafe",
	"ManagedRuntime.make",
]);
const ownerModules = [
	"src/lib/domain/project-services/Services/provider-turn-service.ts",
	"src/lib/domain/project-services/Services/provider-turn-dispatch.ts",
	"src/lib/domain/project-services/Services/provider-turn-session.ts",
	"src/lib/domain/project-services/Services/session-manager-service.ts",
	"src/lib/domain/project-services/Services/draft-prewarm.ts",
	"src/lib/domain/project-services/Services/session-setup.ts",
	"src/lib/domain/project-services/Layers/session-workspace-layer.ts",
	"src/lib/provider/orchestration-wiring.ts",
];
// Each remaining opener, and why it is not a project or session scope.
const scopeOpenerSites = new Map([
	// Owner Scopes opens every project and session scope.
	[`${root}/Layers/owner-scopes-layer.ts:Scope.makeUnsafe`, 1],
	// An account's resources, not a project's or session's.
	[`${root}/Layers/account-resource-scopes-layer.ts:Scope.make`, 1],
	[`${root}/Layers/keep-awake-layer.ts:Scope.fork`, 1],
	// A project's start, a child of the generation Owner Scopes opened, so a
	// failed start closes alone (lane 16q). Unsafe, so the decision to start and
	// its record are one step that `close` cannot split (h0x3p).
	[`${root}/Layers/project-services-layer.ts:Scope.forkUnsafe`, 1],
	// The daemon's own runtime.
	[`${root}/Layers/daemon-foreground.ts:ManagedRuntime.make`, 1],
]);

function constructions(text: string): string[] {
	const source = ts.createSourceFile(
		"source.ts",
		text,
		ts.ScriptTarget.Latest,
		true,
	);
	const hits: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node) && ownerConstructors.has(node.text))
			hits.push(node.text);
		if (
			ts.isNewExpression(node) &&
			node.expression.getText(source) === "OrchestrationEngine"
		)
			hits.push("new OrchestrationEngine");
		if (
			ts.isCallExpression(node) &&
			scopeOpeners.has(node.expression.getText(source))
		)
			hits.push(node.expression.getText(source));
		if (ts.isIdentifier(node) && node.text === "WebSocketHandlerTag")
			hits.push("WebSocketHandlerTag");
		ts.forEachChild(node, visit);
	};
	visit(source);
	return hits;
}

const tally = (paths: readonly string[], kept: (hit: string) => boolean) => {
	const actual = new Map<string, number>();
	for (const path of paths)
		for (const hit of constructions(readFileSync(path, "utf8")).filter(kept)) {
			const key = `${path}:${hit}`;
			actual.set(key, (actual.get(key) ?? 0) + 1);
		}
	return actual;
};

describe("daemon-owned sessions and turns (82tn.10.9)", () => {
	it("OpenCode streaming and terminal code name no daemon owner's constructor and build no engine", () => {
		expect(
			tally(
				[
					...sources("src/lib/provider/opencode"),
					...sources("src/lib/terminal"),
				],
				(hit) =>
					ownerConstructors.has(hit) || hit === "new OrchestrationEngine",
			),
		).toEqual(new Map());
	});

	it("only the daemon builds an engine", () => {
		expect(
			tally(sources("src/lib"), (hit) => hit === "new OrchestrationEngine"),
		).toEqual(
			new Map([
				[
					`${root}/Layers/daemon-orchestration-layer.ts:new OrchestrationEngine`,
					1,
				],
			]),
		);
	});

	it("only Owner Scopes opens project and session scopes; no new runtimes", () => {
		expect(
			tally(
				[
					...sources(root),
					...sources("src/lib/provider/opencode"),
					...sources("src/lib/terminal"),
					...ownerModules,
				],
				(hit) => scopeOpeners.has(hit),
			),
		).toEqual(scopeOpenerSites);
	});

	it("session and turn owners reach clients only through Event Delivery", () => {
		expect(
			tally(
				[...ownerModules, `${root}/Services/daemon-turns.ts`],
				(hit) => hit === "WebSocketHandlerTag",
			),
		).toEqual(new Map());
	});

	it.each([
		[
			"import { SessionManagerServiceLive } from 'x'",
			"SessionManagerServiceLive",
		],
		["Layer.provide(ProviderTurnsLive)", "ProviderTurnsLive"],
		["const e = new OrchestrationEngine({})", "new OrchestrationEngine"],
		["const s = yield* Scope.make()", "Scope.make"],
		["const s = Scope.makeUnsafe('sequential')", "Scope.makeUnsafe"],
		["const s = yield* Scope.fork(parent)", "Scope.fork"],
		["const r = ManagedRuntime.make(layer)", "ManagedRuntime.make"],
		["type R = WebSocketHandlerTag", "WebSocketHandlerTag"],
	])("detects %s", (text, hit) => {
		expect(constructions(text)).toEqual([hit]);
	});
});

describe("one alert feed and pollers held by tabs (82tn.12)", () => {
	const read = (path: string) => readFileSync(path, "utf8");

	it("only the daemon builds the alert feed", () => {
		expect(read(`${root}/Layers/daemon-layers.ts`)).toContain(
			"Layer.merge(AlertsLive)",
		);
		// Its definition, and the daemon's import and one build.
		expect(
			sources("src/lib").filter((file) => /\bAlertsLive\b/.test(read(file))),
		).toEqual([
			`${root}/Layers/daemon-layers.ts`,
			"src/lib/domain/project-services/Services/alerts.ts",
		]);
	});

	it("a tab hears every project's alerts and asks (82tn.13)", () => {
		const delivery = read("src/lib/server/event-delivery.ts");
		expect(delivery).toMatch(/SubscribeAlerts: globalAudience,/);
		expect(delivery).toMatch(/SubscribeApprovals: globalAudience,/);
	});

	it("only tabs viewing a session hold its message poller", () => {
		const poller = read("src/lib/provider/opencode/message-poller-impl.ts");
		expect(poller).toContain("VIEWER_GRACE_MS");
		expect(poller).not.toMatch(/lastContentAt|IDLE_TIMEOUT_MS/);
	});

	it("one daemon owner tells tabs and devices about every project's asks", () => {
		expect(
			read(`${root}/Layers/daemon-layers.ts`).match(/\bAskAlertsLive\b/g),
		).toHaveLength(2);
		expect(read(`${root}/Layers/ask-alerts-layer.ts`)).toContain(
			"subscribeEveryProjectApprovals(",
		);
		// No second ding: SSE wiring pushes no asks and the tab's approvals store dings nothing.
		expect(read("src/lib/provider/opencode/sse-wiring.ts")).not.toMatch(
			/AskedPush|permission\.asked[^\n]*sendPush/,
		);
		expect(read("src/lib/frontend/stores/approvals.ts")).not.toContain(
			"triggerNotifications",
		);
	});
});

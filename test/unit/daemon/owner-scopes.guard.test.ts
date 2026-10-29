import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// These are the daemon-owned destinations for 82tn.10.6, 10.7, 12 and 14.
// Legacy relay/provider code is deliberately outside this migration guard.
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
	it("OS23 reserves exactly one Run Ledger seam before scope closure", () => {
		const source = readFileSync(`${root}/Layers/owner-scopes-layer.ts`, "utf8");
		expect(source.match(/82tn\.32\.12/g)).toHaveLength(1);
		expect(source).toMatch(/82tn\.32\.12[^\n]*projectInactive/);
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

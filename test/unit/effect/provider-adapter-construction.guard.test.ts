import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const adapterSources = [
	"src/lib/provider/claude/claude-provider-instance.ts",
	"src/lib/provider/claude/claude-provider-runtime.ts",
	"src/lib/provider/claude/claude-process-session-runner.ts",
	"src/lib/provider/claude/claude-runner-driver.ts",
	"src/lib/provider/cursor/cursor-provider-runtime.ts",
	"src/lib/provider/cursor/cursor-runner-driver.ts",
	"src/lib/provider/opencode-provider-instance.ts",
	"src/lib/provider/runner/runner-provider-instance.ts",
	"src/lib/provider/runner/process-session-runner.ts",
	"src/lib/provider/runner/in-process-session-runner.ts",
] as const;

const capturedInputs = new Set([
	"folder",
	"directory",
	"projectDir",
	"projectRoot",
	"workspaceRoot",
	"extraFolders",
	"shellEnv",
	"prepareShellEnv",
]);

function capturedConstructorInputs(
	sources: ReadonlyArray<readonly [string, string]>,
): string[] {
	const hits: string[] = [];
	for (const [path, text] of sources) {
		const source = ts.createSourceFile(
			path,
			text,
			ts.ScriptTarget.Latest,
			true,
		);
		const record = (node: ts.Node, name: string) => {
			if (capturedInputs.has(name)) {
				const { line } = source.getLineAndCharacterOfPosition(
					node.getStart(source),
				);
				hits.push(`${path}:${line + 1}: constructor input ${name}`);
			}
		};
		const inputTypes = new Map(
			source.statements
				.filter(
					(node) =>
						ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node),
				)
				.map((node) => [node.name.text, node]),
		);
		const inspected = new Set<ts.Node>();
		const inspect = (node: ts.Node) => {
			if (inspected.has(node)) return;
			inspected.add(node);
			if (
				(ts.isPropertySignature(node) || ts.isPropertyAssignment(node)) &&
				(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
			)
				record(node, node.name.text);
			// Pick<T, "workspaceRoot"> is a constructor input too.
			if (ts.isStringLiteral(node)) record(node, node.text);
			if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
				const declaration = inputTypes.get(node.typeName.text);
				if (declaration) inspect(declaration);
			}
			// Callback arguments describe calls, not captured constructor state.
			if (ts.isFunctionTypeNode(node)) return;
			ts.forEachChild(node, inspect);
		};
		const visit = (node: ts.Node) => {
			if (
				(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
				/(?:ProviderInstance(?:Deps|Options)|RunnerDeps)$/.test(node.name.text)
			) {
				inspect(node);
			}
			if (
				ts.isConstructorDeclaration(node) ||
				ts.isFunctionDeclaration(node) ||
				ts.isArrowFunction(node) ||
				ts.isFunctionExpression(node) ||
				ts.isMethodDeclaration(node)
			) {
				const name =
					ts.isVariableDeclaration(node.parent) ||
					ts.isPropertyAssignment(node.parent)
						? node.parent.name.getText(source)
						: ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
							? node.name?.getText(source)
							: undefined;
				// Factory names are open-ended; Layer factories also construct adapters.
				const factory =
					/^(?:(?:make|create)[A-Z]|create$)/.test(name ?? "") ||
					(node.type &&
						ts.isTypeReferenceNode(node.type) &&
						node.type.typeName.getText(source) === "Layer.Layer");
				if (ts.isConstructorDeclaration(node) || factory) {
					for (const parameter of node.parameters) {
						record(parameter, parameter.name.getText(source));
						if (parameter.type) inspect(parameter.type);
						if (parameter.initializer) inspect(parameter.initializer);
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return hits;
}

describe("daemon-owned provider adapter construction", () => {
	it("accepts folders and frozen shell environments only on calls", () => {
		const hits = capturedConstructorInputs(
			adapterSources.map((path) => [path, readFileSync(path, "utf8")]),
		);
		expect(hits).toEqual([]);
	});

	it.each([
		[
			"src/lib/provider/runner/runner-provider-instance.ts",
			"makeRunnerProviderInstance",
		],
		[
			"src/lib/provider/claude/claude-provider-runtime.ts",
			"makeClaudeSessionRunner",
		],
	])("rejects workspace context added to %s's %s factory", (path, factory) => {
		const text = readFileSync(path, "utf8");
		const source = ts.createSourceFile(
			path,
			text,
			ts.ScriptTarget.Latest,
			true,
		);
		let factoryArrow: ts.ArrowFunction | undefined;
		const visit = (node: ts.Node) => {
			if (
				ts.isVariableDeclaration(node) &&
				node.name.getText(source) === factory &&
				node.initializer &&
				ts.isArrowFunction(node.initializer)
			) {
				factoryArrow = node.initializer;
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		if (!factoryArrow) throw new Error(`Missing factory ${factory}`);
		const insertion =
			factoryArrow.parameters[factoryArrow.parameters.length - 1]?.end;
		if (insertion === undefined)
			throw new Error(`Missing parameters for ${factory}`);
		const mutated = `${text.slice(0, insertion)}, workspaceRoot?: string${text.slice(insertion)}`;
		// A valid optional parameter must be rejected by the constructor guard.
		expect(
			ts.transpileModule(mutated, { reportDiagnostics: true }).diagnostics,
		).toEqual([]);
		expect(capturedConstructorInputs([[path, mutated]])).toEqual([
			expect.stringContaining("constructor input workspaceRoot"),
		]);
	});

	it.each([
		"export function makeFutureAdapter(workspaceRoot?: string) {}",
		"export const createFutureAdapter = (workspaceRoot?: string) => ({});",
		"export const makeFutureAdapter = function(workspaceRoot?: string) {};",
		"export const FutureDriver = { create: (workspaceRoot?: string) => ({}) };",
		"export const FutureDriver = { create(workspaceRoot?: string) {} };",
		"export const FutureRuntimeLive = (workspaceRoot?: string): Layer.Layer<Runtime> => layer;",
	])("rejects workspace context in new construction factories: %s", (text) => {
		expect(capturedConstructorInputs([["future-adapter.ts", text]])).toEqual([
			expect.stringContaining("constructor input workspaceRoot"),
		]);
	});

	it("requires project engines to borrow the daemon adapters", () => {
		const wiring = readFileSync(
			"src/lib/provider/orchestration-wiring.ts",
			"utf8",
		);
		expect(/(?:ClaudeDriver|OpenCodeDriver)\.create\s*\(/.test(wiring)).toBe(
			false,
		);
		expect(/makeCursorProviderRuntime\s*\(/.test(wiring)).toBe(false);
		expect(/serviceOption\(ProviderAdapters\)/.test(wiring)).toBe(false);
		const startup = readFileSync(
			"src/lib/relay/project-relay-startup.ts",
			"utf8",
		);
		expect(/instance\.recoverEffect\s*\(/.test(startup)).toBe(false);
		expect(/serviceOption\(ProviderAdapters\)/.test(startup)).toBe(false);
		const engine = readFileSync(
			"src/lib/provider/orchestration-engine.ts",
			"utf8",
		);
		expect(engine.includes("shutdownAllEffect")).toBe(false);
	});
});

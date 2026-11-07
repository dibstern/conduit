import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// 82tn.16: the per-project relay is deleted. Its folder, and every name that
// built a relay or read one, stay gone from src and the tests.

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		if (entry.isDirectory())
			return file === "src/lib/frontend" ? [] : sources(file);
		return file.endsWith(".ts") ? [file] : [];
	});
}

const relayConstruction = new Set([
	// The relay, its layers, its stack and its startup.
	"createProjectRelay",
	"createProjectRelayLayers",
	"startProjectRelay",
	"ProjectRelay",
	"createRelayStack",
	"EffectRelayServer",
	"RelayCacheTag",
	"RelayFactoryTag",
	// The test harness that built one.
	"createTestProjectRelay",
	"createTestRelayStack",
	// Reads of a relay's context or its RPC handler (lanes 16p, 16q).
	"rpcWsHandler",
	"waitForRelay",
	"resolveProjectRpcContext",
	// The relay's per-project client registry; SessionActivity owns both maps.
	"WebSocketHandlerTag",
	"getClientsForSession",
	"getClientSession",
	"registerSessionViewer",
	// The relay's own OpenCode home and default client.
	"openCodeInstanceTarget",
	"openCodeInstanceId",
	"relayOpenCodeInstances",
	"makeStandaloneOpenCodeInstancesLive",
	"OpenCodeAPILive",
	"backgroundOpenCodeAPI",
]);

/** Identifiers in code, never in comments or strings. */
function names(text: string): string[] {
	const source = ts.createSourceFile(
		"s.ts",
		text,
		ts.ScriptTarget.Latest,
		true,
	);
	const hits: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node)) hits.push(node.text);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return hits;
}

const constructions = (text: string) =>
	names(text).filter((name) => relayConstruction.has(name));

describe("the per-project relay stays deleted (82tn.16)", () => {
	it("has no src/lib/relay directory", () => {
		expect(existsSync("src/lib/relay")).toBe(false);
	});

	it("builds no relay, in src or the tests", () => {
		const files = [...sources("src/lib"), ...sources("test")];
		expect(
			files.flatMap((file) =>
				constructions(readFileSync(file, "utf8")).map(
					(name) => `${file}: ${name}`,
				),
			),
		).toEqual([]);
		expect(
			files.filter((file) =>
				/helpers\/(relay-harness|project-relay)\.ts$/.test(file),
			),
		).toEqual([]);
	});

	it.each([
		["import { createProjectRelay } from 'x'", "createProjectRelay"],
		["const ws = yield* WebSocketHandlerTag", "WebSocketHandlerTag"],
		["layer(relayOpenCodeInstances(x))", "relayOpenCodeInstances"],
	])("finds %s in code", (text, hit) => {
		expect(constructions(text)).toEqual([hit]);
	});

	it.each([
		"// createProjectRelay(config) WebSocketHandlerTag",
		"const s = 'createRelayStack(options)';",
	])("ignores comments and strings: %s", (text) => {
		expect(constructions(text)).toEqual([]);
	});
});

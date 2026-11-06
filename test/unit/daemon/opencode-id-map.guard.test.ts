import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// 82tn.80's structural gate: a Conduit session id never reaches OpenCode as a
// native id, and a native id never reaches the store unmapped. OpenCodeAPI maps
// every session id it sends and receives through OpenCodeSessionIds; the event
// boundary maps every event. Each map pins its sites exactly.

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		if (entry.isDirectory())
			return file === "src/lib/frontend" ? [] : sources(file);
		return file.endsWith(".ts") ? [file] : [];
	});
}
const server = sources("src/lib");

function visit(file: string, see: (node: ts.Node) => void): void {
	const source = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const walk = (node: ts.Node) => {
		see(node);
		ts.forEachChild(node, walk);
	};
	walk(source);
}

function propertyNamed(
	node: ts.ObjectLiteralExpression,
	name: string,
): ts.ObjectLiteralElementLike | undefined {
	return node.properties.find(
		(property) =>
			property.name !== undefined &&
			ts.isIdentifier(property.name) &&
			property.name.text === name,
	);
}

describe("OpenCode id map guard (82tn.80)", () => {
	it("builds every production OpenCode client with the id map, except the native-only ones", () => {
		const clients: Record<string, string[]> = {};
		for (const file of server)
			visit(file, (node) => {
				if (
					!ts.isNewExpression(node) ||
					node.expression.getText() !== "OpenCodeAPI"
				)
					return;
				const options = node.arguments?.[0];
				const mapped =
					options !== undefined &&
					ts.isObjectLiteralExpression(options) &&
					propertyNamed(options, "sessionIds") !== undefined;
				(clients[file] ??= []).push(mapped ? "mapped" : "native");
			});
		expect(clients).toEqual({
			// clientFor maps; reconcile reads statuses in native ids and emits them
			// through the project stream, which maps them.
			"src/lib/domain/daemon/Layers/opencode-instances-layer.ts": [
				"native",
				"mapped",
			],
			// Text generation runs on a throwaway native session Conduit never stores.
			"src/lib/provider/opencode-text-server.ts": ["native"],
		});
	});

	it("reaches the OpenCode SDK only through OpenCodeAPI", () => {
		const raw = server.filter((file) =>
			readFileSync(file, "utf8").includes("._sdk"),
		);
		expect(raw).toEqual(["src/lib/instance/opencode-api.ts"]);
	});

	it("sends OpenCode only session ids the map resolved", () => {
		const unmapped: string[] = [];
		visit("src/lib/instance/opencode-api.ts", (node) => {
			if (
				!ts.isCallExpression(node) ||
				!node.expression.getText().includes("._sdk.")
			)
				return;
			const see = (argument: ts.Node) => {
				if (
					(ts.isPropertyAssignment(argument) ||
						ts.isShorthandPropertyAssignment(argument)) &&
					argument.name.getText() === "sessionID" &&
					!(
						ts.isPropertyAssignment(argument) &&
						argument.initializer.getText() === "native"
					)
				)
					unmapped.push(argument.getText());
				ts.forEachChild(argument, see);
			};
			for (const argument of node.arguments) see(argument);
		});
		expect(unmapped).toEqual([]);
	});

	it("maps every OpenCode event to Conduit ids before it picks the owning project", () => {
		const called: string[] = [];
		visit(
			"src/lib/domain/daemon/Services/opencode-project-streams.ts",
			(node) => {
				if (ts.isCallExpression(node)) called.push(node.expression.getText());
			},
		);
		const mapped = called.indexOf("toConduitIds");
		expect(mapped).toBeGreaterThanOrEqual(0);
		expect(mapped).toBeLessThan(called.indexOf("ownerOf"));
	});
});

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const sources = readdirSync(join(root, "src/lib"), { recursive: true })
	.map(String)
	.filter((name) => name.endsWith(".ts"))
	.map((name) => join(root, "src/lib", name));

const parse = (file: string) =>
	ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);

const nodes = (node: ts.Node): ts.Node[] => {
	const children: ts.Node[] = [];
	ts.forEachChild(node, (child) => {
		children.push(child);
	});
	return [node, ...children.flatMap(nodes)];
};

const literalType = (node: ts.Node | undefined) =>
	node && ts.isObjectLiteralExpression(node)
		? node.properties.flatMap((property) =>
				ts.isPropertyAssignment(property) &&
				ts.isIdentifier(property.name) &&
				property.name.text === "type" &&
				ts.isStringLiteral(property.initializer)
					? [property.initializer.text]
					: [],
			)[0]
		: undefined;

describe("runner connection writers", () => {
	it("frames commands only inside RunnerSocket.commandEffect", () => {
		const framers = sources.flatMap((file) =>
			readFileSync(file, "utf8").includes('"command"')
				? nodes(parse(file))
						.filter((node) => literalType(node) === "command")
						.map(() => relative(root, file))
				: [],
		);
		expect(framers).toEqual(["src/lib/provider/runner/runner-protocol.ts"]);
	});

	it("pins every connection write that can carry send bytes", () => {
		// A literal non-send command (interrupt, shutdown, answer) carries no send
		// bytes. Every other command argument is a possible send writer.
		const writers = sources.flatMap((file) => {
			if (!readFileSync(file, "utf8").includes(".commandEffect(")) return [];
			const parsed = parse(file);
			return nodes(parsed).flatMap((node) => {
				if (
					!ts.isCallExpression(node) ||
					!ts.isPropertyAccessExpression(node.expression) ||
					node.expression.name.text !== "commandEffect" ||
					node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
				)
					return [];
				const command = node.arguments[1];
				const type = literalType(command);
				return type && type !== "send-turn"
					? []
					: [`${relative(root, file)}: ${command?.getText(parsed)}`];
			});
		});
		expect(writers.sort()).toEqual([
			// Dispatch: the one send writer, behind its WritePermission.
			"src/lib/provider/runner/runner-dispatch.ts: payload",
			// A legacy run holds no transmission, so its retained replay has no permission to take.
			"src/lib/provider/runner/runner-legacy-recovery.ts: command",
			// onHello replays a legacy send on the connection that said hello, before Dispatch serves it.
			"src/lib/provider/runner/runner-starter.ts: command",
			// Upgrade warm: a pre-warm carries no turn bytes.
			"src/lib/provider/runner/runner-starter.ts: driver.warmCommand(sessionId, state, snapshot)",
		]);
	});
});

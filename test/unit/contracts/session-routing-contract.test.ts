import type { SchemaAST } from "effect";
import { expect, it } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";

it("no RPC payload variant carries both sessionId and projectSlug", () => {
	const offenders: string[] = [];
	const inspect = (name: string, ast: SchemaAST.AST): void => {
		if (ast._tag === "Transformation" || ast._tag === "Refinement") {
			inspect(name, ast.from);
		} else if (ast._tag === "Union") {
			for (const member of ast.types) inspect(name, member);
		} else if (ast._tag === "TypeLiteral") {
			const fields = new Set(ast.propertySignatures.map(({ name }) => name));
			if (fields.has("sessionId") && fields.has("projectSlug"))
				offenders.push(name);
		}
	};
	for (const [name, rpc] of WsRpcGroup.requests)
		inspect(name, rpc.payloadSchema.ast);
	expect(offenders).toEqual([]);
});

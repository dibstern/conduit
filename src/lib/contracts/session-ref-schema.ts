import { type Schema, SchemaAST } from "effect";

declare module "effect/Schema" {
	namespace Annotations {
		interface Annotations {
			readonly SessionRef?: { readonly holds: boolean } | undefined;
		}
	}
}

/** Field metadata only: no brand, validation, transformation or wire change. */
export const SessionRef =
	(holds: boolean) =>
	<S extends Schema.Top>(schema: S): S["Rebuild"] =>
		schema.annotateKey({ SessionRef: { holds } });

/** Walk wire fields, retaining distinct paths when schemas share AST nodes. */
export function storedEventFields(ast: SchemaAST.AST) {
	const fields: { path: string; name: string; ast: SchemaAST.AST }[] = [];
	function visit(
		node: SchemaAST.AST,
		path: string,
		ancestors: ReadonlySet<SchemaAST.AST>,
	) {
		if (ancestors.has(node)) return;
		const next = new Set([...ancestors, node]);
		switch (node._tag) {
			case "Objects":
				for (const property of node.propertySignatures) {
					const name = String(property.name);
					const childPath = `${path}.${name}`;
					fields.push({ path: childPath, name, ast: property.type });
					visit(property.type, childPath, next);
				}
				for (const signature of node.indexSignatures)
					visit(signature.type, `${path}.*`, next);
				break;
			case "Arrays":
				for (const element of [...node.elements, ...node.rest])
					visit(element, `${path}[*]`, next);
				break;
			case "Union":
				for (const member of node.types) visit(member, path, next);
				break;
			case "Suspend":
				visit(node.thunk(), path, next);
				break;
		}
	}
	visit(SchemaAST.toEncoded(ast), "$", new Set());
	return fields;
}

export function holdingSessionRefs(
	ast: SchemaAST.AST,
): readonly (readonly [type: string, path: string])[] {
	const encoded = SchemaAST.toEncoded(ast);
	const events = encoded._tag === "Union" ? encoded.types : [encoded];
	return events.flatMap((event) => {
		if (event._tag !== "Objects") return [];
		const type = event.propertySignatures.find(
			({ name }) => name === "type",
		)?.type;
		if (type?._tag !== "Literal" || typeof type.literal !== "string") return [];
		const eventType = type.literal;
		return storedEventFields(event).flatMap(({ path, ast: field }) =>
			field.context?.annotations?.SessionRef?.holds
				? [[eventType, path.replace(/^\$\.data\./, "$.")] as const]
				: [],
		);
	});
}

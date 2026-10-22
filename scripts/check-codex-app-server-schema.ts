import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	CONSUMED_DEFINITIONS,
	type ConsumedDefinition,
} from "../src/lib/provider/codex/app-server/protocol.js";

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: {};

async function checkSchemaDrift(): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "conduit-codex-schema-"));
	try {
		const binary = process.env["CONDUIT_CODEX_BINARY"] || "codex";
		await promisify(execFile)(
			binary,
			[
				"app-server",
				"generate-json-schema",
				"--experimental",
				"--out",
				directory,
			],
			{ maxBuffer: 4 * 1024 * 1024 },
		);
		// initialize belongs to the unversioned protocol. The combined document
		// contains it and v2, and keeps JSON-pointer references resolvable.
		const document = asObject(
			JSON.parse(
				await readFile(
					join(directory, "codex_app_server_protocol.schemas.json"),
					"utf8",
				),
			),
		);
		const rootDefinitions = asObject(document["definitions"]);
		const definitions = {
			...rootDefinitions,
			...asObject(rootDefinitions["v2"]),
		};

		function resolve(value: unknown): JsonObject {
			const schema = asObject(value);
			const reference = schema["$ref"];
			if (typeof reference !== "string" || !reference.startsWith("#/")) {
				return schema;
			}
			let target: unknown = document;
			for (const part of reference.slice(2).split("/")) {
				target =
					asObject(target)[part.replaceAll("~1", "/").replaceAll("~0", "~")];
			}
			if (target === undefined) {
				throw new Error(`Unresolvable upstream schema reference: ${reference}`);
			}
			return asObject(target);
		}

		function branches(schema: JsonObject): JsonObject[] {
			return ["oneOf", "anyOf", "allOf"].flatMap((key) => {
				const values = schema[key];
				return Array.isArray(values) ? values.map(resolve) : [];
			});
		}

		function fields(value: unknown, seen = new Set<unknown>()): Set<string> {
			if (seen.has(value)) return new Set();
			seen.add(value);
			const schema = resolve(value);
			return new Set([
				...Object.keys(asObject(schema["properties"])),
				...branches(schema).flatMap((branch) => [...fields(branch, seen)]),
			]);
		}

		function literals(
			value: unknown,
			discriminator?: string,
			seen = new Set<unknown>(),
		): Set<string> {
			if (seen.has(value)) return new Set();
			seen.add(value);
			const schema = resolve(value);
			const enumeration = schema["enum"];
			const own = discriminator
				? [
						...literals(
							asObject(schema["properties"])[discriminator],
							undefined,
							seen,
						),
					]
				: Array.isArray(enumeration)
					? enumeration.filter(
							(item): item is string => typeof item === "string",
						)
					: [];
			return new Set([
				...own,
				...branches(schema).flatMap((branch) => [
					...literals(branch, discriminator, seen),
				]),
			]);
		}

		const failures: string[] = [];
		for (const [name, consumed] of Object.entries<ConsumedDefinition>(
			CONSUMED_DEFINITIONS,
		)) {
			const upstream = definitions[name];
			if (upstream === undefined) {
				failures.push(`${name}: upstream definition is missing`);
				continue;
			}
			for (const narrow of consumed.schemas ?? []) {
				let candidates = [resolve(upstream)];
				const discriminator = consumed.discriminator;
				const tag = discriminator
					? narrow.fields[discriminator]?.ast
					: undefined;
				if (tag?._tag === "Literal" && typeof tag.literal === "string") {
					const literal = tag.literal;
					const tagged = branches(resolve(upstream)).filter((branch) =>
						literals(branch, discriminator).has(literal),
					);
					candidates = tagged;
					if (candidates.length === 0) {
						failures.push(
							`${name}: upstream variant ${tag.literal} is missing`,
						);
						continue;
					}
				}
				const available = new Set(
					candidates.flatMap((candidate) => [...fields(candidate)]),
				);
				for (const field of Object.keys(narrow.fields)) {
					if (!available.has(field)) {
						failures.push(`${name}: consumed field ${field} is missing`);
					}
				}
			}
			if (consumed.literals) {
				const available = literals(upstream, consumed.discriminator);
				if (available.size === 0 && resolve(upstream)["type"] === "string") {
					console.info(
						`${name}: upstream is an open string; known literals remain valid`,
					);
					continue;
				}
				for (const literal of consumed.literals) {
					if (!available.has(literal)) {
						failures.push(
							`${name}: known literal ${JSON.stringify(literal)} is missing`,
						);
					}
				}
				const additional = [...available].filter(
					(literal) => !consumed.literals?.includes(literal),
				);
				if (additional.length > 0) {
					console.info(
						`${name}: upstream literals not yet consumed: ${additional.join(", ")}`,
					);
				}
			}
		}
		if (failures.length > 0) {
			throw new Error(`Codex app-server schema drift:\n${failures.join("\n")}`);
		}
		console.info(
			`Codex app-server schema drift check passed (${Object.keys(CONSUMED_DEFINITIONS).length} definitions)`,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

await checkSchemaDrift().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

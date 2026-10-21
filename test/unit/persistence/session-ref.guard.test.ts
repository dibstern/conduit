import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Schema, SchemaAST } from "effect";
import { SqlClient } from "effect/sql";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
	holdingSessionRefs,
	SessionRef,
	sessionCreatedLineage,
	storedEventFields,
} from "../../../src/lib/contracts/session-ref.js";
import {
	CanonicalEvents,
	STORED_EVENT_HOLDING_FIELDS,
	StoredEventSchema,
} from "../../../src/lib/contracts/stored-event.js";
import { EVENT_RETENTION_HOLD_SQL } from "../../../src/lib/domain/persistence/Services/event-retention.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";

// Failure modes: an unclassified reference, a new hold absent from SQL or a
// writer, a missing/unusable index, and an unreviewed creation writer. Mutations
// below exercise these same checks without editing production files or stores.
type Hold = readonly [type: string, path: string];
interface Source {
	path: string;
	text: string;
}

function stringTyped(ast: SchemaAST.AST): boolean {
	switch (ast._tag) {
		case "String":
		case "TemplateLiteral":
			return true;
		case "Enum":
			return ast.enums.some(([, value]) => typeof value === "string");
		case "Literal":
			return typeof ast.literal === "string";
		case "Union":
			return ast.types.some(stringTyped);
		case "Arrays":
			return [...ast.elements, ...ast.rest].some(stringTyped);
		case "Suspend":
			return stringTyped(ast.thunk());
		default:
			return false;
	}
}

function annotationFailures(ast: SchemaAST.AST) {
	return storedEventFields(ast).flatMap(({ path, name, ast: field }) => {
		const sessionName =
			/^(?:sessionIds?|.*SessionIds?|parentId|forkedFrom)$/.test(name);
		const sessionString = /session/i.test(name) && stringTyped(field);
		return (sessionName || sessionString) &&
			!field.context?.annotations?.SessionRef
			? [`${path}: missing SessionRef`]
			: [];
	});
}

function lineageLookups(sql: string) {
	return [
		...sql.matchAll(
			/SELECT\s+session_id,\s*sequence\s+FROM\s+events\b[\s\S]*?session_id\s*<>\s*\?/gi,
		),
	].map(([query]) => query);
}

function coversType(sql: string, type: string) {
	const predicate = sql.match(/\btype\s*(?:=\s*('[^']+')|IN\s*\(([^)]+)\))/i);
	return (predicate?.[1] ?? predicate?.[2] ?? "")
		.split(",")
		.some((value) => value.trim() === `'${type}'`);
}

function extracts(sql: string, path: string) {
	return [...sql.matchAll(/json_extract\(\s*data\s*,\s*'([^']+)'\s*\)/gi)].some(
		(match) => match[1] === path,
	);
}

function lookupFailures(holds: readonly Hold[], sql: string) {
	return holds.flatMap(([type, path]) =>
		lineageLookups(sql).some(
			(query) => coversType(query, type) && extracts(query, path),
		)
			? []
			: [`${type} ${path}: missing drain lookup`],
	);
}

const indexChecks = (holds: readonly Hold[], lookupSql: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const indexes = yield* sql<{ name: string; sql: string }>`
			SELECT name, sql FROM sqlite_master
			WHERE type = 'index' AND tbl_name = 'events' AND sql IS NOT NULL`;
		const missing: string[] = [];
		const unused: string[] = [];
		for (const [type, path] of holds) {
			const matching = indexes.filter((index) => {
				const [expression = "", predicate = ""] = index.sql.split(/\bWHERE\b/i);
				return extracts(expression, path) && coversType(predicate, type);
			});
			if (matching.length === 0)
				missing.push(`${type} ${path}: missing partial expression index`);
			const query = lineageLookups(lookupSql).find(
				(candidate) => coversType(candidate, type) && extracts(candidate, path),
			);
			if (!query) {
				unused.push(`${type} ${path}: cannot explain missing lookup`);
				continue;
			}
			const plan = yield* sql.unsafe<{ detail: string }>(
				`EXPLAIN QUERY PLAN ${query}`,
				["project", "source", "source"],
			);
			const details = plan.map(({ detail }) => detail).join("\n");
			if (
				!matching.some(({ name }) => details.includes(`USING INDEX ${name} `))
			)
				unused.push(`${type} ${path}: lineage index unused: ${details}`);
		}
		return { missing, unused };
	});

function sourceFiles(dir: string): Source[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.(?:[cm]?[jt]sx?|svelte)$/.test(entry.name)
			? [
					{
						path: relative(process.cwd(), path),
						text: readFileSync(path, "utf8"),
					},
				]
			: [];
	});
}

function nodes(source: Source) {
	const result: ts.Node[] = [];
	const visit = (node: ts.Node) => {
		result.push(node);
		ts.forEachChild(node, visit);
	};
	visit(
		ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true),
	);
	return result;
}

// Compare the closed writer's payload shape without depending on whitespace.
function tokens(text: string) {
	const result: string[] = [];
	const file = ts.createSourceFile(
		"guard.ts",
		text,
		ts.ScriptTarget.Latest,
		true,
	);
	const visit = (node: ts.Node) => {
		const children = node.getChildren(file);
		if (children.length === 0 && node.getText(file))
			result.push(node.getText(file));
		for (const child of children) visit(child);
	};
	visit(file);
	return result.join(" ");
}

function appendCalls(sourceNodes: readonly ts.Node[]) {
	return sourceNodes.filter(
		(node) =>
			ts.isCallExpression(node) &&
			((ts.isPropertyAccessExpression(node.expression) &&
				/^(?:append|appendBatch)$/.test(node.expression.name.text) &&
				// The translator's accumulator appends to an array, not the store.
				node.expression.expression.getText() !== "state.emitted") ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "appendEvents")),
	);
}

const relay = "src/lib/domain/relay/Services/";
const claudePath = "src/lib/persistence/effect/claude-event-persist-effect.ts";
const writers = [
	`${relay}session-command.ts`,
	`${relay}session-manager-service.ts`,
	`${relay}provider-runtime-ingestion-service.ts`,
	claudePath,
];

function writerFailures(sources: Source[]) {
	const failures: string[] = [];
	for (const source of sources) {
		const allowed = writers.includes(source.path);
		if (!allowed && !source.text.includes("session.created")) continue;
		const sourceNodes = nodes(source);
		const creates = sourceNodes.some(
			(node) => ts.isStringLiteralLike(node) && node.text === "session.created",
		);
		if (!allowed) {
			if (creates && appendCalls(sourceNodes).length > 0)
				failures.push(`${source.path}: unreviewed session.created writer`);
			continue;
		}
		const calls = sourceNodes.filter(ts.isCallExpression);
		const callsNamed = (name: string) =>
			calls.some(
				(call) =>
					ts.isIdentifier(call.expression) && call.expression.text === name,
			);
		const closedPayload = source.path === `${relay}session-manager-service.ts`;
		if (
			!callsNamed("isSessionDeleted") &&
			(closedPayload || !callsNamed("requireUndeletedSession"))
		)
			failures.push(`${source.path}: missing death check`);
		if (!closedPayload) {
			if (!callsNamed("sessionCreatedLineage"))
				failures.push(`${source.path}: missing sessionCreatedLineage call`);
			continue;
		}
		// OpenCode constructs this closed payload from parentID and never emits
		// forkedFrom. A new holding field here needs its own reviewed death check.
		for (const call of calls) {
			if (
				!ts.isIdentifier(call.expression) ||
				call.expression.text !== "canonicalEvent" ||
				!call.arguments[0] ||
				!ts.isStringLiteralLike(call.arguments[0]) ||
				call.arguments[0].text !== "session.created"
			)
				continue;
			const payload = call.arguments[2];
			const expectedPayload = `{
				sessionId: session.id,
				title: normalizedTitle,
				provider: providerInstanceId,
				providerSessionId: session.id,
				...(session.parentID === undefined ? {} : { parentId: session.parentID }),
			}`;
			if (!payload || tokens(payload.getText()) !== tokens(expectedPayload))
				failures.push(
					`${source.path}: unreviewed creation payload; check its holding fields`,
				);
		}
	}
	for (const path of writers)
		if (!sources.some((source) => source.path === path))
			failures.push(`${path}: reviewed writer disappeared`);
	return failures;
}

function migrated<A, E>(check: Effect.Effect<A, E, SqlClient.SqlClient>) {
	return Effect.runPromise(
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			return yield* check;
		}).pipe(
			Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
			Effect.scoped,
		),
	);
}

describe("SessionRef contract", () => {
	const sources = sourceFiles(join(process.cwd(), "src"));
	const reviewedSources = sources.filter(({ path }) => writers.includes(path));
	it("classifies every stored reference and covers every hold with drain SQL", () => {
		expect(
			annotationFailures(SchemaAST.toEncoded(StoredEventSchema.ast)),
		).toEqual([]);
		expect(STORED_EVENT_HOLDING_FIELDS.length).toBeGreaterThan(0);
		expect(
			lookupFailures(STORED_EVENT_HOLDING_FIELDS, EVENT_RETENTION_HOLD_SQL),
		).toEqual([]);
	});

	it("detects unannotated schema additions, including nested optional references", () => {
		const schema = CanonicalEvents["session.created"].payload.pipe(
			Schema.fieldsAssign({
				extraSessionId: Schema.String,
				sessionIds: Schema.Array(Schema.String),
				sourceSession: Schema.Literal("source"),
				templateSession: Schema.TemplateLiteral(["session-", Schema.String]),
				enumSession: Schema.Enum({ source: "session-source" }),
				nested: Schema.optionalKey(
					Schema.Array(Schema.Struct({ sourceSession: Schema.String })),
				),
			}),
		);
		expect(annotationFailures(schema.ast)).toEqual([
			"$.extraSessionId: missing SessionRef",
			"$.sessionIds: missing SessionRef",
			"$.sourceSession: missing SessionRef",
			"$.templateSession: missing SessionRef",
			"$.enumSession: missing SessionRef",
			"$.nested[*].sourceSession: missing SessionRef",
		]);
	});

	it("detects a new annotated hold missing from drain", () => {
		const variant = Schema.Struct({
			type: Schema.Literal("session.created"),
			data: CanonicalEvents["session.created"].payload.pipe(
				Schema.fieldsAssign({
					sourceSessionId: Schema.String.pipe(SessionRef(true)),
				}),
			),
		});
		const holds = holdingSessionRefs(variant.ast);
		expect(lookupFailures(holds, EVENT_RETENTION_HOLD_SQL)).toEqual([
			"session.created $.sourceSessionId: missing drain lookup",
		]);
	});

	it("uses migrated partial expression indexes for every lineage lookup", async () => {
		expect(
			await migrated(
				indexChecks(STORED_EVENT_HOLDING_FIELDS, EVENT_RETENTION_HOLD_SQL),
			),
		).toEqual({ missing: [], unused: [] });
	});

	it("detects both missing indexes and fallback query plans after an index is dropped", async () => {
		const result = await migrated(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql.unsafe("DROP INDEX idx_events_lineage_parent");
				return yield* indexChecks(
					STORED_EVENT_HOLDING_FIELDS,
					EVENT_RETENTION_HOLD_SQL,
				);
			}),
		);
		expect(result.missing).toEqual([
			"session.created $.parentId: missing partial expression index",
			"session.forked $.parentId: missing partial expression index",
		]);
		expect(result.unused).toHaveLength(2);
		expect(
			result.unused.every((failure) =>
				failure.includes("lineage index unused"),
			),
		).toBe(true);
	});

	it("serves isSessionDeleted's marker lookup with idx_events_session_type", async () => {
		const source = {
			path: "src/lib/persistence/effect/session-seeder-effect.ts",
			text: readFileSync(
				"src/lib/persistence/effect/session-seeder-effect.ts",
				"utf8",
			),
		};
		const template = nodes(source).find(
			(node) =>
				ts.isTemplateExpression(node) &&
				node.head.text.startsWith("SELECT CASE"),
		);
		if (!template || !ts.isTemplateExpression(template))
			throw new Error("Missing isSessionDeleted lookup");
		const query =
			template.head.text +
			template.templateSpans.map((span) => `?${span.literal.text}`).join("");
		const plan = await migrated(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql.unsafe<{ detail: string }>(
					`EXPLAIN QUERY PLAN ${query}`,
					template.templateSpans.map(() => "session"),
				);
			}),
		);
		expect(plan.map(({ detail }) => detail).join("\n")).toContain(
			"SEARCH events USING INDEX idx_events_session_type (session_id=? AND type=?)",
		);
	});

	it("uses the accessor and a death check at every creation writer", () => {
		expect(writerFailures(sources)).toEqual([]);
	});

	it.each([
		'"session.created"',
		"`session.created`",
	])("rejects an unlisted writer using %s", (literal) => {
		expect(
			writerFailures([
				...reviewedSources,
				{
					path: "src/new-writer.ts",
					text: `store.append(canonicalEvent(${literal}, id, data));`,
				},
			]),
		).toEqual(["src/new-writer.ts: unreviewed session.created writer"]);
	});

	it.each(
		writers.filter((path) => path !== `${relay}session-manager-service.ts`),
	)("rejects a removed sessionCreatedLineage call in %s", (path) => {
		const mutated = reviewedSources.map((source) =>
			source.path === path
				? {
						...source,
						text: source.text.replaceAll(
							"sessionCreatedLineage",
							"uncheckedRefs",
						),
					}
				: source,
		);
		expect(writerFailures(mutated)).toEqual([
			`${path}: missing sessionCreatedLineage call`,
		]);
	});

	it.each(writers)("rejects removed death checks in %s", (path) => {
		const mutated = reviewedSources.map((source) =>
			source.path === path
				? {
						...source,
						text: source.text
							.replaceAll("isSessionDeleted", "uncheckedDeath")
							.replaceAll("requireUndeletedSession", "uncheckedSession"),
					}
				: source,
		);
		expect(writerFailures(mutated)).toEqual([`${path}: missing death check`]);
	});

	it("accepts local renames, formatting and unrelated append sites", () => {
		const changed = reviewedSources.map((source) =>
			source.path === `${relay}session-manager-service.ts`
				? source
				: {
						...source,
						text: `${source.text
							.replaceAll("requireLiveCreationRefs", "checkCreation")
							.replaceAll(
								"sessionCreatedLineage(",
								"sessionCreatedLineage /* refs */ (\n",
							)}\nstore.append(unrelatedEvent);`,
					},
		);
		expect(writerFailures(changed)).toEqual([]);
	});

	it("reads new holding paths from a schema variant in schema order", () => {
		const variant = Schema.Struct({
			type: Schema.Literal("session.created"),
			data: CanonicalEvents["session.created"].payload.pipe(
				Schema.fieldsAssign({
					sourceSessionId: Schema.String.pipe(SessionRef(true)),
					lineage: Schema.Struct({
						ancestorSessionId: Schema.String.pipe(SessionRef(true)),
					}),
				}),
			),
		});
		const paths = holdingSessionRefs(variant.ast)
			.filter(([type]) => type === "session.created")
			.map(([, path]) => path.slice(2).split("."));
		const data = {
			sessionId: "own",
			title: "Title",
			provider: "claude",
			parentId: "parent",
			forkedFrom: "source",
			sourceSessionId: "extra",
			lineage: { ancestorSessionId: "ancestor" },
		};
		expect(sessionCreatedLineage(data, paths)).toEqual([
			"parent",
			"source",
			"extra",
			"ancestor",
		]);
		expect(sessionCreatedLineage(data)).toEqual(["parent", "source"]);
		expect(
			sessionCreatedLineage({
				sessionId: "own",
				title: "Title",
				provider: "claude",
				forkedFrom: "own",
			}),
		).toEqual(["own"]);
	});

	it("rejects an unchecked holding field emitted by the closed-payload writer", () => {
		const path = `${relay}session-manager-service.ts`;
		const mutated = reviewedSources.map((source) =>
			source.path === path
				? {
						...source,
						text: source.text
							.replace('"session.created",\n', "'session.created',\n")
							.replace(
								"title: normalizedTitle,",
								'"forkedFrom": sourceId, title: normalizedTitle,',
							),
					}
				: source,
		);
		expect(
			writerFailures(mutated).some((failure) =>
				failure.includes("unreviewed creation payload"),
			),
		).toBe(true);
	});
});

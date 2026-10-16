import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Data, Effect } from "effect";
import { effectMigrationEntries } from "../effect/migrations.js";
import { createAllEffectProjectors } from "../effect/projectors-effect.js";
import { daemonStorePath } from "../project-storage.js";

export interface ProjectStoreSource {
	readonly projectId: string;
	readonly sourcePath: string;
}

export class DaemonStoreImportError extends Data.TaggedError(
	"DaemonStoreImportError",
)<{
	readonly projectId: string;
	readonly kind:
		| "collision"
		| "unsupported-source"
		| "unprojected-tail"
		| "source-changed"
		| "io";
	readonly message: string;
	readonly table?: string;
	readonly cause?: unknown;
}> {}

export interface ProjectStoreImportResult {
	readonly projectId: string;
	readonly outcome:
		| "seeded"
		| "imported"
		| "skipped"
		| "source-changed"
		| "failed";
	readonly error?: DaemonStoreImportError;
}

const copiedTables = [
	"events",
	"sessions",
	"turns",
	"messages",
	"message_parts",
	"session_providers",
	"pending_approvals",
	"pending_inputs",
	"session_goal_checks",
	"message_tombstones",
	"message_part_tombstones",
	"session_sidebar",
	"command_receipts",
	"provider_command_sessions",
	"provider_command_turns",
	"provider_command_interactions",
	"provider_command_tombstones",
	"provider_command_outbox",
	"provider_command_meta",
	"provider_state",
	"tool_content",
	"sent_alerts",
	"projection_failures",
	"session_git_published",
	"session_pick_backfill",
] as const;
const singletonTables = [
	"projector_cursors",
	"read_model_counter",
	"session_sidebar_horizon",
	"session_pick_backfill_state",
	"store_identity",
	"effect_sql_migrations",
	"daemon_store_imports",
	"sqlite_sequence",
];
const runnerTables: Readonly<Record<string, string>> = {
	claude_runner_cursors: `CREATE TABLE claude_runner_cursors (
		runner_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
		result_json TEXT NOT NULL DEFAULT '{}', attachment_id TEXT NOT NULL DEFAULT '')`,
	claude_runner_permission_replies: `CREATE TABLE claude_runner_permission_replies (
		session_id TEXT NOT NULL, request_id TEXT NOT NULL, response_json TEXT NOT NULL,
		PRIMARY KEY (session_id, request_id))`,
};
const legacySequenceColumns: Readonly<Record<string, readonly string[]>> = {
	provider_command_sessions: ["last_sequence"],
	provider_command_turns: ["side_effect_sequence", "result_sequence"],
	provider_command_interactions: ["request_sequence", "result_sequence"],
	provider_command_outbox: ["result_sequence"],
};
interface Column {
	name: string;
	type: string;
	pk: number;
	hidden: number;
}
interface Offsets {
	event: number;
	outbox: number;
	version: number;
	rowid: Record<string, number>;
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
// SQLite's untyped result is confined to this SQL boundary.
const rows = <T extends object>(
	db: DatabaseSync,
	sql: string,
	...params: SQLInputValue[]
) => db.prepare(sql).all(...params) as T[];
const number = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]) =>
	rows<{ value: number }>(db, sql, ...params)[0]?.value ?? 0;
const columns = (db: DatabaseSync, schema: string, table: string) =>
	rows<Column>(db, `PRAGMA ${schema}.table_xinfo(${quote(table)})`);
const tables = (db: DatabaseSync, schema: string) =>
	rows<{ name: string }>(
		db,
		`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' ORDER BY name`,
	).map(({ name }) => name);

function reject(
	project: ProjectStoreSource,
	kind: DaemonStoreImportError["kind"],
	message: string,
	table?: string,
): never {
	throw new DaemonStoreImportError({
		projectId: project.projectId,
		kind,
		message,
		...(table ? { table } : {}),
	});
}

function fingerprint(filename: string, project: ProjectStoreSource): string {
	return JSON.stringify(
		["", "-wal"].map((suffix) => {
			const path = `${filename}${suffix}`;
			if (!existsSync(path)) return null;
			const before = statSync(path);
			const hash = createHash("sha256");
			const fd = openSync(path, "r");
			try {
				const buffer = Buffer.allocUnsafe(1024 * 1024);
				let length: number;
				while ((length = readSync(fd, buffer)) > 0)
					hash.update(buffer.subarray(0, length));
			} finally {
				closeSync(fd);
			}
			const after = statSync(path);
			if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
				reject(
					project,
					"source-changed",
					"Source changed while fingerprinting",
				);
			return {
				size: after.size,
				mtime: after.mtimeMs,
				sha256: hash.digest("hex"),
			};
		}),
	);
}

function sourceUri(filename: string): string {
	const uri = pathToFileURL(resolve(filename));
	uri.searchParams.set("mode", "ro");
	// SQLite otherwise creates an empty WAL for a checkpointed WAL-mode source.
	// Offline sources without a WAL can be read immutably; existing WALs must
	// still be read through ordinary read-only locking to include their frames.
	if (!existsSync(`${filename}-wal`)) uri.searchParams.set("immutable", "1");
	return uri.href;
}

function verifyStore(
	db: DatabaseSync,
	schema: string,
	project: ProjectStoreSource,
): string[] {
	const names = tables(db, schema);
	for (const name of [...copiedTables, ...singletonTables]) {
		if (!names.includes(name))
			reject(project, "unsupported-source", `Missing table ${name}`, name);
	}
	const actual = rows<{ migration_id: number; name: string }>(
		db,
		`SELECT migration_id, name FROM ${schema}.effect_sql_migrations ORDER BY migration_id`,
	);
	const expected = Object.keys(effectMigrationEntries)
		.map((key) => ({
			migration_id: Number.parseInt(key, 10),
			name: key.slice(key.indexOf("_") + 1),
		}))
		.sort((a, b) => a.migration_id - b.migration_id);
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		reject(
			project,
			"unsupported-source",
			`${schema} migration ledger is not current`,
		);
	for (const name of names) {
		if (
			![
				...copiedTables,
				...singletonTables,
				...Object.keys(runnerTables),
				"_migrations",
				"sqlite_stat1",
				"sqlite_stat4",
			].includes(name)
		)
			reject(
				project,
				"unsupported-source",
				`Unknown persisted table ${name}`,
				name,
			);
	}
	const max = number(
		db,
		`SELECT COALESCE(MAX(sequence), 0) AS value FROM ${schema}.events`,
	);
	const cursors = rows<{ projector_name: string; last_applied_seq: number }>(
		db,
		`SELECT projector_name, last_applied_seq FROM ${schema}.projector_cursors`,
	);
	// Match recovery: only enrolled named projectors inherit a batch frontier.
	for (const { name } of createAllEffectProjectors()) {
		const named = cursors.find((cursor) => cursor.projector_name === name);
		const frontier = named
			? Math.max(
					named.last_applied_seq,
					...cursors
						.filter(
							(cursor) =>
								cursor.projector_name.startsWith("@batch:") &&
								cursor.projector_name
									.slice(7)
									.split(",")
									.includes(encodeURIComponent(name)),
						)
						.map((cursor) => cursor.last_applied_seq),
				)
			: 0;
		if (frontier < max)
			reject(
				project,
				"unprojected-tail",
				`${schema} projector ${name} is behind its event log`,
				"projector_cursors",
			);
	}
	return names;
}

function verifySource(
	db: DatabaseSync,
	schema: string,
	project: ProjectStoreSource,
	translating: boolean,
): string[] {
	const names = verifyStore(db, schema, project);
	if (number(db, `SELECT 1 AS value FROM ${schema}.events LIMIT 1`) === 0)
		reject(project, "unsupported-source", "Source has no events");
	if (
		number(
			db,
			`SELECT COUNT(*) AS value FROM ${schema}.daemon_store_imports`,
		) !== 0
	)
		reject(
			project,
			"unsupported-source",
			"A project source already contains daemon imports",
			"daemon_store_imports",
		);
	for (const table of copiedTables) {
		const owner = columns(db, schema, table).find(
			({ name }) => name === "project_id" || name === "project_key",
		);
		if (
			owner &&
			number(
				db,
				`SELECT COUNT(*) AS value FROM ${schema}.${quote(table)} WHERE ${quote(owner.name)} IS NOT NULL AND ${quote(owner.name)} <> ?`,
				project.projectId,
			)
		)
			reject(
				project,
				"unsupported-source",
				`Rows in ${table} belong to a different project`,
				table,
			);
	}
	if (translating)
		for (const [table, fields] of Object.entries(legacySequenceColumns)) {
			if (
				number(
					db,
					`SELECT COUNT(*) AS value FROM ${schema}.${table} WHERE ${fields.map((field) => `COALESCE(${field}, 0) <> 0`).join(" OR ")}`,
				)
			)
				reject(
					project,
					"unsupported-source",
					`Populated legacy sequence fields in ${table} have no established number domain`,
					table,
				);
		}
	return names;
}

function verifySourcePath(
	configDir: string,
	project: ProjectStoreSource,
): string {
	const filename = daemonStorePath(configDir);
	const destination = existsSync(filename) ? statSync(filename) : undefined;
	const source = statSync(project.sourcePath);
	if (
		!project.projectId.trim() ||
		resolve(filename) === resolve(project.sourcePath) ||
		(destination &&
			((destination.dev === source.dev && destination.ino === source.ino) ||
				realpathSync(filename) === project.sourcePath))
	)
		reject(
			project,
			"unsupported-source",
			"Expected a project id and a separate project store",
		);
	return filename;
}

function markerStatus(
	db: DatabaseSync,
	project: ProjectStoreSource,
): ProjectStoreImportResult | undefined {
	const marker = rows<{ source_path: string; source_fingerprint: string }>(
		db,
		"SELECT source_path, source_fingerprint FROM daemon_store_imports WHERE project_id = ?",
		project.projectId,
	)[0];
	if (!marker) return undefined;
	return {
		projectId: project.projectId,
		outcome:
			marker.source_path === project.sourcePath &&
			marker.source_fingerprint === fingerprint(project.sourcePath, project)
				? "skipped"
				: "source-changed",
	};
}

function writeMarker(
	db: DatabaseSync,
	project: ProjectStoreSource,
	method: "seeded" | "imported",
	sourceFingerprint: string,
	offsets: Offsets,
): void {
	db.prepare(`INSERT INTO daemon_store_imports
		(project_id, method, source_path, source_fingerprint, event_offset, outbox_offset, version_offset, rowid_offsets, completed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		project.projectId,
		method,
		project.sourcePath,
		sourceFingerprint,
		offsets.event,
		offsets.outbox,
		offsets.version,
		JSON.stringify(offsets.rowid),
		Date.now(),
	);
}

function transaction<A>(db: DatabaseSync, body: () => A): A {
	db.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON");
	try {
		const result = body();
		db.exec("COMMIT");
		return result;
	} catch (cause) {
		db.exec("ROLLBACK");
		throw cause;
	}
}

function counts(db: DatabaseSync): string {
	return JSON.stringify(
		tables(db, "main").map((name) => [
			name,
			number(db, `SELECT COUNT(*) AS value FROM ${quote(name)}`),
		]),
	);
}

function seed(
	configDir: string,
	sourceProject: ProjectStoreSource,
): ProjectStoreImportResult {
	const project = {
		...sourceProject,
		sourcePath: realpathSync(sourceProject.sourcePath),
	};
	const filename = verifySourcePath(configDir, project);
	if (existsSync(filename))
		reject(project, "collision", "Daemon store already exists");
	mkdirSync(dirname(filename), { recursive: true });
	const temporary = `${filename}.${randomUUID()}.tmp`;
	try {
		const before = fingerprint(project.sourcePath, project);
		let sourceCounts: string;
		const source = new DatabaseSync(sourceUri(project.sourcePath), {
			readOnly: true,
		});
		try {
			verifySource(source, "main", project, false);
			sourceCounts = counts(source);
			source.prepare("VACUUM INTO ?").run(temporary);
		} finally {
			source.close();
		}
		const copy = new DatabaseSync(temporary);
		try {
			if (
				JSON.stringify(copy.prepare("PRAGMA quick_check").all()) !==
					'[{"quick_check":"ok"}]' ||
				counts(copy) !== sourceCounts
			)
				reject(
					project,
					"unsupported-source",
					"Seed failed quick_check or per-table count comparison",
				);
			if (fingerprint(project.sourcePath, project) !== before)
				reject(project, "source-changed", "Source changed during seed");
			// Only the copy changes journal mode; source main and WAL stay untouched.
			copy.exec("PRAGMA journal_mode = DELETE");
			transaction(copy, () => {
				for (const table of copiedTables) {
					for (const { name } of columns(copy, "main", table)) {
						if (name === "project_id" || name === "project_key")
							copy
								.prepare(
									`UPDATE ${quote(table)} SET ${quote(name)} = ? WHERE ${quote(name)} IS NULL`,
								)
								.run(project.projectId);
					}
				}
				writeMarker(copy, project, "seeded", before, {
					event: 0,
					outbox: 0,
					version: 0,
					rowid: {},
				});
			});
		} finally {
			copy.close();
		}
		const fd = openSync(temporary, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (existsSync(filename))
			reject(project, "collision", "Daemon store appeared during seed");
		renameSync(temporary, filename);
		return { projectId: project.projectId, outcome: "seeded" };
	} finally {
		for (const suffix of ["", "-wal", "-shm", "-journal"])
			if (existsSync(`${temporary}${suffix}`))
				unlinkSync(`${temporary}${suffix}`);
	}
}

function collisions(
	db: DatabaseSync,
	names: readonly string[],
	project: ProjectStoreSource,
): void {
	const all = [
		...copiedTables,
		...Object.keys(runnerTables).filter((name) => names.includes(name)),
	];
	for (const table of all) {
		const key = columns(db, "source", table)
			.filter(({ pk }) => pk > 0)
			.map(({ name }) => name);
		const keys =
			table === "events"
				? [["event_id"], ["session_id", "stream_version"]]
				: table === "projection_failures" || table === "provider_command_outbox"
					? []
					: [key];
		for (const fields of keys) {
			const match = fields
				.map(
					(field) =>
						`d.${quote(field)} = ${field === "project_key" ? "COALESCE(s.project_key, ?)" : `s.${quote(field)}`}`,
				)
				.join(" AND ");
			const params = fields.includes("project_key") ? [project.projectId] : [];
			if (
				rows(
					db,
					`SELECT 1 FROM source.${table} s JOIN main.${table} d ON ${match} LIMIT 1`,
					...params,
				).length
			)
				reject(project, "collision", `Key collision in ${table}`, table);
		}
	}
	// Session identities also survive in command state with project-qualified
	// keys and no FK into sessions. Include every persisted session_id column.
	const sessionIds = (schema: string) =>
		tables(db, schema)
			.filter(
				(table) => all.includes(table) || Object.hasOwn(runnerTables, table),
			)
			.flatMap((table) =>
				columns(db, schema, table)
					.filter(
						({ name }) =>
							name === "session_id" || (table === "sessions" && name === "id"),
					)
					.map(
						({ name }) =>
							`SELECT ${quote(name)} AS id FROM ${schema}.${quote(table)}`,
					),
			)
			.join(" UNION ");
	if (
		rows(
			db,
			`SELECT 1 FROM (${sessionIds("source")}) s JOIN (${sessionIds("main")}) d ON s.id = d.id LIMIT 1`,
		).length
	)
		reject(
			project,
			"collision",
			"Overlapping session identities, including retained command state",
			"sessions",
		);
	const identityGroups = [
		["messages", ["messages:id", "turns:id", "message_tombstones:message_id"]],
		["message_parts", ["message_parts:id", "message_part_tombstones:part_id"]],
		[
			"command_receipts",
			[
				"command_receipts:command_id",
				"provider_command_outbox:command_id",
				"provider_command_turns:command_id",
			],
		],
		["tool_content", ["tool_content:tool_id", "message_parts:call_id"]],
	] as const;
	for (const [table, members] of identityGroups) {
		const select = (schema: string) =>
			members
				.map((member) => {
					const [name, field] = member.split(":");
					return `SELECT ${field} AS id FROM ${schema}.${name}`;
				})
				.join(" UNION ");
		if (
			rows(
				db,
				`SELECT 1 FROM (${select("source")}) s JOIN (${select("main")}) d ON s.id = d.id LIMIT 1`,
			).length
		)
			reject(
				project,
				"collision",
				`Overlapping ${table} identities, including retained history or tombstones`,
				table,
			);
	}
}

// E preserves zero/NULL sentinels and gaps; V includes imported zero versions.
const eventNumber = (expression: string, offset: number) =>
	`CASE WHEN ${expression} > 0 THEN ${expression} + ${offset} ELSE ${expression} END`;
function eventJson(
	expression: string,
	paths: readonly string[],
	offset: number,
): string {
	return paths.reduce(
		(value, path) =>
			`CASE WHEN json_type(${value}, '${path}') = 'integer' THEN json_set(${value}, '${path}', ${eventNumber(`json_extract(${value}, '${path}')`, offset)}) ELSE ${value} END`,
		expression,
	);
}

function copyProject(
	db: DatabaseSync,
	project: ProjectStoreSource,
	names: string[],
	offsets: Offsets,
): void {
	for (const table of [
		...copiedTables,
		...Object.keys(runnerTables).filter((name) => names.includes(name)),
	]) {
		const fields = columns(db, "source", table)
			.filter(({ hidden }) => hidden === 0)
			.map(({ name }) => name);
		const expressions: Record<string, string> = {};
		if (fields.includes("project_id"))
			expressions["project_id"] = "COALESCE(project_id, ?)";
		if (fields.includes("project_key"))
			expressions["project_key"] = "COALESCE(project_key, ?)";
		if (fields.includes("version"))
			expressions["version"] = `version + ${offsets.version}`;
		if (table === "events") {
			expressions["sequence"] = `sequence + ${offsets.event}`;
			expressions["data"] =
				`CASE WHEN type = 'input.sent' THEN ${eventJson("data", ["$.workspaceMoveSequence"], offsets.event)} ELSE data END`;
		}
		if (table === "sessions") {
			expressions["workspace_hint_sequence"] = eventNumber(
				"workspace_hint_sequence",
				offsets.event,
			);
			expressions["claude_worktree_state"] = eventJson(
				"claude_worktree_state",
				["$.pending.sequence"],
				offsets.event,
			);
		}
		if (table === "messages")
			expressions["last_applied_seq"] = eventNumber(
				"last_applied_seq",
				offsets.event,
			);
		if (table === "command_receipts") {
			for (const field of ["accepted_sequence", "side_effect_sequence"])
				expressions[field] = eventNumber(field, offsets.outbox);
			expressions["result_sequence"] = eventNumber(
				"result_sequence",
				offsets.event,
			);
		}
		if (table === "provider_command_outbox") {
			expressions["request_sequence"] = `request_sequence + ${offsets.outbox}`;
			expressions["payload_json"] = eventJson(
				"payload_json",
				["$.nativeThread.firstSequence", "$.nativeThread.deliveredThrough"],
				offsets.event,
			);
		}
		if (table === "provider_command_meta")
			expressions["last_applied_sequence"] = eventNumber(
				"last_applied_sequence",
				offsets.event,
			);
		if (table === "provider_command_tombstones")
			expressions["event_sequence"] = eventNumber(
				"event_sequence",
				offsets.event,
			);
		if (table === "projection_failures") {
			expressions["event_sequence"] = eventNumber(
				"event_sequence",
				offsets.event,
			);
			expressions["id"] = `id + ${offsets.rowid[table] ?? 0}`;
		}
		if (table === "session_sidebar")
			expressions["row"] =
				`CASE WHEN row IS NULL THEN NULL ELSE json_set(row, '$.version', json_extract(row, '$.version') + ${offsets.version}) END`;
		if (table === "provider_state")
			expressions["value"] =
				`CASE WHEN key LIKE 'nativeThread:%' THEN ${eventJson("value", ["$.firstSequence", "$.deliveredThrough"], offsets.event)} ELSE value END`;
		if (table === "turns" || table === "pending_inputs") {
			fields.unshift("rowid");
			expressions["rowid"] =
				`ROW_NUMBER() OVER (ORDER BY rowid) + ${offsets.rowid[table] ?? 0}`;
		}
		db.prepare(
			`INSERT INTO main.${table} (${fields.map(quote).join(", ")}) SELECT ${fields.map((field) => expressions[field] ?? quote(field)).join(", ")} FROM source.${table} ORDER BY rowid`,
		).run(
			...(fields.includes("project_id") || fields.includes("project_key")
				? [project.projectId]
				: []),
		);
	}
	// Native thread receipts inside providerState are JSON strings. Preserve that
	// representation instead of json_set silently changing them into objects.
	const states = rows<{ request_sequence: number; key: string }>(
		db,
		`SELECT o.request_sequence, j.key FROM main.provider_command_outbox o, json_each(o.payload_json, '$.providerState') j WHERE o.project_key = ? AND o.request_sequence > ? AND j.key LIKE 'nativeThread:%'`,
		project.projectId,
		offsets.outbox,
	);
	for (const { request_sequence: request, key } of states) {
		const path = `$.providerState.${JSON.stringify(key)}`;
		const translated = eventJson(
			`json_extract(payload_json, '${path.replaceAll("'", "''")}')`,
			["$.firstSequence", "$.deliveredThrough"],
			offsets.event,
		);
		db.prepare(
			`UPDATE provider_command_outbox SET payload_json = json_set(payload_json, ?, substr(${translated}, 1)) WHERE request_sequence = ?`,
		).run(path, request);
	}
}

function importOne(
	configDir: string,
	sourceProject: ProjectStoreSource,
): ProjectStoreImportResult {
	const project = {
		...sourceProject,
		sourcePath: realpathSync(sourceProject.sourcePath),
	};
	const filename = verifySourcePath(configDir, project);
	if (!existsSync(filename))
		reject(
			project,
			"unsupported-source",
			"Seed the daemon store before importing",
		);
	const db = new DatabaseSync(filename);
	try {
		const marked = markerStatus(db, project);
		if (marked) return marked;
		const before = fingerprint(project.sourcePath, project);
		// Unlike better-sqlite3's default build, node:sqlite enables URI filenames.
		db.prepare("ATTACH DATABASE ? AS source").run(
			sourceUri(project.sourcePath),
		);
		return transaction(db, () => {
			verifyStore(db, "main", project);
			const names = verifySource(db, "source", project, true);
			for (const [table, ddl] of Object.entries(runnerTables)) {
				if (!names.includes(table)) continue;
				if (!tables(db, "main").includes(table)) db.exec(ddl);
			}
			for (const table of [
				...copiedTables,
				...Object.keys(runnerTables).filter((name) => names.includes(name)),
			]) {
				if (
					JSON.stringify(columns(db, "main", table)) !==
					JSON.stringify(columns(db, "source", table))
				)
					reject(
						project,
						"unsupported-source",
						`Incompatible columns in ${table}`,
						table,
					);
			}
			collisions(db, names, project);
			const highWater = (schema: string, table: string, field: string) =>
				number(
					db,
					`SELECT MAX(COALESCE((SELECT MAX(${field}) FROM ${schema}.${table}), 0), COALESCE((SELECT seq FROM ${schema}.sqlite_sequence WHERE name = ?), 0)) AS value`,
					table,
				);
			const versions = (schema: string) =>
				number(
					db,
					`SELECT MAX(value) AS value FROM (
				SELECT value FROM ${schema}.read_model_counter UNION ALL ${["sessions", "messages", "message_parts", "pending_approvals", "pending_inputs", "message_tombstones", "message_part_tombstones", "session_sidebar", "session_sidebar_horizon"].map((table) => `SELECT MAX(version) FROM ${schema}.${table}`).join(" UNION ALL ")})`,
				);
			const outboxMax = (schema: string) =>
				number(
					db,
					`SELECT MAX(value) AS value FROM (
				SELECT MAX(request_sequence) AS value FROM ${schema}.provider_command_outbox
				UNION ALL SELECT MAX(accepted_sequence) FROM ${schema}.command_receipts
				UNION ALL SELECT MAX(side_effect_sequence) FROM ${schema}.command_receipts)`,
				);
			const offsets: Offsets = {
				event: highWater("main", "events", "sequence"),
				outbox: outboxMax("main"),
				version: versions("main") + 1,
				rowid: {
					turns: number(
						db,
						"SELECT COALESCE(MAX(rowid), 0) AS value FROM turns",
					),
					pending_inputs: number(
						db,
						"SELECT COALESCE(MAX(rowid), 0) AS value FROM pending_inputs",
					),
					projection_failures: highWater("main", "projection_failures", "id"),
				},
			};
			const eventHigh =
				offsets.event + highWater("source", "events", "sequence");
			const versionHigh = offsets.version + versions("source");
			if (
				![eventHigh, versionHigh, offsets.outbox + outboxMax("source")].every(
					Number.isSafeInteger,
				)
			)
				reject(
					project,
					"unsupported-source",
					"Translated counters exceed the safe integer range",
				);
			copyProject(db, project, names, offsets);
			for (const table of ["events", "projection_failures"]) {
				const target =
					table === "events"
						? eventHigh
						: (offsets.rowid[table] ?? 0) + highWater("source", table, "id");
				db.prepare(
					"UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?",
				).run(target, table);
				if (
					!number(
						db,
						"SELECT COUNT(*) AS value FROM sqlite_sequence WHERE name = ?",
						table,
					)
				)
					db.prepare(
						"INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)",
					).run(table, target);
			}
			db.prepare("UPDATE read_model_counter SET value = ? WHERE id = 1").run(
				versionHigh,
			);
			db.prepare(
				"UPDATE session_sidebar_horizon SET version = ? WHERE id = 1",
			).run(versionHigh);
			db.exec(
				"UPDATE session_pick_backfill_state SET initialized = MIN(initialized, (SELECT initialized FROM source.session_pick_backfill_state WHERE singleton = 1)) WHERE singleton = 1",
			);
			const frontier =
				offsets.event +
				number(db, "SELECT MAX(sequence) AS value FROM source.events");
			db.prepare(
				"UPDATE projector_cursors SET last_applied_seq = MAX(last_applied_seq, ?)",
			).run(frontier);
			if (db.prepare("PRAGMA main.foreign_key_check").get())
				reject(
					project,
					"unsupported-source",
					"Imported rows fail foreign_key_check",
				);
			if (fingerprint(project.sourcePath, project) !== before)
				reject(project, "source-changed", "Source changed during import");
			writeMarker(db, project, "imported", before, offsets);
			return { projectId: project.projectId, outcome: "imported" };
		});
	} finally {
		db.close();
	}
}

const attempt = (
	project: ProjectStoreSource,
	body: () => ProjectStoreImportResult,
) =>
	Effect.try({
		try: body,
		catch: (cause) =>
			cause instanceof DaemonStoreImportError
				? cause
				: new DaemonStoreImportError({
						projectId: project.projectId,
						kind: "io",
						message: "Project store import failed",
						cause,
					}),
	});

/** Offline only: callers must stop all destination and source writers first. */
export const seedDaemonStore = (
	configDir: string,
	project: ProjectStoreSource,
) => attempt(project, () => seed(configDir, project));
export const importProjectStore = (
	configDir: string,
	project: ProjectStoreSource,
) => attempt(project, () => importOne(configDir, project));

/** Only the supplied registered sources participate; failed projects stay isolated. */
export const importRegisteredProjectStores = (
	configDir: string,
	projects: readonly ProjectStoreSource[],
): Effect.Effect<readonly ProjectStoreImportResult[]> =>
	Effect.gen(function* () {
		const results = new Map<string, ProjectStoreImportResult>();
		if (!existsSync(daemonStorePath(configDir))) {
			const sized = projects
				.map((project) => {
					try {
						return { project, size: statSync(project.sourcePath).size };
					} catch {
						return { project, size: -1 };
					}
				})
				.sort(
					(a, b) =>
						b.size - a.size ||
						a.project.projectId.localeCompare(b.project.projectId),
				);
			for (const { project } of sized) {
				const result = yield* seedDaemonStore(configDir, project).pipe(
					Effect.either,
				);
				if (result._tag === "Right") {
					results.set(project.projectId, result.right);
					break;
				}
				results.set(project.projectId, {
					projectId: project.projectId,
					outcome: "failed",
					error: result.left,
				});
			}
		}
		for (const project of projects) {
			if (results.has(project.projectId)) continue;
			const result = yield* importProjectStore(configDir, project).pipe(
				Effect.either,
			);
			results.set(
				project.projectId,
				result._tag === "Right"
					? result.right
					: {
							projectId: project.projectId,
							outcome: "failed",
							error: result.left,
						},
			);
		}
		return projects.flatMap((project) => {
			const result = results.get(project.projectId);
			return result ? [result] : [];
		});
	});

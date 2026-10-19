import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Data, Effect } from "effect";
import {
	makePersistenceEffectLayer,
	makePersistenceStoreLayer,
	type PersistenceEffectError,
} from "../effect/live.js";
import { effectMigrationEntries } from "../effect/migrations.js";
import { ProjectionRunnerEffectTag } from "../effect/projection-runner-effect.js";
import { createAllEffectProjectors } from "../effect/projectors-effect.js";
import { daemonStorePath } from "../project-storage.js";

export interface ProjectStoreSource {
	readonly projectId: string;
	readonly sourcePath: string;
	/** Retained history follows every registered source and cannot seed. */
	readonly retained?: boolean;
}

export type DaemonStoreImportCheckpoint =
	| "normalised"
	| "seed-marked"
	| "seed-promoted"
	| "import-copied"
	| "import-committed"
	| "backup-sidecars";

export interface DaemonStoreImportOptions {
	readonly now?: () => number;
	readonly checkpoint?: (
		name: DaemonStoreImportCheckpoint,
		projectId: string,
	) => void;
}

export class DaemonStoreImportError extends Data.TaggedError(
	"DaemonStoreImportError",
)<{
	readonly projectId: string;
	readonly kind:
		| "collision"
		| "corrupt"
		| "newer-schema"
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
		| "absent"
		| "seeded"
		| "imported"
		| "skipped"
		| "source-changed"
		| "failed";
	readonly importedEvents?: number;
	readonly sharedSessions?: readonly string[];
	readonly error?: DaemonStoreImportError;
	readonly backup?: string;
	readonly backupError?: DaemonStoreImportError;
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

function fingerprint(
	filename: string,
	project: ProjectStoreSource,
	suffixes: readonly string[] = ["", "-wal"],
): string {
	return JSON.stringify(
		suffixes.map((suffix) => {
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

function sourceUri(filename: string, offline = true): string {
	const uri = pathToFileURL(resolve(filename));
	uri.searchParams.set("mode", "ro");
	// SQLite otherwise creates an empty WAL for a checkpointed WAL-mode source.
	// Offline sources without a WAL can be read immutably; existing WALs must
	// still be read through ordinary read-only locking to include their frames.
	if (offline && !existsSync(`${filename}-wal`))
		uri.searchParams.set("immutable", "1");
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

function readMarker(db: DatabaseSync, projectId: string) {
	return rows<{
		source_path: string;
		source_fingerprint: string;
		completed_at: number;
	}>(
		db,
		"SELECT source_path, source_fingerprint, completed_at FROM daemon_store_imports WHERE project_id = ?",
		projectId,
	)[0];
}

function sourceFingerprintOf(markerFingerprint: string): string {
	return JSON.stringify(
		(JSON.parse(markerFingerprint) as readonly unknown[]).slice(0, 2),
	);
}

function markerStatus(
	db: DatabaseSync,
	project: ProjectStoreSource,
): ProjectStoreImportResult | undefined {
	const marker = readMarker(db, project.projectId);
	if (!marker) return undefined;
	return {
		projectId: project.projectId,
		outcome:
			marker.source_path === project.sourcePath &&
			sourceFingerprintOf(marker.source_fingerprint) ===
				fingerprint(project.sourcePath, project)
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
	completedAt: number,
): void {
	db.prepare(`INSERT INTO daemon_store_imports
		(project_id, method, source_path, source_fingerprint, event_offset, outbox_offset, version_offset, rowid_offsets, completed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		project.projectId,
		method,
		project.sourcePath,
		JSON.stringify([
			...(JSON.parse(sourceFingerprint) as readonly unknown[]),
			...(JSON.parse(
				fingerprint(project.sourcePath, project, ["-shm", "-journal"]),
			) as readonly unknown[]),
		]),
		offsets.event,
		offsets.outbox,
		offsets.version,
		JSON.stringify(offsets.rowid),
		completedAt,
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
	project: ProjectStoreSource,
	temporary: string,
	before: string,
	options: DaemonStoreImportOptions,
): ProjectStoreImportResult {
	const filename = verifySourcePath(configDir, project);
	if (existsSync(filename))
		reject(project, "collision", "Daemon store already exists");
	const copy = new DatabaseSync(temporary);
	let importedEvents: number;
	try {
		verifySource(copy, "main", project, false);
		importedEvents = number(copy, "SELECT COUNT(*) AS value FROM events");
		copy.exec("PRAGMA journal_mode = DELETE");
		transaction(copy, () => {
			// Preserve .4's NULL stamp for every copied ownership column.
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
			writeMarker(
				copy,
				project,
				"seeded",
				before,
				{
					event: 0,
					outbox: 0,
					version: 0,
					rowid: {},
				},
				(options.now ?? Date.now)(),
			);
		});
	} finally {
		copy.close();
	}
	options.checkpoint?.("seed-marked", project.projectId);
	const fd = openSync(temporary, "r+");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	if (existsSync(filename))
		reject(project, "collision", "Daemon store appeared during seed");
	renameSync(temporary, filename);
	options.checkpoint?.("seed-promoted", project.projectId);
	return {
		projectId: project.projectId,
		outcome: "seeded",
		importedEvents,
		sharedSessions: [],
	};
}

// Session identities can outlive sessions in events, tombstones and command state.
function sessionIds(db: DatabaseSync, schema: string): string {
	return tables(db, schema)
		.filter(
			(table) =>
				copiedTables.some((name) => name === table) ||
				Object.hasOwn(runnerTables, table),
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
}

function excludeSharedSessions(
	copyPath: string,
	destination: string,
): readonly string[] {
	const db = new DatabaseSync(copyPath);
	try {
		db.exec("PRAGMA foreign_keys = OFF");
		db.prepare("ATTACH DATABASE ? AS daemon").run(
			sourceUri(destination, false),
		);
		const shared = rows<{ id: string }>(
			db,
			`SELECT s.id FROM (${sessionIds(db, "main")}) s JOIN (${sessionIds(db, "daemon")}) d ON s.id = d.id ORDER BY s.id`,
		).map(({ id }) => id);
		if (shared.length === 0) return shared;
		db.exec("CREATE TEMP TABLE shared_sessions (id TEXT PRIMARY KEY)");
		const insert = db.prepare("INSERT INTO shared_sessions VALUES (?)");
		for (const id of shared) insert.run(id);
		// Capture references before deleting their owners. Parent/fork links are
		// deliberately absent: a non-shared child must resolve to the first owner.
		db.exec(`
			CREATE TEMP TABLE shared_events AS SELECT sequence AS id FROM events WHERE session_id IN shared_sessions;
			CREATE TEMP TABLE shared_turns AS SELECT id FROM turns WHERE session_id IN shared_sessions;
			CREATE TEMP TABLE shared_messages AS SELECT id FROM messages WHERE session_id IN shared_sessions OR turn_id IN shared_turns;
			CREATE TEMP TABLE shared_parts AS SELECT id FROM message_parts WHERE message_id IN shared_messages;
			CREATE TEMP TABLE shared_calls AS SELECT call_id AS id FROM message_parts WHERE message_id IN shared_messages;
			CREATE TEMP TABLE shared_commands AS
				SELECT command_id AS id FROM command_receipts WHERE session_id IN shared_sessions
				UNION SELECT command_id FROM provider_command_outbox WHERE session_id IN shared_sessions
				UNION SELECT command_id FROM provider_command_turns WHERE session_id IN shared_sessions;
		`);
		const references: Readonly<Record<string, string>> = {
			session_id: "shared_sessions",
			message_id: "shared_messages",
			turn_id: "shared_turns",
			command_id: "shared_commands",
			causation_command_id: "shared_commands",
			event_sequence: "shared_events",
			part_id: "shared_parts",
			tool_id: "shared_calls",
		};
		for (const table of tables(db, "main")) {
			const conditions = columns(db, "main", table).flatMap(({ name }) => {
				const ids =
					table === "sessions" && name === "id"
						? "shared_sessions"
						: references[name];
				return ids ? [`${quote(name)} IN (SELECT id FROM ${ids})`] : [];
			});
			if (conditions.length > 0)
				db.exec(`DELETE FROM ${quote(table)} WHERE ${conditions.join(" OR ")}`);
		}
		// A literal copy can also repeat store-independent cache/runner rows.
		// Only exact duplicates from an entirely shared history are explained by
		// that copy; conflicting values still reach collisions().
		if (
			!rows(
				db,
				`SELECT 1 FROM (${sessionIds(db, "main")}) WHERE id IS NOT NULL LIMIT 1`,
			).length
		) {
			for (const table of ["session_git_published", "claude_runner_cursors"]) {
				if (
					!tables(db, "main").includes(table) ||
					!tables(db, "daemon").includes(table)
				)
					continue;
				const fields = columns(db, "main", table).filter(
					({ hidden }) => hidden === 0,
				);
				if (
					JSON.stringify(fields) !==
					JSON.stringify(
						columns(db, "daemon", table).filter(({ hidden }) => hidden === 0),
					)
				)
					continue;
				db.exec(
					`DELETE FROM main.${table} AS s WHERE EXISTS (SELECT 1 FROM daemon.${table} d WHERE ${fields.map(({ name }) => `s.${quote(name)} IS d.${quote(name)}`).join(" AND ")})`,
				);
			}
		}
		return shared;
	} finally {
		db.close();
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

	if (
		rows(
			db,
			`SELECT 1 FROM (${sessionIds(db, "source")}) s JOIN (${sessionIds(db, "main")}) d ON s.id = d.id LIMIT 1`,
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
		if (table === "message_parts")
			expressions["result_event_seq"] = eventNumber(
				"result_event_seq",
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
	project: ProjectStoreSource,
	copyPath: string,
	before: string,
	options: DaemonStoreImportOptions,
): ProjectStoreImportResult {
	const filename = verifySourcePath(configDir, project);
	if (!existsSync(filename))
		reject(
			project,
			"unsupported-source",
			"Seed the daemon store before importing",
		);
	const db = new DatabaseSync(filename);
	try {
		const sharedSessions = excludeSharedSessions(copyPath, filename);
		// Unlike better-sqlite3's default build, node:sqlite enables URI filenames.
		db.prepare("ATTACH DATABASE ? AS source").run(sourceUri(copyPath));
		const result = transaction(db, () => {
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
			options.checkpoint?.("import-copied", project.projectId);
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
			writeMarker(
				db,
				project,
				"imported",
				before,
				offsets,
				(options.now ?? Date.now)(),
			);
			return {
				projectId: project.projectId,
				outcome: "imported" as const,
				importedEvents: number(
					db,
					"SELECT COUNT(*) AS value FROM source.events",
				),
				sharedSessions,
			};
		});
		options.checkpoint?.("import-committed", project.projectId);
		return result;
	} finally {
		db.close();
	}
}

function importError(
	project: ProjectStoreSource,
	cause: unknown,
): DaemonStoreImportError {
	if (cause instanceof DaemonStoreImportError) return cause;
	const corrupt = (error: unknown): boolean => {
		if (typeof error !== "object" || error === null) return false;
		if (
			"code" in error &&
			(error.code === "SQLITE_NOTADB" || error.code === "SQLITE_CORRUPT")
		)
			return true;
		if (
			"errcode" in error &&
			typeof error.errcode === "number" &&
			[11, 26].includes(error.errcode & 255)
		)
			return true;
		return "cause" in error && error.cause !== error && corrupt(error.cause);
	};
	return new DaemonStoreImportError({
		projectId: project.projectId,
		kind: corrupt(cause) ? "corrupt" : "io",
		message: "Project store import failed",
		cause,
	});
}
const attempt = <A>(project: ProjectStoreSource, body: () => A) =>
	Effect.try({ try: body, catch: (cause) => importError(project, cause) });

function withNormalisedSource(
	configDir: string,
	project: ProjectStoreSource,
	options: DaemonStoreImportOptions,
	use: (
		copyPath: string,
		sourceFingerprint: string,
	) => ProjectStoreImportResult,
): Effect.Effect<ProjectStoreImportResult, DaemonStoreImportError> {
	return Effect.acquireUseRelease(
		attempt(project, () => {
			const folder = join(configDir, "daemon-store-import");
			mkdirSync(folder, { recursive: true });
			return join(folder, `${randomUUID()}.db`);
		}),
		(copyPath) =>
			Effect.gen(function* () {
				const before = yield* attempt(project, () => {
					const journal = `${project.sourcePath}-journal`;
					if (existsSync(journal) && statSync(journal).size > 0)
						reject(
							project,
							"unsupported-source",
							"Source has a hot rollback journal",
						);
					const before = fingerprint(project.sourcePath, project);
					const source = new DatabaseSync(sourceUri(project.sourcePath), {
						readOnly: true,
					});
					let sourceCounts: string;
					try {
						sourceCounts = counts(source);
						source.prepare("VACUUM INTO ?").run(copyPath);
					} finally {
						source.close();
					}
					const copy = new DatabaseSync(copyPath);
					try {
						if (
							JSON.stringify(copy.prepare("PRAGMA quick_check").all()) !==
								'[{"quick_check":"ok"}]' ||
							counts(copy) !== sourceCounts
						)
							reject(
								project,
								"corrupt",
								"Copy failed quick_check or per-table count comparison",
							);
						if (tables(copy, "main").includes("effect_sql_migrations")) {
							for (const entry of rows<{ migration_id: number; name: string }>(
								copy,
								"SELECT migration_id, name FROM effect_sql_migrations",
							)) {
								if (
									!Object.keys(effectMigrationEntries).some(
										(key) =>
											Number.parseInt(key, 10) === entry.migration_id &&
											key.slice(key.indexOf("_") + 1) === entry.name,
									)
								)
									reject(
										project,
										"newer-schema",
										`Unknown migration ${entry.migration_id}_${entry.name}`,
									);
							}
						}
					} finally {
						copy.close();
					}
					return before;
				});
				yield* Effect.gen(function* () {
					const runner = yield* ProjectionRunnerEffectTag;
					if (!(yield* runner.isRecovered())) yield* runner.recover();
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(copyPath, project.projectId),
					),
					Effect.scoped,
					Effect.mapError((cause) => importError(project, cause)),
				);
				return yield* attempt(project, () => {
					options.checkpoint?.("normalised", project.projectId);
					if (fingerprint(project.sourcePath, project) !== before)
						reject(
							project,
							"source-changed",
							"Source changed during normalisation",
						);
					const copy = new DatabaseSync(copyPath, { readOnly: true });
					try {
						verifyStore(copy, "main", project);
					} finally {
						copy.close();
					}
					return use(copyPath, before);
				});
			}),
		(copyPath) =>
			Effect.sync(() => {
				for (const suffix of ["", "-wal", "-shm", "-journal"])
					if (existsSync(`${copyPath}${suffix}`))
						unlinkSync(`${copyPath}${suffix}`);
			}),
	);
}

/** Offline only: callers must stop all destination and source writers first. */
export const seedDaemonStore = (
	configDir: string,
	source: ProjectStoreSource,
	options: DaemonStoreImportOptions = {},
) =>
	Effect.gen(function* () {
		const project = yield* attempt(source, () =>
			existsSync(source.sourcePath)
				? { ...source, sourcePath: realpathSync(source.sourcePath) }
				: undefined,
		);
		if (!project)
			return { projectId: source.projectId, outcome: "absent" as const };
		yield* attempt(project, () => {
			if (existsSync(verifySourcePath(configDir, project)))
				reject(project, "collision", "Daemon store already exists");
		});
		return yield* withNormalisedSource(
			configDir,
			project,
			options,
			(copy, before) => seed(configDir, project, copy, before, options),
		);
	});
export const importProjectStore = (
	configDir: string,
	source: ProjectStoreSource,
	options: DaemonStoreImportOptions = {},
) =>
	Effect.gen(function* () {
		const project = yield* attempt(source, () =>
			existsSync(source.sourcePath)
				? { ...source, sourcePath: realpathSync(source.sourcePath) }
				: undefined,
		);
		if (!project)
			return { projectId: source.projectId, outcome: "absent" as const };
		const marked = yield* attempt(project, () => {
			const filename = verifySourcePath(configDir, project);
			if (!existsSync(filename))
				reject(
					project,
					"unsupported-source",
					"Seed the daemon store before importing",
				);
			const db = new DatabaseSync(filename);
			try {
				return markerStatus(db, project);
			} finally {
				db.close();
			}
		});
		if (marked) return marked;
		return yield* withNormalisedSource(
			configDir,
			project,
			options,
			(copy, before) => importOne(configDir, project, copy, before, options),
		);
	});

const backupSuffixes = ["-wal", "-shm", "-journal", ""] as const;

function sameFile(a: string, b: string): boolean {
	if (!existsSync(a) || !existsSync(b)) return false;
	const left = lstatSync(a);
	const right = lstatSync(b);
	return left.dev === right.dev && left.ino === right.ino;
}

function backupSource(
	project: ProjectStoreSource,
	completedAt: number,
	options: DaemonStoreImportOptions,
	partial = false,
): Pick<ProjectStoreImportResult, "backup" | "backupError"> {
	const backup = `${project.sourcePath}.imported-${completedAt}`;
	try {
		// Check every destination before moving the first sidecar. lstat also
		// catches dangling symlinks, which linkSync would refuse to overwrite.
		for (const suffix of backupSuffixes) {
			const source = `${project.sourcePath}${suffix}`;
			const target = `${backup}${suffix}`;
			if (!lstatSync(target, { throwIfNoEntry: false })) continue;
			if (sameFile(source, target)) continue;
			if (partial && suffix !== "" && !existsSync(source)) continue;
			throw new DaemonStoreImportError({
				projectId: project.projectId,
				kind: "io",
				message: `Backup target already exists: ${target}`,
			});
		}
		for (const suffix of backupSuffixes) {
			if (suffix === "")
				options.checkpoint?.("backup-sidecars", project.projectId);
			const source = `${project.sourcePath}${suffix}`;
			if (!existsSync(source)) continue;
			const target = `${backup}${suffix}`;
			if (!sameFile(source, target)) linkSync(source, target);
			unlinkSync(source);
		}
		return { backup };
	} catch (cause) {
		return {
			backupError: new DaemonStoreImportError({
				projectId: project.projectId,
				kind: "io",
				message: cause instanceof Error ? cause.message : String(cause),
				cause,
			}),
		};
	}
}

function finishBackup(
	configDir: string,
	source: ProjectStoreSource,
	options: DaemonStoreImportOptions,
	result?: ProjectStoreImportResult,
): ProjectStoreImportResult | undefined {
	const filename = daemonStorePath(configDir);
	if (!existsSync(filename)) return result;
	const db = new DatabaseSync(filename);
	let marker: ReturnType<typeof readMarker>;
	try {
		marker = readMarker(db, source.projectId);
	} finally {
		db.close();
	}
	if (!marker) return result;
	const skipped: ProjectStoreImportResult = result ?? {
		projectId: source.projectId,
		outcome: "skipped",
	};
	if (!existsSync(source.sourcePath)) return skipped;
	const project = { ...source, sourcePath: realpathSync(source.sourcePath) };
	if (result)
		return {
			...result,
			...backupSource(project, marker.completed_at, options),
		};
	const backup = `${marker.source_path}.imported-${marker.completed_at}`;
	const partial =
		(!existsSync(backup) &&
			backupSuffixes.some(
				(suffix) => suffix !== "" && existsSync(`${backup}${suffix}`),
			)) ||
		sameFile(project.sourcePath, backup);
	if (partial) {
		// Check moved backup files, never the partially moved source. Original
		// SHM/journal evidence is appended to the .4 main/WAL fingerprint.
		const expected = JSON.parse(
			marker.source_fingerprint,
		) as readonly unknown[];
		const moved = ["-wal", "-shm", "-journal"];
		const actual = JSON.parse(
			fingerprint(backup, project, moved),
		) as readonly unknown[];
		for (const [index, suffix] of moved.entries()) {
			if (
				existsSync(`${backup}${suffix}`) &&
				!existsSync(`${project.sourcePath}${suffix}`) &&
				JSON.stringify(expected[index + 1]) !== JSON.stringify(actual[index])
			)
				return {
					...skipped,
					backupError: new DaemonStoreImportError({
						projectId: project.projectId,
						kind: "io",
						message: `Backup sidecar does not match the imported source: ${backup}${suffix}`,
					}),
				};
		}
	}

	if (
		project.sourcePath === marker.source_path &&
		(partial ||
			fingerprint(project.sourcePath, project) ===
				sourceFingerprintOf(marker.source_fingerprint))
	)
		return {
			...skipped,
			...backupSource(project, marker.completed_at, options, partial),
		};
	return { projectId: project.projectId, outcome: "source-changed" };
}

function clearImportScratch(
	configDir: string,
	projects: readonly ProjectStoreSource[],
): void {
	mkdirSync(configDir, { recursive: true });
	const directory = realpathSync(configDir);
	// Registered names and their resolved aliases take precedence over scratch
	// patterns. Preserve their sidecars and completed backups on later runs too.
	const sources = projects.flatMap(({ sourcePath }) => [
		resolve(sourcePath),
		...(existsSync(sourcePath) ? [realpathSync(sourcePath)] : []),
	]);
	const filename = daemonStorePath(directory);
	if (existsSync(filename)) {
		const db = new DatabaseSync(filename);
		try {
			for (const { source_path } of rows<{ source_path: string }>(
				db,
				"SELECT source_path FROM daemon_store_imports",
			))
				sources.push(source_path);
		} finally {
			db.close();
		}
	}
	const remove = (filename: string): void => {
		const path = resolve(filename);
		if (
			sources.some(
				(source) =>
					path === source ||
					backupSuffixes.some((suffix) => path === `${source}${suffix}`) ||
					(path.startsWith(`${source}.imported-`) &&
						/^\d+(?:-(?:wal|shm|journal))?$/.test(
							path.slice(`${source}.imported-`.length),
						)),
			)
		)
			return;
		if (sources.some((source) => source.startsWith(`${path}${sep}`))) {
			if (lstatSync(filename).isDirectory())
				for (const name of readdirSync(filename)) remove(join(filename, name));
			return;
		}
		rmSync(filename, { recursive: true, force: true });
	};
	const folder = join(directory, "daemon-store-import");
	if (existsSync(folder)) remove(folder);
	if (!existsSync(folder)) mkdirSync(folder);
	const prefix = `${basename(daemonStorePath(directory))}.`;
	const temporary =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp(?:-(?:wal|shm|journal))?$/i;
	for (const name of readdirSync(directory)) {
		const filename = join(directory, name);
		if (
			name.startsWith(prefix) &&
			temporary.test(name.slice(prefix.length)) &&
			!lstatSync(filename).isDirectory()
		)
			remove(filename);
	}
}

export function formatDaemonStoreImportReport(
	results: readonly ProjectStoreImportResult[],
	timestamp: number,
): string {
	return `${[
		`Daemon store import ${new Date(timestamp).toISOString()}`,
		...results.map(
			(result) =>
				`${result.projectId}: ${result.outcome}` +
				(result.importedEvents === undefined
					? ""
					: `, ${result.importedEvents} events`) +
				(result.sharedSessions?.length
					? `, shared sessions left out: ${result.sharedSessions.join(",")}`
					: "") +
				(result.error
					? `, error ${result.error.kind}: ${result.error.message}`
					: "") +
				(result.backup ? `, backup ${result.backup}` : "") +
				(result.backupError
					? `, backup failed: ${result.backupError.message}`
					: ""),
		),
	].join("\n")}\n`;
}

function writeReport(
	configDir: string,
	results: readonly ProjectStoreImportResult[],
	options: DaemonStoreImportOptions,
): void {
	if (
		!results.some(
			(result) =>
				!["skipped", "absent"].includes(result.outcome) ||
				result.backup ||
				result.backupError,
		)
	)
		return;
	const filename = join(configDir, "daemon-store-import-report.txt");
	const temporary = `${filename}.${randomUUID()}.tmp`;
	try {
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(
				fd,
				formatDaemonStoreImportReport(results, (options.now ?? Date.now)()),
			);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, filename);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

/** Registered sources seed first; retained sources follow without taking ownership. */
export const importRegisteredProjectStores = (
	configDir: string,
	projects: readonly ProjectStoreSource[],
	options: DaemonStoreImportOptions = {},
): Effect.Effect<readonly ProjectStoreImportResult[], PersistenceEffectError> =>
	Effect.gen(function* () {
		yield* Effect.sync(() => clearImportScratch(configDir, projects));
		const results = new Map<string, ProjectStoreImportResult>();
		const failed = (
			project: ProjectStoreSource,
			error: DaemonStoreImportError,
		): ProjectStoreImportResult => ({
			projectId: project.projectId,
			outcome: error.kind === "source-changed" ? "source-changed" : "failed",
			error,
		});
		if (!existsSync(daemonStorePath(configDir))) {
			const sized = projects
				.filter((project) => !project.retained)
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
				const result = yield* seedDaemonStore(configDir, project, options).pipe(
					Effect.result,
				);
				if (result._tag === "Success") {
					const completed = yield* attempt(project, () =>
						finishBackup(configDir, project, options, result.success),
					).pipe(Effect.result);
					results.set(
						project.projectId,
						completed._tag === "Success"
							? (completed.success ?? result.success)
							: failed(project, completed.failure),
					);
					if (result.success.outcome === "seeded") break;
				} else results.set(project.projectId, failed(project, result.failure));
			}
		}
		// Retained sources cannot seed, even if there are no registered histories.
		if (
			!existsSync(daemonStorePath(configDir)) &&
			projects.some((project) => project.retained)
		) {
			yield* Effect.void.pipe(
				Effect.provide(makePersistenceStoreLayer(daemonStorePath(configDir))),
			);
		}
		for (const project of projects) {
			if (results.has(project.projectId)) continue;
			const marked = yield* attempt(project, () =>
				finishBackup(configDir, project, options),
			).pipe(Effect.result);
			if (marked._tag === "Failure") {
				results.set(project.projectId, failed(project, marked.failure));
				continue;
			}
			if (marked.success) {
				results.set(project.projectId, marked.success);
				continue;
			}
			const result = yield* importProjectStore(
				configDir,
				project,
				options,
			).pipe(Effect.result);
			if (result._tag === "Failure") {
				results.set(project.projectId, failed(project, result.failure));
				continue;
			}
			const completed = yield* attempt(project, () =>
				finishBackup(configDir, project, options, result.success),
			).pipe(Effect.result);
			results.set(
				project.projectId,
				completed._tag === "Success"
					? (completed.success ?? result.success)
					: failed(project, completed.failure),
			);
		}
		const ordered = projects.flatMap((project) => {
			const result = results.get(project.projectId);
			return result ? [result] : [];
		});
		yield* Effect.sync(() => writeReport(configDir, ordered, options));
		return ordered;
	});

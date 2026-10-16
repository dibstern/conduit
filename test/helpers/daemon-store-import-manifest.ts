import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { SqlClient } from "@effect/sql";
import Database from "better-sqlite3";
import { Effect, ManagedRuntime } from "effect";
import { makeCommitAndSignal } from "../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../src/lib/persistence/effect/projection-runner-effect.js";
import { ProviderStateEffectTag } from "../../src/lib/persistence/effect/provider-state-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../src/lib/persistence/events.js";
import { makeClaudeRunnerReceiptStore } from "../../src/lib/provider/claude/claude-runner-receipts.js";
import { DurableCommandCommitRepository } from "../../src/lib/provider/orchestration-command-commit.js";

type Row = Record<string, unknown>;
type NumberDomain = "event" | "outbox" | "version";

// These rows belong to the store rather than a project. Their reconciliation is
// asserted separately, since importing a second project necessarily changes them.
const storeTables = new Set([
	"effect_sql_migrations",
	"_migrations",
	"sqlite_sequence",
	"sqlite_stat1",
	"sqlite_stat4",
	"projector_cursors",
	"read_model_counter",
	"store_identity",
	"session_sidebar_horizon",
	"session_pick_backfill_state",
	"daemon_store_imports",
]);
const versionTables = new Set([
	"sessions",
	"messages",
	"message_parts",
	"pending_approvals",
	"pending_inputs",
	"message_tombstones",
	"message_part_tombstones",
	"session_sidebar",
]);
const eventColumns: Readonly<Record<string, readonly string[]>> = {
	events: ["sequence"],
	sessions: ["workspace_hint_sequence"],
	messages: ["last_applied_seq"],
	projection_failures: ["event_sequence"],
	provider_command_meta: ["last_applied_sequence"],
	provider_command_tombstones: ["event_sequence"],
};
const outboxColumns: Readonly<Record<string, readonly string[]>> = {
	provider_command_outbox: ["request_sequence"],
	command_receipts: ["accepted_sequence", "side_effect_sequence"],
};

export interface ProjectManifest {
	readonly tables: Readonly<Record<string, readonly Row[]>>;
	readonly rowCounts: Readonly<Record<string, number>>;
	readonly hash: string;
	/** Selection keys for runtime tables which have no project/session column. */
	readonly unownedKeys: Readonly<Record<string, readonly string[]>>;
}

function parsed(value: unknown): unknown {
	if (typeof value !== "string" || !/^[\s]*[[{]/.test(value)) return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, sorted(item)]),
		);
	return value;
}

// Keep path equality in the logical comparison without exposing absolute paths.
function logicalPaths(value: unknown): unknown {
	if (typeof value === "string" && value.startsWith("/"))
		return `path:${createHash("sha256").update(value).digest("hex")}`;
	if (Array.isArray(value)) return value.map(logicalPaths);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				String(logicalPaths(key)),
				logicalPaths(item),
			]),
		);
	return value;
}

// The full manifest preserves identity and time for the equality assertion.
// Artifact hashes additionally remove run-specific ids and wall-clock values.
function artifactHash(
	tables: Readonly<Record<string, readonly Row[]>>,
): string {
	const identities = new Map<string, string>();
	const identity = (value: string) => {
		let alias = identities.get(value);
		if (alias === undefined) {
			alias = `identity-${identities.size + 1}`;
			identities.set(value, alias);
		}
		return alias;
	};
	const normalize = (value: unknown, key = ""): unknown => {
		if (Array.isArray(value)) return value.map((item) => normalize(item));
		if (value !== null && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([field, item], index) => [
					field.startsWith("path:") ? `path-key-${index}` : field,
					normalize(item, field),
				]),
			);
		if (
			typeof value === "number" &&
			/(?:_at|At|Timestamp|last_activity|lastActivity|sent_at)$/.test(key)
		)
			return "time";
		if (typeof value === "string") {
			if (key === "source_fingerprint") return "source-fingerprint";
			if (/(?:_at|At)$/.test(key)) return "time";
			if (value.startsWith("/") || value.startsWith("path:")) return "path";
			if (key === "fingerprint_hash" || key === "fingerprintHash")
				return "command-fingerprint";
			if (
				!/^(provider|project|model|agent|origin|instance)(?:_?id|Id|ID)$/i.test(
					key,
				) &&
				/(?:^id$|_id$|Id$|ID$|fork_point_event$|anchor$|claim_id$)/.test(key)
			)
				return identity(value);
		}
		return value;
	};
	// Sequence rank is stable even when event ids were randomly generated.
	for (const row of [...(tables["events"] ?? [])].sort(
		(a, b) => Number(a["sequence"]) - Number(b["sequence"]),
	))
		normalize(row);
	const stable = Object.fromEntries(
		Object.entries(tables).map(([table, rows]) => [
			table,
			rows
				.map((row) =>
					normalize(
						table === "provider_state" &&
							typeof row["key"] === "string" &&
							/(?:id|uuid)$/i.test(row["key"]) &&
							typeof row["value"] === "string"
							? { ...row, value: identity(row["value"]) }
							: row,
					),
				)
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		]),
	);
	return createHash("sha256")
		.update(JSON.stringify(sorted(stable)))
		.digest("hex");
}

/**
 * Independent logical comparison: no offsets or importer implementation are
 * consulted. Every application table is discovered, scoped and compared. Event,
 * outbox and version clocks become their relative ranks within this project.
 */
export function projectManifest(
	filename: string,
	projectId: string,
	source?: ProjectManifest,
): ProjectManifest {
	const db = new Database(filename, { readonly: true, fileMustExist: true });
	try {
		const legacyOwner = source === undefined ? " OR project_id IS NULL" : "";
		const names = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all() as { name: string }[];
		const sessions = new Set(
			(
				db
					.prepare(`SELECT id FROM sessions WHERE project_id = ?${legacyOwner}
			UNION SELECT session_id FROM events WHERE project_id = ?${legacyOwner}
			UNION SELECT session_id FROM session_sidebar WHERE project_id = ?${legacyOwner}`)
					.all(projectId, projectId, projectId) as { id: string }[]
			).map((row) => row.id),
		);
		const events = new Set(
			(
				db
					.prepare(
						`SELECT sequence FROM events WHERE project_id = ?${legacyOwner}`,
					)
					.all(projectId) as { sequence: number }[]
			).map((row) => row.sequence),
		);
		const messages = new Set(
			(
				db.prepare("SELECT id, session_id FROM messages").all() as {
					id: string;
					session_id: string;
				}[]
			)
				.filter((row) => sessions.has(row.session_id))
				.map((row) => row.id),
		);
		const raw: Record<string, Row[]> = {};
		const unownedKeys: Record<string, string[]> = {
			claude_runner_cursors: [],
			session_git_published: [],
		};
		raw["claude_runner_cursors"] = [];
		raw["claude_runner_permission_replies"] = [];
		for (const { name } of names) {
			if (storeTables.has(name)) continue;
			if (!/^[a-z_][a-z_0-9]*$/.test(name))
				throw new Error(`Unexpected table ${name}`);
			let rows = db
				.prepare(`SELECT rowid AS __rowid, * FROM "${name}" ORDER BY rowid`)
				.all() as Row[];
			if (name === "projection_failures")
				rows = rows.filter(
					(row) =>
						events.has(Number(row["event_sequence"])) ||
						sessions.has(String(row["session_id"])),
				);
			else if (name === "message_parts")
				rows = rows.filter((row) => messages.has(String(row["message_id"])));
			else if (rows.some((row) => "project_id" in row))
				rows = rows.filter(
					(row) =>
						row["project_id"] === projectId ||
						(source === undefined && row["project_id"] === null),
				);
			else if (rows.some((row) => "project_key" in row))
				rows = rows.filter(
					(row) =>
						row["project_key"] === projectId ||
						(source === undefined && row["project_key"] === null),
				);
			else if (rows.some((row) => "session_id" in row))
				rows = rows.filter((row) => sessions.has(String(row["session_id"])));
			else if (
				name === "claude_runner_cursors" ||
				name === "session_git_published"
			) {
				const key =
					name === "claude_runner_cursors" ? "runner_id" : "directory";
				const selectionKey = (row: Row) => String(logicalPaths(row[key]));
				const expected = source?.unownedKeys[name];
				if (expected)
					rows = rows.filter((row) => expected.includes(selectionKey(row)));
				unownedKeys[name] = rows.map(selectionKey);
			} else if (rows.length > 0)
				throw new Error(`Manifest has no ownership rule for ${name}`);
			raw[name] = rows;
		}
		const domains: Record<NumberDomain, Set<number>> = {
			event: new Set(),
			outbox: new Set(),
			version: new Set(),
		};
		const visit = (
			value: unknown,
			domain: NumberDomain,
			transform: (n: number, d: NumberDomain) => unknown,
		): unknown =>
			typeof value === "number" && (domain === "version" || value > 0)
				? transform(value, domain)
				: value;
		const json = (
			value: unknown,
			transform: (n: number, d: NumberDomain) => unknown,
			versions = false,
		): unknown => {
			const item = parsed(value);
			if (Array.isArray(item))
				return item.map((entry) => json(entry, transform));
			if (item !== null && typeof item === "object")
				return Object.fromEntries(
					Object.entries(item).map(([key, entry]) => [
						key,
						[
							"firstSequence",
							"deliveredThrough",
							"workspaceMoveSequence",
						].includes(key) ||
						(key === "sequence" && "acknowledged" in item)
							? visit(entry, "event", transform)
							: versions && key === "version"
								? visit(entry, "version", transform)
								: json(entry, transform),
					]),
				);
			return item;
		};
		const walk = (
			table: string,
			row: Row,
			transform: (n: number, d: NumberDomain) => unknown,
		): Row =>
			Object.fromEntries(
				Object.entries(row)
					.filter(([key]) => key !== "__rowid")
					.map(([key, value]) => {
						if ((eventColumns[table] ?? []).includes(key))
							return [key, visit(value, "event", transform)];
						if ((outboxColumns[table] ?? []).includes(key))
							return [key, visit(value, "outbox", transform)];
						if (key === "version" && versionTables.has(table))
							return [key, visit(value, "version", transform)];
						if (
							source === undefined &&
							(key === "project_id" || key === "project_key") &&
							value === null
						)
							return [key, projectId];
						if (table === "sessions" && key === "claude_worktree_state") {
							const state = parsed(value);
							if (
								state !== null &&
								typeof state === "object" &&
								!Array.isArray(state)
							) {
								const pending = (state as Row)["pending"];
								if (
									pending !== null &&
									typeof pending === "object" &&
									!Array.isArray(pending)
								)
									return [
										key,
										{
											...state,
											pending: {
												...pending,
												sequence: visit(
													(pending as Row)["sequence"],
													"event",
													transform,
												),
											},
										},
									];
							}
						}
						return [
							key,
							json(
								value,
								transform,
								table === "session_sidebar" && key === "row",
							),
						];
					}),
			);
		for (const [table, rows] of Object.entries(raw))
			for (const row of rows)
				walk(table, row, (number, domain) => {
					domains[domain].add(number);
					return number;
				});
		const ranks = Object.fromEntries(
			Object.entries(domains).map(([domain, values]) => [
				domain,
				new Map(
					[...values]
						.sort((a, b) => a - b)
						.map((value, index) => [value, index + 1]),
				),
			]),
		) as Record<NumberDomain, Map<number, number>>;
		const counter = Number(
			(
				db
					.prepare("SELECT value FROM read_model_counter WHERE id = 1")
					.get() as Row
			)["value"],
		);
		if ([...domains.version].some((value) => value < 0 || value > counter))
			throw new Error("Read-model version outside counter range");
		const tables: Record<string, Row[]> = {};
		for (const [table, rows] of Object.entries(raw)) {
			tables[table] = rows
				.map((row, index) => {
					const result = walk(table, row, (number, domain) =>
						ranks[domain].get(number),
					);
					if (table === "turns" || table === "pending_inputs")
						result["__order"] = index + 1;
					if (table === "projection_failures") result["id"] = index + 1;
					return sorted(logicalPaths(result)) as Row;
				})
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
		}
		const rowCounts = Object.fromEntries(
			Object.entries(tables).map(([table, rows]) => [table, rows.length]),
		);
		return { tables, rowCounts, hash: artifactHash(tables), unownedKeys };
	} finally {
		db.close();
	}
}

export interface StoreImportPosition {
	readonly eventSequence: number;
	readonly readModelVersion: number;
	readonly outboxSequence: number;
}

export function storeImportPosition(filename: string): StoreImportPosition {
	const db = new Database(filename, { readonly: true, fileMustExist: true });
	try {
		return db
			.prepare(`SELECT
			COALESCE((SELECT MAX(sequence) FROM events), 0) AS eventSequence,
			(SELECT value FROM read_model_counter WHERE id = 1) AS readModelVersion,
			COALESCE((SELECT MAX(request_sequence) FROM provider_command_outbox), 0) AS outboxSequence`)
			.get() as StoreImportPosition;
	} finally {
		db.close();
	}
}

/** Raw daemon-store invariants, independent of rank normalization and offsets. */
export function daemonStoreAssertions(
	filename: string,
	imported: {
		readonly projectId: string;
		readonly before: StoreImportPosition;
	},
) {
	const db = new Database(filename, { readonly: true, fileMustExist: true });
	try {
		const names = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as { name: string }[];
		const nullOwnership = names.flatMap(({ name }) => {
			const fields = db.prepare(`PRAGMA table_info("${name}")`).all() as {
				name: string;
			}[];
			return fields
				.filter(
					(field) =>
						field.name === "project_id" || field.name === "project_key",
				)
				.map((field) =>
					Number(
						(
							db
								.prepare(
									`SELECT COUNT(*) AS n FROM "${name}" WHERE "${field.name}" IS NULL`,
								)
								.get() as { n: number }
						).n,
					),
				);
		});
		const sessionScope = `SELECT id AS session_id FROM sessions WHERE project_id = ?
			UNION SELECT session_id FROM events WHERE project_id = ?
			UNION SELECT session_id FROM session_sidebar WHERE project_id = ?`;
		const allVersions: number[] = [];
		const importedVersions: number[] = [];
		for (const table of versionTables) {
			allVersions.push(
				...(
					db.prepare(`SELECT version FROM ${table}`).all() as {
						version: number;
					}[]
				).map((row) => row.version),
			);
			const scope =
				table === "sessions" || table === "session_sidebar"
					? "project_id = ?"
					: table === "message_parts"
						? `message_id IN (SELECT id FROM messages WHERE session_id IN (${sessionScope}))`
						: `session_id IN (${sessionScope})`;
			const params =
				table === "sessions" || table === "session_sidebar"
					? [imported.projectId]
					: [imported.projectId, imported.projectId, imported.projectId];
			importedVersions.push(
				...(
					db
						.prepare(`SELECT version FROM ${table} WHERE ${scope}`)
						.all(...params) as { version: number }[]
				).map((row) => row.version),
			);
		}
		const sidebarVersions = db
			.prepare(
				"SELECT project_id, json_extract(row, '$.version') AS version FROM session_sidebar WHERE row IS NOT NULL",
			)
			.all() as { project_id: string; version: number }[];
		allVersions.push(...sidebarVersions.map((row) => row.version));
		importedVersions.push(
			...sidebarVersions
				.filter((row) => row.project_id === imported.projectId)
				.map((row) => row.version),
		);
		const events = db
			.prepare("SELECT sequence FROM events WHERE project_id = ?")
			.all(imported.projectId) as { sequence: number }[];
		const outbox = db
			.prepare(
				"SELECT request_sequence FROM provider_command_outbox WHERE project_key = ?",
			)
			.all(imported.projectId) as { request_sequence: number }[];
		const position = storeImportPosition(filename);
		const horizon = db
			.prepare("SELECT version FROM session_sidebar_horizon WHERE id = 1")
			.get() as { version: number };
		const cursors = db
			.prepare("SELECT last_applied_seq FROM projector_cursors")
			.all() as { last_applied_seq: number }[];
		return {
			ownershipStamped: nullOwnership.every((count) => count === 0),
			eventOffsets:
				events.length > 0 &&
				events.every((row) => row.sequence > imported.before.eventSequence),
			versionOffsets:
				importedVersions.length > 0 &&
				importedVersions.every(
					(version) => version > imported.before.readModelVersion,
				),
			outboxOffsets: outbox.every(
				(row) => row.request_sequence > imported.before.outboxSequence,
			),
			counterMatchesVersions:
				position.readModelVersion === Math.max(0, ...allVersions),
			horizonMatchesCounter: horizon.version === position.readModelVersion,
			cursorsCoverEvents:
				cursors.length > 0 &&
				cursors.every((row) => row.last_applied_seq >= position.eventSequence),
		};
	} finally {
		db.close();
	}
}

export function sourceChecksums(filename: string): {
	main: string;
	wal: string | null;
} {
	const hash = (file: string) =>
		createHash("sha256").update(readFileSync(file)).digest("hex");
	return {
		main: hash(filename),
		wal: existsSync(`${filename}-wal`) ? hash(`${filename}-wal`) : null,
	};
}

export function storeTableCounts(filename: string): Record<string, number> {
	const db = new Database(filename, { readonly: true, fileMustExist: true });
	try {
		return Object.fromEntries(
			(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
					)
					.all() as { name: string }[]
			).map(({ name }) => [
				name,
				Number(
					(db.prepare(`SELECT count(*) AS count FROM "${name}"`).get() as Row)[
						"count"
					],
				),
			]),
		);
	} finally {
		db.close();
	}
}

export function writeImportArtifact(filename: string, evidence: unknown): void {
	mkdirSync(dirname(filename), { recursive: true });
	writeFileSync(filename, `${JSON.stringify(sorted(evidence), null, 2)}\n`);
}

/** Full logical state, including markers and allocation clocks, for rollback proof. */
export function daemonStoreManifest(filename: string): {
	tables: Readonly<Record<string, readonly Row[]>>;
	hash: string;
} {
	const db = new Database(filename, { readonly: true, fileMustExist: true });
	try {
		const names = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_stat%' ORDER BY name",
			)
			.all() as { name: string }[];
		const tables = Object.fromEntries(
			names.map(({ name }) => [
				name,
				db
					.prepare(
						`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`,
					)
					.all() as Row[],
			]),
		);
		const logical = Object.fromEntries(
			Object.entries(tables).map(([table, rows]) => [
				table,
				rows.map((row) =>
					Object.fromEntries(
						Object.entries(row).map(([key, value]) => [
							key,
							table === "store_identity" && key === "value"
								? "store-identity"
								: key === "source_fingerprint"
									? "source-fingerprint"
									: parsed(value),
						]),
					),
				),
			]),
		);
		return { tables, hash: artifactHash(logical) };
	} finally {
		db.close();
	}
}

export type ProjectStoreFixture = { projectId: string; sourcePath: string };

export async function createProjectStoreFixture(
	root: string,
	projectId: string,
	options: {
		sessionId?: string;
		large?: boolean;
		synthetic?: boolean;
		unprojected?: boolean;
		eventSequenceStart?: number;
		outboxSequence?: number;
	} = {},
): Promise<ProjectStoreFixture> {
	const folder = join(root, projectId);
	mkdirSync(folder, { recursive: true });
	const sourcePath = join(folder, "events.db");
	const runtime = ManagedRuntime.make(
		makePersistenceEffectLayer(sourcePath, projectId),
	);
	const id = options.sessionId ?? `ses_${projectId}`;
	const user = `${id}_user`;
	const assistant = `${id}_assistant`;
	const time = { provider: "claude", createdAt: 1000 };
	const events: CanonicalEvent[] = [
		canonicalEvent(
			"session.created",
			id,
			{ sessionId: id, title: "Imported history", provider: "claude" },
			time,
		),
		canonicalEvent(
			"message.created",
			id,
			{ sessionId: id, messageId: user, role: "user" },
			time,
		),
		canonicalEvent(
			"message.created",
			id,
			{ sessionId: id, messageId: assistant, role: "assistant" },
			time,
		),
		canonicalEvent(
			"text.delta",
			id,
			{
				messageId: assistant,
				partId: `${id}_text`,
				text: options.large
					? "long transcript ".repeat(40_000)
					: "Complete transcript",
			},
			time,
		),
		canonicalEvent(
			"thinking.start",
			id,
			{ messageId: assistant, partId: `${id}_thinking` },
			time,
		),
		canonicalEvent(
			"thinking.delta",
			id,
			{ messageId: assistant, partId: `${id}_thinking`, text: "Thinking" },
			time,
		),
		canonicalEvent(
			"thinking.end",
			id,
			{ messageId: assistant, partId: `${id}_thinking` },
			time,
		),
		canonicalEvent(
			"tool.started",
			id,
			{
				messageId: assistant,
				partId: `${id}_tool`,
				callId: `${id}_call`,
				toolName: "Bash",
				input: { tool: "Bash", command: "pwd" },
			},
			time,
		),
		canonicalEvent(
			"tool.completed",
			id,
			{
				messageId: assistant,
				partId: `${id}_tool`,
				result: "fixture",
				duration: 10,
				metadata: {},
			},
			time,
		),
		canonicalEvent(
			"turn.completed",
			id,
			{
				messageId: assistant,
				userMessageId: user,
				cost: 0.03,
				duration: 20,
				tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
			},
			time,
		),
		canonicalEvent(
			"session.created",
			`${id}_fork`,
			{ sessionId: `${id}_fork`, title: "Fork", provider: "claude" },
			time,
		),
		canonicalEvent(
			"session.forked",
			`${id}_fork`,
			{ sessionId: `${id}_fork`, parentId: id, forkPointEvent: assistant },
			time,
		),
		canonicalEvent(
			"session.created",
			`${id}_child`,
			{
				sessionId: `${id}_child`,
				title: "Subagent",
				provider: "claude",
				parentId: id,
			},
			time,
		),
		canonicalEvent(
			"tool.started",
			id,
			{
				messageId: assistant,
				partId: `${id}_task`,
				callId: `${id}_task_call`,
				toolName: "Task",
				input: { tool: "Task", description: "Child", prompt: "Continue" },
			},
			time,
		),
		canonicalEvent(
			"tool.running",
			id,
			{
				messageId: assistant,
				partId: `${id}_task`,
				metadata: {
					childSessionId: `${id}_child`,
					providerTaskId: `${id}_provider_task`,
				},
			},
			time,
		),
		canonicalEvent(
			"permission.asked",
			id,
			{
				id: `${id}_pending`,
				sessionId: id,
				toolName: "Bash",
				input: { command: "pwd" },
			},
			time,
		),
		canonicalEvent(
			"permission.asked",
			id,
			{
				id: `${id}_resolved`,
				sessionId: id,
				toolName: "Bash",
				input: { command: "ls" },
			},
			time,
		),
		canonicalEvent(
			"permission.resolved",
			id,
			{ id: `${id}_resolved`, decision: "once" },
			time,
		),
		canonicalEvent(
			"session.provider_changed",
			id,
			{ sessionId: id, oldProvider: "claude", newProvider: "opencode" },
			time,
		),
		canonicalEvent(
			"input.admitted",
			id,
			{
				sessionId: id,
				inputId: `${id}_queue_1`,
				delivery: "queue",
				request: { text: "queued first" },
			},
			time,
		),
		canonicalEvent(
			"input.admitted",
			id,
			{
				sessionId: id,
				inputId: `${id}_queue_2`,
				delivery: "queue",
				request: { text: "queued second" },
			},
			time,
		),
		canonicalEvent(
			"input.admitted",
			id,
			{
				sessionId: id,
				inputId: `${id}_removed`,
				delivery: "steer",
				request: { text: "cancelled" },
			},
			time,
		),
		canonicalEvent(
			"input.cancelled",
			id,
			{ sessionId: id, inputId: `${id}_removed` },
			time,
		),
		canonicalEvent(
			"message.created",
			id,
			{ sessionId: id, messageId: `${id}_gone`, role: "assistant" },
			time,
		),
		canonicalEvent(
			"text.delta",
			id,
			{ messageId: `${id}_gone`, partId: `${id}_gone_part`, text: "remove me" },
			time,
		),
		canonicalEvent(
			"message.part.removed",
			id,
			{ messageId: `${id}_gone`, partId: `${id}_gone_part` },
			time,
		),
		canonicalEvent("message.removed", id, { messageId: `${id}_gone` }, time),
		canonicalEvent(
			"message.created",
			id,
			{ sessionId: id, messageId: `${id}_user_second`, role: "user" },
			time,
		),
		canonicalEvent(
			"text.delta",
			id,
			{
				messageId: `${id}_user_second`,
				partId: `${id}_user_second_text`,
				text: "Second turn",
			},
			time,
		),
		canonicalEvent(
			"session.created",
			`${id}_deleted`,
			{ sessionId: `${id}_deleted`, title: "Deleted", provider: "claude" },
			time,
		),
		canonicalEvent(
			"session.deleted",
			`${id}_deleted`,
			{ sessionId: `${id}_deleted` },
			time,
		),
		canonicalEvent(
			"session.workspace_changed",
			id,
			{
				sessionId: id,
				worktrees: {},
				path: "/fixture/worktree",
				cause: "user",
				origin: "existing",
			},
			time,
		),
		canonicalEvent(
			"session.workspace_hint_changed",
			id,
			{ path: "/fixture/other" },
			time,
		),
	];
	if (options.synthetic)
		events.push(
			canonicalEvent(
				"session.compaction",
				id,
				{ sessionId: id, state: "completed", detail: "Compacted" },
				time,
			),
			canonicalEvent(
				"turn.error",
				id,
				{
					messageId: `${id}_failed`,
					userMessageId: user,
					error: "Fixture error",
					code: "FIXTURE",
				},
				time,
			),
		);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
				const sql = yield* SqlClient.SqlClient;
				if (options.eventSequenceStart !== undefined)
					yield* sql`INSERT INTO sqlite_sequence (name, seq) VALUES ('events', ${options.eventSequenceStart})`;
				const write = yield* makeCommitAndSignal;
				// Equal timestamps exercise turns' and pending_inputs' rowid tie-breaks.
				for (const event of events) yield* write([event]);
				const [move] = yield* sql<{
					sequence: number;
				}>`SELECT sequence FROM events WHERE session_id = ${id} AND type = 'session.workspace_changed'`;
				if (!move)
					return yield* Effect.die(new Error("Missing fixture workspace move"));
				yield* write([
					canonicalEvent(
						"input.sent",
						id,
						{
							sessionId: id,
							inputId: `${id}_queue_1`,
							workspaceMoveSequence: move.sequence,
						},
						time,
					),
				]);
				const state = yield* ProviderStateEffectTag;
				yield* state.saveUpdates(id, [
					{
						key: "nativeThread:opencode",
						value: JSON.stringify({
							resumeSessionId: `${id}_native`,
							firstSequence: 0,
							deliveredThrough: 0,
						}),
					},
					{ key: "turnCount", value: "2" },
				]);
				const thread = (yield* state.getState(id))["nativeThread:opencode"];
				const repository = new DurableCommandCommitRepository(sql, projectId);
				const requestSequence = options.outboxSequence ?? 7;
				yield* repository.commit({
					events: [],
					readModelRows: [],
					receipt: {
						commandId: `${id}_command`,
						commandType: "send_turn",
						sessionId: id,
						status: "side_effect_requested",
						fingerprintHash: "fixture-hash",
						fingerprintVersion: 2,
						acceptedSequence: requestSequence,
						sideEffectSequence: requestSequence,
						createdAt: 1000,
						updatedAt: 1000,
					},
					outboxRequests: [
						{
							requestSequence,
							commandId: `${id}_command`,
							sessionId: id,
							providerId: "opencode",
							effectType: "send_turn",
							payloadJson: JSON.stringify({
								providerState: { "nativeThread:opencode": thread },
								prompt: "fixture",
							}),
						},
					],
				});
				const receipts = yield* makeClaudeRunnerReceiptStore(sql);
				yield* receipts.attach(`${projectId}_runner`, "fixture-attachment");
				yield* receipts.acknowledge(
					`${projectId}_runner`,
					1,
					{},
					"fixture-attachment",
				);
				yield* sql`INSERT INTO claude_runner_permission_replies VALUES (${id}, ${`${id}_resolved`}, '{"decision":"allow"}')`;
				// These primary/legacy records have no current canonical event producer.
				yield* sql`INSERT INTO tool_content VALUES (${`${id}_blob`}, ${id}, 'saved tool result', 1000)`;
				yield* sql`INSERT INTO sent_alerts VALUES (${id}, 'turn-finished', ${assistant}, 1000, 'delivered', 'fixture-claim')`;
				yield* sql`INSERT INTO session_pick_backfill VALUES (${id}, 'driver_unresolved')`;
				yield* sql`INSERT INTO session_git_published VALUES (${`/fixture/${projectId}`}, '{"branch":"fixture"}')`;
				yield* sql`INSERT INTO session_goal_checks VALUES (${`${id}_goal_check`}, ${id}, 'complete', 1000, 2, 'continue', 1000)`;
				yield* sql`INSERT INTO provider_command_sessions (project_key, session_id, provider_id, provider_kind, status, created_at, updated_at) VALUES (${projectId}, ${id}, 'opencode', 'opencode', 'idle', 1000, 1000)`;
				yield* sql`INSERT INTO provider_command_turns (project_key, session_id, turn_id, command_id, status, created_at, updated_at) VALUES (${projectId}, ${id}, ${user}, ${`${id}_command`}, 'completed', 1000, 1000)`;
				yield* sql`INSERT INTO provider_command_interactions (project_key, session_id, interaction_id, kind, status, created_at, updated_at) VALUES (${projectId}, ${id}, ${`${id}_legacy_permission`}, 'permission', 'resolved', 1000, 1000)`;
				yield* sql`INSERT INTO provider_command_tombstones (project_key, scope_kind, scope_id, session_id, event_sequence, reason_code, tombstoned_at) VALUES (${projectId}, 'turn', ${`${id}_old_turn`}, ${id}, ${move.sequence}, 'deleted', 1000)`;
				yield* sql`UPDATE provider_command_meta SET last_applied_sequence = ${move.sequence} WHERE project_key = ${projectId}`;
				yield* sql`INSERT INTO projection_failures (projector_name, event_sequence, event_type, session_id, error, failed_at) VALUES ('fixture-diagnostic', ${move.sequence}, 'session.workspace_changed', ${id}, 'historical diagnostic', 1000)`;
				if (options.unprojected) {
					const store = yield* EventStoreEffectTag;
					yield* store.append(
						canonicalEvent(
							"session.renamed",
							id,
							{ sessionId: id, title: "Unprojected tail" },
							time,
						),
					);
				}
			}),
		);
	} finally {
		await runtime.dispose();
	}
	return { projectId, sourcePath: realpathSync(sourcePath) };
}

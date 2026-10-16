import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { Effect, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	DaemonStoreImportError,
	formatDaemonStoreImportReport,
	importRegisteredProjectStores,
	type ProjectStoreImportResult,
	type ProjectStoreSource,
} from "../../../src/lib/persistence/migrations/daemon-store-import.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import { PROJECT_COMMAND_TABLES } from "../../../src/lib/persistence/schema.js";
import {
	daemonStoreManifest,
	createProjectStoreFixture as fixture,
	projectManifest,
	projectStoreBackup,
	sourceChecksums,
	storeTableCounts,
	writeImportArtifact,
} from "../../helpers/daemon-store-import-manifest.js";

const evidence: Record<string, unknown[]> = {};
let root: string;
let configDir: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "conduit-import-failures-"));
	configDir = join(root, "daemon");
	mkdirSync(configDir);
});
afterEach(() => {
	try {
		const scratch = join(configDir, "daemon-store-import");
		expect(existsSync(scratch) ? readdirSync(scratch) : []).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
afterAll(() =>
	writeImportArtifact("test-results/82tn5-import-failures.json", evidence),
);

function edit(path: string, sql: string): void {
	const db = new Database(path);
	try {
		db.exec(sql);
	} finally {
		db.close();
	}
}
function query(path: string, sql: string): unknown[] {
	const db = new Database(path, { readonly: true });
	try {
		return db.prepare(sql).all();
	} finally {
		db.close();
	}
}
function record(row: string, result: ProjectStoreImportResult): void {
	(evidence[row] ??= []).push({
		outcome: result.outcome,
		errorKind: result.error?.kind ?? null,
		importedEvents: result.importedEvents ?? null,
		sharedSessions: result.sharedSessions ?? [],
		daemonStoreManifestHash: existsSync(daemonStorePath(configDir))
			? daemonStoreManifest(daemonStorePath(configDir)).hash
			: null,
	});
}
async function run(
	row: string,
	project: ProjectStoreSource,
): Promise<ProjectStoreImportResult> {
	const [result] = await Effect.runPromise(
		importRegisteredProjectStores(configDir, [project]),
	);
	if (!result) throw new Error("Missing import result");
	record(row, result);
	return result;
}
async function seed(): Promise<void> {
	const project = await fixture(root, "owner", { large: true });
	const [result] = await Effect.runPromise(
		importRegisteredProjectStores(configDir, [project]),
	);
	expect(result?.outcome).toBe("seeded");
}
async function append(
	project: ProjectStoreSource,
	id: string,
	parent?: string,
	forked = false,
): Promise<void> {
	const runtime = ManagedRuntime.make(
		makePersistenceEffectLayer(project.sourcePath, project.projectId),
	);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				if (!(yield* runner.isRecovered())) yield* runner.recover();
				const write = yield* makeCommitAndSignal;
				yield* write([
					canonicalEvent(
						"session.created",
						id,
						{
							sessionId: id,
							title: "Independent history",
							provider: "claude",
							...(parent ? { parentId: parent } : {}),
						},
						{ provider: "claude", createdAt: 2000 },
					),
					canonicalEvent(
						"message.created",
						id,
						{ sessionId: id, messageId: `${id}_message`, role: "user" },
						{ provider: "claude", createdAt: 2000 },
					),
					...(parent && forked
						? [
								canonicalEvent(
									"session.forked",
									id,
									{
										sessionId: id,
										parentId: parent,
										forkPointEvent: `${parent}_assistant`,
									},
									{ provider: "claude", createdAt: 2000 },
								),
							]
						: []),
				]);
			}),
		);
	} finally {
		await runtime.dispose();
	}
}
function noMarker(projectId: string): void {
	if (existsSync(daemonStorePath(configDir)))
		expect(
			query(
				daemonStorePath(configDir),
				`SELECT project_id FROM daemon_store_imports WHERE project_id = '${projectId}'`,
			),
		).toEqual([]);
}

it("S1 missing sources are absent, never seed, and import when they appear", async () => {
	const missing = {
		projectId: "missing",
		sourcePath: join(root, "missing", "events.db"),
	};
	expect((await run("S1", missing)).outcome).toBe("absent");
	expect(existsSync(daemonStorePath(configDir))).toBe(false);
	const owner = await fixture(root, "owner");
	const results = await Effect.runPromise(
		importRegisteredProjectStores(configDir, [missing, owner]),
	);
	expect(results.map((r) => r.outcome)).toEqual(["absent", "seeded"]);
	noMarker("missing");
	const appeared = await fixture(root, "missing");
	expect((await run("S1", appeared)).outcome).toBe("imported");
});

for (const mode of ["seeded", "imported"] as const) {
	it.each([
		"zero-byte",
		"no-events",
	])(`S2 %s sources are ${mode} with a marker and zero rows`, async (state) => {
		if (mode === "imported") await seed();
		const project = { projectId: "empty", sourcePath: join(root, "empty.db") };
		if (state === "zero-byte") writeFileSync(project.sourcePath, "");
		else {
			const runtime = ManagedRuntime.make(
				makePersistenceEffectLayer(project.sourcePath, project.projectId),
			);
			try {
				await runtime.runPromise(
					Effect.flatMap(ProjectionRunnerEffectTag, (runner) =>
						runner.recover(),
					),
				);
			} finally {
				await runtime.dispose();
			}
		}
		const before = sourceChecksums(project.sourcePath);
		const result = await run("S2", project);
		expect(result).toMatchObject({
			outcome: mode,
			importedEvents: 0,
			sharedSessions: [],
		});
		expect(
			query(
				daemonStorePath(configDir),
				"SELECT project_id FROM daemon_store_imports WHERE project_id = 'empty'",
			),
		).toEqual([{ project_id: "empty" }]);
		expect(
			query(
				daemonStorePath(configDir),
				"SELECT * FROM events WHERE project_id = 'empty'",
			),
		).toEqual([]);
		expect(sourceChecksums(projectStoreBackup(project.sourcePath))).toEqual(
			before,
		);
	});

	it.each([
		"S3",
		"S4",
		"S5",
		"S11",
	])(`%s rejects an unsafe ${mode} source without changing it`, async (row) => {
		if (mode === "imported") await seed();
		const project = await fixture(root, "unsafe");
		if (row === "S3")
			writeFileSync(project.sourcePath, "garbage header, not sqlite");
		if (row === "S4")
			truncateSync(
				project.sourcePath,
				readFileSync(project.sourcePath).length / 2,
			);
		if (row === "S5")
			edit(
				project.sourcePath,
				"INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (9999, 'future_schema', '2026-01-01')",
			);
		if (row === "S11")
			writeFileSync(`${project.sourcePath}-journal`, "hot rollback journal");
		const before = sourceChecksums(project.sourcePath);
		const manifest = existsSync(daemonStorePath(configDir))
			? daemonStoreManifest(daemonStorePath(configDir)).tables
			: undefined;
		const result = await run(row, project);
		expect(result).toMatchObject({
			outcome: "failed",
			error: {
				kind:
					row === "S5"
						? "newer-schema"
						: row === "S11"
							? "unsupported-source"
							: "corrupt",
			},
		});
		noMarker(project.projectId);
		expect(sourceChecksums(project.sourcePath)).toEqual(before);
		if (row === "S11")
			expect(readFileSync(`${project.sourcePath}-journal`, "utf8")).toBe(
				"hot rollback journal",
			);
		if (manifest)
			expect(daemonStoreManifest(daemonStorePath(configDir)).tables).toEqual(
				manifest,
			);
		else expect(existsSync(daemonStorePath(configDir))).toBe(false);
		const healthy = await fixture(root, "healthy");
		expect((await run(row, healthy)).outcome).toBe(mode);
	});

	it(`S6 an older ledger is migrated on the copy before it is ${mode}`, async () => {
		if (mode === "imported") await seed();
		const project = await fixture(root, "older");
		const expected = projectManifest(project.sourcePath, project.projectId);
		edit(
			project.sourcePath,
			"DROP TABLE daemon_store_imports; DELETE FROM effect_sql_migrations WHERE migration_id = 60",
		);
		const before = sourceChecksums(project.sourcePath);
		expect((await run("S6", project)).outcome).toBe(mode);
		expect(
			projectManifest(daemonStorePath(configDir), project.projectId, expected)
				.tables,
		).toEqual(expected.tables);
		expect(sourceChecksums(projectStoreBackup(project.sourcePath))).toEqual(
			before,
		);
	});

	it(`S7 NULL owners and legacy folder keys are stamped on the ${mode} copy`, async () => {
		if (mode === "imported") await seed();
		const project = await fixture(root, "legacy");
		const expected = projectManifest(project.sourcePath, project.projectId);
		edit(
			project.sourcePath,
			`UPDATE events SET project_id = NULL; UPDATE sessions SET project_id = NULL; UPDATE session_sidebar SET project_id = NULL; ${PROJECT_COMMAND_TABLES.map((table) => `UPDATE ${table} SET project_key = 'legacy-folder:/old/project';`).join(" ")}`,
		);
		const before = sourceChecksums(project.sourcePath);
		expect((await run("S7", project)).outcome).toBe(mode);
		expect(
			projectManifest(daemonStorePath(configDir), project.projectId, expected)
				.tables,
		).toEqual(expected.tables);
		expect(sourceChecksums(projectStoreBackup(project.sourcePath))).toEqual(
			before,
		);
	});

	it(`S8 an unprojected tail is recovered only on the ${mode} copy`, async () => {
		if (mode === "imported") await seed();
		const project = await fixture(root, "tail", { unprojected: true });
		const before = sourceChecksums(project.sourcePath);
		const result = await run("S8", project);
		expect(result).toMatchObject({ outcome: mode, importedEvents: 35 });
		expect(
			query(
				daemonStorePath(configDir),
				"SELECT title FROM sessions WHERE id = 'ses_tail'",
			),
		).toEqual([{ title: "Unprojected tail" }]);
		expect(sourceChecksums(projectStoreBackup(project.sourcePath))).toEqual(
			before,
		);
		expect(
			query(
				projectStoreBackup(project.sourcePath),
				"SELECT title FROM sessions WHERE id = 'ses_tail'",
			),
		).toEqual([{ title: "Imported history" }]);
	});

	it(`S10 committed WAL frames through a symlink are included when ${mode}`, async () => {
		if (mode === "imported") await seed();
		const project = await fixture(root, "wal");
		const writer = new Database(project.sourcePath);
		try {
			writer.pragma("wal_autocheckpoint = 0");
			writer.exec("BEGIN; SELECT COUNT(*) FROM events");
			await append(project, "wal_only");
			writer.exec("COMMIT");
			expect(readFileSync(`${project.sourcePath}-wal`).length).toBeGreaterThan(
				0,
			);
			const before = sourceChecksums(project.sourcePath);
			const alias = join(root, "alias.db");
			symlinkSync(project.sourcePath, alias);
			expect(
				(await run("S10", { ...project, sourcePath: alias })).outcome,
			).toBe(mode);
			expect(
				query(
					daemonStorePath(configDir),
					"SELECT id FROM sessions WHERE id = 'wal_only'",
				),
			).toEqual([{ id: "wal_only" }]);
			expect(
				query(
					daemonStorePath(configDir),
					"SELECT source_path FROM daemon_store_imports WHERE project_id = 'wal'",
				),
			).toEqual([{ source_path: project.sourcePath }]);
			expect(sourceChecksums(projectStoreBackup(project.sourcePath))).toEqual(
				before,
			);
		} finally {
			writer.close();
		}
	});
}

it("S5 a known migration id with an unknown name is newer-schema", async () => {
	const project = await fixture(root, "renamed-ledger");
	edit(
		project.sourcePath,
		"UPDATE effect_sql_migrations SET name = 'future_replacement' WHERE migration_id = 60",
	);
	expect(await run("S5", project)).toMatchObject({
		outcome: "failed",
		error: { kind: "newer-schema" },
	});
});

const shared = [
	"ses_shared",
	"ses_shared_child",
	"ses_shared_deleted",
	"ses_shared_fork",
].sort();
it("C1 excludes a shared session from every populated scoped table and imports independent history", async () => {
	const owner = await fixture(root, "first", {
		sessionId: "ses_shared",
		large: true,
	});
	expect((await run("C1", owner)).outcome).toBe("seeded");
	const first = projectManifest(daemonStorePath(configDir), owner.projectId);
	const later = await fixture(root, "later", { sessionId: "ses_shared" });
	// References must also be followed when a dependent row has no matching session id.
	edit(
		later.sourcePath,
		"PRAGMA foreign_keys = OFF; UPDATE command_receipts SET session_id = 'receipt-only'; UPDATE provider_command_outbox SET session_id = 'outbox-only'; UPDATE tool_content SET tool_id = 'ses_shared_call', session_id = 'tool-only'; UPDATE projection_failures SET session_id = ''; UPDATE provider_command_tombstones SET session_id = NULL",
	);
	const scopedTables = [
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
		"provider_state",
		"tool_content",
		"sent_alerts",
		"projection_failures",
		"session_pick_backfill",
		"claude_runner_permission_replies",
	];
	const counts = storeTableCounts(later.sourcePath);
	for (const table of scopedTables)
		expect(counts[table], table).toBeGreaterThan(0);
	await append(later, "independent");
	const before = sourceChecksums(later.sourcePath);
	expect(await run("C1", later)).toMatchObject({
		outcome: "imported",
		importedEvents: 2,
		sharedSessions: shared,
	});
	expect(
		projectManifest(daemonStorePath(configDir), owner.projectId, first).tables,
	).toEqual(first.tables);
	expect(
		query(
			daemonStorePath(configDir),
			"SELECT id FROM sessions WHERE project_id = 'later'",
		),
	).toEqual([{ id: "independent" }]);
	for (const table of scopedTables.filter(
		(name) =>
			![
				"events",
				"sessions",
				"messages",
				"turns",
				"session_providers",
				"session_sidebar",
			].includes(name),
	)) {
		expect(storeTableCounts(daemonStorePath(configDir))[table], table).toBe(
			storeTableCounts(projectStoreBackup(owner.sourcePath))[table],
		);
	}
	expect(sourceChecksums(projectStoreBackup(later.sourcePath))).toEqual(before);
});

it("C2 a source containing only shared sessions imports zero events and gets a marker", async () => {
	const first = await fixture(root, "first", { sessionId: "ses_shared" });
	await run("C2", first);
	const later = await fixture(root, "later", { sessionId: "ses_shared" });
	expect(await run("C2", later)).toMatchObject({
		outcome: "imported",
		importedEvents: 0,
		sharedSessions: shared,
	});
	expect(
		query(
			daemonStorePath(configDir),
			"SELECT id FROM sessions WHERE project_id = 'later'",
		),
	).toEqual([]);
	expect(
		query(
			daemonStorePath(configDir),
			"SELECT project_id FROM daemon_store_imports ORDER BY project_id",
		),
	).toEqual([{ project_id: "first" }, { project_id: "later" }]);
});

it.each([
	"event",
	"command",
	"binding",
	"tombstone",
])("C3 an unrelated %s identity collision rolls back while later projects import", async (kind) => {
	await seed();
	const bad = await fixture(root, "collision");
	const db = new Database(daemonStorePath(configDir), { readonly: true });
	try {
		const identity = db
			.prepare(
				kind === "event"
					? "SELECT event_id AS id FROM events LIMIT 1"
					: kind === "command"
						? "SELECT command_id AS id FROM command_receipts LIMIT 1"
						: kind === "binding"
							? "SELECT id FROM session_providers LIMIT 1"
							: "SELECT id FROM messages LIMIT 1",
			)
			.get() as { id: string };
		const table =
			kind === "event"
				? "events"
				: kind === "command"
					? "provider_command_outbox"
					: kind === "binding"
						? "session_providers"
						: "message_tombstones";
		const field =
			kind === "event"
				? "event_id"
				: kind === "command"
					? "command_id"
					: kind === "binding"
						? "id"
						: "message_id";
		const source = new Database(bad.sourcePath);
		try {
			source
				.prepare(
					`UPDATE ${table} SET ${field} = ? WHERE rowid = (SELECT MIN(rowid) FROM ${table})`,
				)
				.run(identity.id);
		} finally {
			source.close();
		}
	} finally {
		db.close();
	}
	const before = daemonStoreManifest(daemonStorePath(configDir));
	const sourceBefore = sourceChecksums(bad.sourcePath);
	expect(await run("C3", bad)).toMatchObject({
		outcome: "failed",
		error: { kind: "collision" },
	});
	expect(daemonStoreManifest(daemonStorePath(configDir)).tables).toEqual(
		before.tables,
	);
	expect(sourceChecksums(bad.sourcePath)).toEqual(sourceBefore);
	noMarker(bad.projectId);
	const good = await fixture(root, "healthy");
	const results = await Effect.runPromise(
		importRegisteredProjectStores(configDir, [bad, good]),
	);
	expect(results.map((r) => r.outcome)).toEqual(["failed", "imported"]);
});

it("C4 fork and subagent children survive exclusion of their shared parent", async () => {
	const first = await fixture(root, "first", { sessionId: "ses_shared" });
	await run("C4", first);
	const later = await fixture(root, "later", { sessionId: "ses_shared" });
	await append(later, "unique_fork", "ses_shared", true);
	await append(later, "unique_child", "ses_shared");
	expect(await run("C4", later)).toMatchObject({
		outcome: "imported",
		sharedSessions: shared,
		importedEvents: 5,
	});
	expect(
		query(
			daemonStorePath(configDir),
			"SELECT c.id, c.parent_id, c.project_id, p.project_id AS parent_owner FROM sessions c JOIN sessions p ON p.id = c.parent_id WHERE c.project_id = 'later' ORDER BY c.id",
		),
	).toEqual([
		{
			id: "unique_child",
			parent_id: "ses_shared",
			project_id: "later",
			parent_owner: "first",
		},
		{
			id: "unique_fork",
			parent_id: "ses_shared",
			project_id: "later",
			parent_owner: "first",
		},
	]);
});

it("E1 a mid-transaction abort leaves the full manifest unchanged and the next project imports", async () => {
	await seed();
	const bad = await fixture(root, "blocked");
	const good = await fixture(root, "healthy");
	edit(
		daemonStorePath(configDir),
		"CREATE TRIGGER reject_blocked BEFORE INSERT ON messages WHEN NEW.session_id = 'ses_blocked' BEGIN SELECT RAISE(ABORT, 'simulated I/O failure'); END",
	);
	const before = daemonStoreManifest(daemonStorePath(configDir));
	const sourceBefore = sourceChecksums(bad.sourcePath);
	try {
		expect((await run("E1", bad)).outcome).toBe("failed");
		expect(daemonStoreManifest(daemonStorePath(configDir)).tables).toEqual(
			before.tables,
		);
		noMarker(bad.projectId);
		expect(sourceChecksums(bad.sourcePath)).toEqual(sourceBefore);
		const results = await Effect.runPromise(
			importRegisteredProjectStores(configDir, [bad, good]),
		);
		expect(results.map((r) => r.outcome)).toEqual(["failed", "imported"]);
		for (const result of results) record("E1", result);
	} finally {
		edit(daemonStorePath(configDir), "DROP TRIGGER reject_blocked");
	}
});

it("E4 the next largest store seeds after a failed seed, then imports keep registration order", async () => {
	const bad = await fixture(root, "largest", { large: true });
	edit(
		bad.sourcePath,
		"INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (9999, 'future_schema', '2026-01-01')",
	);
	const next = await fixture(root, "next", { large: true });
	// Inflate the rejected store above the viable seed without changing its schema.
	edit(
		bad.sourcePath,
		"UPDATE message_parts SET text = printf('%2000000s', '') WHERE type = 'text'",
	);
	const one = await fixture(root, "registered-first", {
		sessionId: "ses_shared",
	});
	const two = await fixture(root, "registered-second", {
		sessionId: "ses_shared",
	});
	const results = await Effect.runPromise(
		importRegisteredProjectStores(configDir, [two, bad, one, next]),
	);
	for (const result of results) record("E4", result);
	expect(results.map((r) => r.outcome)).toEqual([
		"imported",
		"failed",
		"imported",
		"seeded",
	]);
	expect(results[1]?.error?.kind).toBe("newer-schema");
	expect(results[2]?.sharedSessions).toEqual(shared);
	noMarker(bad.projectId);
	expect(
		query(
			daemonStorePath(configDir),
			"SELECT project_id FROM sessions WHERE id = 'ses_shared'",
		),
	).toEqual([{ project_id: "registered-second" }]);
});

it("R2 a repaired source imports on retry while healthy marked sources skip normalization", async () => {
	const good = await fixture(root, "healthy", { large: true });
	const bad = await fixture(root, "repair");
	edit(
		bad.sourcePath,
		"INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (9999, 'future_schema', '2026-01-01')",
	);
	const first = await Effect.runPromise(
		importRegisteredProjectStores(configDir, [bad, good]),
	);
	for (const result of first) record("R2", result);
	expect(first.map((r) => r.outcome)).toEqual(["failed", "seeded"]);
	noMarker(bad.projectId);
	edit(
		bad.sourcePath,
		"DELETE FROM effect_sql_migrations WHERE migration_id = 9999",
	);
	const normalised: string[] = [];
	const second = await Effect.runPromise(
		runDriver(configDir, [bad, good], {
			checkpoint: (name, projectId) => {
				if (name === "normalised") normalised.push(projectId);
			},
		}),
	);
	for (const result of second) record("R2", result);
	expect(second.map((r) => r.outcome)).toEqual(["imported", "skipped"]);
	expect(normalised).toEqual([bad.projectId]);
	const expected = projectManifest(
		projectStoreBackup(bad.sourcePath),
		bad.projectId,
	);
	expect(
		projectManifest(daemonStorePath(configDir), bad.projectId, expected).tables,
	).toEqual(expected.tables);
});

const completedAt = 1_792_108_800_000;
const runDriver = importRegisteredProjectStores;
const backupPath = (project: ProjectStoreSource) =>
	`${project.sourcePath}.imported-${completedAt}`;

function completedBackup(project: ProjectStoreSource, before: Buffer): void {
	expect(existsSync(project.sourcePath)).toBe(false);
	expect(readFileSync(backupPath(project))).toEqual(before);
	const prefix = `${basename(project.sourcePath)}.imported-`;
	expect(
		readdirSync(dirname(project.sourcePath)).filter(
			(name) =>
				name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)),
		),
	).toEqual([`${prefix}${completedAt}`]);
}

for (const mode of ["seeded", "imported"] as const) {
	it(`S9 a source changed at normalised is rejected before it is ${mode}, then retries`, async () => {
		if (mode === "imported") await seed();
		const project = await fixture(root, "changing");
		let writes = 0;
		const [changed] = await Effect.runPromise(
			runDriver(configDir, [project], {
				now: () => completedAt,
				checkpoint: (name, projectId) => {
					if (name === "normalised" && projectId === project.projectId) {
						writes++;
						edit(
							project.sourcePath,
							"UPDATE sessions SET title = 'Concurrent writer'",
						);
					}
				},
			}),
		);
		expect(writes).toBe(1);
		expect(changed).toMatchObject({ outcome: "source-changed" });
		noMarker(project.projectId);
		expect(existsSync(project.sourcePath)).toBe(true);
		if (changed) record("S9", changed);
		const beforeRetry = readFileSync(project.sourcePath);
		const [retried] = await Effect.runPromise(
			runDriver(configDir, [project], { now: () => completedAt }),
		);
		expect(retried).toMatchObject({
			outcome: mode,
			backup: backupPath(project),
		});
		completedBackup(project, beforeRetry);
		if (retried) record("S9", retried);
	});
}

const crashCases = [
	["K1", "normalised", "seed"],
	["K2", "seed-marked", "seed"],
	["K3", "seed-promoted", "seed"],
	["K4", "import-copied", "second"],
	["K5", "import-committed", "second"],
	["K6", "backup-sidecars", "second"],
] as const;
for (const [row, checkpoint, projectId] of crashCases) {
	it(`${row} recovers a SIGKILL at ${checkpoint} with one complete backup per source`, async () => {
		const projects = [
			await fixture(root, "seed", { large: true }),
			await fixture(root, "second"),
		] as const;
		if (checkpoint === "backup-sidecars") {
			const source = projects[1].sourcePath;
			const writer = new Database(source);
			let files: { suffix: string; bytes: Buffer }[];
			try {
				writer.pragma("wal_autocheckpoint = 0");
				writer.exec("UPDATE sessions SET title = 'Committed WAL history'");
				expect(readFileSync(`${source}-wal`).length).toBeGreaterThan(0);
				files = ["", "-wal", "-shm"].map((suffix) => ({
					suffix,
					bytes: readFileSync(`${source}${suffix}`),
				}));
			} finally {
				writer.close();
			}
			// Restore a valid crash snapshot with committed frames and no writer.
			for (const { suffix, bytes } of files)
				writeFileSync(`${source}${suffix}`, bytes);
		}
		// An empty rollback sidecar is valid and makes K6 a partial backup.
		for (const project of projects)
			writeFileSync(`${project.sourcePath}-journal`, "");
		const originals = projects.map((project) => ({
			project,
			bytes: readFileSync(project.sourcePath),
		}));
		const uninterrupted = join(root, "uninterrupted");
		mkdirSync(uninterrupted);
		const expected = await Effect.runPromise(
			runDriver(uninterrupted, projects, { now: () => completedAt }),
		);
		expect(expected.map((result) => result.outcome)).toEqual([
			"seeded",
			"imported",
		]);
		const expectedManifest = daemonStoreManifest(
			daemonStorePath(uninterrupted),
		);
		for (const { project, bytes } of originals) {
			completedBackup(project, bytes);
			for (const suffix of ["-wal", "-shm", "-journal", ""])
				if (existsSync(`${backupPath(project)}${suffix}`))
					renameSync(
						`${backupPath(project)}${suffix}`,
						`${project.sourcePath}${suffix}`,
					);
		}
		const child = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"test/helpers/daemon-store-import-crash-child.ts",
				JSON.stringify({
					configDir,
					projects,
					now: completedAt,
					checkpoint,
					projectId,
				}),
			],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				timeout: 25_000,
				maxBuffer: 64 * 1024,
			},
		);
		expect(child.error, child.stderr.slice(-4000)).toBeUndefined();
		expect(child.signal, child.stderr.slice(-4000)).toBe("SIGKILL");
		if (checkpoint === "backup-sidecars") {
			const second = projects[1];
			expect(existsSync(`${backupPath(second)}-wal`)).toBe(true);
			expect(existsSync(`${second.sourcePath}-wal`)).toBe(false);
			expect(existsSync(`${backupPath(second)}-journal`)).toBe(true);
			expect(existsSync(backupPath(second))).toBe(false);
			expect(existsSync(second.sourcePath)).toBe(true);
		}
		// K4 deliberately performs no parent read of the daemon store before rerun.
		const recovered = await Effect.runPromise(
			runDriver(configDir, projects, { now: () => completedAt }),
		);
		expect(
			recovered.every((result) => !result.error && !result.backupError),
		).toBe(true);
		expect(daemonStoreManifest(daemonStorePath(configDir)).hash).toBe(
			expectedManifest.hash,
		);
		for (const { project, bytes } of originals) completedBackup(project, bytes);
		expect(readdirSync(join(configDir, "daemon-store-import"))).toEqual([]);
		expect(
			readdirSync(configDir).filter((name) => name.includes(".tmp")),
		).toEqual([]);
		for (const result of recovered) record(row, result);
	});
}

it("K6 a link-then-unlink interruption finishes an identical-inode backup", async () => {
	const project = await fixture(root, "hard-link");
	const original = readFileSync(project.sourcePath);
	await Effect.runPromise(
		runDriver(configDir, [project], { now: () => completedAt }),
	);
	linkSync(backupPath(project), project.sourcePath);
	expect(statSync(project.sourcePath).ino).toBe(
		statSync(backupPath(project)).ino,
	);
	const [result] = await Effect.runPromise(
		runDriver(configDir, [project], { now: () => completedAt }),
	);
	expect(result).toMatchObject({
		outcome: "skipped",
		backup: backupPath(project),
	});
	expect(result?.backupError).toBeUndefined();
	completedBackup(project, original);
	if (result) record("K6", result);
});

it("E2 removes only stale import scratch and UUID seed temps before touching projects", async () => {
	const project = await fixture(root, "preserved");
	const original = readFileSync(project.sourcePath);
	await Effect.runPromise(
		runDriver(configDir, [project], { now: () => completedAt }),
	);
	const daemon = daemonStorePath(configDir);
	const daemonBefore = readFileSync(daemon);
	// Restore the source to prove cleanup itself preserves registered sources.
	renameSync(backupPath(project), project.sourcePath);
	const scratch = join(configDir, "daemon-store-import");
	mkdirSync(join(scratch, "old-nested"), { recursive: true });
	writeFileSync(join(scratch, "old.db"), "stale copy");
	writeFileSync(join(scratch, "old-nested", "leftover"), "stale nested file");
	const stale = `${daemon}.${randomUUID()}.tmp`;
	for (const suffix of ["", "-wal", "-shm", "-journal"])
		writeFileSync(`${stale}${suffix}`, "stale seed");
	const keep = [
		`${daemon}.not-a-uuid.tmp`,
		`${daemon}.${randomUUID()}.tmp.extra`,
		join(configDir, "other.tmp"),
	];
	for (const filename of keep) writeFileSync(filename, "keep");
	const [result] = await Effect.runPromise(
		runDriver(configDir, [project], { now: () => completedAt }),
	);
	expect(result?.outcome).toBe("skipped");
	expect(readFileSync(daemon)).toEqual(daemonBefore);
	completedBackup(project, original);
	for (const suffix of ["", "-wal", "-shm", "-journal"])
		expect(existsSync(`${stale}${suffix}`)).toBe(false);
	for (const filename of keep)
		expect(readFileSync(filename, "utf8")).toBe("keep");
	expect(readdirSync(scratch)).toEqual([]);
	if (result) record("E2", result);
});

it.each([
	"",
	"-wal",
	"-shm",
	"-journal",
])("E3 an existing %s backup target moves nothing after committing the import", async (suffix) => {
	const project = await fixture(root, "blocked-backup");
	writeFileSync(`${project.sourcePath}-journal`, "");
	const original = readFileSync(project.sourcePath);
	const target = `${backupPath(project)}${suffix}`;
	writeFileSync(target, "existing backup bytes");
	const [result] = await Effect.runPromise(
		runDriver(configDir, [project], { now: () => completedAt }),
	);
	expect(result).toMatchObject({
		outcome: "seeded",
		backupError: { kind: "io" },
	});
	expect(result?.backup).toBeUndefined();
	expect(readFileSync(project.sourcePath)).toEqual(original);
	expect(existsSync(`${project.sourcePath}-journal`)).toBe(true);
	expect(readFileSync(target, "utf8")).toBe("existing backup bytes");
	for (const other of ["", "-wal", "-shm", "-journal"].filter(
		(item) => item !== suffix,
	))
		expect(existsSync(`${backupPath(project)}${other}`)).toBe(false);
	expect(
		query(
			daemonStorePath(configDir),
			"SELECT project_id, completed_at FROM daemon_store_imports",
		),
	).toEqual([{ project_id: project.projectId, completed_at: completedAt }]);
	expect(
		readFileSync(join(configDir, "daemon-store-import-report.txt"), "utf8"),
	).toContain("backup failed:");
	if (result) record("E3", result);
});

it.each([
	"scratch",
	"legacy-seed-temp",
])("E2 preserves a registered source matching the %s cleanup pattern", async (location) => {
	const project = await fixture(root, "registered-source");
	await Effect.runPromise(
		runDriver(configDir, [project], { now: () => completedAt }),
	);
	const original = readFileSync(backupPath(project));
	const sourcePath =
		location === "scratch"
			? join(configDir, "daemon-store-import", "registered.db")
			: `${daemonStorePath(configDir)}.${randomUUID()}.tmp`;
	copyFileSync(backupPath(project), sourcePath);
	const daemonBefore = readFileSync(daemonStorePath(configDir));
	try {
		const [result] = await Effect.runPromise(
			runDriver(configDir, [{ ...project, sourcePath }], {
				now: () => completedAt,
			}),
		);
		expect(result?.outcome).toBe("source-changed");
		expect(readFileSync(sourcePath)).toEqual(original);
		expect(readFileSync(daemonStorePath(configDir))).toEqual(daemonBefore);
		if (result) record("E2", result);
	} finally {
		rmSync(sourcePath, { force: true });
	}
});

it.each([
	"-wal",
	"-shm",
	"-journal",
])("E3 an unrelated %s backup target stays blocked on a marked rerun", async (suffix) => {
	const project = await fixture(root, "blocked-sidecar-retry");
	const original = readFileSync(project.sourcePath);
	expect(existsSync(`${project.sourcePath}${suffix}`)).toBe(false);
	expect(existsSync(`${project.sourcePath}-journal`)).toBe(false);
	const target = `${backupPath(project)}${suffix}`;
	writeFileSync(target, "unrelated nonempty backup sidecar");
	const [first] = await Effect.runPromise(
		runDriver(configDir, [project], { now: () => completedAt }),
	);
	expect(first).toMatchObject({
		outcome: "seeded",
		backupError: { kind: "io" },
	});
	const [second] = await Effect.runPromise(
		runDriver(configDir, [project], { now: () => completedAt }),
	);
	expect(second).toMatchObject({
		outcome: "skipped",
		backupError: { kind: "io" },
	});
	expect(second?.backup).toBeUndefined();
	expect(readFileSync(project.sourcePath)).toEqual(original);
	expect(readFileSync(target, "utf8")).toBe(
		"unrelated nonempty backup sidecar",
	);
	expect(existsSync(`${project.sourcePath}${suffix}`)).toBe(false);
	expect(existsSync(backupPath(project))).toBe(false);
	if (first) record("E3", first);
	if (second) record("E3", second);
});

it("E2 preserves a completed canonical backup after its outside source alias dangles", async () => {
	const project = await fixture(root, "aliased-source");
	const original = readFileSync(project.sourcePath);
	const scratch = join(realpathSync(configDir), "daemon-store-import");
	mkdirSync(scratch, { recursive: true });
	const canonical = join(scratch, "registered.db");
	renameSync(project.sourcePath, canonical);
	const alias = join(root, "outside-source-alias.db");
	symlinkSync(canonical, alias);
	const registered = { ...project, sourcePath: alias };
	const backup = `${canonical}.imported-${completedAt}`;
	try {
		const [first] = await Effect.runPromise(
			runDriver(configDir, [registered], { now: () => completedAt }),
		);
		expect(first).toMatchObject({ outcome: "seeded", backup });
		expect(readFileSync(backup)).toEqual(original);
		expect(existsSync(alias)).toBe(false);
		const [second] = await Effect.runPromise(
			runDriver(configDir, [registered], { now: () => completedAt }),
		);
		expect(second?.outcome).toBe("skipped");
		expect(readFileSync(backup)).toEqual(original);
		if (first) record("E2", first);
		if (second) record("E2", second);
	} finally {
		for (const source of [canonical, backup])
			for (const suffix of ["", "-wal", "-shm", "-journal"])
				rmSync(`${source}${suffix}`, { force: true });
	}
});

it("R1 a successful rerun skips every project and preserves daemon and report bytes and mtime", async () => {
	const projects = [
		await fixture(root, "first", { large: true }),
		await fixture(root, "second"),
	];
	await Effect.runPromise(
		runDriver(configDir, projects, { now: () => completedAt }),
	);
	const daemonBefore = readFileSync(daemonStorePath(configDir));
	const report = join(configDir, "daemon-store-import-report.txt");
	const reportBefore = readFileSync(report);
	const mtime = statSync(report).mtimeMs;
	const results = await Effect.runPromise(
		runDriver(configDir, projects, { now: () => completedAt + 1000 }),
	);
	expect(results.map((result) => result.outcome)).toEqual([
		"skipped",
		"skipped",
	]);
	expect(results.every((result) => !result.backup && !result.backupError)).toBe(
		true,
	);
	expect(readFileSync(daemonStorePath(configDir))).toEqual(daemonBefore);
	expect(readFileSync(report)).toEqual(reportBefore);
	expect(statSync(report).mtimeMs).toBe(mtime);
	for (const result of results) record("R1", result);
});

it("R3 a fresh source after a completed backup is source-changed and left untouched", async () => {
	const project = await fixture(root, "recreated");
	await Effect.runPromise(
		runDriver(configDir, [project], { now: () => completedAt }),
	);
	const backupBefore = readFileSync(backupPath(project));
	await fixture(root, "recreated");
	await append(project, "fresh-session");
	const freshBefore = sourceChecksums(project.sourcePath);
	const manifestBefore = daemonStoreManifest(daemonStorePath(configDir)).hash;
	const [result] = await Effect.runPromise(
		runDriver(configDir, [project], { now: () => completedAt + 1000 }),
	);
	expect(result?.outcome).toBe("source-changed");
	expect(result?.backup).toBeUndefined();
	expect(sourceChecksums(project.sourcePath)).toEqual(freshBefore);
	expect(readFileSync(backupPath(project))).toEqual(backupBefore);
	expect(daemonStoreManifest(daemonStorePath(configDir)).hash).toBe(
		manifestBefore,
	);
	expect(
		readFileSync(join(configDir, "daemon-store-import-report.txt"), "utf8"),
	).toContain("recreated: source-changed");
	if (result) record("R3", result);
});

it("R1 report formatter preserves registration order and exact optional fields", () => {
	const error = new DaemonStoreImportError({
		projectId: "bad",
		kind: "corrupt",
		message: "invalid database",
	});
	const backupError = new DaemonStoreImportError({
		projectId: "copy",
		kind: "io",
		message: "target exists",
	});
	expect(
		formatDaemonStoreImportReport(
			[
				{
					projectId: "copy",
					outcome: "imported",
					importedEvents: 0,
					sharedSessions: ["session-a", "session-b"],
					backupError,
				},
				{
					projectId: "seed",
					outcome: "seeded",
					importedEvents: 34,
					sharedSessions: [],
					backup: "/data/events.db.imported-123",
				},
				{ projectId: "bad", outcome: "failed", error },
				{ projectId: "missing", outcome: "absent" },
				{ projectId: "done", outcome: "skipped" },
			],
			0,
		),
	).toBe(
		"Daemon store import 1970-01-01T00:00:00.000Z\n" +
			"copy: imported, 0 events, shared sessions left out: session-a,session-b, backup failed: target exists\n" +
			"seed: seeded, 34 events, backup /data/events.db.imported-123\n" +
			"bad: failed, error corrupt: invalid database\n" +
			"missing: absent\n" +
			"done: skipped\n",
	);
});

it("C2 a literal byte copy keeps its first owner's sessions and imports zero events", async () => {
	const owner = await fixture(root, "original", { sessionId: "ses_shared" });
	const copied = {
		projectId: "copied",
		sourcePath: join(realpathSync(root), "copied.db"),
	};
	copyFileSync(owner.sourcePath, copied.sourcePath);
	const original = readFileSync(copied.sourcePath);
	await Effect.runPromise(
		runDriver(configDir, [owner], { now: () => completedAt }),
	);
	const [result] = await Effect.runPromise(
		runDriver(configDir, [copied], { now: () => completedAt }),
	);
	expect(result).toMatchObject({
		outcome: "imported",
		importedEvents: 0,
		sharedSessions: shared,
		backup: backupPath(copied),
	});
	completedBackup(copied, original);
	expect(
		query(
			daemonStorePath(configDir),
			"SELECT project_id FROM sessions WHERE id = 'ses_shared'",
		),
	).toEqual([{ project_id: "original" }]);
	if (result) record("C2", result);
});

it.each([
	"claude_runner_cursors",
	"session_git_published",
])("C3 a fully shared byte copy with differing %s content still collides", async (table) => {
	const owner = await fixture(root, "original", { sessionId: "ses_shared" });
	const copied = { projectId: "copied", sourcePath: join(root, "copied.db") };
	copyFileSync(owner.sourcePath, copied.sourcePath);
	edit(
		copied.sourcePath,
		table === "claude_runner_cursors"
			? "UPDATE claude_runner_cursors SET result_json = '{\"changed\":true}'"
			: 'UPDATE session_git_published SET git = \'{"branch":"changed"}\'',
	);
	await Effect.runPromise(
		runDriver(configDir, [owner], { now: () => completedAt }),
	);
	const manifestBefore = daemonStoreManifest(daemonStorePath(configDir)).hash;
	const sourceBefore = sourceChecksums(copied.sourcePath);
	const [result] = await Effect.runPromise(
		runDriver(configDir, [copied], { now: () => completedAt }),
	);
	expect(result).toMatchObject({
		outcome: "failed",
		error: { kind: "collision" },
	});
	expect(daemonStoreManifest(daemonStorePath(configDir)).hash).toBe(
		manifestBefore,
	);
	expect(sourceChecksums(copied.sourcePath)).toEqual(sourceBefore);
	noMarker(copied.projectId);
	if (result) record("C3", result);
});

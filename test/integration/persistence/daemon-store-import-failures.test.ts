import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
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
		expect(sourceChecksums(project.sourcePath)).toEqual(before);
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
		expect(sourceChecksums(project.sourcePath)).toEqual(before);
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
		expect(sourceChecksums(project.sourcePath)).toEqual(before);
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
		expect(sourceChecksums(project.sourcePath)).toEqual(before);
		expect(
			query(
				project.sourcePath,
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
			expect(sourceChecksums(project.sourcePath)).toEqual(before);
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
			storeTableCounts(owner.sourcePath)[table],
		);
	}
	expect(sourceChecksums(later.sourcePath)).toEqual(before);
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
	// A marker is checked before the hot-journal guard or any copy/migration.
	writeFileSync(
		`${good.sourcePath}-journal`,
		"do not normalize a marked source",
	);
	const second = await Effect.runPromise(
		importRegisteredProjectStores(configDir, [bad, good]),
	);
	for (const result of second) record("R2", result);
	expect(second.map((r) => r.outcome)).toEqual(["imported", "skipped"]);
	const expected = projectManifest(bad.sourcePath, bad.projectId);
	expect(
		projectManifest(daemonStorePath(configDir), bad.projectId, expected).tables,
	).toEqual(expected.tables);
});

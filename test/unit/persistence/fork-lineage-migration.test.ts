import fs, {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import Database from "better-sqlite3";
import { Effect, Either, Layer } from "effect";
import { expect, it, vi } from "vitest";
import {
	defaultDaemonConfig,
	loadDaemonConfigResult,
} from "../../../src/lib/daemon/config-persistence.js";
import { serializeRecent } from "../../../src/lib/daemon/recent-projects.js";
import {
	effectMigrationEntries,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import { refreshSidebar } from "../../../src/lib/persistence/effect/sidebar-projection.js";
import { migrateForkLineage } from "../../../src/lib/persistence/migrations/fork-lineage-import.js";
import { projectStorageDir } from "../../../src/lib/persistence/project-storage.js";

const migrateWithConfig = (dir: string) =>
	Effect.gen(function* () {
		const loaded = loadDaemonConfigResult(dir);
		const config = yield* Either.isLeft(loaded) &&
		loaded.left._tag === "NotFound"
			? Effect.succeed(defaultDaemonConfig())
			: loaded;
		return yield* migrateForkLineage(dir, config);
	});

function makePersistenceEffectLayer(filename: string, lineage = false) {
	const sqlite = SqliteNode.layer({ filename }).pipe(
		Layer.provide(Reactivity.layer),
	);
	return Layer.merge(
		sqlite,
		Layer.effectDiscard(
			makeEffectSqlMigrator(
				lineage
					? effectMigrationEntries
					: Object.fromEntries(
							Object.entries(effectMigrationEntries).filter(
								([key]) => key < "0059_sessions_lineage",
							),
						),
			),
		).pipe(Layer.provide(sqlite)),
	);
}

it.each([
	false,
	true,
])("imports sidecar lineage and keeps Forks top-level, legacy containment: %s", async (contained) => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-lineage-"));
	const project = join(dir, "project");
	const filename = join(projectStorageDir(dir, "project"), "events.db");
	const sidecar = join(dir, "fork-metadata.json");
	try {
		mkdirSync(project, { recursive: true });
		mkdirSync(projectStorageDir(dir, "project"), { recursive: true });
		writeFileSync(
			join(dir, "recent.json"),
			serializeRecent([{ directory: project, slug: "project", lastUsed: 1 }]),
		);
		const entry = JSON.stringify({
			child: { parentID: "parent", forkMessageId: "boundary" },
			side: { parentID: "parent", forkMessageId: "boundary" },
		});
		writeFileSync(sidecar, entry);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, parent_id, side_thread, root_id, created_at, updated_at)
					VALUES ('parent', 'opencode', NULL, 0, 'parent', 1, 1),
					('child', 'opencode', ${contained ? "parent" : null}, 0, ${contained ? "parent" : "child"}, 1, 1),
					('agent', 'opencode', 'child', 0, ${contained ? "parent" : "child"}, 1, 1),
					('side', 'opencode', 'parent', 1, 'parent', 1, 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, created_at, updated_at)
					VALUES ('boundary', 'parent', 'assistant', 200, 200)`;
				yield* refreshSidebar(["parent", "child"], 0);
				// The importer runs before project migrations during an upgrade.
				yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 60`;
			}).pipe(Effect.provide(makePersistenceEffectLayer(filename, true))),
		);
		await Effect.runPromise(migrateWithConfig(dir));
		const snapshot = () =>
			Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					expect(
						yield* sql`SELECT parent_id, forked_from, root_id,
						fork_point_event, fork_point_timestamp, fork_point_message_id
						FROM sessions WHERE id = 'child'`,
					).toEqual([
						{
							parent_id: null,
							forked_from: "parent",
							root_id: "child",
							fork_point_event: "boundary",
							fork_point_timestamp: 200,
							fork_point_message_id: "boundary",
						},
					]);
					expect(
						yield* sql`SELECT parent_id, forked_from, side_thread, root_id FROM sessions WHERE id = 'side'`,
					).toEqual([
						{
							parent_id: "parent",
							forked_from: "parent",
							side_thread: 1,
							root_id: "parent",
						},
					]);
					const [child] = yield* sql<{
						version: number;
					}>`SELECT version FROM sessions WHERE id = 'child'`;
					expect(child?.version).toBeGreaterThan(0);
					expect(
						yield* sql`SELECT root_id, version FROM sessions WHERE id = 'agent'`,
					).toEqual([
						{ root_id: "child", version: contained ? child?.version : 0 },
					]);
					return {
						sessions: yield* sql`SELECT * FROM sessions ORDER BY id`,
						sidebar:
							yield* sql`SELECT * FROM session_sidebar ORDER BY session_id`,
						counter: yield* sql`SELECT * FROM read_model_counter`,
					};
				}).pipe(Effect.provide(makePersistenceEffectLayer(filename, true))),
			);
		const imported = await snapshot();
		expect(existsSync(sidecar)).toBe(false);
		writeFileSync(sidecar, entry);
		await Effect.runPromise(migrateWithConfig(dir));
		expect(await snapshot()).toEqual(imported);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each([
	"publish",
	"delete",
	"file failure",
	"directory failure",
	"unsupported directory",
])("makes archive changes durable before removing the source: %s", async (scenario) => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-durable-"));
	const sidecar = join(dir, "fork-metadata.json");
	const archive = join(dir, "fork-metadata-unresolved.json");
	const operations: string[] = [];
	const sync = fs.fsyncSync;
	const rename = fs.renameSync;
	const unlink = fs.unlinkSync;
	try {
		writeFileSync(
			sidecar,
			scenario === "delete" ? "{}" : '{"child":"message"}',
		);
		if (scenario === "delete") writeFileSync(archive, "{}");
		vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			const kind = fs.fstatSync(fd).isDirectory() ? "directory" : "file";
			operations.push(`sync ${kind}`);
			if (scenario === `${kind} failure`) throw new Error("disk failure");
			if (kind === "directory" && scenario === "unsupported directory") {
				throw Object.assign(new Error("unsupported"), { code: "EINVAL" });
			}
			sync(fd);
		});
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			operations.push("rename");
			rename(from, to);
		});
		vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
			if (path === sidecar) operations.push("remove source");
			if (path === archive) operations.push("remove archive");
			unlink(path);
		});
		syncBuiltinESMExports();
		await Effect.runPromise(migrateWithConfig(dir));
		const expected =
			scenario === "delete"
				? ["remove archive", "sync directory", "remove source"]
				: scenario === "file failure"
					? ["sync file"]
					: scenario === "directory failure"
						? ["sync file", "rename", "sync directory"]
						: ["sync file", "rename", "sync directory", "remove source"];
		expect(operations).toEqual(expected);
		expect(existsSync(sidecar)).toBe(scenario.endsWith("failure"));
	} finally {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("repairs an archived boundary whose event is present but timestamp is missing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-repair-"));
	const project = join(dir, "project");
	const filename = join(projectStorageDir(dir, "project"), "events.db");
	const archive = join(dir, "fork-metadata-unresolved.json");
	try {
		mkdirSync(project, { recursive: true });
		mkdirSync(projectStorageDir(dir, "project"), { recursive: true });
		writeFileSync(
			join(dir, "recent.json"),
			serializeRecent([{ directory: project, slug: "project", lastUsed: 1 }]),
		);
		writeFileSync(
			archive,
			JSON.stringify({
				child: { parentID: "parent", forkMessageId: "boundary" },
			}),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('parent', 'opencode', 1, 1), ('child', 'opencode', 1, 1)`;
				yield* sql`UPDATE sessions SET parent_id = 'parent', fork_point_event = 'boundary' WHERE id = 'child'`;
				yield* sql`INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES ('boundary', 'parent', 'assistant', 200, 200)`;
			}).pipe(Effect.provide(makePersistenceEffectLayer(filename))),
		);
		await Effect.runPromise(migrateWithConfig(dir));
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT parent_id, fork_point_event, fork_point_timestamp,
				fork_point_message_id FROM sessions WHERE id = 'child'`,
				).toEqual([
					{
						parent_id: "parent",
						fork_point_event: "boundary",
						fork_point_timestamp: 200,
						fork_point_message_id: "boundary",
					},
				]);
			}).pipe(Effect.provide(makePersistenceEffectLayer(filename))),
		);
		expect(existsSync(archive)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("an interrupted archive write leaves no partial archive and can be retried", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-atomic-"));
	const sidecar = join(dir, "fork-metadata.json");
	const archive = join(dir, "fork-metadata-unresolved.json");
	const contents = JSON.stringify({ child: "message" });
	try {
		writeFileSync(sidecar, contents);
		const write = fs.writeFileSync;
		const interrupted = vi
			.spyOn(fs, "writeFileSync")
			.mockImplementationOnce((path) => {
				write(path, "{", { flag: "wx" });
				throw new Error("interrupted archive write");
			});
		syncBuiltinESMExports();
		try {
			await Effect.runPromise(migrateWithConfig(dir));
		} finally {
			interrupted.mockRestore();
			syncBuiltinESMExports();
		}
		expect(existsSync(archive)).toBe(false);
		expect(fs.readdirSync(dir)).toEqual(["fork-metadata.json"]);
		expect(readFileSync(sidecar, "utf8")).toBe(contents);
		await Effect.runPromise(migrateWithConfig(dir));
		expect(readFileSync(archive, "utf8")).toBe(contents);
		expect(existsSync(sidecar)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("refuses to overwrite a different archive appearing before publication", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-conflict-"));
	const sidecar = join(dir, "fork-metadata.json");
	const archive = join(dir, "fork-metadata-unresolved.json");
	const contents = JSON.stringify({ child: "message" });
	const other = JSON.stringify({ other: "other-message" });
	try {
		writeFileSync(sidecar, contents);
		const write = fs.writeFileSync;
		const concurrentWrite = vi
			.spyOn(fs, "writeFileSync")
			.mockImplementationOnce((path, data, options) => {
				write(path, data, options);
				write(archive, other);
			});
		syncBuiltinESMExports();
		try {
			await Effect.runPromise(migrateWithConfig(dir));
		} finally {
			concurrentWrite.mockRestore();
			syncBuiltinESMExports();
		}
		expect(readFileSync(archive, "utf8")).toBe(other);
		expect(readFileSync(sidecar, "utf8")).toBe(contents);
		expect(fs.readdirSync(dir).sort()).toEqual([
			"fork-metadata-unresolved.json",
			"fork-metadata.json",
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("retains both sources when they contain conflicting lineage for the same session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-conflicting-entry-"));
	const sidecar = join(dir, "fork-metadata.json");
	const archive = join(dir, "fork-metadata-unresolved.json");
	const contents = JSON.stringify({ child: "message" });
	const other = JSON.stringify({ child: "other-message" });
	try {
		writeFileSync(sidecar, contents);
		writeFileSync(archive, other);
		await Effect.runPromise(migrateWithConfig(dir));
		expect(readFileSync(archive, "utf8")).toBe(other);
		expect(readFileSync(sidecar, "utf8")).toBe(contents);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("imports all known projects before deleting the sidecar, without appending history", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-"));
	const projects = [join(dir, "a"), join(dir, "b")];
	const sidecar = join(dir, "fork-metadata.json");
	try {
		writeFileSync(
			join(dir, "recent.json"),
			serializeRecent(
				projects.map((directory, i) => ({
					directory,
					slug: String(i),
					lastUsed: 1,
				})),
			),
		);
		writeFileSync(
			sidecar,
			JSON.stringify({
				"child-0": {
					parentID: "parent-0",
					forkMessageId: "message-0",
					forkPointTimestamp: 100,
				},
				"child-1": { parentID: "parent-1", forkMessageId: "message-1" },
			}),
		);
		for (const [i, project] of projects.entries()) {
			mkdirSync(project, { recursive: true });
			mkdirSync(projectStorageDir(dir, String(i)), { recursive: true });
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					for (const id of [`parent-${i}`, `child-${i}`]) {
						yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at) VALUES (${id}, 'claude', 'Kept', 100, 100)`;
					}
					yield* sql`INSERT INTO messages (id, session_id, role, text, created_at, updated_at)
						VALUES (${`message-${i}`}, ${`parent-${i}`}, 'assistant', 'answer', 100, 100)`;
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(
							join(projectStorageDir(dir, String(i)), "events.db"),
						),
					),
				),
			);
		}
		const prepared = vi.spyOn(Database.prototype, "prepare");
		try {
			await Effect.runPromise(migrateWithConfig(dir));
			expect(
				prepared.mock.calls.filter(([query]) =>
					/SELECT id, parent_id, fork_point_event FROM sessions\s+WHERE id IN/.test(
						query,
					),
				),
			).toHaveLength(2);
		} finally {
			prepared.mockRestore();
		}
		for (const [i] of projects.entries()) {
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					expect(
						yield* sql`SELECT parent_id, fork_point_event, fork_point_timestamp,
					fork_point_message_id FROM sessions WHERE id = ${`child-${i}`}`,
					).toEqual([
						{
							parent_id: `parent-${i}`,
							fork_point_event: `message-${i}`,
							fork_point_timestamp: 100,
							fork_point_message_id: `message-${i}`,
						},
					]);
					expect(yield* sql`SELECT count(*) AS count FROM events`).toEqual([
						{ count: 0 },
					]);
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(
							join(projectStorageDir(dir, String(i)), "events.db"),
						),
					),
				),
			);
		}
		expect(existsSync(sidecar)).toBe(false);
		const clean = vi.spyOn(Database.prototype, "prepare");
		try {
			await Effect.runPromise(migrateWithConfig(dir));
			expect(clean).not.toHaveBeenCalled();
		} finally {
			clean.mockRestore();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const kind of [
	"missing",
	"unreadable",
	"malformed",
	"invalid entry",
] as const) {
	it(`startup survives a ${kind} sidecar without discarding its contents`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "fork-migration-invalid-"));
		const path = join(dir, "fork-metadata.json");
		const contents =
			kind === "malformed"
				? "{"
				: kind === "invalid entry"
					? JSON.stringify({ child: { parentID: 1, forkMessageId: "point" } })
					: JSON.stringify({
							child: { parentID: "parent", forkMessageId: "point" },
						});
		try {
			if (kind === "unreadable") mkdirSync(path);
			else if (kind !== "missing") writeFileSync(path, contents);
			await Effect.runPromise(migrateWithConfig(dir));
			expect(existsSync(path)).toBe(kind !== "missing");
			if (kind !== "missing" && kind !== "unreadable")
				expect(readFileSync(path, "utf8")).toBe(contents);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

it("retrying an incomplete import does not advance an already imported session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-retry-"));
	const project = join(dir, "project");
	const filename = join(projectStorageDir(dir, "project"), "events.db");
	try {
		mkdirSync(project, { recursive: true });
		mkdirSync(projectStorageDir(dir, "project"), { recursive: true });
		writeFileSync(
			join(dir, "recent.json"),
			serializeRecent([
				{ directory: project, slug: "project", lastUsed: 1 },
				{ directory: join(dir, "broken"), slug: "broken", lastUsed: 1 },
			]),
		);
		mkdirSync(join(dir, "broken"), { recursive: true });
		mkdirSync(projectStorageDir(dir, "broken"), { recursive: true });
		writeFileSync(
			join(projectStorageDir(dir, "broken"), "events.db"),
			"not a database",
		);
		writeFileSync(
			join(dir, "fork-metadata.json"),
			JSON.stringify({
				child: { parentID: "parent", forkMessageId: "message" },
				unavailable: { parentID: "other", forkMessageId: "other-message" },
			}),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('parent', 'claude', 1, 1), ('child', 'claude', 1, 1)`;
			}).pipe(Effect.provide(makePersistenceEffectLayer(filename))),
		);
		await Effect.runPromise(migrateWithConfig(dir));
		const snapshot = () =>
			Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return yield* sql`SELECT id, parent_id, fork_point_event, version FROM sessions ORDER BY id`;
				}).pipe(Effect.provide(makePersistenceEffectLayer(filename))),
			);
		const first = await snapshot();
		await Effect.runPromise(migrateWithConfig(dir));
		expect(await snapshot()).toEqual(first);
		expect(existsSync(join(dir, "fork-metadata.json"))).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("retires unmatched lineage to a startup archive instead of keeping the active sidecar", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-unmatched-"));
	const path = join(dir, "fork-metadata.json");
	const contents = { gone: { parentID: "parent", forkMessageId: "message" } };
	try {
		writeFileSync(path, JSON.stringify(contents));
		await Effect.runPromise(migrateWithConfig(dir));
		expect(existsSync(path)).toBe(false);
		expect(
			JSON.parse(
				readFileSync(join(dir, "fork-metadata-unresolved.json"), "utf8"),
			),
		).toEqual(contents);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("retries archived lineage when an unavailable project returns and merges live entries", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-returning-"));
	const project = join(dir, "project");
	const filename = join(projectStorageDir(dir, "project"), "events.db");
	const sidecar = join(dir, "fork-metadata.json");
	const archive = join(dir, "fork-metadata-unresolved.json");
	try {
		writeFileSync(
			join(dir, "recent.json"),
			serializeRecent([{ directory: project, slug: "project", lastUsed: 1 }]),
		);
		writeFileSync(
			sidecar,
			JSON.stringify({ child: { parentID: "parent", forkMessageId: "point" } }),
		);
		await Effect.runPromise(migrateWithConfig(dir));
		expect(existsSync(sidecar)).toBe(false);
		writeFileSync(
			sidecar,
			JSON.stringify({ later: { parentID: "parent", forkMessageId: "point" } }),
		);
		mkdirSync(project, { recursive: true });
		mkdirSync(projectStorageDir(dir, "project"), { recursive: true });
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('parent', 'opencode', 1, 1), ('child', 'opencode', 1, 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, text, created_at, updated_at) VALUES ('point', 'parent', 'assistant', 'answer', 100, 100)`;
			}).pipe(Effect.provide(makePersistenceEffectLayer(filename))),
		);
		await Effect.runPromise(migrateWithConfig(dir));
		expect(existsSync(sidecar)).toBe(false);
		expect(JSON.parse(readFileSync(archive, "utf8"))).toEqual({
			later: { parentID: "parent", forkMessageId: "point" },
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT parent_id, fork_point_event, fork_point_timestamp, fork_point_message_id FROM sessions WHERE id = 'child'`,
				).toEqual([
					{
						parent_id: "parent",
						fork_point_event: "point",
						fork_point_timestamp: 100,
						fork_point_message_id: "point",
					},
				]);
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('later', 'opencode', 1, 1)`;
			}).pipe(Effect.provide(makePersistenceEffectLayer(filename))),
		);
		await Effect.runPromise(migrateWithConfig(dir));
		expect(existsSync(archive)).toBe(false);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT parent_id, fork_point_event FROM sessions WHERE id = 'later'`,
				).toEqual([{ parent_id: "parent", fork_point_event: "point" }]);
			}).pipe(Effect.provide(makePersistenceEffectLayer(filename))),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

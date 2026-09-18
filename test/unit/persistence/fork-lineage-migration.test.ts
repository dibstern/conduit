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
import { SqlClient } from "@effect/sql";
import { Effect, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { serializeRecent } from "../../../src/lib/daemon/recent-projects.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { subscribeShell } from "../../../src/lib/domain/relay/Services/shell-subscription.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { migrateForkLineage } from "../../../src/lib/persistence/migrations/fork-lineage-import.js";

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
		await Effect.runPromise(migrateForkLineage(dir));
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
	const filename = join(project, ".conduit", "events.db");
	const archive = join(dir, "fork-metadata-unresolved.json");
	try {
		mkdirSync(join(project, ".conduit"), { recursive: true });
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
		await Effect.runPromise(migrateForkLineage(dir));
		await Effect.runPromise(
			Effect.gen(function* () {
				const envelope = yield* Stream.runHead(subscribeShell({}));
				if (envelope._tag !== "Some" || envelope.value._tag !== "snapshot")
					throw new Error("expected snapshot");
				expect(envelope.value.rows).toContainEqual(
					expect.objectContaining({
						id: "child",
						parentID: "parent",
						forkMessageId: "boundary",
						forkPointTimestamp: 200,
						forkPointMessageId: "boundary",
					}),
				);
			}).pipe(
				Effect.provide(
					Layer.merge(
						makePersistenceEffectLayer(filename),
						SessionEventBusLive,
					),
				),
			),
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
			await Effect.runPromise(migrateForkLineage(dir));
		} finally {
			interrupted.mockRestore();
			syncBuiltinESMExports();
		}
		expect(existsSync(archive)).toBe(false);
		expect(fs.readdirSync(dir)).toEqual(["fork-metadata.json"]);
		expect(readFileSync(sidecar, "utf8")).toBe(contents);
		await Effect.runPromise(migrateForkLineage(dir));
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
			await Effect.runPromise(migrateForkLineage(dir));
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
		await Effect.runPromise(migrateForkLineage(dir));
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
			mkdirSync(join(project, ".conduit"), { recursive: true });
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
						makePersistenceEffectLayer(join(project, ".conduit/events.db")),
					),
				),
			);
		}
		await Effect.runPromise(migrateForkLineage(dir));
		for (const [i, project] of projects.entries()) {
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const envelope = yield* Stream.runHead(subscribeShell({}));
					expect(envelope._tag).toBe("Some");
					if (envelope._tag !== "Some" || envelope.value._tag !== "snapshot")
						throw new Error("expected snapshot");
					expect(envelope.value.rows).toContainEqual(
						expect.objectContaining({
							id: `child-${i}`,
							parentID: `parent-${i}`,
							forkMessageId: `message-${i}`,
							forkPointTimestamp: 100,
							forkPointMessageId: `message-${i}`,
						}),
					);
					expect(yield* sql`SELECT count(*) AS count FROM events`).toEqual([
						{ count: 0 },
					]);
				}).pipe(
					Effect.provide(
						Layer.merge(
							makePersistenceEffectLayer(join(project, ".conduit/events.db")),
							SessionEventBusLive,
						),
					),
				),
			);
		}
		expect(existsSync(sidecar)).toBe(false);
		await Effect.runPromise(migrateForkLineage(dir));
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
			await Effect.runPromise(migrateForkLineage(dir));
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
	const filename = join(project, ".conduit", "events.db");
	try {
		mkdirSync(join(project, ".conduit"), { recursive: true });
		writeFileSync(
			join(dir, "recent.json"),
			serializeRecent([
				{ directory: project, slug: "project", lastUsed: 1 },
				{ directory: join(dir, "broken"), slug: "broken", lastUsed: 1 },
			]),
		);
		mkdirSync(join(dir, "broken", ".conduit"), { recursive: true });
		writeFileSync(
			join(dir, "broken", ".conduit", "events.db"),
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
		await Effect.runPromise(migrateForkLineage(dir));
		const snapshot = () =>
			Effect.runPromise(
				Stream.runHead(subscribeShell({})).pipe(
					Effect.provide(
						Layer.merge(
							makePersistenceEffectLayer(filename),
							SessionEventBusLive,
						),
					),
				),
			);
		const first = await snapshot();
		await Effect.runPromise(migrateForkLineage(dir));
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
		await Effect.runPromise(migrateForkLineage(dir));
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
	const filename = join(project, ".conduit", "events.db");
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
		await Effect.runPromise(migrateForkLineage(dir));
		expect(existsSync(sidecar)).toBe(false);
		writeFileSync(
			sidecar,
			JSON.stringify({ later: { parentID: "parent", forkMessageId: "point" } }),
		);
		mkdirSync(join(project, ".conduit"), { recursive: true });
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('parent', 'opencode', 1, 1), ('child', 'opencode', 1, 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, text, created_at, updated_at) VALUES ('point', 'parent', 'assistant', 'answer', 100, 100)`;
			}).pipe(Effect.provide(makePersistenceEffectLayer(filename))),
		);
		await Effect.runPromise(migrateForkLineage(dir));
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
		await Effect.runPromise(migrateForkLineage(dir));
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

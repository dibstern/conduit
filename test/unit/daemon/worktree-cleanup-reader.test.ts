import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { DEFAULT_WORKTREE_CLEANUP } from "../../../src/lib/contracts/worktree.js";
import { readColdWorktreeCleanupCandidates } from "../../../src/lib/domain/daemon/Services/worktree-cleanup-reader.js";
import { projectStorageDir } from "../../../src/lib/persistence/project-storage.js";
import { writeEventStore } from "../../helpers/persistence-factories.js";

it("only discovers existing owned checkouts whose enabled rules could match", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-cleanup-reader-"));
	const project = {
		slug: "project",
		folders: [join(root, "project")] as const,
	};
	const now = Date.now();
	const old = now - 10 * 86_400_000;
	const disabled = { ...DEFAULT_WORKTREE_CLEANUP, onSettle: "off" as const };
	try {
		const store = projectStorageDir(root, project.slug);
		mkdirSync(store, { recursive: true });
		writeEventStore(
			join(store, "events.db"),
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				for (const id of [
					"settled",
					"idle",
					"old",
					"recent-turn",
					"recent-user",
					"deleted",
					"missing",
					"external",
					"no-activity",
				]) {
					const path = join(root, id);
					if (id !== "missing") mkdirSync(path);
					if (id !== "deleted")
						yield* sql`INSERT INTO sessions
					(id, provider, title, status, created_at, updated_at, last_message_at, settled_at)
					VALUES (${id}, 'claude', ${id}, 'idle', ${old}, ${old},
					${id === "no-activity" ? null : id === "idle" ? now : old}, ${id === "settled" ? now : null})`;
					yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
					VALUES (${id}, ${id}, 1, 'session.workspace_changed', ${JSON.stringify({ cause: "launch", origin: id === "external" ? "external" : "conduit", worktrees: { [project.folders[0]]: path } })}, 'claude', ${old})`;
				}
				yield* sql`INSERT INTO turns (id, session_id, state, requested_at, completed_at)
				VALUES ('turn', 'recent-turn', 'completed', ${old}, ${now})`;
				yield* sql`INSERT INTO messages (id, session_id, role, created_at, updated_at)
				VALUES ('message', 'recent-user', 'user', ${now}, ${now})`;
			}),
		);
		const candidates = async (setting: typeof DEFAULT_WORKTREE_CLEANUP) =>
			(
				await Effect.runPromise(
					readColdWorktreeCleanupCandidates(project, root, setting, now),
				)
			)
				.map((row) => row.session_id)
				.sort();
		expect(await candidates(disabled)).toEqual([]);
		expect(await candidates(DEFAULT_WORKTREE_CLEANUP)).toEqual(["settled"]);
		expect(await candidates({ ...disabled, onDelete: true })).toEqual([
			"deleted",
		]);
		expect(await candidates({ ...disabled, afterInactiveDays: 3 })).toEqual([
			"old",
			"settled",
		]);
		for (const field of ["whenMerged", "noCommitsBeyondDefault"] as const)
			expect(await candidates({ ...disabled, [field]: true })).toEqual([
				"idle",
				"no-activity",
				"old",
				"recent-turn",
				"recent-user",
				"settled",
			]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it.each([
	"sessionId",
	"childSessionIds",
] as const)("excludes a deleted checkout kept through the tombstone's %s", async (field) => {
	const root = mkdtempSync(join(tmpdir(), "conduit-cleanup-reader-"));
	const project = {
		slug: "project",
		folders: [join(root, "project")] as const,
	};
	const now = Date.now();
	try {
		const store = projectStorageDir(root, project.slug);
		mkdirSync(store, { recursive: true });
		writeEventStore(
			join(store, "events.db"),
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				for (const id of ["kept", "deleted"]) {
					const path = join(root, id);
					mkdirSync(path);
					yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
						VALUES (${id}, ${id}, 1, 'session.workspace_changed', ${JSON.stringify({ sessionId: id, cause: "launch", origin: "conduit", worktrees: { [project.folders[0]]: path } })}, 'claude', ${now})`;
				}
				const sessionId = field === "sessionId" ? "kept" : "parent";
				yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
					VALUES ('tombstone', ${sessionId}, 2, 'session.deleted', ${JSON.stringify({ sessionId, keepWorktrees: true, ...(field === "childSessionIds" ? { childSessionIds: ["kept"] } : {}) })}, 'claude', ${now})`;
			}),
		);
		expect(
			await Effect.runPromise(
				readColdWorktreeCleanupCandidates(
					project,
					root,
					{
						...DEFAULT_WORKTREE_CLEANUP,
						onSettle: "off",
						onDelete: true,
					},
					now,
				),
			),
		).toEqual([{ session_id: "deleted", path: join(root, "deleted") }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

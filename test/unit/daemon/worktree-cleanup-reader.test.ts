import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import { DEFAULT_WORKTREE_CLEANUP } from "../../../src/lib/contracts/worktree.js";
import { readColdWorktreeCleanupCandidates } from "../../../src/lib/domain/daemon/Services/worktree-cleanup-reader.js";
import {
	makePersistenceStoreLayer,
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../../src/lib/persistence/effect/live.js";
import { writeEventStore } from "../../helpers/persistence-factories.js";

it("only discovers existing owned checkouts whose enabled rules could match", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-cleanup-reader-"));
	const project = {
		slug: "project",
		folders: [join(root, "project")] as const,
	};
	const now = Date.now();
	const old = now - 10 * 86_400_000;
	const disabled = { ...DEFAULT_WORKTREE_CLEANUP, onSettle: "keep" as const };
	try {
		writeEventStore(
			join(root, "events.db"),
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				for (const id of [
					"settled",
					"idle",
					"old",
					"deleted",
					"missing",
					"external",
				]) {
					const path = join(root, id);
					if (id !== "missing") mkdirSync(path);
					if (id !== "deleted")
						yield* sql`INSERT INTO sessions
					(id, project_id, provider, title, status, created_at, updated_at, last_message_at, settled_at)
					VALUES (${id}, ${project.slug}, 'claude', ${id}, 'idle', ${old}, ${old},
					${id === "idle" ? now : old}, ${id === "settled" ? now : id === "old" ? old : null})`;
					yield* sql`INSERT INTO events (event_id, project_id, session_id, stream_version, type, data, provider, created_at)
					VALUES (${id}, ${project.slug}, ${id}, 1, 'session.workspace_changed', ${JSON.stringify({ cause: "launch", origin: id === "external" ? "external" : "conduit", worktrees: { [project.folders[0]]: path } })}, 'claude', ${old})`;
				}
			}),
		);
		const store = Layer.effect(
			PersistenceStore,
			Effect.context<PersistenceStoreContext>(),
		).pipe(Layer.provide(makePersistenceStoreLayer(join(root, "events.db"))));
		const candidates = async (setting: typeof DEFAULT_WORKTREE_CLEANUP) =>
			(
				await Effect.runPromise(
					readColdWorktreeCleanupCandidates(project, setting, now).pipe(
						Effect.provide(store),
					),
				)
			)
				.map((row) => row.session_id)
				.sort();
		expect(await candidates(disabled)).toEqual([]);
		expect(await candidates(DEFAULT_WORKTREE_CLEANUP)).toEqual([
			"old",
			"settled",
		]);
		expect(await candidates({ ...disabled, onDelete: true })).toEqual([
			"deleted",
		]);
		expect(await candidates({ ...disabled, settledAfterDays: 3 })).toEqual([
			"old",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

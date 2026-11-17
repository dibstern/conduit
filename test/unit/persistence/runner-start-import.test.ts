import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import {
	importProjectStore,
	seedDaemonStore,
} from "../../../src/lib/persistence/migrations/daemon-store-import.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import { makeRunnerReceiptStore } from "../../../src/lib/provider/runner/runner-receipts.js";
import {
	createProjectStoreFixture,
	writeImportArtifact,
} from "../../helpers/daemon-store-import-manifest.js";

// Either side can have been opened by a newer daemon. Normalization must keep
// checkpoints, leave legacy keys NULL, and preserve the original source schema.
it.live.each(["destination", "source"] as const)(
	"imports legacy runner starts when only the %s receipt store has opened",
	(upgraded) =>
		Effect.scoped(
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() =>
						mkdtempSync(join(tmpdir(), "runner-start-import-")),
					),
					(directory) =>
						Effect.sync(() =>
							rmSync(directory, { recursive: true, force: true }),
						),
				);
				const evidence: Record<string, unknown> = { passed: false, upgraded };
				return yield* Effect.gen(function* () {
					const transcript = { prompt: "hello", reply: "reply" };
					const existing = yield* Effect.tryPromise(() =>
						createProjectStoreFixture(root, "existing", { transcript }),
					);
					const incoming = yield* Effect.tryPromise(() =>
						createProjectStoreFixture(root, "incoming", { transcript }),
					);
					const configDir = join(root, "daemon");
					yield* seedDaemonStore(configDir, existing);
					const destination = daemonStorePath(configDir);
					for (const [name, filename] of [
						["destination", destination],
						["source", incoming.sourcePath],
					] as const) {
						const db = new DatabaseSync(filename);
						try {
							const columns = db
								.prepare("PRAGMA table_info(claude_runner_cursors)")
								.all();
							for (const column of ["start_key", "reaper_start_key"])
								if (columns.some((entry) => entry["name"] === column))
									db.exec(
										`ALTER TABLE claude_runner_cursors DROP COLUMN ${column}`,
									);
							db.prepare(`INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, retired_at, pid, start_time, reaper_pid, reaper_start_time)
								VALUES (?, 7, ?, 1234, 123, 'legacy-start', 124, 'legacy-reaper')`).run(
								name,
								name === "source" ? "ses_incoming" : "ses_existing",
							);
						} finally {
							db.close();
						}
					}
					yield* Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* makeRunnerReceiptStore(sql);
					}).pipe(
						Effect.provide(
							SqliteNode.layer({
								filename:
									upgraded === "destination"
										? destination
										: incoming.sourcePath,
							}).pipe(Layer.provide(Reactivity.layer)),
						),
						Effect.scoped,
					);
					const source = new DatabaseSync(incoming.sourcePath, {
						readOnly: true,
					});
					let sourceColumns: unknown;
					try {
						sourceColumns = source
							.prepare("PRAGMA table_info(claude_runner_cursors)")
							.all();
					} finally {
						source.close();
					}
					evidence["sourceColumnsBefore"] = sourceColumns;
					const result = yield* Effect.result(
						importProjectStore(configDir, incoming),
					);
					evidence["result"] = result;
					if (result._tag === "Failure") return yield* result.failure;
					expect(result.success.outcome).toBe("imported");
					const imported = new DatabaseSync(destination, { readOnly: true });
					try {
						const rows = imported
							.prepare(
								"SELECT runner_id, sequence, session_id, pid, start_time, start_key, reaper_pid, reaper_start_time, reaper_start_key FROM claude_runner_cursors ORDER BY runner_id",
							)
							.all();
						evidence["rows"] = rows;
						expect(rows).toEqual(
							["destination", "source"].map((name) => ({
								runner_id: name,
								sequence: 7,
								session_id: name === "source" ? "ses_incoming" : "ses_existing",
								pid: 123,
								start_time: "legacy-start",
								start_key: null,
								reaper_pid: 124,
								reaper_start_time: "legacy-reaper",
								reaper_start_key: null,
							})),
						);
						expect(
							imported.prepare("SELECT id FROM sessions ORDER BY id").all(),
						).toEqual([{ id: "ses_existing" }, { id: "ses_incoming" }]);
					} finally {
						imported.close();
					}
					const original = new DatabaseSync(incoming.sourcePath, {
						readOnly: true,
					});
					try {
						expect(
							original
								.prepare("PRAGMA table_info(claude_runner_cursors)")
								.all(),
						).toEqual(sourceColumns);
					} finally {
						original.close();
					}
					evidence["passed"] = true;
				}).pipe(
					Effect.ensuring(
						Effect.sync(() =>
							writeImportArtifact(
								`test-results/pt-startkey-import/${upgraded}.json`,
								evidence,
							),
						),
					),
				);
			}),
		),
);

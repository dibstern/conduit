import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	renameSync,
	statfsSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Data, Effect, Layer } from "effect";
import * as Failure from "../effect/failure-classification.js";

export class RewriteError extends Data.TaggedError("RewriteError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

const readTableCounts = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const tables = yield* sql<{ name: string }>`
		SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
	const counts: Array<{ name: string; count: number }> = [];
	for (const { name } of tables) {
		const [row] = yield* sql<{ count: number }>`
			SELECT COUNT(*) AS count FROM ${sql(name)}`;
		if (row === undefined) {
			return yield* new RewriteError({
				message: `Failed to count table ${name}`,
			});
		}
		counts.push({ name, count: row.count });
	}
	return counts;
});

/** Call only before opening the store's long-lived connections. */
export const rewriteStore = (
	filename: string,
	destination = filename,
): Effect.Effect<{ beforeBytes: number; afterBytes: number }, RewriteError> =>
	Effect.gen(function* () {
		const temporary = `${destination}.${randomUUID()}.tmp`;
		return yield* Effect.gen(function* () {
			const replacing = resolve(filename) === resolve(destination);
			const sourceCounts = yield* Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const [checkpoint] = yield* sql<{ busy: number }>`
					PRAGMA wal_checkpoint(TRUNCATE)`;
				if (checkpoint?.busy !== 0) {
					return yield* new RewriteError({
						message: `Store WAL checkpoint is busy: ${filename}`,
					});
				}
				const counts = yield* readTableCounts;
				yield* sql`VACUUM INTO ${temporary}`;
				return counts;
			}).pipe(
				Effect.provide(
					SqliteNode.layer({ filename, disableWAL: true }).pipe(
						Layer.provide(Reactivity.layer),
					),
				),
			);
			yield* Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const check = yield* sql<{ quick_check: string }>`PRAGMA quick_check`;
				if (check.length !== 1 || check[0]?.quick_check !== "ok") {
					return yield* new RewriteError({
						message: `Copy failed quick_check: ${JSON.stringify(check)}`,
					});
				}
				const copyCounts = yield* readTableCounts;
				if (JSON.stringify(copyCounts) !== JSON.stringify(sourceCounts)) {
					return yield* new RewriteError({
						message: `Copy table counts differ from ${filename}`,
					});
				}
			}).pipe(
				Effect.provide(
					SqliteNode.layer({
						filename: temporary,
						readonly: true,
						disableWAL: true,
					}).pipe(Layer.provide(Reactivity.layer)),
				),
			);
			// Both SQLite scopes have closed before the promoted inode changes.
			return yield* Effect.try(() => {
				const beforeBytes = statSync(filename).size;
				const afterBytes = statSync(temporary).size;
				const descriptor = openSync(temporary, "r+");
				try {
					fsyncSync(descriptor);
				} finally {
					closeSync(descriptor);
				}
				if (replacing) {
					// A nonempty WAL means another writer invalidated the checkpoint.
					if (
						existsSync(`${filename}-wal`) &&
						statSync(`${filename}-wal`).size > 0
					) {
						throw new RewriteError({
							message: `Store WAL changed during rewrite: ${filename}`,
						});
					}
					for (const suffix of ["-wal", "-shm"]) {
						if (existsSync(`${filename}${suffix}`))
							unlinkSync(`${filename}${suffix}`);
					}
				} else if (existsSync(destination)) {
					throw new RewriteError({
						message: `Project store appeared during migration: ${destination}`,
					});
				}
				renameSync(temporary, destination);
				return { beforeBytes, afterBytes };
			});
		}).pipe(
			Effect.catchAllCause((cause) =>
				Failure.isInterruptedOnly(cause)
					? Effect.interrupt
					: Effect.fail(
							new RewriteError({
								message: `Store rewrite failed: ${filename}`,
								cause,
							}),
						),
			),
			Effect.ensuring(
				Effect.try(() => {
					for (const suffix of ["", "-wal", "-shm"]) {
						if (existsSync(`${temporary}${suffix}`))
							unlinkSync(`${temporary}${suffix}`);
					}
				}).pipe(
					Effect.catchAll((cause) =>
						Effect.logWarning("Failed to remove store rewrite temporary file", {
							temporary,
							cause,
						}),
					),
				),
			),
		);
	});

/** Reclaim only substantial free-page waste, after numbered migrations close. */
export const reclaimStore = (filename: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { pageCount, freePages, pageSize } = yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const [pages] = yield* sql<{ page_count: number }>`PRAGMA page_count`;
			const [free] = yield* sql<{
				freelist_count: number;
			}>`PRAGMA freelist_count`;
			const [size] = yield* sql<{ page_size: number }>`PRAGMA page_size`;
			if (!pages || !free || !size) {
				return yield* new RewriteError({
					message: `Failed to read store page counts: ${filename}`,
				});
			}
			return {
				pageCount: pages.page_count,
				freePages: free.freelist_count,
				pageSize: size.page_size,
			};
		}).pipe(
			Effect.provide(
				SqliteNode.layer({ filename, readonly: true, disableWAL: true }).pipe(
					Layer.provide(Reactivity.layer),
				),
			),
		);
		// Avoid a full rewrite for the small freelist left by ordinary edits.
		if (pageCount === 0 || freePages / pageCount < 0.2) return;
		const expectedBytes = (pageCount - freePages) * pageSize;
		const availableBytes = yield* Effect.try(() => {
			const volume = statfsSync(dirname(filename));
			return volume.bavail * (volume.frsize || volume.bsize);
		});
		if (availableBytes < 2 * expectedBytes) {
			yield* Effect.logWarning(
				"Skipping event store reclaim: insufficient disk",
				{
					filename,
					availableBytes,
					requiredBytes: 2 * expectedBytes,
				},
			);
			return;
		}
		const sizes = yield* rewriteStore(filename);
		yield* Effect.logInfo("Reclaimed event store space", {
			filename,
			...sizes,
		});
	}).pipe(
		Effect.catchAllCause((cause) =>
			Failure.isInterruptedOnly(cause)
				? Effect.interrupt
				: Effect.logWarning("Event store reclaim failed; keeping original", {
						filename,
						cause: Failure.renderCause(cause),
					}),
		),
	);

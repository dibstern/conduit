/**
 * Writes queued for the next commit-and-signal transaction, keyed by owner. A leaf module, so a
 * projector can queue one without importing the commit seam's graph (projectors-effect is in it).
 */
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

export interface PendingWrite {
	readonly apply: Effect.Effect<void, SqlError>;
	readonly committed?: (() => void) | undefined;
}

const pendingWrites = new WeakMap<
	SqlClient.SqlClient,
	Map<unknown, PendingWrite>
>();

/** Synchronous enqueue: owners need not wait for a connection or its permit. */
export const queuePendingWrite = (
	sql: SqlClient.SqlClient,
	key: unknown,
	write: PendingWrite,
) => {
	let pending = pendingWrites.get(sql);
	if (pending === undefined) {
		pending = new Map();
		pendingWrites.set(sql, pending);
	}
	pending.set(key, write);
};

export const applyPendingWrites = (sql: SqlClient.SqlClient) =>
	Effect.gen(function* () {
		const applied = new Map<unknown, PendingWrite>();
		while (true) {
			const pending = [...(pendingWrites.get(sql)?.entries() ?? [])].filter(
				([key, write]) => applied.get(key) !== write,
			);
			if (pending.length === 0) return applied;
			for (const [key, write] of pending) {
				if (pendingWrites.get(sql)?.get(key) !== write) continue;
				yield* write.apply;
				applied.set(key, write);
			}
		}
	});

export const clearCommittedWrites = (
	sql: SqlClient.SqlClient,
	applied: ReadonlyMap<unknown, PendingWrite>,
) => {
	const pending = pendingWrites.get(sql);
	for (const [key, write] of applied) {
		if (pending?.get(key) === write) pending.delete(key);
		write.committed?.();
	}
};

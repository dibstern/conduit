import { Data, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";

/** Canonical deletions survive reloads; sidebar tombstones also name cascaded children. */
export const isSessionDeleted = (sessionId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		// Only an own marker is authoritative, even over a stale or seeded row.
		// Foreign-named deletions remove their payload's session, not this stream.
		// A live row only overrides a legacy sidebar tombstone.
		const rows = yield* sql<{ deleted: number }>`SELECT CASE
			WHEN EXISTS (SELECT 1 FROM events WHERE session_id = ${sessionId} AND type = 'session.deleted'
				AND json_extract(data, '$.sessionId') = session_id) THEN 1
			WHEN EXISTS (SELECT 1 FROM sessions WHERE id = ${sessionId}) THEN 0
			WHEN EXISTS (SELECT 1 FROM session_sidebar WHERE session_id = ${sessionId} AND row IS NULL) THEN 1
			ELSE 0 END AS deleted`;
		return rows[0]?.deleted === 1;
	});

export class SessionSeederEffectError extends Data.TaggedError(
	"SessionSeederEffectError",
)<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

const MAX_SEEN = 10_000;

export class EffectSessionSeeder {
	private readonly seenSessions = new Set<string>();

	ensureSession(
		sessionId: string,
		provider: string,
		opts?: { parentId?: string; providerSessionId?: string },
	): Effect.Effect<
		boolean,
		SessionSeederEffectError | SqlError,
		SqlClient.SqlClient | PersistenceProjectTag
	> {
		if (this.seenSessions.has(sessionId)) return Effect.succeed(false);

		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const { projectId } = yield* PersistenceProjectTag;
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					if (yield* isSessionDeleted(sessionId)) return false;
					if (opts?.parentId && (yield* isSessionDeleted(opts.parentId)))
						return false;
					const now = Date.now();
					yield* sql`
					INSERT OR IGNORE INTO sessions
					(id, project_id, provider, provider_sid, title, status, parent_id, created_at, updated_at)
					VALUES (${sessionId}, ${projectId}, ${provider}, ${opts?.providerSessionId ?? null}, 'Untitled', 'idle', ${opts?.parentId ?? null}, ${now}, ${now})`;
					return true;
				}),
			);
		}).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					this.seenSessions.add(sessionId);
					if (this.seenSessions.size > MAX_SEEN) {
						this.seenSessions.clear();
					}
				}),
			),
			Effect.mapError((e) =>
				e instanceof SessionSeederEffectError
					? e
					: new SessionSeederEffectError({
							operation: "ensureSession",
							cause: e,
						}),
			),
		);
	}

	reset(): void {
		this.seenSessions.clear();
	}
}

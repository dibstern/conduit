import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Data, Effect } from "effect";

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
	): Effect.Effect<
		boolean,
		SessionSeederEffectError | SqlError,
		SqlClient.SqlClient
	> {
		if (this.seenSessions.has(sessionId)) return Effect.succeed(false);

		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const now = Date.now();
			yield* sql`
				INSERT OR IGNORE INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES (${sessionId}, ${provider}, 'Untitled', 'idle', ${now}, ${now})`;
			return true;
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

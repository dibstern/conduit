import type { SqlClient } from "@effect/sql";
import { Effect } from "effect";

export interface ProviderSessionBinding {
	readonly sessionId: string;
	readonly providerId: string;
}

export interface ProviderSessionBindingReadModel {
	bindSession(sessionId: string, providerId: string): void;
	unbindSession(sessionId: string): void;
	getProviderForSession(sessionId: string): Effect.Effect<string | undefined>;
	listBoundSessions(): Effect.Effect<ProviderSessionBinding[]>;
	clearTransientBindings(): void;
}

interface ProviderSessionBindingRow {
	readonly session_id: string;
	readonly provider: string;
}

export class InMemoryProviderSessionBindingReadModel
	implements ProviderSessionBindingReadModel
{
	private readonly bindings = new Map<string, string>();

	bindSession(sessionId: string, providerId: string): void {
		this.bindings.set(sessionId, providerId);
	}

	unbindSession(sessionId: string): void {
		this.bindings.delete(sessionId);
	}

	getProviderForSession(sessionId: string): Effect.Effect<string | undefined> {
		return Effect.sync(() => this.bindings.get(sessionId));
	}

	listBoundSessions(): Effect.Effect<ProviderSessionBinding[]> {
		return Effect.sync(() =>
			[...this.bindings.entries()].map(([sessionId, providerId]) => ({
				sessionId,
				providerId,
			})),
		);
	}

	clearTransientBindings(): void {
		this.bindings.clear();
	}
}

export class SqliteProviderSessionBindingReadModel
	implements ProviderSessionBindingReadModel
{
	private readonly transientBindings = new Map<string, string | null>();

	constructor(private readonly sql: SqlClient.SqlClient) {}

	bindSession(sessionId: string, providerId: string): void {
		this.transientBindings.set(sessionId, providerId);
	}

	unbindSession(sessionId: string): void {
		this.transientBindings.set(sessionId, null);
	}

	getProviderForSession(sessionId: string): Effect.Effect<string | undefined> {
		return Effect.suspend(() => {
			if (this.transientBindings.has(sessionId)) {
				return Effect.succeed(
					this.transientBindings.get(sessionId) ?? undefined,
				);
			}
			return this.sql<ProviderSessionBindingRow>`
				SELECT session_id, provider
				FROM session_providers
				WHERE session_id = ${sessionId} AND status = 'active'
				ORDER BY activated_at DESC, id DESC
				LIMIT 1`.pipe(
				Effect.map((rows) => rows[0]?.provider),
				Effect.orDie,
			);
		});
	}

	listBoundSessions(): Effect.Effect<ProviderSessionBinding[]> {
		return this.sql<ProviderSessionBindingRow>`
			SELECT active.session_id, active.provider
			FROM session_providers AS active
			JOIN (
				SELECT session_id, MAX(activated_at) AS activated_at
				FROM session_providers
				WHERE status = 'active'
				GROUP BY session_id
			) AS latest
			ON latest.session_id = active.session_id
			AND latest.activated_at = active.activated_at
			WHERE active.status = 'active'
			ORDER BY active.session_id, active.id`.pipe(
			Effect.orDie,
			Effect.map((rows) => {
				const bindings = new Map(
					rows.map((row) => [row.session_id, row.provider] as const),
				);
				for (const [sessionId, providerId] of this.transientBindings) {
					if (providerId == null) {
						bindings.delete(sessionId);
					} else {
						bindings.set(sessionId, providerId);
					}
				}
				return [...bindings.entries()].map(([sessionId, providerId]) => ({
					sessionId,
					providerId,
				}));
			}),
		);
	}

	clearTransientBindings(): void {
		this.transientBindings.clear();
	}
}

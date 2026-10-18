import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SessionScope } from "../contracts/session-scope.js";

export interface ProviderSessionBinding {
	readonly sessionId: string;
	readonly providerId: string;
}

export type ProviderSessionBindingRevision = number | string;

export interface ProviderSessionBindingReadModel {
	bindSession(sessionId: string, providerId: string): void;
	unbindSession(sessionId: string): void;
	getBindingRevision(
		sessionId: string,
	): Effect.Effect<ProviderSessionBindingRevision>;
	unbindSessionIfBoundTo(
		sessionId: string,
		providerId: string,
		bindingRevision: ProviderSessionBindingRevision,
	): Effect.Effect<void>;
	getProviderForSession(sessionId: string): Effect.Effect<string | undefined>;
	listBoundSessions(
		scope: SessionScope,
	): Effect.Effect<ProviderSessionBinding[]>;
	clearTransientBindings(): void;
}

interface ProviderSessionBindingRow {
	readonly session_id: string;
	readonly provider: string;
}

interface DurableProviderSessionBindingRevisionRow {
	readonly id: string;
	readonly activated_at: number;
}

export class InMemoryProviderSessionBindingReadModel
	implements ProviderSessionBindingReadModel
{
	private readonly bindings = new Map<string, string>();
	private readonly bindingRevisions = new Map<string, number>();
	private bindingRevisionGenerator = 0;

	bindSession(sessionId: string, providerId: string): void {
		this.bindingRevisionGenerator += 1;
		this.bindings.set(sessionId, providerId);
		this.bindingRevisions.set(sessionId, this.bindingRevisionGenerator);
	}

	unbindSession(sessionId: string): void {
		this.bindingRevisionGenerator += 1;
		this.bindings.delete(sessionId);
		this.bindingRevisions.delete(sessionId);
	}

	getBindingRevision(
		sessionId: string,
	): Effect.Effect<ProviderSessionBindingRevision> {
		return Effect.sync(() => this.bindingRevisions.get(sessionId) ?? 0);
	}

	unbindSessionIfBoundTo(
		sessionId: string,
		providerId: string,
		bindingRevision: ProviderSessionBindingRevision,
	): Effect.Effect<void> {
		return Effect.sync(() => {
			if (
				this.bindings.get(sessionId) === providerId &&
				(this.bindingRevisions.get(sessionId) ?? 0) === bindingRevision
			) {
				this.bindings.delete(sessionId);
				this.bindingRevisions.delete(sessionId);
			}
		});
	}

	getProviderForSession(sessionId: string): Effect.Effect<string | undefined> {
		return Effect.sync(() => this.bindings.get(sessionId));
	}

	listBoundSessions(
		_scope: SessionScope,
	): Effect.Effect<ProviderSessionBinding[]> {
		return Effect.sync(() =>
			[...this.bindings.entries()].map(([sessionId, providerId]) => ({
				sessionId,
				providerId,
			})),
		);
	}

	clearTransientBindings(): void {
		this.bindings.clear();
		this.bindingRevisions.clear();
	}
}

export class SqliteProviderSessionBindingReadModel
	implements ProviderSessionBindingReadModel
{
	private readonly transientBindings = new Map<string, string | null>();
	private readonly bindingRevisions = new Map<string, number>();
	private bindingRevisionGenerator = 0;

	constructor(private readonly sql: SqlClient.SqlClient) {}

	bindSession(sessionId: string, providerId: string): void {
		this.bindingRevisionGenerator += 1;
		this.transientBindings.set(sessionId, providerId);
		this.bindingRevisions.set(sessionId, this.bindingRevisionGenerator);
	}

	unbindSession(sessionId: string): void {
		this.bindingRevisionGenerator += 1;
		this.transientBindings.set(sessionId, null);
		this.bindingRevisions.delete(sessionId);
	}

	getBindingRevision(
		sessionId: string,
	): Effect.Effect<ProviderSessionBindingRevision> {
		return Effect.suspend(() => {
			if (this.transientBindings.has(sessionId)) {
				return Effect.succeed(this.bindingRevisions.get(sessionId) ?? 0);
			}
			return this.sql<DurableProviderSessionBindingRevisionRow>`
				SELECT id, activated_at FROM session_providers
				WHERE session_id = ${sessionId} AND status = 'active'
				ORDER BY activated_at DESC, id DESC LIMIT 1`.pipe(
				Effect.map((rows) =>
					this.transientBindings.has(sessionId)
						? (this.bindingRevisions.get(sessionId) ?? 0)
						: rows[0] === undefined
							? 0
							: JSON.stringify([rows[0].id, rows[0].activated_at]),
				),
				Effect.orDie,
			);
		});
	}

	unbindSessionIfBoundTo(
		sessionId: string,
		providerId: string,
		bindingRevision: ProviderSessionBindingRevision,
	): Effect.Effect<void> {
		return Effect.gen(this, function* () {
			const currentProvider = yield* this.getProviderForSession(sessionId);
			const currentRevision = yield* this.getBindingRevision(sessionId);
			if (
				currentProvider === providerId &&
				currentRevision === bindingRevision
			) {
				this.unbindSession(sessionId);
			}
		});
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

	listBoundSessions(
		scope: SessionScope,
	): Effect.Effect<ProviderSessionBinding[]> {
		return this.sql<{ session_id: string; provider: string | null }>`
			SELECT owner.id AS session_id, active.provider
			FROM sessions AS owner
			LEFT JOIN session_providers AS active ON active.id = (
				SELECT id FROM session_providers WHERE session_id = owner.id AND status = 'active'
				ORDER BY activated_at DESC, id DESC LIMIT 1
			)
			WHERE owner.project_id IN ${this.sql.in(scope.projectIds)}
			ORDER BY owner.id`.pipe(
			Effect.orDie,
			Effect.map((rows) => {
				const scopedSessions = new Set(rows.map((row) => row.session_id));
				const bindings = new Map(
					rows.flatMap((row) =>
						row.provider === null
							? []
							: [[row.session_id, row.provider] as const],
					),
				);
				for (const [sessionId, providerId] of this.transientBindings) {
					if (!scopedSessions.has(sessionId)) continue;
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
		this.bindingRevisions.clear();
	}
}

import type { SQLInputValue } from "node:sqlite";

type SessionBindingReadModelDb = {
	readonly query: <T>(sql: string, params?: readonly SQLInputValue[]) => T[];
	readonly queryOne: <T>(
		sql: string,
		params?: readonly SQLInputValue[],
	) => T | undefined;
};

export interface ProviderSessionBinding {
	readonly sessionId: string;
	readonly providerId: string;
}

export interface ProviderSessionBindingReadModel {
	bindSession(sessionId: string, providerId: string): void;
	unbindSession(sessionId: string): void;
	getBindingRevision(sessionId: string): number;
	unbindSessionIfBoundTo(
		sessionId: string,
		providerId: string,
		bindingRevision: number,
	): void;
	getProviderForSession(sessionId: string): string | undefined;
	listBoundSessions(): ProviderSessionBinding[];
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
	private readonly bindingRevisions = new Map<string, number>();

	bindSession(sessionId: string, providerId: string): void {
		this.bindings.set(sessionId, providerId);
		this.bindingRevisions.set(
			sessionId,
			(this.bindingRevisions.get(sessionId) ?? 0) + 1,
		);
	}

	unbindSession(sessionId: string): void {
		this.bindings.delete(sessionId);
		this.bindingRevisions.set(
			sessionId,
			(this.bindingRevisions.get(sessionId) ?? 0) + 1,
		);
	}

	getBindingRevision(sessionId: string): number {
		return this.bindingRevisions.get(sessionId) ?? 0;
	}

	unbindSessionIfBoundTo(
		sessionId: string,
		providerId: string,
		bindingRevision: number,
	): void {
		if (
			this.bindings.get(sessionId) === providerId &&
			this.getBindingRevision(sessionId) === bindingRevision
		) {
			this.bindings.delete(sessionId);
		}
	}

	getProviderForSession(sessionId: string): string | undefined {
		return this.bindings.get(sessionId);
	}

	listBoundSessions(): ProviderSessionBinding[] {
		return [...this.bindings.entries()].map(([sessionId, providerId]) => ({
			sessionId,
			providerId,
		}));
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

	constructor(private readonly db: SessionBindingReadModelDb) {}

	bindSession(sessionId: string, providerId: string): void {
		this.transientBindings.set(sessionId, providerId);
		this.bindingRevisions.set(
			sessionId,
			(this.bindingRevisions.get(sessionId) ?? 0) + 1,
		);
	}

	unbindSession(sessionId: string): void {
		this.transientBindings.set(sessionId, null);
		this.bindingRevisions.set(
			sessionId,
			(this.bindingRevisions.get(sessionId) ?? 0) + 1,
		);
	}

	getBindingRevision(sessionId: string): number {
		return this.bindingRevisions.get(sessionId) ?? 0;
	}

	unbindSessionIfBoundTo(
		sessionId: string,
		providerId: string,
		bindingRevision: number,
	): void {
		if (
			this.getProviderForSession(sessionId) === providerId &&
			this.getBindingRevision(sessionId) === bindingRevision
		) {
			this.transientBindings.set(sessionId, null);
		}
	}

	getProviderForSession(sessionId: string): string | undefined {
		if (this.transientBindings.has(sessionId)) {
			return this.transientBindings.get(sessionId) ?? undefined;
		}

		const row = this.db.queryOne<ProviderSessionBindingRow>(
			`SELECT session_id, provider
			 FROM session_providers
			 WHERE session_id = ? AND status = 'active'
			 ORDER BY activated_at DESC, id DESC
			 LIMIT 1`,
			[sessionId],
		);
		return row?.provider;
	}

	listBoundSessions(): ProviderSessionBinding[] {
		const rows = this.db.query<ProviderSessionBindingRow>(
			`SELECT active.session_id, active.provider
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
			 ORDER BY active.session_id, active.id`,
		);
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
	}

	clearTransientBindings(): void {
		this.transientBindings.clear();
		this.bindingRevisions.clear();
	}
}

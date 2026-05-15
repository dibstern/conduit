import type { SqliteClient } from "./sqlite-client.js";

export class SessionSeeder {
	private readonly db: SqliteClient;
	private readonly seenSessions = new Set<string>();

	private static readonly MAX_SEEN = 10_000;

	constructor(db: SqliteClient) {
		this.db = db;
	}

	ensureSession(
		sessionId: string,
		provider: string,
		opts?: { parentId?: string; providerSessionId?: string },
	): boolean {
		if (this.seenSessions.has(sessionId)) return false;

		const now = Date.now();
		this.db.execute(
			`INSERT OR IGNORE INTO sessions
			 (id, provider, provider_sid, title, status, parent_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				sessionId,
				provider,
				opts?.providerSessionId ?? null,
				"Untitled",
				"idle",
				opts?.parentId ?? null,
				now,
				now,
			],
		);

		this.seenSessions.add(sessionId);

		if (this.seenSessions.size > SessionSeeder.MAX_SEEN) {
			this.seenSessions.clear();
		}

		return true;
	}

	reset(): void {
		this.seenSessions.clear();
	}
}

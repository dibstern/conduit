import type { SqliteClient } from "./sqlite-client.js";

export class SessionSeeder {
	private readonly db: SqliteClient;
	private readonly seenSessions = new Set<string>();

	private static readonly MAX_SEEN = 10_000;

	constructor(db: SqliteClient) {
		this.db = db;
	}

	ensureSession(sessionId: string, provider: string): boolean {
		if (this.seenSessions.has(sessionId)) return false;

		const now = Date.now();
		this.db.execute(
			`INSERT OR IGNORE INTO sessions (id, provider, title, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[sessionId, provider, "Untitled", "idle", now, now],
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

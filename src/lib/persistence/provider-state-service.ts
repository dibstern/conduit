// src/lib/persistence/provider-state-service.ts

import type { SqliteClient } from "./sqlite-client.js";

/**
 * Read/write service for the provider_state table.
 * Stores per-session key-value pairs used by provider adapters
 * (e.g. Claude resume cursors).
 */
export class ProviderStateService {
	constructor(private readonly db: SqliteClient) {}

	/** Load all provider state for a session as a key-value record. */
	getState(sessionId: string): Record<string, string> {
		const rows = this.db.query<{ key: string; value: string }>(
			"SELECT key, value FROM provider_state WHERE session_id = ?",
			[sessionId],
		);
		const result: Record<string, string> = {};
		for (const row of rows) {
			result[row.key] = row.value;
		}
		return result;
	}

	/** Persist provider state updates (upsert). */
	saveUpdates(
		sessionId: string,
		updates: ReadonlyArray<{ key: string; value: string }>,
	): void {
		if (updates.length === 0) return;
		for (const { key, value } of updates) {
			this.db.execute(
				`INSERT INTO provider_state (session_id, key, value)
				 VALUES (?, ?, ?)
				 ON CONFLICT (session_id, key) DO UPDATE SET value = excluded.value`,
				[sessionId, key, value],
			);
		}
	}

	/** Clear all provider state for a session. */
	clearState(sessionId: string): void {
		this.db.execute("DELETE FROM provider_state WHERE session_id = ?", [
			sessionId,
		]);
	}
}

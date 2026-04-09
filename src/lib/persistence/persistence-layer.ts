import { CommandReceiptRepository } from "./command-receipts.js";
import { EventStore } from "./event-store.js";
import { runMigrations } from "./migrations.js";
import { createAllProjectors, ProjectionRunner } from "./projection-runner.js";
import { ProjectorCursorRepository } from "./projector-cursor-repository.js";
import { schemaMigrations } from "./schema.js";
import { SqliteClient } from "./sqlite-client.js";

export class PersistenceLayer {
	readonly db: SqliteClient;
	readonly eventStore: EventStore;
	readonly commandReceipts: CommandReceiptRepository;
	readonly cursorRepo: ProjectorCursorRepository;
	readonly projectionRunner: ProjectionRunner;
	private closed = false;

	private constructor(db: SqliteClient) {
		this.db = db;
		runMigrations(db, schemaMigrations);
		this.eventStore = new EventStore(db);
		this.commandReceipts = new CommandReceiptRepository(db);
		this.cursorRepo = new ProjectorCursorRepository(db);
		this.projectionRunner = new ProjectionRunner({
			projectors: createAllProjectors(),
			db,
			cursorRepo: this.cursorRepo,
			eventStore: this.eventStore,
		});
	}

	static open(
		filename: string,
		opts?: { interimEvictionThreshold?: number },
	): PersistenceLayer {
		const db = SqliteClient.open(filename);
		const layer = new PersistenceLayer(db);

		const threshold = opts?.interimEvictionThreshold ?? 200_000;
		if (threshold > 0) {
			layer.runInterimEviction(threshold);
		}

		return layer;
	}

	static memory(): PersistenceLayer {
		const db = SqliteClient.memory();
		return new PersistenceLayer(db);
	}

	private runInterimEviction(threshold: number): void {
		const countRow = this.db.queryOne<{ count: number }>(
			"SELECT COUNT(*) as count FROM events",
		);
		const eventCount = countRow?.count ?? 0;
		if (eventCount <= threshold) return;

		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		const batchSize = 5000;

		while (true) {
			const result = this.db.execute(
				`DELETE FROM events WHERE sequence IN (
					SELECT events.sequence FROM events
					JOIN sessions ON events.session_id = sessions.id
					WHERE sessions.status = 'idle'
					  AND sessions.updated_at < ?
					LIMIT ?
				)`,
				[cutoff, batchSize],
			);
			const deleted = Number(result.changes);
			if (deleted < batchSize) break;
		}

		this.db.execute("DELETE FROM command_receipts WHERE created_at < ?", [
			cutoff,
		]);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}
}

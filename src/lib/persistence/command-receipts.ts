import { PersistenceError } from "./errors.js";
import type { SqliteClient } from "./sqlite-client.js";

export interface CommandReceipt {
	readonly commandId: string;
	readonly sessionId: string;
	readonly status: "accepted" | "rejected";
	readonly resultSequence?: number;
	readonly error?: string;
	readonly createdAt: number;
}

interface ReceiptRow {
	command_id: string;
	session_id: string;
	status: string;
	result_sequence: number | null;
	error: string | null;
	created_at: number;
}

export class CommandReceiptRepository {
	private readonly db: SqliteClient;

	constructor(db: SqliteClient) {
		this.db = db;
	}

	check(commandId: string): CommandReceipt | undefined {
		const row = this.db.queryOne<ReceiptRow>(
			`SELECT command_id, session_id, status, result_sequence, error, created_at
			FROM command_receipts
			WHERE command_id = ?`,
			[commandId],
		);

		if (!row) return undefined;
		return this.rowToReceipt(row);
	}

	record(receipt: CommandReceipt): void {
		this.db.execute(
			`INSERT INTO command_receipts (
				command_id, session_id, status, result_sequence, error, created_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
			[
				receipt.commandId,
				receipt.sessionId,
				receipt.status,
				receipt.resultSequence ?? null,
				receipt.error ?? null,
				receipt.createdAt,
			],
		);
	}

	private rowToReceipt(row: ReceiptRow): CommandReceipt {
		if (row.status !== "accepted" && row.status !== "rejected") {
			throw new PersistenceError(
				"INVALID_RECEIPT_STATUS",
				`Unknown receipt status in database: ${row.status}`,
				{
					commandId: row.command_id,
					sessionId: row.session_id,
					status: row.status,
				},
			);
		}
		return {
			commandId: row.command_id,
			sessionId: row.session_id,
			status: row.status,
			...(row.result_sequence != null
				? { resultSequence: row.result_sequence }
				: {}),
			...(row.error != null ? { error: row.error } : {}),
			createdAt: row.created_at,
		};
	}
}

import { Data } from "effect";
import {
	DURABLE_COMMAND_RECEIPT_STATUSES,
	type DurableCommandReceiptStatus,
} from "./orchestration-command-contracts.js";

type CommandReadModelDb = {
	readonly query: <T>(sql: string, params?: readonly unknown[]) => T[];
	readonly queryOne: <T>(
		sql: string,
		params?: readonly unknown[],
	) => T | undefined;
};

export type CommandReceiptStatus = DurableCommandReceiptStatus;

class UnknownCommandReceiptStatus extends Data.TaggedError(
	"UnknownCommandReceiptStatus",
)<{
	readonly status: string;
}> {
	get message(): string {
		return `Unknown command receipt status: ${this.status}`;
	}
}

export type CommandTombstoneScopeKind =
	| "project"
	| "session"
	| "turn"
	| "interaction";

export interface CommandReceiptSnapshot {
	readonly commandId: string;
	readonly sessionId: string;
	readonly status: CommandReceiptStatus;
	readonly resultSequence?: number;
	readonly error?: string;
	readonly createdAt: number;
}

export interface CommandReadModelSnapshot {
	readonly lastEventSequence: number;
	readonly receipts: ReadonlyMap<string, CommandReceiptSnapshot>;
	readonly tombstones: ReadonlySet<string>;
}

interface CommandReceiptRow {
	readonly command_id: string;
	readonly session_id: string;
	readonly status: string;
	readonly result_sequence: number | null;
	readonly error: string | null;
	readonly created_at: number;
}

interface LastSequenceRow {
	readonly last_sequence: number | null;
}

function tombstoneKey(
	scopeKind: CommandTombstoneScopeKind,
	scopeId: string,
): string {
	return `${scopeKind}:${scopeId}`;
}

export function isCommandScopeTombstoned(
	snapshot: CommandReadModelSnapshot,
	scopeKind: CommandTombstoneScopeKind,
	scopeId: string,
): boolean {
	return snapshot.tombstones.has(tombstoneKey(scopeKind, scopeId));
}

function toCommandReceiptStatus(status: string): CommandReceiptStatus {
	if (
		DURABLE_COMMAND_RECEIPT_STATUSES.includes(status as CommandReceiptStatus)
	) {
		return status as CommandReceiptStatus;
	}
	throw new UnknownCommandReceiptStatus({ status });
}

function rowToReceipt(row: CommandReceiptRow): CommandReceiptSnapshot {
	return {
		commandId: row.command_id,
		sessionId: row.session_id,
		status: toCommandReceiptStatus(row.status),
		...(row.result_sequence != null
			? { resultSequence: row.result_sequence }
			: {}),
		...(row.error != null ? { error: row.error } : {}),
		createdAt: row.created_at,
	};
}

export class CommandReadModelRepository {
	constructor(private readonly db: CommandReadModelDb) {}

	bootstrap(): CommandReadModelSnapshot {
		const receiptRows = this.db.query<CommandReceiptRow>(
			`SELECT command_id, session_id, status, result_sequence, error, created_at
			 FROM command_receipts
			 ORDER BY command_id`,
		);
		const lastSequence = this.db.queryOne<LastSequenceRow>(
			"SELECT MAX(sequence) AS last_sequence FROM events",
		);

		return {
			lastEventSequence: lastSequence?.last_sequence ?? 0,
			receipts: new Map(
				receiptRows.map((row) => {
					const receipt = rowToReceipt(row);
					return [receipt.commandId, receipt];
				}),
			),
			tombstones: new Set(),
		};
	}
}

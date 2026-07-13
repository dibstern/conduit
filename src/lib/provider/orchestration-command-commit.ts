import { EventStore } from "../persistence/event-store.js";
import type { CanonicalEvent, StoredEvent } from "../persistence/events.js";
import type { SqliteClient } from "../persistence/sqlite-client.js";
import type {
	DurableCommandCommitPlan,
	DurableCommandOutboxRequest,
	DurableCommandReceiptWrite,
} from "./orchestration-command-contracts.js";

export interface DurableCommandCommitInput extends DurableCommandCommitPlan {
	readonly events: readonly CanonicalEvent[];
}

export class DurableCommandCommitRepository {
	private readonly eventStore: EventStore;

	constructor(private readonly db: SqliteClient) {
		this.eventStore = new EventStore(db);
	}

	commit(input: DurableCommandCommitInput): StoredEvent[] {
		return this.db.runInTransaction(() => {
			const storedEvents = this.eventStore.appendBatch(input.events);
			this.recordReceipt(input.receipt);
			for (const request of input.outboxRequests) {
				this.recordOutboxRequest(request, input.receipt.updatedAt);
			}
			this.recordMeta(
				input.receipt.projectKey,
				storedEvents.at(-1)?.sequence ?? 0,
				input.receipt.updatedAt,
			);
			return storedEvents;
		});
	}

	private recordReceipt(receipt: DurableCommandReceiptWrite): void {
		this.db.execute(
			`INSERT INTO command_receipts (
				command_id, session_id, status, result_sequence, error, created_at,
				command_type, project_key, fingerprint_hash, fingerprint_version,
				accepted_sequence, side_effect_sequence, error_code, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (command_id) DO UPDATE SET
				status = excluded.status,
				result_sequence = excluded.result_sequence,
				command_type = excluded.command_type,
				project_key = excluded.project_key,
				fingerprint_hash = excluded.fingerprint_hash,
				fingerprint_version = excluded.fingerprint_version,
				accepted_sequence = excluded.accepted_sequence,
				side_effect_sequence = excluded.side_effect_sequence,
				error_code = excluded.error_code,
				updated_at = excluded.updated_at`,
			[
				receipt.commandId,
				receipt.sessionId,
				receipt.status,
				receipt.resultSequence ?? null,
				receipt.errorCode ?? null,
				receipt.createdAt,
				receipt.commandType,
				receipt.projectKey,
				receipt.fingerprintHash,
				receipt.fingerprintVersion,
				receipt.acceptedSequence ?? null,
				receipt.sideEffectSequence ?? null,
				receipt.errorCode ?? null,
				receipt.updatedAt,
			],
		);
	}

	private recordOutboxRequest(
		request: DurableCommandOutboxRequest,
		updatedAt: number,
	): void {
		this.db.execute(
			`INSERT INTO provider_command_outbox (
				request_sequence, command_id, project_key, session_id, provider_id,
				effect_type, payload_json, status, attempt_count, requested_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
			[
				request.requestSequence,
				request.commandId,
				request.projectKey,
				request.sessionId,
				request.providerId,
				request.effectType,
				request.payloadJson,
				updatedAt,
				updatedAt,
			],
		);
	}

	private recordMeta(
		projectKey: string,
		lastAppliedSequence: number,
		updatedAt: number,
	): void {
		this.db.execute(
			`INSERT INTO provider_command_meta (
				project_key, last_applied_sequence, schema_version, rebuilt_at
			) VALUES (?, ?, 1, ?)
			ON CONFLICT (project_key) DO UPDATE SET
				last_applied_sequence = excluded.last_applied_sequence,
				schema_version = excluded.schema_version,
				rebuilt_at = excluded.rebuilt_at`,
			[projectKey, lastAppliedSequence, updatedAt],
		);
	}
}

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";
import {
	type EventStoreError,
	makeEventStoreEffect,
} from "../persistence/effect/event-store-effect.js";
import type { CanonicalEvent, StoredEvent } from "../persistence/events.js";
import type {
	DurableCommandCommitPlan,
	DurableCommandOutboxRequest,
	DurableCommandReceiptWrite,
} from "./orchestration-command-contracts.js";

export interface DurableCommandCommitInput extends DurableCommandCommitPlan {
	readonly events: readonly CanonicalEvent[];
}

export class DurableCommandCommitRepository {
	constructor(private readonly sql: SqlClient.SqlClient) {}

	/** Events, receipt, outbox requests and meta commit atomically or not at all. */
	commit(
		input: DurableCommandCommitInput,
	): Effect.Effect<readonly StoredEvent[], SqlError | EventStoreError | Error> {
		return this.sql.withTransaction(
			Effect.gen(this, function* () {
				const eventStore = yield* makeEventStoreEffect.pipe(
					Effect.provideService(SqlClient.SqlClient, this.sql),
				);
				const storedEvents = yield* eventStore.appendBatch(input.events);
				yield* this.recordReceipt(input.receipt);
				for (const request of input.outboxRequests) {
					yield* this.recordOutboxRequest(request, input.receipt.updatedAt);
				}
				yield* this.recordMeta(
					input.receipt.projectKey,
					storedEvents.at(-1)?.sequence ?? 0,
					input.receipt.updatedAt,
				);
				return storedEvents;
			}),
		);
	}

	private recordReceipt(
		receipt: DurableCommandReceiptWrite,
	): Effect.Effect<void, SqlError> {
		return this.sql`
			INSERT INTO command_receipts (
				command_id, session_id, status, result_sequence, error, created_at,
				command_type, project_key, fingerprint_hash, fingerprint_version,
				accepted_sequence, side_effect_sequence, error_code, updated_at
			) VALUES (
				${receipt.commandId}, ${receipt.sessionId}, ${receipt.status},
				${receipt.resultSequence ?? null}, ${receipt.errorCode ?? null},
				${receipt.createdAt}, ${receipt.commandType}, ${receipt.projectKey},
				${receipt.fingerprintHash}, ${receipt.fingerprintVersion},
				${receipt.acceptedSequence ?? null}, ${receipt.sideEffectSequence ?? null},
				${receipt.errorCode ?? null}, ${receipt.updatedAt}
			)
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
				updated_at = excluded.updated_at`.pipe(Effect.asVoid);
	}

	private recordOutboxRequest(
		request: DurableCommandOutboxRequest,
		updatedAt: number,
	): Effect.Effect<void, SqlError | Error> {
		// One live execution claim per command id. A re-dispatch after a
		// retryable failure recommits the same command; supersede any prior
		// *idle* non-terminal row (pending/retryable_failed) so the fresh pending
		// row is the only executable claim. A `running` row is an active claim
		// held by an executor — superseding it would let a second executor run
		// the provider concurrently, so refuse the recommit and let the whole
		// commit transaction roll back. Terminal rows (completed/failed) are
		// preserved as history.
		return Effect.gen(this, function* () {
			const [running] = yield* this.sql<{ readonly n: number }>`
				SELECT COUNT(*) AS n FROM provider_command_outbox
				WHERE command_id = ${request.commandId} AND status = 'running'`;
			if ((running?.n ?? 0) > 0) {
				return yield* Effect.fail(
					new Error(
						`Cannot recommit command ${request.commandId}: an execution claim is already running`,
					),
				);
			}
			yield* this.sql`
				DELETE FROM provider_command_outbox
				WHERE command_id = ${request.commandId}
				  AND status IN ('pending', 'retryable_failed')`;
			yield* this.sql`
				INSERT INTO provider_command_outbox (
					request_sequence, command_id, project_key, session_id, provider_id,
					effect_type, payload_json, status, attempt_count, requested_at, updated_at
				) VALUES (
					${request.requestSequence}, ${request.commandId}, ${request.projectKey},
					${request.sessionId}, ${request.providerId}, ${request.effectType},
					${request.payloadJson}, 'pending', 0, ${updatedAt}, ${updatedAt}
				)`;
		});
	}

	private recordMeta(
		projectKey: string,
		lastAppliedSequence: number,
		updatedAt: number,
	): Effect.Effect<void, SqlError> {
		return this.sql`
			INSERT INTO provider_command_meta (
				project_key, last_applied_sequence, schema_version, rebuilt_at
			) VALUES (${projectKey}, ${lastAppliedSequence}, 1, ${updatedAt})
			ON CONFLICT (project_key) DO UPDATE SET
				last_applied_sequence = excluded.last_applied_sequence,
				schema_version = excluded.schema_version,
				rebuilt_at = excluded.rebuilt_at`.pipe(Effect.asVoid);
	}
}

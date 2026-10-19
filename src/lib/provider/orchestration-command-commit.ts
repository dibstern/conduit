import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import {
	type EventStoreError,
	makeEventStoreEffect,
} from "../persistence/effect/event-store-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	type StoredEvent,
} from "../persistence/events.js";
import { isRecord } from "../utils.js";
import type {
	DurableCommandCommitPlan,
	DurableCommandOutboxRequest,
	DurableCommandReceiptWrite,
} from "./orchestration-command-contracts.js";

export interface DurableCommandCommitInput extends DurableCommandCommitPlan {
	readonly events: readonly CanonicalEvent[];
}

export class DurableCommandCommitRepository {
	constructor(
		private readonly sql: SqlClient.SqlClient,
		private readonly projectId: string,
	) {}

	/** Events, receipt, outbox requests and meta commit atomically or not at all. */
	commit(
		input: DurableCommandCommitInput,
	): Effect.Effect<readonly StoredEvent[], SqlError | EventStoreError | Error> {
		return this.sql.withTransaction(
			Effect.gen({ self: this }, function* () {
				// Acquire the writer slot before the command-ownership preflight.
				// No session rows change; this prevents a stale snapshot upgrade.
				yield* this.sql`UPDATE sessions SET project_id = project_id WHERE 0`;
				const commandIds = [
					...new Set([
						input.receipt.commandId,
						...input.outboxRequests.map((request) => request.commandId),
					]),
				];
				const [foreign] = yield* this.sql<{
					readonly command_id: string;
					readonly project_key: string;
				}>`SELECT command_id, project_key FROM command_receipts
					WHERE command_id IN ${this.sql.in(commandIds)} AND project_key IS NOT ${this.projectId}
					UNION ALL SELECT command_id, project_key FROM provider_command_outbox
					WHERE command_id IN ${this.sql.in(commandIds)} AND project_key IS NOT ${this.projectId}
					LIMIT 1`;
				if (foreign)
					return yield* Effect.fail(
						new Error(
							`Command ${foreign.command_id} belongs to project ${foreign.project_key}; project ${this.projectId} cannot commit it`,
						),
					);
				const eventStore = yield* makeEventStoreEffect.pipe(
					Effect.provideService(SqlClient.SqlClient, this.sql),
					Effect.provideService(PersistenceProjectTag, {
						projectId: this.projectId,
					}),
				);
				const events = [...input.events];
				const requests: DurableCommandOutboxRequest[] = [];
				for (const request of input.outboxRequests) {
					if (request.effectType !== "send_turn") {
						requests.push({ ...request, projectKey: this.projectId });
						continue;
					}
					const payload = yield* Effect.try({
						try: (): unknown => JSON.parse(request.payloadJson),
						catch: (cause) =>
							new Error("Invalid send_turn reservation payload", { cause }),
					});
					if (!isRecord(payload))
						return yield* Effect.fail(
							new Error("Invalid send_turn reservation payload"),
						);
					const superseded = yield* this.sql<{ id: string; input_id: string }>`
						SELECT r.id, COALESCE(json_extract(o.payload_json, '$.inputId'), o.command_id) AS input_id
						FROM provider_command_outbox o JOIN provider_runs r ON r.id = json_extract(o.payload_json, '$.runId')
						WHERE o.command_id = ${request.commandId} AND o.project_key = ${this.projectId}
							AND o.status IN ('pending', 'retryable_failed') AND r.status = 'pending'`;
					for (const previous of superseded) {
						events.push(
							canonicalEvent(
								"turn.interrupted",
								request.sessionId,
								{ messageId: previous.input_id },
								{
									provider: request.providerId,
									createdAt: input.receipt.updatedAt,
									metadata: { runId: previous.id },
								},
							),
						);
					}
					const runId = randomUUID();
					const inputId =
						typeof payload["inputId"] === "string"
							? payload["inputId"]
							: request.commandId;
					yield* this
						.sql`INSERT INTO provider_runs (id, session_id, status, requested_at)
						VALUES (${runId}, ${request.sessionId}, 'pending', ${input.receipt.updatedAt})`;
					events.push(
						canonicalEvent(
							"run.requested",
							request.sessionId,
							{ runId, inputId },
							{
								provider: request.providerId,
								createdAt: input.receipt.updatedAt,
								metadata: { runId },
							},
						),
					);
					requests.push({
						...request,
						projectKey: this.projectId,
						payloadJson: JSON.stringify({ ...payload, runId }),
					});
				}
				const storedEvents = yield* eventStore.appendBatch(events);
				yield* this.recordReceipt({
					...input.receipt,
					projectKey: this.projectId,
				});
				for (const request of requests) {
					yield* this.recordOutboxRequest(
						{ ...request, projectKey: this.projectId },
						input.receipt.updatedAt,
					);
				}
				yield* this.recordMeta(
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
				fingerprint_hash = excluded.fingerprint_hash,
				fingerprint_version = excluded.fingerprint_version,
				accepted_sequence = excluded.accepted_sequence,
				side_effect_sequence = excluded.side_effect_sequence,
				error_code = excluded.error_code,
				updated_at = excluded.updated_at
			WHERE command_receipts.project_key = ${this.projectId}`.pipe(
			Effect.asVoid,
		);
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
		return Effect.gen({ self: this }, function* () {
			const [running] = yield* this.sql<{
				readonly n: number;
				readonly attempt_count: number;
			}>`
				SELECT COUNT(*) FILTER (WHERE status = 'running') AS n,
					COALESCE(MAX(attempt_count), 0) AS attempt_count FROM provider_command_outbox
				WHERE command_id = ${request.commandId} AND project_key = ${this.projectId}`;
			if ((running?.n ?? 0) > 0) {
				return yield* Effect.fail(
					new Error(
						`Cannot recommit command ${request.commandId}: an execution claim is already running`,
					),
				);
			}
			yield* this
				.sql`UPDATE provider_runs SET status = 'interrupted', completed_at = ${updatedAt}
				WHERE status = 'pending' AND id IN (
					SELECT json_extract(payload_json, '$.runId') FROM provider_command_outbox
					WHERE command_id = ${request.commandId} AND project_key = ${this.projectId}
					AND status IN ('pending', 'retryable_failed'))`;
			yield* this.sql`
				DELETE FROM provider_command_outbox
				WHERE command_id = ${request.commandId}
				  AND project_key = ${this.projectId}
				  AND status IN ('pending', 'retryable_failed')`;
			yield* this.sql`
				INSERT INTO provider_command_outbox (
					request_sequence, command_id, project_key, session_id, provider_id,
					effect_type, payload_json, status, attempt_count, requested_at, updated_at
				) VALUES (
					${request.requestSequence}, ${request.commandId}, ${request.projectKey},
					${request.sessionId}, ${request.providerId}, ${request.effectType},
					${request.payloadJson}, 'pending', ${running?.attempt_count ?? 0}, ${updatedAt}, ${updatedAt}
				)`;
		});
	}

	private recordMeta(
		lastAppliedSequence: number,
		updatedAt: number,
	): Effect.Effect<void, SqlError> {
		return this.sql`
			INSERT INTO provider_command_meta (
				project_key, last_applied_sequence, schema_version, rebuilt_at
			) VALUES (${this.projectId}, ${lastAppliedSequence}, 1, ${updatedAt})
			ON CONFLICT (project_key) DO UPDATE SET
				last_applied_sequence = excluded.last_applied_sequence,
				schema_version = excluded.schema_version,
				rebuilt_at = excluded.rebuilt_at`.pipe(Effect.asVoid);
	}
}

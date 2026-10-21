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
import { CommandFingerprintMismatch } from "./errors.js";
import type {
	DurableCommandCommitPlan,
	DurableCommandOutboxRequest,
	DurableCommandReceiptWrite,
	ProviderControlPayload,
} from "./orchestration-command-contracts.js";
import { DURABLE_COMMAND_FINGERPRINT_VERSION } from "./orchestration-command-contracts.js";

export interface DurableCommandCommitInput extends DurableCommandCommitPlan {
	readonly events: readonly CanonicalEvent[];
	/** Controls retain their original acceptance and outbox identity forever. */
	readonly immutable?: boolean;
}

export class DurableCommandCommitRepository {
	constructor(
		private readonly sql: SqlClient.SqlClient,
		private readonly projectId: string,
	) {}

	/** Accept a control without reserving a run or releasing an interaction. */
	commitControl(input: {
		readonly commandId: string;
		readonly providerId: string;
		readonly payload: ProviderControlPayload;
		readonly fingerprintHash: string;
		readonly requestSequence: number;
		readonly nowMs: number;
	}): ReturnType<DurableCommandCommitRepository["commit"]> {
		const { payload, commandId, providerId, nowMs, requestSequence } = input;
		const opts = {
			provider: providerId,
			createdAt: nowMs,
			metadata: { commandId, source: "conduit.control-outbox" },
		};
		let event: CanonicalEvent;
		switch (payload.type) {
			case "interrupt_turn":
				event = canonicalEvent(
					"interrupt.requested",
					payload.sessionId,
					{
						providerProcessId: payload.providerProcessId,
						...(payload.turnIds ? { turnIds: payload.turnIds } : {}),
					},
					opts,
				);
				break;
			case "end_session":
				event = canonicalEvent(
					"session.end_requested",
					payload.sessionId,
					{ providerProcessId: payload.providerProcessId },
					opts,
				);
				break;
			case "resolve_permission":
				event = canonicalEvent(
					"permission.resolved",
					payload.sessionId,
					{
						id: payload.requestId,
						providerProcessId: payload.providerProcessId,
						...(payload.nativeRequestId
							? { providerRequestId: payload.nativeRequestId }
							: {}),
						decision: payload.response?.decision ?? payload.decision,
					},
					opts,
				);
				break;
			case "resolve_question":
				event = canonicalEvent(
					"question.resolved",
					payload.sessionId,
					{
						id: payload.requestId,
						providerProcessId: payload.providerProcessId,
						...(payload.nativeRequestId
							? { providerRequestId: payload.nativeRequestId }
							: {}),
						answers: payload.answers,
					},
					opts,
				);
				break;
		}
		return this.commit({
			immutable: true,
			events: [event],
			receipt: {
				commandId,
				commandType: payload.type,
				sessionId: payload.sessionId,
				status: "side_effect_requested",
				fingerprintHash: input.fingerprintHash,
				fingerprintVersion: DURABLE_COMMAND_FINGERPRINT_VERSION,
				acceptedSequence: requestSequence,
				sideEffectSequence: requestSequence,
				createdAt: nowMs,
				updatedAt: nowMs,
			},
			outboxRequests: [
				{
					requestSequence,
					commandId,
					sessionId: payload.sessionId,
					providerId,
					providerProcessId: payload.providerProcessId,
					effectType: payload.type,
					payloadJson: JSON.stringify(payload),
				},
			],
			readModelRows: ["provider_command_meta"],
		});
	}

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
				if (input.immutable) {
					const [existing] = yield* this.sql<{
						fingerprint_hash: string;
						fingerprint_version: number;
					}>`SELECT fingerprint_hash, fingerprint_version FROM command_receipts WHERE command_id = ${input.receipt.commandId}`;
					if (existing) {
						if (
							existing.fingerprint_hash !== input.receipt.fingerprintHash ||
							existing.fingerprint_version !== input.receipt.fingerprintVersion
						)
							return yield* Effect.fail(
								new CommandFingerprintMismatch({
									commandId: input.receipt.commandId,
								}),
							);
						return [];
					}
				}
				yield* this.recordReceipt({
					...input.receipt,
					projectKey: this.projectId,
				});
				for (const request of input.outboxRequests) {
					const reserved = yield* this.recordOutboxRequest(
						{
							...request,
							projectKey: this.projectId,
						},
						input.receipt.updatedAt,
					);
					if (reserved) events.push(reserved);
				}
				const storedEvents = yield* eventStore.appendBatch(events);
				yield* this.sql`
					INSERT INTO provider_command_meta (project_key, last_applied_sequence, schema_version, rebuilt_at)
					VALUES (${this.projectId}, ${storedEvents.at(-1)?.sequence ?? 0}, 1, ${input.receipt.updatedAt})
					ON CONFLICT (project_key) DO UPDATE SET
						last_applied_sequence = MAX(provider_command_meta.last_applied_sequence, excluded.last_applied_sequence),
						schema_version = excluded.schema_version, rebuilt_at = excluded.rebuilt_at`;
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
	): Effect.Effect<CanonicalEvent | undefined, SqlError | Error> {
		// Recommit replaces idle rows while retaining their reservation. A live
		// executor keeps its exclusive claim; terminal rows remain history.
		return Effect.gen({ self: this }, function* () {
			const [running] = yield* this.sql<{
				readonly n: number;
				readonly attempt_count: number;
				readonly run_id: string | null;
			}>`
				SELECT COUNT(*) FILTER (WHERE status = 'running') AS n,
					COALESCE(MAX(attempt_count), 0) AS attempt_count,
					MAX(CASE WHEN status IN ('pending', 'retryable_failed')
						AND run_id IN (SELECT id FROM provider_runs WHERE session_id = ${request.sessionId} AND status IN ('pending', 'running'))
						THEN run_id END) AS run_id
				FROM provider_command_outbox
				WHERE command_id = ${request.commandId} AND project_key = ${this.projectId}`;
			if ((running?.n ?? 0) > 0) {
				return yield* Effect.fail(
					new Error(
						`Cannot recommit command ${request.commandId}: an execution claim is already running`,
					),
				);
			}
			const runId =
				request.effectType === "send_turn"
					? (running?.run_id ?? randomUUID())
					: null;
			yield* this.sql`
				DELETE FROM provider_command_outbox
				WHERE command_id = ${request.commandId}
				  AND project_key = ${this.projectId}
				  AND status IN ('pending', 'retryable_failed')`;
			yield* this.sql`
				INSERT INTO provider_command_outbox (
					request_sequence, command_id, project_key, session_id, provider_id,
					effect_type, payload_json, run_id, provider_process_id, status, attempt_count, requested_at, updated_at
				) VALUES (
					${request.requestSequence}, ${request.commandId}, ${request.projectKey},
					${request.sessionId}, ${request.providerId}, ${request.effectType},
					${request.payloadJson}, ${runId}, ${request.providerProcessId ?? null}, 'pending', ${running?.attempt_count ?? 0}, ${updatedAt}, ${updatedAt}
				)`;
			if (!runId || running?.run_id) return;
			const payload = yield* Effect.try({
				try: (): unknown => JSON.parse(request.payloadJson),
				catch: (cause) =>
					new Error("Invalid send_turn reservation payload", { cause }),
			});
			if (!isRecord(payload))
				return yield* Effect.fail(
					new Error("Invalid send_turn reservation payload"),
				);
			return canonicalEvent(
				"run.requested",
				request.sessionId,
				{
					runId,
					inputId:
						typeof payload["inputId"] === "string"
							? payload["inputId"]
							: request.commandId,
				},
				{
					provider: request.providerId,
					createdAt: updatedAt,
					metadata: { runId },
				},
			);
		});
	}
}

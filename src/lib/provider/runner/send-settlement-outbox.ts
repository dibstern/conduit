import { Brand, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { AccountSchema } from "../../contracts/account.js";
import { AttachmentRefSchema } from "../../contracts/attachment-ref.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import type { InputDrafts } from "../../domain/project-services/Services/input-drafts.js";
import type { ClaudeEventPersistEffect } from "../../persistence/effect/claude-event-persist-effect.js";
import type { CommitAndSignalProject } from "../../persistence/effect/commit-and-signal.js";
import { makeEventStoreEffect } from "../../persistence/effect/event-store-effect.js";
import { makeProviderStateEffect } from "../../persistence/effect/provider-state-effect.js";
import { isRecord } from "../../utils.js";
import { recordClaudeNativeResumeFallback } from "../claude/prepare-turn.js";
import { isClaudeResumeRefused } from "../event-sink-errors.js";
import { translateProviderRuntimeEventToDomain } from "../provider-runtime-event-to-domain.js";
import type { TurnResult } from "../types.js";
import {
	legacyRunnerRunPredicate,
	legacyRunnerRunQuery,
} from "./runner-legacy-classification.js";
import type { runningRunnerCommands } from "./runner-recovery.js";
import {
	classify,
	type NormalizedTerminalEvidence,
	type SendEvidence,
	type SendOutcome,
	type SettlementTx,
	type StoreFault,
	sendRetryBackoff,
	terminalFailureResult,
	terminalTurnResult,
	toStoreFault,
} from "./send-settlement.js";
import type { SessionFailure } from "./session-runner.js";

type SendRow = Pick<
	Effect.Success<ReturnType<typeof runningRunnerCommands>>[number],
	| "request_sequence"
	| "project_key"
	| "session_id"
	| "command_id"
	| "attempt_count"
	| "provider_id"
	| "run_id"
	| "payload_json"
>;

/** The outbox adapter appends one terminal; projection settles the command. */
const settleRunnerCommandReply = (
	sql: SqlClient.SqlClient,
	row: Pick<
		Effect.Success<ReturnType<typeof runningRunnerCommands>>[number],
		| "request_sequence"
		| "project_key"
		| "session_id"
		| "command_id"
		| "attempt_count"
		| "provider_id"
		| "run_id"
		| "payload_json"
	>,
	result: TurnResult | undefined,
	failure: SessionFailure | undefined,
	now: number,
	outcome: SendOutcome,
	options: {
		readonly project: CommitAndSignalProject;
		readonly persistUserMessage?: ClaudeEventPersistEffect["persistUserMessage"];
		readonly userMessageIdForInput?: (
			driver: string,
			inputId: string,
		) => string | undefined;
		readonly retryAt?: number;
		readonly inputDrafts?: Pick<InputDrafts, "restoreChange">;
		readonly afterCommit?: (effect: Effect.Effect<void>) => void;
		readonly driverKind?: string;
		readonly processLost?: boolean;
		readonly covered?: boolean;
	},
) =>
	Effect.gen(function* () {
		if (!row.run_id) return;
		const completed = outcome === "succeeded";
		const retryable = outcome === "retryable";
		const interrupted = outcome === "cancelled";
		const code = completed
			? null
			: interrupted
				? "interrupted"
				: String(
						failure?.code ??
							result?.error?.code ??
							result?.status ??
							"provider_failure",
					);
		const message =
			failure?.message ?? result?.error?.message ?? code ?? "provider_failure";
		const payloadResult = !completed
			? yield* Effect.result(
					Schema.decodeUnknownEffect(
						Schema.fromJsonString(
							Schema.Struct({
								prompt: Schema.String,
								text: Schema.optionalKey(Schema.String),
								inputId: Schema.optionalKey(Schema.String),
								commandId: Schema.optionalKey(Schema.String),
								userMessageId: Schema.optionalKey(Schema.String),
								turnId: Schema.optionalKey(Schema.String),
								continuation: Schema.optionalKey(Schema.Unknown),
								account: Schema.optionalKey(AccountSchema),
								images: Schema.optionalKey(Schema.Array(AttachmentRefSchema)),
							}),
						),
					)(row.payload_json),
				)
			: undefined;
		// An undecodable payload still settles; it only skips the payload's duties.
		const payload =
			payloadResult?._tag === "Success" ? payloadResult.success : undefined;
		// Receipt and terminal stay in this caller-owned transaction.
		yield* sql`UPDATE command_receipts
			SET error = ${failure ? JSON.stringify(failure) : result?.error ? JSON.stringify(result.error) : null}
			WHERE command_id = ${row.command_id} AND project_key = ${row.project_key}
				AND status = 'side_effect_requested'
				AND ${row.request_sequence} = (SELECT MAX(request_sequence) FROM provider_command_outbox
					WHERE command_id = ${row.command_id} AND project_key = ${row.project_key})`;
		if (completed && result?.providerStateUpdates.length) {
			const state = yield* makeProviderStateEffect.pipe(
				Effect.provideService(SqlClient.SqlClient, sql),
				Effect.provideService(PersistenceProjectTag, {
					projectId: row.project_key,
				}),
			);
			yield* state.saveUpdates(
				row.session_id,
				result.providerStateUpdates.map(({ key, value }) => ({
					key,
					value: String(value),
				})),
			);
		}
		const inputId = payload
			? payload.continuation === true
				? (payload.commandId ?? row.command_id)
				: (payload.inputId ??
					payload.userMessageId ??
					payload.commandId ??
					payload.turnId ??
					row.command_id)
			: row.command_id;
		const [placement] = yield* sql<{
			placed: number;
			shown: number;
			steering: number;
		}>`SELECT
			EXISTS (SELECT 1 FROM turns WHERE session_id = ${row.session_id} AND run_id = ${row.run_id}) AS placed,
			EXISTS (SELECT 1 FROM messages WHERE session_id = ${row.session_id} AND input_id = ${inputId}) AS shown,
			EXISTS (SELECT 1 FROM pending_inputs WHERE session_id = ${row.session_id}
				AND input_id = ${row.command_id} AND state = 'steering') AS steering`;
		// A failure placed here names its user message, as main's placement did.
		let placedMessageId: string | undefined;
		if (
			payload &&
			options.persistUserMessage &&
			!placement?.placed &&
			(!placement?.steering || code === "send_admission_timeout") &&
			(!interrupted || options.covered)
		) {
			const continuation = payload.continuation;
			const cutOffMessageId =
				continuation === true
					? payload.userMessageId
					: isRecord(continuation) &&
							typeof continuation["cutOffMessageId"] === "string"
						? continuation["cutOffMessageId"]
						: undefined;
			const driver = payload.account?.driver ?? row.provider_id;
			placedMessageId =
				cutOffMessageId ??
				options.userMessageIdForInput?.(driver, inputId) ??
				inputId;
			yield* options.persistUserMessage(row.session_id, payload.prompt, {
				projectId: row.project_key,
				project: options.project,
				messageId: placedMessageId,
				inputId,
				runId: row.run_id,
				provider: driver,
				...(payload.images ? { images: payload.images } : {}),
			});
		}
		// Exhaustion returns the text even when an earlier transmission placed it.
		if (
			outcome === "permanent" &&
			payload &&
			options.inputDrafts &&
			(code === "provider_send_attempts_exhausted" ||
				(!placement?.placed && !placement?.shown)) &&
			!placement?.steering
		) {
			const change = options.inputDrafts.restoreChange(
				{ session: row.session_id },
				inputId,
				payload.images ?? [],
				payload.text ?? payload.prompt,
				now,
			);
			yield* change.write.pipe(Effect.provideService(SqlClient.SqlClient, sql));
			options.afterCommit?.(change.publish);
		}
		const store = yield* makeEventStoreEffect.pipe(
			Effect.provideService(SqlClient.SqlClient, sql),
			Effect.provideService(PersistenceProjectTag, {
				projectId: row.project_key,
			}),
		);
		const { events } = translateProviderRuntimeEventToDomain({
			eventId: `provider-command-terminal:${row.request_sequence}:${row.attempt_count}`,
			type: completed
				? "turn.completed"
				: interrupted
					? "turn.interrupted"
					: "turn.error",
			providerId: options.processLost
				? "conduit"
				: (options.driverKind ?? row.provider_id),
			sessionId: row.session_id,
			runId: row.run_id,
			providerRefs: {},
			rawSource: {
				kind: options.processLost
					? "conduit.session-run-settlement"
					: "runner.command-reply",
			},
			createdAt: now,
			data: completed
				? { messageId: `provider-command:${row.command_id}` }
				: interrupted
					? { messageId: "", reason: message }
					: {
							messageId: options.processLost
								? ""
								: (placedMessageId ?? `provider-command:${row.command_id}`),
							error: message,
							code,
							retryable,
							...(retryable && options.retryAt !== undefined
								? { retryAt: options.retryAt }
								: {}),
						},
		});
		const idle = options.processLost
			? translateProviderRuntimeEventToDomain({
					eventId: `provider-command-idle:${row.request_sequence}:${row.attempt_count}`,
					type: "session.status",
					providerId: "conduit",
					sessionId: row.session_id,
					runId: row.run_id,
					providerRefs: {},
					rawSource: { kind: "conduit.session-run-settlement" },
					createdAt: now,
					data: { sessionId: row.session_id, status: "idle" },
				}).events
			: [];
		yield* options.project(yield* store.appendBatch([...events, ...idle]));
	});

export const appendSendSettlement = (
	tx: SettlementTx,
	row: SendRow,
	evidence: NormalizedTerminalEvidence,
	outcome: SendOutcome,
	observedAt: number,
	retryAt?: number,
) => {
	const result =
		evidence._tag === "replied" || evidence._tag === "journal_finished"
			? evidence.result
			: undefined;
	const failure =
		evidence._tag === "failed"
			? evidence.failure
			: evidence._tag === "covered"
				? {
						operation: "holdRun",
						code: "interrupted",
						message: "Stopped before delivery",
					}
				: evidence._tag === "delivery_unknown"
					? {
							operation: "settle runner send",
							code: "delivery_indeterminate",
							message:
								"The runner may have received this message. Retry it explicitly.",
						}
					: evidence._tag === "process_lost"
						? {
								operation: "settle stopped runner",
								code:
									outcome === "cancelled" ? "interrupted" : "runner_stopped",
								message: "Provider process stopped",
							}
						: undefined;
	return settleRunnerCommandReply(
		tx.sql,
		row,
		result,
		failure,
		observedAt,
		outcome,
		{
			...tx,
			...(evidence._tag === "covered" ? { covered: true } : {}),
			...(evidence._tag === "process_lost" ? { processLost: true } : {}),
			...(outcome === "retryable"
				? {
						retryAt:
							retryAt ?? observedAt + sendRetryBackoff(row.attempt_count),
					}
				: {}),
		},
	);
};

/** Direct providers retain their existing outcome path without a runner hold. */
export const settleDirectSend = (
	tx: SettlementTx,
	row: SendRow,
	result: TurnResult | undefined,
	failure: SessionFailure | undefined,
	observedAt: number,
	retryDelay?: number,
): Effect.Effect<void, StoreFault> =>
	Effect.gen(function* () {
		const terminal = failure
			? terminalFailureResult(failure)
			: terminalTurnResult(result);
		if (!terminal || !row.run_id) return;
		const [current] =
			yield* tx.sql`SELECT 1 FROM provider_command_outbox command
			JOIN provider_runs run ON run.id = command.run_id AND run.session_id = command.session_id
			WHERE command.request_sequence = ${row.request_sequence} AND command.project_key = ${row.project_key}
				AND command.session_id = ${row.session_id} AND command.command_id = ${row.command_id}
				AND command.attempt_count = ${row.attempt_count} AND command.status = 'running'
				AND run.status IN ('pending', 'running') AND run.runner_id IS NULL`;
		if (!current) return;
		const normalized: NormalizedTerminalEvidence = {
			_tag: "replied",
			result: terminal,
		};
		const outcome = classify(normalized);
		const retryAt =
			outcome === "retryable"
				? observedAt + (retryDelay ?? sendRetryBackoff(row.attempt_count))
				: null;
		yield* appendSendSettlement(
			tx,
			row,
			normalized,
			outcome,
			observedAt,
			retryAt ?? undefined,
		);
		// Direct-provider acknowledgement remains separate from native lifecycle.
		const changed = yield* tx.sql`UPDATE provider_command_outbox
			SET status = ${outcome === "succeeded" ? "completed" : outcome === "retryable" ? "retryable_failed" : "failed"},
				error_code = ${outcome === "succeeded" ? null : (terminal.error?.code ?? terminal.status)},
				next_attempt_at = ${retryAt}, updated_at = ${observedAt},
				payload_json = CASE WHEN ${outcome === "retryable"} OR NOT json_valid(payload_json)
					THEN payload_json ELSE json_remove(payload_json, '$.images') END
			WHERE request_sequence = ${row.request_sequence} AND project_key = ${row.project_key}
				AND session_id = ${row.session_id} AND command_id = ${row.command_id}
				AND attempt_count = ${row.attempt_count} AND status = 'running' RETURNING command_id`;
		if (changed.length)
			yield* tx.sql`UPDATE command_receipts
			SET status = ${outcome === "succeeded" ? "side_effect_completed" : "side_effect_failed"},
				error_code = ${outcome === "succeeded" ? null : (terminal.error?.code ?? terminal.status)},
				updated_at = ${observedAt} WHERE command_id = ${row.command_id} AND project_key = ${row.project_key}
				AND ${row.request_sequence} = (SELECT MAX(request_sequence) FROM provider_command_outbox
					WHERE command_id = ${row.command_id} AND project_key = ${row.project_key})`;
		yield* tx.stamp((version) =>
			tx.sql<{ id: string }>`UPDATE sessions SET version = ${version}
			WHERE id = ${row.session_id} RETURNING id`.pipe(
				Effect.map((rows) => rows.map(({ id }) => id)),
			),
		);
	}).pipe(Effect.mapError(toStoreFault));

/** Only the predicate can construct a key for the pre-hold recovery path. */
export type LegacySendKey = {
	readonly row: SendRow;
} & Brand.Brand<"LegacySendKey">;
const legacySendKey = Brand.nominal<LegacySendKey>();
export const LegacySendKey = {
	prove: (
		sql: SqlClient.SqlClient,
		row: SendRow,
	): Effect.Effect<LegacySendKey | undefined, StoreFault> =>
		Effect.gen(function* () {
			if (
				!row.run_id ||
				!(yield* legacyRunnerRunQuery(sql, row.session_id, row.run_id))
			)
				return undefined;
			return legacySendKey({ row });
		}).pipe(Effect.mapError(toStoreFault)),
};

export const settleLegacySend = (
	tx: SettlementTx,
	key: LegacySendKey,
	result: TurnResult | undefined,
	failure: SessionFailure | undefined,
	observedAt: number,
	options: {
		readonly nativeResumeFallback?: boolean;
		readonly driverKind?: string;
	} = {},
): Effect.Effect<void, StoreFault> =>
	Effect.gen(function* () {
		const { row } = key;
		const [current] =
			yield* tx.sql`SELECT 1 FROM provider_command_outbox command
			JOIN provider_runs requested ON requested.id = command.run_id AND requested.session_id = command.session_id
			JOIN provider_runs owner ON owner.id = COALESCE(requested.joined_into, requested.id) AND owner.session_id = requested.session_id
			WHERE command.request_sequence = ${row.request_sequence} AND command.project_key = ${row.project_key}
				AND command.session_id = ${row.session_id} AND command.command_id = ${row.command_id}
				AND command.attempt_count = ${row.attempt_count} AND command.status = 'running'
				AND owner.id = ${row.run_id} AND owner.status IN ('pending', 'running')
				AND command.request_sequence = (SELECT MAX(latest.request_sequence) FROM provider_command_outbox latest
					WHERE latest.project_key = command.project_key AND latest.command_id = command.command_id)
				AND ${legacyRunnerRunPredicate(tx.sql, row.session_id, tx.sql`owner.id`)}`;
		if (!current) return;
		const resumeRejected =
			result?.nativeResumeRejected ||
			isClaudeResumeRefused(failure ?? result?.error);
		if (resumeRejected && options.nativeResumeFallback === false) {
			const payload = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(
					Schema.Struct({
						instanceId: Schema.optionalKey(Schema.String),
						account: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
						clearInheritedGoal: Schema.optionalKey(Schema.Boolean),
						forkSession: Schema.optionalKey(Schema.Boolean),
					}),
				),
			)(row.payload_json);
			const [session] = yield* tx.sql<{
				forked_from: string | null;
			}>`SELECT forked_from FROM sessions WHERE id = ${row.session_id}`;
			yield* recordClaudeNativeResumeFallback(tx.sql, {
				sessionId: row.session_id,
				instanceId:
					payload.account?.id ?? payload.instanceId ?? row.provider_id,
				commandId: row.command_id,
				requestSequence: row.request_sequence,
				attempt: row.attempt_count,
				forkRefused:
					payload.clearInheritedGoal ||
					payload.forkSession ||
					session?.forked_from != null,
			});
			yield* tx.sql`UPDATE provider_command_outbox SET status = 'retryable_failed', error_code = NULL,
				next_attempt_at = ${observedAt}, updated_at = ${observedAt}
				WHERE request_sequence = ${row.request_sequence} AND project_key = ${row.project_key}
					AND session_id = ${row.session_id} AND command_id = ${row.command_id}
					AND status = 'running' AND attempt_count = ${row.attempt_count}`;
			yield* tx.sql`UPDATE command_receipts SET status = 'side_effect_requested', error_code = NULL,
				error = NULL, updated_at = ${observedAt} WHERE command_id = ${row.command_id}
				AND project_key = ${row.project_key} AND ${row.request_sequence} =
					(SELECT MAX(request_sequence) FROM provider_command_outbox WHERE command_id = ${row.command_id} AND project_key = ${row.project_key})`;
			return;
		}
		const terminal =
			resumeRejected && options.nativeResumeFallback === true
				? terminalFailureResult(
						failure ?? {
							operation: "send-turn",
							message: result?.error?.message ?? "Native resume was rejected",
							code: result?.error?.code ?? "native_resume_rejected",
						},
					)
				: failure
					? terminalFailureResult(failure)
					: terminalTurnResult(result);
		if (!terminal) return;
		const normalized: NormalizedTerminalEvidence = {
			_tag: "replied",
			result: terminal,
		};
		yield* appendSendSettlement(
			tx,
			row,
			normalized,
			classify(normalized),
			observedAt,
		);
		yield* tx.stamp((version) =>
			tx.sql<{ id: string }>`UPDATE sessions SET version = ${version}
				WHERE id = ${row.session_id} RETURNING id`.pipe(
				Effect.map((rows) => rows.map(({ id }) => id)),
			),
		);
	}).pipe(Effect.mapError(toStoreFault));

// A legacy send its runner no longer reports goes back to the outbox for replay.
// It takes the row, not a LegacySendKey: rows with no run_id or no run row requeue too.
export const requeueLegacySend = (
	tx: SettlementTx,
	row: SendRow,
	now: number,
): Effect.Effect<void, StoreFault> =>
	Effect.gen(function* () {
		const requeued = yield* tx.sql`UPDATE provider_command_outbox
			SET status = 'retryable_failed', next_attempt_at = ${now}, updated_at = ${now}
			WHERE request_sequence = ${row.request_sequence} AND project_key = ${row.project_key}
				AND session_id = ${row.session_id} AND command_id = ${row.command_id}
				AND status = 'running' AND attempt_count = ${row.attempt_count} RETURNING command_id`;
		if (requeued.length > 0)
			yield* tx.stamp((version) =>
				tx.sql<{ id: string }>`UPDATE sessions SET version = ${version}
				WHERE id = ${row.session_id} RETURNING id`.pipe(
					Effect.map((rows) => rows.map(({ id }) => id)),
				),
			);
	}).pipe(Effect.mapError(toStoreFault));

// From 32.5 a joined steer's command settles under its own run while its owner's Run is open;
// its hold is its own run's (4.8; CONTRACT 1555-1556, 1868-1869).
export const settleSend = (
	tx: SettlementTx,
	evidence: SendEvidence,
): Effect.Effect<void, StoreFault> =>
	Effect.gen(function* () {
		let normalized: NormalizedTerminalEvidence;
		if (evidence._tag === "journal_finished") {
			const { answer } = evidence;
			if (
				answer.result?.nativeResumeRejected ||
				isClaudeResumeRefused(answer.failure ?? answer.result?.error)
			)
				return;
			const result = answer.failure
				? terminalFailureResult(answer.failure)
				: terminalTurnResult(answer.result);
			if (!result) return;
			normalized = { _tag: "journal_finished", result };
		} else normalized = evidence;
		const { send } = evidence;
		const { sql } = tx;
		const [row] = yield* sql<{
			request_sequence: number;
			project_key: string;
			session_id: string;
			command_id: string;
			attempt_count: number;
			provider_id: string;
			run_id: string;
			payload_json: string;
			runner_id: string | null;
			held_transmission: number | null;
		}>`SELECT command.request_sequence, command.project_key, command.session_id,
			command.command_id, command.attempt_count, command.provider_id,
			command.run_id, command.payload_json, run.runner_id, run.held_transmission
			FROM provider_command_outbox command JOIN provider_runs run
				ON run.id = command.run_id AND run.session_id = command.session_id
			JOIN provider_runs owner ON owner.id = COALESCE(run.joined_into, run.id) AND owner.session_id = run.session_id
			JOIN sessions session ON session.id = command.session_id AND session.project_id = command.project_key
			WHERE command.request_sequence = ${send.requestSequence}
				AND command.session_id = ${send.sessionId} AND command.command_id = ${send.commandId}
				AND command.attempt_count = ${send.attempt} AND run.id = ${send.runId}
				AND owner.status IN ('pending', 'running')
				AND command.effect_type = 'send_turn'
				AND command.request_sequence = (SELECT MAX(latest.request_sequence)
					FROM provider_command_outbox latest WHERE latest.project_key = command.project_key
					AND latest.command_id = command.command_id)`;
		if (!row) return;
		if ("runnerId" in send) {
			if (
				row.runner_id !== send.runnerId ||
				row.held_transmission !== send.transmission
			)
				return;
		} else if (row.runner_id !== null || row.held_transmission !== null) return;
		const outcome = classify(normalized);
		yield* appendSendSettlement(
			tx,
			row,
			normalized,
			outcome,
			evidence.observedAt,
		);
		yield* tx.stamp((version) =>
			sql<{ id: string }>`UPDATE sessions SET version = ${version}
				WHERE id = ${send.sessionId} RETURNING id`.pipe(
				Effect.map((rows) => rows.map(({ id }) => id)),
			),
		);
	}).pipe(Effect.mapError(toStoreFault));

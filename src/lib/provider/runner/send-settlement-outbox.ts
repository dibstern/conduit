import { Brand, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { recordClaudeNativeResumeFallback } from "../claude/prepare-turn.js";
import { isClaudeResumeRefused } from "../event-sink-errors.js";
import type { TurnResult } from "../types.js";
import {
	legacyRunnerRunQuery,
	type runningRunnerCommands,
	settleRunnerCommandReply,
} from "./runner-recovery.js";
import {
	classify,
	type NormalizedTerminalEvidence,
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
									outcome === "cancelled"
										? "interrupted"
										: evidence.reason._tag === "ProjectRemoved"
											? "runner_stopped"
											: "provider_error",
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
				AND NOT EXISTS (SELECT 1 FROM events WHERE session_id = command.session_id
					AND json_extract(data, '$.runId') = owner.id
					AND (type = 'run.released' OR (type = 'run.dispatched' AND json_extract(data, '$.commandId') IS NOT NULL)))`;
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

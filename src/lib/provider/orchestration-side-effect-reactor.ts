import { Clock, Data, Duration, Effect } from "effect";
import type { ProviderRuntimeIngestion } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import type { SqliteClient } from "../persistence/sqlite-client.js";
import { ProviderInstanceFailure, ProviderNotRegistered } from "./errors.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { EventSink, SendTurnInput, TurnResult } from "./types.js";

/**
 * Synthesized completion result for effects that produce no provider
 * `TurnResult` (interrupt) or for an idempotent replay where the row was
 * already executed. Provider state flows back through send_turn results.
 */
const REACTOR_COMPLETED_RESULT: TurnResult = {
	status: "completed",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
};

interface ProviderCommandOutboxRow {
	readonly request_sequence: number;
	readonly command_id: string;
	readonly project_key: string;
	readonly session_id: string;
	readonly provider_id: string;
	readonly effect_type: string;
	readonly payload_json: string;
	readonly attempt_count: number;
}

interface SendTurnOutboxPayload
	extends Omit<SendTurnInput, "eventSink" | "abortSignal"> {}

class UnknownProviderCommandEffect extends Data.TaggedError(
	"UnknownProviderCommandEffect",
)<{
	readonly effectType: string;
	readonly code: "unknown_provider_command_effect";
}> {
	get message(): string {
		return `Unknown provider command effect: ${this.effectType}`;
	}
}

class ProviderCommandStoreFailure extends Data.TaggedError(
	"ProviderCommandStoreFailure",
)<{
	readonly operation: string;
	readonly code: "provider_command_store_failure";
	readonly cause: unknown;
}> {
	get message(): string {
		return `Provider command store operation failed: ${this.operation}`;
	}
}

class ProviderCommandPayloadParseFailed extends Data.TaggedError(
	"ProviderCommandPayloadParseFailed",
)<{
	readonly requestSequence: number;
	readonly commandId: string;
	readonly code: "provider_command_payload_parse_failed";
	readonly cause: unknown;
}> {
	get message(): string {
		return `Provider command payload parse failed: ${this.commandId}`;
	}
}

class ProviderSideEffectInteractionUnsupported extends Data.TaggedError(
	"ProviderSideEffectInteractionUnsupported",
)<{
	readonly operation: "requestPermission" | "requestQuestion";
	readonly code: "provider_side_effect_interaction_unsupported";
}> {
	get message(): string {
		return `Provider side-effect reactor cannot ${this.operation}`;
	}
}

class ProviderCommandNotExecutable extends Data.TaggedError(
	"ProviderCommandNotExecutable",
)<{
	readonly commandId: string;
	readonly errorCode: string | null;
	readonly code: "provider_command_not_executable";
}> {
	get message(): string {
		return `Provider command is no longer executable: ${this.commandId}`;
	}
}

export interface ProviderSideEffectReactorOptions {
	readonly db: SqliteClient;
	readonly registry: ProviderRegistry;
	readonly ingestion: Pick<ProviderRuntimeIngestion, "ingest">;
	/** Optional deterministic override; defaults to the Effect Clock service. */
	readonly nowMs?: () => number;
	readonly retryBackoff?: (failureCount: number) => Duration.DurationInput;
}

const defaultRetryBackoff = (failureCount: number): Duration.DurationInput =>
	Duration.millis(Math.min(1000 * 2 ** Math.max(0, failureCount - 1), 30_000));

export class ProviderSideEffectReactor {
	constructor(private readonly options: ProviderSideEffectReactorOptions) {}

	drain(): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			while (true) {
				const processed = yield* this.runOnce();
				if (processed === 0) return;
			}
		});
	}

	runOnce(): Effect.Effect<number, unknown> {
		return Effect.gen(this, function* () {
			const now = yield* this.currentTimeMillis();
			const row = yield* this.nextPendingRequest(now);
			if (!row) return 0;
			// Recovery / background path: no waiter, so the row outcome is recorded
			// durably and swallowed here.
			yield* Effect.either(this.executeRow(row));
			return 1;
		});
	}

	/**
	 * Execute a single committed command by id and surface its provider result
	 * to a same-process waiter. Shares the single executor (`executeRow`) with
	 * `drain()`; provider execution is idempotent via the `markRunning` status
	 * guard. When the row is no longer pending (already drained), the durable
	 * receipt supplies the outcome.
	 */
	runCommand(commandId: string): Effect.Effect<TurnResult, unknown> {
		return Effect.gen(this, function* () {
			const row = yield* this.pendingRequestForCommand(commandId);
			if (row) return yield* this.executeRow(row);

			const receipt = yield* this.receiptOutcome(commandId);
			if (receipt?.status === "side_effect_completed") {
				return REACTOR_COMPLETED_RESULT;
			}
			return yield* Effect.fail(
				new ProviderCommandNotExecutable({
					commandId,
					errorCode: receipt?.error_code ?? null,
					code: "provider_command_not_executable",
				}),
			);
		});
	}

	/**
	 * Single provider executor: claim the row, run the provider effect, and
	 * record completion or (retryable) failure. Returns the provider `TurnResult`
	 * (carrying provider-state updates) on success; fails with the provider error
	 * on failure so the caller can surface it to a waiter.
	 */
	private executeRow(
		row: ProviderCommandOutboxRow,
	): Effect.Effect<TurnResult, unknown> {
		return Effect.gen(this, function* () {
			const startedAt = yield* this.currentTimeMillis();
			yield* this.markRunning(row, startedAt);
			const result = yield* Effect.either(this.runProviderEffect(row));
			if (result._tag === "Left") {
				const failedAt = yield* this.currentTimeMillis();
				yield* this.markFailed(row, result.left, failedAt);
				return yield* Effect.fail(result.left);
			}
			const completedAt = yield* this.currentTimeMillis();
			yield* this.markCompleted(row, completedAt);
			return result.right;
		});
	}

	private currentTimeMillis(): Effect.Effect<number> {
		return this.options.nowMs
			? Effect.sync(this.options.nowMs)
			: Clock.currentTimeMillis;
	}

	private nextPendingRequest(
		nowMs: number,
	): Effect.Effect<
		ProviderCommandOutboxRow | undefined,
		ProviderCommandStoreFailure
	> {
		return Effect.try({
			try: () =>
				this.options.db.queryOne<ProviderCommandOutboxRow>(
					`SELECT request_sequence, command_id, project_key, session_id, provider_id,
					        effect_type, payload_json, attempt_count
					 FROM provider_command_outbox
					 WHERE status = 'pending'
					    OR (status = 'retryable_failed' AND next_attempt_at <= ?)
					 ORDER BY request_sequence
					 LIMIT 1`,
					[nowMs],
				),
			catch: (cause) =>
				new ProviderCommandStoreFailure({
					operation: "nextPendingRequest",
					code: "provider_command_store_failure",
					cause,
				}),
		});
	}

	private markRunning(
		row: ProviderCommandOutboxRow,
		updatedAt: number,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		return Effect.try({
			try: () => {
				this.options.db.execute(
					`UPDATE provider_command_outbox
					 SET status = 'running',
					     attempt_count = attempt_count + 1,
					     next_attempt_at = NULL,
					     updated_at = ?
					 WHERE request_sequence = ?
					   AND status IN ('pending', 'retryable_failed')`,
					[updatedAt, row.request_sequence],
				);
			},
			catch: (cause) =>
				new ProviderCommandStoreFailure({
					operation: "markRunning",
					code: "provider_command_store_failure",
					cause,
				}),
		});
	}

	private runProviderEffect(
		row: ProviderCommandOutboxRow,
	): Effect.Effect<TurnResult, unknown> {
		return Effect.gen(this, function* () {
			const instance = yield* this.options.registry.getInstanceEffect(
				row.provider_id,
			);

			if (row.effect_type === "send_turn") {
				const payload = yield* this.parseSendTurnPayload(row);
				return yield* instance.sendTurnEffect({
					...payload,
					eventSink: this.makeIngestionEventSink(),
					abortSignal: new AbortController().signal,
				});
			}
			if (row.effect_type === "interrupt_turn") {
				yield* instance.interruptTurnEffect(row.session_id);
				return REACTOR_COMPLETED_RESULT;
			}
			return yield* Effect.fail(
				new UnknownProviderCommandEffect({
					effectType: row.effect_type,
					code: "unknown_provider_command_effect",
				}),
			);
		});
	}

	private pendingRequestForCommand(
		commandId: string,
	): Effect.Effect<
		ProviderCommandOutboxRow | undefined,
		ProviderCommandStoreFailure
	> {
		return Effect.try({
			try: () =>
				this.options.db.queryOne<ProviderCommandOutboxRow>(
					`SELECT request_sequence, command_id, project_key, session_id, provider_id,
					        effect_type, payload_json, attempt_count
					 FROM provider_command_outbox
					 WHERE command_id = ? AND status IN ('pending', 'retryable_failed')
					 ORDER BY request_sequence
					 LIMIT 1`,
					[commandId],
				),
			catch: (cause) =>
				new ProviderCommandStoreFailure({
					operation: "pendingRequestForCommand",
					code: "provider_command_store_failure",
					cause,
				}),
		});
	}

	private receiptOutcome(
		commandId: string,
	): Effect.Effect<
		{ readonly status: string; readonly error_code: string | null } | undefined,
		ProviderCommandStoreFailure
	> {
		return Effect.try({
			try: () =>
				this.options.db.queryOne<{
					readonly status: string;
					readonly error_code: string | null;
				}>(
					"SELECT status, error_code FROM command_receipts WHERE command_id = ?",
					[commandId],
				),
			catch: (cause) =>
				new ProviderCommandStoreFailure({
					operation: "receiptOutcome",
					code: "provider_command_store_failure",
					cause,
				}),
		});
	}

	private parseSendTurnPayload(
		row: ProviderCommandOutboxRow,
	): Effect.Effect<SendTurnOutboxPayload, ProviderCommandPayloadParseFailed> {
		const toParseFailure = (cause: unknown) =>
			new ProviderCommandPayloadParseFailed({
				requestSequence: row.request_sequence,
				commandId: row.command_id,
				code: "provider_command_payload_parse_failed",
				cause,
			});

		return Effect.try({
			try: (): unknown => JSON.parse(row.payload_json),
			catch: toParseFailure,
		}).pipe(
			Effect.flatMap((payload) =>
				isSendTurnOutboxPayload(payload)
					? Effect.succeed(payload)
					: Effect.fail(toParseFailure("Invalid send_turn outbox payload")),
			),
		);
	}

	private markCompleted(
		row: ProviderCommandOutboxRow,
		updatedAt: number,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		return Effect.try({
			try: () => {
				this.options.db.runInTransaction(() => {
					this.options.db.execute(
						`UPDATE provider_command_outbox
						 SET status = 'completed', updated_at = ?
						 WHERE request_sequence = ?`,
						[updatedAt, row.request_sequence],
					);
					this.options.db.execute(
						`UPDATE command_receipts
						 SET status = 'side_effect_completed', updated_at = ?
						 WHERE command_id = ?`,
						[updatedAt, row.command_id],
					);
				});
			},
			catch: (cause) =>
				new ProviderCommandStoreFailure({
					operation: "markCompleted",
					code: "provider_command_store_failure",
					cause,
				}),
		});
	}

	private markFailed(
		row: ProviderCommandOutboxRow,
		error: unknown,
		updatedAt: number,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		const retryable = isRetryableProviderFailure(error);
		const retryBackoff = this.options.retryBackoff ?? defaultRetryBackoff;
		const nextAttemptAt = retryable
			? updatedAt + Duration.toMillis(retryBackoff(row.attempt_count + 1))
			: null;
		const errorCode = providerFailureCode(error);
		return Effect.try({
			try: () => {
				this.options.db.runInTransaction(() => {
					this.options.db.execute(
						`UPDATE provider_command_outbox
						 SET status = ?,
						     error_code = ?,
						     next_attempt_at = ?,
						     updated_at = ?
						 WHERE request_sequence = ?`,
						[
							retryable ? "retryable_failed" : "failed",
							errorCode,
							nextAttemptAt,
							updatedAt,
							row.request_sequence,
						],
					);
					this.options.db.execute(
						`UPDATE command_receipts
						 SET status = 'side_effect_failed', error_code = ?, updated_at = ?
						 WHERE command_id = ?`,
						[errorCode, updatedAt, row.command_id],
					);
				});
			},
			catch: (cause) =>
				new ProviderCommandStoreFailure({
					operation: "markFailed",
					code: "provider_command_store_failure",
					cause,
				}),
		});
	}

	private makeIngestionEventSink(): EventSink {
		return {
			push: (event) => this.options.ingestion.ingest(event).pipe(Effect.asVoid),
			requestPermission: () =>
				Effect.fail(
					new ProviderSideEffectInteractionUnsupported({
						operation: "requestPermission",
						code: "provider_side_effect_interaction_unsupported",
					}),
				),
			requestQuestion: () =>
				Effect.fail(
					new ProviderSideEffectInteractionUnsupported({
						operation: "requestQuestion",
						code: "provider_side_effect_interaction_unsupported",
					}),
				),
			resolvePermission: () => Effect.void,
			resolveQuestion: () => Effect.void,
		};
	}
}

function isRetryableProviderFailure(error: unknown): boolean {
	if (error instanceof ProviderInstanceFailure) {
		return isRecord(error.cause) && error.cause["retryable"] === true;
	}
	return isRecord(error) && error["retryable"] === true;
}

function providerFailureCode(error: unknown): string {
	if (error instanceof ProviderInstanceFailure) {
		return providerFailureCode(error.cause);
	}
	if (isRecord(error)) {
		const code = error["code"];
		if (typeof code === "string" && code.length > 0) return code;
		const tag = error["_tag"];
		if (tag === "ProviderNotRegistered") return "provider_not_registered";
	}
	if (error instanceof ProviderNotRegistered) return "provider_not_registered";
	return "provider_failure";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isSendTurnOutboxPayload(
	value: unknown,
): value is SendTurnOutboxPayload {
	if (!isRecord(value)) return false;
	return (
		typeof value["sessionId"] === "string" &&
		typeof value["turnId"] === "string" &&
		typeof value["prompt"] === "string" &&
		Array.isArray(value["history"]) &&
		isRecord(value["providerState"]) &&
		typeof value["workspaceRoot"] === "string"
	);
}

import { randomUUID } from "node:crypto";
import {
	Clock,
	Data,
	Duration,
	Effect,
	Fiber,
	Option,
	Schema,
	Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";
import { AccountSchema } from "../contracts/account.js";
import { getProviderDriver } from "../contracts/provider-instance.js";
import type { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import { mark } from "../domain/daemon/Services/turn-timeline.js";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import type { ProviderRuntimeIngestion } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { PROCESSING_TIMEOUT_DURATION } from "../domain/relay/Services/session-overrides-state.js";
import * as Failure from "../effect/failure-classification.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
} from "../persistence/effect/claude-event-persist-effect.js";
import type { CommitAndSignal } from "../persistence/effect/commit-and-signal.js";
import { makeEventStoreEffect } from "../persistence/effect/event-store-effect.js";
import { requeueFailedSteers } from "../persistence/effect/input-requeue-effect.js";
import {
	makeProviderStateEffect,
	ProviderStateEffectTag,
} from "../persistence/effect/provider-state-effect.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../persistence/events.js";
import { normalizeClaudeLaunchInput } from "./claude/claude-runner-wire.js";
import type { ClaudeLaunchConfig } from "./claude/claude-sdk-env.js";
import type { ClaudeSessionForkSdk } from "./claude/claude-session-fork.js";
import {
	type PreparedTurn,
	sendPreparedClaudeTurn,
} from "./claude/prepare-turn.js";
import { ProviderInstanceFailure, ProviderNotRegistered } from "./errors.js";
import type { ProviderCallRequest } from "./orchestration-engine.js";
import type { ProviderRegistry } from "./provider-registry.js";
import { toEventSinkError } from "./relay-event-sink.js";
import type {
	EventSink,
	ProviderCall,
	SendTurnInput,
	TurnResult,
} from "./types.js";

/**
 * Synthesized completion result for effects that produce no provider
 * `TurnResult` (interrupt) or for an idempotent replay where the row was
 * already executed. Provider state follows the projected terminal event.
 */
const REACTOR_COMPLETED_RESULT: TurnResult = {
	status: "completed",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
};

export type ProviderCommandInteractionSinkFactory = (
	sessionId: string,
	driver: string,
) => EventSink;

interface ProviderCommandOutboxRow {
	readonly request_sequence: number;
	readonly command_id: string;
	readonly project_key: string;
	readonly session_id: string;
	readonly provider_id: string;
	readonly effect_type: string;
	readonly payload_json: string;
	readonly run_id: string | null;
	readonly attempt_count: number;
}

interface SendTurnOutboxPayload
	extends Omit<
		SendTurnInput,
		"eventSink" | "abortSignal" | "history" | "awaitIntake"
	> {
	readonly history?: SendTurnInput["history"];
}

type LiveSendContext = Pick<SendTurnInput, "account" | "shellEnv">;

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

export class ProviderCommandStoreFailure extends Data.TaggedError(
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

export class ProviderSideEffectInteractionUnsupported extends Data.TaggedError(
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

type ProviderCommandExecutionError =
	| ProviderCommandStoreFailure
	| ProviderCommandNotExecutable
	| ProviderCommandPayloadParseFailed
	| UnknownProviderCommandEffect
	| ProviderNotRegistered
	| ProviderInstanceFailure;

export interface ProviderSideEffectReactorOptions {
	readonly projectId: string;
	readonly sql: SqlClient.SqlClient;
	readonly registry: ProviderRegistry;
	readonly ingestion: Pick<ProviderRuntimeIngestion, "ingest" | "ingestBatch">;
	readonly write: CommitAndSignal["write"];
	readonly persistUserMessage?: ClaudeEventPersistEffect["persistUserMessage"];
	readonly claudeSessionForkSdk?: ClaudeSessionForkSdk;
	readonly defaultClaudeLaunchConfig?: () => ClaudeLaunchConfig;
	readonly resolveSessionCallContext?: (
		sessionId: string,
		runId: string | undefined,
	) => Effect.Effect<ProviderCall | undefined, ProviderInstanceFailure>;
	readonly resolveCallContext?: (
		request: ProviderCallRequest,
	) => Effect.Effect<ProviderCall, ProviderInstanceFailure>;
	/** Optional deterministic override; defaults to the Effect Clock service. */
	readonly nowMs?: () => number;
	readonly retryBackoff?: (failureCount: number) => Duration.Input;
	readonly outcomePollInterval?: Duration.Input;
	readonly outcomePollTimeout?: Duration.Input;
	readonly accountDirectory?: Pick<
		AccountDirectory["Service"],
		"resolve" | "defaultFor"
	>;
}

const defaultRetryBackoff = (failureCount: number): Duration.Input =>
	Duration.millis(Math.min(1000 * 2 ** Math.max(0, failureCount - 1), 30_000));
const defaultOutcomePollInterval: Duration.Input = Duration.millis(500);

function clampPollDuration(
	duration: Duration.Input,
	minimumMillis: number,
): Duration.Duration {
	const millis = Duration.toMillis(duration);
	return Duration.millis(
		Number.isFinite(millis)
			? Math.min(Math.max(millis, minimumMillis), Number.MAX_SAFE_INTEGER)
			: minimumMillis,
	);
}

const storeFailure =
	(operation: string) =>
	(cause: unknown): ProviderCommandStoreFailure =>
		new ProviderCommandStoreFailure({
			operation,
			code: "provider_command_store_failure",
			cause,
		});

export class ProviderSideEffectReactor {
	private readonly liveCommands = new Set<string>();
	private readonly drainingSessions = new Set<string>();
	private readonly admission = Semaphore.makeUnsafe(1);

	constructor(private readonly options: ProviderSideEffectReactorOptions) {}

	/** Reserve before commit; the short lock also fences an asynchronous claim. */
	withLiveCommand<A, E, R>(commandId: string, effect: Effect.Effect<A, E, R>) {
		return Effect.acquireUseRelease(
			this.admission.withPermit(
				Effect.sync(() => {
					this.liveCommands.add(commandId);
				}),
			),
			() => effect,
			() =>
				Effect.sync(() => {
					this.liveCommands.delete(commandId);
				}),
		);
	}

	drain(
		makeInteractions?: ProviderCommandInteractionSinkFactory,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		return Effect.gen({ self: this }, function* () {
			const heads = yield* this.nextPendingRequests();
			yield* Effect.forEach(
				heads,
				(head) =>
					this.withDrainSession(
						head.session_id,
						Effect.gen({ self: this }, function* () {
							let row: ProviderCommandOutboxRow | undefined = head;
							while (row) {
								if ((yield* this.runBackgroundRow(row, makeInteractions)) === 0)
									return;
								row = (yield* this.nextPendingRequests(head.session_id))[0];
							}
						}),
					).pipe(
						// A failed session must not interrupt another session's live turn.
						Effect.catchCause((cause) =>
							Failure.isInterruptedOnly(cause)
								? Effect.interrupt
								: Effect.logError(
										"Provider command outbox drain failed",
										cause,
									),
						),
					),
				{ concurrency: Math.max(1, heads.length), discard: true },
			);
		});
	}

	private withDrainSession<A, E, R>(
		sessionId: string,
		effect: Effect.Effect<A, E, R>,
	) {
		return Effect.acquireUseRelease(
			Effect.sync(() => {
				if (this.drainingSessions.has(sessionId)) return false;
				this.drainingSessions.add(sessionId);
				return true;
			}),
			(acquired) => (acquired ? effect : Effect.succeed(undefined)),
			(acquired) =>
				Effect.sync(() => {
					if (acquired) this.drainingSessions.delete(sessionId);
				}),
		);
	}

	runOnce(
		makeInteractions?: ProviderCommandInteractionSinkFactory,
	): Effect.Effect<number, ProviderCommandStoreFailure> {
		return Effect.gen({ self: this }, function* () {
			const row = (yield* this.nextPendingRequests())[0];
			if (!row) return 0;
			return (
				(yield* this.withDrainSession(
					row.session_id,
					this.runBackgroundRow(row, makeInteractions),
				)) ?? 0
			);
		});
	}

	private runBackgroundRow(
		row: ProviderCommandOutboxRow,
		makeInteractions?: ProviderCommandInteractionSinkFactory,
	): Effect.Effect<number, ProviderCommandStoreFailure> {
		return Effect.gen({ self: this }, function* () {
			if (this.liveCommands.has(row.command_id)) return 0;
			// Recovery / background path: no waiter, so the row outcome is recorded
			// durably and swallowed here.
			const result = yield* Effect.result(
				this.executeRow(row, { makeInteractions, background: true }),
			);
			// Store failures may leave the row executable. Let the scheduler log
			// and delay; retrying it inside drain's loop would spin without backoff.
			if (
				result._tag === "Failure" &&
				result.failure instanceof ProviderCommandStoreFailure
			) {
				return yield* Effect.fail(result.failure);
			}
			if (
				result._tag === "Success" &&
				result.success.status === "steer-declined"
			) {
				const persist = yield* Effect.serviceOption(
					ClaudeEventPersistEffectTag,
				);
				if (persist._tag === "Some")
					yield* requeueFailedSteers(
						this.options.sql,
						persist.value,
						row.session_id,
						row.command_id,
					).pipe(Effect.mapError(storeFailure("requeueDeclinedSteer")));
			}
			return 1;
		});
	}

	/**
	 * Execute a single committed command by id and await its durable receipt
	 * to a same-process waiter. Shares the single executor (`executeRow`) with
	 * `drain()`; provider execution is idempotent via the `markRunning` status
	 * guard. When the row is no longer pending (already drained), the durable
	 * receipt supplies the outcome.
	 *
	 * `interactions` is the caller's real interaction-capable event sink for the
	 * same-process dispatch path. Provider output still streams to the durable
	 * ProviderRuntimeIngestion, but permission/question requests route through
	 * this sink so Claude tool approvals and `AskUserQuestion` behave exactly as
	 * the inline path did. Production drains create their sink through the same
	 * relay factory for unowned commands recovered from a previous process.
	 */
	runCommand(
		commandId: string,
		interactions?: EventSink,
		abortSignal?: AbortSignal,
		liveContext?: LiveSendContext,
	): Effect.Effect<TurnResult, ProviderCommandExecutionError> {
		return Effect.gen({ self: this }, function* () {
			const row = yield* this.pendingRequestForCommand(commandId);
			if (row) {
				const delivery = this.executeRow(row, {
					interactions,
					abortSignal,
					liveContext,
				});
				if (row.effect_type !== "send_turn") return yield* delivery;
				return yield* delivery.pipe(
					Effect.flatMap((result) =>
						result.status === "indeterminate"
							? Effect.succeed(result)
							: this.durableOutcome(commandId),
					),
				);
			}
			return yield* this.durableOutcome(commandId);
		});
	}

	/**
	 * Claim and execute once. Send lifecycle follows projected run events;
	 * the adapter result only releases its in-process waiter.
	 */
	private executeRow(
		row: ProviderCommandOutboxRow,
		options?: {
			interactions?: EventSink | undefined;
			makeInteractions?: ProviderCommandInteractionSinkFactory | undefined;
			abortSignal?: AbortSignal | undefined;
			background?: boolean;
			liveContext?: LiveSendContext | undefined;
		},
	): Effect.Effect<TurnResult, ProviderCommandExecutionError> {
		return Effect.gen({ self: this }, function* () {
			const startedAt = yield* this.currentTimeMillis();
			// The `pending -> running` update is the exclusive execution claim.
			// If it changes no rows another executor already claimed this row, so
			// do NOT run the provider effect; surface the durable outcome instead.
			const claimed = yield* options?.background
				? this.admission.withPermit(
						Effect.suspend(() =>
							this.liveCommands.has(row.command_id)
								? Effect.succeed(undefined)
								: this.markRunning(row, startedAt),
						),
					)
				: this.markRunning(row, startedAt);
			if (claimed === undefined) {
				if (options?.background) return REACTOR_COMPLETED_RESULT;
				this.liveCommands.delete(row.command_id);
				return yield* this.durableOutcome(row.command_id);
			}
			row = claimed;
			const cancellation = new AbortController();
			const delivery = this.runProviderEffect(
				row,
				options?.interactions,
				options?.makeInteractions,
				options?.abortSignal
					? AbortSignal.any([options.abortSignal, cancellation.signal])
					: cancellation.signal,
				options?.liveContext,
			);
			const result = yield* Effect.result(
				row.effect_type !== "send_turn"
					? delivery
					: Effect.gen({ self: this }, function* () {
							const pending = yield* Effect.forkChild(delivery);
							const wait = Fiber.join(pending);
							// Recall only Conduit's queue. Missing acknowledgement is uncertainty,
							// never permission to cancel native work or retry the command.
							const recall = Effect.sync(() => cancellation.abort()).pipe(
								Effect.andThen(wait),
								Effect.timeoutOrElse({
									duration: "1 second",
									orElse: () =>
										Effect.succeed({
											...REACTOR_COMPLETED_RESULT,
											status: "indeterminate" as const,
										}),
								}),
							);
							return yield* Effect.raceFirst(
								wait,
								this.durableOutcome(row.command_id).pipe(
									Effect.flatMap((outcome) =>
										outcome.error ? recall.pipe(Effect.as(outcome)) : wait,
									),
								),
							).pipe(
								Effect.timeoutOrElse({
									duration: PROCESSING_TIMEOUT_DURATION,
									orElse: () =>
										recall.pipe(
											Effect.flatMap((ack) =>
												ack.status !== "cancelled"
													? Effect.succeed({
															...REACTOR_COMPLETED_RESULT,
															status: "indeterminate" as const,
														})
													: Effect.fail(
															new ProviderInstanceFailure({
																providerId: row.provider_id,
																operation: "awaitIntake",
																cause: Object.assign(
																	new Error("Input recalled before intake"),
																	{
																		code: "processing_timeout",
																		retryable: false,
																	},
																),
															}),
														),
											),
										),
								}),
							);
						}),
			);
			if (
				row.effect_type === "send_turn" &&
				result._tag === "Success" &&
				result.success.status === "indeterminate"
			) {
				yield* this.options
					.write((_project, stamp) =>
						Effect.gen({ self: this }, function* () {
							const marked = yield* this.options
								.sql`UPDATE provider_command_outbox
						SET error_code = 'delivery_indeterminate' WHERE request_sequence = ${row.request_sequence}
						AND status = 'running' AND attempt_count = ${row.attempt_count} RETURNING command_id`;
							if (marked.length) {
								yield* this.options
									.sql`UPDATE command_receipts SET error_code = 'delivery_indeterminate'
						WHERE command_id = ${row.command_id} AND project_key = ${this.options.projectId} AND status = 'side_effect_requested'`;
								yield* stamp((version) =>
									this.options.sql<{
										id: string;
									}>`UPDATE sessions SET version = ${version} WHERE id = ${row.session_id} RETURNING id`.pipe(
										Effect.map((rows) => rows.map(({ id }) => id)),
									),
								);
							}
						}),
					)
					.pipe(Effect.mapError(storeFailure("indeterminate")));
				return yield* this.durableOutcome(row.command_id);
			}
			const failure = result._tag === "Failure" ? result.failure : undefined;
			const turn = result._tag === "Success" ? result.success : undefined;
			if (
				failure ||
				turn?.status === "cancelled" ||
				turn?.status === "steer-declined" ||
				(row.effect_type !== "send_turn" &&
					turn?.status !== "completed" &&
					turn?.status !== "joined")
			) {
				if (row.effect_type === "send_turn") {
					const receipt = yield* this.receiptOutcome(row.command_id);
					if (
						receipt?.status === "side_effect_completed" ||
						receipt?.status === "side_effect_failed"
					)
						return yield* this.durableOutcome(row.command_id);
				}
				const failedAt = yield* this.currentTimeMillis();
				const cause =
					failure instanceof ProviderInstanceFailure ? failure.cause : failure;
				const retryable = failure
					? isRetryableProviderFailure(failure)
					: turn?.status !== "steer-declined" &&
						turn?.error?.retryable === true &&
						turn.error.retryHandled !== true;
				const code = failure
					? providerFailureCode(failure)
					: (turn?.error?.code ?? turn?.status ?? "provider_failure");
				const retryAt = retryable
					? failedAt +
						Duration.toMillis(
							(this.options.retryBackoff ?? defaultRetryBackoff)(
								row.attempt_count,
							),
						)
					: undefined;
				if (row.effect_type === "send_turn") {
					const [owner] = yield* this.options.sql<{
						run_id: string;
					}>`
						SELECT COALESCE(joined_into, id) AS run_id
						FROM provider_runs WHERE id = ${row.run_id} AND session_id = ${row.session_id}`.pipe(
						Effect.mapError(storeFailure("failedRunOwner")),
					);
					const interrupted =
						code === "interrupted" || turn?.status === "steer-declined";
					const [placement] = yield* this.options.sql<{
						placed: number;
						steering: number;
					}>`SELECT
						EXISTS (SELECT 1 FROM turns WHERE session_id = ${row.session_id}
							AND run_id = ${owner?.run_id ?? null}) AS placed,
						EXISTS (SELECT 1 FROM pending_inputs WHERE session_id = ${row.session_id}
							AND input_id = ${row.command_id} AND state = 'steering') AS steering`.pipe(
						Effect.mapError(storeFailure("failedPlacement")),
					);
					const payload =
						this.options.persistUserMessage &&
						!placement?.placed &&
						!placement?.steering &&
						!interrupted
							? yield* this.parseSendTurnPayload(row).pipe(
									Effect.orElseSucceed(() => undefined),
								)
							: undefined;
					if (owner && payload && this.options.persistUserMessage) {
						const driver = payload.account?.driver ?? row.provider_id;
						yield* this.options
							.persistUserMessage(row.session_id, payload.prompt, {
								messageId:
									payload.continuation?.cutOffMessageId ??
									this.options.registry
										.getInstance(driver)
										?.userMessageIdForInput?.(payload.inputId) ??
									payload.inputId,
								inputId: payload.inputId,
								runId: owner.run_id,
								provider: driver,
								...(payload.images ? { images: payload.images } : {}),
								failure: {
									message:
										cause instanceof Error
											? cause.message
											: (turn?.error?.message ?? code),
									code,
									retryable,
									retryAt,
								},
							})
							.pipe(Effect.mapError(storeFailure("failedPlacement")));
					} else if (owner)
						yield* this.options.ingestion
							.ingest({
								eventId: `provider-command-terminal:${row.request_sequence}:${claimed.attempt_count}`,
								type:
									code === "interrupted" || turn?.status === "steer-declined"
										? "turn.interrupted"
										: "turn.error",
								providerId: row.provider_id,
								sessionId: row.session_id,
								runId: owner.run_id,
								providerRefs: {},
								rawSource: { kind: "conduit.provider-command" },
								createdAt: failedAt,
								data: {
									messageId: `provider-command:${row.command_id}`,
									error:
										cause instanceof Error
											? cause.message
											: (turn?.error?.message ?? code),
									code,
									retryable,
									retryAt,
								},
							})
							.pipe(Effect.mapError(storeFailure("failedRun")));
				} else yield* this.writeFailure(row, retryable, code, failedAt);
			} else if (row.effect_type !== "send_turn")
				yield* this.markCompleted(row, yield* this.currentTimeMillis());
			if (result._tag === "Failure") {
				if (row.effect_type !== "send_turn")
					return yield* Effect.fail(result.failure);
				return { ...REACTOR_COMPLETED_RESULT, status: "error" };
			}
			return result.success;
		});
	}

	/**
	 * Durable outcome for a command that this fiber did not execute (lost the
	 * `markRunning` claim, or the row was already drained): terminal receipts
	 * replay the winner's outcome, while a present non-terminal receipt is
	 * polled until the owned run transition settles it (or an explicit deadline).
	 */
	private durableOutcome(
		commandId: string,
	): Effect.Effect<
		TurnResult,
		ProviderCommandStoreFailure | ProviderCommandNotExecutable
	> {
		return Effect.gen({ self: this }, function* () {
			const pollInterval = clampPollDuration(
				this.options.outcomePollInterval ?? defaultOutcomePollInterval,
				1,
			);
			const maxPolls =
				this.options.outcomePollTimeout === undefined
					? Infinity
					: Math.ceil(
							Duration.toMillis(
								clampPollDuration(this.options.outcomePollTimeout, 0),
							) / Duration.toMillis(pollInterval),
						);

			for (let poll = 0; poll <= maxPolls; poll += 1) {
				const receipt = yield* this.receiptOutcome(commandId);
				if (!receipt) {
					return yield* this.commandNotExecutable(commandId, null);
				}
				if (receipt.status === "side_effect_completed") {
					return REACTOR_COMPLETED_RESULT;
				}
				if (receipt.status === "side_effect_failed") {
					if (receipt.error_code === "steer-declined")
						return { ...REACTOR_COMPLETED_RESULT, status: "steer-declined" };
					return {
						...REACTOR_COMPLETED_RESULT,
						status:
							receipt.run_status === "interrupted" ? "interrupted" : "error",
						error: {
							code: receipt.error_code ?? "provider_error",
							message: receipt.error_code ?? "Provider command failed",
						},
					};
				}
				if (receipt.error_code === "delivery_indeterminate")
					return { ...REACTOR_COMPLETED_RESULT, status: "indeterminate" };
				if (poll === maxPolls) {
					return yield* this.commandNotExecutable(commandId, null);
				}
				yield* Effect.sleep(pollInterval);
			}

			return yield* this.commandNotExecutable(commandId, null);
		});
	}

	private commandNotExecutable(
		commandId: string,
		errorCode: string | null,
	): Effect.Effect<never, ProviderCommandNotExecutable> {
		return Effect.fail(
			new ProviderCommandNotExecutable({
				commandId,
				errorCode,
				code: "provider_command_not_executable",
			}),
		);
	}

	private currentTimeMillis(): Effect.Effect<number> {
		return this.options.nowMs
			? Effect.sync(this.options.nowMs)
			: Clock.currentTimeMillis;
	}

	private nextPendingRequests(
		sessionId?: string,
	): Effect.Effect<
		readonly ProviderCommandOutboxRow[],
		ProviderCommandStoreFailure
	> {
		return Effect.gen({ self: this }, function* () {
			const nowMs = yield* this.currentTimeMillis();
			return yield* this.options.sql<ProviderCommandOutboxRow>`
			SELECT request_sequence, command_id, project_key, session_id, provider_id,
			       effect_type, payload_json, run_id, attempt_count
			FROM provider_command_outbox AS candidate
			WHERE project_key = ${this.options.projectId}
				AND (${sessionId ?? null} IS NULL OR session_id = ${sessionId ?? null})
				AND (status = 'pending'
					OR (status = 'retryable_failed' AND next_attempt_at <= ${nowMs}))
				AND NOT EXISTS (
					SELECT 1 FROM provider_command_outbox AS earlier
					WHERE earlier.project_key = candidate.project_key
						AND earlier.session_id = candidate.session_id
						AND earlier.status IN ('pending', 'running', 'retryable_failed')
						AND (earlier.request_sequence < candidate.request_sequence OR earlier.status = 'running')
				)
			ORDER BY request_sequence
			`.pipe(
				Effect.map((rows) =>
					rows.filter(
						(row) =>
							!this.liveCommands.has(row.command_id) &&
							(sessionId !== undefined ||
								!this.drainingSessions.has(row.session_id)),
					),
				),
				Effect.mapError(storeFailure("nextPendingRequest")),
			);
		});
	}

	/** Claim and reserve atomically; an ended reservation is never reopened. */
	private markRunning(
		row: ProviderCommandOutboxRow,
		updatedAt: number,
	): Effect.Effect<
		ProviderCommandOutboxRow | undefined,
		ProviderCommandStoreFailure
	> {
		const runId = randomUUID();
		return this.options
			.write((project, stamp) =>
				Effect.gen({ self: this }, function* () {
					const [claimed] = yield* this.options.sql<ProviderCommandOutboxRow>`
				UPDATE provider_command_outbox SET status = 'running',
					attempt_count = attempt_count + 1, next_attempt_at = NULL, updated_at = ${updatedAt},
					run_id = CASE WHEN effect_type = 'send_turn' AND NOT EXISTS (
						SELECT 1 FROM provider_runs WHERE id = provider_command_outbox.run_id
							AND session_id = provider_command_outbox.session_id AND status IN ('pending', 'running')
					) THEN ${runId} ELSE run_id END
				WHERE request_sequence = ${row.request_sequence} AND project_key = ${this.options.projectId}
					AND (effect_type <> 'send_turn' OR NOT EXISTS (
						SELECT 1 FROM provider_command_outbox prior JOIN provider_runs run ON run.id = prior.run_id
						WHERE prior.project_key = provider_command_outbox.project_key AND prior.session_id = provider_command_outbox.session_id
							AND prior.status = 'running' AND prior.error_code = 'delivery_indeterminate'
							AND run.status IN ('pending', 'running', 'joined')
					))
					AND attempt_count = ${row.attempt_count}
					AND (status = 'pending' OR (status = 'retryable_failed' AND next_attempt_at <= ${updatedAt}))
				RETURNING request_sequence, command_id, project_key, session_id, provider_id,
					effect_type, payload_json, run_id, attempt_count`;
					if (claimed?.run_id === runId) {
						const store = yield* makeEventStoreEffect.pipe(
							Effect.provideService(SqlClient.SqlClient, this.options.sql),
							Effect.provideService(PersistenceProjectTag, {
								projectId: this.options.projectId,
							}),
						);
						yield* project(
							yield* store.appendBatch([
								canonicalEvent(
									"run.requested",
									claimed.session_id,
									{ runId, inputId: claimed.command_id },
									{
										provider: claimed.provider_id,
										createdAt: updatedAt,
										metadata: { runId },
									},
								),
							]),
						);
					}
					if (claimed?.effect_type === "send_turn")
						yield* stamp((version) =>
							this.options.sql<{
								id: string;
							}>`UPDATE sessions SET version = ${version} WHERE id = ${row.session_id} RETURNING id`.pipe(
								Effect.map((rows) => rows.map(({ id }) => id)),
							),
						);
					return claimed;
				}),
			)
			.pipe(Effect.mapError(storeFailure("markRunning")));
	}

	private runProviderEffect(
		row: ProviderCommandOutboxRow,
		interactions?: EventSink,
		makeInteractions?: ProviderCommandInteractionSinkFactory,
		abortSignal?: AbortSignal,
		liveContext?: LiveSendContext,
	): Effect.Effect<
		TurnResult,
		| ProviderCommandPayloadParseFailed
		| UnknownProviderCommandEffect
		| ProviderNotRegistered
		| ProviderInstanceFailure
		| ProviderCommandStoreFailure
	> {
		return Effect.gen({ self: this }, function* () {
			if (row.effect_type === "send_turn") {
				const payload = yield* this.parseSendTurnPayload(row);
				if (payload.continuation)
					yield* this.options.ingestion
						.ingest({
							eventId: `continuation-placement:${payload.runId}`,
							type: "message.created",
							providerId: row.provider_id,
							sessionId: payload.sessionId,
							runId: payload.runId,
							providerRefs: {},
							rawSource: { kind: "conduit.continuation" },
							createdAt: yield* this.currentTimeMillis(),
							data: {
								sessionId: payload.sessionId,
								messageId: payload.continuation.cutOffMessageId,
								role: "user",
							},
						})
						.pipe(Effect.mapError(storeFailure("placeContinuation")));
				const currentAccount = this.options.accountDirectory
					? yield* this.options.accountDirectory
							.resolve({
								_tag: "Id",
								id:
									payload.account?.id ?? payload.instanceId ?? row.provider_id,
							})
							.pipe(
								Effect.mapError(
									(cause) =>
										new ProviderInstanceFailure({
											providerId: row.provider_id,
											operation: "resolveReplayAccount",
											cause,
										}),
								),
							)
					: undefined;
				const admittedAccount = liveContext?.account ?? payload.account;
				const account = admittedAccount
					? {
							...admittedAccount,
							env: currentAccount
								? currentAccount.env
								: liveContext?.account?.env,
						}
					: currentAccount;
				const driver = account?.driver ?? row.provider_id;
				const call =
					liveContext?.shellEnv === undefined && this.options.resolveCallContext
						? yield* this.options.resolveCallContext({
								sessionId: payload.sessionId,
								...(account ? { account } : {}),
								providerId: row.provider_id,
								workspaceRoot: payload.workspaceRoot,
								extraFolders: payload.extraFolders,
								prepareShellEnv: true,
							})
						: undefined;
				const shellEnv = liveContext?.shellEnv ?? call?.shellEnv;
				const interactionSink =
					interactions ?? makeInteractions?.(payload.sessionId, driver);
				const instanceId = account?.id ?? payload.instanceId ?? row.provider_id;
				const instance = yield* this.options.registry.getInstanceEffect(driver);
				const turnKey = {
					sessionId: payload.sessionId,
					inputId: payload.inputId,
				};
				mark(turnKey, "reactor-start");
				const send = (
					prepared: PreparedTurn | undefined,
					nativeResumeFallback: boolean,
				) =>
					Effect.suspend(() => {
						mark(turnKey, "history-ready");
						return instance.sendTurnEffect({
							...payload,
							...(shellEnv ? { shellEnv } : {}),
							awaitIntake: this.awaitIntake(row),
							commandAttempt: row.attempt_count,
							account:
								account?.driver === "claude" && prepared && !payload.account
									? { ...account, folder: prepared.configDir }
									: account,
							instanceId,
							history: payload.history ?? [],
							...(getProviderDriver(driver)?.supportsNativeResume
								? {
										prompt: prepared?.prompt ?? payload.prompt,
										text: payload.prompt,
										configDir: prepared?.configDir,
										resumeSessionId: prepared?.resumeSessionId,
										resumeSessionAt: prepared?.resumeSessionAt,
										forkSession: prepared?.forkSession,
										clearInheritedGoal: prepared?.clearInheritedGoal,
										startFreshNativeSession:
											prepared?.resumeSessionId === undefined ||
											payload.rewind !== undefined,
										nativeResumeFallback,
										nativeThread: prepared?.nativeThread,
										...(prepared?.handoff ? { handoff: prepared.handoff } : {}),
									}
								: {}),
							eventSink: this.makeReactorEventSink(interactionSink),
							abortSignal: abortSignal ?? new AbortController().signal,
						});
					});
				const result = getProviderDriver(driver)?.supportsNativeResume
					? yield* Effect.gen({ self: this }, function* () {
							const state = yield* makeProviderStateEffect.pipe(
								Effect.provideService(PersistenceProjectTag, {
									projectId: row.project_key,
								}),
							);
							const read = yield* makeReadQueryEffect;
							let legacyDefault: ClaudeLaunchConfig | undefined;
							if (
								!payload.account &&
								payload.configDir === undefined &&
								this.options.accountDirectory
							) {
								const defaultAccount =
									yield* this.options.accountDirectory.defaultFor("claude");
								if (
									Option.isNone(defaultAccount) ||
									!("folder" in defaultAccount.value)
								)
									return yield* Effect.fail(
										storeFailure("decodeClaudeLaunch")(
											"Claude replay requires a Claude default account",
										),
									);
								legacyDefault = {
									configDir: defaultAccount.value.folder,
									folderSource: "legacyDefault",
								};
							}
							const launch = yield* Effect.try({
								try: () =>
									normalizeClaudeLaunchInput(
										payload.account?.driver === "claude"
											? {
													...payload,
													configDir: payload.account.folder,
													folderSource: "account",
												}
											: payload,
										() => {
											if (legacyDefault) return legacyDefault;
											if (this.options.defaultClaudeLaunchConfig)
												return this.options.defaultClaudeLaunchConfig();
											throw storeFailure("decodeClaudeLaunch")(
												"Claude replay requires a resolved default account or explicit config directory",
											);
										},
									),
								catch: storeFailure("decodeClaudeLaunch"),
							});
							return yield* sendPreparedClaudeTurn({
								sessionId: payload.sessionId,
								instanceId,
								commandId: row.command_id,
								userText: payload.prompt,
								options: {
									liveSession: yield* instance.getNativeSessionEffect?.(
										payload.sessionId,
									) ?? Effect.succeed(undefined),
									...launch,
									agent: payload.agent,
									userMessageId:
										payload.continuation?.cutOffMessageId ?? payload.inputId,
									continuation: payload.continuation,
									nativeResumeFallback: payload.nativeResumeFallback,
									rewind: payload.rewind,
									sessionForkSdk: this.options.claudeSessionForkSdk,
									workspaceRoot: payload.workspaceRoot,
									modelContextWindow:
										payload.contextWindow === "1m" ? 1000000 : undefined,
								},
								send,
							}).pipe(
								Effect.provideService(ProviderStateEffectTag, state),
								Effect.provideService(ReadQueryEffectTag, read),
							);
						}).pipe(
							Effect.provideService(SqlClient.SqlClient, this.options.sql),
							Effect.mapError((cause) =>
								cause instanceof ProviderInstanceFailure
									? cause
									: storeFailure("prepareTurn")(cause),
							),
						)
					: yield* send(undefined, false);
				return result;
			}
			if (row.effect_type === "interrupt_turn") {
				const call = yield* this.options.resolveSessionCallContext?.(
					row.session_id,
					row.run_id ?? undefined,
				) ?? Effect.succeed(undefined);
				const account =
					call?.account ??
					(this.options.accountDirectory
						? yield* this.options.accountDirectory
								.resolve({ _tag: "Id", id: row.provider_id })
								.pipe(Effect.mapError(storeFailure("resolveReplayAccount")))
						: undefined);
				const instance = yield* this.options.registry.getInstanceEffect(
					call?.account.driver ?? account?.driver ?? row.provider_id,
				);
				yield* call
					? instance.interruptTurnEffect(row.session_id, undefined, call)
					: instance.interruptTurnEffect(row.session_id);
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

	private awaitIntake(row: ProviderCommandOutboxRow) {
		return Effect.gen({ self: this }, function* () {
			for (;;) {
				const [run] = yield* this.options.sql<{
					status: TurnResult["status"] | "pending" | "running";
					started_at: number | null;
					joined_into: string | null;
				}>`SELECT status, started_at, joined_into FROM provider_runs
					WHERE session_id = ${row.session_id} AND id = ${row.run_id}`;
				if (!run)
					return yield* Effect.fail(new Error("Missing run reservation"));
				if (run.started_at !== null || run.joined_into !== null)
					return { ...REACTOR_COMPLETED_RESULT, status: "accepted" as const };
				if (run.status !== "pending" && run.status !== "running")
					return { ...REACTOR_COMPLETED_RESULT, status: run.status };
				yield* Effect.sleep(
					this.options.outcomePollInterval ?? defaultOutcomePollInterval,
				);
			}
		}).pipe(
			Effect.mapError(
				(cause) =>
					new ProviderInstanceFailure({
						providerId: row.provider_id,
						operation: "awaitIntake",
						cause,
					}),
			),
		);
	}

	private pendingRequestForCommand(
		commandId: string,
	): Effect.Effect<
		ProviderCommandOutboxRow | undefined,
		ProviderCommandStoreFailure
	> {
		return this.options.sql<ProviderCommandOutboxRow>`
			SELECT request_sequence, command_id, project_key, session_id, provider_id,
			       effect_type, payload_json, run_id, attempt_count
			FROM provider_command_outbox
			WHERE project_key = ${this.options.projectId}
				AND command_id = ${commandId} AND status IN ('pending', 'retryable_failed')
			ORDER BY request_sequence
			LIMIT 1`.pipe(
			Effect.map((rows) => rows[0]),
			Effect.mapError(storeFailure("pendingRequestForCommand")),
		);
	}

	private receiptOutcome(commandId: string): Effect.Effect<
		| {
				readonly status: string;
				readonly error_code: string | null;
				readonly run_status: string | null;
		  }
		| undefined,
		ProviderCommandStoreFailure
	> {
		return this.options.sql<{
			readonly status: string;
			readonly error_code: string | null;
			readonly run_status: string | null;
		}>`SELECT receipt.status, receipt.error_code, run.status AS run_status FROM command_receipts receipt
			LEFT JOIN provider_command_outbox command ON command.command_id = receipt.command_id
				AND command.project_key = receipt.project_key AND command.request_sequence = (
					SELECT MAX(request_sequence) FROM provider_command_outbox WHERE command_id = receipt.command_id AND project_key = receipt.project_key)
			LEFT JOIN provider_runs reservation ON reservation.id = command.run_id AND reservation.session_id = command.session_id
			LEFT JOIN provider_runs run ON run.id = COALESCE(reservation.joined_into, reservation.id) AND run.session_id = reservation.session_id
			WHERE receipt.command_id = ${commandId} AND receipt.project_key = ${this.options.projectId}`.pipe(
			Effect.map((rows) => rows[0]),
			Effect.mapError(storeFailure("receiptOutcome")),
		);
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
			Effect.flatMap((payload) => {
				if (!isRecord(payload))
					return Effect.fail(
						toParseFailure("Invalid send_turn outbox payload"),
					);
				// Pre-inbox continuations carried a boolean and the cut-off id in
				// userMessageId; their own identity was the command id.
				const legacyContinuation =
					payload["continuation"] === true &&
					typeof payload["userMessageId"] === "string";
				const inputId = legacyContinuation
					? payload["commandId"]
					: (payload["inputId"] ??
						payload["userMessageId"] ??
						payload["commandId"] ??
						payload["turnId"]);
				const {
					turnId: _turnId,
					userMessageId: _userMessageId,
					commandId: _commandId,
					shellEnv: _shellEnv,
					...input
				} = payload;
				const normalized = {
					...input,
					inputId,
					runId: row.run_id ?? undefined,
					...(legacyContinuation
						? { continuation: { cutOffMessageId: payload["userMessageId"] } }
						: {}),
				};
				return isSendTurnOutboxPayload(normalized)
					? Effect.succeed(normalized)
					: Effect.fail(toParseFailure("Invalid send_turn outbox payload"));
			}),
		);
	}

	private markCompleted(
		row: ProviderCommandOutboxRow,
		updatedAt: number,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		const { sql } = this.options;
		return sql
			.withTransaction(
				Effect.all([
					sql`
					UPDATE provider_command_outbox
					SET status = 'completed', updated_at = ${updatedAt}
					WHERE request_sequence = ${row.request_sequence}
						AND project_key = ${this.options.projectId}`,
					sql`
					UPDATE command_receipts
					SET status = 'side_effect_completed', updated_at = ${updatedAt}
					WHERE command_id = ${row.command_id}
						AND project_key = ${this.options.projectId}`,
				]),
			)
			.pipe(Effect.asVoid, Effect.mapError(storeFailure("markCompleted")));
	}

	private writeFailure(
		row: ProviderCommandOutboxRow,
		retryable: boolean,
		errorCode: string,
		updatedAt: number,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		const retryBackoff = this.options.retryBackoff ?? defaultRetryBackoff;
		const nextAttemptAt = retryable
			? updatedAt + Duration.toMillis(retryBackoff(row.attempt_count))
			: null;
		const { sql } = this.options;
		const updates = Effect.all([
			sql`
					UPDATE provider_command_outbox
					SET status = ${retryable ? "retryable_failed" : "failed"},
					    error_code = ${errorCode},
					    next_attempt_at = ${nextAttemptAt},
					    updated_at = ${updatedAt}
					WHERE request_sequence = ${row.request_sequence}
						AND project_key = ${this.options.projectId}`,
			sql`
					UPDATE command_receipts
					SET status = 'side_effect_failed', error_code = ${errorCode}, updated_at = ${updatedAt}
					WHERE command_id = ${row.command_id}
						AND project_key = ${this.options.projectId}`,
		]).pipe(Effect.asVoid);
		return sql
			.withTransaction(updates)
			.pipe(Effect.asVoid, Effect.mapError(storeFailure("markFailed")));
	}

	/**
	 * Event sink handed to the provider during execution. Provider OUTPUT always
	 * streams to the durable ProviderRuntimeIngestion (the mandatory persistence
	 * seam). INTERACTIONS (permission/question) route through the caller's real
	 * sink on the same-process dispatch path so Claude tool approvals and
	 * `AskUserQuestion` resolve. Production drains supply the same relay sink
	 * factory so recovered commands and background claim winners can also ask.
	 */
	private makeReactorEventSink(interactions?: EventSink): EventSink {
		// Streamed output bypasses the relay sink, so mark the session alive here
		// or the relay's processing timeout fires mid-turn on long turns.
		const push: EventSink["push"] = (event) =>
			Effect.suspend(() => {
				interactions?.noteActivity?.(event);
				return this.options.ingestion
					.ingest(event)
					.pipe(Effect.asVoid, Effect.mapError(toEventSinkError));
			});
		if (!interactions) {
			return {
				push,
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
		const { cancelSessionInteractions, detachInteractions } = interactions;
		return {
			push,
			requestPermission: (request) => interactions.requestPermission(request),
			requestQuestion: (request) => interactions.requestQuestion(request),
			resolvePermission: (requestId, response) =>
				interactions.resolvePermission(requestId, response),
			resolveQuestion: (requestId, answers) =>
				interactions.resolveQuestion(requestId, answers),
			...(detachInteractions ? { detachInteractions } : {}),
			...(cancelSessionInteractions
				? {
						cancelSessionInteractions: (
							reason: string,
							options?: { readonly recoverQuestions?: boolean },
						) => cancelSessionInteractions(reason, options),
					}
				: {}),
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
		typeof value["inputId"] === "string" &&
		typeof value["prompt"] === "string" &&
		(value["history"] === undefined || Array.isArray(value["history"])) &&
		(value["rewind"] === undefined ||
			(isRecord(value["rewind"]) &&
				(value["rewind"]["resumeSessionAt"] === null ||
					typeof value["rewind"]["resumeSessionAt"] === "string") &&
				(value["rewind"]["targetMessageId"] === undefined ||
					typeof value["rewind"]["targetMessageId"] === "string"))) &&
		isRecord(value["providerState"]) &&
		(value["account"] === undefined ||
			Schema.is(AccountSchema)(value["account"])) &&
		typeof value["workspaceRoot"] === "string"
	);
}

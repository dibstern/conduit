import { randomUUID } from "node:crypto";
import {
	Clock,
	type Context,
	Data,
	Duration,
	Effect,
	Exit,
	Fiber,
	Option,
	Ref,
	Schedule,
	Schema,
	Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";
import { AccountSchema } from "../contracts/account.js";
import { AccountUnroutable } from "../contracts/limit-recovery.js";
import { getProviderDriver } from "../contracts/provider-instance.js";
import type { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import {
	OpenCodeControlTarget,
	OpenCodeInstancesTag,
} from "../domain/daemon/Services/opencode-instances-service.js";
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
import { makeRetireReplacedProcessPrompts } from "../persistence/effect/retire-pending-prompts.js";
import { SessionRollupProjects } from "../persistence/effect/session-rollup-projects.js";
import { type CanonicalEvent, canonicalEvent } from "../persistence/events.js";
import { normalizeClaudeLaunchInput } from "./claude/claude-runner-wire.js";
import type { ClaudeLaunchConfig } from "./claude/claude-sdk-env.js";
import type { ClaudeSessionForkSdk } from "./claude/claude-session-fork.js";
import {
	type PreparedTurn,
	sendPreparedClaudeTurn,
} from "./claude/prepare-turn.js";
import { ProviderInstanceFailure, ProviderNotRegistered } from "./errors.js";
import type { EventSinkError } from "./event-sink-errors.js";
import { backfillLegacyControlAnswers } from "./legacy-control-outbox.js";
import { ProviderControlPayloadSchema } from "./orchestration-command-contracts.js";
import type {
	OrchestrationEngine,
	ProviderCallRequest,
} from "./orchestration-engine.js";
import type { ProviderRegistry } from "./provider-registry.js";
import { toEventSinkError } from "./relay-event-sink.js";
import { legacyStopOwnersQuery } from "./session-run-settlement.js";
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

const controlErrorSchema = Schema.Struct({
	_tag: Schema.Literal("ProviderInstanceFailure"),
	providerId: Schema.String,
	operation: Schema.String,
	code: Schema.optionalKey(
		Schema.Literals([
			"auth_required",
			"provider_process_gone",
			"provider_process_unavailable",
			"project_inactive",
			"project_unavailable",
		]),
	),
	causeMessage: Schema.String,
});

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
	readonly provider_process_id: string | null;
	readonly attempt_count: number;
	readonly status: "pending" | "running" | "retryable_failed";
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
	readonly projectId?: string;
	readonly sql: SqlClient.SqlClient;
	readonly registry: ProviderRegistry;
	readonly ingestion: Pick<ProviderRuntimeIngestion, "ingest" | "ingestBatch">;
	readonly write: CommitAndSignal["write"];
	readonly persistUserMessage?: ClaudeEventPersistEffect["persistUserMessage"];
	readonly claudeSessionForkSdk?: ClaudeSessionForkSdk;
	readonly defaultClaudeLaunchConfig?: () => ClaudeLaunchConfig;
	readonly resolveSessionCallContext?: OrchestrationEngine["resolveSessionCallContextEffect"];
	readonly resolveCallContext?: (
		request: ProviderCallRequest,
	) => Effect.Effect<ProviderCall, ProviderInstanceFailure>;
	readonly isProjectReady?: (
		projectId: string,
		sessionId: string,
	) => Effect.Effect<boolean, ProviderInstanceFailure>;
	readonly recoverDetachedSession?: (sessionId: string) => Effect.Effect<void>;
	readonly makeInteractions?: (
		sessionId: string,
		driver: string,
	) => Effect.Effect<EventSink, ProviderInstanceFailure>;
	readonly projectContext?: (
		projectId: string,
	) => Option.Option<Context.Context<never>>;
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
const maxControlAttempts = 5;
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
	private readonly acceptedControls = new Map<
		string,
		ProviderCall | undefined
	>();
	private readonly executingControls = new Set<string>();
	private readonly executingSends = new Map<string, ProviderCommandOutboxRow>();
	private recoveryPrepared = false;

	registerControl(commandId: string, call?: ProviderCall): void {
		this.acceptedControls.set(commandId, call);
	}

	unregisterControl(commandId: string): void {
		this.acceptedControls.delete(commandId);
	}
	private readonly liveCommands = new Set<string>();
	private readonly drainingSessions = new Set<string>();
	private readonly admission = Semaphore.makeUnsafe(1);

	constructor(private readonly options: ProviderSideEffectReactorOptions) {}

	/** Only an executing send, not a refusal lock, owns pending intake. */
	ownsPendingSend(
		sessionId: string,
		commandId: string,
		requestSequence: number,
		attemptCount: number,
	): boolean {
		const owner = this.executingSends.get(`${requestSequence}:${attemptCount}`);
		return owner?.session_id === sessionId && owner.command_id === commandId;
	}

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

	/** Runtime imports prepare only their own rows, under the claim lock. */
	prepareProjectRecovery(
		projectId: string,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		return this.admission.withPermit(
			Effect.suspend(() =>
				this.recoveryPrepared ? this.prepareRecovery(projectId) : Effect.void,
			),
		);
	}

	private prepareRecovery(
		projectId?: string,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		return Effect.gen({ self: this }, function* () {
			yield* backfillLegacyControlAnswers(
				projectId === undefined ? this.options : { ...this.options, projectId },
			).pipe(Effect.mapError(storeFailure("backfillLegacyAnswers")));
			// Replay keeps the command id so surviving runners deduplicate delivery.
			yield* this.options
				.write(
					() => this.options.sql`
				UPDATE provider_command_outbox SET status = 'pending', next_attempt_at = NULL
				WHERE (${projectId ?? null} IS NULL OR project_key = ${projectId ?? null})
					AND effect_type <> 'send_turn' AND status = 'running'
					AND attempt_count < ${maxControlAttempts}
					AND command_id NOT IN ${this.options.sql.in([...new Set([...this.acceptedControls.keys(), ...this.executingControls])])}
			`,
				)
				.pipe(Effect.mapError(storeFailure("recoverControls")));
		});
	}

	drain(
		makeInteractions?: ProviderCommandInteractionSinkFactory,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		return Effect.gen({ self: this }, function* () {
			yield* this.admission.withPermit(
				Effect.gen({ self: this }, function* () {
					if (this.recoveryPrepared) return;
					yield* this.prepareRecovery(this.options.projectId);
					this.recoveryPrepared = true;
				}),
			);
			const registered = yield* SessionRollupProjects;
			if (this.options.isProjectReady) {
				// Sidebar membership hides unavailable projects and is not registration
				// truth. Include retained send claims that crashed before intake;
				// neither adapter recovery nor pending selection can settle those.
				const commands = yield* this.options.sql<ProviderCommandOutboxRow>`
					SELECT request_sequence, command_id, project_key, session_id, provider_id,
						effect_type, payload_json, run_id, provider_process_id, attempt_count, status
					FROM provider_command_outbox
					WHERE (${this.options.projectId ?? null} IS NULL OR project_key = ${this.options.projectId ?? null})
						AND status IN ('pending', 'running', 'retryable_failed')
					ORDER BY request_sequence
				`.pipe(Effect.mapError(storeFailure("inactiveCommands")));
				for (const row of commands) {
					const ready = yield* Effect.result(
						this.options.isProjectReady(row.project_key, row.session_id),
					);
					if (ready._tag === "Failure")
						yield* this.withDrainSession(
							row.session_id,
							this.refuseProjectCommand(row, ready.failure),
						).pipe(
							Effect.catchCause((cause) =>
								Failure.isInterruptedOnly(cause)
									? Effect.interrupt
									: Effect.logError(
											"Provider command project refusal failed",
											cause,
										),
							),
						);
				}
			} else if (registered !== undefined) {
				// Removed projects retain history but have no executor. Release their
				// process queue heads before selecting another project's controls.
				yield* this.options
					.write(() =>
						Effect.gen({ self: this }, function* () {
							const projects = yield* Ref.get(registered);
							const now = yield* this.currentTimeMillis();
							const cancelled = yield* this.options.sql<{
								command_id: string;
								project_key: string;
								provider_id: string;
								effect_type: string;
							}>`UPDATE provider_command_outbox
						SET status = 'cancelled', error_code = 'project_inactive', next_attempt_at = NULL, updated_at = ${now}
						WHERE effect_type <> 'send_turn' AND status IN ('pending', 'running', 'retryable_failed')
							AND project_key NOT IN ${this.options.sql.in(projects)}
						RETURNING command_id, project_key, provider_id, effect_type`;
							for (const row of cancelled)
								yield* this.options
									.sql`UPDATE command_receipts SET status = 'side_effect_failed', error_code = 'project_inactive',
							error = ${JSON.stringify({ _tag: "ProviderInstanceFailure", providerId: row.provider_id, operation: row.effect_type, code: "project_inactive", causeMessage: "The target project is no longer registered" })}, updated_at = ${now}
							WHERE command_id = ${row.command_id} AND project_key = ${row.project_key} AND status = 'side_effect_requested'`;
						}),
					)
					.pipe(Effect.mapError(storeFailure("cancelInactiveControls")));
			}
			const heads = yield* this.nextPendingRequests();
			yield* Effect.forEach(
				heads,
				(head) =>
					(head.provider_process_id !== null && head.effect_type !== "send_turn"
						? this.runBackgroundRow(head, makeInteractions).pipe(Effect.asVoid)
						: this.withDrainSession(
								head.session_id,
								Effect.gen({ self: this }, function* () {
									let row: ProviderCommandOutboxRow | undefined = head;
									while (row) {
										if (
											(yield* this.runBackgroundRow(row, makeInteractions)) ===
											0
										)
											return;
										const next = (yield* this.nextPendingRequests(
											head.session_id,
										))[0];
										// A refusal can race project recovery and leave its head
										// unchanged. Defer it to the scheduler's next drain.
										if (
											next?.request_sequence === row.request_sequence &&
											next.attempt_count === row.attempt_count
										)
											return;
										row = next;
									}
								}),
							)
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
			if (row.provider_process_id !== null && row.effect_type !== "send_turn")
				return yield* this.runBackgroundRow(row, makeInteractions);
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
			if (result._tag === "Success" && result.success === undefined) return 0;
			if (
				result._tag === "Success" &&
				result.success?.status === "steer-declined"
			) {
				yield* this.withProjectContext(
					row.project_key,
					Effect.gen({ self: this }, function* () {
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
					}),
				);
			}
			return 1;
		});
	}

	/** Resolve short project cleanup borrows after delivery, including replacements. */
	private withProjectContext<E>(
		projectId: string,
		effect: Effect.Effect<void, E>,
	): Effect.Effect<void, E> {
		return Effect.suspend(() => {
			if (!this.options.projectContext) return effect;
			const context = this.options.projectContext(projectId);
			return Option.isSome(context)
				? effect.pipe(Effect.provide(context.value))
				: Effect.void;
		});
	}

	/**
	 * Execute a single committed command by id and await its durable receipt
	 * to a same-process waiter. Shares the single executor (`executeRow`) with
	 * `drain()`; provider execution is idempotent via the `markRunning` status
	 * guard. When the row is no longer pending (already drained), the durable
	 * receipt supplies the outcome.
	 *
	 * `interactions` supplies the standalone caller's interaction sink. Daemon
	 * sends use the current project borrow when each request arrives. Provider
	 * output always streams through durable ProviderRuntimeIngestion.
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
				}).pipe(
					Effect.flatMap((result) => {
						if (result !== undefined) return Effect.succeed(result);
						this.liveCommands.delete(commandId);
						return this.durableOutcome(commandId);
					}),
				);
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
	private executeControlRow(
		row: ProviderCommandOutboxRow,
		background: boolean,
	): Effect.Effect<TurnResult, ProviderCommandExecutionError> {
		// Keep claim and outcome persistence atomic with respect to interruption.
		// Provider delivery and waiting for another claim remain interruptible.
		return Effect.acquireUseRelease(
			Effect.sync(() => {
				if (this.executingControls.has(row.command_id)) return false;
				this.executingControls.add(row.command_id);
				return true;
			}),
			(acquired) => {
				if (!acquired) return Effect.succeed(undefined);
				return Effect.uninterruptibleMask((restore) =>
					Effect.gen({ self: this }, function* () {
						if (row.attempt_count >= maxControlAttempts) {
							yield* this.recordControlOutcome(
								row,
								new ProviderInstanceFailure({
									providerId: row.provider_id,
									operation: row.effect_type,
									cause: Object.assign(
										new Error("Provider control attempt budget exhausted"),
										{ code: "provider_control_attempts_exhausted" },
									),
								}),
							);
							return yield* this.durableOutcome(row.command_id);
						}
						const startedAt = yield* this.currentTimeMillis();
						const claimed = yield* background
							? this.admission.withPermit(
									Effect.suspend(() =>
										this.liveCommands.has(row.command_id)
											? Effect.succeed(undefined)
											: this.markRunning(row, startedAt),
									),
								)
							: this.markRunning(row, startedAt);
						if (!claimed) return;
						const result = yield* Effect.result(
							restore(this.runProviderEffect(claimed)),
						);
						if (
							claimed.provider_process_id !== null &&
							result._tag === "Failure" &&
							result.failure instanceof ProviderInstanceFailure &&
							result.failure.code === "provider_process_gone"
						) {
							const expiredProcessId = claimed.provider_process_id;
							yield* this.withProjectContext(
								claimed.project_key,
								Effect.gen(function* () {
									const retire = yield* makeRetireReplacedProcessPrompts;
									yield* retire(null, {
										sessionId: claimed.session_id,
										expiredProcessId,
									}).pipe(
										Effect.mapError(storeFailure("retireControlProcess")),
									);
								}),
							);
						}
						const failure =
							result._tag === "Failure"
								? result.failure instanceof ProviderInstanceFailure
									? result.failure
									: new ProviderInstanceFailure({
											providerId: claimed.provider_id,
											operation: claimed.effect_type,
											cause: result.failure,
										})
								: undefined;
						yield* this.recordControlOutcome(claimed, failure);
						// The request can report a delivery error while the accepted answer
						// remains owned by the outbox for a later retry.
						if (failure) return yield* failure;
						return yield* this.durableOutcome(claimed.command_id);
					}),
				);
			},
			(acquired) =>
				Effect.sync(() => {
					if (acquired) this.executingControls.delete(row.command_id);
				}),
		).pipe(
			// Release this execution's reservation before a waiter polls again.
			Effect.flatMap((result) =>
				result
					? Effect.succeed(result)
					: background
						? Effect.succeed(REACTOR_COMPLETED_RESULT)
						: Effect.sleep(
								this.options.outcomePollInterval ?? defaultOutcomePollInterval,
							).pipe(Effect.andThen(this.runCommand(row.command_id))),
			),
		);
	}

	private executeRow(
		row: ProviderCommandOutboxRow,
		options?: {
			interactions?: EventSink | undefined;
			makeInteractions?: ProviderCommandInteractionSinkFactory | undefined;
			abortSignal?: AbortSignal | undefined;
			background?: boolean;
			liveContext?: LiveSendContext | undefined;
		},
	): Effect.Effect<TurnResult | undefined, ProviderCommandExecutionError> {
		return Effect.gen({ self: this }, function* () {
			if (this.options.isProjectReady) {
				const active = yield* Effect.result(
					this.options.isProjectReady(row.project_key, row.session_id),
				);
				if (active._tag === "Failure") {
					yield* this.refuseProjectCommand(row, active.failure);
					return yield* active.failure;
				}
				if (!active.success) return;
			}
			if (
				(row.provider_process_id !== null ||
					row.effect_type === "interrupt_turn") &&
				row.effect_type !== "send_turn"
			)
				return yield* this.executeControlRow(row, options?.background ?? false);
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
			).pipe(
				Effect.ensuring(
					Effect.sync(() =>
						this.executingSends.delete(
							`${row.request_sequence}:${row.attempt_count}`,
						),
					),
				),
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
						WHERE command_id = ${row.command_id} AND project_key = ${row.project_key} AND status = 'side_effect_requested'`;
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
			// Keep the durable claim for runner recovery, but release this attempt
			// and its drain lease so project removal can also settle the command.
			if (
				row.effect_type === "send_turn" &&
				failure instanceof ProviderInstanceFailure &&
				failure.code === "runner_detached"
			) {
				// Ownership is already released. A replacement that skipped this
				// attempt while it was unwinding now needs to attach its runner.
				yield* this.options.recoverDetachedSession?.(row.session_id) ??
					Effect.void;
				return;
			}
			if (failure && this.options.isProjectReady) {
				const active = yield* Effect.result(
					this.options.isProjectReady(row.project_key, row.session_id),
				);
				if (active._tag === "Failure") {
					yield* this.refuseProjectCommand(row, active.failure);
					return yield* active.failure;
				}
			}
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
		| ProviderCommandStoreFailure
		| ProviderCommandNotExecutable
		| ProviderInstanceFailure
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
					if (
						receipt.effect_type !== null &&
						receipt.effect_type !== "send_turn" &&
						receipt.error
					) {
						const stored = yield* Effect.try({
							try: () =>
								Schema.decodeSync(controlErrorSchema)(
									JSON.parse(receipt.error ?? ""),
								),
							catch: storeFailure("decodeControlOutcome"),
						});
						return yield* Effect.fail(
							new ProviderInstanceFailure({
								providerId: stored.providerId,
								operation: stored.operation,
								...(stored.code ? { code: stored.code } : {}),
								cause: new Error(stored.causeMessage),
							}),
						);
					}
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
			       effect_type, payload_json, run_id, provider_process_id, attempt_count, status
			FROM provider_command_outbox AS candidate
			WHERE (${this.options.projectId ?? null} IS NULL OR project_key = ${this.options.projectId ?? null})
				AND (${sessionId ?? null} IS NULL OR session_id = ${sessionId ?? null})
				AND (status = 'pending'
					OR (status = 'retryable_failed' AND next_attempt_at <= ${nowMs})
					OR (status = 'running' AND effect_type <> 'send_turn' AND attempt_count >= ${maxControlAttempts}
						AND command_id NOT IN ${this.options.sql.in([...this.executingControls])}))
				AND NOT EXISTS (
					SELECT 1 FROM provider_command_outbox AS earlier
					WHERE earlier.status IN ('pending', 'running', 'retryable_failed') AND (
						(candidate.effect_type <> 'send_turn' AND candidate.provider_process_id IS NOT NULL
							AND earlier.effect_type <> 'send_turn' AND earlier.provider_process_id = candidate.provider_process_id
							AND earlier.request_sequence < candidate.request_sequence)
						OR ((candidate.effect_type = 'send_turn' OR candidate.provider_process_id IS NULL)
							AND earlier.project_key = candidate.project_key AND earlier.session_id = candidate.session_id
							AND (earlier.request_sequence < candidate.request_sequence OR earlier.status = 'running')))
				)
			ORDER BY request_sequence
			`.pipe(
				Effect.map((rows) =>
					rows.filter(
						(row) =>
							!this.liveCommands.has(row.command_id) &&
							((row.effect_type !== "send_turn" &&
								row.provider_process_id !== null) ||
								sessionId !== undefined ||
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
		let ownedKey: string | undefined;
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
				WHERE request_sequence = ${row.request_sequence} AND project_key = ${row.project_key}
					AND (effect_type <> 'send_turn' OR NOT EXISTS (
						SELECT 1 FROM provider_command_outbox prior JOIN provider_runs run ON run.id = prior.run_id
						WHERE prior.project_key = provider_command_outbox.project_key AND prior.session_id = provider_command_outbox.session_id
							AND prior.status = 'running' AND prior.error_code = 'delivery_indeterminate'
							AND run.status IN ('pending', 'running', 'joined')
					))
					AND attempt_count = ${row.attempt_count}
					AND (effect_type = 'send_turn' OR attempt_count < ${maxControlAttempts})
					AND (effect_type = 'send_turn' OR provider_process_id IS NULL OR NOT EXISTS (
						SELECT 1 FROM provider_command_outbox prior
						WHERE prior.effect_type <> 'send_turn' AND prior.provider_process_id = provider_command_outbox.provider_process_id
							AND prior.request_sequence < provider_command_outbox.request_sequence
							AND prior.status IN ('pending', 'running', 'retryable_failed')
					))
					AND (status = 'pending' OR (status = 'retryable_failed' AND next_attempt_at <= ${updatedAt}))
				RETURNING request_sequence, command_id, project_key, session_id, provider_id,
					effect_type, payload_json, run_id, provider_process_id, attempt_count, status`;
					if (claimed?.run_id === runId) {
						const store = yield* makeEventStoreEffect.pipe(
							Effect.provideService(SqlClient.SqlClient, this.options.sql),
							Effect.provideService(PersistenceProjectTag, {
								projectId: row.project_key,
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
					if (claimed?.effect_type === "send_turn") {
						// Attachment can run during post-commit publication, so expose
						// the successful claim before committing its running state.
						ownedKey = `${claimed.request_sequence}:${claimed.attempt_count}`;
						this.executingSends.set(ownedKey, claimed);
						yield* stamp((version) =>
							this.options.sql<{
								id: string;
							}>`UPDATE sessions SET version = ${version} WHERE id = ${row.session_id} RETURNING id`.pipe(
								Effect.map((rows) => rows.map(({ id }) => id)),
							),
						);
					}
					return claimed;
				}),
			)
			.pipe(
				Effect.onExit((exit) =>
					Exit.isFailure(exit)
						? Effect.sync(() => {
								if (ownedKey) this.executingSends.delete(ownedKey);
							})
						: Effect.void,
				),
				Effect.mapError(storeFailure("markRunning")),
			);
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
			const ready = yield* this.options.isProjectReady?.(
				row.project_key,
				row.session_id,
			) ?? Effect.succeed(true);
			if (!ready)
				return yield* Effect.sleep(
					this.options.outcomePollInterval ?? defaultOutcomePollInterval,
				).pipe(
					Effect.andThen(
						this.runProviderEffect(
							row,
							interactions,
							makeInteractions,
							abortSignal,
							liveContext,
						),
					),
				);
			if (row.provider_process_id !== null && row.effect_type !== "send_turn") {
				const payload = yield* Effect.try({
					try: () =>
						Schema.decodeSync(ProviderControlPayloadSchema)(
							JSON.parse(row.payload_json),
						),
					catch: (cause) =>
						new ProviderCommandPayloadParseFailed({
							requestSequence: row.request_sequence,
							commandId: row.command_id,
							code: "provider_command_payload_parse_failed",
							cause,
						}),
				});
				if (
					payload.type !== row.effect_type ||
					payload.providerProcessId !== row.provider_process_id
				)
					return yield* Effect.fail(
						new ProviderCommandPayloadParseFailed({
							requestSequence: row.request_sequence,
							commandId: row.command_id,
							code: "provider_command_payload_parse_failed",
							cause: "Control target does not match outbox",
						}),
					);
				const stop =
					payload.type === "interrupt_turn" || payload.type === "end_session"
						? payload.stop
						: undefined;
				const stopOwners = stop?.owners.length
					? stop.owners
					: !stop &&
							payload.type === "interrupt_turn" &&
							payload.turnIds?.length
						? yield* legacyStopOwnersQuery(
								this.options.sql,
								row.session_id,
								row.command_id,
							).pipe(Effect.mapError(storeFailure("recoverStopCohort")))
						: undefined;
				const stopRunning = stopOwners?.length
					? this.options.sql<{ running: number }>`
						SELECT EXISTS (SELECT 1 FROM provider_runs WHERE session_id = ${row.session_id}
							AND id IN ${this.options.sql.in(stopOwners.map(({ runId }) => runId))}
							AND status IN ('pending', 'running')) AS running`.pipe(
							Effect.map(([cohort]) => cohort?.running === 1),
							Effect.mapError(storeFailure("stopCohort")),
						)
					: undefined;
				if (stopRunning && !(yield* stopRunning))
					return REACTOR_COMPLETED_RESULT;
				if (payload.type === "end_session" && payload.retireRunIds) {
					const [cohort] = yield* this.options.sql<{ running: number }>`
						SELECT EXISTS (SELECT 1 FROM provider_runs WHERE session_id = ${row.session_id}
							AND id IN ${this.options.sql.in(payload.retireRunIds)}
							AND status IN ('pending', 'running')) AS running`.pipe(
						Effect.mapError(storeFailure("retirementCohort")),
					);
					if (cohort?.running !== 1) return REACTOR_COMPLETED_RESULT;
				}
				const call =
					this.acceptedControls.get(row.command_id) ??
					(yield* this.options.resolveSessionCallContext?.(
						row.session_id,
						payload.type === "end_session" ? payload.account : undefined,
						payload.type === "interrupt_turn"
							? payload.turnIds === undefined
								? undefined
								: { turnIds: payload.turnIds }
							: payload.type === "end_session"
								? {
										projectId: row.project_key,
										includeSettledForProviderId:
											payload.targetProviderId ??
											payload.account?.id ??
											row.provider_id,
										...(payload.targetProviderId
											? { providerId: payload.targetProviderId }
											: {}),
									}
								: {
										prompt: {
											id: payload.requestId,
											kind:
												payload.type === "resolve_permission"
													? "permission"
													: "question",
										},
									},
					) ?? Effect.succeed(undefined));
				const account =
					call?.account ??
					(payload.type === "end_session" && payload.account
						? payload.account
						: this.options.accountDirectory
							? yield* this.options.accountDirectory
									.resolve({ _tag: "Id", id: row.provider_id })
									.pipe(
										Effect.catchTag("AccountUnroutable", () =>
											Effect.succeed(undefined),
										),
										Effect.mapError(storeFailure("resolveControlAccount")),
									)
							: undefined);
				const instance = yield* this.options.registry.getInstanceEffect(
					account?.driver ?? row.provider_id,
				);
				const context = {
					commandId: row.command_id,
					providerProcessId: row.provider_process_id,
					...(payload.type === "end_session" && payload.retireRunIds
						? { retireRunIds: payload.retireRunIds }
						: {}),
				};
				const instances = yield* Effect.serviceOption(OpenCodeInstancesTag);
				if (instance.getControlProcessIdEffect) {
					const currentProcessId = yield* instance.getControlProcessIdEffect(
						row.session_id,
					);
					if (currentProcessId !== row.provider_process_id)
						return yield* new ProviderInstanceFailure({
							providerId: row.provider_id,
							operation: row.effect_type,
							// Quarantine hides the control identity while retaining a live
							// process. Require liveness evidence before retiring its prompts.
							code:
								currentProcessId === undefined &&
								(!instance.hasLiveProcessEffect ||
									(yield* instance.hasLiveProcessEffect(row.session_id)))
									? "provider_process_unavailable"
									: "provider_process_gone",
							cause: new Error(
								"The target provider process is unavailable for control delivery",
							),
						});
				}
				if (instance.providerId === "opencode" && Option.isSome(instances)) {
					const running = yield* instances.value.ifRunning(
						call?.account.id ?? row.provider_id,
						call?.workspaceRoot,
					);
					if (
						Option.isNone(running) ||
						running.value.promptProcessId !== row.provider_process_id ||
						(!this.acceptedControls.has(row.command_id) &&
							!running.value.controlReplaySafe)
					)
						return yield* new ProviderInstanceFailure({
							providerId: row.provider_id,
							operation: row.effect_type,
							code:
								Option.isSome(running) &&
								running.value.promptProcessId === row.provider_process_id
									? "provider_process_unavailable"
									: "provider_process_gone",
							cause: new Error(
								"The target OpenCode process cannot be verified for delivery",
							),
						});
					if (
						payload.type === "resolve_question" &&
						payload.operation === "reject"
					) {
						const client = yield* instances.value
							.use(call?.account.id ?? row.provider_id, call?.workspaceRoot)
							.pipe(
								Effect.provideService(
									OpenCodeControlTarget,
									context.providerProcessId,
								),
								Effect.mapError(
									(cause) =>
										new ProviderInstanceFailure({
											providerId: row.provider_id,
											operation: row.effect_type,
											cause,
											...(cause.code === "provider_process_gone"
												? { code: cause.code }
												: {}),
										}),
								),
							);
						yield* Effect.tryPromise({
							try: () =>
								client.question.reject(
									payload.nativeRequestId ?? payload.requestId,
									call?.workspaceRoot,
								),
							catch: (cause) =>
								new ProviderInstanceFailure({
									providerId: row.provider_id,
									operation: row.effect_type,
									cause,
								}),
						});
						return REACTOR_COMPLETED_RESULT;
					}
				}
				const deliver = Effect.gen(function* () {
					switch (payload.type) {
						case "interrupt_turn": {
							const driver = getProviderDriver(
								account?.driver ?? instance.providerId,
							);
							yield* instance.interruptTurnEffect(
								row.session_id,
								// The predecessor omitted turnIds for an empty Stop.
								// Fence delivery without changing its committed payload.
								payload.turnIds ??
									payload.stop?.turnIds ??
									(driver?.keepsPendingSteersOnInterrupt ||
									driver?.runsOpenCodeServer
										? []
										: undefined),
								call,
								context,
							);
							break;
						}
						case "resolve_permission":
							yield* instance.resolvePermissionEffect(
								row.session_id,
								payload.nativeRequestId ?? payload.requestId,
								payload.response?.decision ?? payload.decision,
								context.providerProcessId,
								call,
								{
									...context,
									...(payload.response ? { response: payload.response } : {}),
								},
							);
							break;
						case "resolve_question":
							yield* instance.resolveQuestionEffect(
								row.session_id,
								payload.nativeRequestId ?? payload.requestId,
								payload.answers,
								call,
								{ ...context, operation: payload.operation ?? "reply" },
							);
							break;
						case "end_session":
							yield* instance.endSessionEffect(row.session_id, call, context);
							break;
					}
				});
				// An unanswered native interrupt becomes obsolete when its captured
				// cohort ends. Release the control through the ordinary receipt path;
				// provider terminals alone still own the turn's outcome.
				yield* (
					stopRunning
						? Effect.raceFirst(
								deliver,
								Effect.repeat(stopRunning, {
									while: (running) => running,
									schedule: Schedule.spaced("100 millis"),
								}).pipe(Effect.asVoid),
							)
						: deliver
				).pipe(
					Effect.provideService(OpenCodeControlTarget, row.provider_process_id),
					Effect.mapError((failure) =>
						providerFailureCode(failure) === "provider_process_gone"
							? new ProviderInstanceFailure({
									providerId: row.provider_id,
									operation: row.effect_type,
									code: "provider_process_gone",
									cause: failure.cause,
								})
							: failure,
					),
				);
				return REACTOR_COMPLETED_RESULT;
			}
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
				const admittedAccount = liveContext?.account ?? payload.account;
				const currentAccount = this.options.accountDirectory
					? yield* this.options.accountDirectory
							.resolve({
								_tag: "Id",
								id:
									admittedAccount?.id ?? payload.instanceId ?? row.provider_id,
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
				if (
					admittedAccount &&
					this.options.accountDirectory &&
					(currentAccount?.id !== admittedAccount.id ||
						currentAccount.driver !== admittedAccount.driver)
				)
					return yield* Effect.fail(
						new ProviderInstanceFailure({
							providerId: row.provider_id,
							operation: "resolveReplayAccount",
							cause: new AccountUnroutable({
								ref: { _tag: "Id", id: admittedAccount.id },
							}),
						}),
					);
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
								projectId: row.project_key,
								...(account ? { account } : {}),
								providerId: row.provider_id,
								workspaceRoot: payload.workspaceRoot,
								extraFolders: payload.extraFolders,
								prepareShellEnv: true,
								requireRoutableAccount: true,
							})
						: undefined;
				const shellEnv = liveContext?.shellEnv ?? call?.shellEnv;
				// Daemon sends can outlive the caller's relay. Resolve its borrow
				// when each interaction arrives, including after adapter intake.
				const currentInteractions = this.options.makeInteractions?.(
					payload.sessionId,
					driver,
				);
				const interactionSink = currentInteractions
					? undefined
					: (interactions ?? makeInteractions?.(payload.sessionId, driver));
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
							eventSink: this.makeReactorEventSink(
								interactionSink,
								currentInteractions,
							),
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
				return yield* new ProviderInstanceFailure({
					providerId: row.provider_id,
					operation: row.effect_type,
					code: "provider_process_gone",
					cause: new Error("Legacy control has no captured provider process"),
				});
			}
			return yield* Effect.fail(
				new UnknownProviderCommandEffect({
					effectType: row.effect_type,
					code: "unknown_provider_command_effect",
				}),
			);
		}).pipe(Effect.scoped);
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
			       effect_type, payload_json, run_id, provider_process_id, attempt_count, status
			FROM provider_command_outbox
			WHERE (${this.options.projectId ?? null} IS NULL OR project_key = ${this.options.projectId ?? null})
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
				readonly effect_type: string | null;
				readonly error: string | null;
		  }
		| undefined,
		ProviderCommandStoreFailure
	> {
		return this.options.sql<{
			readonly status: string;
			readonly error_code: string | null;
			readonly run_status: string | null;
			readonly effect_type: string | null;
			readonly error: string | null;
		}>`SELECT receipt.status, receipt.error_code, receipt.error, command.effect_type, run.status AS run_status FROM command_receipts receipt
			LEFT JOIN provider_command_outbox command ON command.command_id = receipt.command_id
				AND command.project_key = receipt.project_key AND command.request_sequence = (
					SELECT MAX(request_sequence) FROM provider_command_outbox WHERE command_id = receipt.command_id AND project_key = receipt.project_key)
			LEFT JOIN provider_runs reservation ON reservation.id = command.run_id AND reservation.session_id = command.session_id
			LEFT JOIN provider_runs run ON run.id = COALESCE(reservation.joined_into, reservation.id) AND run.session_id = reservation.session_id
			WHERE receipt.command_id = ${commandId}
				AND (${this.options.projectId ?? null} IS NULL OR receipt.project_key = ${this.options.projectId ?? null})`.pipe(
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
						AND project_key = ${row.project_key}`,
					sql`
					UPDATE command_receipts
					SET status = 'side_effect_completed', updated_at = ${updatedAt}
					WHERE command_id = ${row.command_id}
						AND project_key = ${row.project_key}`,
				]),
			)
			.pipe(Effect.asVoid, Effect.mapError(storeFailure("markCompleted")));
	}

	private recordControlOutcome(
		row: ProviderCommandOutboxRow,
		failure?: ProviderInstanceFailure,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		const retryable =
			failure !== undefined &&
			(row.effect_type === "resolve_permission" ||
				row.effect_type === "resolve_question") &&
			failure.retryable &&
			row.attempt_count < maxControlAttempts;
		return (
			failure && !retryable && failure.code === undefined
				? this.readFailedControlPrompt(row)
				: Effect.succeed(undefined)
		).pipe(
			Effect.flatMap((reopened) =>
				this.options.write((project) =>
					Effect.gen({ self: this }, function* () {
						const updatedAt = yield* this.currentTimeMillis();
						const retryAfter = failure?.retryAfter?.trim();
						const retryAfterAt =
							retryAfter === undefined
								? Number.NaN
								: /^\d+$/.test(retryAfter)
									? updatedAt + Number(retryAfter) * 1000
									: /^[a-z]/i.test(retryAfter)
										? Date.parse(retryAfter)
										: Number.NaN;
						const nextAttemptAt = retryable
							? Number.isFinite(retryAfterAt)
								? Math.max(updatedAt, retryAfterAt)
								: updatedAt +
									Duration.toMillis(
										(this.options.retryBackoff ?? defaultRetryBackoff)(
											row.attempt_count,
										),
									)
							: null;
						const errorCode = failure
							? (failure.code ?? providerFailureCode(failure))
							: null;
						const errorJson = failure
							? JSON.stringify({
									_tag: failure._tag,
									providerId: failure.providerId,
									operation: failure.operation,
									code: failure.code,
									causeMessage:
										failure.cause instanceof Error
											? failure.cause.message
											: String(failure.cause),
								})
							: null;
						const changed = yield* this.options
							.sql`UPDATE provider_command_outbox SET status = ${failure?.code === "provider_process_gone" || failure?.code === "provider_process_unavailable" ? "cancelled" : retryable ? "retryable_failed" : failure ? "failed" : "completed"}, error_code = ${errorCode}, next_attempt_at = ${nextAttemptAt}, updated_at = ${updatedAt}
				WHERE request_sequence = ${row.request_sequence} AND project_key = ${row.project_key}
					AND (status = 'running' OR (${row.attempt_count >= maxControlAttempts} AND status IN ('pending', 'retryable_failed')))
					AND attempt_count = ${row.attempt_count} RETURNING command_id`;
						if (changed.length) {
							yield* this.options
								.sql`UPDATE command_receipts SET status = ${retryable ? "side_effect_requested" : failure ? "side_effect_failed" : "side_effect_completed"}, error_code = ${errorCode}, error = ${errorJson}, updated_at = ${updatedAt}
				WHERE command_id = ${row.command_id} AND project_key = ${row.project_key} AND status = 'side_effect_requested'`;
							if (reopened) {
								const current = yield* this.options
									.sql`SELECT id FROM pending_approvals WHERE id = ${reopened.event.data.id} AND session_id = ${row.session_id} AND provider_process_id = ${row.provider_process_id} AND status = 'resolved' AND version = ${reopened.version}`;
								if (current.length) {
									const store = yield* makeEventStoreEffect.pipe(
										Effect.provideService(
											SqlClient.SqlClient,
											this.options.sql,
										),
										Effect.provideService(PersistenceProjectTag, {
											projectId: row.project_key,
										}),
									);
									yield* project([yield* store.append(reopened.event)]);
								}
							}
						}
					}),
				),
			),
			Effect.tap(() =>
				Effect.sync(() => {
					if (!retryable) this.acceptedControls.delete(row.command_id);
				}),
			),
			Effect.mapError(storeFailure("controlOutcome")),
		);
	}

	/** Only confirmed consumption keeps an unconfirmed terminal answer resolved. */
	private readFailedControlPrompt(row: ProviderCommandOutboxRow): Effect.Effect<
		| {
				readonly event: CanonicalEvent<"permission.asked" | "question.asked">;
				readonly version: number;
		  }
		| undefined,
		ProviderCommandStoreFailure
	> {
		return Effect.gen({ self: this }, function* () {
			if (
				row.effect_type !== "resolve_permission" &&
				row.effect_type !== "resolve_question"
			)
				return undefined;
			const payload = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(ProviderControlPayloadSchema),
			)(row.payload_json);
			if (
				payload.type !== "resolve_permission" &&
				payload.type !== "resolve_question"
			)
				return undefined;
			const [prompt] = yield* this.options.sql<{
				version: number;
				tool_name: string | null;
				input: string | null;
				provider_request_id: string | null;
			}>`SELECT version, tool_name, input, provider_request_id FROM pending_approvals WHERE id = ${payload.requestId} AND session_id = ${row.session_id} AND provider_process_id = ${row.provider_process_id} AND status = 'resolved'`;
			if (!prompt) return undefined;
			const input: unknown =
				prompt.input === null ? undefined : JSON.parse(prompt.input);
			const target = {
				id: payload.requestId,
				sessionId: row.session_id,
				providerProcessId: payload.providerProcessId,
				...(prompt.provider_request_id === null
					? {}
					: { providerRequestId: prompt.provider_request_id }),
			};
			const options = {
				provider: row.provider_id,
				metadata: {
					commandId: row.command_id,
					source: "conduit.control-reconciliation",
				},
			};
			const reopened = {
				version: prompt.version,
				event:
					payload.type === "resolve_permission"
						? canonicalEvent(
								"permission.asked",
								row.session_id,
								{ ...target, toolName: prompt.tool_name ?? "", input },
								options,
							)
						: canonicalEvent(
								"question.asked",
								row.session_id,
								{ ...target, questions: input },
								options,
							),
			};
			return yield* Effect.gen({ self: this }, function* () {
				const instances = yield* Effect.serviceOption(OpenCodeInstancesTag);
				if (Option.isNone(instances)) return reopened;
				const call = yield* this.options.resolveSessionCallContext?.(
					row.session_id,
					undefined,
					{
						prompt: {
							id: payload.requestId,
							kind:
								payload.type === "resolve_permission"
									? "permission"
									: "question",
						},
					},
				) ?? Effect.succeed(undefined);
				const running = yield* instances.value.ifRunning(
					call?.account.id ?? row.provider_id,
					call?.workspaceRoot,
				);
				if (Option.isNone(running)) return reopened;
				if (running.value.promptProcessId !== row.provider_process_id)
					return undefined;
				const client = running.value;
				const directory =
					call?.workspaceRoot ??
					(yield* Effect.tryPromise(() => client.session.get(row.session_id)))
						.directory;
				if (!directory) return reopened;
				const pending = yield* Effect.tryPromise(() =>
					payload.type === "resolve_permission"
						? client.permission.list(directory)
						: client.question.list(directory),
				);
				const current = yield* instances.value.ifRunning(
					call?.account.id ?? row.provider_id,
					call?.workspaceRoot,
				);
				if (Option.isNone(current)) return reopened;
				if (current.value.promptProcessId !== row.provider_process_id)
					return undefined;
				return pending.some(
					(request) =>
						request.id === (payload.nativeRequestId ?? payload.requestId),
				)
					? reopened
					: undefined;
			}).pipe(
				Effect.scoped,
				// Reconciliation cannot hold the process queue if the provider is down.
				Effect.timeoutOption("1 second"),
				Effect.map((result) =>
					Option.isSome(result) ? result.value : reopened,
				),
				Effect.catch(() => Effect.succeed(reopened)),
			);
		}).pipe(Effect.mapError(storeFailure("readFailedControlPrompt")));
	}

	/** Missing project services must leave a terminal receipt without ingestion. */
	private refuseProjectCommand(
		row: ProviderCommandOutboxRow,
		failure: ProviderInstanceFailure,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		return Effect.gen({ self: this }, function* () {
			const code = failure.code ?? providerFailureCode(failure);
			let runnerAlive: boolean | undefined;
			if (row.effect_type === "send_turn" && row.status === "running") {
				const [payload] = yield* this.options.sql<{ driver: string }>`
					SELECT COALESCE(json_extract(payload_json, '$.account.driver'), provider_id) AS driver
					FROM provider_command_outbox WHERE request_sequence = ${row.request_sequence}`;
				const instance = this.options.registry.getInstance(
					payload?.driver ?? row.provider_id,
				);
				runnerAlive = yield* instance?.hasLiveProcessEffect?.(row.session_id) ??
					Effect.succeed(undefined);
				if (
					code === "project_inactive" &&
					runnerAlive &&
					instance?.getControlProcessIdEffect
				) {
					const owner = yield* Effect.result(
						instance.getControlProcessIdEffect(row.session_id),
					);
					// Quarantined ownership cannot authorize a stop or a synthetic
					// terminal. Its command can still end without changing the turn.
					if (owner._tag === "Success" && owner.success) {
						const ready = yield* Effect.result(
							this.options.isProjectReady?.(row.project_key, row.session_id) ??
								Effect.succeed(true),
						);
						if (ready._tag === "Success" || ready.failure.code !== code) return;
						// Retire before committing refusal, so a crash retries retirement.
						// Provider loss/terminals, rather than the sweep, settle the run.
						yield* instance
							.endSessionEffect(row.session_id, undefined, {
								commandId: `project-inactive:${row.command_id}:${row.attempt_count}`,
								providerProcessId: owner.success,
							})
							.pipe(
								Effect.catch((cause) =>
									Effect.logWarning(
										"Inactive project runner retirement could not be confirmed",
										cause,
									),
								),
							);
					}
				}
			}
			return yield* this.options
				.write((project, stamp) =>
					Effect.gen({ self: this }, function* () {
						// Registration can change while native retirement is in flight.
						const ready = yield* Effect.result(
							this.options.isProjectReady?.(row.project_key, row.session_id) ??
								Effect.fail(failure),
						);
						if (ready._tag === "Success" || ready.failure.code !== code) return;
						const now = yield* this.currentTimeMillis();
						const unstarted =
							row.effect_type === "send_turn" &&
							(row.status !== "running" || runnerAlive === false)
								? ((yield* this.options.sql<{
										id: string;
									}>`SELECT id FROM provider_runs
								WHERE id = ${row.run_id} AND session_id = ${row.session_id}
									AND status = 'pending' AND started_at IS NULL AND joined_into IS NULL`)[0] ??
									(row.status !== "running" ? { id: randomUUID() } : undefined))
								: undefined;
						// Started work in an unavailable project belongs to its recovery.
						// Claimed intake is started even before run.started is projected.
						if (
							row.effect_type === "send_turn" &&
							!unstarted &&
							code === "project_unavailable"
						)
							return;
						const changed = yield* this.options
							.sql`UPDATE provider_command_outbox
					SET status = ${code === "project_inactive" ? "cancelled" : "failed"}, error_code = ${code},
						next_attempt_at = NULL, updated_at = ${now}, run_id = ${unstarted?.id ?? row.run_id}
					WHERE request_sequence = ${row.request_sequence} AND project_key = ${row.project_key}
						AND attempt_count = ${row.attempt_count} AND status IN ('pending', 'running', 'retryable_failed')
					RETURNING command_id`;
						if (changed.length === 0) return;
						yield* this.options
							.sql`UPDATE command_receipts SET status = 'side_effect_failed',
					error_code = ${code}, error = ${JSON.stringify({
						_tag: failure._tag,
						providerId: row.provider_id,
						operation: row.effect_type,
						code,
						causeMessage:
							failure.cause instanceof Error
								? failure.cause.message
								: String(failure.cause),
					})}, updated_at = ${now}
					WHERE command_id = ${row.command_id} AND project_key = ${row.project_key}
						AND status IN ('side_effect_requested', 'side_effect_failed')`;
						if (unstarted) {
							const store = yield* makeEventStoreEffect.pipe(
								Effect.provideService(SqlClient.SqlClient, this.options.sql),
								Effect.provideService(PersistenceProjectTag, {
									projectId: row.project_key,
								}),
							);
							// Like execution, refusal reserves a new run for an automatic
							// retry. The preceding run's terminal must remain unchanged.
							if (unstarted.id !== row.run_id)
								yield* project([
									yield* store.append(
										canonicalEvent(
											"run.requested",
											row.session_id,
											{ runId: unstarted.id, inputId: row.command_id },
											{
												provider: row.provider_id,
												createdAt: now,
												metadata: { runId: unstarted.id },
											},
										),
									),
								]);
							if (this.options.persistUserMessage) {
								const payload = yield* this.parseSendTurnPayload(row);
								const driver = payload.account?.driver ?? row.provider_id;
								yield* this.options.persistUserMessage(
									row.session_id,
									payload.prompt,
									{
										project,
										messageId:
											payload.continuation?.cutOffMessageId ??
											this.options.registry
												.getInstance(driver)
												?.userMessageIdForInput?.(payload.inputId) ??
											payload.inputId,
										inputId: payload.inputId,
										runId: unstarted.id,
										provider: driver,
										...(payload.images ? { images: payload.images } : {}),
										failure: {
											message:
												failure.cause instanceof Error
													? failure.cause.message
													: String(failure.cause),
											code,
											retryable: false,
										},
									},
								);
							} else {
								yield* project([
									yield* store.append(
										canonicalEvent(
											"turn.error",
											row.session_id,
											{
												messageId: `provider-command:${row.command_id}`,
												error:
													failure.cause instanceof Error
														? failure.cause.message
														: String(failure.cause),
												code,
												retryable: false,
											},
											{
												provider: row.provider_id,
												createdAt: now,
												metadata: {
													runId: unstarted.id,
													commandId: row.command_id,
												},
											},
										),
									),
								]);
							}
						}
						yield* stamp((version) =>
							this.options.sql<{
								id: string;
							}>`UPDATE sessions SET version = ${version}
					WHERE id = ${row.session_id} AND project_id = ${row.project_key} RETURNING id`.pipe(
								Effect.map((rows) => rows.map(({ id }) => id)),
							),
						);
						this.acceptedControls.delete(row.command_id);
					}),
				)
				.pipe(Effect.mapError(storeFailure("refuseProjectCommand")));
		}).pipe(Effect.mapError(storeFailure("refuseProjectCommand")));
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
						AND project_key = ${row.project_key}`,
			sql`
					UPDATE command_receipts
					SET status = 'side_effect_failed', error_code = ${errorCode}, updated_at = ${updatedAt}
					WHERE command_id = ${row.command_id}
						AND project_key = ${row.project_key}`,
		]).pipe(Effect.asVoid);
		return sql
			.withTransaction(updates)
			.pipe(Effect.asVoid, Effect.mapError(storeFailure("markFailed")));
	}

	/**
	 * Event sink handed to the provider during execution. Provider OUTPUT always
	 * streams to the durable ProviderRuntimeIngestion (the mandatory persistence
	 * seam). Daemon interactions resolve the current project borrow per callback;
	 * standalone relays use their caller's sink for their own scoped lifetime.
	 */
	private makeReactorEventSink(
		interactions?: EventSink,
		currentInteractions?: Effect.Effect<EventSink, ProviderInstanceFailure>,
	): EventSink {
		// Keep each request's ID mapping and detach flag until its waiter settles.
		const pending = new Set<{ readonly sink: EventSink }>();
		let detaching = false;
		// Streamed output bypasses the relay sink, so mark the session alive here
		// or the relay's processing timeout fires mid-turn on long turns.
		const push: EventSink["push"] = (event) =>
			Effect.suspend(() => {
				interactions?.noteActivity?.(event);
				return this.options.ingestion
					.ingest(event)
					.pipe(Effect.asVoid, Effect.mapError(toEventSinkError));
			});
		const current: Effect.Effect<EventSink, EventSinkError> =
			currentInteractions?.pipe(Effect.mapError(toEventSinkError)) ??
			Effect.succeed(
				interactions ?? {
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
				},
			);
		return {
			push,
			requestPermission: (request) =>
				Effect.flatMap(current, (sink) => {
					const entry = { sink };
					return Effect.gen(function* () {
						pending.add(entry);
						if (detaching) yield* sink.detachInteractions?.() ?? Effect.void;
						return yield* sink.requestPermission(request);
					}).pipe(Effect.ensuring(Effect.sync(() => pending.delete(entry))));
				}),
			requestQuestion: (request) =>
				Effect.flatMap(current, (sink) => {
					const entry = { sink };
					return Effect.gen(function* () {
						pending.add(entry);
						if (detaching) yield* sink.detachInteractions?.() ?? Effect.void;
						return yield* sink.requestQuestion(request);
					}).pipe(Effect.ensuring(Effect.sync(() => pending.delete(entry))));
				}),
			resolvePermission: (requestId, response) =>
				Effect.suspend(() =>
					currentInteractions
						? Effect.forEach(
								pending,
								({ sink }) => sink.resolvePermission(requestId, response),
								{ discard: true },
							)
						: (interactions?.resolvePermission(requestId, response) ??
							Effect.void),
				),
			resolveQuestion: (requestId, answers) =>
				Effect.suspend(() =>
					currentInteractions
						? Effect.forEach(
								pending,
								({ sink }) => sink.resolveQuestion(requestId, answers),
								{ discard: true },
							)
						: (interactions?.resolveQuestion(requestId, answers) ??
							Effect.void),
				),
			...(currentInteractions || interactions?.detachInteractions
				? {
						detachInteractions: () =>
							Effect.suspend(() => {
								detaching = true;
								return currentInteractions
									? Effect.forEach(
											pending,
											({ sink }) => sink.detachInteractions?.() ?? Effect.void,
											{ discard: true },
										)
									: (interactions?.detachInteractions?.() ?? Effect.void);
							}),
					}
				: {}),
			...(currentInteractions || interactions?.cancelSessionInteractions
				? {
						cancelSessionInteractions: (
							reason: string,
							options?: { readonly recoverQuestions?: boolean },
						) =>
							Effect.suspend(() =>
								currentInteractions
									? Effect.forEach(
											pending,
											({ sink }) =>
												sink.cancelSessionInteractions?.(reason, options) ??
												Effect.void,
											{ discard: true },
										)
									: (interactions?.cancelSessionInteractions?.(
											reason,
											options,
										) ?? Effect.void),
							),
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
		return error.code ?? providerFailureCode(error.cause);
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

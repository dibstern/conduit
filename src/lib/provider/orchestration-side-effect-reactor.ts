import { randomUUID } from "node:crypto";
import {
	Clock,
	Context,
	Data,
	Duration,
	Effect,
	Exit,
	Fiber,
	Option,
	Queue,
	Schedule,
	Schema,
	Scope,
	Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";
import { AccountSchema } from "../contracts/account.js";
import { AttachmentRefSchema } from "../contracts/attachment-ref.js";
import { AccountUnroutable } from "../contracts/limit-recovery.js";
import { getProviderDriver } from "../contracts/provider-instance.js";
import type { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import {
	OpenCodeControlTarget,
	OpenCodeInstancesTag,
} from "../domain/daemon/Services/opencode-instances-service.js";
import {
	isSealedSecretAnswer,
	SecretAnswerFailure,
	type SecretAnswers,
} from "../domain/daemon/Services/secret-answers.js";
import { mark } from "../domain/daemon/Services/turn-timeline.js";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import {
	type InputDrafts,
	InputDraftsTag,
} from "../domain/relay/Services/input-drafts.js";
import type { ProviderRuntimeIngestion } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import * as Failure from "../effect/failure-classification.js";
import type { AttachmentStore } from "../persistence/attachment-store.js";
import type { ClaudeEventPersistEffect } from "../persistence/effect/claude-event-persist-effect.js";
import type {
	CommitAndSignal,
	CommitAndSignalProject,
} from "../persistence/effect/commit-and-signal.js";
import { makeEventStoreEffect } from "../persistence/effect/event-store-effect.js";
import {
	makeProviderStateEffect,
	ProviderStateEffectTag,
} from "../persistence/effect/provider-state-effect.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../persistence/effect/read-query-effect.js";
import { makeRetireReplacedProcessPrompts } from "../persistence/effect/retire-pending-prompts.js";
import {
	ENDED_ROW_COLUMNS,
	type EndedOutboxRow,
	endedRowOutcome,
	LEDGER_EFFECT_TYPES,
	ledgerEffectWakes,
	ledgerFenceWakes,
	loadLedger,
} from "../persistence/effect/run-ledger-arm.js";
import { type CanonicalEvent, canonicalEvent } from "../persistence/events.js";
import { normalizeClaudeLaunchInput } from "./claude/claude-runner-wire.js";
import type { ClaudeLaunchConfig } from "./claude/claude-sdk-env.js";
import type { ClaudeSessionForkSdk } from "./claude/claude-session-fork.js";
import {
	type ClaudeLaunchFields,
	launchClaudeTurn,
} from "./claude/prepare-turn.js";
import {
	nativeCommandUnsupported,
	ProviderInstanceFailure,
	ProviderNotRegistered,
} from "./errors.js";
import type { EventSinkError } from "./event-sink-errors.js";
import { backfillLegacyControlAnswers } from "./legacy-control-outbox.js";
import {
	ProviderControlPayloadSchema,
	STOP_ABORT_WAIT_MS,
} from "./orchestration-command-contracts.js";
import type {
	OrchestrationEngine,
	ProviderCallRequest,
} from "./orchestration-engine.js";
import type { ProviderRegistry } from "./provider-registry.js";
import { toEventSinkError } from "./relay-event-sink.js";
import { resolveTurnImages } from "./resolve-turn-images.js";
import {
	fenceHolds,
	inputPlacement,
	viewLedger,
} from "./run-ledger/run-ledger-decider.js";
import type { Evidence } from "./run-ledger/run-ledger-model.js";
import { RunnerProviderInstance } from "./runner/runner-provider-instance.js";
import {
	classify,
	retrySettlementWrite,
	type SettlementTx,
	terminalTurnResult,
} from "./runner/send-settlement.js";
import {
	appendSendSettlement,
	LegacySendKey,
	settleDirectSend,
	settleLegacySend,
	settleSend,
} from "./runner/send-settlement-outbox.js";
import type { SessionFailure } from "./runner/session-runner.js";
import { legacyStopOwnersQuery, stopCovers } from "./session-run-settlement.js";
import type {
	EventSink,
	ProviderCall,
	ResolvedSendTurnInput,
	SendTurnInput,
	TurnResult,
} from "./types.js";

type ProbeFinding = Extract<Evidence, { kind: "probe_result" }>["finding"];

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
			"attachment_missing",
			"auth_required",
			"provider_process_gone",
			"provider_process_unavailable",
			"provider_control_timeout",
			"secret_answer_expired",
			"secret_answer_unavailable",
			"project_inactive",
			"project_unavailable",
			"model_parameters_unavailable",
			"codex_version_unsupported",
			"runner_detached",
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
	readonly requested_at: number;
	readonly status: "pending" | "running" | "retryable_failed";
}

interface SendTurnOutboxPayload
	extends Omit<
		SendTurnInput,
		"eventSink" | "abortSignal" | "history" | "awaitIntake"
	> {
	readonly history?: SendTurnInput["history"];
}

type LiveSendContext = Pick<
	SendTurnInput,
	"account" | "shellEnv" | "shellConfig"
>;

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

/**
 * H4 (CONTRACT 3.11): removed is final, not served waits unseen, served proceeds.
 * Removed is answered only once no removal or registration of the project runs.
 */
export type ProjectGate = "served" | "not_served" | "removed";

const projectRemoved = (projectId: string) =>
	new ProviderInstanceFailure({
		providerId: "conduit",
		operation: "executeCommand",
		code: "project_inactive",
		cause: `Project ${projectId} is no longer registered`,
	});

export interface ProviderSideEffectReactorOptions {
	readonly scope?: Scope.Scope;
	readonly projectId?: string;
	readonly secretAnswers?: SecretAnswers["Service"];
	readonly sql: SqlClient.SqlClient;
	readonly registry: ProviderRegistry;
	readonly attachmentStore?: Pick<AttachmentStore, "get">;
	readonly ingestion: Pick<ProviderRuntimeIngestion, "ingest" | "ingestBatch">;
	readonly write: CommitAndSignal["write"];
	readonly persistUserMessage?: ClaudeEventPersistEffect["persistUserMessage"];
	readonly claudeSessionForkSdk?: ClaudeSessionForkSdk;
	readonly defaultClaudeLaunchConfig?: () => ClaudeLaunchConfig;
	readonly resolveSessionCallContext?: OrchestrationEngine["resolveSessionCallContextEffect"];
	readonly resolveCallContext?: (
		request: ProviderCallRequest,
	) => Effect.Effect<ProviderCall, ProviderInstanceFailure>;
	/** The one project gate (H4, CONTRACT 3.11); absent means every project is served. */
	readonly projectGate?: (projectId: string) => Effect.Effect<ProjectGate>;
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
/**
 * 9 (CONTRACT.md 3101-3103): a probe is called after an earlier abort of its session only once the
 * abort's call returns, so its idle answer never ends a cancel still in flight.
 */
const PROBE_AFTER_ABORT = `NOT (candidate.effect_type = 'probe' AND EXISTS (
	SELECT 1 FROM provider_command_outbox AS abort
	WHERE abort.effect_type = 'cancel_request' AND abort.status IN ('pending', 'running')
		AND abort.project_key = candidate.project_key AND abort.session_id = candidate.session_id
		AND abort.request_sequence < candidate.request_sequence))`;

/** 4.8: the cap, 5 transmissions per send or control effect. */
const maxControlAttempts = 5;
const runnerControlReplyGraceMs = 5000;
const maxControlRetryAfterMs = 30_000;
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
	private ledgerWakeRegistered = false;

	registerControl(commandId: string, call?: ProviderCall): void {
		this.acceptedControls.set(commandId, call);
	}

	unregisterControl(commandId: string): void {
		this.acceptedControls.delete(commandId);
	}
	private readonly liveCommands = new Set<string>();
	private readonly drainingSessions = new Set<string>();
	private readonly admission = Semaphore.makeUnsafe(1);
	private retryWake:
		| { readonly due: number; fiber?: Fiber.Fiber<void, never> }
		| undefined;

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
			// 3.12, 2.1 row 216: a wake after the commit that inserts a ledger effect. Registered
			// once, in the drain's scope, and removed when that scope closes. It runs only the
			// ledger's effects: a whole drain would also claim main's controls from the callers
			// that execute them, which then wait out an outcome poll.
			const wakeScope =
				this.options.scope ??
				Option.getOrUndefined(yield* Effect.serviceOption(Scope.Scope));
			if (!this.ledgerWakeRegistered && wakeScope) {
				this.ledgerWakeRegistered = true;
				const ledgerEffects = this.options.sql<ProviderCommandOutboxRow>`
					SELECT request_sequence, command_id, project_key, session_id, provider_id,
						effect_type, payload_json, run_id, provider_process_id, attempt_count, status, requested_at
					FROM provider_command_outbox AS candidate
					WHERE (${this.options.projectId ?? null} IS NULL OR project_key = ${this.options.projectId ?? null})
						AND status = 'pending' AND effect_type IN ${this.options.sql.in(LEDGER_EFFECT_TYPES)}
						AND ${this.options.sql.literal(PROBE_AFTER_ABORT)}
					ORDER BY request_sequence
				`.pipe(
					Effect.mapError(storeFailure("ledgerEffects")),
					Effect.flatMap((rows) =>
						Effect.forEach(
							rows,
							(row) =>
								this.runLedgerEffect(row).pipe(
									// A returned abort releases the probes held behind it.
									Effect.tap(() =>
										row.effect_type === "cancel_request"
											? Effect.sync(() => {
													for (const kick of ledgerEffectWakes.get(
														this.options.sql,
													) ?? [])
														kick();
												})
											: Effect.void,
									),
								),
							{ concurrency: "unbounded", discard: true },
						),
					),
				);
				// 2.1 row 202 (CONTRACT.md 215, 714-717): the commit that releases a fence claims the
				// held starts, each through its session lane, and stops at the first control.
				const heldStarts = this.nextPendingRequests().pipe(
					Effect.flatMap((heads) =>
						Effect.forEach(
							heads.filter((head) => head.effect_type === "send_turn"),
							(head) => this.drainSessionLane(head, makeInteractions, true),
							{ concurrency: "unbounded", discard: true },
						),
					),
				);
				for (const [wakes, work] of [
					[ledgerEffectWakes, ledgerEffects],
					[ledgerFenceWakes, heldStarts],
				] as const) {
					const kicks = yield* Queue.sliding<void>(1);
					const wake = () => Queue.offerUnsafe(kicks, undefined);
					const registered =
						wakes.get(this.options.sql) ?? new Set<() => void>();
					wakes.set(this.options.sql, registered.add(wake));
					yield* Scope.addFinalizer(
						wakeScope,
						Effect.sync(() => registered.delete(wake)),
					);
					yield* Effect.forkIn(
						Queue.take(kicks).pipe(
							Effect.andThen(work),
							Effect.catch((cause) =>
								Effect.logError("Run Ledger wake failed", cause),
							),
							Effect.forever,
						),
						wakeScope,
					);
				}
			}
			yield* this.admission.withPermit(
				Effect.gen({ self: this }, function* () {
					if (this.recoveryPrepared) return;
					yield* this.prepareRecovery(this.options.projectId);
					this.recoveryPrepared = true;
				}),
			);
			if (this.options.projectGate) {
				// A removed project has no reactor of its own, so every reactor sweeps
				// its rows: a removed head must not block a process another project shares.
				const commands = yield* this.options.sql<ProviderCommandOutboxRow>`
					SELECT request_sequence, command_id, project_key, session_id, provider_id,
						effect_type, payload_json, run_id, provider_process_id, attempt_count, status, requested_at
					FROM provider_command_outbox
					WHERE status IN ('pending', 'running', 'retryable_failed')
					ORDER BY request_sequence
				`.pipe(Effect.mapError(storeFailure("inactiveCommands")));
				for (const row of commands)
					if ((yield* this.options.projectGate(row.project_key)) === "removed")
						yield* this.withDrainSession(
							row.session_id,
							this.refuseProjectCommand(row),
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
			const heads = yield* this.nextPendingRequests();
			// Arm before running heads too: a held turn can outlast a later retryAt. The heads are this
			// drain's to run, so a wake for one would only race it for its session lane.
			yield* this.armRetryWake(makeInteractions, heads);
			yield* Effect.forEach(
				heads,
				(head) =>
					((head.provider_process_id !== null &&
						head.effect_type !== "send_turn") ||
					LEDGER_EFFECT_TYPES.some((type) => type === head.effect_type)
						? this.runBackgroundRow(head, makeInteractions).pipe(Effect.asVoid)
						: this.drainSessionLane(head, makeInteractions)
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
			yield* this.armRetryWake(makeInteractions);
		});
	}

	private armRetryWake(
		makeInteractions?: ProviderCommandInteractionSinkFactory,
		running: readonly ProviderCommandOutboxRow[] = [],
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		return this.admission.withPermit(
			Effect.gen({ self: this }, function* () {
				const currentScope = yield* Effect.serviceOption(Scope.Scope);
				const scope =
					this.options.scope ??
					(Option.isSome(currentScope) ? currentScope.value : undefined);
				if (!scope) return;
				const now = yield* this.currentTimeMillis();
				const [next] = yield* this.options.sql<{
					due: number | null;
				}>`SELECT MIN(next_attempt_at) AS due
				FROM provider_command_outbox candidate
				WHERE status = 'retryable_failed' AND next_attempt_at IS NOT NULL
					AND request_sequence NOT IN ${this.options.sql.in(running.map((row) => row.request_sequence))}
					AND (${this.options.projectId ?? null} IS NULL OR project_key = ${this.options.projectId ?? null})
					AND (next_attempt_at > ${now}
						OR command_id NOT IN ${this.options.sql.in([...this.liveCommands])})
					AND effect_type NOT IN ${this.options.sql.in(LEDGER_EFFECT_TYPES)}
					AND ((effect_type <> 'send_turn' AND provider_process_id IS NOT NULL)
						OR session_id NOT IN ${this.options.sql.in([...this.drainingSessions])})
					AND NOT EXISTS (
						SELECT 1 FROM provider_command_outbox earlier
						WHERE earlier.status IN ('pending', 'running', 'retryable_failed')
							AND earlier.effect_type NOT IN ${this.options.sql.in(LEDGER_EFFECT_TYPES)} AND (
							(candidate.effect_type <> 'send_turn' AND candidate.provider_process_id IS NOT NULL
								AND earlier.effect_type <> 'send_turn' AND earlier.provider_process_id = candidate.provider_process_id
								AND earlier.request_sequence < candidate.request_sequence)
							OR ((candidate.effect_type = 'send_turn' OR candidate.provider_process_id IS NULL)
								AND earlier.project_key = candidate.project_key AND earlier.session_id = candidate.session_id
								AND (earlier.request_sequence < candidate.request_sequence OR earlier.status = 'running')))
					)`.pipe(Effect.mapError(storeFailure("scheduleRetry")));
				const due = next?.due ?? undefined;
				if (due === this.retryWake?.due) return;
				if (this.retryWake?.fiber) yield* Fiber.interrupt(this.retryWake.fiber);
				this.retryWake = undefined;
				if (due === undefined) return;
				const wake: { readonly due: number; fiber?: Fiber.Fiber<void, never> } =
					{ due };
				this.retryWake = wake;
				wake.fiber = yield* Effect.forkIn(
					Effect.sleep(Math.max(0, due - now)).pipe(
						Effect.andThen(
							Effect.sync(() => {
								if (this.retryWake === wake) this.retryWake = undefined;
							}),
						),
						Effect.andThen(this.drain(makeInteractions)),
						Effect.catch((cause) =>
							Effect.logError("Provider command retry wake failed", cause),
						),
					),
					scope,
				);
			}),
		);
	}

	/** Runs a session's rows from its head, in order; `sendsOnly` stops at the first control. */
	private drainSessionLane(
		head: ProviderCommandOutboxRow,
		makeInteractions?: ProviderCommandInteractionSinkFactory,
		sendsOnly?: true,
	) {
		return this.withDrainSession(
			head.session_id,
			Effect.gen({ self: this }, function* () {
				let row: ProviderCommandOutboxRow | undefined = head;
				while (row && (!sendsOnly || row.effect_type === "send_turn")) {
					if ((yield* this.runBackgroundRow(row, makeInteractions)) === 0)
						return;
					const next = (yield* this.nextPendingRequests(head.session_id))[0];
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
		);
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
			if (LEDGER_EFFECT_TYPES.some((type) => type === row.effect_type)) {
				yield* this.runLedgerEffect(row);
				return 1;
			}
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
						const kept = yield* this.recordControlOutcome(claimed, failure);
						// A refused answer that main keeps and retries is accepted, so its
						// request succeeds (CONTRACT.md 1015-1018).
						if (kept) return REACTOR_COMPLETED_RESULT;
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
		let ownedSend: string | undefined;
		return Effect.gen({ self: this }, function* () {
			// H4: a row this executor runs reads the gate before its claim and,
			// unless removed, writes nothing; the next drain tries it again.
			const gate = yield* this.readProjectGate(row);
			if (gate === "removed") {
				yield* this.refuseProjectCommand(row);
				return yield* projectRemoved(row.project_key);
			}
			if (gate === "not_served") return;
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
			if (row.effect_type === "send_turn")
				ownedSend = `${row.request_sequence}:${row.attempt_count}`;
			const cancellation = new AbortController();
			// 2.1 row 212: a claim past the cap sends nothing and fails its input through main's path.
			const delivery = claimed.exhausted
				? Effect.fail(
						new ProviderInstanceFailure({
							providerId: row.provider_id,
							operation: "sendTurn",
							cause: Object.assign(
								new Error("Provider send attempts exhausted"),
								{ code: "provider_send_attempts_exhausted", retryable: false },
							),
						}),
					)
				: this.runProviderEffect(
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
							const recall = Effect.gen({ self: this }, function* () {
								cancellation.abort();
								const observedAt = yield* this.currentTimeMillis();
								yield* this.recordSendReply(
									row,
									undefined,
									{
										operation: "awaitIntake",
										code: "processing_timeout",
										message: "Input recalled before intake",
									},
									observedAt,
									"unheld_runner",
								);
								return yield* wait.pipe(
									Effect.timeoutOrElse({
										duration: "1 second",
										orElse: () =>
											Effect.succeed({
												...REACTOR_COMPLETED_RESULT,
												status: "indeterminate" as const,
											}),
									}),
								);
							});
							// 2.1 row 202 (CONTRACT.md 215): the fence replaces the intake recall's deadline, so
							// only another writer's durable error recalls the queue.
							return yield* Effect.raceFirst(
								wait,
								this.durableOutcome(row.command_id).pipe(
									Effect.flatMap((outcome) =>
										outcome.error ? recall.pipe(Effect.as(outcome)) : wait,
									),
								),
							);
						}),
			);
			if (
				row.effect_type === "send_turn" &&
				result._tag === "Success" &&
				result.success.status === "indeterminate"
			) {
				yield* this.options
					.write((project, stamp) =>
						Effect.gen({ self: this }, function* () {
							// Direct providers keep their nonterminal uncertainty marker.
							// Runner sends wait for Settle, including between released holds.
							const marked = yield* this.options
								.sql`UPDATE provider_command_outbox
						SET error_code = 'delivery_indeterminate' WHERE request_sequence = ${row.request_sequence}
						AND status = 'running' AND attempt_count = ${row.attempt_count}
						AND NOT EXISTS (
							SELECT 1 FROM provider_runs send
							JOIN provider_runs owner ON owner.id = COALESCE(send.joined_into, send.id)
							WHERE send.id = provider_command_outbox.run_id
							AND (owner.runner_id IS NOT NULL OR owner.held_transmission IS NOT NULL)
						)
						AND NOT EXISTS (
							SELECT 1 FROM events WHERE session_id = ${row.session_id}
							AND type = 'run.dispatched' AND (
								json_extract(data, '$.commandId') = ${row.command_id}
								OR json_extract(data, '$.runId') = (
									SELECT COALESCE(joined_into, id) FROM provider_runs
									WHERE id = provider_command_outbox.run_id
								)
							)
						) RETURNING command_id`;
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
								// CONTRACT.md 2.1 row 215, 4.10: the direct marker's event, in the marker's
								// write; a direct start's token is its runId (3.4).
								if (row.run_id)
									yield* this.appendInWrite(project, row.project_key, [
										canonicalEvent(
											"evidence.delivery_indeterminate",
											row.session_id,
											{ runId: row.run_id, commandId: row.command_id },
											{ provider: row.provider_id },
										),
									]);
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
				if (ownedSend) this.executingSends.delete(ownedSend);
				ownedSend = undefined;
				// Ownership is already released. A replacement that skipped this
				// attempt while it was unwinding now needs to attach its runner.
				yield* this.options.recoverDetachedSession?.(row.session_id) ??
					Effect.void;
				return;
			}
			if (failure && (yield* this.readProjectGate(row)) === "removed") {
				yield* this.refuseProjectCommand(row);
				return yield* projectRemoved(row.project_key);
			}
			if (
				failure ||
				turn?.status === "cancelled" ||
				turn?.status === "error" ||
				turn?.status === "interrupted" ||
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
				const rawFailure = failure
					? providerSessionFailure(failure)
					: undefined;
				const code = failure
					? providerFailureCode(failure)
					: turn?.status === "cancelled"
						? "interrupted"
						: (turn?.error?.code ?? turn?.status ?? "provider_failure");
				const message =
					typeof cause === "object" &&
					cause !== null &&
					"message" in cause &&
					typeof cause.message === "string"
						? cause.message
						: (turn?.error?.message ?? code);
				if (row.effect_type === "send_turn") {
					yield* this.recordSendReply(
						row,
						turn,
						rawFailure ? { ...rawFailure, message, code } : undefined,
						failedAt,
					);
				} else {
					const terminal = terminalTurnResult(turn);
					const retryable = rawFailure
						? classify({ _tag: "failed", failure: rawFailure }) === "retryable"
						: terminal !== undefined &&
							classify({ _tag: "replied", result: terminal }) === "retryable";
					yield* this.writeFailure(row, retryable, code, failedAt);
				}
			} else if (row.effect_type !== "send_turn")
				yield* this.markCompleted(row, yield* this.currentTimeMillis());
			if (
				row.effect_type === "send_turn" &&
				!failure &&
				(turn === undefined || turn.status === "completed")
			)
				yield* this.recordSendReply(
					row,
					turn,
					undefined,
					yield* this.currentTimeMillis(),
				);

			if (result._tag === "Failure") {
				if (row.effect_type !== "send_turn")
					return yield* Effect.fail(result.failure);
				return {
					...REACTOR_COMPLETED_RESULT,
					status: "error",
				} satisfies TurnResult;
			}
			return result.success;
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					if (ownedSend) this.executingSends.delete(ownedSend);
				}),
			),
		);
	}

	private recordSendReply(
		row: ProviderCommandOutboxRow,
		result: TurnResult | undefined,
		failure: SessionFailure | undefined,
		now: number,
		scope: "all" | "unheld_runner" = "all",
	) {
		return Effect.gen({ self: this }, function* () {
			const followUps: Effect.Effect<void>[] = [];
			yield* retrySettlementWrite(
				this.options.write(
					(project, stamp) =>
						Effect.gen({ self: this }, function* () {
							followUps.length = 0;
							const projectContext = this.options.projectContext?.(
								row.project_key,
							);
							const drafts =
								projectContext === undefined
									? yield* Effect.serviceOption(InputDraftsTag)
									: Option.isSome(projectContext)
										? Context.getOption(projectContext.value, InputDraftsTag)
										: Option.none<InputDrafts>();
							const tx: SettlementTx = {
								sql: this.options.sql,
								project,
								stamp,
								...(this.options.persistUserMessage
									? { persistUserMessage: this.options.persistUserMessage }
									: {}),
								userMessageIdForInput: (driver, inputId) =>
									this.options.registry
										.getInstance(driver)
										?.userMessageIdForInput?.(inputId),
								...(Option.isSome(drafts) ? { inputDrafts: drafts.value } : {}),
								afterCommit: (effect) => followUps.push(effect),
							};
							const runId = row.run_id;
							if (!runId) return;
							// From 32.5 a joined steer's runner send is settled on its own while its
							// owner's Run is open (CONTRACT 1625-1632, 2021-2025).
							const [run] = yield* this.options.sql<{
								runner_id: string | null;
								held_transmission: number | null;
								provider: string;
								joined: number;
							}>`SELECT run.runner_id, run.held_transmission, session.provider, run.joined_into IS NOT NULL AS joined
						FROM provider_runs run
						JOIN provider_runs owner ON owner.id = COALESCE(run.joined_into, run.id) AND owner.session_id = run.session_id
						JOIN sessions session ON session.id = run.session_id
						WHERE run.id = ${row.run_id} AND run.session_id = ${row.session_id}
							AND owner.status IN ('pending', 'running')`;
							if (!run) return;
							const ledger = yield* loadLedger(row.session_id).pipe(
								Effect.provideService(SqlClient.SqlClient, this.options.sql),
							);
							const input =
								ledger && inputPlacement(ledger.state, row.command_id);
							// 2.1 row 210 (CONTRACT.md 220, 1852-1858): a declined start is tried again up to
							// the cap, a retryable outcome with main's backoff under main's settle guards. A
							// steer, its own Run's start included, is returned by `steerDeclined` (CONTRACT.md 978-983).
							const reply: TurnResult | undefined =
								result?.status === "steer-declined" && input?.steer === false
									? {
											...result,
											status: "error",
											error: {
												code: "input_declined",
												message: "The provider declined the start",
												retryable: true,
											},
										}
									: result;
							yield* Effect.gen({ self: this }, function* () {
								const payload = yield* this.parseSendTurnPayload(row).pipe(
									Effect.catch(() => Effect.succeed(undefined)),
								);
								const driver =
									payload?.account?.driver ??
									(this.options.registry.getInstance(row.provider_id)
										? row.provider_id
										: run.provider);
								const settlementTx: SettlementTx = {
									...tx,
									driverKind: driver,
								};
								if (
									!(
										this.options.registry.getInstance(driver) instanceof
										RunnerProviderInstance
									)
								) {
									if (scope === "unheld_runner" || run.joined === 1) return;
									yield* settleDirectSend(
										settlementTx,
										row,
										reply,
										failure,
										now,
										Duration.toMillis(
											(this.options.retryBackoff ?? defaultRetryBackoff)(
												row.attempt_count,
											),
										),
									);
									// 2.1 row 207 (CONTRACT.md 218, 973-977): a steer this write failed permanently, not
									// by Stop (4.8, 9), is failed in the view in the same write, so commitAndSignal's
									// requeue cancels it. Row 215 (224) names this writer only as "each writer of its
									// row's outcome"; it names a direct send's token, its runId (3.4), as the decider
									// reads it, not (commandId, transmission) (gap). A decline is not a failure:
									// `steerDeclined` returns it (CONTRACT.md 973), stored as `steer-declined` as
									// the inbox's requeue reads it.
									if (input?.start !== false) return;
									const [failed] = yield* this.options.sql<{
										error_code: string | null;
									}>`SELECT error_code FROM provider_command_outbox
										WHERE request_sequence = ${row.request_sequence} AND project_key = ${row.project_key}
											AND attempt_count = ${row.attempt_count} AND status = 'failed' AND updated_at = ${now}
											AND COALESCE(error_code, '') NOT IN ('interrupted', 'cancelled', 'steer-declined')`;
									if (!failed) return;
									return yield* this.appendInWrite(project, row.project_key, [
										canonicalEvent(
											"evidence.effect_outcome",
											row.session_id,
											{
												commandId: row.command_id,
												transmission: row.attempt_count,
												token: runId,
												outcome: {
													tag: "permanent",
													code: failed.error_code ?? "provider_failure",
												},
											},
											{ provider: row.provider_id, createdAt: now },
										),
									]);
								}
								const legacy = yield* LegacySendKey.prove(
									this.options.sql,
									row,
								);
								if (legacy) {
									if (scope === "unheld_runner" || run.joined === 1) return;
									return yield* settleLegacySend(
										settlementTx,
										legacy,
										reply,
										failure,
										now,
									);
								}
								const send = {
									sessionId: row.session_id,
									runId,
									commandId: row.command_id,
									requestSequence: row.request_sequence,
									attempt: row.attempt_count,
								};
								if (failure) {
									// A transport failure after a hold is owned by reply recovery or Settle.
									return yield* settleSend(settlementTx, {
										_tag: "failed",
										send,
										failure,
										observedAt: now,
									});
								}
								const terminal = terminalTurnResult(reply);
								if (terminal && reply?.runnerSend)
									yield* settleSend(settlementTx, {
										_tag: "replied",
										send: { ...send, ...reply.runnerSend },
										result: terminal,
										observedAt: now,
									});
							});
							// 2.1 row 211 (CONTRACT.md 221): a start cancelled before it reached the agent is
							// Stop's own; it returns behind the pause in this write once its Run is interrupted. A
							// placed message is main's proof of reach the view may not hold yet (D53, gap, reported).
							if (
								result?.status !== "cancelled" ||
								!input?.start ||
								input.place !== "unplaced"
							)
								return;
							const [sent] = yield* this.options.sql<{ sequence: number }>`
								SELECT MAX(sequence) AS sequence FROM events WHERE session_id = ${row.session_id}
									AND type = 'input.sent' AND json_extract(data, '$.inputId') = ${row.command_id}
									AND EXISTS (SELECT 1 FROM provider_runs WHERE id = ${row.run_id}
										AND session_id = ${row.session_id} AND status = 'interrupted')
									AND NOT EXISTS (SELECT 1 FROM messages WHERE session_id = ${row.session_id}
										AND input_id = ${row.command_id})
								HAVING MAX(sequence) IS NOT NULL`;
							if (!sent) return;
							const store = yield* makeEventStoreEffect.pipe(
								Effect.provideService(SqlClient.SqlClient, this.options.sql),
								Effect.provideService(PersistenceProjectTag, {
									projectId: row.project_key,
								}),
							);
							yield* project(
								yield* store.appendBatch([
									canonicalEvent(
										"input.requeued",
										row.session_id,
										{
											sessionId: row.session_id,
											inputId: row.command_id,
											sentSequence: sent.sequence,
											reason: "failed",
										},
										{ createdAt: now, metadata: { runId: row.run_id } },
									),
								]),
							);
						}),
					{
						afterCommit: Effect.suspend(() =>
							Effect.forEach(followUps, (effect) => effect, { discard: true }),
						),
					},
				),
			);
			yield* this.armRetryWake();
		}).pipe(Effect.mapError(storeFailure("settleRunnerReply")));
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
			       effect_type, payload_json, run_id, provider_process_id, attempt_count, status, requested_at
			FROM provider_command_outbox AS candidate
			WHERE (${this.options.projectId ?? null} IS NULL OR project_key = ${this.options.projectId ?? null})
				AND (${sessionId ?? null} IS NULL OR session_id = ${sessionId ?? null})
				AND (status = 'pending'
					OR (status = 'retryable_failed' AND next_attempt_at <= ${nowMs})
					OR (status = 'running' AND effect_type <> 'send_turn' AND attempt_count >= ${maxControlAttempts}
						AND command_id NOT IN ${this.options.sql.in([...this.executingControls])}))
				AND ${this.options.sql.literal(PROBE_AFTER_ABORT)}
				-- 3.12: the ledger's three effects neither wait in nor hold the session lane.
				AND (candidate.effect_type IN ${this.options.sql.in(LEDGER_EFFECT_TYPES)} OR NOT EXISTS (
					SELECT 1 FROM provider_command_outbox AS earlier
					WHERE earlier.status IN ('pending', 'running', 'retryable_failed')
						AND earlier.effect_type NOT IN ${this.options.sql.in(LEDGER_EFFECT_TYPES)} AND (
						(candidate.effect_type <> 'send_turn' AND candidate.provider_process_id IS NOT NULL
							AND earlier.effect_type <> 'send_turn' AND earlier.provider_process_id = candidate.provider_process_id
							AND earlier.request_sequence < candidate.request_sequence)
						OR ((candidate.effect_type = 'send_turn' OR candidate.provider_process_id IS NULL)
							AND earlier.project_key = candidate.project_key AND earlier.session_id = candidate.session_id
							AND (earlier.request_sequence < candidate.request_sequence OR earlier.status = 'running')))
				))
			ORDER BY request_sequence
			`.pipe(
				Effect.map((rows) =>
					rows.filter(
						(row) =>
							!this.liveCommands.has(row.command_id) &&
							((row.effect_type !== "send_turn" &&
								row.provider_process_id !== null) ||
								LEDGER_EFFECT_TYPES.some((type) => type === row.effect_type) ||
								sessionId !== undefined ||
								!this.drainingSessions.has(row.session_id)),
					),
				),
				Effect.mapError(storeFailure("nextPendingRequest")),
			);
		});
	}

	/**
	 * The executor of the ledger's three effects (CONTRACT.md 3.12, 2.1 row 216), one provider call
	 * per type: claim, call, then set the status and append its effect_outcome in one write. A
	 * probe's call is bounded by its retry deadline; a timeout records retryable at that deadline
	 * (3.7). A retry is the decider's fresh transmission, so the row keeps no next_attempt_at.
	 */
	private runLedgerEffect(
		row: ProviderCommandOutboxRow,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		return Effect.gen({ self: this }, function* () {
			const claimed = yield* this.markRunning(
				row,
				yield* this.currentTimeMillis(),
			);
			if (!claimed) return;
			const payload = Schema.decodeUnknownOption(
				Schema.fromJsonString(
					Schema.Struct({
						token: Schema.String,
						deadlineAt: Schema.optionalKey(Schema.Number),
						effect: Schema.Union([
							Schema.Struct({
								kind: Schema.Literal("probe"),
								target: Schema.Union([
									Schema.Struct({
										tag: Schema.Literal("input"),
										inputId: Schema.String,
									}),
									Schema.Struct({ tag: Schema.Literal("native_session") }),
								]),
							}),
							Schema.Struct({ kind: Schema.Literal("cancel_request") }),
							Schema.Struct({
								kind: Schema.Literal("stop_task"),
								key: Schema.Struct({ taskId: Schema.String }),
							}),
						]),
					}),
				),
			)(claimed.payload_json);
			const startedAt = yield* this.currentTimeMillis();
			const deadlineAt = Option.isSome(payload)
				? payload.value.deadlineAt
				: undefined;
			const called = Effect.gen({ self: this }, function* () {
				if (Option.isNone(payload)) return "unparsed" as const;
				const account = this.options.accountDirectory
					? yield* this.options.accountDirectory
							.resolve({ _tag: "Id", id: claimed.provider_id })
							.pipe(
								Effect.catchTag("AccountUnroutable", () =>
									Effect.succeed(undefined),
								),
							)
					: undefined;
				const instance = yield* this.options.registry.getInstanceEffect(
					account?.driver ?? claimed.provider_id,
				);
				const call = yield* this.options.resolveSessionCallContext?.(
					claimed.session_id,
					account,
				) ?? Effect.succeed(undefined);
				const effect = payload.value.effect;
				// 3.4, 3.7: a probe records what its provider read (OpenCode, CONTRACT.md 3089).
				// Gap: no other provider API reports native idle or busy, so its probe reads the
				// native session and records no finding; an absent method never calls the provider.
				const request:
					| Effect.Effect<ProbeFinding | undefined, ProviderInstanceFailure>
					| undefined =
					effect.kind === "cancel_request"
						? instance
								.interruptTurnEffect(claimed.session_id, undefined, call)
								.pipe(Effect.as(undefined))
						: effect.kind === "stop_task"
							? instance
									.stopTaskEffect?.(claimed.session_id, effect.key.taskId, call)
									.pipe(Effect.as(undefined))
							: (instance.probeEffect?.(
									claimed.session_id,
									effect.target,
									call,
								) ??
								instance
									.getNativeSessionEffect?.(claimed.session_id)
									.pipe(Effect.as(undefined)));
				if (!request) return "not_sent" as const;
				const sent = request.pipe(Effect.map((finding) => ({ finding })));
				return deadlineAt === undefined
					? yield* sent
					: yield* sent.pipe(
							Effect.timeoutOption(Math.max(0, deadlineAt - startedAt)),
							Effect.map(Option.getOrElse(() => "timed_out" as const)),
						);
			});
			const result = yield* Effect.result(called);
			const now = yield* this.currentTimeMillis();
			const outcome:
				| { readonly tag: "succeeded" }
				| {
						readonly tag: "retryable";
						readonly retryAt: number;
						readonly code?: string;
				  }
				| { readonly tag: "permanent"; readonly code: string }
				| { readonly tag: "not_sent"; readonly retryAt: number } =
				result._tag === "Failure"
					? result.failure instanceof ProviderInstanceFailure &&
						result.failure.retryable
						? {
								tag: "retryable",
								retryAt: deadlineAt ?? now,
								code:
									result.failure.code ?? providerFailureCode(result.failure),
							}
						: {
								tag: "permanent",
								code:
									result.failure instanceof ProviderInstanceFailure
										? (result.failure.code ??
											providerFailureCode(result.failure))
										: result.failure._tag,
							}
					: typeof result.success === "object"
						? { tag: "succeeded" }
						: result.success === "timed_out"
							? { tag: "retryable", retryAt: deadlineAt ?? now }
							: result.success === "not_sent"
								? { tag: "not_sent", retryAt: now }
								: {
										tag: "permanent",
										code: "provider_command_payload_parse_failed",
									};
			const finding =
				result._tag === "Success" && typeof result.success === "object"
					? result.success.finding
					: undefined;
			yield* this.options
				.write((project) =>
					Effect.gen({ self: this }, function* () {
						const changed = yield* this.options.sql<{ command_id: string }>`
							UPDATE provider_command_outbox SET status = ${outcome.tag === "succeeded" ? "completed" : outcome.tag === "retryable" ? "retryable_failed" : outcome.tag === "not_sent" ? "cancelled" : "failed"},
								error_code = ${"code" in outcome ? (outcome.code ?? null) : null}, next_attempt_at = NULL, updated_at = ${now}
							WHERE request_sequence = ${claimed.request_sequence} AND project_key = ${claimed.project_key}
								AND status = 'running' AND attempt_count = ${claimed.attempt_count}
							RETURNING command_id`;
						if (!changed.length || Option.isNone(payload)) return;
						yield* this.appendInWrite(project, claimed.project_key, [
							canonicalEvent(
								"evidence.effect_outcome",
								claimed.session_id,
								{
									commandId: claimed.command_id,
									transmission: claimed.attempt_count,
									token: payload.value.token,
									outcome,
								},
								{ provider: claimed.provider_id, createdAt: now },
							),
							// 3.4: the finding names the probe's token, in the write that ends its row.
							...(finding === undefined
								? []
								: [
										canonicalEvent(
											"evidence.probe_result",
											claimed.session_id,
											{ token: payload.value.token, finding },
											{ provider: claimed.provider_id, createdAt: now },
										),
									]),
						]);
					}),
				)
				.pipe(Effect.mapError(storeFailure("ledgerEffectOutcome")));
		});
	}

	/** Claim and reserve atomically; an ended reservation is never reopened. */
	private markRunning(
		row: ProviderCommandOutboxRow,
		updatedAt: number,
	): Effect.Effect<
		(ProviderCommandOutboxRow & { readonly exhausted?: true }) | undefined,
		ProviderCommandStoreFailure
	> {
		const runId = randomUUID();
		let ownedKey: string | undefined;
		return this.options
			.write((project, stamp) =>
				Effect.gen({ self: this }, function* () {
					let exhausted = false;
					let relaunch = false;
					if (row.effect_type === "send_turn") {
						const ledger = yield* loadLedger(row.session_id).pipe(
							Effect.provideService(SqlClient.SqlClient, this.options.sql),
						);
						const claim = row.run_id ?? undefined;
						const input =
							ledger && inputPlacement(ledger.state, row.command_id, claim);
						// 2.1 row 202 (CONTRACT.md 215, 714-717): a start waits with no clock while some
						// label has work; the commit that releases the fence wakes the drain. A steer is sent
						// as a steer even as its own Run's start, so a wake takes it (CONTRACT.md 992-995).
						if (
							ledger &&
							input?.start &&
							!input.steer &&
							fenceHolds(ledger.state, claim)
						)
							return undefined;
						// CONTRACT.md 3.6, 692-698 (F40, 3270-3274): its runner's retirement unlaunched this start
						// before main first claimed it, so main requests its Run again. The same runId: the relaunch
						// is the same Run (674-675) and main appends no terminal for an unlaunch (680).
						const active = ledger && viewLedger(ledger.state).active;
						relaunch =
							row.attempt_count === 0 &&
							active?.tag === "Queued" &&
							active.inputs.some(({ inputId }) => inputId === row.command_id);
						// 2.1 row 212 (CONTRACT.md 1873-1876): 5 transmissions per direct send; a runner-held
						// one is holdRun's to cap. The view folds a retry's run.requested on an ended Run only
						// from 32.2.6 (CONTRACT.md 3583), so main's own claims are the floor (gap, reported).
						exhausted =
							ledger !== undefined &&
							getProviderDriver(ledger.provider)?.runsOpenCodeServer === true &&
							Math.max(input?.transmissions ?? 0, row.attempt_count) >=
								maxControlAttempts;
					}
					const [claimed] = yield* this.options.sql<ProviderCommandOutboxRow>`
				UPDATE provider_command_outbox SET status = 'running',
					attempt_count = attempt_count + 1, error_code = NULL, next_attempt_at = NULL, updated_at = ${updatedAt},
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
					effect_type, payload_json, run_id, provider_process_id, attempt_count, status, requested_at`;
					if (claimed?.run_id && (claimed.run_id === runId || relaunch)) {
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
									{ runId: claimed.run_id, inputId: claimed.command_id },
									{
										provider: claimed.provider_id,
										createdAt: updatedAt,
										metadata: { runId: claimed.run_id },
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
					return claimed && exhausted
						? { ...claimed, exhausted: true as const }
						: claimed;
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
			const gate = yield* this.readProjectGate(row);
			if (gate === "removed") return yield* projectRemoved(row.project_key);
			if (gate === "not_served")
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
				const candidates = stop
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
				const stopOwners = candidates
					? yield* Effect.filter(candidates, ({ runId }) =>
							stopCovers(this.options.sql, row.session_id, runId).pipe(
								Effect.mapError(storeFailure("stopCoverage")),
							),
						)
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
								: payload.type === "native_command"
									? undefined
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
				// Bound provider execution in this daemon run, never time queued or
				// offline. Forced retirement owns its bounded process-termination path.
				const replyTimeout =
					getProviderDriver(account?.driver ?? instance.providerId)
						?.runsOpenCodeServer ||
					(payload.type === "end_session" && payload.retireProcess)
						? undefined
						: STOP_ABORT_WAIT_MS + runnerControlReplyGraceMs;
				const timedOut = () =>
					new ProviderInstanceFailure({
						providerId: row.provider_id,
						operation: row.effect_type,
						code: "provider_control_timeout",
						cause: new Error("Provider control reply deadline exceeded"),
					});
				const context = {
					commandId: row.command_id,
					providerProcessId: row.provider_process_id,
					...(payload.type === "interrupt_turn"
						? {
								requestedAt: stop
									? stop.deadlineAt - STOP_ABORT_WAIT_MS
									: row.requested_at,
							}
						: {}),
					...(payload.type === "end_session" && payload.retireRunIds
						? { retireRunIds: payload.retireRunIds }
						: {}),
				};
				const instances = yield* Effect.serviceOption(OpenCodeInstancesTag);
				// A native command addresses the session, not a process: with none live it is the
				// next launch's first send (lane 82tn.32.26's reading of CONTRACT.md 8.5, 2922).
				if (
					instance.getControlProcessIdEffect &&
					payload.type !== "native_command"
				) {
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
						const failure = (cause: unknown) =>
							new ProviderInstanceFailure({
								providerId: row.provider_id,
								operation: row.effect_type,
								cause,
							});
						// The question lives in the session's workspace, which a fork may not share with the relay.
						const session = yield* Effect.tryPromise({
							try: () => client.session.get(row.session_id),
							catch: failure,
						});
						if (!session.directory)
							return yield* Effect.fail(
								failure(
									`OpenCode session "${row.session_id}" has no stored directory`,
								),
							);
						const directory = session.directory;
						yield* Effect.tryPromise({
							try: () =>
								client.question.reject(
									payload.nativeRequestId ?? payload.requestId,
									directory,
								),
							catch: failure,
						});
						return REACTOR_COMPLETED_RESULT;
					}
				}
				const deliver = Effect.gen({ self: this }, function* () {
					switch (payload.type) {
						case "interrupt_turn": {
							// A Stop that captured only a retained steer sends nothing, as main's Stop entry
							// (provider-turn-service.ts 214). Its row waits behind the steer's send, and an
							// empty interrupt there would close the idle query the steer answered on.
							// With neither an owner nor anything that may still act, Stop issues nothing
							// (CONTRACT.md 5.1, 5260; oracle RL-079).
							if (payload.stop?.owners.length === 0) {
								if (payload.stop.retainedSteers) break;
								const ledger = yield* loadLedger(row.session_id).pipe(
									Effect.provideService(SqlClient.SqlClient, this.options.sql),
									Effect.mapError(storeFailure("stopLedgerView")),
								);
								if (ledger && !viewLedger(ledger.state).anythingMayAct) break;
							}
							const driver = getProviderDriver(
								account?.driver ?? instance.providerId,
							);
							yield* instance.interruptTurnEffect(
								row.session_id,
								// A Stop names its committed cohort's runs, never reusable input ids (4.6).
								// A legacy payload keeps its turnIds; the predecessor omitted them for an
								// empty Stop, so fence delivery without changing its committed payload.
								payload.stop?.owners.map(({ runId }) => runId) ??
									payload.turnIds ??
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
						case "resolve_question": {
							let answers = payload.answers;
							if (Object.values(answers).some(isSealedSecretAnswer)) {
								if (
									!this.acceptedControls.has(row.command_id) &&
									instance.getControlCommandStatusEffect
								) {
									// The previous daemon may have delivered before losing its reply.
									// Runner completion survives independently of the sealing key.
									const status = yield* Effect.repeat(
										instance.getControlCommandStatusEffect(
											row.session_id,
											context,
										),
										{
											while: (value) => value === "running",
											schedule: Schedule.spaced("100 millis"),
										},
									);
									if (status === "completed") break;
									if (status === "failed" || status === "gone")
										return yield* new ProviderInstanceFailure({
											providerId: row.provider_id,
											operation: row.effect_type,
											...(status === "gone"
												? { code: "provider_process_gone" as const }
												: {}),
											cause:
												status === "gone"
													? "The original provider process is gone."
													: "The runner previously failed this answer command.",
										});
								}
								if (!this.options.secretAnswers)
									return yield* new ProviderInstanceFailure({
										providerId: row.provider_id,
										operation: row.effect_type,
										code: "secret_answer_unavailable",
										cause: new SecretAnswerFailure({
											code: "secret_answer_unavailable",
										}),
									});
								answers = yield* this.options.secretAnswers
									.unseal(answers)
									.pipe(
										Effect.mapError(
											(cause) =>
												new ProviderInstanceFailure({
													providerId: row.provider_id,
													operation: row.effect_type,
													code: cause.code,
													cause,
												}),
										),
									);
							}
							yield* instance.resolveQuestionEffect(
								row.session_id,
								payload.nativeRequestId ?? payload.requestId,
								answers,
								call,
								{ ...context, operation: payload.operation ?? "reply" },
							);
							break;
						}
						case "end_session":
							yield* instance.endSessionEffect(row.session_id, call, context);
							break;
						case "native_command":
							if (!instance.sendNativeCommandEffect)
								return yield* nativeCommandUnsupported(row.provider_id);
							yield* instance.sendNativeCommandEffect(
								row.session_id,
								row.command_id,
								payload.text,
								call,
							);
							break;
					}
				});
				// Runner controls are bound to their captured turns. OpenCode's abort
				// is session-wide and can still cancel replacement work after a terminal.
				const delivery = (
					stopRunning &&
					instance.getControlProcessIdEffect &&
					!getProviderDriver(account?.driver ?? instance.providerId)
						?.runsOpenCodeServer
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
				yield* replyTimeout === undefined
					? delivery
					: delivery.pipe(
							Effect.timeoutOrElse({
								duration: replyTimeout,
								orElse: () => Effect.fail(timedOut()),
							}),
						);
				return REACTOR_COMPLETED_RESULT;
			}
			if (row.effect_type === "send_turn") {
				const payload = yield* this.parseSendTurnPayload(row);
				if (payload.continuation) {
					const placementId = `continuation-placement:${payload.runId}`;
					const [placed] = yield* this.options.sql<{ event_id: string }>`
						SELECT event_id FROM events WHERE project_id = ${row.project_key}
							AND session_id = ${payload.sessionId} AND event_id = ${placementId}
						LIMIT 1`.pipe(Effect.mapError(storeFailure("placeContinuation")));
					if (!placed)
						yield* this.options.ingestion
							.ingest({
								eventId: placementId,
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
				}
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
				const instance = yield* this.options.registry.getInstanceEffect(driver);
				const prepareCall = yield* Effect.cached(
					liveContext?.shellEnv === undefined && this.options.resolveCallContext
						? this.options.resolveCallContext({
								sessionId: payload.sessionId,
								projectId: row.project_key,
								...(account ? { account } : {}),
								providerId: row.provider_id,
								workspaceRoot: payload.workspaceRoot,
								extraFolders: payload.extraFolders,
								prepareShellEnv: true,
								requireRoutableAccount: true,
							})
						: Effect.succeed(undefined),
				);
				const call =
					instance instanceof RunnerProviderInstance
						? undefined
						: yield* prepareCall;
				const shellEnv = liveContext?.shellEnv ?? call?.shellEnv;
				const shellConfig =
					liveContext?.shellEnv !== undefined
						? liveContext.shellConfig
						: call?.shellConfig;
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
				const turnKey = {
					sessionId: payload.sessionId,
					inputId: payload.inputId,
				};
				mark(turnKey, "reactor-start");
				const send = (planned: ClaudeLaunchFields | undefined) =>
					Effect.gen({ self: this }, function* () {
						mark(turnKey, "history-ready");
						const input = yield* resolveTurnImages(
							payload,
							this.options.attachmentStore,
						).pipe(
							Effect.mapError(
								(cause) =>
									new ProviderInstanceFailure({
										providerId: row.provider_id,
										operation: "resolveTurnImages",
										...(cause._tag === "AttachmentMissing"
											? { code: "attachment_missing" as const }
											: {}),
										cause,
									}),
							),
						);
						const sendInput: ResolvedSendTurnInput = {
							...input,
							...(shellEnv ? { shellEnv } : {}),
							...(shellConfig !== undefined ? { shellConfig } : {}),
							awaitIntake: this.awaitIntake(row),
							commandAttempt: row.attempt_count,
							account:
								account?.driver === "claude" && planned && !payload.account
									? { ...account, folder: planned.configDir }
									: account,
							instanceId,
							history: payload.history ?? [],
							...planned,
							eventSink: this.makeReactorEventSink(
								interactionSink,
								currentInteractions,
							),
							abortSignal: abortSignal ?? new AbortController().signal,
						};
						return yield* instance instanceof RunnerProviderInstance
							? instance.sendTurnEffect(sendInput, prepareCall)
							: instance.sendTurnEffect(sendInput);
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
							return yield* launchClaudeTurn({
								sessionId: payload.sessionId,
								instanceId,
								commandId: row.command_id,
								turn: payload,
								launch: {
									configDir: launch.configDir,
									folderSource: launch.folderSource,
								},
								liveSession: yield* instance.getNativeSessionEffect?.(
									payload.sessionId,
								) ?? Effect.succeed(undefined),
								sessionForkSdk: this.options.claudeSessionForkSdk,
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
					: yield* send(undefined);
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
		}).pipe(
			Effect.scoped,
			// 3.11 (CONTRACT.md 1083-1085): a send its project's removal cut short is
			// not sent and writes nothing; its next try meets the project gate. While
			// served, the failure stands, so a missing root never loops a spawn.
			Effect.catchIf(
				(failure) =>
					failure instanceof ProviderInstanceFailure &&
					failure.code === "not_sent",
				(failure) =>
					this.readProjectGate(row).pipe(
						Effect.flatMap((gate) =>
							gate === "served"
								? Effect.fail(failure)
								: this.runProviderEffect(
										row,
										interactions,
										makeInteractions,
										abortSignal,
										liveContext,
									),
						),
					),
			),
		);
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
			       effect_type, payload_json, run_id, provider_process_id, attempt_count, status, requested_at
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
					shellConfig: _shellConfig,
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

	/** A control row's success, with its effect_outcome in the same write (3.4, 3.12). */
	private markCompleted(
		row: ProviderCommandOutboxRow,
		updatedAt: number,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		const { sql } = this.options;
		return this.options
			.write((project) =>
				Effect.gen({ self: this }, function* () {
					const ended = yield* sql<EndedOutboxRow>`
					UPDATE provider_command_outbox
					SET status = 'completed', payload_json = CASE WHEN json_valid(payload_json) THEN json_remove(payload_json, '$.images') ELSE payload_json END, updated_at = ${updatedAt}
					WHERE request_sequence = ${row.request_sequence}
						AND project_key = ${row.project_key}
					RETURNING ${sql.literal(ENDED_ROW_COLUMNS)}`;
					yield* sql`
					UPDATE command_receipts
					SET status = 'side_effect_completed', updated_at = ${updatedAt}
					WHERE command_id = ${row.command_id}
						AND project_key = ${row.project_key}`;
					yield* this.appendInWrite(
						project,
						row.project_key,
						ended.map(endedRowOutcome),
					);
				}),
			)
			.pipe(Effect.mapError(storeFailure("markCompleted")));
	}

	/**
	 * Append and project events in the caller's write, under the row's project (3.12). An event
	 * for a session whose row is gone is dropped: deletion's retention drain has run or is
	 * running, and an event after it would outlive the tombstone. CONTRACT.md 224 (row 215)
	 * spares only `process_lost` there; `effect_outcome` takes the same reading (gap, reported).
	 */
	private appendInWrite(
		project: CommitAndSignalProject,
		projectId: string,
		events: readonly CanonicalEvent[],
	) {
		return Effect.gen({ self: this }, function* () {
			if (events.length === 0) return;
			const live = new Set(
				(yield* this.options.sql<{ id: string }>`SELECT id FROM sessions
					WHERE id IN ${this.options.sql.in(events.map((event) => event.sessionId))}`).map(
					(row) => row.id,
				),
			);
			const kept = events.filter((event) => live.has(event.sessionId));
			if (kept.length === 0) return;
			const store = yield* makeEventStoreEffect.pipe(
				Effect.provideService(SqlClient.SqlClient, this.options.sql),
				Effect.provideService(PersistenceProjectTag, { projectId }),
			);
			yield* project(yield* store.appendBatch(kept));
		});
	}

	private recordControlOutcome(
		row: ProviderCommandOutboxRow,
		failure?: ProviderInstanceFailure,
	): Effect.Effect<boolean, ProviderCommandStoreFailure> {
		const retryable =
			failure !== undefined &&
			(row.effect_type === "resolve_permission" ||
				row.effect_type === "resolve_question") &&
			failure.retryable &&
			row.attempt_count < maxControlAttempts;
		const unsealFailed =
			failure?.code === "secret_answer_expired" ||
			failure?.code === "secret_answer_unavailable";
		return (
			failure &&
			!retryable &&
			(failure.code === undefined ||
				failure.code === "provider_control_timeout" ||
				unsealFailed)
				? this.readFailedControlPrompt(row, unsealFailed)
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
								? Math.min(
										updatedAt + maxControlRetryAfterMs,
										Math.max(updatedAt, retryAfterAt),
									)
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
							.sql<EndedOutboxRow>`UPDATE provider_command_outbox SET status = ${failure?.code === "provider_process_gone" || failure?.code === "provider_process_unavailable" ? "cancelled" : retryable ? "retryable_failed" : failure ? "failed" : "completed"}, payload_json = CASE WHEN ${retryable} OR NOT json_valid(payload_json) THEN payload_json ELSE json_remove(payload_json, '$.images') END, error_code = ${errorCode}, next_attempt_at = ${nextAttemptAt}, updated_at = ${updatedAt}
				WHERE request_sequence = ${row.request_sequence} AND project_key = ${row.project_key}
					AND (status = 'running' OR (${row.attempt_count >= maxControlAttempts} AND status IN ('pending', 'retryable_failed')))
					AND attempt_count = ${row.attempt_count} RETURNING ${this.options.sql.literal(ENDED_ROW_COLUMNS)}`;
						if (changed.length) {
							yield* this.options
								.sql`UPDATE command_receipts SET status = ${retryable ? "side_effect_requested" : failure ? "side_effect_failed" : "side_effect_completed"}, error_code = ${errorCode}, error = ${errorJson}, updated_at = ${updatedAt}
				WHERE command_id = ${row.command_id} AND project_key = ${row.project_key} AND status = 'side_effect_requested'`;
							const current = reopened
								? yield* this.options
										.sql`SELECT id FROM pending_approvals WHERE id = ${reopened.event.data.id} AND session_id = ${row.session_id} AND provider_process_id = ${row.provider_process_id} AND status = 'resolved' AND version = ${reopened.version}`
								: [];
							yield* this.appendInWrite(project, row.project_key, [
								...changed.map(endedRowOutcome),
								...(reopened && current.length
									? [
											reopened.event,
											...(reopened.notice ? [reopened.notice] : []),
										]
									: []),
							]);
						}
					}),
				),
			),
			Effect.tap(() =>
				Effect.sync(() => {
					if (!retryable) this.acceptedControls.delete(row.command_id);
				}),
			),
			Effect.as(retryable),
			Effect.mapError(storeFailure("controlOutcome")),
		);
	}

	/** Reopen runner answers only after confirming they were not consumed. */
	private readFailedControlPrompt(
		row: ProviderCommandOutboxRow,
		unsealFailed = false,
	): Effect.Effect<
		| {
				readonly event: CanonicalEvent<"permission.asked" | "question.asked">;
				readonly version: number;
				readonly notice?: CanonicalEvent<"turn.notice">;
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
				run_id: string | null;
			}>`SELECT version, tool_name, input, provider_request_id,
				(SELECT json_extract(metadata, '$.runId') FROM events
				 WHERE session_id = pending_approvals.session_id AND type = ${`${row.effect_type === "resolve_permission" ? "permission" : "question"}.asked`}
					AND json_extract(data, '$.id') = pending_approvals.id
				 ORDER BY sequence LIMIT 1) AS run_id
			FROM pending_approvals WHERE id = ${payload.requestId} AND session_id = ${row.session_id} AND provider_process_id = ${row.provider_process_id} AND status = 'resolved'`;
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
					...(prompt.run_id ? { runId: prompt.run_id } : {}),
				},
			};
			const reopened = {
				version: prompt.version,
				...(unsealFailed
					? {
							notice: canonicalEvent(
								"turn.notice",
								row.session_id,
								{
									text: "Secret answer expired after the server restarted. Please re-enter the answer.",
								},
								options,
							),
						}
					: {}),
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
			const call = yield* (
				this.options.resolveSessionCallContext?.(row.session_id, undefined, {
					prompt: {
						id: payload.requestId,
						kind:
							payload.type === "resolve_permission" ? "permission" : "question",
					},
				}) ?? Effect.succeed(undefined)
			).pipe(Effect.catch(() => Effect.succeed(undefined)));
			const account =
				call?.account ??
				(this.options.accountDirectory
					? yield* this.options.accountDirectory
							.resolve({ _tag: "Id", id: row.provider_id })
							.pipe(Effect.catch(() => Effect.succeed(undefined)))
					: undefined);
			const instance = this.options.registry.getInstance(
				account?.driver ?? row.provider_id,
			);
			if (!instance) return undefined;
			// Sealed runner replays already proved not_received before unsealing.
			// Native providers still need their pending-prompt check below.
			if (unsealFailed && instance.getControlCommandStatusEffect)
				return reopened;
			if (instance.getControlCommandStatusEffect) {
				const status = yield* instance
					.getControlCommandStatusEffect(row.session_id, {
						commandId: row.command_id,
						providerProcessId: payload.providerProcessId,
					})
					.pipe(
						Effect.timeoutOption("1 second"),
						Effect.catch(() => Effect.succeed(Option.none())),
					);
				// A missing reply or a failed command does not prove nonconsumption.
				return Option.isSome(status) &&
					(status.value === "not_received" || status.value === "gone")
					? reopened
					: undefined;
			}
			return yield* Effect.gen({ self: this }, function* () {
				const instances = yield* Effect.serviceOption(OpenCodeInstancesTag);
				if (Option.isNone(instances)) return reopened;
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

	/** The one project gate (H4, CONTRACT 3.11) for a row; absent means served. */
	private readProjectGate(
		row: Pick<ProviderCommandOutboxRow, "project_key">,
	): Effect.Effect<ProjectGate> {
		return (
			this.options.projectGate?.(row.project_key) ?? Effect.succeed("served")
		);
	}

	/**
	 * A removed project's row ends final as project_inactive (H4). A send its
	 * runner or provider may hold is never refused (3.11): removal's retirement
	 * ends that run, so the refusal neither retires a runner nor touches it.
	 */
	private refuseProjectCommand(
		row: ProviderCommandOutboxRow,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		return Effect.gen({ self: this }, function* () {
			const failure = projectRemoved(row.project_key);
			const code = "project_inactive";
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
				// Removed is read only once removal's Stops committed, so a runner still
				// alive here survived it (a restart over a hand-edited config): retire it,
				// and its loss, not this refusal, ends the run.
				const owner =
					runnerAlive && instance?.getControlProcessIdEffect
						? yield* Effect.result(
								instance.getControlProcessIdEffect(row.session_id),
							)
						: undefined;
				// Quarantined ownership cannot authorize a stop; a re-added project keeps its runner.
				if (
					instance &&
					owner?._tag === "Success" &&
					owner.success &&
					(yield* this.readProjectGate(row)) === "removed"
				)
					yield* instance
						.endSessionEffect(row.session_id, undefined, {
							commandId: `project-inactive:${row.command_id}:${row.attempt_count}`,
							providerProcessId: owner.success,
							projectRemoved: true,
						})
						.pipe(
							Effect.catch((cause) =>
								Effect.logWarning(
									"Removed project runner retirement could not be confirmed",
									cause,
								),
							),
						);
				if (runnerAlive !== false) return;
			}
			return yield* this.options
				.write((project, stamp) =>
					Effect.gen({ self: this }, function* () {
						// A re-add between the drain's read and this write delivers the row.
						if ((yield* this.readProjectGate(row)) !== "removed") return;
						const now = yield* this.currentTimeMillis();
						const unstarted =
							row.effect_type === "send_turn"
								? ((yield* this.options.sql<{
										id: string;
									}>`SELECT id FROM provider_runs
								WHERE id = ${row.run_id} AND session_id = ${row.session_id}
									AND status = 'pending' AND started_at IS NULL AND joined_into IS NULL`)[0] ??
									(row.status !== "running" ? { id: randomUUID() } : undefined))
								: undefined;
						const stampSession = stamp((version) =>
							this.options.sql<{
								id: string;
							}>`UPDATE sessions SET version = ${version}
					WHERE id = ${row.session_id} AND project_id = ${row.project_key} RETURNING id`.pipe(
								Effect.map((rows) => rows.map(({ id }) => id)),
							),
						);
						// A claimed send whose run started belongs to its provider's loss.
						if (row.effect_type === "send_turn" && !unstarted) {
							// Removal's runner retirement has no settlement owner once its project
							// is gone (3.11), so the run that loss ended settles here, as that loss.
							const [open] =
								runnerAlive === false
									? yield* this.options.sql<{
											id: string;
										}>`SELECT id FROM provider_runs
								WHERE id = ${row.run_id} AND session_id = ${row.session_id}
									AND status IN ('pending', 'running')`
									: [];
							if (!open) return;
							yield* appendSendSettlement(
								{ sql: this.options.sql, project, stamp },
								row,
								{ _tag: "process_lost", reason: { _tag: "ProjectRemoved" } },
								"permanent",
								now,
							);
							yield* stampSession;
							return;
						}
						const changed = yield* this.options
							.sql<EndedOutboxRow>`UPDATE provider_command_outbox
					SET status = 'cancelled', error_code = ${code},
						payload_json = CASE WHEN json_valid(payload_json) THEN json_remove(payload_json, '$.images') ELSE payload_json END,
						next_attempt_at = NULL, updated_at = ${now}, run_id = ${unstarted?.id ?? row.run_id}
					WHERE request_sequence = ${row.request_sequence} AND project_key = ${row.project_key}
						AND attempt_count = ${row.attempt_count} AND status IN ('pending', 'running', 'retryable_failed')
					RETURNING ${this.options.sql.literal(ENDED_ROW_COLUMNS)}`;
						if (changed.length === 0) return;
						// 3.12: a control row the refusal sweep ends appends its outcome, n 0 unclaimed.
						if (row.effect_type !== "send_turn")
							yield* this.appendInWrite(
								project,
								row.project_key,
								changed.map(endedRowOutcome),
							);
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
						yield* stampSession;
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
		return this.options
			.write((project) =>
				Effect.gen({ self: this }, function* () {
					const ended = yield* sql<EndedOutboxRow>`
					UPDATE provider_command_outbox
					SET status = ${retryable ? "retryable_failed" : "failed"},
					    payload_json = CASE WHEN ${retryable} OR NOT json_valid(payload_json) THEN payload_json ELSE json_remove(payload_json, '$.images') END,
					    error_code = ${errorCode},
					    next_attempt_at = ${nextAttemptAt},
					    updated_at = ${updatedAt}
					WHERE request_sequence = ${row.request_sequence}
						AND project_key = ${row.project_key}
					RETURNING ${sql.literal(ENDED_ROW_COLUMNS)}`;
					yield* sql`
					UPDATE command_receipts
					SET status = 'side_effect_failed', error_code = ${errorCode}, updated_at = ${updatedAt}
					WHERE command_id = ${row.command_id}
						AND project_key = ${row.project_key}`;
					// A control row's failure, with its effect_outcome in the same write (3.4, 3.12).
					yield* this.appendInWrite(
						project,
						row.project_key,
						ended.map(endedRowOutcome),
					);
				}),
			)
			.pipe(Effect.mapError(storeFailure("markFailed")));
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

function providerSessionFailure(error: unknown): SessionFailure {
	const cause = error instanceof ProviderInstanceFailure ? error.cause : error;
	return {
		operation: "send-turn",
		message:
			isRecord(cause) && typeof cause["message"] === "string"
				? cause["message"]
				: String(cause),
		code: providerFailureCode(error),
		...(isRecord(cause) && typeof cause["retryable"] === "boolean"
			? { retryable: cause["retryable"] }
			: {}),
	};
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
		(value["images"] === undefined ||
			Schema.is(Schema.Array(AttachmentRefSchema))(value["images"])) &&
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

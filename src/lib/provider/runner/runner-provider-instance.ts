import { randomUUID } from "node:crypto";
import {
	Brand,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberMap,
	Option,
	Scope,
} from "effect";
import { SqlClient } from "effect/sql";
import type { AccountsState } from "../../account-directory.js";
import type { Account } from "../../contracts/account.js";
import type { AttachmentRef } from "../../contracts/attachment-ref.js";
import type { KnownProviderDriverKind } from "../../contracts/provider-instance.js";
import {
	bindTurnTimelineSink,
	observeTurnTimelineFrame,
} from "../../domain/daemon/Services/turn-timeline.js";
import {
	Usage,
	type UsageService,
} from "../../domain/daemon/Services/usage.js";
import type { InputDrafts } from "../../domain/project-services/Services/input-drafts.js";
import type { PendingInteractionService } from "../../domain/project-services/Services/pending-interaction-service.js";
import type {
	ProviderRuntimeIngestion,
	ProviderRuntimeIngestionError,
} from "../../domain/project-services/Services/provider-runtime-ingestion-service.js";
import * as Failure from "../../effect/failure-classification.js";
import { formatErrorDetail } from "../../errors-utils.js";
import { createLogger } from "../../logger.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
	type ClaudeEventPersistFailure,
} from "../../persistence/effect/claude-event-persist-effect.js";
import { guardCurrentWrite } from "../../persistence/effect/commit-and-signal.js";
import type { makeRetireReplacedProcessPrompts } from "../../persistence/effect/retire-pending-prompts.js";
import { loadLedgerView } from "../../persistence/effect/run-ledger-arm.js";
import type { SessionPermissionMode } from "../../shared-types.js";
import {
	nativeCommandUnsupported,
	ProviderInstanceFailure,
} from "../errors.js";
import type { OrchestrationEngine } from "../orchestration-engine.js";
import type { ProjectEventSinkDeps } from "../project-event-sink.js";
import type { ProviderRegistry } from "../provider-registry.js";
import type { NativeCommandView } from "../run-ledger/run-ledger-model.js";
import { settleToolChildRuns } from "../session-run-settlement.js";
import type {
	EventSink,
	PermissionDecision,
	PreWarmSessionInput,
	ProviderCall,
	ProviderCapabilities,
	ProviderControlCommandStatus,
	ProviderControlContext,
	ProviderInstance,
	ProviderNativeSession,
	ResolvedSendTurnInput,
	TurnResult,
} from "../types.js";
import { makeProductionProcessTable } from "./process-table.js";
import { makeRecoveredEventSink } from "./runner-event-sink.js";
import {
	runnerSinkId,
	runnerFailure as sessionFailure,
} from "./runner-protocol.js";
import {
	currentPendingSendOwner,
	runningRunnerCommands,
	settleUnclaimedRunnerCommands,
} from "./runner-recovery.js";
import { discoverAllRunners } from "./runner-registry.js";
import { failRunnerTurn } from "./runner-turn-failure.js";
import {
	makeSendScopes,
	type SendScope,
	type SendScopes,
} from "./send-scope.js";
import type {
	AdmitSend,
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionRunner,
	SessionTurn,
} from "./session-runner.js";
import type { TurnFacts } from "./turn-facts.js";

const log = createLogger("runner-provider-instance");

/** Check every owner, including one retained across an account rebind. */
export const assertSessionRunnerAvailable = (
	sessionId: string,
	registry: ProviderRegistry | undefined,
	account?: Account,
) =>
	Effect.gen(function* () {
		for (const providerId of registry?.listProviders() ?? []) {
			const provider = registry?.getInstance(providerId);
			if (!(provider instanceof RunnerProviderInstance)) continue;
			const failure = yield* provider.getSessionFailureEffect(sessionId);
			if (failure)
				return yield* new ProviderInstanceFailure({
					providerId,
					operation: failure.operation,
					cause: Object.assign(new Error(failure.message), failure),
				});
			if (account) {
				const block = yield* provider.getAccountSwitchBlockEffect(
					sessionId,
					account,
				);
				if (block) return yield* block;
			}
		}
	});

type PreparedTurnFields = Omit<
	Extract<SessionCommand, { type: "send-turn" }>,
	"type" | "sinkId" | "aborted" | "input"
> & { readonly input: SessionTurn & { readonly facts: TurnFacts } };

/** A send-turn's prepared fields; only launchRunnerTurn builds one. */
export type PreparedTurn = PreparedTurnFields & Brand.Brand<"PreparedTurn">;

const preparedTurn = Brand.nominal<PreparedTurn>();

/** First delivery and recovery alike launch a turn through the driver's prepare. */
export const launchRunnerTurn = (
	driver: Pick<RunnerDriverPieces, "prepareTurnEffect">,
	input: SessionTurn,
): Effect.Effect<PreparedTurn, ProviderInstanceFailure> =>
	driver.prepareTurnEffect(input).pipe(Effect.map(preparedTurn));

/** Provider policy only; sink, interaction and runner lifetime belong to the instance. */
export interface RunnerDriverPieces {
	readonly driverKind: KnownProviderDriverKind;
	discoverEffect(
		workspaceRoot?: string,
		account?: Account,
		options?: { readonly refresh?: boolean },
		call?: ProviderCall,
	): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure>;
	readonly generateTextEffect: ProviderInstance["generateTextEffect"];
	prepareTurnEffect(
		input: SessionTurn,
	): Effect.Effect<PreparedTurnFields, ProviderInstanceFailure>;
	readonly preparePreWarmEffect?: (
		input: PreWarmSessionInput,
		scope: Scope.Scope,
	) => Effect.Effect<
		Extract<SessionCommand, { type: "pre-warm" }> | undefined,
		ProviderInstanceFailure
	>;
	readonly stopTask?: boolean;
	/** The provider takes native commands (8.5) as session sends. */
	readonly nativeCommands?: boolean;
	readonly nativeSession?: boolean;
}

export interface RunnerRecoveryDependencies {
	readonly wakeReactor?: Effect.Effect<void>;
	readonly projectId: string;
	readonly ingestion: ProviderRuntimeIngestion;
	readonly pending: PendingInteractionService;
	readonly timeoutHooks: Pick<
		ProjectEventSinkDeps,
		"clearTimeout" | "resetTimeout"
	>;
	readonly persist: ClaudeEventPersistEffect;
	readonly inputDrafts?: InputDrafts;
	readonly resolveCallContext: OrchestrationEngine["resolveCallContextEffect"];
	readonly retirePrompts: (
		currentProcessId: string | null,
		options?: {
			readonly expiredProcessId?: string;
			readonly exceptCommandId?: string;
		},
	) => ReturnType<Effect.Success<typeof makeRetireReplacedProcessPrompts>>;
}

export interface RunnerProviderInstanceDeps {
	readonly processIdentity?: import("./process-table.js").ProcessTable;
	readonly accountResources?: {
		readonly use: <A, E, R>(
			account: Account,
			work: (account: Account) => Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | ProviderInstanceFailure, R>;
	};
	readonly accounts: Effect.Effect<AccountsState>;
	readonly autoSettleAfterDays?: Effect.Effect<number | null | undefined>;
	readonly daemonConfigDir?: string;
	readonly projectRootForSession?: (
		sessionId: string,
		projectId?: string,
	) => Effect.Effect<string | undefined>;
	readonly recoveryForSession?: (
		sessionId: string,
	) => Effect.Effect<RunnerRecoveryDependencies | undefined>;
	readonly ensureChildSession?: ClaudeEventPersistEffect["ensureClaudeSubagentSession"];
	readonly readSubagentTranscript?: ClaudeEventPersistEffect["readClaudeSubagentTranscript"];
	readonly persistUserMessage?: ClaudeEventPersistEffect["persistUserMessage"];
}

export const makeRunnerProviderInstance = (
	deps: RunnerProviderInstanceDeps,
	driver: RunnerDriverPieces,
	makeRunner: (
		emit: (
			output: SessionOutput,
			sessionId?: string,
			send?: SendScope,
		) => Effect.Effect<SessionOutputReply, SessionFailure>,
	) => Effect.Effect<SessionRunner, never, Scope.Scope>,
): Effect.Effect<RunnerProviderInstance, never, Scope.Scope> =>
	Effect.gen(function* () {
		const processIdentity =
			deps.processIdentity ??
			makeProductionProcessTable((message) => log.warn(message));
		const providerScope = yield* Effect.scope;
		const usage = Option.getOrUndefined(yield* Effect.serviceOption(Usage));
		const abortFibers = yield* FiberMap.make<string, void, never>();
		const interactionFibers = yield* FiberMap.make<string, void, never>();
		const preWarmFibers = yield* FiberMap.make<
			string,
			void,
			ProviderInstanceFailure
		>();
		const accountResourceFibers = yield* FiberMap.make<string, void, never>();
		let instance: RunnerProviderInstance | undefined;
		const dispose = yield* Effect.cached(
			Effect.suspend(() => (instance ? instance.disposeEffect() : Effect.void)),
		);
		const shutdown = Effect.uninterruptible(dispose);
		// Dynamic send scopes must close after shutdown has detached their waiters.
		const resourceScope = yield* Scope.fork(providerScope, "sequential");
		const runner = yield* makeRunner((output, sessionId, send) =>
			instance
				? instance.handleOutputEffect(output, sessionId, send)
				: Effect.succeed({}),
		).pipe(Scope.provide(resourceScope));
		const sendScopes =
			runner.sendScopes ??
			(yield* makeSendScopes().pipe(Scope.provide(resourceScope)));
		instance = new RunnerProviderInstance(
			{ ...deps, processIdentity },
			driver,
			runner,
			sendScopes,
			abortFibers,
			interactionFibers,
			preWarmFibers,
			accountResourceFibers,
			providerScope,
			resourceScope,
			shutdown,
			usage,
		);
		runner.setSendAdmission?.(instance.admitSendEffect);
		yield* Effect.addFinalizer(() => shutdown.pipe(Effect.ignore));
		return instance;
	});

/** Provider API compatibility and event-store interaction routing only. */
export class RunnerProviderInstance implements ProviderInstance {
	readonly providerId: KnownProviderDriverKind;
	private readonly sends = new Map<
		string,
		{ send?: SendScope; readonly closed: Effect.Effect<void> }
	>();
	private readonly sendAdmissions = new WeakMap<
		SendScope,
		{ transferred: boolean; refused: boolean }
	>();
	private readonly sinks = new Map<
		string,
		{ readonly sink: EventSink; readonly send: SendScope }
	>();
	private readonly sinkSessions = new Map<string, string>();
	/** Native commands made while no process was live: the next launch's first sends (8.5). */
	private readonly firstSends = new Map<
		string,
		{ readonly commandId: string; readonly text: string }[]
	>();
	private detachingInteractions = false;
	private recoveryForSession: RunnerProviderInstanceDeps["recoveryForSession"];
	private recoveredSink:
		| ((
				sessionId: string,
				sinkId: string,
		  ) => Effect.Effect<EventSink | undefined>)
		| undefined;
	private readonly recoveredSinkIds = new Set<string>();
	private readonly recoveredRequests = new Map<
		string,
		Deferred.Deferred<void>
	>();

	private recoverWithContexts = (
		recoveryForSession: NonNullable<
			RunnerProviderInstanceDeps["recoveryForSession"]
		>,
		sessionIds?: ReadonlySet<string>,
		ownsPendingSend?: OrchestrationEngine["ownsPendingSend"],
	) =>
		Effect.gen({ self: this }, function* () {
			this.recoveryForSession = recoveryForSession;
			const sql = yield* SqlClient.SqlClient;
			// Validate persisted launch folders before recovery can settle or requeue them.
			if (this.providerId === "claude") {
				const accounts = yield* this.deps.accounts;
				const driverForAccount = (id: string) =>
					accounts.accounts.find((account) => account.id === id)?.driver ??
					accounts.deleted.find((account) => account.id === id)?.driver ??
					(id === this.providerId ? this.providerId : undefined);
				if (sessionIds)
					for (const sessionId of sessionIds)
						yield* runningRunnerCommands(
							sql,
							this.providerId,
							driverForAccount,
							sessionId,
						);
				else
					yield* runningRunnerCommands(sql, this.providerId, driverForAccount);
			}
			// An in-process runner's turns ended with the generation that ran them, so
			// every running command is unclaimed. Runner processes may outlive it.
			const claimed = new Set<string>();
			if (this.runner.recoverEffect) {
				this.recoveredSink = (sessionId, sinkId) =>
					Effect.gen({ self: this }, function* () {
						const recovery = yield* recoveryForSession(sessionId);
						if (!recovery) return undefined;
						return makeRecoveredEventSink({
							driverKind: this.providerId,
							sessionId,
							sql,
							ingestion: recovery.ingestion,
							pending: recovery.pending,
							timeoutHooks: recovery.timeoutHooks,
							onRegistered: (id) => {
								const ready = this.recoveredRequests.get(
									JSON.stringify([sinkId, id]),
								);
								return ready ? Deferred.succeed(ready, undefined) : Effect.void;
							},
						});
					});
				yield* (
					sessionIds
						? (this.runner.attachSessionsEffect?.([...sessionIds]) ??
							Effect.void)
						: this.runner.recoverEffect
				).pipe(Effect.provideService(currentPendingSendOwner, ownsPendingSend));
				const registrations = yield* Effect.try(() =>
					discoverAllRunners(
						this.deps.daemonConfigDir,
						this.deps.processIdentity,
					),
				).pipe(
					Effect.catch((error) =>
						Effect.logError("Could not verify runner ownership", error).pipe(
							Effect.as(undefined),
						),
					),
				);
				// Discovery errors are not proof that a running command has no owner.
				if (!registrations) return;
				for (const runner of registrations) {
					if (
						runner.driverKind === this.providerId &&
						(yield* this.runner.hasLiveProcessEffect(
							runner.sessionId,
							runner.runnerId,
						))
					)
						claimed.add(runner.sessionId);
				}
			}
			const accounts = yield* this.deps.accounts;
			// A nested subagent has no runner registration of its own. Protect
			// its descendants while their root runner is alive, using tool ownership.
			const protectedSessions = new Set(claimed);
			if (this.providerId === "claude" && claimed.size) {
				const live = yield* sql<{ id: string }>`
					WITH RECURSIVE owned(id) AS (
						SELECT id FROM sessions WHERE id IN ${sql.in([...claimed])}
						UNION
						SELECT json_extract(part.metadata, '$.childSessionId')
						FROM owned CROSS JOIN messages message ON message.session_id = owned.id
						CROSS JOIN message_parts part ON part.message_id = message.id
						WHERE message.is_inherited = 0 AND part.type = 'tool'
							AND json_extract(part.metadata, '$.childSessionId') IS NOT NULL
					) SELECT id FROM owned`;
				for (const session of live) protectedSessions.add(session.id);
			}
			// Startup visits every session; walk tool links only when some open
			// run lies outside the live runners' trees.
			const orphanable =
				this.providerId === "claude" &&
				(yield* sql<{ session_id: string }>`
						SELECT DISTINCT session_id FROM provider_runs WHERE status IN ('pending', 'running')`).some(
					({ session_id }) => !protectedSessions.has(session_id),
				);
			const sessions = yield* sql<{
				id: string;
				provider: string;
			}>`SELECT s.id, s.provider FROM sessions s
				JOIN (
					SELECT session_id FROM pending_approvals
					WHERE status = 'pending'
						AND COALESCE(json_extract(details, '$.delivery'), '') <> 'async'
					UNION
					SELECT session_id FROM provider_command_outbox
					WHERE effect_type <> 'send_turn'
						AND status IN ('pending', 'running', 'retryable_failed')
				) cleanup ON cleanup.session_id = s.id`;
			for (const session of sessions) {
				if (sessionIds && !sessionIds.has(session.id)) continue;
				const driver =
					accounts.accounts.find((account) => account.id === session.provider)
						?.driver ??
					accounts.deleted.find((account) => account.id === session.provider)
						?.driver;
				if (
					!claimed.has(session.id) &&
					(driver ?? session.provider) === this.providerId
				) {
					const recovery = yield* recoveryForSession(session.id);
					if (recovery) {
						yield* recovery.retirePrompts(null);
						if (orphanable && !protectedSessions.has(session.id))
							yield* settleToolChildRuns(
								sql,
								session.id,
								"Claude runner stopped before completing the child turn",
								(events) =>
									recovery.ingestion.ingestBatch(events, {
										publishToBus: false,
										publishToBrowser: false,
									}),
							);
					}
				}
			}
			for (const sessionId of claimed) {
				if (sessionIds && !sessionIds.has(sessionId)) continue;
				const native = yield* this.runner.getNativeSessionEffect?.(sessionId) ??
					Effect.succeed(undefined);
				const account = accounts.accounts.find(
					(account) => account.id === native?.instanceId,
				);
				if (
					account &&
					(yield* this.runner.hasDemandEffect?.(sessionId) ??
						Effect.succeed(false))
				)
					yield* this.withAccountResources(
						account,
						sessionId,
						() => Effect.void,
					);
			}
			yield* settleUnclaimedRunnerCommands(
				sql,
				claimed,
				this.providerId,
				(id) =>
					accounts.accounts.find((account) => account.id === id)?.driver ??
					accounts.deleted.find((account) => account.id === id)?.driver,
				(sinkId, turn, failure, beforeProject) =>
					Effect.gen({ self: this }, function* () {
						const recovery = yield* recoveryForSession(turn.sessionId);
						if (!recovery) return;
						const requestIds = new Set([
							...(yield* recovery.pending.listPendingPermissions(
								turn.sessionId,
							)).map((request) => request.requestId),
							...(yield* recovery.pending.listPendingQuestions(
								turn.sessionId,
							)).map((request) => request.requestId),
						]);
						let persistenceError: ProviderRuntimeIngestionError | undefined;
						yield* failRunnerTurn(
							(output) =>
								Effect.gen(function* () {
									if (output.type === "event") {
										// Startup has no WebSocket publisher or live sink yet.
										yield* recovery.ingestion.ingestBatch([output.event], {
											publishToBus: false,
											publishToBrowser: false,
											...(output.event.type === "turn.error"
												? {
														beforeProject,
														beforeCommit:
															recovery.pending.cancelSessionInteractions(
																turn.sessionId,
																failure.message,
																{ recoverQuestions: false, requestIds },
															),
													}
												: {}),
										});
									}
									return {};
								}).pipe(
									Effect.tapError((error) =>
										Effect.sync(() => {
											persistenceError = error;
										}),
									),
									Effect.mapError((error) =>
										sessionFailure("recover stopped runner", error),
									),
								),
							sinkId,
							turn,
							accounts.accounts.some((account) => account.id === turn.accountId)
								? failure
								: {
										operation: "recover stopped runner",
										message: `${this.providerId} account "${turn.accountId}" is unavailable`,
										code: "account_unavailable",
										retryable: false,
									},
							this.providerId,
						);
						// failRunnerTurn logs errors; database failures still need a retry.
						if (persistenceError) return yield* Effect.fail(persistenceError);
					}),
				recoveryForSession,
				sessionIds,
				ownsPendingSend,
				(sessionId, runId) =>
					this.runner.ownsRetirementCleanupEffect?.(sessionId, runId) ??
					Effect.succeed(false),
			);
			// Gap, CONTRACT.md 8.5 (2919-2924) names no delivery without a live process, and the kept
			// first sends are in memory. Nearest reading: a restart reloads each command the ledger
			// still has Sent or Unconfirmed in a session with no live process, for its next launch.
			const issued = yield* sql<{
				readonly session_id: string;
				readonly command_id: string;
				readonly text: string;
				readonly provider: string;
			}>`SELECT event.session_id, json_extract(event.metadata, '$.commandId') AS command_id,
					json_extract(event.data, '$.text') AS text, sessions.provider
				FROM events event JOIN sessions ON sessions.id = event.session_id
				WHERE event.type = 'native_command.requested' ORDER BY event.sequence`;
			const views = new Map<string, readonly NativeCommandView[] | undefined>();
			for (const { session_id, command_id, text, provider } of issued) {
				const driver =
					accounts.accounts.find((account) => account.id === provider)
						?.driver ??
					accounts.deleted.find((account) => account.id === provider)?.driver;
				if (
					(sessionIds && !sessionIds.has(session_id)) ||
					claimed.has(session_id) ||
					(driver ?? provider) !== this.providerId ||
					this.firstSends
						.get(session_id)
						?.some(({ commandId }) => commandId === command_id) ||
					// A failed session launches nothing to send them first.
					(yield* this.getControlProcessIdEffect(session_id).pipe(
						Effect.map((id) => id !== undefined),
						Effect.catch(() => Effect.succeed(true)),
					))
				)
					continue;
				if (!views.has(session_id))
					views.set(
						session_id,
						(yield* loadLedgerView(session_id))?.nativeCommands,
					);
				const tag = views
					.get(session_id)
					?.find(({ commandId }) => commandId === command_id)?.tag;
				if (tag === "Sent" || tag === "Unconfirmed")
					this.firstSends.set(session_id, [
						...(this.firstSends.get(session_id) ?? []),
						{ commandId: command_id, text },
					]);
			}
		});

	constructor(
		private readonly deps: RunnerProviderInstanceDeps,
		private readonly driver: RunnerDriverPieces,
		private readonly runner: SessionRunner,
		private readonly sendScopes: SendScopes,
		private readonly abortFibers: FiberMap.FiberMap<string, void, never>,
		private readonly interactionFibers: FiberMap.FiberMap<string, void, never>,
		private readonly preWarmFibers: FiberMap.FiberMap<
			string,
			void,
			ProviderInstanceFailure
		>,
		private readonly accountResourceFibers: FiberMap.FiberMap<
			string,
			void,
			never
		>,
		private readonly providerScope: Scope.Scope,
		private readonly resourceScope: Scope.Scope,
		private readonly shutdown: Effect.Effect<void, ProviderInstanceFailure>,
		private readonly usage?: UsageService,
	) {
		this.providerId = driver.driverKind;
	}

	recoverProjectContextsEffect(
		recoveryForSession: NonNullable<
			RunnerProviderInstanceDeps["recoveryForSession"]
		>,
	) {
		return this.recoverWithContexts(recoveryForSession);
	}

	attachSessionsEffect(
		sessionIds: readonly string[],
		recoveryForSession: NonNullable<
			RunnerProviderInstanceDeps["recoveryForSession"]
		>,
		ownsPendingSend?: OrchestrationEngine["ownsPendingSend"],
	) {
		return this.recoverWithContexts(
			recoveryForSession,
			new Set(sessionIds),
			ownsPendingSend,
		);
	}

	private commandEffect(
		command: Extract<SessionCommand, { type: "send-turn" }>,
		send: SendScope,
	): Effect.Effect<TurnResult, ProviderInstanceFailure>;
	private commandEffect(
		command: Exclude<SessionCommand, { type: "send-turn" }>,
		send?: SendScope,
	): Effect.Effect<void, ProviderInstanceFailure>;
	private commandEffect(
		command: SessionCommand,
		send?: SendScope,
	): Effect.Effect<TurnResult | undefined, ProviderInstanceFailure> {
		const executing: Effect.Effect<TurnResult | undefined, SessionFailure> =
			command.type === "send-turn"
				? send
					? this.runner.executeEffect(command, send)
					: Effect.die("Send command requires its admitted handle")
				: this.runner.executeEffect(command, send).pipe(Effect.as(undefined));
		return executing.pipe(
			Effect.mapError(
				(failure) =>
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: failure.operation,
						cause: Object.assign(new Error(failure.message), failure),
						...(failure.code === "provider_process_gone" ||
						(command.type === "send-turn" && failure.code === "runner_detached")
							? { code: failure.code }
							: {}),
					}),
			),
		);
	}

	private abortSendEffect(
		send: SendScope,
		startImmediately = false,
		retireAccountId?: string,
	): Effect.Effect<void> {
		return this.sendScopes
			.fork(
				send,
				"abort operation",
				Effect.gen({ self: this }, function* () {
					const assignment = send.assignment;
					if (assignment._tag === "Closed") return;
					yield* this.runner
						.executeEffect({ type: "abort", sinkId: send.sinkId }, send)
						.pipe(Effect.ignore);
					if (!retireAccountId || assignment._tag !== "Dispatched") return;
					const native = yield* this.runner.getNativeSessionEffect?.(
						send.sessionId,
					) ?? Effect.succeed(undefined);
					const current = send.assignment;
					if (
						current._tag !== "Dispatched" ||
						current.runnerId !== assignment.runnerId ||
						native?.instanceId !== retireAccountId
					)
						return;
					// Intake can already have replied while this account's SDK query runs.
					yield* this.runner
						.executeEffect({
							type: "end-session",
							sessionId: send.sessionId,
							control: {
								commandId: randomUUID(),
								providerProcessId: assignment.runnerId,
							},
						})
						.pipe(Effect.ignore);
				}),
				startImmediately,
			)
			.pipe(Effect.asVoid);
	}

	discoverEffect(
		workspaceRoot?: string,
		account?: Account,
		options?: { readonly refresh?: boolean },
		call?: ProviderCall,
	): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> {
		return this.driver.discoverEffect(workspaceRoot, account, options, call);
	}

	generateTextEffect(
		input: Parameters<ProviderInstance["generateTextEffect"]>[0],
	): Effect.Effect<string, ProviderInstanceFailure> {
		return this.driver.generateTextEffect(input);
	}

	hasLiveProcessEffect(
		sessionId: string,
		processId?: string,
	): Effect.Effect<boolean> {
		return this.runner.hasLiveProcessEffect(sessionId, processId);
	}

	getControlProcessIdEffect(
		sessionId: string,
	): Effect.Effect<string | undefined, ProviderInstanceFailure> {
		return Effect.gen({ self: this }, function* () {
			const failure = yield* this.getSessionFailureEffect(sessionId);
			if (failure)
				return yield* new ProviderInstanceFailure({
					providerId: this.providerId,
					operation: "getControlProcessId",
					code: "provider_process_unavailable",
					cause: new Error(failure.message),
				});
			return yield* this.runner.getControlProcessIdEffect?.(sessionId) ??
				Effect.succeed(undefined);
		});
	}

	getSessionFailureEffect(sessionId: string) {
		return (
			this.runner.getSessionFailureEffect?.(sessionId) ??
			Effect.succeed(undefined)
		);
	}

	hasActiveTurnsEffect(sessionId: string) {
		return (
			this.runner.hasActiveTurnsEffect?.(sessionId) ?? Effect.succeed(false)
		);
	}

	get turnEnds() {
		return this.runner.turnEnds;
	}

	getAccountSwitchBlockEffect(sessionId: string, account: Account) {
		return (
			this.runner.getAccountSwitchBlockEffect?.(sessionId, account) ??
			Effect.succeed(undefined)
		);
	}

	getControlCommandStatusEffect(
		sessionId: string,
		control: ProviderControlContext,
	): Effect.Effect<ProviderControlCommandStatus, ProviderInstanceFailure> {
		return (
			this.runner.getControlCommandStatusEffect?.(sessionId, control) ??
			Effect.fail(
				sessionFailure(
					"get control command status",
					"Runner cannot reconcile commands",
				),
			)
		).pipe(
			Effect.mapError(
				(failure) =>
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: failure.operation,
						cause: Object.assign(new Error(failure.message), failure),
					}),
			),
		);
	}

	getNativeSessionEffect(
		sessionId: string,
	): Effect.Effect<ProviderNativeSession | undefined> {
		return (
			(this.driver.nativeSession
				? this.runner.getNativeSessionEffect?.(sessionId)
				: undefined) ?? Effect.succeed(undefined)
		);
	}

	sendTurnEffect(
		input: ResolvedSendTurnInput,
		prepareCall?: Effect.Effect<
			ProviderCall | undefined,
			ProviderInstanceFailure
		>,
	): Effect.Effect<TurnResult, ProviderInstanceFailure> {
		const sinkId = runnerSinkId(
			input.inputId,
			input.commandAttempt,
			input.nativeResumeFallback,
		);
		return this.admitSendEffect(
			{ origin: { _tag: "Fresh" }, sinkId, input },
			(send) =>
				input.account
					? this.withAccountResources(
							input.account,
							input.sessionId,
							(account) =>
								this.sendTurnUnscopedEffect(
									{ ...input, account },
									send,
									prepareCall,
								),
							sinkId,
							send,
						)
					: this.sendTurnUnscopedEffect(input, send, prepareCall),
		).pipe(
			Effect.flatMap((result) =>
				Option.isSome(result)
					? Effect.succeed(result.value)
					: Effect.die("Fresh admission cannot already be ended"),
			),
			Effect.mapError((cause) =>
				cause instanceof ProviderInstanceFailure
					? cause
					: new ProviderInstanceFailure({
							providerId: this.providerId,
							operation: cause.operation,
							...(cause.code === "not_sent" ? { code: "not_sent" } : {}),
							cause,
						}),
			),
		);
	}

	/** The only admission and the only creator of a send handle. */
	readonly admitSendEffect: AdmitSend = (request, work) => {
		const { sinkId, input } = request;
		const admissionKey = JSON.stringify([input.sessionId, sinkId]);
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen({ self: this }, function* () {
				let send = request.retained;
				if (send) {
					if (
						request.previous ||
						send.sinkId !== sinkId ||
						send.sessionId !== input.sessionId ||
						!this.sendAdmissions.has(send)
					)
						return yield* Effect.fail(
							sessionFailure(
								"continue send",
								"Retained handle does not belong to this admission",
							),
						);
					if (
						request.origin._tag !== "Fresh" &&
						send.assignment._tag === "Closed"
					) {
						yield* send.close;
						return Option.none();
					}
					if (this.sends.get(admissionKey)?.send !== send)
						return yield* Effect.fail(
							sessionFailure(
								"continue send",
								"Retained handle does not belong to this admission",
							),
						);
				} else {
					const previousAdmission = request.previous
						? this.sendAdmissions.get(request.previous)
						: undefined;
					if (request.previous) {
						if (
							!previousAdmission ||
							request.previous.sessionId !== input.sessionId ||
							request.previous.sinkId === sinkId
						)
							return yield* Effect.fail(
								sessionFailure(
									"replace send",
									"Previous handle does not belong to this send replacement",
								),
							);
						yield* request.previous.close;
					}
					const completed = yield* Deferred.make<void>();
					const reservation: {
						send?: SendScope;
						readonly closed: Effect.Effect<void>;
					} = { closed: Deferred.await(completed) };
					let previous = this.sends.get(admissionKey)?.closed;
					while (previous) {
						yield* restore(previous);
						previous = this.sends.get(admissionKey)?.closed;
					}
					// The final free-key check and claim have no yield between them.
					this.sends.set(admissionKey, reservation);
					const release = Effect.sync(() => {
						if (this.sends.get(admissionKey) === reservation)
							this.sends.delete(admissionKey);
					}).pipe(Effect.andThen(Deferred.succeed(completed, undefined)));
					let opened: SendScope | undefined;
					const admitted = yield* Effect.gen({ self: this }, function* () {
						if (
							request.origin._tag !== "Fresh" &&
							(yield* restore(request.isEnded ?? Effect.succeed(false)))
						) {
							yield* release;
							return Option.none();
						}
						const handle = yield* this.sendScopes.open(sinkId, input.sessionId);
						opened = handle;
						yield* this.sendScopes.acquire(
							handle,
							sinkId,
							"provider admission",
							Effect.sync(() => {
								reservation.send = handle;
								return reservation;
							}),
							(admission) =>
								Effect.sync(() => {
									delete admission.send;
								}),
						);
						// A resource finalizer runs before the send's closed signal. Keep
						// the claim until every finalizer, including close notification, ends.
						yield* handle.closed.pipe(
							Effect.ensuring(handle.close),
							Effect.ensuring(release),
							Effect.interruptible,
							Effect.forkIn(this.resourceScope),
						);
						this.sendAdmissions.set(handle, {
							transferred: false,
							refused: false,
						});
						if (previousAdmission) previousAdmission.transferred = true;
						return Option.some(handle);
					}).pipe(
						Effect.onError(() =>
							(opened?.close ?? Effect.void).pipe(Effect.ensuring(release)),
						),
					);
					if (Option.isNone(admitted)) return Option.none();
					send = admitted.value;
				}
				const handle = send;
				const ownership = this.sendAdmissions.get(handle);
				if (!ownership)
					return yield* Effect.die("Missing provider send admission");
				return yield* restore(
					Effect.gen(function* () {
						if (request.origin._tag !== "Fresh") {
							const ended = yield* request.isEnded ?? Effect.succeed(false);
							if (ended || handle.assignment._tag === "Closed") {
								yield* handle.close;
								return Option.none();
							}
						}
						return Option.some(yield* work(handle));
					}),
				).pipe(
					Effect.catchCause((cause) =>
						request.origin._tag !== "Fresh" &&
						handle.assignment._tag === "Closed" &&
						Failure.isInterruptedOnly(cause)
							? Effect.succeed(Option.none())
							: Effect.failCause(cause),
					),
					Effect.tap((admitted) =>
						handle.assignment._tag === "Queued" ||
						(Option.isSome(admitted) &&
							typeof admitted.value === "object" &&
							admitted.value !== null &&
							"status" in admitted.value &&
							admitted.value.status === "cancelled")
							? handle.close
							: Effect.void,
					),
					Effect.onError((cause) => {
						// Detaching the intake waiter leaves an already queued native send live.
						if (
							Failure.isInterruptedOnly(cause) &&
							this.runner.retainsSend?.(handle)
						)
							return Effect.void;
						const failure = sessionFailure(
							"recover turn",
							Failure.squashCause(cause),
						);
						const showFailure =
							!ownership.transferred &&
							!ownership.refused &&
							!Failure.isInterruptedOnly(cause);
						if (showFailure) ownership.refused = true;
						const notify =
							request.refuse?.(
								failure,
								handle,
								showFailure && failure.code !== "send_admission_timeout",
							) ?? Effect.void;
						const report =
							request.origin._tag === "Adopted" && showFailure
								? notify
								: Effect.void;
						return Effect.all(
							[
								report.pipe(
									Effect.catchCause((error) =>
										Effect.logError("Could not settle send refusal", error),
									),
								),
								handle.close,
							],
							{ concurrency: 2, discard: true },
						);
					}),
				);
			}),
		);
	};

	private withAccountResources<A>(
		admitted: Account,
		sessionId: string,
		operation: (account: Account) => Effect.Effect<A, ProviderInstanceFailure>,
		sinkId?: string,
		ownedScope?: SendScope,
	): Effect.Effect<A, ProviderInstanceFailure> {
		const resources = this.deps.accountResources;
		if (!resources) return operation(admitted);
		if (ownedScope && sinkId)
			return Effect.uninterruptibleMask((restore) =>
				Effect.gen({ self: this }, function* () {
					const ready = yield* Deferred.make<
						Account,
						ProviderInstanceFailure
					>();
					const finished = yield* Deferred.make<void>();
					const invalidated = yield* Deferred.make<
						never,
						ProviderInstanceFailure
					>();
					const holder = resources
						.use(admitted, (account) =>
							Deferred.succeed(ready, account).pipe(
								Effect.andThen(Deferred.await(finished)),
							),
						)
						.pipe(
							Effect.onInterrupt(() =>
								this.detachingInteractions
									? Effect.void
									: this.abortSendEffect(ownedScope, true, admitted.id),
							),
							Effect.onExit((exit) =>
								Exit.isFailure(exit)
									? Deferred.failCause(ready, exit.cause).pipe(
											Effect.andThen(
												Deferred.failCause(invalidated, exit.cause),
											),
										)
									: Effect.void,
							),
							Effect.catchCause(() => Effect.void),
						);
					yield* this.sendScopes.acquire(
						ownedScope,
						sinkId,
						"provider account demand",
						FiberMap.run(
							this.accountResourceFibers,
							randomUUID(),
							Effect.interruptible(holder),
						),
						(fiber) =>
							Deferred.succeed(finished, undefined).pipe(
								Effect.andThen(Fiber.join(fiber)),
							),
					);
					const account = yield* restore(Deferred.await(ready));
					return yield* restore(
						Effect.raceFirst(operation(account), Deferred.await(invalidated)),
					).pipe(
						Effect.onInterrupt(() =>
							this.detachingInteractions
								? Effect.void
								: this.abortSendEffect(ownedScope, true),
						),
					);
				}),
			);
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen({ self: this }, function* () {
				const reply = yield* Deferred.make<A, ProviderInstanceFailure>();
				let callerCancelled = false;
				const work = resources
					.use(admitted, (account) =>
						Effect.gen({ self: this }, function* () {
							const result = yield* operation(account);
							yield* Deferred.succeed(reply, result);
							// Intake can precede the end of the native turn by hours. The runner's
							// quiescence also counts questions, approvals and background finalizers.
							while (
								yield* this.runner.hasDemandEffect?.(sessionId) ??
									Effect.succeed(false)
							) {
								const native = yield* this.runner.getNativeSessionEffect?.(
									sessionId,
								) ?? Effect.succeed(undefined);
								if (native && native.instanceId !== admitted.id) break;
								yield* Effect.sleep("25 millis");
							}
						}),
					)
					.pipe(
						Effect.onInterrupt(() =>
							Effect.gen({ self: this }, function* () {
								if (this.detachingInteractions) return;
								if (sinkId)
									yield* this.runner
										.executeEffect({ type: "abort", sinkId })
										.pipe(Effect.ignore);
								const native = yield* this.runner.getNativeSessionEffect?.(
									sessionId,
								) ?? Effect.succeed(undefined);
								if (
									!callerCancelled &&
									(native?.instanceId === admitted.id || (!native && !sinkId))
								)
									yield* this.runner
										.executeEffect({ type: "end-session", sessionId })
										.pipe(Effect.ignore);
							}),
						),
						Effect.onExit((exit) =>
							Exit.isFailure(exit)
								? Deferred.failCause(reply, exit.cause)
								: Effect.void,
						),
						Effect.catchCause(() => Effect.void),
					);
				const fiber = yield* FiberMap.run(
					this.accountResourceFibers,
					randomUUID(),
					Effect.interruptible(work),
				);
				return yield* restore(Deferred.await(reply)).pipe(
					Effect.onInterrupt(() =>
						Effect.sync(() => {
							callerCancelled = true;
						}).pipe(Effect.andThen(Fiber.interrupt(fiber))),
					),
				);
			}),
		);
	}

	private sendTurnUnscopedEffect(
		input: ResolvedSendTurnInput,
		scope: SendScope,
		prepareCall?: Effect.Effect<
			ProviderCall | undefined,
			ProviderInstanceFailure
		>,
	): Effect.Effect<TurnResult, ProviderInstanceFailure> {
		const {
			eventSink,
			abortSignal,
			awaitIntake: _awaitIntake,
			...payload
		} = input;
		const { sessionId } = input;
		const sinkId = runnerSinkId(
			input.inputId,
			input.commandAttempt,
			input.nativeResumeFallback,
		);
		const send = Effect.gen({ self: this }, function* () {
			const call =
				payload.shellEnv === undefined
					? yield* prepareCall ?? Effect.succeed(undefined)
					: undefined;
			const prepared = yield* launchRunnerTurn(this.driver, {
				...payload,
				...(call
					? { shellEnv: call.shellEnv, shellConfig: call.shellConfig }
					: {}),
			});
			if (scope.assignment._tag === "Closed") return yield* Effect.interrupt;
			yield* this.bindSinkEffect(
				scope,
				sinkId,
				sessionId,
				eventSink,
				input.inputId,
			);
			const aborted = yield* Deferred.make<void>();
			const abortKey = randomUUID();
			yield* this.sendScopes.acquire(
				scope,
				sinkId,
				"abort listener",
				Effect.sync(() => {
					const onAbort = () => {
						this.runner.abortSend?.(scope);
						Deferred.doneUnsafe(aborted, Effect.void);
					};
					if (abortSignal.aborted) onAbort();
					else abortSignal.addEventListener("abort", onAbort, { once: true });
					return onAbort;
				}),
				(onAbort) =>
					Effect.sync(() => abortSignal.removeEventListener("abort", onAbort)),
			);
			yield* this.sendScopes.acquire(
				scope,
				sinkId,
				"abort fiber",
				FiberMap.run(
					this.abortFibers,
					abortKey,
					Deferred.await(aborted).pipe(
						Effect.andThen(this.abortSendEffect(scope)),
						// Only the send finalizer removes this watcher. Running abort on a
						// separate fiber prevents scope close from interrupting itself.
						Effect.andThen(Effect.never),
					),
				),
				() => FiberMap.remove(this.abortFibers, abortKey),
			);
			const nativeFirst = this.firstSends.get(sessionId);
			this.firstSends.delete(sessionId);
			return yield* this.commandEffect(
				{
					type: "send-turn",
					sinkId,
					aborted: abortSignal.aborted,
					...prepared,
					...(nativeFirst ? { input: { ...prepared.input, nativeFirst } } : {}),
				},
				scope,
			);
		});
		return (
			this.runner.withTurnEffect?.(payload, sinkId, send, scope) ?? send
		).pipe(
			Effect.catchIf(
				(failure) => failure.code === "cancelled",
				() =>
					Effect.succeed({
						status: "cancelled" as const,
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					}),
			),
			Effect.mapError((cause) =>
				cause instanceof ProviderInstanceFailure
					? cause
					: new ProviderInstanceFailure({
							providerId: this.providerId,
							operation: cause.operation,
							cause,
						}),
			),
		);
	}

	private bindSinkEffect(
		scope: SendScope,
		sinkId: string,
		sessionId: string,
		sink: EventSink,
		inputId?: string,
	) {
		return this.sendScopes.acquire(
			scope,
			sinkId,
			"provider sink",
			Effect.sync(() => {
				this.sinks.set(sinkId, { sink, send: scope });
				this.sinkSessions.set(sinkId, sessionId);
				if (inputId) bindTurnTimelineSink(sinkId, { sessionId, inputId });
				this.reportSinkForTesting("allocated", sinkId, sessionId);
				return sink;
			}),
			() =>
				Effect.gen({ self: this }, function* () {
					if (this.sinks.get(sinkId)?.send !== scope) return;
					this.sinks.delete(sinkId);
					this.sinkSessions.delete(sinkId);
					this.recoveredSinkIds.delete(sinkId);
					this.reportSinkForTesting("released", sinkId, sessionId);
					for (const [key] of Array.from(this.interactionFibers))
						if (key.startsWith(`${sinkId}:`))
							yield* FiberMap.remove(this.interactionFibers, key);
				}),
		);
	}

	/** Places a send's user message once; only a missing session fails it. */
	private placeUserMessageEffect(input: {
		readonly sessionId: string;
		readonly inputId: string;
		readonly text: string;
		readonly runId?: string;
		readonly images?: readonly AttachmentRef[];
	}): Effect.Effect<void, ClaudeEventPersistFailure> {
		return Effect.gen({ self: this }, function* () {
			const persist = yield* Effect.serviceOption(ClaudeEventPersistEffectTag);
			const persistUserMessage =
				this.deps.persistUserMessage ??
				(persist._tag === "Some"
					? persist.value.persistUserMessage
					: undefined);
			if (!persistUserMessage) return;
			yield* persistUserMessage(input.sessionId, input.text, {
				messageId: input.inputId,
				inputId: input.inputId,
				provider: this.providerId,
				...(input.runId ? { runId: input.runId } : {}),
				...(input.images ? { images: input.images } : {}),
			}).pipe(
				Effect.catchIf(
					(error) => error._tag !== "ClaudeSessionLifecycleError",
					(error) =>
						Effect.sync(() =>
							log.warn(
								`Non-fatal persistence error for runner user message: ${formatErrorDetail(error)}`,
							),
						),
				),
			);
		});
	}

	preWarmSessionEffect(
		input: PreWarmSessionInput,
	): Effect.Effect<void, ProviderInstanceFailure> {
		const prepare = this.driver.preparePreWarmEffect;
		if (!prepare) return Effect.void;
		const warm = (input: PreWarmSessionInput) =>
			Effect.gen({ self: this }, function* () {
				const command = yield* prepare(input, this.providerScope);
				if (command) yield* this.commandEffect(command);
			});
		const preWarm = input.account
			? this.withAccountResources(input.account, input.sessionId, (account) =>
					warm({ ...input, account }),
				)
			: warm(input);
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen({ self: this }, function* () {
				const runPreWarm = yield* FiberMap.runtime(this.preWarmFibers)();
				const fiber = yield* Effect.sync(() => {
					const existing = FiberMap.getUnsafe(
						this.preWarmFibers,
						input.sessionId,
					);
					if (Option.isSome(existing)) {
						if (
							process.env["NODE_ENV"] === "test" &&
							process.env["CONDUIT_TEST_UPGRADE_SINK_PROOF"] === "1" &&
							process.connected
						)
							process.send?.({
								channel: "conduit-process-test",
								kind: "pre-warm-joined",
								sessionId: input.sessionId,
							});
						return existing.value;
					}
					return runPreWarm(input.sessionId, Effect.interruptible(preWarm), {
						onlyIfMissing: true,
					});
				});
				const exit = yield* restore(Fiber.await(fiber)).pipe(
					Effect.onInterrupt(() => Fiber.interrupt(fiber)),
				);
				if (Exit.isSuccess(exit)) return;
				return yield* Failure.isInterruptedOnly(exit.cause)
					? Effect.fail(
							new ProviderInstanceFailure({
								providerId: this.providerId,
								operation: "preWarmSession",
								cause: new Error("Session pre-warm was cancelled"),
							}),
						)
					: Effect.failCause(exit.cause);
			}),
		);
	}

	interruptTurnEffect(
		sessionId: string,
		runIds?: readonly string[],
		call?: ProviderCall,
		control?: ProviderControlContext,
	): Effect.Effect<void, ProviderInstanceFailure> {
		// A bound Stop must leave a pre-warm for a replacement turn alone.
		return (
			runIds === undefined
				? FiberMap.remove(this.preWarmFibers, sessionId)
				: Effect.void
		).pipe(
			Effect.andThen(
				this.commandEffect({
					type: "interrupt",
					sessionId,
					...(control ? { control } : {}),
					...(call ? { call } : {}),
					...(runIds !== undefined ? { runIds } : {}),
				}),
			),
		);
	}
	sendNativeCommandEffect(
		sessionId: string,
		commandId: string,
		text: string,
		call?: ProviderCall,
	): Effect.Effect<void, ProviderInstanceFailure> {
		if (!this.driver.nativeCommands)
			return Effect.fail(nativeCommandUnsupported(this.providerId));
		return Effect.gen({ self: this }, function* () {
			// 8.5 (CONTRACT.md 2922) names no delivery without a live process; the nearest reading
			// keeps it for the next launch, which sends it before its prompt.
			if ((yield* this.getControlProcessIdEffect(sessionId)) === undefined) {
				this.firstSends.set(sessionId, [
					...(this.firstSends.get(sessionId) ?? []),
					{ commandId, text },
				]);
				return;
			}
			yield* this.commandEffect({
				type: "native-command",
				sessionId,
				commandId,
				text,
				...(call ? { call } : {}),
			});
		});
	}
	stopTaskEffect(
		sessionId: string,
		taskId: string,
		call?: ProviderCall,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.driver.stopTask
			? this.commandEffect({
					type: "stop-task",
					sessionId,
					taskId,
					...(call ? { call } : {}),
				})
			: Effect.void;
	}
	resolvePermissionEffect(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
		_providerProcessId?: string,
		call?: ProviderCall,
		control?: ProviderControlContext,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "resolve-permission",
			sessionId,
			...(control ? { control } : {}),
			...(call ? { call } : {}),
			requestId,
			decision,
		});
	}
	resolveQuestionEffect(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
		call?: ProviderCall,
		control?: ProviderControlContext,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "resolve-question",
			sessionId,
			...(control ? { control } : {}),
			...(call ? { call } : {}),
			requestId,
			answers,
		});
	}
	applyLiveSettingsEffect(
		sessionId: string,
		settings: {
			readonly modelId?: string | undefined;
			readonly contextWindow?: string | undefined;
			readonly variant?: string | undefined;
		},
		call?: ProviderCall,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "apply-live-settings",
			sessionId,
			...(call ? { call } : {}),
			settings,
		});
	}
	setPermissionModeEffect(
		sessionId: string,
		mode: SessionPermissionMode,
		call?: ProviderCall,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "apply-live-settings",
			sessionId,
			...(call ? { call } : {}),
			settings: { permissionMode: mode },
		});
	}
	endSessionEffect(
		sessionId: string,
		call?: ProviderCall,
		control?: ProviderControlContext,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return FiberMap.remove(this.preWarmFibers, sessionId).pipe(
			Effect.andThen(
				this.commandEffect({
					type: "end-session",
					sessionId,
					...(control ? { control } : {}),
					...(call ? { call } : {}),
				}),
			),
		);
	}
	shutdownEffect(): Effect.Effect<void, ProviderInstanceFailure> {
		return this.shutdown;
	}

	/** Project scopes release their attachments without closing the shared driver. */
	releaseSessionsEffect(sessionIds: readonly string[]): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			const sessions = new Set(sessionIds);
			for (const sessionId of sessions) {
				yield* FiberMap.remove(this.preWarmFibers, sessionId);
				yield* this.runner.detachSessionEffect?.(sessionId) ??
					this.runner
						.executeEffect({ type: "end-session", sessionId })
						.pipe(Effect.ignore);
			}
			for (const [sinkId, sessionId] of this.sinkSessions) {
				if (!sessions.has(sessionId)) continue;
				yield* this.sinks.get(sinkId)?.sink.detachInteractions?.() ??
					Effect.void;
				for (const [key] of Array.from(this.interactionFibers))
					if (key.startsWith(`${sinkId}:`))
						yield* FiberMap.remove(this.interactionFibers, key);
			}
			for (const sessionId of sessions)
				yield* this.sendScopes.closeSession(sessionId);
		});
	}

	/** Shared by explicit shutdown and scope disposal through one cached Effect. */
	disposeEffect(): Effect.Effect<void, ProviderInstanceFailure> {
		return Effect.gen({ self: this }, function* () {
			this.detachingInteractions = true;
			for (const { sink } of this.sinks.values()) {
				yield* sink.detachInteractions?.() ?? Effect.void;
			}
			yield* FiberMap.clear(this.preWarmFibers);
			yield* this.commandEffect({ type: "shutdown" });
		}).pipe(
			Effect.ensuring(
				Effect.gen({ self: this }, function* () {
					yield* this.sendScopes.closeAll;
					yield* FiberMap.clear(this.interactionFibers);
				}),
			),
		);
	}

	private reportSinkForTesting(
		phase: "allocated" | "released",
		sinkId: string,
		sessionId: string | undefined,
	): void {
		if (
			process.env["NODE_ENV"] === "test" &&
			process.env["CONDUIT_TEST_UPGRADE_SINK_PROOF"] === "1" &&
			process.connected
		)
			process.send?.({
				channel: "conduit-process-test",
				kind: "runtime-sink",
				phase,
				sinkId,
				sessionId,
				activeSinks: this.sinks.size,
			});
	}

	handleOutputEffect(
		output: SessionOutput,
		recoveredSessionId?: string,
		send?: SendScope,
	): Effect.Effect<SessionOutputReply, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			if (output.type === "release-sink") {
				// A process runner already validated and closed its captured scope.
				// Its delayed notification must not close a new send with this id.

				return;
			}
			if (
				Option.isNone(
					yield* guardCurrentWrite(() => observeTurnTimelineFrame(output)),
				)
			)
				return;
			if (output.type === "account-usage") {
				yield* this.usage?.update?.(
					output.accountId,
					output.harness,
					output.reading,
				) ?? Effect.void;
				return;
			}
			const currentSink = this.sinks.get(output.sinkId);
			let sink =
				!send || currentSink?.send === send ? currentSink?.sink : undefined;
			if (!sink && recoveredSessionId && this.recoveredSink) {
				sink = yield* this.recoveredSink(recoveredSessionId, output.sinkId);
				if (!sink) return;
				const recovered = sink;
				if (
					Option.isNone(
						yield* guardCurrentWrite(
							Effect.gen({ self: this }, function* () {
								const scope = send;
								// Trailing authorized output uses this transient recovered sink;
								// completed sends never regain resource ownership.
								if (!scope || scope.assignment._tag === "Closed") return;
								yield* this.bindSinkEffect(
									scope,
									output.sinkId,
									recoveredSessionId,
									recovered,
								);
								this.recoveredSinkIds.add(output.sinkId);
							}),
						),
					)
				)
					return;
			}
			if (!sink) return;
			if (this.detachingInteractions)
				yield* guardCurrentWrite(sink.detachInteractions?.() ?? Effect.void);
			switch (output.type) {
				case "event":
					yield* guardCurrentWrite(
						sink
							.push(output.event)
							.pipe(Effect.mapError((cause) => sessionFailure("push", cause))),
					);
					return;
				case "permission-request":
				case "question-request": {
					const requestKey = JSON.stringify([
						output.sinkId,
						output.request.requestId,
					]);
					const registered = this.recoveredSinkIds.has(output.sinkId)
						? yield* Deferred.make<void>()
						: undefined;
					if (
						registered &&
						Option.isNone(
							yield* guardCurrentWrite(() =>
								this.recoveredRequests.set(requestKey, registered),
							),
						)
					)
						return;
					// Registration and UI waiters belong here; only the outbox delivers answers.
					const request = guardCurrentWrite(
						Effect.suspend(() =>
							output.type === "permission-request"
								? sink.requestPermission(output.request).pipe(Effect.asVoid)
								: sink.requestQuestion(output.request).pipe(Effect.asVoid),
						),
					).pipe(Effect.asVoid);
					const running = yield* guardCurrentWrite(
						FiberMap.run(
							this.interactionFibers,
							`${output.sinkId}:${output.request.requestId}`,
							request.pipe(
								Effect.onExit((exit) =>
									Effect.gen({ self: this }, function* () {
										// Failed asks never register a waiter. Release recovery's
										// readiness barrier before reporting their cancellation.
										if (registered)
											yield* Deferred.succeed(registered, undefined);
										if (
											Exit.isFailure(exit) &&
											!Failure.isInterruptedOnly(exit.cause)
										) {
											yield* this.runner
												.executeEffect({
													type: "interaction-failed",
													sinkId: output.sinkId,
													requestId: output.request.requestId,
													kind:
														output.type === "permission-request"
															? "permission"
															: "question",
													failure: sessionFailure(
														"request interaction",
														Failure.squashCause(exit.cause),
													),
												})
												.pipe(Effect.ignore);
										}
									}),
								),
								Effect.catchCause(() => Effect.void),
							),
						),
					);
					if (Option.isNone(running)) return;
					if (registered) {
						yield* Deferred.await(registered);
						yield* guardCurrentWrite(() =>
							this.recoveredRequests.delete(requestKey),
						);
					}
					return;
				}
				case "resolve-permission":
					yield* guardCurrentWrite(
						sink
							.resolvePermission(output.requestId, output.response)
							.pipe(
								Effect.mapError((cause) =>
									sessionFailure("resolvePermission", cause),
								),
							),
					);
					return;
				case "resolve-question":
					yield* guardCurrentWrite(
						sink
							.resolveQuestion(output.requestId, output.answers)
							.pipe(
								Effect.mapError((cause) =>
									sessionFailure("resolveQuestion", cause),
								),
							),
					);
					return;
				case "cancel-interactions":
					yield* guardCurrentWrite(
						Effect.suspend(
							() =>
								sink.cancelSessionInteractions?.(output.reason, {
									recoverQuestions: output.recoverQuestions,
								}) ?? Effect.void,
						).pipe(Effect.catchCause(() => Effect.void)),
					);
					return;
				case "cancel-interaction":
					yield* guardCurrentWrite(
						FiberMap.remove(
							this.interactionFibers,
							`${output.sinkId}:${output.requestId}`,
						),
					);
					if (output.kind && sink.withdrawInteraction)
						yield* guardCurrentWrite(
							sink
								.withdrawInteraction(output.requestId, output.kind)
								.pipe(
									Effect.mapError((cause) =>
										sessionFailure("withdrawInteraction", cause),
									),
								),
						);
					return;
				case "place-user-message":
					yield* guardCurrentWrite(
						this.placeUserMessageEffect(output.input).pipe(
							Effect.mapError((cause) => sessionFailure(output.type, cause)),
						),
					);
					return;
				case "read-subagent-transcript": {
					const project = yield* this.deps.recoveryForSession?.(
						output.childSessionId,
					) ?? Effect.succeed(undefined);
					const persist = yield* Effect.serviceOption(
						ClaudeEventPersistEffectTag,
					);
					const readTranscript =
						this.deps.readSubagentTranscript ??
						project?.persist.readClaudeSubagentTranscript ??
						(persist._tag === "Some"
							? persist.value.readClaudeSubagentTranscript
							: undefined);
					const subagentTranscript = yield* readTranscript?.(
						output.childSessionId,
					).pipe(
						Effect.mapError((cause) => sessionFailure(output.type, cause)),
					) ?? Effect.succeed({ messages: [], parts: [] });
					return { subagentTranscript };
				}
				case "ensure-subagent-session": {
					const project = yield* this.deps.recoveryForSession?.(
						output.input.parentSessionId,
					) ?? Effect.succeed(undefined);
					const persist = yield* Effect.serviceOption(
						ClaudeEventPersistEffectTag,
					);
					const ensureSession =
						this.deps.ensureChildSession ??
						project?.persist.ensureClaudeSubagentSession ??
						(persist._tag === "Some"
							? persist.value.ensureClaudeSubagentSession
							: undefined);
					yield* guardCurrentWrite(
						ensureSession?.({
							...output.input,
							provider: this.providerId,
						}).pipe(
							Effect.mapError((cause) => sessionFailure(output.type, cause)),
						) ?? Effect.void,
					);
					return;
				}
			}
		}).pipe(
			Effect.map((reply) => reply ?? {}),
			Effect.catchDefect((cause) =>
				Effect.fail(sessionFailure(output.type, cause)),
			),
		);
	}
}

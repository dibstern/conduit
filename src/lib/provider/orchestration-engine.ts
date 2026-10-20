import { getProviderDriver } from "../contracts/provider-instance.js";
import type { ClaudeLaunchConfig } from "./claude/claude-sdk-env.js";

// src/lib/provider/orchestration-engine.ts
// Central command processor for the provider instance layer (CQRS core loop).
// Routes commands to the correct provider instance via ProviderRegistry.
// Manages session-to-provider mapping.

import { Data, Deferred, Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import type { Account } from "../contracts/account.js";
import type { SessionScope } from "../contracts/session-scope.js";
import type { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import type { ProviderRuntimeIngestion } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { createLogger } from "../logger.js";
import type { ClaudeEventPersistEffect } from "../persistence/effect/claude-event-persist-effect.js";
import type {
	CommitAndSignal,
	CommitAndSignalFailure,
} from "../persistence/effect/commit-and-signal.js";
import type { EventStoreError } from "../persistence/effect/event-store-effect.js";
import { readPendingRewindCommit } from "../persistence/effect/pending-rewind.js";
import type { CanonicalEvent } from "../persistence/events.js";
import type { ClaudeSessionForkSdk } from "./claude/claude-session-fork.js";
import {
	CommandFingerprintMismatch,
	CommandIdGenerationFailed,
	MissingCommandId,
	type OrchestrationError,
	ProviderInstanceFailure,
	ProviderNotRegistered,
	SessionProviderNotBound,
	StaleCommandRejected,
} from "./errors.js";
import { DurableCommandCommitRepository } from "./orchestration-command-commit.js";
import { DURABLE_COMMAND_FINGERPRINT_VERSION } from "./orchestration-command-contracts.js";
import {
	effectiveDispatchFingerprint,
	fingerprintHash,
} from "./orchestration-command-fingerprint.js";
import { decideDurableSendTurnCommand } from "./orchestration-decider.js";
import {
	CommandReadModelRepository,
	type CommandReadModelSnapshot,
	isCommandScopeTombstoned,
} from "./orchestration-read-model.js";
import {
	type ProviderCommandInteractionSinkFactory,
	type ProviderCommandStoreFailure,
	ProviderSideEffectReactor,
} from "./orchestration-side-effect-reactor.js";
import type { ProviderRegistry } from "./provider-registry.js";
import {
	InMemoryProviderSessionBindingReadModel,
	type ProviderSessionBindingReadModel,
} from "./provider-session-binding-read-model.js";
import type {
	PermissionDecision,
	ProviderCapabilities,
	ProviderInstance,
	SendTurnInput,
	TurnResult,
} from "./types.js";

const log = createLogger("orchestration-engine");

class CommandPayloadSerializationFailed extends Data.TaggedError(
	"CommandPayloadSerializationFailed",
)<{ readonly commandId: string; readonly cause: unknown }> {
	get message(): string {
		return this.cause instanceof Error
			? this.cause.message
			: String(this.cause);
	}
}

export interface SendTurnCommand {
	readonly type: "send_turn";
	readonly commandId: string;
	readonly providerId: string;
	readonly input: SendTurnInput;
	/** Canonical events that commit in the same transaction as the outbox row. */
	readonly events?: readonly CanonicalEvent[];
	/** Runs once the command is accepted, before the provider is called. */
	readonly onAccepted?: Effect.Effect<void>;
}

export interface InterruptTurnCommand {
	readonly type: "interrupt_turn";
	readonly commandId: string;
	readonly sessionId: string;
}

export interface ResolvePermissionCommand {
	readonly type: "resolve_permission";
	readonly commandId: string;
	readonly sessionId: string;
	readonly requestId: string;
	readonly decision: PermissionDecision;
}

export interface ResolveQuestionCommand {
	readonly type: "resolve_question";
	readonly commandId: string;
	readonly sessionId: string;
	readonly requestId: string;
	readonly answers: Record<string, unknown>;
}

export interface DiscoverCommand {
	readonly type: "discover";
	readonly commandId?: string;
	readonly providerId: string;
	readonly account?: Account;
	readonly workspaceRoot?: string;
	readonly refresh?: boolean;
}

export interface EndSessionCommand {
	readonly type: "end_session";
	readonly commandId: string;
	readonly sessionId: string;
	/** Explicit provider-instance route captured before session projections change. */
	readonly targetProviderId?: string;
	readonly account?: Account;
	/** Default false -- keep binding. Set true to also unbind. */
	readonly unbind?: boolean;
}

export type OrchestrationCommand =
	| SendTurnCommand
	| InterruptTurnCommand
	| ResolvePermissionCommand
	| ResolveQuestionCommand
	| DiscoverCommand
	| EndSessionCommand;

// biome-ignore lint/suspicious/noConfusingVoidType: void is needed in the command result union.
export type OrchestrationResult = TurnResult | ProviderCapabilities | void;

export interface SessionBinding {
	readonly sessionId: string;
	readonly providerId: string;
}

/**
 * Durable command store wiring. When supplied, the engine treats durable
 * command receipts as the authoritative dedupe: it checks the receipt before
 * dispatch, rejects reused ids with a changed effective-dispatch fingerprint,
 * and replays accepted commands after restart without a provider call. The
 * in-memory `inFlightCommands` map remains only a same-process waiter.
 *
 * `now`/`generateId` are injected so tests can control time and force id-gen
 * failures; production supplies wall-clock and a random id at the wiring edge.
 * `snapshot` is the narrow command read model (receipts + stale-command
 * tombstones) loaded by `CommandReadModelRepository.bootstrap()` before the
 * engine is constructed.
 */
export interface DurableCommandStoreOptions {
	readonly sql: SqlClient.SqlClient;
	readonly snapshot: CommandReadModelSnapshot;
	/** The stable slug bound when the project's store is constructed. */
	readonly projectKey: string;
	readonly now: () => number;
	readonly generateId: () => string;
	/** Provider output and command outcomes share durable ingestion. */
	readonly ingestion: Pick<ProviderRuntimeIngestion, "ingest" | "ingestBatch">;
	/** Atomically project and announce command commits and execution claims. */
	readonly write: CommitAndSignal["write"];
	readonly persistHandoffDelivered?: ClaudeEventPersistEffect["persistHandoffDelivered"];
	readonly claudeSessionForkSdk?: ClaudeSessionForkSdk;
}

export interface OrchestrationEngineOptions {
	readonly registry: ProviderRegistry;
	readonly defaultClaudeLaunchConfig?: () => ClaudeLaunchConfig;
	readonly sessionBindingReadModel?: ProviderSessionBindingReadModel;
	readonly durableCommands?: DurableCommandStoreOptions;
	readonly accountDirectory?: Pick<
		AccountDirectory["Service"],
		"resolve" | "defaultFor"
	>;
}

interface DurableCommandRuntime {
	readonly projectId: string;
	readonly commit: DurableCommandCommitRepository;
	readonly receipts: CommandReadModelRepository;
	readonly reactor: ProviderSideEffectReactor;
	readonly ingestion: Pick<ProviderRuntimeIngestion, "ingest" | "ingestBatch">;
	readonly sql: SqlClient.SqlClient;
	readonly now: () => number;
	readonly generateId: () => string;
	readonly snapshot: CommandReadModelSnapshot;
	readonly write: CommitAndSignal["write"];
}

/**
 * Result returned when a durable receipt replays an already-accepted send_turn
 * without re-invoking the provider (restart / duplicate). Result payloads are
 * not persisted in receipts, so the ack shape is synthesized.
 */
const REPLAYED_TURN_RESULT: TurnResult = {
	status: "completed",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
};

/** Orphan replay settles as interrupted without executing the provider. */
const ORPHANED_TURN_RESULT: TurnResult = {
	status: "interrupted",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
	error: {
		code: "interrupted",
		message:
			"Provider command was committed but never executed (orphaned by an earlier crash); not re-executing per crash policy.",
	},
};

export class OrchestrationEngine {
	private readonly registry: ProviderRegistry;
	private readonly sessionBindingReadModel: ProviderSessionBindingReadModel;
	private readonly accountDirectory: OrchestrationEngineOptions["accountDirectory"];
	private readonly durable?: DurableCommandRuntime;
	private readonly inFlightCommands = new Map<
		string,
		Deferred.Deferred<OrchestrationResult, OrchestrationError>
	>();

	constructor(options: OrchestrationEngineOptions) {
		this.registry = options.registry;
		this.sessionBindingReadModel =
			options.sessionBindingReadModel ??
			new InMemoryProviderSessionBindingReadModel();
		this.accountDirectory = options.accountDirectory;
		if (options.durableCommands) {
			const durable = options.durableCommands;
			this.durable = {
				projectId: durable.projectKey,
				commit: new DurableCommandCommitRepository(
					durable.sql,
					durable.projectKey,
				),
				receipts: new CommandReadModelRepository(
					durable.sql,
					durable.projectKey,
				),
				reactor: new ProviderSideEffectReactor({
					sql: durable.sql,
					projectId: durable.projectKey,
					registry: this.registry,
					ingestion: durable.ingestion,
					write: durable.write,
					...(durable.persistHandoffDelivered
						? { persistHandoffDelivered: durable.persistHandoffDelivered }
						: {}),
					...(durable.claudeSessionForkSdk
						? { claudeSessionForkSdk: durable.claudeSessionForkSdk }
						: {}),
					nowMs: durable.now,
					...(options.defaultClaudeLaunchConfig
						? { defaultClaudeLaunchConfig: options.defaultClaudeLaunchConfig }
						: {}),
					...(this.accountDirectory
						? { accountDirectory: this.accountDirectory }
						: {}),
				}),
				sql: durable.sql,
				ingestion: durable.ingestion,
				now: durable.now,
				generateId: durable.generateId,
				snapshot: durable.snapshot,
				write: durable.write,
			};
		}
	}

	dispatchEffect(
		command: SendTurnCommand,
	): Effect.Effect<TurnResult, OrchestrationError>;
	dispatchEffect(
		command: DiscoverCommand,
	): Effect.Effect<ProviderCapabilities, OrchestrationError>;
	dispatchEffect(
		command: InterruptTurnCommand,
	): Effect.Effect<void, OrchestrationError>;
	dispatchEffect(
		command: ResolvePermissionCommand,
	): Effect.Effect<void, OrchestrationError>;
	dispatchEffect(
		command: ResolveQuestionCommand,
	): Effect.Effect<void, OrchestrationError>;
	dispatchEffect(
		command: EndSessionCommand,
	): Effect.Effect<void, OrchestrationError>;
	dispatchEffect(
		command: OrchestrationCommand,
	): Effect.Effect<OrchestrationResult, OrchestrationError>;
	dispatchEffect(
		command: OrchestrationCommand,
	): Effect.Effect<OrchestrationResult, OrchestrationError> {
		return Effect.gen({ self: this }, function* () {
			yield* this.ensureMutatingCommandHasId(command);
			if (!command.commandId) {
				return yield* this.runCommandEffect(command);
			}
			const commandId = command.commandId;

			const existing = this.inFlightCommands.get(commandId);
			if (existing) {
				const receipt =
					command.type === "send_turn" && this.durable
						? yield* this.durable.receipts
								.checkReceipt(commandId)
								.pipe(Effect.orDie)
						: undefined;
				if (receipt?.status !== "side_effect_failed")
					return yield* Deferred.await(existing);
				// Resume may arrive before the failed attempt's receipt poll unwinds.
				// Release that attempt's live claim before reserving the next one.
				yield* Effect.result(Deferred.await(existing));
				if (this.inFlightCommands.get(commandId) === existing)
					this.inFlightCommands.delete(commandId);
				return yield* this.dispatchEffect(command);
			}

			const deferred = yield* Deferred.make<
				OrchestrationResult,
				OrchestrationError
			>();
			this.inFlightCommands.set(commandId, deferred);

			const run = this.runCommandEffect(command);
			const owned =
				command.type === "send_turn" && this.durable
					? this.durable.reactor.withLiveCommand(commandId, run)
					: run;
			return yield* owned.pipe(
				Effect.tap((result) => Deferred.succeed(deferred, result)),
				Effect.tapError((error) => Deferred.fail(deferred, error)),
				Effect.ensuring(
					Effect.sync(() => {
						if (this.inFlightCommands.get(commandId) === deferred) {
							this.inFlightCommands.delete(commandId);
						}
					}),
				),
			);
		});
	}

	private ensureMutatingCommandHasId(
		command: OrchestrationCommand,
	): Effect.Effect<void, MissingCommandId> {
		if (command.type !== "discover" && !command.commandId) {
			return Effect.fail(new MissingCommandId({ commandType: command.type }));
		}
		return Effect.void;
	}

	private runCommandEffect(
		command: OrchestrationCommand,
	): Effect.Effect<OrchestrationResult, OrchestrationError> {
		return Effect.gen({ self: this }, function* () {
			switch (command.type) {
				case "send_turn":
					return yield* this.handleSendTurnEffect(command);
				case "interrupt_turn":
					return yield* this.handleInterruptTurnEffect(command);
				case "resolve_permission":
					return yield* this.handleResolvePermissionEffect(command);
				case "resolve_question":
					return yield* this.handleResolveQuestionEffect(command);
				case "discover":
					return yield* this.handleDiscoverEffect(command);
				case "end_session":
					return yield* this.handleEndSessionEffect(command);
				default: {
					const _exhaustive: never = command;
					return _exhaustive;
				}
			}
		});
	}

	private handleSendTurnEffect(
		command: SendTurnCommand,
	): Effect.Effect<TurnResult, OrchestrationError> {
		return this.durable
			? this.handleDurableSendTurnEffect(command, this.durable)
			: this.handleInlineSendTurnEffect(command);
	}

	/**
	 * Durable-receipt send_turn path. Order matters: fingerprint + receipt check
	 * and id generation happen before provider lookup and before any durable
	 * write, so a duplicate replays, a fingerprint mismatch rejects, and an
	 * id-gen failure fails — all without consuming a receipt or calling the
	 * provider. After the durable commit the side-effect reactor is the single
	 * provider executor: it drains the outbox row, streams output to
	 * ProviderRuntimeIngestion, and records completion/failure. The provider
	 * result flows back so the same-process waiter and provider-state
	 * persistence behave exactly as the former inline path did.
	 */
	private handleDurableSendTurnEffect(
		command: SendTurnCommand,
		durable: DurableCommandRuntime,
	): Effect.Effect<TurnResult, OrchestrationError> {
		return Effect.gen({ self: this }, function* () {
			const hash = fingerprintHash(effectiveDispatchFingerprint(command));

			const existing = yield* durable.receipts
				.checkReceipt(command.commandId)
				.pipe(Effect.orDie);
			if (existing) {
				if (existing.projectId !== durable.projectId)
					return yield* Effect.fail(
						new CommandFingerprintMismatch({ commandId: command.commandId }),
					);
				// The stored hash is only comparable to a freshly computed one within
				// the same fingerprint scheme version. A version mismatch (a receipt
				// written under an older scheme) is treated as a fingerprint mismatch:
				// reject rather than risk replaying — or, worse, re-executing — a
				// command whose identity cannot be verified. No v1 receipts exist in
				// any deployed database (the durable path is unreleased), so this is a
				// forward-compatibility guard, not a live migration path.
				if (
					existing.fingerprintHash !== undefined &&
					(existing.fingerprintHash !== hash ||
						(existing.fingerprintVersion !== undefined &&
							existing.fingerprintVersion !==
								DURABLE_COMMAND_FINGERPRINT_VERSION))
				) {
					return yield* Effect.fail(
						new CommandFingerprintMismatch({ commandId: command.commandId }),
					);
				}
				if (existing.status === "side_effect_completed") {
					return REPLAYED_TURN_RESULT;
				}
				if (existing.status === "side_effect_requested") {
					// Replaying an orphan cannot execute it. Its owned interruption
					// settles the reservation, command and receipt together.
					const [owner] = yield* durable.sql<{
						run_id: string;
						input_id: string;
						error_code: string | null;
					}>`
						SELECT outbox.error_code, COALESCE(run.joined_into, run.id) AS run_id,
							COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'),
								json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), outbox.command_id) AS input_id
						FROM provider_command_outbox outbox JOIN provider_runs run
							ON run.id = outbox.run_id AND run.session_id = outbox.session_id
						WHERE outbox.command_id = ${command.commandId} AND outbox.project_key = ${durable.projectId}
							AND outbox.status IN ('pending', 'running', 'retryable_failed') LIMIT 1`.pipe(
						Effect.orDie,
					);
					if (owner?.error_code === "delivery_indeterminate")
						return { ...REPLAYED_TURN_RESULT, status: "indeterminate" };
					if (owner)
						yield* durable.ingestion
							.ingest({
								eventId: `provider-command-orphaned:${owner.run_id}`,
								type: "turn.interrupted",
								providerId: "conduit",
								sessionId: command.input.sessionId,
								runId: owner.run_id,
								providerRefs: {},
								rawSource: { kind: "conduit.command-replay" },
								createdAt: durable.now(),
								data: {
									messageId: owner.input_id,
									userMessageId: owner.input_id,
									reason: ORPHANED_TURN_RESULT.error?.message,
									code: "orphaned",
								},
							})
							.pipe(Effect.orDie);
					return ORPHANED_TURN_RESULT;
				}
			}

			if (
				isCommandScopeTombstoned(
					durable.snapshot,
					"session",
					command.input.sessionId,
				)
			) {
				return yield* Effect.fail(
					new StaleCommandRejected({
						commandId: command.commandId,
						scopeKind: "session",
						scopeId: command.input.sessionId,
					}),
				);
			}

			// Injected id generation before receipt consumption / provider lookup.
			const dispatchId = yield* Effect.try({
				try: () => durable.generateId(),
				catch: (cause) =>
					new CommandIdGenerationFailed({
						commandId: command.commandId,
						cause,
					}),
			});
			const nowMs = durable.now();

			// Provider lookup before durable commit: a lookup failure consumes no
			// receipt and can be retried after registration. The reactor re-looks
			// up the instance when it executes; this is the pre-commit fail-fast.
			yield* this.getProviderInstanceEffect(
				command.providerId,
				command.input.account,
			);

			yield* this.commitAcceptedSendTurn(
				command,
				durable,
				hash,
				dispatchId,
				nowMs,
			).pipe(
				Effect.mapError(
					(cause) =>
						new ProviderInstanceFailure({
							providerId: command.providerId,
							operation: "commitSendTurn",
							cause,
						}),
				),
			);

			// Bind the session so follow-up commands route to this provider,
			// matching the inline path.
			yield* Effect.sync(() =>
				this.sessionBindingReadModel.bindSession(
					command.input.sessionId,
					command.providerId,
				),
			);
			yield* command.onAccepted ?? Effect.void;

			// The reactor is the single provider executor: it performs the call
			// once and ingests output. The projector settles the receipt; the
			// foreground caller waits on that durable outcome. The
			// caller's real event sink is threaded through so provider-driven
			// permission/question interactions resolve exactly as the inline path.
			return yield* durable.reactor
				.runCommand(
					command.commandId,
					command.input.eventSink,
					command.input.abortSignal,
				)
				.pipe(
					Effect.mapError((cause) =>
						cause instanceof ProviderInstanceFailure
							? cause
							: new ProviderInstanceFailure({
									providerId: command.providerId,
									operation: "sendTurn",
									cause,
								}),
					),
				);
		});
	}

	private commitAcceptedSendTurn(
		command: SendTurnCommand,
		durable: DurableCommandRuntime,
		fingerprintHashValue: string,
		dispatchId: string,
		nowMs: number,
	): Effect.Effect<
		void,
		| SqlError
		| EventStoreError
		| CommitAndSignalFailure
		| Error
		| CommandPayloadSerializationFailed
	> {
		const driver = command.input.account?.driver ?? command.providerId;
		// The rewind range and request sequence share ingestion's write boundary:
		// a backfill accepted before this write must be removed by this commit.
		const commit = Effect.gen(function* () {
			const pendingRewind = command.input.continuation
				? undefined
				: yield* readPendingRewindCommit(durable.sql, command.input.sessionId);
			const [maxRow] = yield* durable.sql<{ readonly m: number }>`
					SELECT COALESCE(MAX(request_sequence), 0) AS m FROM provider_command_outbox`;
			const requestSequence = (maxRow?.m ?? 0) + 1;
			const {
				eventSink: _eventSink,
				abortSignal: _abortSignal,
				history: _history,
				...payload
			} = command.input;
			const payloadJson = yield* Effect.try({
				try: () =>
					JSON.stringify({
						...payload,
						...(getProviderDriver(driver)?.supportsNativeResume && pendingRewind
							? { rewind: pendingRewind.rewind }
							: {}),
						dispatchId,
					}),
				catch: (cause) =>
					new CommandPayloadSerializationFailed({
						commandId: command.commandId,
						cause,
					}),
			});
			return yield* durable.commit.commit(
				decideDurableSendTurnCommand({
					commandId: command.commandId,
					sessionId: command.input.sessionId,
					providerId: command.providerId,
					fingerprintHash: fingerprintHashValue,
					nowMs,
					requestSequence,
					payloadJson,
					events: [...(pendingRewind?.events ?? []), ...(command.events ?? [])],
				}),
			);
		});
		// Through the seam the events are projected in the same transaction and
		// announced once it commits.
		return durable.write((project) => Effect.flatMap(commit, project));
	}

	private handleInlineSendTurnEffect(
		command: SendTurnCommand,
	): Effect.Effect<TurnResult, OrchestrationError> {
		return Effect.gen({ self: this }, function* () {
			const instance = yield* this.getProviderInstanceEffect(
				command.providerId,
				command.input.account,
			);
			yield* command.onAccepted ?? Effect.void;
			return yield* this.sendTurnThroughInstanceEffect(command, instance);
		});
	}

	/** Bind the session, invoke the provider inline, restore binding on error. */
	private sendTurnThroughInstanceEffect(
		command: SendTurnCommand,
		instance: ProviderInstance,
	): Effect.Effect<TurnResult, OrchestrationError> {
		return Effect.gen({ self: this }, function* () {
			yield* Effect.sync(() =>
				log.info(
					`Dispatching sendTurn: session=${command.input.sessionId} provider=${command.providerId}`,
				),
			);

			const previousProviderId =
				yield* this.sessionBindingReadModel.getProviderForSession(
					command.input.sessionId,
				);
			const restorePreviousBinding = Effect.sync(() => {
				if (previousProviderId) {
					this.sessionBindingReadModel.bindSession(
						command.input.sessionId,
						previousProviderId,
					);
				} else {
					this.sessionBindingReadModel.unbindSession(command.input.sessionId);
				}
			});
			yield* Effect.sync(() =>
				this.sessionBindingReadModel.bindSession(
					command.input.sessionId,
					command.providerId,
				),
			);
			const sendEffect = yield* Effect.try({
				try: () => instance.sendTurnEffect(command.input),
				catch: (cause) =>
					new ProviderInstanceFailure({
						providerId: command.providerId,
						operation: "sendTurn",
						cause,
					}),
			}).pipe(Effect.tapError(() => restorePreviousBinding));
			const result = yield* sendEffect.pipe(
				Effect.tapError(() => restorePreviousBinding),
			);
			return result;
		});
	}

	private handleInterruptTurnEffect(
		command: InterruptTurnCommand,
	): Effect.Effect<void, OrchestrationError> {
		return Effect.gen({ self: this }, function* () {
			const providerId = yield* this.requireProviderForSessionEffect(
				command.sessionId,
			);
			const instance = yield* this.getProviderInstanceEffect(providerId);

			yield* Effect.sync(() =>
				log.info(`Dispatching interruptTurn: session=${command.sessionId}`),
			);

			return yield* instance
				.interruptTurnEffect(command.sessionId)
				.pipe(
					Effect.tapError((error) =>
						Effect.sync(() =>
							log.error(
								`interruptTurn failed: session=${command.sessionId} provider=${providerId}: ${error.message}`,
							),
						),
					),
				);
		});
	}

	private handleResolvePermissionEffect(
		command: ResolvePermissionCommand,
	): Effect.Effect<void, OrchestrationError> {
		return Effect.gen({ self: this }, function* () {
			const providerId = yield* this.requireProviderForSessionEffect(
				command.sessionId,
			);
			const instance = yield* this.getProviderInstanceEffect(providerId);

			return yield* instance
				.resolvePermissionEffect(
					command.sessionId,
					command.requestId,
					command.decision,
				)
				.pipe(
					Effect.tapError((error) =>
						Effect.sync(() =>
							log.error(
								`resolvePermission failed: session=${command.sessionId} request=${command.requestId} provider=${providerId}: ${error.message}`,
							),
						),
					),
				);
		});
	}

	private handleResolveQuestionEffect(
		command: ResolveQuestionCommand,
	): Effect.Effect<void, OrchestrationError> {
		return Effect.gen({ self: this }, function* () {
			const providerId = yield* this.requireProviderForSessionEffect(
				command.sessionId,
			);
			const instance = yield* this.getProviderInstanceEffect(providerId);

			return yield* instance
				.resolveQuestionEffect(
					command.sessionId,
					command.requestId,
					command.answers,
				)
				.pipe(
					Effect.tapError((error) =>
						Effect.sync(() =>
							log.error(
								`resolveQuestion failed: session=${command.sessionId} request=${command.requestId} provider=${providerId}: ${error.message}`,
							),
						),
					),
				);
		});
	}

	private handleDiscoverEffect(
		command: DiscoverCommand,
	): Effect.Effect<ProviderCapabilities, OrchestrationError> {
		return Effect.gen({ self: this }, function* () {
			const instance = yield* this.getProviderInstanceEffect(
				command.providerId,
				command.account,
			);
			const discovery = command.refresh
				? instance.discoverEffect(command.workspaceRoot, command.account, {
						refresh: true,
					})
				: instance.discoverEffect(command.workspaceRoot, command.account);
			return yield* discovery.pipe(
				Effect.tapError((error) =>
					Effect.sync(() =>
						log.error(
							`discover failed: provider=${command.providerId}: ${error.message}`,
						),
					),
				),
			);
		});
	}

	private handleEndSessionEffect(
		command: EndSessionCommand,
	): Effect.Effect<void, OrchestrationError> {
		return Effect.gen({ self: this }, function* () {
			const targetBindingRevision =
				yield* this.sessionBindingReadModel.getBindingRevision(
					command.sessionId,
				);
			const providerId =
				command.targetProviderId ??
				(yield* this.sessionBindingReadModel.getProviderForSession(
					command.sessionId,
				));
			if (!providerId) {
				yield* Effect.sync(() =>
					log.debug(
						`endSession: no provider bound for session=${command.sessionId}`,
					),
				);
				return;
			}
			const endSession = Effect.gen({ self: this }, function* () {
				const instance = yield* this.getProviderInstanceEffect(
					providerId,
					command.account,
				);
				yield* Effect.sync(() =>
					log.info(
						`Dispatching endSession: session=${command.sessionId} provider=${providerId}`,
					),
				);
				return yield* instance
					.endSessionEffect(command.sessionId)
					.pipe(
						Effect.tapError((error) =>
							Effect.sync(() =>
								log.error(
									`endSession failed: session=${command.sessionId} provider=${providerId}: ${error.message}`,
								),
							),
						),
					);
			});
			if (command.unbind) {
				return yield* endSession.pipe(
					Effect.ensuring(
						this.sessionBindingReadModel.unbindSessionIfBoundTo(
							command.sessionId,
							providerId,
							targetBindingRevision,
						),
					),
				);
			}
			yield* endSession;
		});
	}

	/** Bind a session to a provider. */
	bindSession(sessionId: string, providerId: string): void {
		this.sessionBindingReadModel.bindSession(sessionId, providerId);
	}

	/** Unbind a session from its provider. */
	unbindSession(sessionId: string): void {
		this.sessionBindingReadModel.unbindSession(sessionId);
	}

	/** Get the provider ID for a session, or undefined if not bound. */
	getProviderForSessionEffect(
		sessionId: string,
	): Effect.Effect<string | undefined> {
		return this.sessionBindingReadModel.getProviderForSession(sessionId);
	}

	/** List all bound sessions with their provider IDs. */
	listBoundSessionsEffect(
		scope: SessionScope,
	): Effect.Effect<SessionBinding[]> {
		return this.sessionBindingReadModel.listBoundSessions(scope);
	}

	/**
	 * Drain any committed-but-unexecuted provider side effects through the
	 * reactor (crash recovery / orphaned outbox rows). Same-process dispatch
	 * already awaits its own execution; this is the deterministic quiescence
	 * seam for tests and startup recovery. No-op when durable commands are off.
	 */
	drainSideEffects(
		makeInteractions?: ProviderCommandInteractionSinkFactory,
	): Effect.Effect<void, ProviderCommandStoreFailure> {
		return this.durable
			? this.durable.reactor.drain(makeInteractions)
			: Effect.void;
	}

	/** Shutdown the engine and all provider instances. */
	shutdownEffect(): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			yield* Effect.sync(() => log.info("OrchestrationEngine shutting down"));
			yield* this.registry.shutdownAllEffect();
			yield* Effect.sync(() => {
				this.sessionBindingReadModel.clearTransientBindings();
				this.inFlightCommands.clear();
			});
		});
	}

	private getProviderInstanceEffect(
		providerId: string,
		account?: Account,
	): Effect.Effect<ProviderInstance, ProviderNotRegistered> {
		if (account) return this.registry.getInstanceEffect(account.driver);
		if (this.accountDirectory)
			return this.accountDirectory.resolve({ _tag: "Id", id: providerId }).pipe(
				Effect.flatMap((resolved) =>
					this.registry.getInstanceEffect(resolved.driver),
				),
				Effect.mapError(() => new ProviderNotRegistered({ providerId })),
			);
		return this.registry.getInstanceEffect(providerId);
	}

	private requireProviderForSessionEffect(
		sessionId: string,
	): Effect.Effect<string, SessionProviderNotBound> {
		return this.sessionBindingReadModel
			.getProviderForSession(sessionId)
			.pipe(
				Effect.flatMap((providerId) =>
					providerId
						? Effect.succeed(providerId)
						: Effect.fail(new SessionProviderNotBound({ sessionId })),
				),
			);
	}
}

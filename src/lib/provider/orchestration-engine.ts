// src/lib/provider/orchestration-engine.ts
// ─── Orchestration Engine ───────────────────────────────────────────────────
// Central command processor for the provider instance layer (CQRS core loop).
// Routes commands to the correct provider instance via ProviderRegistry.
// Manages session-to-provider mapping.

import { Deferred, Effect } from "effect";

import type { ProviderRuntimeIngestion } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { createLogger } from "../logger.js";
import type { SqliteClient } from "../persistence/sqlite-client.js";
import {
	CommandFingerprintMismatch,
	CommandIdGenerationFailed,
	MissingCommandId,
	type OrchestrationError,
	ProviderInstanceFailure,
	SessionProviderNotBound,
	StaleCommandRejected,
} from "./errors.js";
import { DurableCommandCommitRepository } from "./orchestration-command-commit.js";
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
import { ProviderSideEffectReactor } from "./orchestration-side-effect-reactor.js";
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

// ─── Command Types ──────────────────────────────────────────────────────────

export interface SendTurnCommand {
	readonly type: "send_turn";
	readonly commandId: string;
	readonly providerId: string;
	readonly input: SendTurnInput;
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
}

export interface EndSessionCommand {
	readonly type: "end_session";
	readonly commandId: string;
	readonly sessionId: string;
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

// ─── Session Binding ────────────────────────────────────────────────────────

export interface SessionBinding {
	readonly sessionId: string;
	readonly providerId: string;
}

// ─── Engine Options ─────────────────────────────────────────────────────────

/**
 * Durable command store wiring. When supplied, the engine treats durable
 * command receipts as the authoritative dedupe: it checks the receipt before
 * dispatch, rejects reused ids with a changed effective-dispatch fingerprint,
 * and replays accepted commands after restart without a provider call. The
 * in-memory `inFlightCommands` map remains only a same-process waiter.
 *
 * `now`/`generateId` are injected so tests can control time and force id-gen
 * failures; production supplies wall-clock and a random id at the wiring edge.
 */
export interface DurableCommandStoreOptions {
	readonly db: SqliteClient;
	readonly projectKey: string;
	readonly now: () => number;
	readonly generateId: () => string;
	/**
	 * Provider-output sink for the side-effect reactor. Production supplies the
	 * shared ProviderRuntimeIngestion so streamed provider events are persisted
	 * exactly as the inline path did. Absent in narrow unit tests (no-op sink).
	 */
	readonly ingestion?: Pick<ProviderRuntimeIngestion, "ingest">;
}

export interface OrchestrationEngineOptions {
	readonly registry: ProviderRegistry;
	readonly sessionBindingReadModel?: ProviderSessionBindingReadModel;
	readonly durableCommands?: DurableCommandStoreOptions;
}

interface DurableCommandRuntime {
	readonly commit: DurableCommandCommitRepository;
	readonly receipts: CommandReadModelRepository;
	readonly reactor: ProviderSideEffectReactor;
	readonly db: SqliteClient;
	readonly projectKey: string;
	readonly now: () => number;
	readonly generateId: () => string;
	readonly snapshot: CommandReadModelSnapshot;
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

/**
 * Result returned when a durable receipt is still `side_effect_requested` — the
 * command was committed but never executed (crash between commit and provider
 * execution). Per the plan's crash policy the provider is NOT re-executed on
 * replay; the caller receives an explicit incomplete/orphaned status rather than
 * a synthetic success.
 */
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

// ─── OrchestrationEngine ────────────────────────────────────────────────────

export class OrchestrationEngine {
	private readonly registry: ProviderRegistry;
	private readonly sessionBindingReadModel: ProviderSessionBindingReadModel;
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
		if (options.durableCommands) {
			const durable = options.durableCommands;
			const receipts = new CommandReadModelRepository(durable.db);
			this.durable = {
				commit: new DurableCommandCommitRepository(durable.db),
				receipts,
				// Single provider executor. Shares the durable DB, registry, and
				// wall-clock with the engine; provider output streams to the shared
				// ProviderRuntimeIngestion (no-op sink when none is supplied).
				reactor: new ProviderSideEffectReactor({
					db: durable.db,
					registry: this.registry,
					ingestion: durable.ingestion ?? { ingest: () => Effect.succeed(0) },
					nowMs: durable.now,
				}),
				db: durable.db,
				projectKey: durable.projectKey,
				now: durable.now,
				generateId: durable.generateId,
				// Narrow command read-model bootstrap: load only the command decision
				// snapshot (receipts + stale-command tombstones), never the full
				// relay/UI snapshot or message history.
				snapshot: receipts.bootstrap(),
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
		return Effect.gen(this, function* () {
			yield* this.ensureMutatingCommandHasId(command);
			if (!command.commandId) {
				return yield* this.runCommandEffect(command);
			}
			const commandId = command.commandId;

			const existing = this.inFlightCommands.get(commandId);
			if (existing) return yield* Deferred.await(existing);

			const deferred = yield* Deferred.make<
				OrchestrationResult,
				OrchestrationError
			>();
			this.inFlightCommands.set(commandId, deferred);

			return yield* this.runCommandEffect(command).pipe(
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
		return Effect.gen(this, function* () {
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

	// ─── Command Handlers ─────────────────────────────────────────────────

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
		return Effect.gen(this, function* () {
			const hash = fingerprintHash(effectiveDispatchFingerprint(command));

			const existing = yield* Effect.sync(() =>
				durable.receipts.checkReceipt(command.commandId),
			);
			if (existing) {
				if (
					existing.fingerprintHash !== undefined &&
					existing.fingerprintHash !== hash
				) {
					return yield* Effect.fail(
						new CommandFingerprintMismatch({ commandId: command.commandId }),
					);
				}
				if (existing.status === "side_effect_completed") {
					return REPLAYED_TURN_RESULT;
				}
				if (existing.status === "side_effect_requested") {
					// Committed but never executed (orphaned). Do not re-execute the
					// provider; surface an explicit incomplete status.
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
			yield* this.registry.getInstanceEffect(command.providerId);

			yield* Effect.try({
				try: () =>
					this.commitAcceptedSendTurn(
						command,
						durable,
						hash,
						dispatchId,
						nowMs,
					),
				catch: (cause) =>
					new ProviderInstanceFailure({
						providerId: command.providerId,
						operation: "commitSendTurn",
						cause,
					}),
			});

			// Bind the session so follow-up commands route to this provider,
			// matching the inline path.
			yield* Effect.sync(() =>
				this.sessionBindingReadModel.bindSession(
					command.input.sessionId,
					command.providerId,
				),
			);

			// The reactor is the single provider executor: it performs the call
			// once, ingests output, and records completion/failure. Its result
			// (carrying provider-state updates) is surfaced to the waiter. The
			// caller's real event sink is threaded through so provider-driven
			// permission/question interactions resolve exactly as the inline path.
			return yield* durable.reactor
				.runCommand(command.commandId, command.input.eventSink)
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
	): void {
		const requestSequence =
			(durable.db.queryOne<{ readonly m: number }>(
				"SELECT COALESCE(MAX(request_sequence), 0) AS m FROM provider_command_outbox",
			)?.m ?? 0) + 1;
		const {
			eventSink: _eventSink,
			abortSignal: _abortSignal,
			...payload
		} = command.input;
		const payloadJson = JSON.stringify({ ...payload, dispatchId });
		durable.commit.commit(
			decideDurableSendTurnCommand({
				commandId: command.commandId,
				projectKey: durable.projectKey,
				sessionId: command.input.sessionId,
				providerId: command.providerId,
				fingerprintHash: fingerprintHashValue,
				nowMs,
				requestSequence,
				payloadJson,
				events: [],
			}),
		);
	}

	private handleInlineSendTurnEffect(
		command: SendTurnCommand,
	): Effect.Effect<TurnResult, OrchestrationError> {
		return Effect.gen(this, function* () {
			const instance = yield* this.registry.getInstanceEffect(
				command.providerId,
			);
			return yield* this.sendTurnThroughInstanceEffect(command, instance);
		});
	}

	/** Bind the session, invoke the provider inline, restore binding on error. */
	private sendTurnThroughInstanceEffect(
		command: SendTurnCommand,
		instance: ProviderInstance,
	): Effect.Effect<TurnResult, OrchestrationError> {
		return Effect.gen(this, function* () {
			yield* Effect.sync(() =>
				log.info(
					`Dispatching sendTurn: session=${command.input.sessionId} provider=${command.providerId}`,
				),
			);

			const previousProviderId =
				this.sessionBindingReadModel.getProviderForSession(
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
		return Effect.gen(this, function* () {
			const providerId = yield* this.getProviderForSessionEffect(
				command.sessionId,
			);
			const instance = yield* this.registry.getInstanceEffect(providerId);

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
		return Effect.gen(this, function* () {
			const providerId = yield* this.getProviderForSessionEffect(
				command.sessionId,
			);
			const instance = yield* this.registry.getInstanceEffect(providerId);

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
		return Effect.gen(this, function* () {
			const providerId = yield* this.getProviderForSessionEffect(
				command.sessionId,
			);
			const instance = yield* this.registry.getInstanceEffect(providerId);

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
		return Effect.gen(this, function* () {
			const instance = yield* this.registry.getInstanceEffect(
				command.providerId,
			);
			return yield* instance
				.discoverEffect()
				.pipe(
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
		return Effect.gen(this, function* () {
			const providerId = this.sessionBindingReadModel.getProviderForSession(
				command.sessionId,
			);
			if (!providerId) {
				yield* Effect.sync(() =>
					log.debug(
						`endSession: no provider bound for session=${command.sessionId}`,
					),
				);
				return;
			}
			const instance = yield* this.registry.getInstanceEffect(providerId);
			yield* Effect.sync(() =>
				log.info(
					`Dispatching endSession: session=${command.sessionId} provider=${providerId}`,
				),
			);
			yield* instance
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
			if (command.unbind) {
				yield* Effect.sync(() =>
					this.sessionBindingReadModel.unbindSession(command.sessionId),
				);
			}
		});
	}

	// ─── Session Binding Management ───────────────────────────────────────

	/** Bind a session to a provider. */
	bindSession(sessionId: string, providerId: string): void {
		this.sessionBindingReadModel.bindSession(sessionId, providerId);
	}

	/** Unbind a session from its provider. */
	unbindSession(sessionId: string): void {
		this.sessionBindingReadModel.unbindSession(sessionId);
	}

	/** Get the provider ID for a session, or undefined if not bound. */
	getProviderForSession(sessionId: string): string | undefined {
		return this.sessionBindingReadModel.getProviderForSession(sessionId);
	}

	/** List all bound sessions with their provider IDs. */
	listBoundSessions(): SessionBinding[] {
		return this.sessionBindingReadModel.listBoundSessions();
	}

	/**
	 * Drain any committed-but-unexecuted provider side effects through the
	 * reactor (crash recovery / orphaned outbox rows). Same-process dispatch
	 * already awaits its own execution; this is the deterministic quiescence
	 * seam for tests and startup recovery. No-op when durable commands are off.
	 */
	drainSideEffects(): Effect.Effect<void, unknown> {
		return this.durable ? this.durable.reactor.drain() : Effect.void;
	}

	/** Shutdown the engine and all provider instances. */
	shutdownEffect(): Effect.Effect<void> {
		return Effect.gen(this, function* () {
			yield* Effect.sync(() => log.info("OrchestrationEngine shutting down"));
			yield* this.registry.shutdownAllEffect();
			yield* Effect.sync(() => {
				this.sessionBindingReadModel.clearTransientBindings();
				this.inFlightCommands.clear();
			});
		});
	}

	// ─── Internal ─────────────────────────────────────────────────────────

	private getProviderForSessionEffect(
		sessionId: string,
	): Effect.Effect<string, SessionProviderNotBound> {
		const providerId =
			this.sessionBindingReadModel.getProviderForSession(sessionId);
		if (!providerId) {
			return Effect.fail(new SessionProviderNotBound({ sessionId }));
		}
		return Effect.succeed(providerId);
	}
}

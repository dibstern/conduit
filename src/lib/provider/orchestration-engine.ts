// src/lib/provider/orchestration-engine.ts
// ─── Orchestration Engine ───────────────────────────────────────────────────
// Central command processor for the provider instance layer (CQRS core loop).
// Routes commands to the correct provider instance via ProviderRegistry.
// Manages session-to-provider mapping.

import { Deferred, Effect } from "effect";

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
}

export interface OrchestrationEngineOptions {
	readonly registry: ProviderRegistry;
	readonly sessionBindingReadModel?: ProviderSessionBindingReadModel;
	readonly durableCommands?: DurableCommandStoreOptions;
}

interface DurableCommandRuntime {
	readonly commit: DurableCommandCommitRepository;
	readonly receipts: CommandReadModelRepository;
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
	 * provider. Provider execution stays inline (current behavior); the reactor
	 * cutover is cev.5.
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
				if (
					existing.status === "side_effect_requested" ||
					existing.status === "side_effect_completed"
				) {
					return REPLAYED_TURN_RESULT;
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
			// receipt and can be retried after registration.
			const instance = yield* this.registry.getInstanceEffect(
				command.providerId,
			);

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

			return yield* this.sendTurnThroughInstanceEffect(command, instance).pipe(
				Effect.tap(() =>
					Effect.sync(() =>
						this.markSendTurnCompleted(
							durable,
							command.commandId,
							durable.now(),
						),
					),
				),
				Effect.tapError(() =>
					Effect.sync(() =>
						this.rollbackAcceptedSendTurn(durable, command.commandId),
					),
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

	private markSendTurnCompleted(
		durable: DurableCommandRuntime,
		commandId: string,
		nowMs: number,
	): void {
		durable.db.runInTransaction(() => {
			durable.db.execute(
				"UPDATE command_receipts SET status = 'side_effect_completed', updated_at = ? WHERE command_id = ?",
				[nowMs, commandId],
			);
			durable.db.execute(
				"UPDATE provider_command_outbox SET status = 'completed', updated_at = ? WHERE command_id = ?",
				[nowMs, commandId],
			);
		});
	}

	/**
	 * Inline provider failure (non-crash): remove the accepted receipt + outbox
	 * row so a fresh dispatch can retry, preserving current retry-after-failure
	 * behavior. A crash between commit and completion leaves the receipt in
	 * `side_effect_requested`, which replays as orphaned (no re-execution).
	 */
	private rollbackAcceptedSendTurn(
		durable: DurableCommandRuntime,
		commandId: string,
	): void {
		durable.db.runInTransaction(() => {
			durable.db.execute(
				"DELETE FROM provider_command_outbox WHERE command_id = ?",
				[commandId],
			);
			durable.db.execute("DELETE FROM command_receipts WHERE command_id = ?", [
				commandId,
			]);
		});
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

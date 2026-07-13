// src/lib/provider/orchestration-engine.ts
// ─── Orchestration Engine ───────────────────────────────────────────────────
// Central command processor for the provider instance layer (CQRS core loop).
// Routes commands to the correct provider instance via ProviderRegistry.
// Manages session-to-provider mapping.

import { Deferred, Effect } from "effect";

import { createLogger } from "../logger.js";
import {
	MissingCommandId,
	type OrchestrationError,
	ProviderInstanceFailure,
	SessionProviderNotBound,
} from "./errors.js";
import type { ProviderRegistry } from "./provider-registry.js";
import {
	InMemoryProviderSessionBindingReadModel,
	type ProviderSessionBindingReadModel,
} from "./provider-session-binding-read-model.js";
import type {
	PermissionDecision,
	ProviderCapabilities,
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

export interface OrchestrationEngineOptions {
	readonly registry: ProviderRegistry;
	readonly sessionBindingReadModel?: ProviderSessionBindingReadModel;
}

// ─── OrchestrationEngine ────────────────────────────────────────────────────

export class OrchestrationEngine {
	private readonly registry: ProviderRegistry;
	private readonly sessionBindingReadModel: ProviderSessionBindingReadModel;
	private readonly inFlightCommands = new Map<
		string,
		Deferred.Deferred<OrchestrationResult, OrchestrationError>
	>();

	constructor(options: OrchestrationEngineOptions) {
		this.registry = options.registry;
		this.sessionBindingReadModel =
			options.sessionBindingReadModel ??
			new InMemoryProviderSessionBindingReadModel();
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
		return Effect.gen(this, function* () {
			const instance = yield* this.registry.getInstanceEffect(
				command.providerId,
			);

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

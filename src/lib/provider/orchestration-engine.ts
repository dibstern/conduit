// src/lib/provider/orchestration-engine.ts
// ─── Orchestration Engine ───────────────────────────────────────────────────
// Central command processor for the provider instance layer (CQRS core loop).
// Routes commands to the correct provider instance via ProviderRegistry.
// Manages session-to-provider mapping.

import { Effect, Ref } from "effect";

import { createLogger } from "../logger.js";
import {
	DuplicateCommand,
	type OrchestrationError,
	ProviderInstanceFailure,
	SessionProviderNotBound,
} from "./errors.js";
import type { ProviderRegistry } from "./provider-registry.js";
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
	readonly commandId?: string;
	readonly providerId: string;
	readonly input: SendTurnInput;
}

export interface InterruptTurnCommand {
	readonly type: "interrupt_turn";
	readonly commandId?: string;
	readonly sessionId: string;
}

export interface ResolvePermissionCommand {
	readonly type: "resolve_permission";
	readonly commandId?: string;
	readonly sessionId: string;
	readonly requestId: string;
	readonly decision: PermissionDecision;
}

export interface ResolveQuestionCommand {
	readonly type: "resolve_question";
	readonly commandId?: string;
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
	readonly commandId?: string;
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
}

// ─── OrchestrationEngine ────────────────────────────────────────────────────

export class OrchestrationEngine {
	private readonly registry: ProviderRegistry;
	private readonly sessionBindings = new Map<string, string>();
	private processedCommands: Ref.Ref<Set<string>>;
	private static readonly PROCESSED_COMMANDS_MAX = 10_000;

	constructor(options: OrchestrationEngineOptions) {
		this.registry = options.registry;
		this.processedCommands = Ref.unsafeMake(new Set<string>());
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
			yield* this.ensureCommandNotProcessed(command);

			let result: OrchestrationResult;

			switch (command.type) {
				case "send_turn":
					result = yield* this.handleSendTurnEffect(command);
					break;
				case "interrupt_turn":
					result = yield* this.handleInterruptTurnEffect(command);
					break;
				case "resolve_permission":
					result = yield* this.handleResolvePermissionEffect(command);
					break;
				case "resolve_question":
					result = yield* this.handleResolveQuestionEffect(command);
					break;
				case "discover":
					result = yield* this.handleDiscoverEffect(command);
					break;
				case "end_session":
					result = yield* this.handleEndSessionEffect(command);
					break;
				default: {
					const _exhaustive: never = command;
					return _exhaustive;
				}
			}

			yield* this.markCommandProcessed(command);
			return result;
		});
	}

	private ensureCommandNotProcessed(
		command: OrchestrationCommand,
	): Effect.Effect<void, DuplicateCommand> {
		if (!command.commandId) return Effect.void;
		const id = command.commandId;
		return Effect.gen(this, function* () {
			const isDuplicate = yield* Ref.modify(this.processedCommands, (set) => {
				if (set.has(id)) return [true, set] as const;
				return [false, set] as const;
			});
			if (isDuplicate) {
				return yield* new DuplicateCommand({ commandId: id });
			}
		});
	}

	private markCommandProcessed(
		command: OrchestrationCommand,
	): Effect.Effect<void> {
		if (!command.commandId) return Effect.void;
		const id = command.commandId;
		return Ref.modify(this.processedCommands, (set) => {
			const next = new Set(set);
			next.add(id);
			if (next.size > OrchestrationEngine.PROCESSED_COMMANDS_MAX) {
				const evictCount = OrchestrationEngine.PROCESSED_COMMANDS_MAX / 2;
				let count = 0;
				for (const entry of next) {
					if (count++ >= evictCount) break;
					next.delete(entry);
				}
			}
			return [undefined, next] as const;
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

			const previousProviderId = this.sessionBindings.get(
				command.input.sessionId,
			);
			const restorePreviousBinding = Effect.sync(() => {
				if (previousProviderId) {
					this.sessionBindings.set(command.input.sessionId, previousProviderId);
				} else {
					this.sessionBindings.delete(command.input.sessionId);
				}
			});
			yield* Effect.sync(() =>
				this.sessionBindings.set(command.input.sessionId, command.providerId),
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
			const providerId = this.sessionBindings.get(command.sessionId);
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
					this.sessionBindings.delete(command.sessionId),
				);
			}
		});
	}

	// ─── Session Binding Management ───────────────────────────────────────

	/** Bind a session to a provider. */
	bindSession(sessionId: string, providerId: string): void {
		this.sessionBindings.set(sessionId, providerId);
	}

	/** Unbind a session from its provider. */
	unbindSession(sessionId: string): void {
		this.sessionBindings.delete(sessionId);
	}

	/** Get the provider ID for a session, or undefined if not bound. */
	getProviderForSession(sessionId: string): string | undefined {
		return this.sessionBindings.get(sessionId);
	}

	/** List all bound sessions with their provider IDs. */
	listBoundSessions(): SessionBinding[] {
		return [...this.sessionBindings.entries()].map(
			([sessionId, providerId]) => ({ sessionId, providerId }),
		);
	}

	/** Shutdown the engine and all provider instances. */
	shutdownEffect(): Effect.Effect<void> {
		return Effect.gen(this, function* () {
			yield* Effect.sync(() => log.info("OrchestrationEngine shutting down"));
			yield* this.registry.shutdownAllEffect();
			yield* Effect.sync(() => {
				this.sessionBindings.clear();
				this.processedCommands = Ref.unsafeMake(new Set<string>());
			});
		});
	}

	// ─── Internal ─────────────────────────────────────────────────────────

	private getProviderForSessionEffect(
		sessionId: string,
	): Effect.Effect<string, SessionProviderNotBound> {
		const providerId = this.sessionBindings.get(sessionId);
		if (!providerId) {
			return Effect.fail(new SessionProviderNotBound({ sessionId }));
		}
		return Effect.succeed(providerId);
	}

	// pruneProcessedCommands() removed — FIFO eviction is now inlined
	// in the Ref.modify call within dispatch().
}

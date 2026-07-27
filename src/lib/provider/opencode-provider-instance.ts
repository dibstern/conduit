// src/lib/provider/opencode-provider-instance.ts
// ─── OpenCode Provider Instance ─────────────────────────────────────────────
// Wraps the existing OpenCodeClient REST API behind the ProviderInstance
// interface. Translates OpenCode SSE events into canonical events via EventSink.

import { Deferred, Effect } from "effect";
import { OpenCodeApiError } from "../errors.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { PromptOptions } from "../instance/sdk-types.js";
import { createLogger } from "../logger.js";
import { ProviderInstanceFailure } from "./errors.js";
import type {
	CommandInfo,
	ModelInfo,
	PermissionDecision,
	ProviderCapabilities,
	ProviderDriver,
	ProviderInstance,
	SendTurnInput,
	TurnResult,
} from "./types.js";

const log = createLogger("opencode-provider-instance");

function interruptedTurnResult(): TurnResult {
	return {
		status: "interrupted",
		cost: 0,
		tokens: { input: 0, output: 0 },
		durationMs: 0,
		providerStateUpdates: [],
	};
}

function sendFailedTurnResult(message: string): TurnResult {
	return {
		status: "error",
		cost: 0,
		tokens: { input: 0, output: 0 },
		durationMs: 0,
		error: { code: "send_failed", message },
		providerStateUpdates: [],
	};
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface OpenCodeProviderInstanceOptions {
	readonly client: OpenCodeAPI;
	readonly workspaceRoot?: string;
	/**
	 * Phase 4.4: resolve the API client for a session bound to a NAMED
	 * OpenCode instance (a real second server). Resolves to undefined when the
	 * session runs on the project-default instance, and fails when a named
	 * instance cannot be resolved — the caller surfaces that as a send
	 * failure instead of silently using the default server. Absent in wirings
	 * without named-instance support.
	 */
	readonly clientForSession?: (
		sessionId: string,
	) => Effect.Effect<OpenCodeAPI | undefined, Error>;
}

// ─── OpenCodeProviderInstance ──────────────────────────────────────────────

export class OpenCodeProviderInstance implements ProviderInstance {
	readonly providerId = "opencode";

	private readonly client: OpenCodeAPI;
	private readonly workspaceRoot: string | undefined;
	private readonly clientForSession:
		| ((sessionId: string) => Effect.Effect<OpenCodeAPI | undefined, Error>)
		| undefined;
	private readonly pendingTurns = new Map<
		string,
		Deferred.Deferred<TurnResult, Error>
	>();

	constructor(options: OpenCodeProviderInstanceOptions) {
		this.client = options.client;
		this.workspaceRoot = options.workspaceRoot;
		this.clientForSession = options.clientForSession;
	}

	/**
	 * Resolve the client that owns this session: the named instance's client
	 * when the session is bound to one, otherwise the project-default client.
	 */
	private resolveClientEffect(
		sessionId: string,
	): Effect.Effect<OpenCodeAPI, Error> {
		const resolve = this.clientForSession;
		if (resolve === undefined) return Effect.succeed(this.client);
		return resolve(sessionId).pipe(
			Effect.map((client) => client ?? this.client),
		);
	}

	private providerFailure(
		operation: string,
		cause: unknown,
	): ProviderInstanceFailure {
		return new ProviderInstanceFailure({
			providerId: this.providerId,
			operation,
			cause,
		});
	}

	// ─── discover ─────────────────────────────────────────────────────────

	discoverEffect(): Effect.Effect<
		ProviderCapabilities,
		ProviderInstanceFailure
	> {
		return Effect.tryPromise({
			try: () => this.discoverCapabilities(),
			catch: (cause) => this.providerFailure("discover", cause),
		});
	}

	private async discoverCapabilities(): Promise<ProviderCapabilities> {
		const [providerResult, commandsRaw, skillsRaw] = await Promise.all([
			this.client.provider.list(),
			this.client.app.commands(),
			this.client.app.skills(this.workspaceRoot),
		]);

		const models: ModelInfo[] = providerResult.providers.flatMap((provider) =>
			(provider.models ?? []).map((model) => ({
				id: model.id,
				name: model.name,
				providerId: provider.id,
				...(model.limit != null ? { limit: model.limit } : {}),
				...(model.variants ? { variants: model.variants } : {}),
			})),
		);

		const commands: CommandInfo[] = commandsRaw.map((cmd) => ({
			name: cmd.name,
			...(cmd.description != null ? { description: cmd.description } : {}),
			source: "builtin" as const,
		}));

		const skills: CommandInfo[] = skillsRaw.map((skill) => ({
			name: skill.name,
			...(skill.description != null ? { description: skill.description } : {}),
			source: "project-skill" as const,
		}));

		return {
			models,
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: true,
			supportsQuestions: true,
			supportsAttachments: true,
			supportsFork: true,
			supportsRevert: true,
			commands: [...commands, ...skills],
		};
	}

	// ─── sendTurn ─────────────────────────────────────────────────────────

	sendTurnEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ProviderInstanceFailure> {
		return this.sendTurnLocalEffect(input).pipe(
			Effect.mapError((cause) => this.providerFailure("sendTurn", cause)),
		);
	}

	private sendTurnLocalEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, unknown> {
		const { sessionId, prompt, model, images, agent, variant, abortSignal } =
			input;

		const promptOptions: PromptOptions = {
			text: prompt,
			...(model?.providerId && model?.modelId
				? { model: { providerID: model.providerId, modelID: model.modelId } }
				: {}),
			...(images && images.length > 0 ? { images: [...images] } : {}),
			...(agent ? { agent } : {}),
			...(variant ? { variant } : {}),
		};

		return Effect.gen(this, function* () {
			// Resolve the owning client first: a session bound to a NAMED
			// OpenCode instance must be prompted on THAT instance's server. A
			// resolution failure (unknown/unconfigured instance) becomes a clean
			// send failure — never a hang or a silent fall-through to the
			// default server.
			const clientResult = yield* Effect.either(
				this.resolveClientEffect(sessionId),
			);
			if (clientResult._tag === "Left") {
				const message = clientResult.left.message;
				log.error(
					`sendTurn client resolution failed for session ${sessionId}: ${message}`,
				);
				return sendFailedTurnResult(message);
			}
			const client = clientResult.right;

			const deferred = yield* Deferred.make<TurnResult, Error>();
			this.pendingTurns.set(sessionId, deferred);

			const onAbort = () => {
				log.info(`Turn aborted for session ${sessionId}`);
				client.session.abort(sessionId).catch((err) => {
					log.warn(`Failed to abort session ${sessionId}: ${err}`);
				});
			};
			abortSignal.addEventListener("abort", onAbort, { once: true });

			const cleanup = Effect.sync(() => {
				abortSignal.removeEventListener("abort", onAbort);
				this.pendingTurns.delete(sessionId);
			});

			return yield* Effect.gen(this, function* () {
				if (abortSignal.aborted) return interruptedTurnResult();

				const promptResult = yield* Effect.either(
					Effect.tryPromise({
						try: () => client.session.prompt(sessionId, promptOptions),
						catch: (cause) => cause,
					}),
				);
				if (promptResult._tag === "Left") {
					const cause = promptResult.left;
					const baseMessage =
						cause instanceof Error ? cause.message : String(cause);
					// Migration guard (Phase 4.4): a session bound to a named
					// OpenCode instance BEFORE per-instance routing physically
					// lives on the project-default server, so the named server
					// 404s the prompt. Surface that clearly instead of silently
					// re-routing to the default server.
					const message =
						client !== this.client &&
						cause instanceof OpenCodeApiError &&
						cause.responseStatus === 404
							? `${baseMessage} — this session does not exist on its bound OpenCode instance (it may predate named-instance routing); create a new session on that instance`
							: baseMessage;
					log.error(`sendTurn failed for session ${sessionId}: ${message}`);
					return sendFailedTurnResult(message);
				}

				return yield* Deferred.await(deferred);
			}).pipe(Effect.ensuring(cleanup));
		});
	}

	/**
	 * Called by the SSE event pipeline when a turn completes, errors, or
	 * is interrupted. Resolves the pending sendTurnEffect() wait.
	 *
	 * This is the bridge between the existing SSE-based event flow and the
	 * ProviderInstance interface. The SSE pipeline continues to own the
	 * connection; the provider instance just waits for notification.
	 */
	notifyTurnCompleted(sessionId: string, result: TurnResult): void {
		const deferred = this.pendingTurns.get(sessionId);
		if (deferred) {
			this.pendingTurns.delete(sessionId);
			// SSE callbacks are synchronous; complete the Effect Deferred directly
			// instead of adding an app-internal runtime bridge.
			Deferred.unsafeDone(deferred, Effect.succeed(result));
		} else {
			log.debug(
				`notifyTurnCompleted: no pending turn for session ${sessionId} -- may have already completed`,
			);
		}
	}

	// ─── interruptTurn ────────────────────────────────────────────────────

	interruptTurnEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.resolveClientEffect(sessionId).pipe(
			Effect.flatMap((client) =>
				Effect.tryPromise({
					try: () => client.session.abort(sessionId),
					catch: (cause) => cause,
				}),
			),
			Effect.mapError((cause) => this.providerFailure("interruptTurn", cause)),
			Effect.asVoid,
		);
	}

	// ─── resolvePermission ────────────────────────────────────────────────

	resolvePermissionEffect(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.resolveClientEffect(sessionId).pipe(
			Effect.flatMap((client) =>
				Effect.tryPromise({
					try: () => client.permission.reply(sessionId, requestId, decision),
					catch: (cause) => cause,
				}),
			),
			Effect.mapError((cause) =>
				this.providerFailure("resolvePermission", cause),
			),
			Effect.asVoid,
		);
	}

	// ─── resolveQuestion ──────────────────────────────────────────────────

	resolveQuestionEffect(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, ProviderInstanceFailure> {
		const answerArrays = Object.values(answers).map((v) =>
			Array.isArray(v) ? v.map(String) : [String(v)],
		);
		return this.resolveClientEffect(sessionId).pipe(
			Effect.flatMap((client) =>
				Effect.tryPromise({
					try: () => client.question.reply(requestId, answerArrays),
					catch: (cause) => cause,
				}),
			),
			Effect.mapError((cause) =>
				this.providerFailure("resolveQuestion", cause),
			),
			Effect.asVoid,
		);
	}

	// ─── endSession ──────────────────────────────────────────────────────

	endSessionEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return Effect.sync(() => this.endLocalSession(sessionId));
	}

	private endLocalSession(sessionId: string): void {
		// OpenCode owns session state server-side. The provider instance's only
		// per-session state is the pending turn Deferred; fail it so the caller
		// unblocks. We do not call client.session.abort: reload is a provider
		// instance reset, while interruptTurn/cancel is a provider cancellation.
		const deferred = this.pendingTurns.get(sessionId);
		if (deferred) {
			this.pendingTurns.delete(sessionId);
			Deferred.unsafeDone(
				deferred,
				Effect.fail(new Error("Session ended (reload)")),
			);
		}
	}

	// ─── shutdown ────────────────────────────────────────────────────────

	shutdownEffect(): Effect.Effect<void> {
		return Effect.sync(() => {
			log.info("OpenCodeProviderInstance shutting down");

			for (const [sessionId, deferred] of this.pendingTurns) {
				Deferred.unsafeDone(
					deferred,
					Effect.fail(
						new Error(
							`Provider instance shutdown -- turn for session ${sessionId} cancelled`,
						),
					),
				);
			}
			this.pendingTurns.clear();
		});
	}
}

export const OpenCodeDriver: ProviderDriver<OpenCodeProviderInstanceOptions> = {
	providerId: "opencode",
	create: (options) => Effect.sync(() => new OpenCodeProviderInstance(options)),
};

// src/lib/provider/opencode-provider-instance.ts
// Wraps the existing OpenCodeClient REST API behind the ProviderInstance
// interface. Translates OpenCode SSE events into canonical events via EventSink.

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Deferred, Effect, type Scope } from "effect";
import { PROVIDER_SESSION_CAPABILITIES } from "../contracts/provider-instance.js";
import { OpenCodeApiError } from "../errors.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type {
	PermissionRuleset,
	PromptOptions,
} from "../instance/sdk-types.js";
import { createLogger } from "../logger.js";
import type { SessionPermissionMode } from "../shared-types.js";
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

/**
 * OpenCode session rules for a Side Thread in the given mode. Session rules
 * append and the last match wins, so every mode change sends the full set.
 */
export function sideThreadPermissionRules(
	mode: SessionPermissionMode,
): PermissionRuleset {
	const plan = mode === "plan";
	return [
		{ permission: "edit", pattern: "*", action: plan ? "deny" : "ask" },
		{ permission: "bash", pattern: "*", action: "ask" },
		{ permission: "task", pattern: "*", action: plan ? "deny" : "allow" },
	];
}

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

export interface OpenCodeProviderInstanceOptions {
	readonly client: OpenCodeAPI;
	readonly workspaceRoot?: string;
	/**
	 * Resolve the scoped API client for the OpenCode instance that owns a
	 * session (OpenCode Instances `use`). Resolving to undefined means the
	 * default client. Fails when the instance is unknown or unreachable — the
	 * caller surfaces that as a send failure instead of silently using the
	 * default server. Absent in wirings
	 * without named-instance support.
	 */
	readonly clientForSession?: (
		sessionId: string,
	) => Effect.Effect<OpenCodeAPI | undefined, Error, Scope.Scope>;
}

export class OpenCodeProviderInstance implements ProviderInstance {
	readonly providerId = "opencode";
	readonly steering = false;

	private readonly client: OpenCodeAPI;
	private readonly workspaceRoot: string | undefined;
	private readonly clientForSession:
		| ((
				sessionId: string,
		  ) => Effect.Effect<OpenCodeAPI | undefined, Error, Scope.Scope>)
		| undefined;
	private readonly pendingTurns = new Map<
		string,
		{
			readonly deferred: Deferred.Deferred<TurnResult, Error>;
			inFlight: number;
		}
	>();
	/** Sends handed to OpenCode whose user echo is not yet seen, in handoff
	 *  order. OpenCode picks its own message ids, so echoes match by order. */
	private readonly unechoedInputs = new Map<string, string[]>();
	/** Echo message id to send, so a retried translation tags the same send. */
	private readonly echoInputIds = new Map<string, string>();

	constructor(options: OpenCodeProviderInstanceOptions) {
		this.client = options.client;
		this.workspaceRoot = options.workspaceRoot;
		this.clientForSession = options.clientForSession;
	}

	/** The send a new user message echo belongs to: the oldest unechoed one. */
	inputIdForUserEcho(sessionId: string, messageId: string): string | undefined {
		const tagged = this.echoInputIds.get(messageId);
		if (tagged) return tagged;
		const inputId = this.unechoedInputs.get(sessionId)?.shift();
		if (inputId) this.echoInputIds.set(messageId, inputId);
		return inputId;
	}

	private forgetInput(sessionId: string, inputId: string): void {
		const queue = this.unechoedInputs.get(sessionId) ?? [];
		const remaining = queue.filter((id) => id !== inputId);
		if (remaining.length > 0) this.unechoedInputs.set(sessionId, remaining);
		else this.unechoedInputs.delete(sessionId);
		for (const [messageId, id] of this.echoInputIds) {
			if (id === inputId) this.echoInputIds.delete(messageId);
		}
	}

	/**
	 * Resolve the client that owns this session: the named instance's client
	 * when the session is bound to one, otherwise the project-default client.
	 */
	private resolveClientEffect(
		sessionId: string,
	): Effect.Effect<OpenCodeAPI, Error, Scope.Scope> {
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

	sendTurnEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ProviderInstanceFailure> {
		return this.sendTurnLocalEffect(input).pipe(
			Effect.mapError((cause) => this.providerFailure("sendTurn", cause)),
		);
	}

	private sendTurnLocalEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, Error> {
		const {
			sessionId,
			prompt,
			model,
			images,
			agent,
			variant,
			abortSignal,
			extraFolders,
		} = input;

		const promptOptions: PromptOptions = {
			text: prompt,
			...(extraFolders.length > 0
				? {
						system: `Additional project folders available for reading and editing:\n${extraFolders.map((folder) => `- ${folder}`).join("\n")}`,
					}
				: {}),
			...(model?.providerId && model?.modelId
				? { model: { providerID: model.providerId, modelID: model.modelId } }
				: {}),
			...(images && images.length > 0 ? { images: [...images] } : {}),
			...(input.permissionMode === "plan" && !input.sideThread
				? { agent: "plan" }
				: agent
					? { agent }
					: {}),
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

			let pendingTurn = this.pendingTurns.get(sessionId);
			if (pendingTurn) {
				pendingTurn.inFlight += 1;
			} else {
				const deferred = yield* Deferred.make<TurnResult, Error>();
				pendingTurn = { deferred, inFlight: 1 };
				this.pendingTurns.set(sessionId, pendingTurn);
			}

			const onAbort = () => {
				log.info(`Turn aborted for session ${sessionId}`);
				client.session.abort(sessionId).catch((err) => {
					log.warn(`Failed to abort session ${sessionId}: ${err}`);
				});
			};
			abortSignal.addEventListener("abort", onAbort, { once: true });

			const cleanup = Effect.sync(() => {
				abortSignal.removeEventListener("abort", onAbort);
				this.forgetInput(sessionId, input.inputId);
				pendingTurn.inFlight -= 1;
				if (
					pendingTurn.inFlight === 0 &&
					this.pendingTurns.get(sessionId) === pendingTurn
				) {
					this.pendingTurns.delete(sessionId);
				}
			});

			return yield* Effect.gen(this, function* () {
				if (abortSignal.aborted) return interruptedTurnResult();

				const promptResult = yield* Effect.either(
					Effect.tryPromise({
						try: async () => {
							const session = await client.session.get(sessionId);
							const current = new Map<
								string,
								PermissionRuleset[number]["action"]
							>();
							for (const rule of session.permission ?? []) {
								// Leave catch-alls untouched when reconciling folder rules.
								if (
									rule.permission === "external_directory" &&
									rule.pattern !== "*"
								) {
									current.set(rule.pattern, rule.action);
								}
							}
							const desired = new Set<string>();
							for (const folder of extraFolders) {
								let directory: string;
								try {
									directory = realpathSync(folder).replaceAll("\\", "/");
								} catch {
									// A folder can disappear after launch-folder resolution.
									continue;
								}
								// Permission wildcards cannot escape a literal * or ?.
								if (/[?*]/.test(directory)) continue;
								desired.add(join(directory, "*").replaceAll("\\", "/"));
							}
							// Updates append rules, so unchanged patterns need no patch.
							const permission: PermissionRuleset = [];
							for (const [pattern, action] of current) {
								if (action === "allow" && !desired.has(pattern)) {
									permission.push({
										permission: "external_directory",
										pattern,
										action: "ask",
									});
								}
							}
							for (const pattern of desired) {
								if (current.get(pattern) !== "allow") {
									permission.push({
										permission: "external_directory",
										pattern,
										action: "allow",
									});
								}
							}
							if (permission.length > 0) {
								await client.session.update(sessionId, { permission });
							}
							if (!abortSignal.aborted) {
								const queue = this.unechoedInputs.get(sessionId) ?? [];
								queue.push(input.inputId);
								this.unechoedInputs.set(sessionId, queue);
								await client.session.prompt(sessionId, promptOptions);
							}
						},
						catch: (cause) => cause,
					}),
				);
				if (promptResult._tag === "Left") {
					const cause = promptResult.left;
					const baseMessage =
						cause instanceof Error ? cause.message : String(cause);
					// Migration guard: a session bound to a named
					// OpenCode instance BEFORE per-instance routing physically
					// lives on the project-default server, so the named server
					// 404s the prompt. Surface that clearly instead of silently
					// re-routing to the default server.
					const message =
						cause instanceof OpenCodeApiError &&
						cause.responseStatus === 404 &&
						client.getBaseUrl() !== this.client.getBaseUrl()
							? `${baseMessage} — this session does not exist on its bound OpenCode instance (it may predate named-instance routing); create a new session on that instance`
							: baseMessage;
					log.error(`sendTurn failed for session ${sessionId}: ${message}`);
					return sendFailedTurnResult(message);
				}

				if (abortSignal.aborted) return interruptedTurnResult();
				return yield* Deferred.await(pendingTurn.deferred);
			}).pipe(Effect.ensuring(cleanup));
			// The client stays valid for the whole turn, abort included.
		}).pipe(Effect.scoped);
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
		const pendingTurn = this.pendingTurns.get(sessionId);
		if (pendingTurn && this.pendingTurns.get(sessionId) === pendingTurn) {
			this.pendingTurns.delete(sessionId);
			// SSE callbacks are synchronous; complete the Effect Deferred directly
			// instead of adding an app-internal runtime bridge.
			Deferred.unsafeDone(pendingTurn.deferred, Effect.succeed(result));
		} else {
			log.debug(
				`notifyTurnCompleted: no pending turn for session ${sessionId} -- may have already completed`,
			);
		}
	}

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
			Effect.scoped,
		);
	}

	/** Appends the Side Thread rules for `mode`; callers gate on Side Threads. */
	setPermissionModeEffect(
		sessionId: string,
		mode: SessionPermissionMode,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.resolveClientEffect(sessionId).pipe(
			Effect.flatMap((client) =>
				Effect.tryPromise({
					try: () =>
						client.session.update(sessionId, {
							permission: sideThreadPermissionRules(mode),
						}),
					catch: (cause) => cause,
				}),
			),
			Effect.mapError((cause) =>
				this.providerFailure("setPermissionMode", cause),
			),
			Effect.asVoid,
			Effect.scoped,
		);
	}

	resolvePermissionEffect(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.resolveClientEffect(sessionId).pipe(
			Effect.flatMap((client) =>
				Effect.tryPromise({
					try: async () => {
						if (decision === "always") {
							// OpenCode's "always" approvals override rules in other sessions.
							const request = (
								await client.permission.list(this.workspaceRoot)
							).find((pending) => pending.id === requestId);
							if (request?.always?.length) {
								await client.session.update(sessionId, {
									permission: request.always.map((pattern) => ({
										permission: request.permission,
										pattern,
										action: "allow",
									})),
								});
							}
						}
						await client.permission.reply(
							sessionId,
							requestId,
							decision === "always" ? "once" : decision,
						);
					},
					catch: (cause) => cause,
				}),
			),
			Effect.mapError((cause) =>
				this.providerFailure("resolvePermission", cause),
			),
			Effect.asVoid,
			Effect.scoped,
		);
	}

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
			Effect.scoped,
		);
	}

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
		const pendingTurn = this.pendingTurns.get(sessionId);
		if (pendingTurn && this.pendingTurns.get(sessionId) === pendingTurn) {
			this.pendingTurns.delete(sessionId);
			Deferred.unsafeDone(
				pendingTurn.deferred,
				Effect.fail(new Error("Session ended (reload)")),
			);
		}
	}

	shutdownEffect(): Effect.Effect<void> {
		return Effect.sync(() => {
			log.info("OpenCodeProviderInstance shutting down");

			for (const [sessionId, pendingTurn] of this.pendingTurns) {
				if (this.pendingTurns.get(sessionId) !== pendingTurn) continue;
				this.pendingTurns.delete(sessionId);
				Deferred.unsafeDone(
					pendingTurn.deferred,
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
	capabilities: PROVIDER_SESSION_CAPABILITIES.opencode,
	create: (options) => Effect.sync(() => new OpenCodeProviderInstance(options)),
};

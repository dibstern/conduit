// src/lib/provider/opencode-provider-instance.ts
// Wraps the existing OpenCodeClient REST API behind the ProviderInstance
// interface. Translates OpenCode SSE events into canonical events via EventSink.

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Deferred, Effect, type Scope } from "effect";
import {
	type Account,
	MANAGED_OPENCODE_ACCOUNT_ID,
	type OpenCodeAccount,
} from "../contracts/account.js";
import { PROVIDER_DRIVERS } from "../contracts/provider-instance.js";
import { DEFAULT_CONFIG_DIR } from "../env.js";
import { OpenCodeApiError } from "../errors.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type {
	PermissionRuleset,
	PromptOptions,
} from "../instance/sdk-types.js";
import { createLogger } from "../logger.js";
import { createEventId } from "../persistence/events.js";
import type { SessionPermissionMode } from "../shared-types.js";
import { ProviderInstanceFailure } from "./errors.js";
import {
	inputIdFromOpenCodeMessageId,
	openCodeInputMessageId,
} from "./opencode/opencode-input-message-id.js";
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
	readonly configDir?: string;
	readonly clientForAccount?: (
		account: OpenCodeAccount,
		directory?: string,
	) => Effect.Effect<OpenCodeAPI, Error, Scope.Scope>;
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
	/** Authoritative binding for diagnostics; endpoint snapshots can be stale. */
	readonly instanceIdForSession?: (
		sessionId: string,
	) => Effect.Effect<string | undefined>;
	readonly hasWorktreeToolForSession?: (
		sessionId: string,
		account?: OpenCodeAccount,
	) => Effect.Effect<boolean>;
}

export class OpenCodeProviderInstance implements ProviderInstance {
	readonly providerId = "opencode";

	private readonly client: OpenCodeAPI;
	private readonly workspaceRoot: string | undefined;
	private readonly configDir: string;
	private readonly clientForSession:
		| ((
				sessionId: string,
		  ) => Effect.Effect<OpenCodeAPI | undefined, Error, Scope.Scope>)
		| undefined;
	private readonly instanceIdForSession: OpenCodeProviderInstanceOptions["instanceIdForSession"];
	private readonly clientForAccount: OpenCodeProviderInstanceOptions["clientForAccount"];
	private readonly hasWorktreeToolForSession: OpenCodeProviderInstanceOptions["hasWorktreeToolForSession"];
	private readonly pendingTurns = new Map<
		string,
		{
			readonly deferred: Deferred.Deferred<TurnResult, Error>;
			inFlight: number;
		}
	>();
	/** Sends whose user echo is not yet seen, in handoff order. Compaction and
	 *  legacy echoes can still carry an ID that OpenCode chose. */
	private readonly unechoedInputs = new Map<string, string[]>();
	/** Echo message id to send, so a retried translation tags the same send. */
	private readonly echoInputIds = new Map<string, string>();

	constructor(options: OpenCodeProviderInstanceOptions) {
		this.client = options.client;
		this.workspaceRoot = options.workspaceRoot;
		this.configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
		this.clientForSession = options.clientForSession;
		this.clientForAccount = options.clientForAccount;
		this.instanceIdForSession = options.instanceIdForSession;
		this.hasWorktreeToolForSession = options.hasWorktreeToolForSession;
	}

	/** Match reserved IDs exactly; legacy provider IDs retain their FIFO fallback. */
	inputIdForUserEcho(sessionId: string, messageId: string): string | undefined {
		const tagged = this.echoInputIds.get(messageId);
		if (tagged) return tagged;
		const queue = this.unechoedInputs.get(sessionId) ?? [];
		const reserved = inputIdFromOpenCodeMessageId(messageId);
		const index = reserved === undefined ? 0 : queue.indexOf(reserved);
		const inputId = index < 0 ? undefined : queue.splice(index, 1)[0];
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
	 * Sends retain their admitted account. Other operations resolve the session
	 * binding; legacy direct callers may use the project-default client.
	 */
	private resolveClientEffect(
		sessionId: string,
		account?: Account,
		directory?: string,
	): Effect.Effect<OpenCodeAPI, Error, Scope.Scope> {
		if (account) {
			if (!PROVIDER_DRIVERS[account.driver].runsOpenCodeServer)
				return Effect.fail(
					new Error("OpenCode turn requires an OpenCode account"),
				);
			if (this.clientForAccount && account.driver === "opencode")
				return this.clientForAccount(account, directory);
			if (account.id === MANAGED_OPENCODE_ACCOUNT_ID)
				return Effect.succeed(this.client);
			return Effect.fail(
				new Error(`OpenCode account "${account.id}" has no client route`),
			);
		}
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

	generateTextEffect(
		input: Parameters<ProviderInstance["generateTextEffect"]>[0],
	): Effect.Effect<string, ProviderInstanceFailure> {
		const route = this.clientForAccount;
		const scratchRoot = join(this.configDir, "text-generation");
		return Effect.gen(function* () {
			const account =
				input.account.driver === "opencode" ? input.account : undefined;
			if (!account || !route)
				return yield* Effect.fail(
					new Error(
						"OpenCode text generation requires an account-scoped client",
					),
				);
			return yield* Effect.acquireUseRelease(
				Effect.tryPromise(async () => {
					await mkdir(scratchRoot, { recursive: true });
					return mkdtemp(join(scratchRoot, "run-"));
				}),
				(cwd) =>
					Effect.scoped(
						Effect.gen(function* () {
							// Never borrow a project client: it would import its instructions and
							// publish the scratch session through that project's subscriptions.
							const client = yield* route(account, cwd);
							yield* Effect.gen(function* () {
								if (
									!["localhost", "127.0.0.1", "[::1]"].includes(
										new URL(client.getBaseUrl()).hostname,
									)
								)
									return yield* Effect.fail(
										new Error(
											"OpenCode text isolation requires a local account server",
										),
									);
								const config = yield* Effect.tryPromise(() =>
									client.config.get(),
								);
								const paths = yield* Effect.tryPromise(() => client.app.path());
								// The API has no per-prompt isolation flag. Refuse inherited
								// sources rather than mutating the account server's configuration.
								for (const key of [
									"plugin",
									"instructions",
									"mcp",
									"agent",
									"agents",
								])
									if (config[key] && Object.keys(config[key]).length > 0)
										return yield* Effect.fail(
											new Error(
												`OpenCode text isolation refuses configured ${key}`,
											),
										);
								for (let directory = cwd; ; directory = dirname(directory)) {
									const entries = yield* Effect.tryPromise(() =>
										readdir(directory),
									);
									if (
										["AGENTS.md", "CLAUDE.md", "CONTEXT.md", ".opencode"].some(
											(name) => entries.includes(name),
										)
									)
										return yield* Effect.fail(
											new Error(
												`OpenCode text isolation refuses instruction/config sources in ${directory}`,
											),
										);
									if (directory === dirname(directory)) break;
								}
								// OpenCode also discovers plugins outside config.plugin.
								for (const name of ["plugin", "plugins"]) {
									const entries = yield* Effect.tryPromise(() =>
										readdir(join(paths.config, name)).catch(
											(cause: unknown) => {
												if (
													cause instanceof Error &&
													"code" in cause &&
													cause.code === "ENOENT"
												)
													return [];
												throw cause;
											},
										),
									);
									if (entries.length > 0)
										return yield* Effect.fail(
											new Error(
												"OpenCode text isolation refuses global plugins",
											),
										);
								}
							});
							const agents = yield* Effect.tryPromise(() =>
								client.app.agents(),
							);
							if (!agents.some((agent) => agent.id === "title"))
								return yield* Effect.fail(
									new Error("OpenCode title agent is unavailable"),
								);
							let variant = input.effort;
							if (!variant) {
								const catalog = yield* Effect.tryPromise(() =>
									client.provider.list(),
								);
								const variants =
									catalog.providers
										.find((provider) => provider.id === input.model.providerId)
										?.models?.find((model) => model.id === input.model.modelId)
										?.variants ?? {};
								variant =
									["none", "minimal", "min", "low"].find(
										(value) => value in variants,
									) ??
									Object.keys(variants)[0] ??
									"";
							}
							return yield* Effect.acquireUseRelease(
								Effect.sync(() => `ses_${randomUUID().replaceAll("-", "")}`),
								(sessionId) =>
									Effect.gen(function* () {
										// Reserve before I/O so even a lost create reply has a cleanup id.
										yield* Effect.tryPromise(() =>
											client.session.create({
												id: sessionId,
												directory: cwd,
												title: "Conduit ephemeral text generation",
												permission: [
													{ permission: "*", pattern: "*", action: "deny" },
												],
											}),
										).pipe(Effect.uninterruptible);
										const reply = yield* Effect.tryPromise((signal) =>
											client.session.promptText(sessionId, {
												directory: cwd,
												model: {
													providerID: input.model.providerId,
													modelID: input.model.modelId,
												},
												variant,
												agent: "title",
												system: input.instructions,
												text: input.prompt,
												signal,
											}),
										);
										const text = reply.parts
											.filter((part) => part.type === "text")
											.map((part) => part["text"])
											.join("");
										if (
											reply.info.role !== "assistant" ||
											reply.info.error ||
											reply.info.finish !== "stop" ||
											!text.trim() ||
											reply.parts.some((part) => part.type === "tool")
										)
											return yield* Effect.fail(
												new Error(
													"OpenCode text generation returned an incomplete or failed reply",
												),
											);
										return text;
									}),
								(sessionId) =>
									Effect.gen(function* () {
										const aborted = yield* Effect.result(
											Effect.tryPromise(() =>
												client.session.abort(sessionId),
											).pipe(
												Effect.catchIf(
													(cause) =>
														cause.cause instanceof OpenCodeApiError &&
														cause.cause.responseStatus === 404,
													() => Effect.void,
												),
											),
										);
										yield* Effect.tryPromise(() =>
											client.session.delete(sessionId),
										).pipe(
											Effect.catchIf(
												(cause) =>
													cause.cause instanceof OpenCodeApiError &&
													cause.cause.responseStatus === 404,
												() => Effect.void,
											),
										);
										yield* Effect.fromResult(aborted);
									}),
							);
						}),
					),
				(cwd) =>
					Effect.tryPromise(() => rm(cwd, { recursive: true, force: true })),
			);
		}).pipe(
			Effect.mapError((cause) => this.providerFailure("generateText", cause)),
		);
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
		const isCompaction = prompt.trim() === "/compact";
		const compactionEvent = {
			type: "session.compaction" as const,
			providerId: this.providerId,
			sessionId,
			providerRefs: { providerSessionId: sessionId },
			rawSource: { kind: "opencode.command", endpoint: "session.summarize" },
		};

		const promptOptions: PromptOptions = {
			text: prompt,
			...(!isCompaction
				? { messageId: openCodeInputMessageId(input.inputId) }
				: {}),
			directory: input.workspaceRoot,
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

		return Effect.gen({ self: this }, function* () {
			// Resolve the owning client first: a session bound to a NAMED
			// OpenCode instance must be prompted on THAT instance's server. A
			// resolution failure (unknown/unconfigured instance) becomes a clean
			// send failure — never a hang or a silent fall-through to the
			// default server.
			const clientResult = yield* Effect.result(
				this.resolveClientEffect(sessionId, input.account, input.workspaceRoot),
			);
			if (clientResult._tag === "Failure") {
				const message = clientResult.failure.message;
				log.error(
					`sendTurn client resolution failed for session ${sessionId}: ${message}`,
				);
				return sendFailedTurnResult(message);
			}
			const client = clientResult.success;
			if (
				!isCompaction &&
				this.hasWorktreeToolForSession &&
				(yield* this.hasWorktreeToolForSession(
					sessionId,
					input.account?.driver === "opencode" ? input.account : undefined,
				))
			) {
				promptOptions.system = [
					promptOptions.system,
					"To work in another git worktree, call conduit_use_worktree with its path instead of using cd.",
				]
					.filter(Boolean)
					.join("\n");
			}

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

			return yield* Effect.gen({ self: this }, function* () {
				if (abortSignal.aborted) return interruptedTurnResult();
				if (isCompaction) {
					yield* input.eventSink.push({
						...compactionEvent,
						eventId: createEventId(),
						createdAt: Date.now(),
						data: {
							sessionId,
							state: "started",
							detail: "Compacting conversation…",
						},
					});
				}

				const promptResult = yield* Effect.result(
					Effect.tryPromise({
						try: async () => {
							if (isCompaction) {
								if (!abortSignal.aborted) {
									const compactModel = promptOptions.model;
									if (!compactModel)
										throw this.providerFailure(
											"summarize",
											"A session model pick is required before compacting.",
										);
									if (abortSignal.aborted) return;
									const queue = this.unechoedInputs.get(sessionId) ?? [];
									queue.push(input.inputId);
									this.unechoedInputs.set(sessionId, queue);
									await client.session.summarize(sessionId, compactModel);
								}
								return;
							}
							const session = await client.session.get(sessionId);
							// Existing sessions use their stored directory, ignoring prompt cwd.
							if (
								session.directory &&
								session.directory !== input.workspaceRoot
							)
								await client.session.move(sessionId, input.workspaceRoot);
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
				if (promptResult._tag === "Failure") {
					const cause = promptResult.failure;
					const baseMessage =
						cause instanceof Error ? cause.message : String(cause);
					const boundInstanceId =
						input.account?.id ??
						(cause instanceof OpenCodeApiError &&
						cause.responseStatus === 404 &&
						this.instanceIdForSession
							? yield* this.instanceIdForSession(sessionId)
							: undefined);
					// Migration guard: a session bound to a named
					// OpenCode instance BEFORE per-instance routing physically
					// lives on the project-default server, so the named server
					// 404s the prompt. Surface that clearly instead of silently
					// re-routing to the default server.
					const message =
						cause instanceof OpenCodeApiError &&
						cause.responseStatus === 404 &&
						boundInstanceId !== undefined &&
						boundInstanceId !== MANAGED_OPENCODE_ACCOUNT_ID
							? `${baseMessage} — this session does not exist on its bound OpenCode instance (it may predate named-instance routing); create a new session on that instance`
							: baseMessage;
					log.error(`sendTurn failed for session ${sessionId}: ${message}`);
					if (isCompaction && !abortSignal.aborted) {
						yield* input.eventSink.push({
							...compactionEvent,
							eventId: createEventId(),
							createdAt: Date.now(),
							data: {
								sessionId,
								state: "failed",
								detail: `Compaction failed: ${message}`,
							},
						});
					}
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
			Deferred.doneUnsafe(pendingTurn.deferred, Effect.succeed(result));
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
		providerProcessId?: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.resolveClientEffect(sessionId).pipe(
			Effect.flatMap((client) =>
				providerProcessId && client.promptProcessId !== providerProcessId
					? Effect.fail(
							"The provider process that asked this prompt is no longer running.",
						)
					: Effect.tryPromise({
							try: async () => {
								if (decision === "always") {
									// OpenCode's "always" approvals override rules in other sessions.
									const session = await client.session.get(sessionId);
									const request = (
										await client.permission.list(
											session.directory || this.workspaceRoot,
										)
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
					try: async () => {
						const session = await client.session.get(sessionId);
						await client.question.reply(
							requestId,
							answerArrays,
							session.directory || this.workspaceRoot,
						);
					},
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
			Deferred.doneUnsafe(
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
				Deferred.doneUnsafe(
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
	capabilities: PROVIDER_DRIVERS.opencode.sessionCapabilities,
	create: (options) => Effect.sync(() => new OpenCodeProviderInstance(options)),
};

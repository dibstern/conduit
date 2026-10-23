// src/lib/provider/opencode-provider-instance.ts
// Wraps the existing OpenCodeClient REST API behind the ProviderInstance
// interface. Translates OpenCode SSE events into canonical events via EventSink.

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { Effect, type Scope } from "effect";
import {
	type Account,
	MANAGED_OPENCODE_ACCOUNT_ID,
	type OpenCodeAccount,
} from "../contracts/account.js";
import { PROVIDER_DRIVERS } from "../contracts/provider-instance.js";
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
import { openCodeTextServerEffect } from "./opencode-text-server.js";
import type {
	CommandInfo,
	ModelInfo,
	PermissionDecision,
	ProviderCall,
	ProviderCapabilities,
	ProviderControlContext,
	ProviderDriver,
	ProviderInstance,
	ResolvedSendTurnInput,
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

function sendFailure(message: string) {
	return Object.assign(new Error(message), {
		code: "SEND_FAILED",
		retryable: false,
	});
}

export interface OpenCodeProviderInstanceOptions {
	readonly configDir?: string;
	readonly clientForAccount?: (
		account: OpenCodeAccount,
		directory?: string,
	) => Effect.Effect<OpenCodeAPI, Error, Scope.Scope>;
	/**
	 * Resolve the scoped API client for the OpenCode instance that owns a
	 * session for callers without a ProviderCall (OpenCode Instances `use`).
	 * Missing or unreachable routes fail without fallback.
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
	readonly userMessageIdForInput = openCodeInputMessageId;

	private readonly clientForSession:
		| ((
				sessionId: string,
		  ) => Effect.Effect<OpenCodeAPI | undefined, Error, Scope.Scope>)
		| undefined;
	private readonly instanceIdForSession: OpenCodeProviderInstanceOptions["instanceIdForSession"];
	private readonly clientForAccount: OpenCodeProviderInstanceOptions["clientForAccount"];
	private readonly hasWorktreeToolForSession: OpenCodeProviderInstanceOptions["hasWorktreeToolForSession"];
	private readonly compactions = new Map<
		string,
		Array<{ inputId: string; messageId?: string }>
	>();

	constructor(options: OpenCodeProviderInstanceOptions) {
		this.clientForSession = options.clientForSession;
		this.clientForAccount = options.clientForAccount;
		this.instanceIdForSession = options.instanceIdForSession;
		this.hasWorktreeToolForSession = options.hasWorktreeToolForSession;
	}

	/** Summarize alone cannot reserve its native user message identity. */
	inputIdForUserEcho(
		sessionId: string,
		messageId: string,
		compaction = false,
	): string | undefined {
		const exact = inputIdFromOpenCodeMessageId(messageId);
		if (exact || !compaction) return exact;
		const calls = this.compactions.get(sessionId);
		const pending =
			calls?.find((call) => call.messageId === messageId) ??
			calls?.find((call) => call.messageId === undefined);
		if (!pending) return undefined;
		pending.messageId = messageId;
		return pending.inputId;
	}

	/**
	 * Sends retain their admitted account. Other operations resolve the session binding.
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
			return Effect.fail(
				new Error(`OpenCode account "${account.id}" has no client route`),
			);
		}
		const resolve = this.clientForSession;
		return (resolve ? resolve(sessionId) : Effect.succeed(undefined)).pipe(
			Effect.flatMap((client) => {
				return client
					? Effect.succeed(client)
					: Effect.fail(
							new Error(`OpenCode session "${sessionId}" has no client route`),
						);
			}),
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

	/** Account-bound calls must borrow a scoped client, never the default client. */
	private resolveScopedClientEffect(
		sessionId: string,
		account?: Account,
		directory?: string,
	): Effect.Effect<OpenCodeAPI, Error, Scope.Scope> {
		if (account?.driver === "opencode" && this.clientForAccount)
			return this.clientForAccount(account, directory);
		if (!account && this.clientForSession)
			return this.clientForSession(sessionId).pipe(
				Effect.flatMap((client) =>
					client
						? Effect.succeed(client)
						: Effect.fail(
								new Error(
									`OpenCode session "${sessionId}" has no client route`,
								),
							),
				),
			);
		return Effect.fail(
			new Error("OpenCode call requires an account client route"),
		);
	}

	discoverEffect(
		workspaceRoot?: string,
		account?: Account,
		_options?: { readonly refresh?: boolean },
		call?: ProviderCall,
	): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> {
		const directory = call?.workspaceRoot ?? workspaceRoot;
		const selected = call?.account ?? account;
		const client =
			selected && directory
				? this.resolveScopedClientEffect(
						call?.sessionId ?? "",
						selected,
						directory,
					)
				: Effect.fail(
						new Error("OpenCode discovery requires an account and directory"),
					);
		return client.pipe(
			Effect.flatMap((client) =>
				Effect.tryPromise({
					try: () => this.discoverCapabilities(client, directory),
					catch: (cause) => cause,
				}),
			),
			Effect.mapError((cause) => this.providerFailure("discover", cause)),
			Effect.scoped,
		);
	}

	generateTextEffect(
		input: Parameters<ProviderInstance["generateTextEffect"]>[0],
	): Effect.Effect<string, ProviderInstanceFailure> {
		const route = this.clientForAccount;
		return Effect.scoped(
			Effect.gen(function* () {
				const account =
					input.account.driver === "opencode" ? input.account : undefined;
				if (!account || !route)
					return yield* Effect.fail(
						new Error(
							"OpenCode text generation requires an account-scoped client",
						),
					);
				const accountClient = yield* route(account);
				const hostname = yield* Effect.try(
					() => new URL(accountClient.getBaseUrl()).hostname,
				);
				if (
					!account.managed &&
					hostname !== "localhost" &&
					hostname !== "[::1]" &&
					!(isIP(hostname) === 4 && hostname.startsWith("127."))
				)
					return yield* Effect.fail(
						new Error(
							"OpenCode text generation cannot reproduce logins for a non-loopback unmanaged account",
						),
					);
				const config = yield* Effect.tryPromise(() =>
					accountClient.config.get(),
				);
				const { client, cwd } = yield* openCodeTextServerEffect(
					account,
					config,
				);
				const agents = yield* Effect.tryPromise(() => client.app.agents());
				if (!agents.some((agent) => agent.id === "title"))
					return yield* Effect.fail(
						new Error("OpenCode title agent is unavailable"),
					);
				const catalog = yield* Effect.tryPromise(() => client.provider.list());
				const model = catalog.providers
					.find((provider) => provider.id === input.model.providerId)
					?.models?.find((model) => model.id === input.model.modelId);
				if (!model)
					return yield* Effect.fail(
						new Error(
							`OpenCode title model ${input.model.providerId}/${input.model.modelId} is unavailable on the isolated server`,
						),
					);
				let variant = input.effort;
				if (!variant) {
					const variants = model.variants ?? {};
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
							).pipe(Effect.timeout("5 seconds"), Effect.uninterruptible);
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
								Effect.tryPromise(() => client.session.abort(sessionId)).pipe(
									Effect.catchIf(
										(cause) =>
											cause.cause instanceof OpenCodeApiError &&
											cause.cause.responseStatus === 404,
										() => Effect.void,
									),
									Effect.timeout("2 seconds"),
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
								Effect.timeout("2 seconds"),
							);
							yield* Effect.fromResult(aborted);
						}),
				);
			}),
		).pipe(
			Effect.mapError((cause) => this.providerFailure("generateText", cause)),
		);
	}

	private async discoverCapabilities(
		client: OpenCodeAPI,
		directory?: string,
	): Promise<ProviderCapabilities> {
		const [providerResult, commandsRaw, skillsRaw] = await Promise.all([
			client.provider.list(),
			client.app.commands(),
			client.app.skills(directory),
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
		input: ResolvedSendTurnInput,
	): Effect.Effect<TurnResult, ProviderInstanceFailure> {
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
			...(images && images.length > 0
				? { images: images.map(({ dataUrl }) => dataUrl) }
				: {}),
			...(input.permissionMode === "plan" && !input.sideThread
				? { agent: "plan" }
				: agent
					? { agent }
					: {}),
			...(variant ? { variant } : {}),
		};

		let submitted = false;
		const indeterminate: TurnResult = {
			status: "indeterminate",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		};
		const recalled: TurnResult = { ...indeterminate, status: "cancelled" };
		const recall = Effect.callback<TurnResult>((resume) => {
			const onAbort = () =>
				resume(Effect.succeed(submitted ? indeterminate : recalled));
			if (abortSignal.aborted) onAbort();
			else abortSignal.addEventListener("abort", onAbort, { once: true });
			return Effect.sync(() =>
				abortSignal.removeEventListener("abort", onAbort),
			);
		});
		return Effect.gen({ self: this }, function* () {
			if (abortSignal.aborted) return recalled;
			const awaitIntake = input.awaitIntake;
			if (!awaitIntake)
				return yield* Effect.fail(
					sendFailure("OpenCode intake acknowledgement is unavailable"),
				);
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
				return yield* Effect.fail(sendFailure(message));
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

			return yield* Effect.gen({ self: this }, function* () {
				if (abortSignal.aborted) return recalled;
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
									submitted = true;
									const pending = { inputId: input.inputId };
									const calls = this.compactions.get(sessionId) ?? [];
									calls.push(pending);
									this.compactions.set(sessionId, calls);
									try {
										await client.session.summarize(sessionId, compactModel);
									} finally {
										calls.splice(calls.indexOf(pending), 1);
										if (
											calls.length === 0 &&
											this.compactions.get(sessionId) === calls
										)
											this.compactions.delete(sessionId);
									}
								}
								return;
							}
							const session = await client.session.get(sessionId);
							if (abortSignal.aborted) return;
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
								submitted = true;
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
					if (!submitted) return yield* Effect.fail(sendFailure(message));
					return indeterminate;
				}
				if (!submitted) return recalled;
				// Once submitted, only the ordinary native echo can establish intake.
				return yield* awaitIntake.pipe(
					Effect.catch(() => Effect.succeed(indeterminate)),
				);
			});
		}).pipe(
			Effect.raceFirst(recall),
			Effect.scoped,
			Effect.mapError((cause) => this.providerFailure("sendTurn", cause)),
		);
	}

	interruptTurnEffect(
		sessionId: string,
		turnIds?: readonly string[],
		call?: ProviderCall,
		_control?: ProviderControlContext,
	): Effect.Effect<void, ProviderInstanceFailure> {
		if (turnIds?.length === 0) return Effect.void;
		return this.resolveClientEffect(
			sessionId,
			call?.account,
			call?.workspaceRoot,
		).pipe(
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
		call?: ProviderCall,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.resolveClientEffect(
			sessionId,
			call?.account,
			call?.workspaceRoot,
		).pipe(
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
		call?: ProviderCall,
		_control?: ProviderControlContext,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.resolveScopedClientEffect(
			sessionId,
			call?.account,
			call?.workspaceRoot,
		).pipe(
			Effect.flatMap((client) =>
				providerProcessId && client.promptProcessId !== providerProcessId
					? Effect.fail(
							"The provider process that asked this prompt is no longer running.",
						)
					: Effect.gen(function* () {
							const session = yield* Effect.tryPromise({
								try: () => client.session.get(sessionId),
								catch: (cause) => cause,
							});
							if (!session.directory)
								return yield* Effect.fail(
									new Error(
										`OpenCode session "${sessionId}" has no stored directory`,
									),
								);
							yield* Effect.tryPromise({
								try: async () => {
									if (decision === "always") {
										// OpenCode's "always" approvals override rules in other sessions.
										const request = (
											await client.permission.list(session.directory)
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
										session.directory,
									);
								},
								catch: (cause) => cause,
							});
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
		call?: ProviderCall,
		_control?: ProviderControlContext,
	): Effect.Effect<void, ProviderInstanceFailure> {
		const answerArrays = Object.values(answers).map((v) =>
			Array.isArray(v) ? v.map(String) : [String(v)],
		);
		return this.resolveScopedClientEffect(
			sessionId,
			call?.account,
			call?.workspaceRoot,
		).pipe(
			Effect.flatMap((client) =>
				Effect.gen(function* () {
					const session = yield* Effect.tryPromise({
						try: () => client.session.get(sessionId),
						catch: (cause) => cause,
					});
					if (!session.directory)
						return yield* Effect.fail(
							new Error(
								`OpenCode session "${sessionId}" has no stored directory`,
							),
						);
					yield* Effect.tryPromise({
						try: async () => {
							await client.question.reply(
								requestId,
								answerArrays,
								session.directory,
							);
						},
						catch: (cause) => cause,
					});
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
		_sessionId: string,
		_call?: ProviderCall,
		_control?: ProviderControlContext,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return Effect.void;
	}

	shutdownEffect(): Effect.Effect<void> {
		return Effect.sync(() => {
			log.info("OpenCodeProviderInstance shutting down");
		});
	}
}

export const OpenCodeDriver: ProviderDriver<OpenCodeProviderInstanceOptions> = {
	providerId: "opencode",
	capabilities: PROVIDER_DRIVERS.opencode.sessionCapabilities,
	create: (options) => Effect.sync(() => new OpenCodeProviderInstance(options)),
};

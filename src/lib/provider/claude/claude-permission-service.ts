import { Deferred, Effect, Fiber } from "effect";
import { isRecord } from "../../utils.js";
import {
	type ClaudeAdapterError,
	ClaudeRuntimeError,
} from "../event-sink-errors.js";
import type {
	EventSink,
	PermissionDecision,
	PermissionResponse,
	QuestionRequest,
} from "../types.js";
import type {
	CanUseTool,
	ClaudeSessionContext,
	PendingApproval,
	PermissionResult,
	PermissionUpdate,
} from "./types.js";

type CanUseToolOptions = Parameters<CanUseTool>[2];

export interface ClaudePermissionServiceDeps {
	readonly sink?: EventSink;
}

function toSdkPermissionUpdates(
	updates: PermissionResponse["permissionUpdates"],
): PermissionUpdate[] | undefined {
	if (updates == null || updates.length === 0) return undefined;
	return updates.map((update): PermissionUpdate => {
		switch (update.type) {
			case "addRules":
			case "replaceRules":
			case "removeRules":
				return {
					...update,
					rules: update.rules.map((rule) => ({
						toolName: rule.toolName,
						...(rule.ruleContent != null
							? { ruleContent: rule.ruleContent }
							: {}),
					})),
				};
			case "addDirectories":
			case "removeDirectories":
				return {
					...update,
					directories: [...update.directories],
				};
			case "setMode":
				return { ...update };
		}
		return update;
	});
}

/**
 * The SDK asks for `ExitPlanMode` through the ordinary permission callback, so
 * conduit's permission card is already the plan-approval UI. But approving it
 * is not merely "run the tool" -- it is the moment the session leaves plan
 * mode, and that only happens if a `setMode` rides back on the allow. Without
 * one the SDK stays read-only and Claude keeps planning against a plan the
 * user just accepted.
 *
 * Conduit's own fallback is `default` ("ask"), not `acceptEdits`: approving a
 * plan is approving the plan, not pre-approving every edit it implies. The
 * SDK's suggestion wins when it has one, since it knows where it wants the
 * session to land.
 */
const EXIT_PLAN_MODE_TOOL = "ExitPlanMode";

function withPlanModeExit(
	toolName: string,
	suggestions: CanUseToolOptions["suggestions"],
	chosen: PermissionUpdate[] | undefined,
): PermissionUpdate[] | undefined {
	if (toolName !== EXIT_PLAN_MODE_TOOL) return chosen;
	const updates = chosen ?? [];
	// A mode the user explicitly picked outranks both.
	if (updates.some((update) => update.type === "setMode")) return updates;
	const suggested = suggestions?.find(
		(update) => update.type === "setMode" && update.mode !== "plan",
	);
	return [
		...updates,
		suggested ?? {
			type: "setMode",
			mode: "default",
			destination: "session",
		},
	];
}

function toQuestionRequestQuestions(
	toolInput: Record<string, unknown>,
): QuestionRequest["questions"] {
	const rawQuestions = Array.isArray(toolInput["questions"])
		? toolInput["questions"]
		: [];
	return rawQuestions.map((raw) => {
		const question = isRecord(raw) ? raw : {};
		const rawOptions = Array.isArray(question["options"])
			? question["options"]
			: [];
		return {
			question: stringField(question["question"]),
			header: stringField(question["header"]),
			options: rawOptions.map((rawOption) => {
				const option = isRecord(rawOption) ? rawOption : {};
				return {
					label: stringField(option["label"]),
					description: stringField(option["description"]),
				};
			}),
			multiSelect:
				question["multiSelect"] === true || question["multiple"] === true,
			custom: question["custom"] !== false,
		};
	});
}

function toClaudeQuestionAnswers(
	questions: QuestionRequest["questions"],
	answers: Record<string, unknown>,
): Record<string, string> {
	const byQuestionText: Record<string, string> = {};
	for (let i = 0; i < questions.length; i++) {
		const question = questions[i];
		if (!question) continue;
		const answer = answers[String(i)] ?? answers[question.question];
		if (typeof answer === "string" && answer.trim()) {
			byQuestionText[question.question] = answer;
		}
	}
	return byQuestionText;
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function abortSignalEffect(
	signal: AbortSignal,
): Effect.Effect<never, ClaudeRuntimeError> {
	return Effect.callback<never, ClaudeRuntimeError>((resume) => {
		if (signal.aborted) {
			resume(Effect.fail(new ClaudeRuntimeError({ message: "Aborted" })));
			return;
		}
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			resume(Effect.fail(new ClaudeRuntimeError({ message: "Aborted" })));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		return Effect.sync(() => signal.removeEventListener("abort", onAbort));
	});
}

export class ClaudePermissionService {
	constructor(private readonly deps: ClaudePermissionServiceDeps = {}) {}

	handlePermissionEffect(
		ctx: ClaudeSessionContext,
		toolName: string,
		toolInput: Record<string, unknown>,
		options: CanUseToolOptions,
	): Effect.Effect<PermissionResult, ClaudeAdapterError> {
		if (ctx.stopped)
			return Effect.succeed({
				behavior: "deny",
				message: "Claude query has closed",
			});
		const attributes = {
			providerId: "claude",
			sessionId: ctx.sessionId,
			turnId: ctx.currentTurnId ?? "unknown",
			toolName,
		};
		const effect =
			toolName === "AskUserQuestion"
				? this.handleQuestionEffect(ctx, toolInput, options)
				: this.handleToolPermissionEffect(ctx, toolName, toolInput, options);
		return effect.pipe(
			Effect.annotateLogs(attributes),
			Effect.withSpan("claude.permission", { attributes }),
		);
	}

	resolvePermission(
		ctx: ClaudeSessionContext,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, ClaudeAdapterError> {
		const pending = ctx.pendingApprovals.get(requestId);
		if (!pending) return Effect.void;
		return pending.resolve(decision);
	}

	private handleQuestionEffect(
		ctx: ClaudeSessionContext,
		toolInput: Record<string, unknown>,
		options: CanUseToolOptions,
	): Effect.Effect<PermissionResult, ClaudeAdapterError> {
		const sink = ctx.eventSink ?? this.deps.sink;
		if (!sink) {
			return Effect.succeed({
				behavior: "deny",
				message: "Question sink unavailable.",
			});
		}
		const questions = toQuestionRequestQuestions(toolInput ?? {});
		const runId = options.agentID
			? undefined
			: (ctx.toolRunIds?.get(options.toolUseID) ?? ctx.currentRunId);
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const requestId = options.requestId ?? options.toolUseID;
				const answer = yield* Deferred.make<
					Record<string, unknown>,
					ClaudeAdapterError
				>();
				ctx.pendingQuestions.set(requestId, {
					requestId,
					createdAt: new Date().toISOString(),
					resolve: (answers) =>
						Deferred.succeed(answer, answers).pipe(Effect.asVoid),
					reject: (error) =>
						Deferred.fail(
							answer,
							new ClaudeRuntimeError({ message: error.message }),
						).pipe(Effect.asVoid),
				});
				const request = yield* Effect.forkDetach(
					restore(
						Deferred.complete(
							answer,
							sink.requestQuestion({
								requestId,
								...(runId ? { runId } : {}),
								toolUseId: options.toolUseID,
								questions,
							}),
						),
					),
					{ startImmediately: true },
				);
				return yield* restore(
					Deferred.await(answer).pipe(
						Effect.map((answers) => ({
							behavior: "allow" as const,
							updatedInput: {
								...(toolInput ?? {}),
								answers: toClaudeQuestionAnswers(questions, answers),
							},
						})),
						Effect.raceFirst(
							// abortSignalEffect signals abort by failing, so map that failure.
							abortSignalEffect(options.signal).pipe(
								Effect.orElseSucceed(() => ({
									behavior: "deny" as const,
									message: "Turn interrupted",
								})),
							),
						),
					),
				).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							ctx.pendingQuestions.delete(requestId);
							request.interruptUnsafe();
						}),
					),
					Effect.catch(() =>
						Effect.succeed({
							behavior: "deny" as const,
							message: "Question request failed.",
						}),
					),
				);
			}),
		);
	}

	private handleToolPermissionEffect(
		ctx: ClaudeSessionContext,
		toolName: string,
		toolInput: Record<string, unknown>,
		options: CanUseToolOptions,
	): Effect.Effect<PermissionResult, ClaudeAdapterError> {
		return Effect.gen({ self: this }, function* () {
			const requestId = options.requestId ?? options.toolUseID;
			const runId = options.agentID
				? undefined
				: (ctx.toolRunIds?.get(options.toolUseID) ?? ctx.currentRunId);
			const createdAt = new Date().toISOString();
			const sink = ctx.eventSink ?? this.deps.sink;
			if (!sink) {
				return {
					behavior: "deny" as const,
					message: "Permission sink unavailable.",
				};
			}

			const pending: PendingApproval = {
				requestId,
				toolName,
				toolInput: toolInput ?? {},
				createdAt,
				resolve: (decision) => sink.resolvePermission(requestId, { decision }),
				reject: () => sink.resolvePermission(requestId, { decision: "reject" }),
			};
			ctx.pendingApprovals.set(requestId, pending);

			const response = yield* Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const request = yield* Effect.forkDetach(
						restore(
							sink.requestPermission({
								requestId,
								...(runId ? { runId } : {}),
								sessionId: ctx.sessionId,
								turnId: ctx.currentTurnId ?? "",
								toolName,
								toolInput: toolInput ?? {},
								providerItemId: options.toolUseID,
								...(options.suggestions != null
									? { permissionSuggestions: options.suggestions }
									: {}),
								...(options.title != null
									? { permissionTitle: options.title }
									: {}),
								...(options.displayName != null
									? { permissionDisplayName: options.displayName }
									: {}),
								...(options.description != null
									? { permissionDescription: options.description }
									: {}),
								...(options.decisionReason != null
									? { permissionReason: options.decisionReason }
									: {}),
							}),
						),
						{ startImmediately: true },
					);
					return yield* restore(
						Fiber.join(request).pipe(
							Effect.raceFirst(abortSignalEffect(options.signal)),
						),
					).pipe(Effect.ensuring(Effect.sync(() => request.interruptUnsafe())));
				}),
			).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						ctx.pendingApprovals.delete(requestId);
					}),
				),
			);

			const decision =
				response && typeof response === "object" && "decision" in response
					? (response as { decision: PermissionDecision }).decision
					: "reject";

			if (decision === "once" || decision === "always") {
				const updatedPermissions = withPlanModeExit(
					toolName,
					options.suggestions,
					toSdkPermissionUpdates(response.permissionUpdates),
				);
				return {
					behavior: "allow" as const,
					updatedInput: toolInput ?? {},
					...(updatedPermissions != null ? { updatedPermissions } : {}),
				};
			}
			return {
				behavior: "deny" as const,
				message: "User declined tool execution.",
			};
		});
	}
}

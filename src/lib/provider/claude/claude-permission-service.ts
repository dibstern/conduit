import { randomUUID } from "node:crypto";
import { Effect } from "effect";
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function abortSignalEffect(signal: AbortSignal): Effect.Effect<never, Error> {
	return Effect.async<never, Error>((resume) => {
		if (signal.aborted) {
			resume(Effect.fail(new Error("Aborted")));
			return;
		}
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			resume(Effect.fail(new Error("Aborted")));
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
	): Effect.Effect<PermissionResult, unknown> {
		if (toolName === "AskUserQuestion") {
			return this.handleQuestionEffect(ctx, toolInput, options);
		}
		return this.handleToolPermissionEffect(ctx, toolName, toolInput, options);
	}

	resolvePermission(
		ctx: ClaudeSessionContext,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, unknown> {
		const pending = ctx.pendingApprovals.get(requestId);
		if (!pending) return Effect.void;
		return pending.resolve(decision);
	}

	private handleQuestionEffect(
		ctx: ClaudeSessionContext,
		toolInput: Record<string, unknown>,
		options: CanUseToolOptions,
	): Effect.Effect<PermissionResult, unknown> {
		const sink = ctx.eventSink ?? this.deps.sink;
		if (!sink) {
			return Effect.succeed({
				behavior: "deny",
				message: "Question sink unavailable.",
			});
		}
		const questions = toQuestionRequestQuestions(toolInput ?? {});
		return sink
			.requestQuestion({
				requestId: options.toolUseID,
				toolUseId: options.toolUseID,
				questions,
			})
			.pipe(
				Effect.disconnect,
				Effect.raceFirst(Effect.disconnect(abortSignalEffect(options.signal))),
				Effect.map((answers) => ({
					behavior: "allow" as const,
					updatedInput: {
						...(toolInput ?? {}),
						answers: toClaudeQuestionAnswers(questions, answers),
					},
				})),
				Effect.catchAll(() =>
					Effect.succeed({
						behavior: "deny" as const,
						message: "Turn interrupted",
					}),
				),
			);
	}

	private handleToolPermissionEffect(
		ctx: ClaudeSessionContext,
		toolName: string,
		toolInput: Record<string, unknown>,
		options: CanUseToolOptions,
	): Effect.Effect<PermissionResult, unknown> {
		return Effect.gen(this, function* () {
			const requestId = randomUUID();
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

			const response = yield* sink
				.requestPermission({
					requestId,
					sessionId: ctx.sessionId,
					turnId: ctx.currentTurnId ?? "",
					toolName,
					toolInput: toolInput ?? {},
					providerItemId: options.toolUseID,
					...(options.suggestions != null
						? { permissionSuggestions: options.suggestions }
						: {}),
					...(options.title != null ? { permissionTitle: options.title } : {}),
					...(options.displayName != null
						? { permissionDisplayName: options.displayName }
						: {}),
					...(options.description != null
						? { permissionDescription: options.description }
						: {}),
				})
				.pipe(
					Effect.disconnect,
					Effect.raceFirst(
						Effect.disconnect(abortSignalEffect(options.signal)),
					),
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
				const updatedPermissions = toSdkPermissionUpdates(
					response.permissionUpdates,
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

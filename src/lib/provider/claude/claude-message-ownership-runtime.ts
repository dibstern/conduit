import { Duration, Effect } from "effect";
import { createLogger } from "../../logger.js";
import { ClaudeEventPersistEffectTag } from "../../persistence/effect/claude-event-persist-effect.js";
import {
	type ClaudeAdapterError,
	ClaudeBoundaryError,
	ClaudeRuntimeError,
} from "../event-sink-errors.js";
import {
	claudeTaskNotificationMetadata,
	claudeTaskProgressMetadata,
	claudeTaskStartedMetadata,
	claudeToolProgressMetadata,
} from "./claude-event-translator.js";
import type { ClaudeOwnershipDecision } from "./claude-message-ownership.js";
import type { ClaudeProviderInstanceDeps } from "./claude-provider-runtime.js";
import { claudeRuntimeEvent } from "./claude-runtime-event.js";
import {
	type ClaudeSubagentSdk,
	type ClaudeSubagentTranscriptCursor,
	commitClaudeSubagentTranscriptCursor,
	defaultClaudeSubagentSdk,
	stageSessionMessagesToEvents,
} from "./claude-subagent-materializer.js";
import type {
	ClaudeSessionContext,
	ClaudeSubagentLivePoller,
	SDKResultMessage,
	SessionMessage,
} from "./types.js";

const log = createLogger("claude-provider-runtime");
const SUBAGENT_POLL_TIMEOUT_MS = 2000;

type SubagentDeps = Pick<
	ClaudeProviderInstanceDeps,
	| "subagentSdk"
	| "materializeSubagents"
	| "ensureClaudeSubagentSession"
	| "subagentPollTimeoutMs"
>;

type EnsureSubagentSession = (
	input: Parameters<
		NonNullable<ClaudeProviderInstanceDeps["ensureClaudeSubagentSession"]>
	>[0],
) => Effect.Effect<void, ClaudeAdapterError>;

function subagentTranscript(ctx: ClaudeSessionContext, childSessionId: string) {
	const transcripts = (ctx.subagentTranscripts ??= new Map());
	const existing = transcripts.get(childSessionId);
	if (existing) return existing;
	const cursor: ClaudeSubagentTranscriptCursor = {
		messageRoles: new Map(),
		textOffsets: new Map(),
		thinkingOffsets: new Map(),
		toolStarts: new Set(),
		toolCompletions: new Set(),
	};
	const transcript = { cursor, deliveryPermit: Effect.unsafeMakeSemaphore(1) };
	transcripts.set(childSessionId, transcript);
	return transcript;
}

/** Prefer the Task's human description ("Audit auth flow") — the raw
 *  subagent type is an internal identifier (e.g. "local_agent") and reads
 *  as noise in the session sidebar. */
function claudeSubagentTitle(task?: {
	readonly description?: string;
	readonly subagentType?: string;
}): string {
	if (task?.description) return task.description;
	const subagentType = task?.subagentType;
	if (!subagentType) return "Claude Subagent";
	const first = subagentType[0]?.toUpperCase() ?? "";
	return `${first}${subagentType.slice(1)} Agent`;
}
export function detachSubagentFinalizationContext(
	ctx: ClaudeSessionContext,
): ClaudeSessionContext {
	const subagentPollers = new Map(ctx.subagentPollers ?? []);
	const finalizationCtx = {
		...ctx,
		eventSink: ctx.eventSink,
		resumeSessionId: ctx.resumeSessionId,
		lastAssistantUuid: ctx.lastAssistantUuid,
		subagentTasks: new Map(ctx.subagentTasks ?? []),
		subagentPollers,
		get stopped() {
			return ctx.stopped;
		},
	} as ClaudeSessionContext;
	(
		ctx as { subagentPollers: Map<string, ClaudeSubagentLivePoller> }
	).subagentPollers = new Map();
	return finalizationCtx;
}

function materializeSubagentsAfterResultEffect(
	materializeSubagents: ClaudeProviderInstanceDeps["materializeSubagents"],
	ctx: ClaudeSessionContext,
	result: SDKResultMessage,
): Effect.Effect<void, ClaudeAdapterError> {
	return Effect.gen(function* () {
		if (!materializeSubagents) return;
		const parentClaudeSessionId = ctx.resumeSessionId ?? result.session_id;
		if (!parentClaudeSessionId) return;

		yield* materializeSubagents({
			parentConduitSessionId: ctx.sessionId,
			parentClaudeSessionId,
			workspaceRoot: ctx.workspaceRoot,
			...(ctx.configDir !== undefined && { configDir: ctx.configDir }),
			knownTasks: ctx.subagentTasks ?? new Map(),
		});
	});
}

export function finalizeSubagentsAfterResultEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
	result: SDKResultMessage,
): Effect.Effect<void, never> {
	return Effect.gen(function* () {
		yield* finalPollAndStopSubagentsEffect(deps, ctx);
		yield* materializeSubagentsAfterResultEffect(
			deps.materializeSubagents,
			ctx,
			result,
		);
	}).pipe(
		Effect.catchAll((err) =>
			Effect.sync(() => {
				log.warn(
					`Final Claude subagent catch-up failed for ${ctx.sessionId}: ${err instanceof Error ? err.message : err}`,
				);
			}),
		),
	);
}

export function applyClaudeOwnershipDecisionEffect(
	ensureSession: EnsureSubagentSession | undefined,
	ctx: ClaudeSessionContext,
	decision: ClaudeOwnershipDecision,
	parentClaudeSessionId?: string,
): Effect.Effect<Effect.Effect<void> | undefined, ClaudeAdapterError> {
	return Effect.gen(function* () {
		if (decision.kind === "hold" || decision.kind === "drop") {
			logClaudeOwnershipDecision(ctx, decision);
			return;
		}
		const failed = (ctx.failedSubagentSessions ??= new Set());
		if (decision.kind === "route") {
			if (decision.owner.kind === "parent") return;
			const childSessionId = decision.owner.childSessionId;
			if (failed.has(childSessionId)) {
				log.warn(
					`Dropping Claude message ${decision.message.uuid} for failed child ${childSessionId}`,
				);
				return;
			}
			const sink = ctx.eventSink;
			if (!sink) return;
			const message = decision.message;
			if (message.type === "assistant" || message.type === "user") {
				const transcriptMessage: SessionMessage = {
					type: message.type,
					uuid: message.uuid ?? "",
					session_id: message.session_id ?? parentClaudeSessionId ?? "",
					message: message.message,
					parent_tool_use_id: message.parent_tool_use_id ?? null,
					parent_agent_id: null,
				};
				const { cursor, deliveryPermit } = subagentTranscript(
					ctx,
					childSessionId,
				);
				yield* deliveryPermit.withPermits(1)(
					Effect.gen(function* () {
						const stage = stageSessionMessagesToEvents({
							childSessionId,
							messages: [transcriptMessage],
							cursor,
						});
						// Reserve before pushing, but finish this delivery before a
						// poll can observe the reservation and send a completion.
						commitClaudeSubagentTranscriptCursor(cursor, stage.cursor);
						for (const event of stage.events) yield* sink.push(event);
					}),
				);
				return;
			}
			if (!decision.tool) return;
			let metadata: Record<string, unknown>;
			if (message.type === "tool_progress") {
				metadata = claudeToolProgressMetadata(message);
			} else if (message.type === "system") {
				switch (message.subtype) {
					case "task_started":
						metadata = claudeTaskStartedMetadata(message);
						break;
					case "task_progress":
						metadata = claudeTaskProgressMetadata(message);
						break;
					case "task_notification":
						metadata = claudeTaskNotificationMetadata(message);
						break;
					default:
						return;
				}
			} else return;
			yield* sink.push(
				claudeRuntimeEvent("tool.running", childSessionId, {
					messageId: decision.tool.issuingMessageId ?? "",
					partId: decision.tool.toolUseId,
					metadata,
				}),
			);
			return;
		}

		const { childSessionId, taskId, toolUseId, issuer } = decision;
		if (issuer.kind === "child" && failed.has(issuer.childSessionId)) {
			failed.add(childSessionId);
			log.warn(
				`Dropping Claude child ${childSessionId}: issuer ${issuer.childSessionId} failed`,
			);
			return;
		}
		const task = {
			toolUseId,
			...(decision.issuingMessageId
				? { parentMessageId: decision.issuingMessageId }
				: {}),
			...(decision.description ? { description: decision.description } : {}),
			...(decision.taskType ? { subagentType: decision.taskType } : {}),
		};
		const ensureClaudeSubagentSession =
			yield* resolveEnsureClaudeSubagentSessionEffect(ensureSession);
		if (ensureClaudeSubagentSession) {
			const ensured = yield* ensureClaudeSubagentSession({
				childSessionId,
				parentSessionId: ctx.sessionId,
				providerSessionId: taskId,
				title: claudeSubagentTitle(task),
			}).pipe(
				Effect.as(true),
				Effect.catchAll((err) =>
					Effect.sync(() => {
						log.warn(
							`Failed to ensure Claude subagent session for ${ctx.sessionId}/${taskId}: ${err instanceof Error ? err.message : err}`,
						);
						return false;
					}),
				),
			);
			if (!ensured) {
				failed.add(childSessionId);
				return;
			}
		}
		ctx.subagentTasks?.set(taskId, { ...task, childSessionId });

		const childLink = ctx.eventSink
			? ctx.eventSink
					.push(
						claudeRuntimeEvent(
							"tool.running",
							issuer.kind === "parent" ? ctx.sessionId : issuer.childSessionId,
							{
								messageId:
									decision.issuingMessageId ??
									(issuer.kind === "parent"
										? ctx.lastAssistantUuid
										: undefined) ??
									"",
								partId: toolUseId,
								metadata: {
									...(task?.description
										? { description: task.description }
										: {}),
									...(task?.subagentType
										? { subagentType: task.subagentType }
										: {}),
									childSessionId,
									sdkSubagentId: taskId,
									providerTaskId: taskId,
								},
							},
						),
					)
					.pipe(
						Effect.catchAll((err) =>
							Effect.sync(() => {
								log.warn(
									`Failed to push Claude subagent metadata for ${ctx.sessionId}/${taskId}: ${err instanceof Error ? err.message : err}`,
								);
							}),
						),
					)
			: undefined;
		if (issuer.kind === "child" && childLink) yield* childLink;

		if (parentClaudeSessionId) {
			const poller: ClaudeSubagentLivePoller = {
				sdkSubagentId: taskId,
				childSessionId,
				parentClaudeSessionId,
				...subagentTranscript(ctx, childSessionId),
				sessionReady: true,
				active: true,
			};
			getSubagentPollers(ctx).set(taskId, poller);
		}
		// A parent task_started may create its tool part during translation.
		// Publish its link after that route so the projector can merge it.
		return issuer.kind === "parent" ? childLink : undefined;
	});
}

function logClaudeOwnershipDecision(
	ctx: ClaudeSessionContext,
	decision: Extract<ClaudeOwnershipDecision, { kind: "hold" | "drop" }>,
): void {
	if (decision.kind === "hold") {
		log.debug(
			`Holding Claude message ${decision.message.uuid} for ${ctx.sessionId}, awaiting ${decision.awaiting}`,
		);
	} else {
		log.warn(
			`Dropping Claude message ${decision.message.uuid} for ${ctx.sessionId}: ${decision.reason}`,
		);
	}
}

export function endClaudeMessageOwnership(ctx: ClaudeSessionContext): void {
	for (const decision of ctx.messageOwnership?.decide({ kind: "end" }) ?? []) {
		if (decision.kind === "drop") logClaudeOwnershipDecision(ctx, decision);
	}
}

function getSubagentPollers(
	ctx: ClaudeSessionContext,
): Map<string, ClaudeSubagentLivePoller> {
	if (ctx.subagentPollers) return ctx.subagentPollers;
	const pollers = new Map<string, ClaudeSubagentLivePoller>();
	(
		ctx as { subagentPollers: Map<string, ClaudeSubagentLivePoller> }
	).subagentPollers = pollers;
	return pollers;
}

function resolveSubagentSdk(deps: SubagentDeps): ClaudeSubagentSdk | undefined {
	return (
		deps.subagentSdk ??
		(deps.materializeSubagents ? defaultClaudeSubagentSdk : undefined)
	);
}

function resolveEnsureClaudeSubagentSessionEffect(
	ensureClaudeSubagentSession: EnsureSubagentSession | undefined,
): Effect.Effect<EnsureSubagentSession | undefined> {
	return Effect.gen(function* () {
		if (ensureClaudeSubagentSession) {
			return ensureClaudeSubagentSession;
		}
		// Claude provider turn callbacks run outside the relay persistence context.
		const persist = yield* Effect.serviceOption(ClaudeEventPersistEffectTag);
		return persist._tag === "Some"
			? persist.value.ensureClaudeSubagentSession
			: undefined;
	});
}

function pollClaudeSubagentOnceEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
	poller: ClaudeSubagentLivePoller,
	subagentSdk: ClaudeSubagentSdk,
	options: { readonly allowInactive?: boolean } = {},
): Effect.Effect<void, ClaudeAdapterError> {
	if (!canPollSubagent(ctx, poller, options)) return Effect.void;
	return pollClaudeSubagentSnapshotEffect(
		deps,
		ctx,
		poller,
		subagentSdk,
		options,
	);
}

function pollClaudeSubagentSnapshotEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
	poller: ClaudeSubagentLivePoller,
	subagentSdk: ClaudeSubagentSdk,
	options: { readonly allowInactive?: boolean },
): Effect.Effect<void, ClaudeAdapterError> {
	return Effect.gen(function* () {
		if (!canPollSubagent(ctx, poller, options)) return;
		const messages = yield* Effect.tryPromise({
			try: () =>
				subagentSdk.getSubagentMessages(
					poller.parentClaudeSessionId,
					poller.sdkSubagentId,
					{
						dir: ctx.workspaceRoot,
						...(ctx.configDir !== undefined && { configDir: ctx.configDir }),
					},
				),
			catch: (cause) =>
				new ClaudeBoundaryError({ operation: "getSubagentMessages", cause }),
		}).pipe(
			Effect.timeoutFail({
				duration: Duration.millis(subagentPollTimeoutMs(deps)),
				onTimeout: () =>
					new ClaudeRuntimeError({
						message: `Claude subagent poll ${ctx.sessionId}/${poller.sdkSubagentId} timed out after ${subagentPollTimeoutMs(deps)}ms`,
					}),
			}),
		);
		yield* poller.deliveryPermit.withPermits(1)(
			Effect.gen(function* () {
				const sink = ctx.eventSink;
				if (!sink || !canPollSubagent(ctx, poller, options)) return;
				const stage = stageSessionMessagesToEvents({
					childSessionId: poller.childSessionId,
					messages,
					cursor: poller.cursor,
				});
				commitClaudeSubagentTranscriptCursor(poller.cursor, stage.cursor);
				for (const event of stage.events) {
					if (!canPollSubagent(ctx, poller, options)) return;
					yield* sink.push(event);
				}
			}),
		);
	});
}

function canPollSubagent(
	ctx: ClaudeSessionContext,
	poller: ClaudeSubagentLivePoller,
	options: { readonly allowInactive?: boolean },
): boolean {
	return (
		poller.sessionReady &&
		!ctx.stopped &&
		(poller.active || options.allowInactive === true)
	);
}

function subagentPollTimeoutMs(deps: SubagentDeps): number {
	return deps.subagentPollTimeoutMs ?? SUBAGENT_POLL_TIMEOUT_MS;
}

function finalPollAndStopSubagentsEffect(
	deps: SubagentDeps,
	ctx: ClaudeSessionContext,
): Effect.Effect<void, never> {
	return Effect.gen(function* () {
		const pollers = ctx.subagentPollers;
		if (!pollers || pollers.size === 0) return;
		const subagentSdk = resolveSubagentSdk(deps);
		if (!subagentSdk) {
			stopSubagentPollers(ctx);
			return;
		}

		for (const poller of pollers.values()) {
			yield* pollClaudeSubagentOnceEffect(deps, ctx, poller, subagentSdk, {
				allowInactive: true,
			}).pipe(
				Effect.catchAll((err) =>
					Effect.sync(() => {
						log.warn(
							`Final Claude subagent poll failed for ${ctx.sessionId}/${poller.sdkSubagentId}: ${err instanceof Error ? err.message : err}`,
						);
					}),
				),
			);
		}
		stopSubagentPollers(ctx);
	});
}

export function stopSubagentPollers(ctx: ClaudeSessionContext): void {
	const pollers = ctx.subagentPollers;
	if (!pollers) return;
	for (const poller of pollers.values()) {
		poller.active = false;
	}
	pollers.clear();
}

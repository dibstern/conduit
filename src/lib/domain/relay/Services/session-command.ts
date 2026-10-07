// One pipeline for every session mutation: append the canonical event, project
// it strictly, then sync upstream best-effort.
//
// Before this module each mutating method picked its own backends: rename wrote
// the event store AND OpenCode, delete wrote OpenCode only, create wrote
// OpenCode only. listSessions has always read the SQLite read model, so a
// mutation that skipped the event store simply never reached the UI — which is
// how deleted sessions reappeared in the sidebar.
//
// See docs/adr/0004-session-mutations-are-canonical-events.md.

import { SqlClient } from "@effect/sql";
import { type Cause, Data, Effect } from "effect";
import {
	loadDaemonConfig,
	resolveClaudeInstanceConfigDir,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import type { OpenCodeAPI } from "../../../instance/opencode-api.js";
import {
	type CommitAndSignalProject,
	makeCommitAndSignal,
} from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import {
	nativeThreadKey,
	ProviderStateEffectTag,
} from "../../../persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import {
	canonicalEvent,
	type EventPayloadMap,
} from "../../../persistence/events.js";
import {
	copyForkHistory,
	midTurnForkBoundary,
} from "../../../persistence/fork-history.js";
import type { SessionRow } from "../../../persistence/read-model-types.js";
import { forkClaudeTranscript } from "../../../provider/claude/claude-session-fork.js";
import { sideThreadPermissionRules } from "../../../provider/opencode-provider-instance.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import { OpenCodeSessionCreationGateTag } from "./opencode-runtime-ingress-service.js";
import { ConfigTag, LoggerTag } from "./services.js";
import { markSeen } from "./session-attention.js";
import { setPermissionMode } from "./session-overrides-state.js";

const CLAUDE_PROVIDER_ID = "claude";
const CLAUDE_SDK_PROVIDER_ID = "claude-sdk";
export const SIDE_THREAD_TITLE_MAX_LENGTH = 120;

const sideThreadTitle = (question: string) =>
	normalizeSessionTitle(question)
		.slice(0, SIDE_THREAD_TITLE_MAX_LENGTH)
		.trimEnd();

export class SessionCommandError extends Data.TaggedError(
	"SessionCommandError",
)<{
	readonly operation: string;
	readonly cause: unknown;
	readonly message?: string;
}> {}

/**
 * A session mutation, typed as the canonical event it becomes. Indexing
 * `EventPayloadMap` is what makes the parity gap unrepresentable: a mutation
 * with no `session.*` event cannot be expressed as a command, and the read
 * model is projected from those events, so it cannot drift from them either.
 */
type SessionCommandType =
	| "session.created"
	| "session.renamed"
	| "session.settled"
	| "session.unsettled"
	| "session.pinned"
	| "session.unpinned"
	| "session.snoozed"
	| "session.auto_settle_set"
	| "session.unsnoozed"
	| "session.deleted"
	| "session.provider_changed"
	| "session.forked";

export type SessionCommand = {
	[K in SessionCommandType]: {
		readonly type: K;
		readonly data: EventPayloadMap[K];
	};
}[SessionCommandType];

/**
 * Upstream sync varies for a real reason: OpenCode keeps its own session
 * registry that has to be told about mutations, and the Claude Agent SDK has no
 * such registry. Two adapters, so the seam is real rather than hypothetical.
 *
 * Sync is best-effort by contract — the local write is authoritative, so a
 * failure here is logged, never propagated.
 */
export interface SessionUpstreamAdapter {
	readonly provider: "opencode" | "claude";
	readonly sync: (
		command: SessionCommand,
	) => Effect.Effect<void, Cause.UnknownException>;
}

export interface ApplySessionCommandOptions {
	/** Join a caller's canonical commit, without publishing before that commit. */
	readonly project?: CommitAndSignalProject;
	/**
	 * Override the provider adapter while retaining the canonical
	 * append/project/sync pipeline. SessionManager uses this to fold its richer
	 * end-session and named-instance cleanup into the command seam.
	 */
	readonly upstreamAdapter?: SessionUpstreamAdapter | null;
}

export const openCodeUpstreamAdapter = (
	api: OpenCodeAPI,
): SessionUpstreamAdapter => ({
	provider: "opencode",
	sync: (command) => {
		switch (command.type) {
			case "session.deleted":
				// No retry: delete is not idempotent, and upstream cleanup is
				// best-effort.
				return Effect.tryPromise(() =>
					api.session.delete(command.data.sessionId),
				).pipe(Effect.asVoid);
			case "session.renamed":
				return Effect.tryPromise(() =>
					api.session.update(command.data.sessionId, {
						title: command.data.title,
					}),
				).pipe(Effect.asVoid);
			case "session.created":
				// Whoever created the session chose its id — upstream for
				// OpenCode-backed sessions, locally for the rest — so by the time this
				// event exists upstream already has it. Nothing to replicate.
				return Effect.void;
			case "session.settled":
			case "session.unsettled":
			case "session.pinned":
			case "session.unpinned":
			case "session.snoozed":
			case "session.auto_settle_set":
			case "session.unsnoozed":
			case "session.provider_changed":
				// Triage state belongs to Conduit and has no provider-side equivalent.
				return Effect.void;
			case "session.forked":
				// Same: the fork happened upstream first, which is where the forked
				// session's id came from. This event records its lineage locally.
				return Effect.void;
		}
	},
});

export const claudeUpstreamAdapter: SessionUpstreamAdapter = {
	provider: "claude",
	// The Claude Agent SDK has no server-side session registry to keep in step.
	sync: () => Effect.void,
};

export const isClaudeSessionRow = (
	row: SessionRow,
	configDir?: string,
): boolean =>
	row.provider === CLAUDE_SDK_PROVIDER_ID ||
	resolveProviderRoutingDriver(loadDaemonConfig(configDir), row.provider) ===
		CLAUDE_PROVIDER_ID;

/**
 * Apply a session mutation: append, project, sync.
 *
 * The local write is authoritative and strict — if the projection fails, so
 * does this effect, because a user told the session was deleted must not find
 * it still listed. Upstream sync is best-effort and cannot fail the command.
 *
 */
export const applySessionCommand = (
	command: SessionCommand,
	options: ApplySessionCommandOptions = {},
) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;
		const readQuery = yield* ReadQueryEffectTag;
		const eventStore = yield* EventStoreEffectTag;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const sql = yield* SqlClient.SqlClient;

		const { sessionId } = command.data;

		const commitAndSignal = yield* makeCommitAndSignal.pipe(
			Effect.provideService(SqlClient.SqlClient, sql),
			Effect.provideService(EventStoreEffectTag, eventStore),
			Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
		);

		const row = yield* readQuery.getSession(sessionId).pipe(
			Effect.mapError(
				(cause) =>
					new SessionCommandError({
						operation: `${command.type}.getSession`,
						cause,
					}),
			),
		);

		// session.created is the one command that does not require an existing
		// row — it is what brings the row into being, and its payload names the
		// provider. Every other command describes a change to a row that must
		// already be there: no row is not an error (it may already be gone, and
		// upstream may still hold it), there is simply nothing to record.
		// This is why forkOpenCodeSession applies session.created before any
		// session.forked can land: an UPDATE onto a row that is not there yet
		// writes nothing and reports success.
		const appendProvider =
			command.type === "session.created"
				? command.data.provider
				: row?.provider;

		if (appendProvider !== undefined) {
			const events = [
				canonicalEvent(command.type, sessionId, command.data, {
					provider: appendProvider,
					createdAt: Date.now(),
					metadata: { source: "relay" },
				}),
			];
			yield* (
				options.project
					? Effect.flatMap(eventStore.appendBatch(events), options.project)
					: commitAndSignal(events)
			).pipe(
				Effect.mapError(
					(cause) =>
						new SessionCommandError({
							operation: `${command.type}.commit`,
							cause,
						}),
				),
			);
		}

		const defaultAdapter =
			row !== undefined && isClaudeSessionRow(row, config.configDir)
				? claudeUpstreamAdapter
				: openCodeUpstreamAdapter(api);
		const adapter =
			options.upstreamAdapter === undefined
				? defaultAdapter
				: options.upstreamAdapter;

		if (adapter !== null)
			yield* adapter.sync(command).pipe(
				Effect.catchAll((cause) =>
					Effect.sync(() => {
						log.warn("Upstream session sync failed", {
							operation: command.type,
							sessionId,
							cause,
						});
					}),
				),
			);
	}).pipe(
		Effect.annotateLogs("sessionId", command.data.sessionId),
		Effect.withSpan("session.applySessionCommand", {
			attributes: { sessionId: command.data.sessionId, type: command.type },
		}),
	);

export const normalizeSessionTitle = (title?: string): string => {
	const trimmed = title?.trim();
	return trimmed ? trimmed : "Untitled";
};

/**
 * Create a session on an OpenCode server and record it locally.
 *
 * The one mutation that cannot be expressed as a command on its own: OpenCode
 * chooses the session id, and a command needs that id before it can be built.
 * So the direct `api.session.create` call lives here, next to the sync adapter,
 * and applying `session.created` is folded into the same function rather than
 * left to the caller.
 *
 * That folding is the point. A caller who creates the session upstream and
 * forgets to record it locally can make the session absent from the read model; there is no
 * longer a way to express it from outside this module.
 */
export const createOpenCodeSession = (
	title: string | undefined,
	provider: string,
) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;

		// No retry: create is not idempotent — retrying could produce duplicates.
		const session = yield* Effect.tryPromise(() =>
			api.session.create(title ? { title } : undefined),
		).pipe(
			Effect.mapError(
				(cause) =>
					new SessionCommandError({
						operation: "session.created.upstream",
						cause,
					}),
			),
		);

		yield* applySessionCommand({
			type: "session.created",
			data: {
				sessionId: session.id,
				title: normalizeSessionTitle(session.title),
				provider,
				providerSessionId: session.id,
			},
		});

		return session;
	}).pipe(
		Effect.annotateLogs("operation", "createOpenCodeSession"),
		Effect.withSpan("session.createOpenCodeSession"),
	);

/**
 * Fork a session on an OpenCode server and record the forked session locally.
 *
 * Creation's asymmetry again: OpenCode chooses the forked session's id, so the
 * direct `api.session.fork` call lives here and `session.created` is applied in
 * the same function. Before this, the forked session reached the read model
 * only if the provider event stream happened to mention it — with no parent, so
 * it surfaced as a root session in the sidebar.
 *
 * The fork keeps the parent's messages up to and including `messageId`, or all
 * of them when it is omitted. Resolve the fork point before publishing creation
 * so the first subscription row already carries it.
 */
export const forkOpenCodeSession = (
	parentSessionId: string,
	messageId?: string,
	side?: { title: string },
) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		// An explicit fork must not succeed upstream before its ordering key is
		// known. Otherwise a provider read failure creates a new legacy fallback.
		const parentHistory =
			messageId === undefined
				? undefined
				: yield* Effect.tryPromise(() =>
						api.session.messages(parentSessionId),
					).pipe(
						Effect.mapError(
							(cause) =>
								new SessionCommandError({
									operation: "session.forked.boundary",
									cause,
								}),
						),
					);
		const boundaryIndex =
			parentHistory?.findIndex((message) => message.id === messageId) ?? -1;
		const requestedBoundary = parentHistory?.[boundaryIndex];
		if (
			messageId !== undefined &&
			requestedBoundary?.time?.created === undefined
		) {
			return yield* new SessionCommandError({
				operation: "session.forked.boundary",
				cause: "OpenCode fork boundary is missing or has no creation timestamp",
			});
		}
		// The given message is kept, as Claude forks keep theirs. OpenCode copies
		// the messages before its messageID, so name the one after the boundary.
		const cutBefore = parentHistory?.[boundaryIndex + 1]?.id;

		// No retry: fork is not idempotent — retrying could produce duplicates.
		const session = yield* Effect.tryPromise(() =>
			api.session.fork(parentSessionId, {
				...(cutBefore !== undefined && { messageID: cutBefore }),
			}),
		).pipe(
			Effect.mapError(
				(cause) =>
					new SessionCommandError({
						operation: "session.forked.upstream",
						cause,
					}),
			),
		);
		const title = side
			? sideThreadTitle(side.title)
			: normalizeSessionTitle(session.title);
		if (side) {
			// OpenCode's later session.updated events must carry the same title.
			// The read-only rules land before session.created is applied.
			yield* Effect.tryPromise(() =>
				api.session.update(session.id, {
					title,
					permission: sideThreadPermissionRules("plan"),
				}),
			).pipe(
				Effect.mapError(
					(cause) =>
						new SessionCommandError({
							operation: "session.forked.title",
							cause,
							message: "Could not set the Side Thread title",
						}),
				),
			);
		}

		// A fork inherits its parent's provider. Forking is an OpenCode
		// operation, so an unreadable parent can only mean the read model is not
		// wired here at all — in which case nothing is projected anyway.
		const parent =
			readQueryOption._tag === "Some"
				? yield* readQueryOption.value
						.getSession(parentSessionId)
						.pipe(Effect.orElseSucceed(() => undefined))
				: undefined;
		// The fork's newest message is its copy of the boundary. Its id, not the
		// parent's, orders the fork's own transcript at that boundary.
		const forkTip = yield* Effect.tryPromise(() =>
			api.session.messagesPage(session.id, { limit: 1 }),
		).pipe(
			Effect.map((messages) => messages.at(-1)),
			Effect.catchAll((error) =>
				Effect.logWarning(
					`Could not determine fork point for ${session.id}: ${String(error)}`,
				).pipe(Effect.as(undefined)),
			),
		);
		let forkPointTimestamp =
			forkTip?.time?.created ?? requestedBoundary?.time?.created;

		let forkPointEvent = forkTip?.id ?? messageId;
		if (
			(forkPointEvent === undefined || forkPointTimestamp === undefined) &&
			readQueryOption._tag === "Some"
		) {
			const parentMessages =
				yield* readQueryOption.value.getSessionMessagesWithParts(
					parentSessionId,
				);
			// A lagging projection cannot replace a known provider boundary.
			const localBoundary =
				forkPointEvent === undefined
					? parentMessages.at(-1)
					: parentMessages.find((message) => message.id === forkPointEvent);
			forkPointEvent ??= localBoundary?.id;
			forkPointTimestamp ??= localBoundary?.created_at;
		}

		yield* applySessionCommand({
			type: "session.created",
			data: {
				sessionId: session.id,
				title,
				provider: parent?.provider ?? "opencode",
				parentId: parentSessionId,
				...(side ? { sideThread: true, permissionMode: "plan" as const } : {}),
				...(forkPointEvent === undefined ? {} : { forkPointEvent }),
				...(forkPointTimestamp === undefined ? {} : { forkPointTimestamp }),
				providerSessionId: session.id,
			},
		});

		return {
			...session,
			...(side ? { title } : {}),
			forkMessageId: forkPointEvent,
			forkPointTimestamp,
		};
	}).pipe(
		Effect.annotateLogs("operation", "forkOpenCodeSession"),
		Effect.withSpan("session.forkOpenCodeSession"),
	);

/** Route forks by the persisted parent provider, before contacting a runtime. */
export const forkSession = (
	parentSessionId: string,
	options?: { messageId?: string; side?: { title: string } },
) =>
	Effect.gen(function* () {
		const readOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		const config = yield* Effect.serviceOption(ConfigTag);
		const parent =
			readOption._tag === "Some"
				? yield* readOption.value.getSession(parentSessionId)
				: undefined;
		if (options?.side) {
			if (!parent) {
				return yield* new SessionCommandError({
					operation: "session.side_thread.parent_not_found",
					cause: parentSessionId,
					message: `Parent session ${parentSessionId} was not found`,
				});
			}
			if (parent.side_thread === 1) {
				return yield* new SessionCommandError({
					operation: "session.side_thread.nested",
					cause: parentSessionId,
					message: "Cannot start a Side Thread from a Side Thread",
				});
			}
		}
		const eventStore = yield* Effect.serviceOption(EventStoreEffectTag);
		// A Side Thread of a parent mid-turn forks at its last completed turn,
		// so it inherits no dangling tool call and no turn that never ends.
		const midTurn =
			options?.side &&
			options.messageId === undefined &&
			eventStore._tag === "Some"
				? midTurnForkBoundary(
						yield* eventStore.value.readAllBySession(parentSessionId),
					)
				: undefined;
		if (midTurn && midTurn.lastCompleted === undefined) {
			return yield* new SessionCommandError({
				operation: "session.side_thread.no_completed_turn",
				cause: parentSessionId,
				message:
					"This session has no completed turn yet. Wait for its first reply.",
			});
		}
		// Both providers fork up to and including this message.
		const messageId = options?.messageId ?? midTurn?.lastCompleted;
		if (
			!parent ||
			!isClaudeSessionRow(
				parent,
				config._tag === "Some" ? config.value.configDir : undefined,
			)
		) {
			const api = yield* Effect.serviceOption(OpenCodeAPITag);
			if (api._tag === "None") {
				return yield* new SessionCommandError({
					operation: "session.forked.opencode",
					cause: "OpenCode API is unavailable",
				});
			}
			const fork = forkOpenCodeSession(
				parentSessionId,
				messageId,
				options?.side,
			).pipe(Effect.provideService(OpenCodeAPITag, api.value));
			const creationGate = yield* Effect.serviceOption(
				OpenCodeSessionCreationGateTag,
			);
			const initializedFork = options?.side
				? fork.pipe(
						Effect.tap((session) => setPermissionMode(session.id, "plan")),
						Effect.uninterruptible,
					)
				: fork;
			const forked = yield* options?.side && creationGate._tag === "Some"
				? creationGate.value.withPermits(1)(initializedFork)
				: initializedFork;
			return {
				...forked,
				provider: "opencode" as const,
			};
		}
		// Claude forks through the turn holding the given message.
		const stateOption = yield* Effect.serviceOption(ProviderStateEffectTag);
		const projections = yield* Effect.serviceOption(ProjectionRunnerEffectTag);
		const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
		if (
			readOption._tag === "None" ||
			stateOption._tag === "None" ||
			eventStore._tag === "None" ||
			projections._tag === "None" ||
			sql._tag === "None"
		) {
			return yield* new SessionCommandError({
				operation: "session.forked.claude",
				cause: "Claude fork requires provider state persistence",
			});
		}
		const state = stateOption.value;
		if (config._tag === "None" || config.value.claudeSdk === undefined) {
			return yield* new SessionCommandError({
				operation: "session.forked.claude",
				cause: "Claude fork requires project SDK configuration",
			});
		}
		const claudeSdk = config.value.claudeSdk;
		const commitAndSignal = yield* makeCommitAndSignal.pipe(
			Effect.provideService(EventStoreEffectTag, eventStore.value),
			Effect.provideService(ProjectionRunnerEffectTag, projections.value),
			Effect.provideService(SqlClient.SqlClient, sql.value),
		);
		const parentThread = yield* state.nativeThread(
			parentSessionId,
			parent.provider,
		);
		const claudeConfigDir =
			parentThread?.configDir ??
			resolveClaudeInstanceConfigDir(
				loadDaemonConfig(config.value.configDir),
				parent.provider,
			) ??
			config.value.shellEnv?.(config.value.projectDir)["CLAUDE_CONFIG_DIR"];
		const providerSessionId = parentThread?.resumeSessionId;
		if (!providerSessionId) {
			return yield* new SessionCommandError({
				operation: "session.forked.claude",
				cause: "Claude parent has no SDK resume session",
				message:
					"This session has no Claude transcript yet. Send a message first.",
			});
		}
		const parentMessages =
			yield* readOption.value.getSessionMessagesWithParts(parentSessionId);
		const forkPointMessage =
			messageId === undefined
				? parentMessages.at(-1)
				: parentMessages.find((message) => message.id === messageId);
		if (!forkPointMessage) {
			return yield* new SessionCommandError({
				operation: "session.forked.claude",
				cause: "Claude fork boundary has no persisted message ordering key",
				message: `Fork point ${messageId} was not found in the session history`,
			});
		}
		const side = options?.side;
		const title = side ? sideThreadTitle(side.title) : `${parent.title} (fork)`;
		const parentEvents =
			yield* eventStore.value.readAllBySession(parentSessionId);
		if (
			messageId !== undefined &&
			!copyForkHistory(parentEvents, {
				newSessionId: parentSessionId,
				upToMessageId: messageId,
			})
		) {
			return yield* new SessionCommandError({
				operation: "session.forked.point",
				cause: `Fork point ${messageId} was not found in the session history`,
				message: `Fork point ${messageId} was not found in the session history`,
			});
		}
		const forked = yield* Effect.tryPromise({
			try: () =>
				forkClaudeTranscript(
					{
						parentSdkId: providerSessionId,
						projectDir: config.value.projectDir,
						...(claudeConfigDir !== undefined && {
							configDir: claudeConfigDir,
						}),
						title,
						...(messageId !== undefined && { messageId }),
						...(messageId !== undefined && {
							fallbackMessageIds: parentMessages
								.slice(0, parentMessages.indexOf(forkPointMessage))
								.flatMap((message) =>
									message.role === "assistant" ? [message.id] : [],
								)
								.reverse(),
						}),
					},
					claudeSdk.fork,
				),
			catch: (cause) =>
				new SessionCommandError({
					operation: "session.forked.upstream",
					cause,
					message: cause instanceof Error ? cause.message : String(cause),
				}),
		});
		const history = copyForkHistory(parentEvents, {
			newSessionId: forked.sdkSessionId,
			...(messageId !== undefined && { upToMessageId: messageId }),
		});
		const forkPointEvent = messageId ?? forkPointMessage.id;
		// Creation and the SDK resume cursor must commit before the first row
		// is announced, or a prompt could start a fresh Claude conversation.
		yield* commitAndSignal.write((project) =>
			Effect.gen(function* () {
				const stored = yield* eventStore.value.appendBatch([
					canonicalEvent(
						"session.created",
						forked.sdkSessionId,
						{
							sessionId: forked.sdkSessionId,
							title,
							provider: parent.provider,
							providerSessionId: forked.sdkSessionId,
							parentId: parentSessionId,
							...(side
								? { sideThread: true, permissionMode: "plan" as const }
								: {}),
							forkPointEvent,
							forkPointTimestamp: forkPointMessage.created_at,
							forkPointMessageId: forkPointMessage.id,
						},
						{
							provider: parent.provider,
							createdAt: Date.now(),
							metadata: { source: "relay" },
						},
					),
					...(history?.events ?? []),
				]);
				yield* project(stored);
				yield* state.saveUpdates(forked.sdkSessionId, [
					{
						key: nativeThreadKey(parent.provider),
						value: JSON.stringify({
							...(claudeConfigDir !== undefined
								? { configDir: claudeConfigDir }
								: {}),
							resumeSessionId: forked.sdkSessionId,
							firstSequence: stored[0]?.sequence ?? 0,
							deliveredThrough: stored.at(-1)?.sequence ?? 0,
						}),
					},
				]);
				// Plan applies before the row is announced, so no send can reach the
				// Side Thread first.
				if (side) yield* setPermissionMode(forked.sdkSessionId, "plan");
			}),
		);
		// The copied turns were the parent's to read, so the fork starts seen up
		// to its last imported turn end rather than with a dot. SessionAttention
		// caps at the committed turn end, so this has to follow the commit.
		yield* markSeen(forked.sdkSessionId, Number.MAX_SAFE_INTEGER).pipe(
			Effect.provideService(EventStoreEffectTag, eventStore.value),
			Effect.provideService(ProjectionRunnerEffectTag, projections.value),
			Effect.provideService(SqlClient.SqlClient, sql.value),
		);
		const now = Date.now();
		return {
			id: forked.sdkSessionId,
			title,
			time: { created: now, updated: now },
			provider: "claude" as const,
			forkMessageId: forkPointEvent,
			forkPointTimestamp: forkPointMessage.created_at,
		};
	});

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

import { randomUUID } from "node:crypto";
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
	type NativeThread,
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
import type { TurnSettings } from "../../../provider/turn-settings.js";
import type { SessionPermissionMode } from "../../../shared-types.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import { OpenCodeSessionCreationGateTag } from "./opencode-runtime-ingress-service.js";
import { ConfigTag, LoggerTag } from "./services.js";
import { markSeen } from "./session-attention.js";
import { setPermissionMode } from "./session-overrides-state.js";
import { loadServerSessionPick, sessionPickEvents } from "./session-pick.js";
import { SessionWorkspaceTag } from "./session-workspace.js";

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
	| "session.workspace_changed"
	| "session.setup_started"
	| "session.setup_output"
	| "session.setup_finished"
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
	readonly pick?: TurnSettings;
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
			case "session.workspace_changed":
			case "session.setup_started":
			case "session.setup_output":
			case "session.setup_finished":
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
				...(command.type === "session.created" && options.pick
					? sessionPickEvents(sessionId, options.pick)
					: []),
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

		const adapter =
			options.upstreamAdapter === undefined
				? row !== undefined && isClaudeSessionRow(row, config.configDir)
					? claudeUpstreamAdapter
					: openCodeUpstreamAdapter(api)
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
 * chooses the session id unless a worktree launch reserves it, and a command
 * needs that id before it can be built.
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
	pick?: TurnSettings,
	reservedSessionId?: string,
	permissionMode?: SessionPermissionMode,
) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const settings =
			pick ?? (yield* loadServerSessionPick("opencode", provider));

		const create = Effect.gen(function* () {
			// No retry: create is not idempotent — retrying could produce duplicates.
			const session = yield* Effect.tryPromise(() =>
				api.session.create({
					...(title ? { title } : {}),
					...(reservedSessionId === undefined ? {} : { id: reservedSessionId }),
				}),
			).pipe(
				Effect.mapError(
					(cause) =>
						new SessionCommandError({
							operation: "session.created.upstream",
							cause,
						}),
				),
			);

			yield* applySessionCommand(
				{
					type: "session.created",
					data: {
						sessionId: session.id,
						title: normalizeSessionTitle(session.title),
						provider,
						providerSessionId: session.id,
						...(permissionMode === undefined ? {} : { permissionMode }),
					},
				},
				{ pick: settings },
			);

			return session;
		});
		const creationGate = yield* Effect.serviceOption(
			OpenCodeSessionCreationGateTag,
		);
		return yield* creationGate._tag === "Some"
			? creationGate.value.withPermits(1)(create)
			: create;
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
 * of them when it is omitted. Resolve the boundary id before publishing creation;
 * its timestamp follows the fork's stored copy when that row is projected.
 */
export const forkOpenCodeSession = (
	parentSessionId: string,
	messageId?: string,
	side?: { title: string },
) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		const parent =
			readQueryOption._tag === "Some"
				? yield* readQueryOption.value.getSession(parentSessionId)
				: undefined;
		const pick = yield* loadServerSessionPick(
			"opencode",
			parent?.provider ?? "opencode",
			parent,
		);
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
			// The Ask rules land before session.created is applied.
			yield* Effect.tryPromise(() =>
				api.session.update(session.id, {
					title,
					permission: sideThreadPermissionRules("ask"),
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
		let forkPointEvent = forkTip?.id ?? messageId;
		if (forkPointEvent === undefined && readQueryOption._tag === "Some") {
			const parentMessages =
				yield* readQueryOption.value.getSessionMessagesWithParts(
					parentSessionId,
				);
			// A lagging projection cannot replace a known provider boundary.
			forkPointEvent = parentMessages.at(-1)?.id;
		}

		yield* applySessionCommand(
			{
				type: "session.created",
				data: {
					sessionId: session.id,
					title,
					provider: parent?.provider ?? "opencode",
					parentId: parentSessionId,
					...(side ? { sideThread: true, permissionMode: "ask" as const } : {}),
					...(forkPointEvent === undefined ? {} : { forkPointEvent }),
					providerSessionId: session.id,
				},
			},
			{ pick },
		);
		const workspace = yield* Effect.serviceOption(SessionWorkspaceTag);
		if (workspace._tag === "Some")
			yield* workspace.value.inherit(session.id, parentSessionId);
		const forkPointTimestamp =
			readQueryOption._tag === "Some"
				? (yield* readQueryOption.value.getSession(session.id))
						?.fork_point_timestamp
				: undefined;

		return {
			...session,
			...(side ? { title } : {}),
			forkMessageId: forkPointEvent,
			...(forkPointTimestamp == null ? {} : { forkPointTimestamp }),
		};
	}).pipe(
		Effect.annotateLogs("operation", "forkOpenCodeSession"),
		Effect.withSpan("session.forkOpenCodeSession"),
	);

/** Route forks by the persisted parent provider, before contacting a runtime. */
const forkSessionInWorkspace = (
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
						Effect.tap((session) => setPermissionMode(session.id, "ask")),
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
		const workspace = yield* Effect.serviceOption(SessionWorkspaceTag);
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
				message:
					messageId === undefined
						? "This session has no Claude transcript yet. Send a message first."
						: `Fork point ${messageId} was not found in the session history`,
			});
		}
		const side = options?.side;
		const title = side ? sideThreadTitle(side.title) : `${parent.title} (fork)`;
		const parentEvents =
			yield* eventStore.value.readAllBySession(parentSessionId);
		const forkPointSequence = parentEvents.find(
			(event) =>
				event.type === "message.created" &&
				event.data.messageId === forkPointMessage.id,
		)?.sequence;
		if (
			forkPointSequence === undefined ||
			(messageId !== undefined &&
				!copyForkHistory(parentEvents, {
					newSessionId: parentSessionId,
					upToMessageId: messageId,
				}))
		) {
			return yield* new SessionCommandError({
				operation: "session.forked.point",
				cause: `Fork point ${messageId} was not found in the session history`,
				message: `Fork point ${messageId} was not found in the session history`,
			});
		}
		const instanceIds = new Set([parent.provider]);
		for (const event of parentEvents) {
			if (event.type === "session.created")
				instanceIds.add(event.data.provider);
			if (event.type === "session.provider_changed") {
				instanceIds.add(event.data.oldProvider);
				instanceIds.add(event.data.newProvider);
			}
		}
		let selected: { instanceId: string; thread: NativeThread } | undefined;
		for (const instanceId of instanceIds) {
			const thread = yield* state.nativeThread(parentSessionId, instanceId);
			if (
				thread &&
				thread.firstSequence <= forkPointSequence &&
				forkPointSequence <= thread.deliveredThrough &&
				(!selected || thread.firstSequence > selected.thread.firstSequence)
			)
				selected = { instanceId, thread };
		}
		// Prefer the thread that began closest to the point when an older
		// account has since returned and received a catch-up covering that range.
		const provider = selected?.instanceId ?? parent.provider;
		const pick = yield* loadServerSessionPick("claude", provider, parent);
		const parentThread = selected?.thread;
		const claudeConfigDir =
			parentThread?.configDir ??
			resolveClaudeInstanceConfigDir(
				loadDaemonConfig(config.value.configDir),
				provider,
			) ??
			config.value.shellEnv?.(config.value.projectDir)["CLAUDE_CONFIG_DIR"];
		// The next launch workspace can differ from the native transcript's folder.
		// Find the SDK id across the selected account's project directories.
		const forked = parentThread
			? yield* Effect.tryPromise({
					try: () =>
						forkClaudeTranscript(
							{
								parentSdkId: parentThread.resumeSessionId,
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
				})
			: { sdkSessionId: randomUUID() };
		const history = copyForkHistory(parentEvents, {
			newSessionId: forked.sdkSessionId,
			...(messageId !== undefined && { upToMessageId: messageId }),
		});
		const forkPointEvent = messageId ?? forkPointMessage.id;
		// A native cursor commits before the row is announced. Without one,
		// prepareTurn hands off this child's bounded history on its first send.
		yield* commitAndSignal.write((project) =>
			Effect.gen(function* () {
				const created = yield* eventStore.value.appendBatch([
					canonicalEvent(
						"session.created",
						forked.sdkSessionId,
						{
							sessionId: forked.sdkSessionId,
							title,
							provider,
							...(parentThread
								? { providerSessionId: forked.sdkSessionId }
								: {}),
							parentId: parentSessionId,
							...(side
								? { sideThread: true, permissionMode: "ask" as const }
								: {}),
							forkPointEvent,
							forkPointTimestamp: forkPointMessage.created_at,
							forkPointMessageId: forkPointMessage.id,
						},
						{
							provider,
							createdAt: Date.now(),
							metadata: { source: "relay" },
						},
					),
					...sessionPickEvents(forked.sdkSessionId, pick),
				]);
				yield* project(created);
				if (workspace._tag === "Some")
					yield* workspace.value.inherit(forked.sdkSessionId, parentSessionId, {
						project,
					});
				// The fork has nothing in flight. Copied history can end inside a
				// turn the parent is still running; the idle closes it, or the
				// inbox reads the fork as busy and holds every send.
				const stored = history?.events.length
					? yield* eventStore.value.appendBatch([
							...history.events,
							canonicalEvent(
								"session.status",
								forked.sdkSessionId,
								{ sessionId: forked.sdkSessionId, status: "idle" },
								{ provider, metadata: { source: "relay" } },
							),
						])
					: created;
				if (history?.events.length) yield* project(stored);
				if (parentThread)
					yield* state.saveUpdates(forked.sdkSessionId, [
						{
							key: nativeThreadKey(provider),
							value: JSON.stringify({
								...(claudeConfigDir !== undefined
									? { configDir: claudeConfigDir }
									: {}),
								resumeSessionId: forked.sdkSessionId,
								firstSequence: created[0]?.sequence ?? 0,
								deliveredThrough: stored.at(-1)?.sequence ?? 0,
							}),
						},
					]);
				// Ask applies before the row is announced, so no send can reach the
				// Side Thread first.
				if (side) yield* setPermissionMode(forked.sdkSessionId, "ask");
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

/** A fork's first launch cannot read its row before workspace inheritance. */
export const forkSession = (
	parentSessionId: string,
	options?: { messageId?: string; side?: { title: string } },
) =>
	Effect.gen(function* () {
		const workspace = yield* Effect.serviceOption(SessionWorkspaceTag);
		const fork = forkSessionInWorkspace(parentSessionId, options);
		return yield* workspace._tag === "Some"
			? workspace.value.withLaunch(fork)
			: fork;
	});

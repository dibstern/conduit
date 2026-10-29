import { Context, Data, Effect, Option, Ref, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { Fragment } from "effect/sql/Statement";
import type { SessionScope } from "../../contracts/session-scope.js";
import { inboxRunStatusQuery } from "../inbox-run-status-query.js";
import { SessionRollupProjects } from "./session-rollup-projects.js";

export type { SessionScope } from "../../contracts/session-scope.js";

import {
	LimitRecoverySchema,
	SessionResumeSchema,
} from "../../contracts/limit-recovery.js";
import { SessionWorkspaceSchema } from "../../contracts/session-workspace.js";
import {
	type InputRequest,
	InputRequestSchema,
	type SessionGoalChangedPayload,
	SessionGoalChangedPayloadSchema,
} from "../../contracts/stored-event.js";
import type { ToolDetail } from "../../contracts/tool-wire.js";
import type {
	GoalDetails,
	SessionDetailWindow,
	SessionPromptSummary,
	SessionTodos,
	TodoItem,
} from "../../contracts/ws-rpc.js";
import { SessionWorkspaceHintStateTag } from "../../domain/relay/Services/session-workspace-hint-state.js";
import type { SessionBackground } from "../../session/background-liveness.js";
import {
	claudeWorkspaceMismatch,
	decodeClaudeWorktreeState,
} from "../../session/claude-worktree-state.js";
import type { SessionSkillMessage } from "../../session/session-skills.js";
import {
	GoalStuckSchema,
	type SessionAttention,
	type SessionInfo,
	SessionPermissionModeSchema,
} from "../../shared-types.js";
import type {
	MessagePartRow,
	MessageRow,
	MessageWithParts,
	PendingApprovalCountRow,
	PendingApprovalRow,
	PendingClaudeQuestionToolRow,
	SessionRow,
	TurnModelExecutionRow,
} from "../read-model-types.js";
import {
	sessionFamilyMembersQuery,
	sessionFamilyRootQuery,
	sessionFamilyWindowQuery,
} from "../session-family-query.js";
import {
	FRAME_ENVELOPE_BYTES,
	messageRowGroups,
	messageRowsToHistory,
	PAGE_FRAME_BUDGET,
} from "../session-history-adapter.js";
import { type SidebarRow, SidebarRowSchema } from "../sidebar-row.js";
import { pendingClaudeQuestionToolsQuery } from "../startup-restore-queries.js";
import {
	NEVER_CUT_TOOL_NAMES,
	PREVIEW_CODE_POINTS,
	toolDetail,
} from "../tool-wire-projection.js";

// The relay or daemon supplies ownership and resolves the current account.
type SessionProjection = Omit<SessionInfo, "projectSlug" | "accountId">;

const isSessionPermissionMode = Schema.is(SessionPermissionModeSchema);
const decodeGoalState = Schema.decodeUnknownSync(
	Schema.fromJsonString(SessionGoalChangedPayloadSchema),
);
const decodeTurnWaits = Schema.decodeUnknownSync(
	Schema.fromJsonString(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				from: Schema.Number,
				to: Schema.NullOr(Schema.Number),
			}),
		),
	),
);

export const sessionGoalState = (
	row: Pick<SessionRow, "id" | "goal_state">,
): SessionGoalChangedPayload =>
	row.goal_state
		? decodeGoalState(row.goal_state)
		: { sessionId: row.id, goal: null };

/**
 * What `sessionColumns` selects: the single session type with SQLite's NULLs
 * still in place for the two nullable columns.
 */
export const deriveSessionSnooze = (
	row: Pick<
		SessionRow,
		"snoozed_at" | "snoozed_until" | "woken_at" | "woken_reason"
	>,
	now = Date.now(),
): Pick<
	SessionInfo,
	"snoozedAt" | "snoozedUntil" | "wokenAt" | "wokeBecause"
> => {
	if (row.snoozed_at === null) return {};
	const wakeAt =
		row.woken_at ??
		(row.snoozed_until !== null && row.snoozed_until <= now
			? row.snoozed_until
			: null);
	// Woken stays shown until the session is opened, which unsnoozes it; its
	// unread dot is a separate matter (conduit-test-hk9m.9).
	if (wakeAt !== null)
		return { wokenAt: wakeAt, wokeBecause: row.woken_reason ?? "time" };
	return {
		snoozedAt: row.snoozed_at,
		...(row.snoozed_until !== null ? { snoozedUntil: row.snoozed_until } : {}),
	};
};

export const pendingApprovalCountsByType = (
	rows: readonly PendingApprovalCountRow[],
) => {
	const questions = new Map<string, number>();
	const permissions = new Map<string, number>();
	for (const row of rows)
		(row.type === "question" ? questions : permissions).set(
			row.session_id,
			row.pending_count,
		);
	return { questions, permissions };
};

export const sessionRowsToSessionInfoList = (
	rows: readonly SessionRow[],
	opts: {
		readonly now?: number;
		readonly statuses?: Readonly<Record<string, { type: string }>>;
		readonly parentMap?: ReadonlyMap<string, string>;
		/** Contribution owners; the parent map still includes the whole family. */
		readonly contributingSessionIds?: ReadonlySet<string> | undefined;
		readonly sideThreadIds?: ReadonlySet<string>;
		/** Unread descendants, stopping at each Side Thread's edge to its parent. */
		readonly unreadSessionIds?: ReadonlySet<string>;
		readonly pendingQuestionCounts?: ReadonlyMap<string, number>;
		readonly pendingPermissionCounts?: ReadonlyMap<string, number>;
		readonly hintDismissals?: ReadonlyMap<string, number> | undefined;
		readonly backgroundOf?: (
			sessionId: string,
		) => SessionBackground | undefined;
	} = {},
): Array<SessionProjection & { readonly updatedAt: number }> => {
	const subtree = new Map<
		string,
		{
			processing: boolean;
			monitoring: boolean;
			unread: boolean;
			questions: number;
			permissions: number;
		}
	>();
	const sideThreadIds = new Set([
		...(opts.sideThreadIds ?? []),
		...rows.flatMap((row) => (row.side_thread === 1 ? [row.id] : [])),
	]);
	const stateFor = (id: string) => {
		const state = subtree.get(id) ?? {
			processing: false,
			monitoring: false,
			unread: false,
			questions: 0,
			permissions: 0,
		};
		subtree.set(id, state);
		return state;
	};
	if (opts.parentMap) {
		const rowStatuses = new Map(rows.map((row) => [row.id, row.status]));
		const members = new Set([...rowStatuses.keys(), ...opts.parentMap.keys()]);
		const backgroundChildren = new Set(
			[...new Set([...members, ...opts.parentMap.values()])]
				.filter((id) => opts.contributingSessionIds?.has(id) ?? true)
				.flatMap(
					(id) =>
						opts
							.backgroundOf?.(id)
							?.tasks.flatMap((task) =>
								task.childSessionId ? [task.childSessionId] : [],
							) ?? [],
				),
		);
		for (const id of members) {
			if (opts.contributingSessionIds && !opts.contributingSessionIds.has(id))
				continue;
			let root = id;
			let activityRoot: string | undefined;
			const seen = new Set<string>();
			const promptRoots = new Set<string>();
			while (opts.parentMap.has(root) && !seen.has(root)) {
				seen.add(root);
				if (sideThreadIds.has(root)) {
					activityRoot ??= root;
					promptRoots.add(root);
				}
				root = opts.parentMap.get(root) ?? root;
			}
			// Prompts reach each Side Thread ancestor and the family root.
			promptRoots.add(root);
			for (const promptRoot of promptRoots) {
				const state = stateFor(promptRoot);
				state.questions += opts.pendingQuestionCounts?.get(id) ?? 0;
				state.permissions += opts.pendingPermissionCounts?.get(id) ?? 0;
			}
			const activity = stateFor(activityRoot ?? root);
			const status = opts.statuses?.[id]?.type ?? rowStatuses.get(id);
			const work = opts.backgroundOf?.(id)?.work;
			// A live background agent keeps its own busy status; its owner
			// monitors that work rather than inheriting a foreground turn.
			activity.processing ||=
				(!backgroundChildren.has(id) &&
					(status === "busy" || status === "retry")) ||
				work === "working";
			activity.monitoring ||= work === "monitoring";
			activity.unread ||= opts.unreadSessionIds?.has(id) === true;
		}
	}
	return rows.map((row) => {
		const parentID = row.parent_id ?? undefined;
		const state =
			parentID && row.side_thread !== 1 ? undefined : subtree.get(row.id);
		const pendingQuestionCount =
			state?.questions ?? opts.pendingQuestionCounts?.get(row.id);
		const pendingPermissionCount =
			state?.permissions ?? opts.pendingPermissionCounts?.get(row.id);
		const unread = row.unread === 1;
		const status = opts.statuses?.[row.id]?.type ?? row.status;
		const background = opts.backgroundOf?.(row.id);
		const backgroundWork = background?.work;
		const processing =
			state?.processing ||
			status === "busy" ||
			status === "retry" ||
			backgroundWork === "working";
		const monitoring = state?.monitoring || backgroundWork === "monitoring";
		let attention: SessionAttention = "idle";
		if ((pendingPermissionCount ?? 0) > 0) attention = "needs-approval";
		else if ((pendingQuestionCount ?? 0) > 0) attention = "needs-reply";
		else if (row.last_turn_error_at !== null) attention = "error";
		else if (processing) attention = "working";
		else if (monitoring) attention = "monitoring";
		else if (state?.unread || unread) attention = "done-unread";
		return {
			id: row.id,
			title: row.title,
			status:
				status === "busy" || status === "retry" || status === "error"
					? status
					: "idle",
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			...(row.last_user_message_at == null
				? {}
				: { lastUserMessageAt: row.last_user_message_at }),
			messageCount: 0,
			...(row.workspace_hint == null ||
			opts.hintDismissals?.get(row.id) === row.workspace_hint_sequence
				? {}
				: { workspaceHint: row.workspace_hint }),
			...(row.workspace == null
				? {}
				: {
						workspace: Schema.decodeUnknownSync(
							Schema.fromJsonString(SessionWorkspaceSchema),
						)(row.workspace),
					}),
			workspaceMismatch: row.claude_worktree_state
				? claudeWorkspaceMismatch(
						decodeClaudeWorktreeState(row.claude_worktree_state),
					)
				: undefined,
			...(row.goal_state ? { goalState: sessionGoalState(row) } : {}),
			...(row.goal_stuck
				? {
						goalStuck: Schema.decodeUnknownSync(
							Schema.fromJsonString(GoalStuckSchema),
						)(row.goal_stuck),
					}
				: {}),
			...(isSessionPermissionMode(row.permission_mode)
				? { permissionMode: row.permission_mode }
				: {}),
			...(row.model_id != null && row.model_provider != null
				? { model: { model: row.model_id, provider: row.model_provider } }
				: {}),
			...(row.variant != null ? { variant: row.variant } : {}),
			...(row.context_window != null
				? { contextWindow: row.context_window }
				: {}),
			...(parentID ? { parentID } : {}),
			...(row.forked_from != null ? { forkedFrom: row.forked_from } : {}),
			...(row.side_thread === 1 ? { sideThread: true } : {}),
			...(row.fork_point_event ? { forkMessageId: row.fork_point_event } : {}),
			...(row.fork_point_timestamp != null
				? { forkPointTimestamp: row.fork_point_timestamp }
				: {}),
			...(row.fork_point_message_id != null
				? { forkPointMessageId: row.fork_point_message_id }
				: {}),
			...(processing ? { processing: true } : {}),
			...(backgroundWork ? { backgroundWork } : {}),
			...(background?.tasks.length
				? { backgroundTasks: background.tasks }
				: {}),
			...(pendingQuestionCount ? { pendingQuestionCount } : {}),
			...(pendingPermissionCount ? { pendingPermissionCount } : {}),
			...(unread ? { unread: true } : {}),
			...(row.last_turn_end_version != null
				? { lastTurnEndVersion: row.last_turn_end_version }
				: {}),
			...(row.last_turn_end_input_id != null
				? { lastTurnEndInputId: row.last_turn_end_input_id }
				: {}),
			...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
			...(row.archived_at != null ? { archivedAt: row.archived_at } : {}),
			limitRecovery:
				row.limit_recovery == null
					? null
					: Schema.decodeUnknownSync(
							Schema.fromJsonString(LimitRecoverySchema),
						)(row.limit_recovery),
			resumes:
				row.resumes == null
					? []
					: Schema.decodeUnknownSync(
							Schema.fromJsonString(Schema.Array(SessionResumeSchema)),
						)(row.resumes),
			...(row.settled_automatically === 1
				? { settledAutomatically: true }
				: {}),
			...(row.auto_settle_disabled_at != null
				? { autoSettleDisabled: true }
				: {}),
			...(row.jev != null ? { jev: row.jev } : {}),
			...(row.pinned_at !== null ? { pinnedAt: row.pinned_at } : {}),
			...deriveSessionSnooze(row, opts.now),
			attention,
		};
	});
};

const decodeSidebarRow = Schema.decodeUnknownSync(
	Schema.fromJsonString(SidebarRowSchema),
);

/**
 * A stored sidebar row as the sidebar shows it now. Background work and snooze
 * depend on the moment of reading, so they are applied here, as the full
 * session list applies them, and never stored.
 */
const sidebarItem = (
	row: SidebarRow,
	backgroundOf?: (sessionId: string) => SessionBackground | undefined,
	busyMembers?: ReadonlySet<string>,
): SessionProjection => {
	const work = new Set(row.members.map((id) => backgroundOf?.(id)?.work));
	const background = backgroundOf?.(row.session.id);
	const backgroundChildren = new Set(
		row.members.flatMap(
			(id) =>
				backgroundOf?.(id)?.tasks.flatMap((task) =>
					task.childSessionId ? [task.childSessionId] : [],
				) ?? [],
		),
	);
	const { processing: storedProcessing, ...session } = row.session;
	const processing =
		backgroundChildren.size > 0 && busyMembers !== undefined
			? row.members.some(
					(id) => busyMembers.has(id) && !backgroundChildren.has(id),
				)
			: storedProcessing === true;
	const quiet =
		row.session.attention === "idle" ||
		row.session.attention === "done-unread" ||
		(row.session.attention === "working" && !processing);
	return {
		...session,
		updatedAt: row.lastActivity,
		...(processing || work.has("working") ? { processing: true } : {}),
		...(background?.work ? { backgroundWork: background.work } : {}),
		...(background?.tasks.length ? { backgroundTasks: background.tasks } : {}),
		...deriveSessionSnooze(row.snooze),
		attention: !quiet
			? row.session.attention
			: work.has("working")
				? "working"
				: work.has("monitoring")
					? "monitoring"
					: row.session.attention,
	};
};

export class ReadQueryEffectError extends Data.TaggedError(
	"ReadQueryEffectError",
)<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

export class TranscriptPageCursorNotFoundError extends Data.TaggedError(
	"TranscriptPageCursorNotFoundError",
)<{
	readonly sessionId: string;
	readonly before: string;
}> {}

export interface TranscriptPosition {
	readonly createdAt: number;
	readonly id: string;
}
export interface TranscriptBounds {
	readonly first: TranscriptPosition;
	readonly last: TranscriptPosition;
}
interface SessionTranscriptPageOptions {
	readonly before?: string;
	readonly limit: number;
	/** Read from the oldest message, or inclusively from the supplied cursor. */
	readonly forward?: { readonly from?: string; readonly exclusive?: boolean };
	readonly bounds?: TranscriptBounds;
	readonly windowKind?: "latest" | "historical";
	/** Cut long tool outputs as the browser opens them (see previewParts). */
	readonly previewTools?: boolean;
}

interface TranscriptListingOptions {
	/** The page's oldest message; omitted, the whole session. */
	readonly from?: string;
	/** The version the page was read at. */
	readonly since: number;
}

interface TranscriptWindow {
	readonly messages: MessageWithParts[];
	readonly version: number;
	readonly removed?: readonly {
		readonly id: string;
		readonly version: number;
	}[];
	readonly removedParts?: readonly {
		readonly messageId: string;
		readonly partId: string;
		readonly version: number;
	}[];
	/** With listing options whose `from` still exists, read from a cursor
	 *  the store has reached. */
	readonly listing?: {
		readonly messages: readonly {
			readonly id: string;
			readonly version: number;
		}[];
		readonly parts: readonly {
			readonly messageId: string;
			readonly partId: string;
			readonly version: number;
		}[];
	};
}

export interface ReadQueryEffect {
	/** The named tools of one session exactly as stored; unknown ids are left out. */
	readonly readToolDetails: (
		sessionId: string,
		toolIds: readonly string[],
	) => Effect.Effect<readonly ToolDetail[], ReadQueryEffectError | SqlError>;

	readonly getSessionStatus: (
		sessionId: string,
	) => Effect.Effect<string | undefined, ReadQueryEffectError | SqlError>;

	readonly getSession: (
		sessionId: string,
	) => Effect.Effect<SessionRow | undefined, ReadQueryEffectError | SqlError>;

	/** The topmost ancestor still present; none for a missing session or a cycle. */
	readonly getSessionFamilyRoot: (
		sessionId: string,
	) => Effect.Effect<string | undefined, ReadQueryEffectError>;

	readonly getGoalDetails: (
		sessionId: string,
	) => Effect.Effect<GoalDetails, ReadQueryEffectError | SqlError>;

	readonly getAllSessionStatuses: (
		scope: SessionScope,
	) => Effect.Effect<Record<string, string>, ReadQueryEffectError | SqlError>;

	readonly getAllSessionStatusesWithProviders: (
		scope: SessionScope,
	) => Effect.Effect<
		readonly Pick<SessionRow, "id" | "status" | "provider">[],
		ReadQueryEffectError | SqlError
	>;

	readonly getSessionsForReconciliation: (
		scope: SessionScope,
		reportedIds: readonly string[],
	) => Effect.Effect<
		readonly Pick<SessionRow, "id" | "status" | "updated_at">[],
		ReadQueryEffectError | SqlError
	>;

	/** Busy children launched by a task while their parent has no turn in
	 * flight, with the task id and the session whose Claude runtime lists it. */
	readonly getStrandedChildren: (
		scope: SessionScope,
	) => Effect.Effect<
		readonly { id: string; task_id: string; owner_id: string }[],
		ReadQueryEffectError | SqlError
	>;

	readonly listSessions: (
		scope: SessionScope,
		opts?: {
			roots?: boolean;
			limit?: number;
			titleQuery?: string;
			excludeArchived?: boolean;
			archivedOnly?: boolean;
			orderColumn?: "updated_at" | "archived_at";
			before?: { at: number; id: string };
		},
	) => Effect.Effect<readonly SessionRow[], ReadQueryEffectError | SqlError>;

	/** Full shelf size, independent of a session page or keyset cursor. */
	readonly countSettledSessions: (
		scope: SessionScope,
		opts?: {
			roots?: boolean;
			titleQuery?: string;
			excludeArchived?: boolean;
			archivedOnly?: boolean;
		},
	) => Effect.Effect<number, ReadQueryEffectError | SqlError>;

	readonly listSessionInfos: (
		scope: SessionScope,
		opts?: {
			roots?: boolean;
			limit?: number;
			titleQuery?: string;
			excludeArchived?: boolean;
			archivedOnly?: boolean;
			orderColumn?: "updated_at" | "archived_at";
			before?: { at: number; id: string };
			statuses?: Readonly<Record<string, { type: string }>>;
			backgroundOf?: (sessionId: string) => SessionBackground | undefined;
			hintDismissals?: ReadonlyMap<string, number>;
		},
	) => Effect.Effect<
		readonly (SessionProjection & { readonly updatedAt: number })[],
		ReadQueryEffectError | SqlError
	>;
	readonly listSessionGitRefreshTargets: (
		scope: SessionScope,
		options: {
			readonly sessionIds: readonly string[];
			readonly all: boolean;
		},
	) => Effect.Effect<
		readonly Pick<SessionInfo, "id" | "workspace">[],
		ReadQueryEffectError | SqlError
	>;

	readonly getSessionLineage: (scope: SessionScope) => Effect.Effect<
		{
			rows: readonly {
				id: string;
				parent_id: string | null;
				unread: number;
				side_thread: number;
			}[];
			count: number;
		},
		ReadQueryEffectError | SqlError
	>;

	readonly countPendingApprovalsBySession: (
		scope: SessionScope,
	) => Effect.Effect<
		readonly PendingApprovalCountRow[],
		ReadQueryEffectError | SqlError
	>;
	/**
	 * The approvals subscription's read (ni8.9), in the shape of
	 * {@link readSessionList}. A base read (no `range`) is every pending
	 * approval; a windowed read is every approval that moved inside it,
	 * resolved ones included, because a resolution is a removal to announce.
	 */
	readonly readPendingApprovals: (
		scope: SessionScope,
		range?: {
			readonly after?: number;
			readonly through?: number;
		},
	) => Effect.Effect<
		{ readonly rows: readonly PendingApprovalRow[]; readonly version: number },
		ReadQueryEffectError | SqlError
	>;
	readonly listPendingClaudeQuestionTools: (
		scope: SessionScope,
	) => Effect.Effect<
		readonly PendingClaudeQuestionToolRow[],
		ReadQueryEffectError | SqlError
	>;
	readonly getPendingClaudeQuestionTool?: (
		sessionId: string,
		callId: string,
	) => Effect.Effect<
		PendingClaudeQuestionToolRow | undefined,
		ReadQueryEffectError | SqlError
	>;

	readonly getSessionMessagesWithParts: (
		sessionId: string,
	) => Effect.Effect<MessageWithParts[], ReadQueryEffectError | SqlError>;
	readonly getSessionSkillMessages: (
		sessionId: string,
	) => Effect.Effect<SessionSkillMessage[], ReadQueryEffectError | SqlError>;
	readonly getSessionHistoryMetadata: (
		sessionId: string,
	) => Effect.Effect<
		{ readonly messageCount: number; readonly cumulativeTokens: number },
		ReadQueryEffectError | SqlError
	>;
	readonly readSessionTranscriptPage: (
		sessionId: string,
		options: SessionTranscriptPageOptions,
	) => Effect.Effect<
		{
			readonly messages: MessageWithParts[];
			readonly hasMore: boolean;
			readonly version: number;
			readonly cursor?: string;
			readonly window?: SessionDetailWindow;
		},
		ReadQueryEffectError | SqlError | TranscriptPageCursorNotFoundError
	>;
	readonly readSessionPromptIndex: (
		sessionId: string,
		range?: { readonly after?: number; readonly through?: number },
	) => Effect.Effect<
		{
			readonly rows: readonly {
				readonly item: SessionPromptSummary;
				readonly version: number;
			}[];
			readonly version: number;
			readonly removed: readonly {
				readonly id: string;
				readonly version: number;
			}[];
		},
		ReadQueryEffectError | SqlError
	>;

	/**
	 * The session-list rows that moved inside `range`, each with the version it
	 * moved at, and the read-model version the answer is current through.
	 *
	 * `range` omitted is the same read over every version: a cold-start base and
	 * a live window are one query, not two mechanisms that can disagree. Rows
	 * and version are read in ONE transaction, so the version never claims a row
	 * the read could not see.
	 *
	 * `through` is what keeps a slow read honest. Without it the answer is
	 * whatever the read model holds when the query happens to run, which can be
	 * a commit whose advance is still queued — and a subscriber that treats
	 * those rows as seen will then discard that advance, taking its removals
	 * with it. No later query can recover them (§8).
	 */
	readonly readSessionList: (
		scope: SessionScope,
		range?: {
			readonly after?: number;
			readonly through?: number;
			/**
			 * Only the family (root and descendants) of this session. Without it,
			 * the sidebar: one row per top-level session, its family rolled up.
			 */
			readonly familyOf?: string;
			/** Bound a family base to this member's view; ignored for windows. */
			readonly viewed?: string;
			readonly hintDismissals?: ReadonlyMap<string, number>;
			/** In-memory liveness the row cannot carry; see announceBackgroundWork. */
			readonly backgroundOf?: (
				sessionId: string,
			) => SessionBackground | undefined;
			/** Also list every sidebar row, for a resume checksum. */
			readonly listing?: boolean;
		},
	) => Effect.Effect<
		{
			readonly rows: readonly {
				readonly item: SessionProjection;
				readonly version: number;
			}[];
			readonly version: number;
			/**
			 * Families that left the sidebar inside a range with an `after`, each
			 * at the version it left, and sessions deleted there, children too,
			 * marked `deleted`. A read without one is a base, which shows absence
			 * by leaving them out.
			 */
			readonly removed?: readonly {
				readonly id: string;
				readonly version: number;
				readonly deleted: boolean;
				readonly projectSlug?: string;
			}[];
			/**
			 * With `removed`: the version tombstones were first kept at. A range
			 * opening before it may have missed removals.
			 */
			readonly removedSince?: number;
			/** With `listing`: each sidebar row's id and version, no bodies. */
			readonly listing?: readonly (readonly [id: string, version: number])[];
		},
		ReadQueryEffectError | SqlError
	>;

	/**
	 * As {@link readSessionList}, for one session's projected transcript. A
	 * message and each of its parts carry their own `version`. A ranged read
	 * returns the parts that moved inside `range` with the message that owns
	 * each, which may itself have moved past it; the message moved in `range`
	 * when its own version is inside it. Removed messages and removed parts
	 * come back separately. Tool outputs come back as the browser opens them
	 * (`previewTools`).
	 *
	 * `listing` also lists, by id and version and in the same transaction, the
	 * messages and parts a client holding a page from `from` and every change
	 * past `since` holds: those of messages at or after `from` (the whole
	 * session without one), and any that moved past `since`.
	 */
	readonly readSessionTranscript: (
		sessionId: string,
		range?: { readonly after?: number; readonly through?: number },
		listing?: TranscriptListingOptions,
	) => Effect.Effect<TranscriptWindow, ReadQueryEffectError | SqlError>;
	/** Decline a large resume before reading its listing or any part bodies. */
	readonly readSessionTranscriptCatchUp: (
		sessionId: string,
		after: number,
		maxMessages: number,
		listing?: TranscriptListingOptions,
	) => Effect.Effect<
		TranscriptWindow | "snapshot",
		ReadQueryEffectError | SqlError
	>;

	/**
	 * One session's todo list: the items its newest completed TodoWrite left
	 * behind, as one row. Todos are not a table of their own; they are the
	 * TodoWrite tool parts the message projector already keeps, so they inherit
	 * the owning message's version and survive a reload with the transcript.
	 *
	 * A ranged read answers with the row only when a TodoWrite message (or a
	 * removed message) moved inside `range`, at the newest such version, so an
	 * ordinary text delta in the session costs one indexed probe and no row.
	 */
	readonly readSessionTodos: (
		sessionId: string,
		range?: { readonly after?: number; readonly through?: number },
	) => Effect.Effect<
		{
			readonly rows: readonly {
				readonly item: SessionTodos;
				readonly version: number;
			}[];
			readonly version: number;
		},
		ReadQueryEffectError | SqlError
	>;

	readonly getLatestTurnModelExecution: (
		sessionId: string,
	) => Effect.Effect<
		TurnModelExecutionRow | undefined,
		ReadQueryEffectError | SqlError
	>;

	/**
	 * The session's pending inputs that moved inside `range`, oldest first.
	 * Without `after` it is a base read: every input still pending, and no
	 * removals. With it, inputs that left the tray come back as `removed`.
	 * Pass `through` so the answer never runs ahead of the version the caller
	 * reports.
	 */
	readonly readPendingInputs: (
		sessionId: string,
		range: { readonly after?: number; readonly through: number },
	) => Effect.Effect<
		{
			readonly rows: readonly PendingInputRow[];
			readonly removed: readonly {
				readonly id: string;
				readonly version: number;
			}[];
		},
		ReadQueryEffectError | SqlError
	>;

	/**
	 * The session's inbox facts, computed on read. A queue is paused while
	 * inputs wait behind a turn stopped or failed since the latest handoff,
	 * or behind a Limit Recovery. A Resume lifts a hold admitted after the
	 * latest Stop; a later Stop still wins. `version` is the session row's, which
	 * every turn end, prompt and pending-input write stamps. Undefined for a
	 * session that has never held an input, which has no queue to pause and no
	 * turn to steer into.
	 */
	readonly readInboxState: (sessionId: string) => Effect.Effect<
		| {
				readonly paused: boolean;
				readonly promptOpen: boolean;
				readonly provider: string;
				readonly version: number;
		  }
		| undefined,
		ReadQueryEffectError
	>;
	/** This store's random name, minted once by migration. Resume points carry
	 *  it so a point from another store is refused. */
	readonly readStoreIdentity: () => Effect.Effect<
		string | undefined,
		ReadQueryEffectError
	>;
}

export interface PendingInputRow {
	readonly inputId: string;
	readonly state: "queued" | "steering";
	readonly request: InputRequest;
	readonly admittedAt: number;
	readonly version: number;
}

const decodeInputRequest = Schema.decodeUnknownEffect(
	Schema.fromJsonString(InputRequestSchema),
);

export class ReadQueryEffectTag extends Context.Service<
	ReadQueryEffectTag,
	ReadQueryEffect
>()("ReadQueryEffect") {}

type MessageWithTurnModelRow = MessageRow & {
	turn_provider_driver: "codex" | null;
	turn_cost: number | null;
	turn_requested_model: string | null;
	turn_expected_model: string | null;
	turn_actual_model: string | null;
	turn_effort: string | null;
	turn_context_window: string | null;
	turn_started_at: number | null;
	turn_completed_at: number | null;
	turn_waits: string;
};

const TODO_STATUSES: readonly TodoItem["status"][] = [
	"pending",
	"in_progress",
	"completed",
	"cancelled",
];

const parseStoredJson = (text: string | null): unknown => {
	if (text === null) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		// A provider's text output is stored as a JSON string, and OpenCode's
		// todowrite output is itself JSON.
		return typeof value === "string" ? parseStoredJson(value) : value;
	} catch {
		return undefined;
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The todo list a TodoWrite carried: its input's `todos` (stored canonically
 * as `{ tool: "Unknown", raw }`), else the list OpenCode echoes as its output.
 * Items speak `content` on the wire and `subject` here. `undefined` when
 * neither side holds a list.
 */
const todoWriteItems = (
	input: string | null,
	result: string | null,
): TodoItem[] | undefined => {
	const listOf = (value: unknown): unknown[] | undefined =>
		Array.isArray(value)
			? value
			: !isRecord(value)
				? undefined
				: Array.isArray(value["todos"])
					? value["todos"]
					: listOf(value["raw"]);
	const list =
		listOf(parseStoredJson(input)) ?? listOf(parseStoredJson(result));
	return list?.filter(isRecord).map((todo, index) => {
		const status = TODO_STATUSES.find((known) => known === todo["status"]);
		const description = todo["description"];
		return {
			id:
				typeof todo["id"] === "string" && todo["id"]
					? todo["id"]
					: `todo-${index}`,
			subject: String(todo["subject"] ?? todo["content"] ?? ""),
			...(typeof description === "string" && description
				? { description }
				: {}),
			status: status ?? "pending",
		};
	});
};

function groupMessagesWithPartsAndTurnModels(
	messages: readonly MessageWithTurnModelRow[],
	parts: readonly MessagePartRow[],
): MessageWithParts[] {
	const partsByMessage = new Map<string, MessagePartRow[]>();
	for (const part of parts) {
		const existing = partsByMessage.get(part.message_id) ?? [];
		existing.push(part);
		partsByMessage.set(part.message_id, existing);
	}
	return messages.map((message) => {
		const {
			turn_provider_driver,
			turn_cost,
			turn_requested_model,
			turn_expected_model,
			turn_actual_model,
			turn_effort,
			turn_context_window,
			turn_started_at,
			turn_completed_at,
			turn_waits,
			...messageRow
		} = message;
		return {
			...messageRow,
			parts: partsByMessage.get(message.id) ?? [],
			...(turn_provider_driver == null
				? {}
				: { providerDriver: turn_provider_driver }),
			...(turn_cost === null ? {} : { turnCost: turn_cost }),
			...(message.role === "user" && turn_started_at !== null
				? {
						turnTiming: {
							startedAt: turn_started_at,
							...(turn_completed_at === null
								? {}
								: { endedAt: turn_completed_at }),
							waits: decodeTurnWaits(turn_waits).map(({ id, from, to }) => ({
								id,
								from,
								...(to === null ? {} : { to }),
							})),
						},
					}
				: {}),
			...(turn_actual_model === null
				? {}
				: {
						modelExecution: {
							...(turn_requested_model === null
								? {}
								: { requestedModel: turn_requested_model }),
							...(turn_expected_model === null
								? {}
								: { expectedModel: turn_expected_model }),
							actualModel: turn_actual_model,
							...(turn_effort === null ? {} : { effort: turn_effort }),
							...(turn_context_window === null
								? {}
								: { contextWindow: turn_context_window }),
						},
					}),
		};
	});
}

export const makeReadQueryEffect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const projects = yield* SessionRollupProjects;
	// Read state is an annotation beside the replay-owned rows; only surfaced
	// text parts carry it.
	const withPartReadState = (parts: readonly MessagePartRow[]) => {
		const surfaced = parts.flatMap((part) =>
			part.surfacing_ordinal == null ? [] : [part.id],
		);
		if (surfaced.length === 0) return Effect.succeed(parts);
		return sql<{ part_id: string }>`
			SELECT part_id FROM message_part_read_state
			WHERE part_id IN (SELECT value FROM json_each(${JSON.stringify(surfaced)}))`.pipe(
			Effect.map((rows) => {
				const read = new Set(rows.map((row) => row.part_id));
				return parts.map((part) =>
					part.surfacing_ordinal == null
						? part
						: { ...part, surfacing_read: read.has(part.id) },
				);
			}),
		);
	};
	// The provider may reconcile streamed timestamps while a rewind is pending.
	// Visibility follows the transcript's current (created_at, id) ordering.
	const pendingRewindHides = (table: "messages" | "m" = "messages") => sql`
		EXISTS (
			SELECT 1 FROM sessions s JOIN messages cut
				ON cut.id = s.pending_rewind_message_id AND cut.session_id = s.id
			WHERE s.id = ${sql.literal(`${table}.session_id`)}
				AND (${sql.literal(`${table}.created_at`)} > cut.created_at
					OR (${sql.literal(`${table}.created_at`)} = cut.created_at
						AND ${sql.literal(`${table}.id`)} >= cut.id))
		)`;
	const hintDismissals = Option.getOrUndefined(
		yield* Effect.serviceOption(SessionWorkspaceHintStateTag),
	);
	// A prompt queued behind a running turn starts working when that turn
	// ends, not when it was sent: waiting in the queue is not work. A steer
	// joins the running turn and settles with it, so it starts when sent.
	const turnMetadataColumns = sql`
		CASE WHEN EXISTS (SELECT 1 FROM message_parts part
			WHERE part.message_id = messages.id AND part.type = 'tool' AND part.result IS NULL
				AND part.status IS NOT 'completed' AND part.status IS NOT 'error'
				AND json_type(CASE WHEN json_valid(part.metadata) THEN part.metadata END, '$.output') = 'text')
		THEN CASE COALESCE(CASE WHEN COALESCE(turns.run_id, t.run_id) IS NOT NULL THEN COALESCE((SELECT json_extract(command.payload_json, '$.account.driver')
			FROM provider_command_outbox command
			WHERE command.session_id = messages.session_id AND command.effect_type = 'send_turn'
				AND json_valid(command.payload_json)
				AND command.run_id = COALESCE(turns.run_id, t.run_id)
			ORDER BY command.request_sequence LIMIT 1),
			(SELECT event.provider FROM events event INDEXED BY idx_events_run_started_identity
				WHERE event.session_id = messages.session_id AND event.type = 'run.started' AND json_valid(event.metadata)
					AND json_extract(event.metadata, '$.runId') = COALESCE(turns.run_id, t.run_id)
				ORDER BY event.sequence LIMIT 1)) END,
			(
				-- Retained creation events identify legacy output even when migration supplied a run ID.
				-- Unary + removes column affinity so string message IDs use the JSON expression index.
				WITH RECURSIVE ancestors(session_id, message_id, provider, through_sequence) AS (
					SELECT messages.session_id, messages.id,
						(SELECT owner.provider FROM events owner INDEXED BY idx_events_message_created_identity
							WHERE owner.session_id = messages.session_id AND owner.type = 'message.created' AND json_valid(owner.data)
								AND json_extract(owner.data, '$.messageId') = +messages.id AND owner.provider IS NOT NULL
							ORDER BY owner.sequence LIMIT 1), NULL
					UNION ALL
					SELECT COALESCE(json_extract(created.data, '$.forkedFrom'), json_extract(created.data, '$.parentId')),
						substr(ancestor.message_id, 1, length(ancestor.message_id) - length(ancestor.session_id) - 1),
						(SELECT owner.provider FROM events owner INDEXED BY idx_events_message_created_identity
							WHERE owner.session_id = COALESCE(json_extract(created.data, '$.forkedFrom'), json_extract(created.data, '$.parentId'))
								AND owner.type = 'message.created' AND json_valid(owner.data)
								AND json_extract(owner.data, '$.messageId') = substr(ancestor.message_id, 1, length(ancestor.message_id) - length(ancestor.session_id) - 1)
								AND owner.provider IS NOT NULL AND owner.sequence < created.sequence
							ORDER BY owner.sequence LIMIT 1),
						created.sequence
					FROM ancestors ancestor JOIN events created INDEXED BY idx_events_session_type
						ON created.session_id = ancestor.session_id AND created.type = 'session.created'
							AND CASE WHEN json_valid(created.data) THEN json_extract(created.data, '$.inheritsHistory') END = 1
					WHERE ancestor.provider IS NULL
						AND (ancestor.through_sequence IS NOT NULL OR messages.is_inherited = 1)
						AND (ancestor.through_sequence IS NULL OR created.sequence < ancestor.through_sequence)
						AND substr(ancestor.message_id, -length(ancestor.session_id) - 1) = '_' || ancestor.session_id
				)
				SELECT provider FROM ancestors WHERE provider IS NOT NULL LIMIT 1
			)) WHEN 'codex' THEN 'codex' END END AS turn_provider_driver,
		CASE WHEN (SELECT provider FROM sessions WHERE id = messages.session_id) = 'claude'
			THEN turns.cost ELSE NULL END AS turn_cost,
		CASE WHEN messages.steered = 1 THEN t.requested_at
			ELSE MAX(t.requested_at, COALESCE((SELECT MAX(p.completed_at) FROM turns p
				WHERE p.session_id = t.session_id AND p.requested_at < t.requested_at), 0))
		END AS turn_started_at,
		t.completed_at AS turn_completed_at,
		(SELECT json_group_array(json_object(
			'id', pa.id, 'from', pa.created_at, 'to', pa.resolved_at
		))
		FROM (
			SELECT id, created_at, resolved_at FROM pending_approvals
			WHERE session_id = t.session_id
				AND (type <> 'question' OR COALESCE(json_extract(details, '$.delivery'), '') <> 'async')
				AND created_at >= t.requested_at
				AND (t.completed_at IS NULL OR created_at <= t.completed_at)
			ORDER BY created_at ASC, id ASC
		) pa) AS turn_waits`;

	const fullToolResult = sql`
		CASE WHEN mp.result_event_seq IS NULL THEN mp.result
			ELSE (SELECT e.data -> '$.result' FROM events e
				WHERE e.sequence = mp.result_event_seq) END`;

	// A part's full tool result as text: a JSON string decoded, anything
	// else as stored. Nested so json_type never sees malformed JSON.
	const toolOutput = sql`
		CASE WHEN json_valid(${fullToolResult})
			THEN CASE WHEN json_type(${fullToolResult}) = 'text'
				THEN json_extract(${fullToolResult}, '$') ELSE ${fullToolResult} END
			ELSE ${fullToolResult} END`;

	// User annotations outlive projector-owned parts. Join them only when reading.
	const surfacingMark = sql`(SELECT json_patch('{}', json_object(
		'level', sm.level, 'category', sm.category, 'reason', sm.reason, 'direction', sm.direction
	)) FROM surfacing_marks sm
		WHERE sm.session_id = (SELECT session_id FROM messages WHERE id = mp.message_id)
			AND sm.part_id = mp.id AND sm.message_id = mp.message_id) AS surfacing_mark`;

	// Parts as the browser opens them, by the rule tool-wire-projection.ts
	// owns: a tool output over the budget comes back as the JSON of its first
	// PREVIEW_CODE_POINTS code points with `result_bytes` its whole UTF-8 size;
	// never-cut tools come back whole. Only results whose stored JSON is over
	// the budget are decoded, and parts' rest_payload blobs stay behind.
	// `source` is the FROM clause over `message_parts mp`.
	const previewParts = (source: Fragment) =>
		sql<MessagePartRow>`
		SELECT id, message_id, type, text, tool_name, call_id, input, metadata,
			duration, status, sort_order, created_at, updated_at, version,
			surfacing_ordinal, surfacing_probabilities, surfacing_set_version, surfacing_model,
			surfacing_mark,
			CASE WHEN result_event_seq IS NOT NULL THEN result
				WHEN length(output) > ${PREVIEW_CODE_POINTS}
				THEN json_quote(substr(output, 1, ${PREVIEW_CODE_POINTS}))
				ELSE result END AS result,
			CASE WHEN result_event_seq IS NOT NULL THEN result_bytes
				WHEN length(output) > ${PREVIEW_CODE_POINTS}
				THEN length(CAST(output AS BLOB)) END AS result_bytes
		FROM (
			SELECT mp.*, ${surfacingMark},
				CASE WHEN mp.result_event_seq IS NULL AND mp.type = 'tool'
					AND mp.tool_name NOT IN ${sql.in(NEVER_CUT_TOOL_NAMES)}
					AND length(mp.result) > ${PREVIEW_CODE_POINTS}
				THEN ${toolOutput} END AS output
			${source}
		)
		ORDER BY message_id, sort_order`.pipe(Effect.flatMap(withPartReadState));

	const readToolDetails = (
		sessionId: string,
		toolIds: readonly string[],
	): Effect.Effect<readonly ToolDetail[], ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			if (toolIds.length === 0) return [];
			// The browser names a tool by its call id, or by its part id when it
			// has none; a fork repeats its parent's call ids in another session.
			const rows = yield* sql<{
				tool_id: string;
				input: string | null;
				output: string | null;
				version: number;
				settled: number | null;
			}>`
				SELECT COALESCE(mp.call_id, mp.id) AS tool_id, mp.input,
					${toolOutput} AS output, mp.version,
					mp.status IN ('completed', 'error') AS settled
				FROM message_parts mp
				JOIN messages ON messages.id = mp.message_id
				WHERE (mp.call_id IN ${sql.in(toolIds)}
						OR (mp.call_id IS NULL AND mp.id IN ${sql.in(toolIds)}))
					AND mp.type = 'tool' AND messages.session_id = ${sessionId}
				ORDER BY messages.created_at, mp.sort_order`;
			return rows.map((row) =>
				toolDetail({
					toolId: row.tool_id,
					version: row.version,
					settled: row.settled === 1,
					input: row.input,
					output: row.output,
				}),
			);
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "readToolDetails",
							cause: e,
						}),
			),
		);

	const getSessionStatus = (
		sessionId: string,
	): Effect.Effect<string | undefined, ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<{ status: string }>`
				SELECT status FROM sessions WHERE id = ${sessionId}`;
			return rows[0]?.status;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getSessionStatus",
							cause: e,
						}),
			),
		);

	const getSession = (
		sessionId: string,
	): Effect.Effect<SessionRow | undefined, ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<SessionRow>`
				SELECT * FROM sessions WHERE id = ${sessionId}`;
			return rows[0];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getSession",
							cause: e,
						}),
			),
		);

	const getSessionFamilyRoot = (sessionId: string) =>
		sql.unsafe<{ id: string }>(sessionFamilyRootQuery, [sessionId]).pipe(
			Effect.map((rows) => rows[0]?.id),
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({
						operation: "getSessionFamilyRoot",
						cause,
					}),
			),
		);

	const getAllSessionStatusesWithProviders = (scope: SessionScope) =>
		sql<Pick<SessionRow, "id" | "status" | "provider">>`
			SELECT id, status, provider FROM sessions
			WHERE project_id IN ${sql.in(scope.projectIds)}`.pipe(
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({
						operation: "getAllSessionStatusesWithProviders",
						cause,
					}),
			),
		);

	const getAllSessionStatuses = (
		scope: SessionScope,
	): Effect.Effect<Record<string, string>, ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<{ id: string; status: string }>`
				SELECT id, status FROM sessions WHERE project_id IN ${sql.in(scope.projectIds)}`;
			const result: Record<string, string> = {};
			for (const row of rows) {
				result[row.id] = row.status;
			}
			return result;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getAllSessionStatuses",
							cause: e,
						}),
			),
		);

	const getSessionsForReconciliation = (
		scope: SessionScope,
		reportedIds: readonly string[],
	) =>
		sql<Pick<SessionRow, "id" | "status" | "updated_at">>`
			SELECT id, status, updated_at FROM sessions
			WHERE project_id IN ${sql.in(scope.projectIds)} AND (status != 'idle'
				OR id IN (SELECT value FROM json_each(${JSON.stringify(reportedIds)})))
				-- An open run settles only on provider confirmation; the projector
				-- drops an unowned idle for it, so the session would re-qualify forever.
				AND NOT EXISTS (SELECT 1 FROM provider_runs run WHERE run.session_id = sessions.id
					AND run.status IN ('pending', 'running'))
			ORDER BY updated_at DESC, id DESC`.pipe(
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({
						operation: "getSessionsForReconciliation",
						cause,
					}),
			),
		);

	// The link is found through the parent's own messages, which are indexed;
	// CROSS JOIN pins that order, as the planner otherwise scans every part. SDK subagents share their
	// parent's runtime, so the owner climbs through them; forks own theirs.
	const getStrandedChildren = (scope: SessionScope) =>
		sql<{ id: string; task_id: string; owner_id: string }>`
			WITH RECURSIVE stranded AS (
				SELECT c.id, c.parent_id AS owner_id,
					json_extract(mp.metadata, '$.providerTaskId') AS task_id
				FROM sessions c
				CROSS JOIN sessions parent
				CROSS JOIN messages m
				CROSS JOIN message_parts mp
				WHERE c.status IN ('busy', 'retry')
					AND c.project_id IN ${sql.in(scope.projectIds)}
					AND parent.project_id IN ${sql.in(scope.projectIds)}
					AND parent.id = c.parent_id AND parent.status = 'idle'
					AND m.session_id = c.parent_id AND mp.message_id = m.id
					AND json_valid(mp.metadata)
					AND json_extract(mp.metadata, '$.childSessionId') = c.id
					AND json_type(mp.metadata, '$.providerTaskId') = 'text'
					-- A child resumed directly runs its own turn, outside the task list.
					AND NOT EXISTS (SELECT 1 FROM provider_runs run WHERE run.session_id = c.id
						AND run.status IN ('pending', 'running'))
			),
			owned AS (
				SELECT id, task_id, owner_id FROM stranded
				UNION
				SELECT o.id, o.task_id, s.parent_id FROM owned o
				JOIN sessions s ON s.id = o.owner_id
				WHERE o.owner_id LIKE 'claude-subagent-%' AND s.parent_id IS NOT NULL
			)
			SELECT id, task_id, owner_id FROM owned
			WHERE owner_id NOT LIKE 'claude-subagent-%'`.pipe(
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({
						operation: "getStrandedChildren",
						cause,
					}),
			),
		);

	// Shared by the page and the shelf count, so a count can never match
	// different rows than the list it labels.
	const sessionFilters = (
		scope: SessionScope,
		opts?: {
			roots?: boolean;
			titleQuery?: string;
			excludeArchived?: boolean;
			archivedOnly?: boolean;
		},
	) => {
		const predicates = [sql`project_id IN ${sql.in(scope.projectIds)}`];
		// Archive state lives on the root and hides the whole family.
		if (opts?.excludeArchived)
			predicates.push(
				sql`archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM sessions AS archived_root WHERE archived_root.id = sessions.root_id AND archived_root.archived_at IS NOT NULL)`,
			);
		if (opts?.archivedOnly) predicates.push(sql`archived_at IS NOT NULL`);
		if (opts?.roots) predicates.push(sql`parent_id IS NULL`);
		if (opts?.titleQuery !== undefined) {
			const escapedQuery = opts.titleQuery.replace(/[\\%_]/g, "\\$&");
			const pattern = `%${escapedQuery}%`;
			// SQLite LIKE is ASCII-case-insensitive; we accept non-ASCII case sensitivity until deep search adds a collation.
			predicates.push(sql`title LIKE ${pattern} ESCAPE '\\'`);
		}
		return predicates;
	};

	// `readSessionList` is the only producer of the single session type (ni8.5
	// T-1) — what the shell subscription streams and what the browser holds.
	// The per-row re-query it replaced is gone: a subscriber asks for what moved
	// past a version, never for one row by id. These column aliases do the
	// renaming,
	// so no caller bridges a row into a session; the only step left in code is
	// NULL-to-absent, which SQL cannot express. `listSessions` stays a row read
	// for the server-internal callers that need columns the wire never carries
	// (the status poller's `updated_at`, permission-mode restore).
	//
	// The last three are the notification facts (ni8.23), derived here so that
	// "does this session want me?" is answered once, by the server, in the same
	// read that produces the row — rather than by each client folding a stream of
	// events into a guess. `pending_approvals` is read-only here: the approval
	// projector owns those rows, and both question and permission requests land
	// in it, so the counts cannot drift from what the app is actually blocked on.
	const listSessions = (
		scope: SessionScope,
		opts?: {
			roots?: boolean;
			limit?: number;
			titleQuery?: string;
			excludeArchived?: boolean;
			archivedOnly?: boolean;
			orderColumn?: "updated_at" | "archived_at";
			before?: { at: number; id: string };
		},
	): Effect.Effect<readonly SessionRow[], ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const predicates = sessionFilters(scope, opts);
			const orderColumn = sql(opts?.orderColumn ?? "updated_at");
			if (opts?.before !== undefined) {
				predicates.push(
					sql`(${orderColumn} < ${opts.before.at} OR (${orderColumn} = ${opts.before.at} AND id < ${opts.before.id}))`,
				);
			}
			const limit =
				opts?.limit === undefined ? sql.literal("") : sql`LIMIT ${opts.limit}`;

			// The id DESC tiebreaker makes equal timestamps deterministic. This
			// deliberately replaces the previous arbitrary per-query tie ordering and
			// is required so keyset pages neither duplicate nor skip rows.
			return yield* sql<SessionRow>`
				SELECT * FROM sessions
				WHERE ${sql.and(predicates)}
				ORDER BY ${orderColumn} DESC, id DESC
				${limit}`;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "listSessions",
							cause: e,
						}),
			),
		);

	const countSettledSessions: ReadQueryEffect["countSettledSessions"] = (
		scope,
		opts,
	) =>
		Effect.gen(function* () {
			const predicates = [
				...sessionFilters(scope, opts),
				sql`settled_at IS NOT NULL AND pinned_at IS NULL`,
			];
			const rows = yield* sql<{
				count: number;
			}>`SELECT COUNT(*) AS count FROM sessions
				WHERE ${sql.and(predicates)}`;
			return rows[0]?.count ?? 0;
		}).pipe(
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({
						operation: "countSettledSessions",
						cause,
					}),
			),
		);

	const getSessionLineage = (scope: SessionScope) =>
		Effect.gen(function* () {
			const rows = yield* sql<{
				id: string;
				parent_id: string | null;
				unread: number;
				side_thread: number;
			}>`
				SELECT id, parent_id, unread, side_thread FROM sessions
				WHERE project_id IN ${sql.in(scope.projectIds)}`;
			const counts = yield* sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM sessions
				WHERE project_id IN ${sql.in(scope.projectIds)}`;
			return { rows, count: counts[0]?.count ?? 0 };
		}).pipe(
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({ operation: "getSessionLineage", cause }),
			),
		);

	const listSessionGitRefreshTargets: ReadQueryEffect["listSessionGitRefreshTargets"] =
		(scope, { sessionIds, all }) =>
			Effect.gen(function* () {
				const requested = sql`id IN (SELECT value FROM json_each(${JSON.stringify(sessionIds)}))`;
				const targets = all
					? sql`(${requested} OR (workspace IS NOT NULL
						AND (settled_at IS NULL OR json_extract(workspace, '$.origin') = 'conduit')))`
					: requested;
				const rows = yield* sql<Pick<SessionRow, "id" | "workspace">>`
					SELECT id, workspace FROM sessions
					WHERE project_id IN ${sql.in(scope.projectIds)} AND ${targets}
					ORDER BY updated_at DESC, id DESC`;
				return rows.map((row) => ({
					id: row.id,
					...(row.workspace == null
						? {}
						: {
								workspace: Schema.decodeUnknownSync(
									Schema.fromJsonString(SessionWorkspaceSchema),
								)(row.workspace),
							}),
				}));
			}).pipe(
				Effect.mapError(
					(cause) =>
						new ReadQueryEffectError({
							operation: "listSessionGitRefreshTargets",
							cause,
						}),
				),
			);

	const countPendingApprovalsBySession = (
		scope: SessionScope,
		projectIds: readonly string[] = scope.projectIds,
	): Effect.Effect<
		readonly PendingApprovalCountRow[],
		ReadQueryEffectError | SqlError
	> =>
		Effect.gen(function* () {
			return yield* sql<PendingApprovalCountRow>`
				SELECT session_id, type, COUNT(*) AS pending_count
				FROM pending_approvals
				WHERE status = 'pending'
					AND (type <> 'question' OR COALESCE(json_extract(details, '$.delivery'), '') <> 'async')
					AND session_id IN (SELECT id FROM sessions WHERE project_id IN ${sql.in(projectIds)})
				GROUP BY session_id, type`;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "countPendingApprovalsBySession",
							cause: e,
						}),
			),
		);

	const listSessionInfos: ReadQueryEffect["listSessionInfos"] = (scope, opts) =>
		Effect.gen(function* () {
			const rows = yield* listSessions(scope, opts);
			const projectIds = projects ? yield* Ref.get(projects) : scope.projectIds;
			// Roll-ups (busy, unread, pending counts) only need the listed rows and
			// their descendants. Reading lineage and status for every session made
			// each page cost a full scan of the store, twice.
			const [family, approvals] = yield* Effect.all([
				sql<{
					id: string;
					parent_id: string | null;
					status: string;
					unread: number;
					side_thread: number;
					project_id: string | null;
				}>`
					WITH RECURSIVE family(id) AS (
						SELECT value FROM json_each(${JSON.stringify(rows.map((row) => row.id))})
						UNION
						SELECT child.id FROM sessions child JOIN family ON child.parent_id = family.id
					)
					SELECT id, parent_id, status, unread, side_thread, project_id FROM sessions JOIN family USING (id)`,
				countPendingApprovalsBySession(scope, projectIds),
			]).pipe(
				Effect.mapError((cause) =>
					cause instanceof ReadQueryEffectError
						? cause
						: new ReadQueryEffectError({
								operation: "listSessionInfos",
								cause,
							}),
				),
			);
			const pending = pendingApprovalCountsByType(approvals);
			const registered = new Set(projectIds);
			return sessionRowsToSessionInfoList(rows, {
				contributingSessionIds: new Set(
					family
						.filter(
							(row) =>
								row.project_id !== null && registered.has(row.project_id),
						)
						.map(({ id }) => id),
				),
				sideThreadIds: new Set(
					family.flatMap((row) => (row.side_thread === 1 ? [row.id] : [])),
				),
				parentMap: new Map(
					family.flatMap((row) =>
						row.parent_id === null ? [] : [[row.id, row.parent_id] as const],
					),
				),
				unreadSessionIds: new Set(
					family.flatMap((row) => (row.unread === 1 ? [row.id] : [])),
				),
				statuses: {
					...Object.fromEntries(
						family.map((row) => [row.id, { type: row.status }]),
					),
					...opts?.statuses,
				},
				pendingQuestionCounts: pending.questions,
				pendingPermissionCounts: pending.permissions,
				hintDismissals: opts?.hintDismissals ?? hintDismissals,
				...(opts?.backgroundOf && {
					backgroundOf: opts.backgroundOf,
				}),
			});
		});

	const listPendingClaudeQuestionTools = (scope: SessionScope) =>
		sql
			.unsafe<PendingClaudeQuestionToolRow>(
				`${pendingClaudeQuestionToolsQuery} AND s.project_id IN (SELECT value FROM json_each(?))`,
				[JSON.stringify(scope.projectIds)],
			)
			.pipe(
				Effect.mapError(
					(cause) =>
						new ReadQueryEffectError({
							operation: "listPendingClaudeQuestionTools",
							cause,
						}),
				),
			);

	const getPendingClaudeQuestionTool = (sessionId: string, callId: string) =>
		sql<PendingClaudeQuestionToolRow>`
			SELECT mp.id, mp.call_id, mp.message_id, mp.input, mp.created_at, m.session_id
			FROM message_parts mp
			JOIN messages m ON m.id = mp.message_id
			WHERE m.session_id = ${sessionId}
				AND mp.call_id = ${callId} AND mp.tool_name = 'AskUserQuestion'
				AND mp.status IN ('started', 'running', 'pending')
			LIMIT 1`.pipe(
			Effect.map((rows) => rows[0]),
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({
						operation: "getPendingClaudeQuestionTool",
						cause,
					}),
			),
		);

	const getSessionMessagesWithParts = (
		sessionId: string,
	): Effect.Effect<MessageWithParts[], ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const messages = yield* sql<MessageWithTurnModelRow>`
				SELECT messages.*,
					turns.requested_model AS turn_requested_model,
					turns.expected_model AS turn_expected_model,
					turns.actual_model AS turn_actual_model,
					turns.effort AS turn_effort,
					turns.context_window AS turn_context_window,
					${turnMetadataColumns}
				FROM messages
				LEFT JOIN turns ON turns.id = messages.turn_id
				LEFT JOIN turns t ON t.id = messages.id AND messages.role = 'user'
				WHERE messages.session_id = ${sessionId}
					AND NOT ${pendingRewindHides()}
				ORDER BY messages.created_at ASC, messages.id ASC`;
			if (messages.length === 0) return [];

			const parts = yield* sql<MessagePartRow>`
				WITH target_messages AS (
					SELECT id FROM messages
					WHERE session_id = ${sessionId}
					ORDER BY created_at ASC, id ASC
				)
				SELECT mp.*, ${surfacingMark}, ${fullToolResult} AS result, NULL AS result_bytes
				FROM message_parts mp
				JOIN target_messages tm ON mp.message_id = tm.id
				ORDER BY mp.message_id, mp.sort_order`;

			return groupMessagesWithPartsAndTurnModels(
				messages,
				yield* withPartReadState(parts),
			);
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getSessionMessagesWithParts",
							cause: e,
						}),
			),
		);

	const getSessionSkillMessages: ReadQueryEffect["getSessionSkillMessages"] = (
		sessionId,
	) =>
		Effect.gen(function* () {
			const messages = yield* sql<Omit<SessionSkillMessage, "parts">>`
				SELECT id, role, created_at, CASE WHEN role = 'user' THEN text END AS text
				FROM messages
				WHERE session_id = ${sessionId} AND NOT ${pendingRewindHides()}
				ORDER BY created_at ASC, id ASC`;
			if (messages.length === 0) return [];
			const parts = yield* sql<SessionSkillMessage["parts"][number]>`
				SELECT mp.id, mp.message_id, mp.type, mp.tool_name, mp.input,
					mp.status, mp.created_at, substr(mp.result, 1, 2000) AS result
				FROM message_parts mp JOIN messages m ON mp.message_id = m.id
				WHERE m.session_id = ${sessionId} AND NOT ${pendingRewindHides("m")}
					AND mp.type = 'tool' AND (
						mp.tool_name IN ('Skill', 'skill')
						OR substr(mp.result, 1, 14) = '<skill_content'
						OR substr(mp.result, 1, 16) = 'Launching skill:'
						OR substr(mp.result, 1, 17) = '"Launching skill:'
						OR CASE WHEN json_valid(mp.input) THEN json_extract(mp.input, '$.tool') END = 'Skill'
					)
				ORDER BY mp.message_id, mp.sort_order`;
			const byMessage = new Map<
				string,
				SessionSkillMessage["parts"][number][]
			>();
			for (const part of parts) {
				const group = byMessage.get(part.message_id);
				if (group) group.push(part);
				else byMessage.set(part.message_id, [part]);
			}
			return messages.map((message) => ({
				...message,
				parts: byMessage.get(message.id) ?? [],
			}));
		}).pipe(
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({
						operation: "getSessionSkillMessages",
						cause,
					}),
			),
		);

	const getSessionHistoryMetadata = (sessionId: string) =>
		Effect.gen(function* () {
			const rows = yield* sql<{
				messageCount: number;
				cumulativeTokens: number;
			}>`
				SELECT COUNT(*) AS messageCount,
					COALESCE(SUM(CASE WHEN rest_payload IS NOT NULL OR tokens_in IS NOT NULL
						OR tokens_out IS NOT NULL OR context_window IS NOT NULL
						THEN COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)
							+ COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_write, 0)
						ELSE 0 END), 0) AS cumulativeTokens
				FROM messages m WHERE m.session_id = ${sessionId}
					AND NOT ${pendingRewindHides("m")}
					AND NOT EXISTS (
						SELECT 1 FROM message_parts p WHERE p.message_id = m.id
							AND CASE WHEN json_valid(p.metadata)
								THEN json_type(p.metadata, '$.setup') END = 'object'
					)`;
			const metadata = rows[0];
			if (!metadata)
				return yield* new ReadQueryEffectError({
					operation: "getSessionHistoryMetadata",
					cause: new Error("Missing history metadata row"),
				});
			return metadata;
		}).pipe(
			Effect.mapError((cause) =>
				cause instanceof ReadQueryEffectError
					? cause
					: new ReadQueryEffectError({
							operation: "getSessionHistoryMetadata",
							cause,
						}),
			),
		);

	const getGoalDetails = (sessionId: string) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const row = yield* getSession(sessionId);
					const facts = row
						? yield* Effect.try(() => sessionGoalState(row))
						: undefined;
					const goal = facts?.goal ?? facts?.endedGoal;
					if (!goal)
						return {
							checks: [],
							tokensSinceStart: null,
							judgeModel: null,
							setAt: null,
							metAt: null,
							turnCount: null,
						};

					const checks = yield* sql<GoalDetails["checks"][number]>`
					SELECT iterations AS iteration, created_at AS at, reason,
						turn_index AS turnIndex, judge_model AS judgeModel
					FROM session_goal_checks
					WHERE session_id = ${sessionId} AND set_at = ${goal.setAt}
						AND condition = ${goal.condition}
					ORDER BY iterations ASC`;
					const rows = yield* getSessionMessagesWithParts(sessionId);
					const history = yield* Effect.try(
						() =>
							messageRowsToHistory(rows, { pageSize: Number.MAX_SAFE_INTEGER })
								.messages,
					);
					return {
						checks,
						judgeModel: goal.judgeModel ?? null,
						setAt: goal.setAt,
						metAt: facts?.ended === "met" ? (facts.endedAt ?? null) : null,
						turnCount: goal.turnCount ?? null,
						tokensSinceStart:
							history.reduce(
								(total, message) =>
									total +
									(message.tokens?.input ?? 0) +
									(message.tokens?.output ?? 0) +
									(message.tokens?.cache?.read ?? 0) +
									(message.tokens?.cache?.write ?? 0),
								0,
							) - goal.tokensAtStart,
					};
				}),
			)
			.pipe(
				Effect.mapError(
					(cause) =>
						new ReadQueryEffectError({ operation: "getGoalDetails", cause }),
				),
			);

	// One query per source serves cold start, resume catch-up and every live
	// advance. `version` is the read-model counter, read FIRST inside the
	// transaction so the rows that follow are from the same consistent state:
	// the number handed to a subscriber never claims a row the read missed.
	//
	// A base read is a catch-up from before the first version. The 0012 backfill
	// left undatable rows at 0, so the floor is -1 rather than 0 — otherwise a
	// cold start would silently skip them.
	const BEFORE_FIRST_VERSION = -1;
	// An unbounded read is bounded by a number the counter cannot reach, which
	// keeps one query shape for both the base and a windowed live read.
	const AFTER_LAST_VERSION = Number.MAX_SAFE_INTEGER;

	const readModelVersion = Effect.gen(function* () {
		const rows = yield* sql<{ value: number }>`
			SELECT value FROM read_model_counter WHERE id = 1`;
		return rows[0]?.value ?? 0;
	});

	const readSessionPromptIndex: ReadQueryEffect["readSessionPromptIndex"] = (
		sessionId,
		range,
	) =>
		sql.withTransaction(
			Effect.gen(function* () {
				const version = yield* readModelVersion;
				const floor = range?.after ?? BEFORE_FIRST_VERSION;
				const ceiling = range?.through ?? AFTER_LAST_VERSION;
				const rows = yield* sql<{
					id: string;
					created_at: number;
					preview: string;
					is_inherited: number;
					version: number;
				}>`
				SELECT id, created_at, is_inherited, version,
				substr(text, CASE WHEN instr(text, '<user-message>' || char(10)) > 0
					THEN instr(text, '<user-message>' || char(10)) + length('<user-message>' || char(10)) ELSE 1 END, 960) AS preview
				FROM messages WHERE session_id = ${sessionId} AND role = 'user'
				AND version > ${floor} AND version <= ${ceiling} AND NOT ${pendingRewindHides()}
				ORDER BY created_at, id`;
				const removed =
					range === undefined
						? []
						: yield* sql<{ id: string; version: number }>`
				SELECT message_id AS id, version FROM message_tombstones WHERE session_id = ${sessionId} AND version > ${floor} AND version <= ${ceiling}
				UNION ALL SELECT id, version FROM messages WHERE session_id = ${sessionId} AND (role <> 'user' OR ${pendingRewindHides()}) AND version > ${floor} AND version <= ${ceiling}`;
				return {
					version,
					removed,
					rows: rows.map((row) => ({
						version: row.version,
						item: {
							id: row.id,
							createdAt: row.created_at,
							isInherited: row.is_inherited === 1,
							preview:
								Array.from(
									row.preview
										.split("\n</user-message>")[0]
										?.replace(/\s+/g, " ")
										.trim() ?? "",
								)
									.slice(0, 240)
									.join("") || "Attached files",
						},
					})),
				};
			}),
		);

	const readSessionWindowMetadata = (
		sessionId: string,
		messages: readonly MessageWithParts[],
		kind: "latest" | "historical",
	): Effect.Effect<SessionDetailWindow, SqlError> =>
		Effect.gen(function* () {
			const first = messages[0];
			const last = messages.at(-1);
			if (!first || !last) return { kind, hasEarlier: false, hasLater: false };
			const [availability] = yield* sql<{
				earlier: number;
				later: number;
			}>`SELECT
			EXISTS(SELECT 1 FROM messages WHERE session_id = ${sessionId} AND NOT ${pendingRewindHides()} AND (created_at,id) < (${first.created_at},${first.id})) AS earlier,
			EXISTS(SELECT 1 FROM messages WHERE session_id = ${sessionId} AND NOT ${pendingRewindHides()} AND (created_at,id) > (${last.created_at},${last.id})) AS later`;
			return {
				kind,
				firstMessageId: first.id,
				lastMessageId: last.id,
				hasEarlier: availability?.earlier === 1,
				hasLater: availability?.later === 1,
			};
		});

	const readSessionTranscriptPage = (
		sessionId: string,
		options: SessionTranscriptPageOptions,
	): Effect.Effect<
		{
			readonly messages: MessageWithParts[];
			readonly hasMore: boolean;
			readonly version: number;
			readonly cursor?: string;
			readonly window?: SessionDetailWindow;
		},
		ReadQueryEffectError | SqlError | TranscriptPageCursorNotFoundError
	> =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const version = yield* readModelVersion;
					const bounds = options.bounds;
					const inBounds =
						bounds === undefined
							? sql.literal("1")
							: sql`(messages.created_at, messages.id) >= (${bounds.first.createdAt}, ${bounds.first.id}) AND (messages.created_at, messages.id) <= (${bounds.last.createdAt}, ${bounds.last.id})`;
					const forward = options.forward !== undefined;
					const cursorId = forward ? options.forward?.from : options.before;
					const cursor =
						cursorId !== undefined
							? (yield* sql<{ created_at: number; id: string }>`
									SELECT created_at, id FROM messages
									WHERE session_id = ${sessionId} AND id = ${cursorId} AND NOT ${pendingRewindHides()} AND ${inBounds}`)[0]
							: undefined;
					if (cursorId !== undefined && !cursor) {
						return yield* new TranscriptPageCursorNotFoundError({
							sessionId,
							before: cursorId,
						});
					}
					// The first page reaches back to the newest prompt, or further to
					// the prompt still running, which a prompt queued behind it would
					// otherwise push off the page. A turn left running before a later
					// one settled is a crash leftover and is ignored.
					const [anchor] =
						forward || cursor
							? []
							: yield* sql<{ created_at: number; id: string }>`
								SELECT created_at, id FROM messages
								WHERE session_id = ${sessionId} AND role = 'user' AND NOT ${pendingRewindHides()} AND ${inBounds}
								ORDER BY id IS (
									SELECT id FROM turns
									WHERE session_id = ${sessionId} AND state = 'running'
									AND requested_at >= (SELECT COALESCE(MAX(requested_at), 0) FROM turns
										WHERE session_id = ${sessionId}
										AND state NOT IN ('pending', 'running'))
									ORDER BY requested_at ASC, rowid ASC LIMIT 1
								) DESC, created_at DESC, id DESC
								LIMIT 1`;
					const rows = forward
						? yield* sql<{ id: string; created_at: number }>`
								SELECT messages.id, messages.created_at
								FROM messages
								WHERE messages.session_id = ${sessionId}
									AND NOT ${pendingRewindHides()} AND ${inBounds}
									AND (${cursor?.id ?? null} IS NULL
										OR messages.created_at > ${cursor?.created_at ?? null}
										OR (messages.created_at = ${cursor?.created_at ?? null} AND messages.id ${sql.literal(options.forward?.exclusive ? ">" : ">=")} ${cursor?.id ?? null}))
								ORDER BY messages.created_at ASC, messages.id ASC
								LIMIT ${options.limit + 1}`
						: cursor
							? yield* sql<{ id: string; created_at: number }>`
								SELECT messages.id, messages.created_at
								FROM messages
								WHERE messages.session_id = ${sessionId}
									AND NOT ${pendingRewindHides()} AND ${inBounds}
									AND (messages.created_at < ${cursor.created_at}
										OR (messages.created_at = ${cursor.created_at} AND messages.id < ${cursor.id}))
								ORDER BY messages.created_at DESC, messages.id DESC
								LIMIT ${options.limit + 1}`
							: yield* sql<{ id: string; created_at: number }>`
								SELECT messages.id, messages.created_at
								FROM messages
								WHERE messages.session_id = ${sessionId}
									AND NOT ${pendingRewindHides()} AND ${inBounds}
								ORDER BY messages.created_at DESC, messages.id DESC
								LIMIT (
									SELECT MAX(${options.limit}, COUNT(*)) + 1
									FROM messages m
									WHERE m.session_id = ${sessionId}
										AND NOT ${pendingRewindHides("m")}
										AND (m.created_at > ${anchor?.created_at ?? null}
											OR (m.created_at = ${anchor?.created_at ?? null} AND m.id >= ${anchor?.id ?? null}))
								)`;
					const pageLimit =
						forward || cursor
							? options.limit
							: Math.max(
									options.limit,
									rows.findIndex((message) => message.id === anchor?.id) + 1,
								);
					const page = rows.slice(0, pageLimit);
					const messages: MessageWithParts[] = [];
					if (options.previewTools) {
						let bytes = FRAME_ENVELOPE_BYTES;
						for (const candidate of page) {
							const row = (yield* sql<MessageWithTurnModelRow>`
								SELECT messages.*,
									turns.requested_model AS turn_requested_model,
										turns.expected_model AS turn_expected_model,
										turns.actual_model AS turn_actual_model,
										turns.effort AS turn_effort,
										turns.context_window AS turn_context_window,
										${turnMetadataColumns}
									FROM messages
									LEFT JOIN turns ON turns.id = messages.turn_id
									LEFT JOIN turns t ON t.id = messages.id AND messages.role = 'user'
									WHERE messages.id = ${candidate.id}`)[0];
							if (row === undefined) continue;
							const parts = yield* previewParts(
								sql`FROM message_parts mp WHERE mp.message_id = ${row.id}`,
							);
							const group = groupMessagesWithPartsAndTurnModels([row], parts);
							const projected = messageRowsToHistory(group, {
								pageSize: 1,
							}).messages;
							// Both browser representations must fit: detail rows and the
							// history reply, which also carries the joined message text.
							const weight =
								Math.max(
									Buffer.byteLength(
										JSON.stringify(
											messageRowGroups(group, () => true, projected)[0],
										),
										"utf8",
									),
									Buffer.byteLength(JSON.stringify(projected[0]), "utf8"),
								) + 1;
							// Preserve the newest whole message even when it exceeds the
							// frame. Part paging is a separate protocol change.
							if (messages.length > 0 && bytes + weight > PAGE_FRAME_BUDGET)
								break;
							messages.push(...group);
							bytes += weight;
							if (bytes >= PAGE_FRAME_BUDGET) break;
						}
					} else {
						// Provider replay needs full history, without the browser budget.
						const fullPage =
							page.length === 0
								? []
								: yield* sql<MessageWithTurnModelRow>`
							SELECT messages.*,
								turns.requested_model AS turn_requested_model,
								turns.expected_model AS turn_expected_model,
								turns.actual_model AS turn_actual_model,
								turns.effort AS turn_effort,
								turns.context_window AS turn_context_window,
								${turnMetadataColumns}
							FROM messages
							LEFT JOIN turns ON turns.id = messages.turn_id
							LEFT JOIN turns t ON t.id = messages.id AND messages.role = 'user'
							WHERE messages.id IN ${sql.in(page.map((message) => message.id))}
							ORDER BY messages.created_at ${sql.literal(forward ? "ASC" : "DESC")},
								messages.id ${sql.literal(forward ? "ASC" : "DESC")}`;
						const parts =
							page.length === 0
								? []
								: yield* sql<MessagePartRow>`
							SELECT mp.*, ${surfacingMark}, ${fullToolResult} AS result, NULL AS result_bytes
							FROM message_parts mp
							WHERE mp.message_id IN ${sql.in(page.map((message) => message.id))}
							ORDER BY mp.message_id, mp.sort_order`;
						messages.push(
							...groupMessagesWithPartsAndTurnModels(
								fullPage,
								yield* withPartReadState(parts),
							),
						);
					}
					if (!forward) messages.reverse();
					const window =
						options.windowKind === undefined
							? undefined
							: yield* readSessionWindowMetadata(
									sessionId,
									messages,
									options.windowKind,
								);
					return {
						messages,
						...(window === undefined ? {} : { window }),
						hasMore: rows.length > messages.length,
						version,
						...(messages[0] === undefined ? {} : { cursor: messages[0].id }),
					};
				}),
			)
			.pipe(
				Effect.mapError((cause) =>
					cause instanceof TranscriptPageCursorNotFoundError
						? cause
						: new ReadQueryEffectError({
								operation: "readSessionTranscriptPage",
								cause,
							}),
				),
			);

	const readSessionList = (
		scope: SessionScope,
		range?: {
			readonly after?: number;
			readonly through?: number;
			readonly familyOf?: string;
			readonly viewed?: string;
			readonly hintDismissals?: ReadonlyMap<string, number>;
			readonly backgroundOf?: (
				sessionId: string,
			) => SessionBackground | undefined;
			readonly listing?: boolean;
		},
	): Effect.Effect<
		{
			readonly rows: readonly {
				readonly item: SessionProjection;
				readonly version: number;
			}[];
			readonly version: number;
			readonly removed?: readonly {
				readonly id: string;
				readonly version: number;
				readonly deleted: boolean;
				readonly projectSlug?: string;
			}[];
			readonly removedSince?: number;
			readonly listing?: readonly (readonly [id: string, version: number])[];
		},
		ReadQueryEffectError | SqlError
	> =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const version = yield* readModelVersion;
					const floor = range?.after ?? BEFORE_FIRST_VERSION;
					const ceiling = range?.through ?? AFTER_LAST_VERSION;
					if (range?.familyOf === undefined) {
						// The sidebar table holds each family rolled up already, so
						// this reads the rows that moved and nothing else. A row with
						// no content is a family's tombstone, and a deletion while its
						// session is gone.
						const ranged = range?.after !== undefined;
						const stored = yield* sql<{
							session_id: string;
							project_id: string;
							version: number;
							row: string | null;
							workspace_hint_sequence: number | null;
							deleted: number;
						}>`
							SELECT session_sidebar.session_id, session_sidebar.project_id, session_sidebar.version, row,
								workspace_hint_sequence, sessions.id IS NULL AS deleted
							FROM session_sidebar LEFT JOIN sessions
								ON sessions.id = session_sidebar.session_id
							WHERE session_sidebar.version > ${floor} AND session_sidebar.version <= ${ceiling}
							AND session_sidebar.project_id IN ${sql.in(scope.projectIds)}
							AND (row IS NOT NULL OR ${ranged ? 1 : 0})
							ORDER BY last_activity DESC, session_id DESC`;
						const removedSince = ranged
							? ((yield* sql<{ version: number }>`
									SELECT version FROM session_sidebar_horizon WHERE id = 1`)[0]
									?.version ?? 0)
							: undefined;
						// A cursor the tombstones cannot cover, or one past the store,
						// is answered with a snapshot, so it is not listed.
						const listable =
							range?.listing === true &&
							floor <= version &&
							floor >= (removedSince ?? floor);
						const sidebars = stored.flatMap(({ row }) =>
							row === null ? [] : [decodeSidebarRow(row)],
						);
						// Stored rows aggregate busy children without live task ownership.
						// Read projected statuses once for families with background agents
						// so a foreground sibling still outranks monitoring.
						const members = [
							...new Set(
								sidebars.flatMap((row) =>
									row.members.some((id) =>
										range
											?.backgroundOf?.(id)
											?.tasks.some((task) => task.childSessionId),
									)
										? row.members
										: [],
								),
							),
						];
						const busyMembers =
							members.length === 0
								? undefined
								: new Set(
										(yield* sql<{ id: string }>`
								SELECT id FROM sessions WHERE id IN ${sql.in(members)}
								AND status IN ('busy', 'retry')`).map(({ id }) => id),
									);
						return {
							rows: stored.flatMap(({ row, workspace_hint_sequence }) => {
								if (row === null) return [];
								const sidebar = decodeSidebarRow(row);
								return [
									{
										item: {
											...sidebarItem(sidebar, range?.backgroundOf, busyMembers),
											workspaceHint:
												(range?.hintDismissals ?? hintDismissals)?.get(
													sidebar.session.id,
												) === workspace_hint_sequence
													? undefined
													: sidebar.session.workspaceHint,
										},
										version: sidebar.version,
									},
								];
							}),
							version,
							...(ranged && {
								removed: stored.flatMap((stamp) =>
									stamp.row === null
										? [
												{
													id: stamp.session_id,
													version: stamp.version,
													deleted: stamp.deleted === 1,
													projectSlug: stamp.project_id,
												},
											]
										: [],
								),
							}),
							...(removedSince === undefined ? {} : { removedSince }),
							...(listable && {
								listing: (yield* sql<{ session_id: string; version: number }>`
									SELECT session_id, version FROM session_sidebar
										WHERE row IS NOT NULL AND project_id IN ${sql.in(scope.projectIds)}`).map(
									({ session_id, version }) => [session_id, version] as const,
								),
							}),
						};
					}
					const viewed = range.viewed;
					const bounded =
						viewed !== undefined &&
						range.after === undefined &&
						range.through === undefined;
					let rows = bounded
						? []
						: yield* sql.unsafe<SessionRow & { effective_version: number }>(
								`SELECT * FROM (${sessionFamilyWindowQuery}) WHERE project_id IN (SELECT value FROM json_each(?))`,
								[
									range.familyOf,
									floor,
									ceiling,
									JSON.stringify(scope.projectIds),
								],
							);
					// A window no member moved in costs the window query alone. The
					// roll-ups (busy, unread, pending counts) read only the family: a
					// member's ancestors and descendants are all in it.
					if (!bounded && rows.length === 0) return { rows: [], version };
					const family = yield* sql.unsafe<{
						id: string;
						parent_id: string | null;
						status: string;
						unread: number;
						side_thread: number;
						version: number;
					}>(
						`${sessionFamilyMembersQuery} WHERE project_id IN (SELECT value FROM json_each(?))`,
						[range.familyOf, JSON.stringify(scope.projectIds)],
					);
					const approvals = yield* sql<PendingApprovalCountRow>`
						SELECT session_id, type, COUNT(*) AS pending_count
						FROM pending_approvals
						WHERE status = 'pending'
							AND (type <> 'question' OR COALESCE(json_extract(details, '$.delivery'), '') <> 'async')
							AND session_id IN (SELECT value FROM json_each(${JSON.stringify(family.map((row) => row.id))}))
						GROUP BY session_id, type`;
					const pending = pendingApprovalCountsByType(approvals);
					if (bounded) {
						const members = new Map(family.map((row) => [row.id, row]));
						const selected = new Set<string>();
						const include = (id: string) => {
							for (
								let member = members.get(id);
								member !== undefined && !selected.has(member.id);
								member = members.get(member.parent_id ?? "")
							) {
								selected.add(member.id);
							}
						};
						// Keep the anchor even if the viewed member was deleted.
						include(range.familyOf);
						include(viewed);
						for (const member of family) {
							if (
								(member.side_thread === 1 && member.parent_id === viewed) ||
								member.status === "busy" ||
								member.status === "retry" ||
								pending.questions.has(member.id) ||
								pending.permissions.has(member.id)
							) {
								include(member.id);
							}
							// A live task can open an idle child in the task drawer.
							for (const task of range.backgroundOf?.(member.id)?.tasks ?? []) {
								if (task.childSessionId) include(task.childSessionId);
							}
						}
						// Preserve subtree MAX(version), stopping once an ancestor
						// already carries this version or a newer one.
						const effectiveVersions = new Map<string, number>();
						for (const member of family) {
							let id: string | null = member.id;
							while (id !== null) {
								const previous = effectiveVersions.get(id);
								if (previous !== undefined && previous >= member.version) break;
								effectiveVersions.set(id, member.version);
								id = members.get(id)?.parent_id ?? null;
							}
						}
						rows = (yield* sql<SessionRow>`SELECT * FROM sessions
								WHERE id IN (SELECT value FROM json_each(${JSON.stringify([...selected])}))
								ORDER BY updated_at DESC, id DESC`).map((row) => ({
							...row,
							effective_version: effectiveVersions.get(row.id) ?? row.version,
						}));
					}
					const items = sessionRowsToSessionInfoList(rows, {
						sideThreadIds: new Set(
							family.flatMap((row) => (row.side_thread === 1 ? [row.id] : [])),
						),
						parentMap: new Map(
							family.flatMap((row) =>
								row.parent_id === null
									? []
									: [[row.id, row.parent_id] as const],
							),
						),
						unreadSessionIds: new Set(
							family.flatMap((row) => (row.unread === 1 ? [row.id] : [])),
						),
						statuses: Object.fromEntries(
							family.map((row) => [row.id, { type: row.status }]),
						),
						pendingQuestionCounts: pending.questions,
						pendingPermissionCounts: pending.permissions,
						hintDismissals: range?.hintDismissals ?? hintDismissals,
						...(range?.backgroundOf && {
							backgroundOf: range.backgroundOf,
						}),
					});
					return {
						rows: rows.flatMap((row, index) => {
							const item = items[index];
							if (item === undefined) return [];
							return [
								{
									item,
									version: row.effective_version,
								},
							];
						}),
						version,
					};
				}),
			)
			.pipe(
				Effect.mapError((e) =>
					e instanceof ReadQueryEffectError
						? e
						: new ReadQueryEffectError({
								operation: "readSessionList",
								cause: e,
							}),
				),
			);

	const readPendingApprovals: ReadQueryEffect["readPendingApprovals"] = (
		scope,
		range,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const version = yield* readModelVersion;
					const floor = range?.after ?? BEFORE_FIRST_VERSION;
					const ceiling = range?.through ?? AFTER_LAST_VERSION;
					const rows =
						range === undefined
							? yield* sql<PendingApprovalRow>`
								SELECT id, session_id, type, status, tool_name, input, details, version
								FROM pending_approvals
								WHERE status = 'pending'
									AND session_id IN (SELECT id FROM sessions WHERE project_id IN ${sql.in(scope.projectIds)})
								ORDER BY created_at, id`
							: yield* sql<PendingApprovalRow>`
								SELECT id, session_id, type, status, tool_name, input, details, version
								FROM pending_approvals
								WHERE version > ${floor} AND version <= ${ceiling}
									AND session_id IN (SELECT id FROM sessions WHERE project_id IN ${sql.in(scope.projectIds)})
								ORDER BY version, created_at, id`;
					return { rows, version };
				}),
			)
			.pipe(
				Effect.mapError(
					(cause) =>
						new ReadQueryEffectError({
							operation: "readPendingApprovals",
							cause,
						}),
				),
			);

	const readSessionTranscript = (
		sessionId: string,
		range?: { readonly after?: number; readonly through?: number },
		listing?: TranscriptListingOptions,
	): Effect.Effect<TranscriptWindow, ReadQueryEffectError | SqlError> =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const version = yield* readModelVersion;
					const floor = range?.after ?? BEFORE_FIRST_VERSION;
					const ceiling = range?.through ?? AFTER_LAST_VERSION;
					const from =
						listing?.from === undefined
							? undefined
							: (yield* sql<{ created_at: number; id: string }>`
									SELECT created_at, id FROM messages
									WHERE session_id = ${sessionId} AND id = ${listing.from}`)[0];
					// Ids and versions only: the page, from its first message on (the
					// whole session without one), then whatever moved past the page's
					// version before it. Each half is one index range within the
					// session; a part write stamps its message, so a moved part's
					// message has moved too. A cursor past the store is answered with
					// a snapshot, so it is not listed.
					const inPage =
						from === undefined
							? sql.literal("1")
							: sql`m.created_at >= ${from.created_at}
								AND (m.created_at > ${from.created_at} OR m.id >= ${from.id})`;
					const listed =
						listing === undefined ||
						(listing.from !== undefined && !from) ||
						floor > version
							? undefined
							: {
									messages: yield* sql<{ id: string; version: number }>`
										SELECT m.id, m.version FROM messages m
										WHERE m.session_id = ${sessionId} AND ${inPage}
											AND NOT ${pendingRewindHides("m")}
										${
											from === undefined
												? sql.literal("")
												: sql`UNION ALL
										SELECT m.id, m.version FROM messages m
										WHERE m.session_id = ${sessionId}
											AND m.version > ${listing.since} AND NOT (${inPage})
											AND NOT ${pendingRewindHides("m")}`
										}`,
									parts: yield* sql<{
										messageId: string;
										partId: string;
										version: number;
									}>`
										SELECT mp.message_id AS messageId, mp.id AS partId, mp.version
										FROM messages m JOIN message_parts mp ON mp.message_id = m.id
										WHERE m.session_id = ${sessionId} AND ${inPage}
											AND NOT ${pendingRewindHides("m")}
										${
											from === undefined
												? sql.literal("")
												: sql`UNION ALL
										SELECT mp.message_id, mp.id, mp.version
										FROM messages m CROSS JOIN message_parts mp ON mp.message_id = m.id
										WHERE m.session_id = ${sessionId} AND m.version > ${listing.since}
											AND mp.version > ${listing.since} AND NOT (${inPage})
											AND NOT ${pendingRewindHides("m")}`
										}`,
								};
					// A part write stamps its message too, so a message is never older
					// than its parts: every message with a part in the window is past
					// the floor. Its own version may be past the ceiling; it then
					// comes back only as the parent of the parts that moved.
					const messages = yield* sql<MessageWithTurnModelRow>`
						SELECT messages.*,
							turns.requested_model AS turn_requested_model,
							turns.expected_model AS turn_expected_model,
							turns.actual_model AS turn_actual_model,
							turns.effort AS turn_effort,
							turns.context_window AS turn_context_window,
							${turnMetadataColumns}
						FROM messages
						LEFT JOIN turns ON turns.id = messages.turn_id
						LEFT JOIN turns t ON t.id = messages.id AND messages.role = 'user'
						WHERE messages.session_id = ${sessionId}
							AND NOT ${pendingRewindHides()}
							AND messages.version > ${floor}
						ORDER BY messages.created_at ASC, messages.id ASC`;

					let parts: readonly MessagePartRow[] = [];
					if (messages.length > 0) {
						// The parts that moved, by their own version. A live window is a
						// narrow range, so it starts from idx_message_parts_version
						// (CROSS JOIN fixes the join order; unanalyzed, SQLite would
						// start from the session's messages). A resume has no ceiling
						// and may reach back past every session's writes, so it starts
						// from this session's moved messages instead.
						parts = yield* previewParts(
							range?.through === undefined
								? sql`FROM messages m CROSS JOIN message_parts mp ON mp.message_id = m.id
									WHERE m.session_id = ${sessionId} AND m.version > ${floor}
										AND mp.version > ${floor} AND NOT ${pendingRewindHides("m")}`
								: sql`FROM message_parts mp CROSS JOIN messages m ON m.id = mp.message_id
									WHERE m.session_id = ${sessionId}
										AND mp.version > ${floor} AND mp.version <= ${ceiling}
										AND NOT ${pendingRewindHides("m")}`,
						);
					}
					const removed =
						range === undefined
							? undefined
							: yield* sql<{
									id: string;
									version: number;
								}>`SELECT message_id AS id, version FROM message_tombstones
						WHERE session_id = ${sessionId}
						AND version > ${floor} AND version <= ${ceiling}
						UNION ALL
						SELECT id, version FROM messages
						WHERE session_id = ${sessionId} AND ${pendingRewindHides()}
							AND version > ${floor} AND version <= ${ceiling}
						ORDER BY version, id`;
					const removedParts =
						range === undefined
							? undefined
							: yield* sql<{
									messageId: string;
									partId: string;
									version: number;
								}>`SELECT message_id AS messageId, part_id AS partId, version
						FROM message_part_tombstones
						WHERE session_id = ${sessionId}
						AND version > ${floor} AND version <= ${ceiling}
						ORDER BY version, part_id`;

					return {
						messages: groupMessagesWithPartsAndTurnModels(messages, parts),
						version,
						...(removed === undefined ? {} : { removed }),
						...(removedParts === undefined ? {} : { removedParts }),
						...(listed === undefined ? {} : { listing: listed }),
					};
				}),
			)
			.pipe(
				Effect.mapError((e) =>
					e instanceof ReadQueryEffectError
						? e
						: new ReadQueryEffectError({
								operation: "readSessionTranscript",
								cause: e,
							}),
				),
			);

	const readSessionTranscriptCatchUp: ReadQueryEffect["readSessionTranscriptCatchUp"] =
		(sessionId, after, maxMessages, listing) =>
			sql.withTransaction(
				Effect.gen(function* () {
					// A part write stamps its message, but one moved message can own many
					// parts. Bound both counts before reading bodies or the checksum.
					const changed = yield* sql<{ id: string }>`
					SELECT id FROM messages
					WHERE session_id = ${sessionId} AND version > ${after}
					LIMIT ${maxMessages + 1}`;
					if (changed.length > maxMessages) return "snapshot" as const;
					const maxParts = Math.floor(PAGE_FRAME_BUDGET / PREVIEW_CODE_POINTS);
					const changedParts = yield* sql<{ id: string }>`
					SELECT mp.id FROM messages m
					CROSS JOIN message_parts mp ON mp.message_id = m.id
					WHERE m.session_id = ${sessionId} AND m.version > ${after}
						AND mp.version > ${after}
					LIMIT ${maxParts + 1}`;
					if (changedParts.length > maxParts) return "snapshot" as const;
					return yield* readSessionTranscript(sessionId, { after }, listing);
				}),
			);

	const readInboxState = (sessionId: string) =>
		sql<{
			paused: number;
			prompt_open: number;
			provider: string;
			version: number;
		}>`
			WITH latest_run AS (${inboxRunStatusQuery(sql, sessionId)})
			SELECT version, provider,
				EXISTS (SELECT 1 FROM pending_inputs
					WHERE session_id = ${sessionId} AND state = 'queued')
				AND (((SELECT stopped FROM latest_run) AND NOT EXISTS (
					SELECT 1 FROM events admitted JOIN events resumed
						ON resumed.session_id = admitted.session_id
					WHERE admitted.session_id = ${sessionId} AND admitted.type = 'input.admitted'
						AND resumed.type = 'session.resumed'
						AND resumed.sequence > admitted.sequence
						AND admitted.sequence > COALESCE((SELECT MAX(sequence) FROM events
							WHERE session_id = ${sessionId}
							AND type IN ('turn.interrupted', 'turn.error')), 0)
						AND resumed.sequence > COALESCE((SELECT MAX(requeued.sequence) FROM events requeued
							WHERE requeued.session_id = ${sessionId} AND requeued.type = 'input.requeued'
								AND json_extract(requeued.data, '$.reason') = 'failed'
								AND requeued.sequence = (SELECT MIN(first.sequence) FROM events first
									WHERE first.session_id = ${sessionId} AND first.type = 'input.requeued'
									AND json_extract(first.data, '$.sentSequence') = json_extract(requeued.data, '$.sentSequence'))
								AND json_extract(requeued.data, '$.sentSequence') = (SELECT MAX(sent.sequence) FROM events sent
									WHERE sent.session_id = ${sessionId} AND sent.type = 'input.sent'
									AND json_extract(sent.data, '$.inputId') = json_extract(requeued.data, '$.inputId'))
								AND requeued.sequence > COALESCE((SELECT MAX(sequence) FROM events
									WHERE session_id = ${sessionId} AND (type = 'input.sent'
										OR (type = 'session.resume_cancelled'
											AND json_extract(metadata, '$.source') = 'inbox-reset'))), 0)), 0)))
					OR json_extract(limit_recovery, '$.cutOffMessageId') IS NOT NULL
					OR (NOT json_extract(limit_recovery, '$.continued')
						AND COALESCE((SELECT MAX(sequence) FROM events
							WHERE session_id = ${sessionId} AND type = 'session.resume_scheduled'), 0)
							> COALESCE((SELECT MAX(sequence) FROM events
								WHERE session_id = ${sessionId} AND type = 'session.cut_off_dismissed'), 0))) AS paused,
				EXISTS (SELECT 1 FROM pending_approvals
					WHERE session_id = ${sessionId} AND status = 'pending'
						AND (type <> 'question' OR COALESCE(json_extract(details, '$.delivery'), '') <> 'async')) AS prompt_open
			FROM sessions WHERE id = ${sessionId}
				AND EXISTS (SELECT 1 FROM pending_inputs WHERE session_id = ${sessionId})`.pipe(
			Effect.map(([row]) =>
				row
					? {
							paused: row.paused === 1,
							promptOpen: row.prompt_open === 1,
							provider: row.provider,
							version: row.version,
						}
					: undefined,
			),
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({ operation: "readInboxState", cause }),
			),
		);

	const readStoreIdentity = () =>
		sql<{ value: string }>`SELECT value FROM store_identity WHERE id = 1`.pipe(
			Effect.map(([row]) => row?.value),
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({ operation: "readStoreIdentity", cause }),
			),
		);

	const readPendingInputs = (
		sessionId: string,
		range: { readonly after?: number; readonly through: number },
	) =>
		Effect.gen(function* () {
			const floor = range.after ?? BEFORE_FIRST_VERSION;
			const rows = yield* sql<{
				input_id: string;
				state: "queued" | "steering" | "removed";
				request: string;
				admitted_at: number;
				version: number;
			}>`
				SELECT input_id, state, request, admitted_at, version FROM pending_inputs
				WHERE session_id = ${sessionId}
					AND version > ${floor} AND version <= ${range.through}
				ORDER BY admitted_at, rowid`;
			const live: PendingInputRow[] = [];
			const removed: { id: string; version: number }[] = [];
			for (const row of rows) {
				if (row.state === "removed") {
					if (range.after !== undefined)
						removed.push({ id: `input:${row.input_id}`, version: row.version });
					continue;
				}
				live.push({
					inputId: row.input_id,
					state: row.state,
					request: yield* decodeInputRequest(row.request),
					admittedAt: row.admitted_at,
					version: row.version,
				});
			}
			return { rows: live, removed };
		}).pipe(
			Effect.mapError((cause) =>
				cause instanceof ReadQueryEffectError
					? cause
					: new ReadQueryEffectError({ operation: "readPendingInputs", cause }),
			),
		);
	const readSessionTodos = (
		sessionId: string,
		range?: { readonly after?: number; readonly through?: number },
	): Effect.Effect<
		{
			readonly rows: readonly {
				readonly item: SessionTodos;
				readonly version: number;
			}[];
			readonly version: number;
		},
		ReadQueryEffectError | SqlError
	> =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const version = yield* readModelVersion;
					const floor = range?.after ?? BEFORE_FIRST_VERSION;
					const ceiling = range?.through ?? AFTER_LAST_VERSION;
					const moved =
						range === undefined
							? undefined
							: ((yield* sql<{ moved: number | null }>`
						SELECT MAX(v) AS moved FROM (
							SELECT messages.version AS v FROM messages
							JOIN message_parts mp ON mp.message_id = messages.id
							WHERE messages.session_id = ${sessionId}
								AND messages.version > ${floor} AND messages.version <= ${ceiling}
								AND mp.tool_name = 'TodoWrite'
							UNION ALL
							SELECT version AS v FROM message_tombstones
							WHERE session_id = ${sessionId}
								AND version > ${floor} AND version <= ${ceiling}
						)`)[0]?.moved ?? null);
					if (moved === null) return { rows: [], version };
					// The newest few writes are plenty: the first one that still
					// parses is the list, and older ones are history.
					const writes = yield* sql<{
						input: string | null;
						result: string | null;
						version: number;
					}>`
						SELECT mp.input, ${fullToolResult} AS result, messages.version
						FROM message_parts mp
						JOIN messages ON messages.id = mp.message_id
						WHERE messages.session_id = ${sessionId}
							AND NOT ${pendingRewindHides()}
							AND messages.version <= ${ceiling}
							AND mp.tool_name = 'TodoWrite' AND mp.status = 'completed'
						ORDER BY messages.created_at DESC, messages.id DESC, mp.sort_order DESC
						LIMIT 10`;
					const items =
						writes
							.map((write) => todoWriteItems(write.input, write.result))
							.find((parsed) => parsed !== undefined) ?? [];
					return {
						rows: [
							{
								item: { sessionId, items },
								version: moved ?? writes[0]?.version ?? 0,
							},
						],
						version,
					};
				}),
			)
			.pipe(
				Effect.mapError((e) =>
					e instanceof ReadQueryEffectError
						? e
						: new ReadQueryEffectError({
								operation: "readSessionTodos",
								cause: e,
							}),
				),
			);

	const getLatestTurnModelExecution = (
		sessionId: string,
	): Effect.Effect<
		TurnModelExecutionRow | undefined,
		ReadQueryEffectError | SqlError
	> =>
		Effect.gen(function* () {
			const rows = yield* sql<TurnModelExecutionRow>`
				SELECT requested_model, expected_model, actual_model, effort, context_window
				FROM turns
				WHERE session_id = ${sessionId}
					AND actual_model IS NOT NULL
				ORDER BY requested_at DESC
				LIMIT 1`;
			return rows[0];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getLatestTurnModelExecution",
							cause: e,
						}),
			),
		);

	return {
		readToolDetails,
		getSessionStatus,
		getSession,
		getSessionFamilyRoot,
		getGoalDetails,
		getAllSessionStatuses,
		getAllSessionStatusesWithProviders,
		listSessions,
		countSettledSessions,
		listSessionInfos,
		listSessionGitRefreshTargets,
		getSessionLineage,
		getSessionsForReconciliation,
		getStrandedChildren,
		countPendingApprovalsBySession,
		readPendingApprovals,
		listPendingClaudeQuestionTools,
		getPendingClaudeQuestionTool,
		getSessionMessagesWithParts,
		getSessionSkillMessages,
		getSessionHistoryMetadata,
		readSessionTranscriptPage,
		readSessionPromptIndex,
		readSessionList,
		readSessionTranscript,
		readSessionTranscriptCatchUp,
		readSessionTodos,
		getLatestTurnModelExecution,
		readPendingInputs,
		readInboxState,
		readStoreIdentity,
	} satisfies ReadQueryEffect;
});

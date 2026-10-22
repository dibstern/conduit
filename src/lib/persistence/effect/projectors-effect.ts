// Each projector's `project` method is an Effect program over @effect/sql SqlClient.

import { Data, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { getProviderDriver } from "../../contracts/provider-instance.js";
import type { ReadModelCollection } from "../../contracts/read-model-advance.js";
import type { SessionGoalChangedPayload } from "../../contracts/stored-event.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import { CLAUDE_WORKTREE_EVENTS } from "../../session/claude-worktree-state.js";
import { isRecord } from "../../utils.js";
import type { LiveEventType, StoredEvent } from "../events.js";
import { type Check, detectGoalStuck } from "../goal-stuck-detector.js";
import {
	getSessionStatements,
	isHumanSentMessage,
	isSessionRemoval,
	REMOVE_SESSION_SQL,
	SESSION_HANDLED_TYPES,
	SESSION_SUBTREE_SQL,
} from "../projectors/session-handlers.js";
import { PAGE_MESSAGES } from "../session-history-adapter.js";
import {
	NEVER_CUT_TOOL_NAMES,
	PREVIEW_CODE_POINTS,
} from "../tool-wire-projection.js";
import { inheritForkHistory } from "./inherit-fork-history.js";
import { makeProviderStateEffect } from "./provider-state-effect.js";
import { rerootSession } from "./sidebar-projection.js";

export class ProjectionError extends Data.TaggedError("ProjectionError")<{
	readonly projector: string;
	readonly operation: string;
	readonly cause: unknown;
}> {}

export interface ProjectionContext {
	/**
	 * The read-model version every row this projection touches is stamped with.
	 * It comes from the monotone read-model counter, never from the event: an
	 * event sequence goes backwards on replay, and a row that moves backwards is
	 * a row a subscriber never hears about again.
	 */
	readonly version: number;
	readonly replaying?: boolean;
	/**
	 * Set by a batch: message stamps collect here and run once at the end. A
	 * batch shares one version, so stamping a message per event repeats the same
	 * write, and a forked history makes that tens of thousands of statements.
	 */
	readonly deferredMessageStamps?: Set<string>;
	/** Exact event IDs which moved a run to terminal in this transaction. */
	readonly endedRunEvents?: Set<string>;
}

/**
 * What one projection did, in the only two terms a subscriber can act on:
 * sessions to re-query, and sessions to drop.
 *
 * The split is decided by the database, not declared by the projector. Every
 * statement names the rows it wrote through `RETURNING`; the stamp pass then
 * separates them — a row still there takes the version and is `stamped`, and a
 * row the statement wrote but that is no longer there was removed underneath
 * it, by its own removal or by the cascade that followed one. So a projector
 * can neither stamp a row it did not write, nor stay quiet about one it
 * removed.
 */
export interface ProjectionTouch {
	readonly stamped: readonly string[];
	readonly removed: readonly string[];
	readonly collections: readonly ReadModelCollection[];
	/**
	 * Sessions whose family's sidebar row this projection may have changed,
	 * or that held a row before it. The runner refreshes them all once per
	 * transaction, not once per projection.
	 */
	readonly sidebar?: readonly string[];
}

/**
 * Collapse touches into the outcome each session actually ended the commit
 * with, later touches winning over earlier ones.
 *
 * Order is the whole point: a commit that deletes a session and recreates it
 * leaves a live row, and one that creates then deletes leaves nothing. Taking
 * the union and letting removal win would announce the surviving row as gone,
 * and a subscriber would drop a session that is still there. Folding in order
 * is also what keeps the two lists disjoint, so nobody downstream has to
 * reconcile them.
 */
export const mergeTouches = (
	touches: Iterable<ProjectionTouch>,
): ProjectionTouch => {
	const live = new Map<string, boolean>();
	const sidebar = new Set<string>();
	const collections = new Set<ReadModelCollection>();
	for (const touch of touches) {
		for (const sessionId of touch.stamped) live.set(sessionId, true);
		for (const sessionId of touch.removed) live.set(sessionId, false);
		for (const sessionId of touch.sidebar ?? []) sidebar.add(sessionId);
		for (const collection of touch.collections) collections.add(collection);
	}
	if (sidebar.size > 0) collections.add("sidebar");
	return {
		stamped: [...live].filter(([, alive]) => alive).map(([id]) => id),
		removed: [...live].filter(([, alive]) => !alive).map(([id]) => id),
		collections: [...collections],
		...(sidebar.size > 0 ? { sidebar: [...sidebar] } : {}),
	};
};

export interface EffectProjector {
	readonly name: string;
	readonly handles: readonly LiveEventType[];
	/**
	 * Apply the event, then report what moved and what is gone. The projection
	 * runner needs nothing from the caller to know either.
	 */
	readonly project: (
		event: StoredEvent,
		ctx: ProjectionContext,
	) => Effect.Effect<
		ProjectionTouch,
		ProjectionError | SqlError,
		SqlClient.SqlClient
	>;
}

export function defineProjector<
	const Types extends readonly [LiveEventType, ...LiveEventType[]],
>(
	makeProjector: () => {
		readonly name: string;
		readonly handles: Types;
		readonly project: (
			event: Extract<StoredEvent, { type: NoInfer<Types[number]> }>,
			ctx: ProjectionContext,
		) => ReturnType<EffectProjector["project"]>;
	},
): () => Omit<EffectProjector, "handles"> & { readonly handles: Types } {
	// The runner dispatches only events in handles. Erase the narrowed input at
	// that boundary while retaining the literal list for the coverage check.
	return makeProjector as () => Omit<EffectProjector, "handles"> & {
		readonly handles: Types;
	};
}

function isEventType<E extends StoredEvent, K extends E["type"]>(
	event: E,
	type: K,
): event is Extract<E, { type: K }> {
	return event.type === type;
}

// A child-table row naming the session row it belongs to. `turns`,
// `pending_approvals` and `session_providers` move the session row that owns
// them (pending_approvals also has a version, for its own subscription), and
// the owner is whatever the write itself put in `session_id`, not what the
// event header says.
interface OwnedRow {
	readonly session_id: string;
}

const owners = (rows: readonly OwnedRow[]): readonly string[] =>
	rows.map((row) => row.session_id);

// A row a statement reports having written, via `RETURNING id`. An empty result
// is the whole point: a declined guard, an ignored conflict and an update that
// matched nothing all come back with no rows, and so announce nothing.
const ids = (rows: readonly { readonly id: string }[]): readonly string[] =>
	rows.map((row) => row.id);

// Stamping is unconditional. `version` is the read-model counter, not the event
// sequence, so a replayed write is still a write: it takes the next counter
// value and the row moves forward whatever it carried before. Under the old
// sequence stamp a replay could rewrite a row's payload and leave its version
// behind, and a subscriber holding that version never heard about the change.
//
// `RETURNING` reports only rows that were really there, so an UPDATE against a
// missing or already-deleted row announces nothing.
const stampSessions = (
	sessionIds: readonly string[],
	version: number,
): Effect.Effect<ProjectionTouch, SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const stamped: string[] = [];
		const removed: string[] = [];
		for (const sessionId of new Set(sessionIds)) {
			const rows = yield* sql<{ id: string }>`
				UPDATE sessions SET version = ${version}
				WHERE id = ${sessionId}
				RETURNING id`;
			// The row was written a moment ago and is not here now: it went under
			// this same event, by a removal statement or by the cascade one set off.
			// Nothing declares that — the UPDATE that matched nothing is the report.
			if (rows.length === 0) removed.push(sessionId);
			else stamped.push(...rows.map((row) => row.id));
		}
		return {
			stamped,
			removed,
			collections: stamped.length > 0 || removed.length > 0 ? ["sessions"] : [],
		};
	});

const HUMAN_USER_MESSAGE_SQL =
	"messages.is_human_sent = 1 AND messages.role = 'user' AND messages.is_inherited = 0";

function jsonRecord(value: string | null): Record<string, unknown> {
	const parsed: unknown = value === null ? undefined : JSON.parse(value);
	return isRecord(parsed) ? parsed : {};
}

const refreshLastUserMessageAt = (sessionId: string, version: number) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [latest] = yield* sql<{ created_at: number | null }>`
			SELECT MAX(messages.created_at) AS created_at FROM messages
			WHERE messages.session_id = ${sessionId} AND ${sql.literal(HUMAN_USER_MESSAGE_SQL)}`;
		return ids(
			yield* sql<{ id: string }>`
			UPDATE sessions SET last_user_message_at = ${latest?.created_at ?? null}, version = ${version}
			WHERE id = ${sessionId} AND last_user_message_at IS NOT ${latest?.created_at ?? null}
			RETURNING id`,
		);
	});

// Takes the messages the handler reported writing, not the id in the event
// header: a guard that declined and a conflict that was ignored both report
// nothing, and a row nobody wrote must not be announced as changed.
//
// Returns the owning session rather than the event's own, because a subagent
// message is stored against the subagent session and that is the row a
// subscriber must re-query. A part write stamps the part itself and also
// advances the message that owns it, whose updated_at moved with it.
export const stampMessage = (
	messageIds: readonly string[],
	ctx: ProjectionContext,
): Effect.Effect<ProjectionTouch, SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		if (ctx.deferredMessageStamps) {
			for (const messageId of messageIds)
				ctx.deferredMessageStamps.add(messageId);
			return { stamped: [], removed: [], collections: [] };
		}
		const { version } = ctx;
		const sql = yield* SqlClient.SqlClient;
		const stamped: string[] = [];
		const changedSessions: string[] = [];
		for (const messageId of new Set(messageIds)) {
			const rows = yield* sql<
				OwnedRow & { readonly created_at: number; readonly human_sent: number }
			>`
				UPDATE messages SET version = ${version}
				WHERE id = ${messageId}
				RETURNING session_id, created_at, (${sql.literal(HUMAN_USER_MESSAGE_SQL)}) AS human_sent`;
			// The fork split uses the copy's stored clock, including when a
			// snapshot replaces a streamed row with a provider timestamp.
			for (const row of rows) {
				if (row.human_sent) {
					changedSessions.push(
						...ids(
							yield* sql<{ id: string }>`
						UPDATE sessions SET last_user_message_at = MAX(COALESCE(last_user_message_at, ${row.created_at}), ${row.created_at}),
							version = ${version}
						WHERE id = ${row.session_id}
						AND (last_user_message_at IS NULL OR last_user_message_at < ${row.created_at})
						RETURNING id`,
						),
					);
				}
				changedSessions.push(
					...ids(
						yield* sql<{
							id: string;
						}>`UPDATE sessions SET fork_point_timestamp = ${row.created_at},
					version = ${version}
					WHERE id = ${row.session_id} AND fork_point_event = ${messageId}
					AND fork_point_timestamp IS NOT ${row.created_at} RETURNING id`,
					),
				);
			}
			stamped.push(...owners(rows));
		}
		// A message row that vanished under its own event went with the session
		// that owned it, and the session projector reports that removal by name.
		// Nothing to add here: the missing id is a message id, and the advance
		// speaks in sessions.
		const collections: ReadModelCollection[] = [];
		if (stamped.length > 0) collections.push("messages");
		if (changedSessions.length > 0) collections.push("sessions");
		return {
			stamped,
			removed: [],
			collections,
			...(changedSessions.length > 0 ? { sidebar: changedSessions } : {}),
		};
	});

const removeMessages = (
	sessionId: string,
	messageIds: readonly string[],
	ctx: ProjectionContext,
): Effect.Effect<ProjectionTouch, SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		if (messageIds.length === 0)
			return { stamped: [], removed: [], collections: [] };
		const sql = yield* SqlClient.SqlClient;
		const list = JSON.stringify(messageIds);
		// A pending stamp can move a fork's clock. Preserve that clock before
		// deleting its message, without stamping each disappearing row.
		const pending = messageIds.filter((id) =>
			ctx.deferredMessageStamps?.delete(id),
		);
		const forkChanges =
			pending.length === 0
				? []
				: ids(
						yield* sql<{ id: string }>`UPDATE sessions SET
				fork_point_timestamp = (SELECT created_at FROM messages WHERE id = fork_point_event AND session_id = ${sessionId}),
				version = ${ctx.version}
				WHERE id = ${sessionId}
				AND fork_point_event IN (SELECT value FROM json_each(${JSON.stringify(pending)}))
				AND EXISTS (SELECT 1 FROM messages WHERE id = fork_point_event AND session_id = ${sessionId}
					AND created_at IS NOT fork_point_timestamp)
				RETURNING id`,
					);
		yield* sql`UPDATE turns SET
			user_message_id = CASE WHEN user_message_id IN (SELECT value FROM json_each(${list})) THEN NULL ELSE user_message_id END,
			assistant_message_id = CASE WHEN assistant_message_id IN (SELECT value FROM json_each(${list})) THEN NULL ELSE assistant_message_id END
			WHERE session_id = ${sessionId} AND (
				user_message_id IN (SELECT value FROM json_each(${list}))
				OR assistant_message_id IN (SELECT value FROM json_each(${list})))`;
		yield* sql`DELETE FROM messages WHERE session_id = ${sessionId}
			AND id IN (SELECT value FROM json_each(${list}))`;
		yield* sql`INSERT INTO message_tombstones (session_id, message_id, version)
			SELECT ${sessionId}, value, ${ctx.version} FROM json_each(${list}) WHERE true
			ON CONFLICT (message_id) DO UPDATE SET
			session_id = excluded.session_id, version = excluded.version`;
		const changed = [
			...forkChanges,
			...(yield* refreshLastUserMessageAt(sessionId, ctx.version)),
		];
		return {
			...(yield* stampSessions([sessionId], ctx.version)),
			collections:
				changed.length > 0
					? ["sessions", "messages", "sidebar"]
					: ["sessions", "messages"],
			...(changed.length > 0 ? { sidebar: [...new Set(changed)] } : {}),
		};
	});

interface RewindCut {
	readonly id: string;
	readonly created_at: number;
}

const restampRewind = (
	sessionId: string,
	previousCut: RewindCut | null | undefined,
	cut: RewindCut | null | undefined,
	version: number,
): Effect.Effect<readonly string[], SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		// Old events did not carry the preceding cut. A missing cut row also
		// leaves its ordering unknown, so preserve the full-restamp behavior.
		if (previousCut === undefined || cut === undefined) {
			yield* sql`UPDATE message_parts SET version = ${version}
				WHERE message_id IN (SELECT id FROM messages WHERE session_id = ${sessionId})`;
			return ids(
				yield* sql<{
					id: string;
				}>`SELECT id FROM messages WHERE session_id = ${sessionId}`,
			);
		}
		const boundary = previousCut ?? cut;
		// Either range starts at the earlier cut in SQLite's (created_at, id)
		// ordering. Null means no pending cut, i.e. no hidden messages.
		const affected =
			previousCut && cut
				? sql`(created_at, id) >= (${previousCut.created_at}, ${previousCut.id})
					OR (created_at, id) >= (${cut.created_at}, ${cut.id})`
				: boundary
					? sql`(created_at, id) >= (${boundary.created_at}, ${boundary.id})`
					: sql.literal("0");
		const visible = cut
			? sql`(created_at, id) < (${cut.created_at}, ${cut.id})`
			: sql.literal("1");
		const restored = previousCut
			? sql`(created_at, id) >= (${previousCut.created_at}, ${previousCut.id})`
			: sql.literal("0");
		const page = sql`SELECT id FROM messages WHERE session_id = ${sessionId}
			AND ${visible} ORDER BY created_at DESC, id DESC LIMIT ${PAGE_MESSAGES}`;
		// Hidden messages need only headers for removals. Restored messages and
		// the visible page before the new cut need their parts and headers whole.
		yield* sql`UPDATE message_parts SET version = ${version} WHERE message_id IN (
			SELECT id FROM messages WHERE session_id = ${sessionId} AND ${restored} AND ${visible}
			UNION SELECT id FROM (${page})
		)`;
		return ids(
			yield* sql<{ id: string }>`SELECT id FROM messages
				WHERE session_id = ${sessionId} AND (${affected})
				UNION SELECT id FROM (${page})`,
		);
	});

function encodeJson(value: unknown): string {
	if (value === undefined) return "null";
	return JSON.stringify(value);
}

/** Shallow-merge new tool metadata into the stored JSON object. Corrupt stored metadata is logged and kept as-is. */
function mergeMetadata(
	current: string | null,
	next: Record<string, unknown> | undefined,
	sessionId: string,
	partId: string,
): Effect.Effect<string | null> {
	if (next === undefined) return Effect.succeed(current);
	if (current == null) return Effect.succeed(encodeJson(next));
	const keepCorrupt = (reason: string) =>
		Effect.logError(
			`Unable to merge corrupt message part metadata for session ${sessionId}, part ${partId}; preserving stored metadata: ${reason}`,
		).pipe(Effect.as(current));
	try {
		const parsed: unknown = JSON.parse(current);
		return isRecord(parsed)
			? Effect.succeed(encodeJson({ ...parsed, ...next }))
			: keepCorrupt("Stored metadata must be a JSON object");
	} catch (error) {
		return keepCorrupt(error instanceof Error ? error.message : String(error));
	}
}

export const makeSessionProjector = defineProjector(() => ({
	name: "session",
	handles: SESSION_HANDLED_TYPES,
	project: (event, ctx) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const terminal = runTerminalStatus(event, event.provider) !== undefined;
			// Fork copies preserve historical attention without creating runs or settling live work.
			if (
				event.metadata.inherited &&
				["turn.completed", "turn.error", "turn.interrupted"].includes(
					event.type,
				)
			) {
				const updated = yield* sql<{
					id: string;
				}>`UPDATE sessions SET last_turn_end_version = ${event.streamVersion}
					WHERE id = ${event.sessionId} AND COALESCE(last_turn_end_version, -1) < ${event.streamVersion}
					RETURNING id`;
				return {
					...(yield* stampSessions(ids(updated), ctx.version)),
					sidebar: ids(updated),
				};
			}
			if (event.type === "turn.completed" && !terminal)
				return { stamped: [], removed: [], collections: [] };
			const unownedStatus =
				event.type === "session.status" && !event.metadata.runId;
			if (terminal && unownedStatus) {
				// An orphan status observation may move; it cannot end owned work.
				const open =
					yield* sql`SELECT 1 FROM provider_runs WHERE session_id = ${event.sessionId}
					AND status IN ('pending', 'running') LIMIT 1`;
				if (open.length) return { stamped: [], removed: [], collections: [] };
			}
			if (
				(terminal && !unownedStatus) ||
				(event.type === "session.status" && event.metadata.runId)
			) {
				const runId = event.metadata.runId;
				if (!runId) return { stamped: [], removed: [], collections: [] };
				const [run] = yield* sql<{
					status: string;
					completed_at: number | null;
				}>`SELECT status, completed_at FROM provider_runs
					WHERE id = ${runId} AND session_id = ${event.sessionId}`;
				if (!run) return { stamped: [], removed: [], collections: [] };
				const open = run.status === "pending" || run.status === "running";
				if (
					terminal &&
					!open &&
					!(ctx.replaying && run.completed_at === event.createdAt)
				)
					return { stamped: [], removed: [], collections: [] };
				if (event.type === "session.status" && !open) {
					const newer =
						yield* sql`SELECT 1 FROM provider_runs WHERE session_id = ${event.sessionId}
						AND id <> ${runId} AND status IN ('pending', 'running') LIMIT 1`;
					if (newer.length)
						return { stamped: [], removed: [], collections: [] };
					// A background task can wake Claude into a turn on its ended run;
					// that busy is the only sign it is working. Take it only where
					// the run's later idle stays a plain status, never dropped as a
					// second terminal, so it cannot leave the session stuck busy.
					if (
						(event.data.status === "busy" || event.data.status === "retry") &&
						runTerminalStatus(
							{ type: "session.status", data: { status: "idle" } },
							event.provider,
						) !== undefined
					)
						return { stamped: [], removed: [], collections: [] };
				}
			}

			if (event.type === "session.created") {
				for (const id of [event.data.parentId, event.data.forkedFrom]) {
					if (id === undefined) continue;
					const [row] = yield* sql`SELECT id FROM sessions WHERE id = ${id}`;
					if (!row) return { stamped: [], removed: [], collections: [] };
				}
			}
			const written: string[] = [];
			// Families this event can take members from, which naming the
			// sessions it wrote does not reach.
			const left: string[] = [];

			let goalFacts: SessionGoalChangedPayload | undefined;
			let goalTurnIndex: number | null = null;
			if (event.type === "session.goal_changed") {
				const goal = event.data.goal ?? event.data.endedGoal;
				if (goal) {
					const until = event.data.endedAt ?? event.createdAt;
					// Checks can run before turn.completed, and several checks may
					// belong to one turn. Queued inputs have not run a turn yet.
					const [turns] = yield* sql<{
						turnIndex: number | null;
						turnCount: number;
					}>`
						SELECT NULLIF(COUNT(*), 0) AS turnIndex,
							COALESCE(SUM(CASE WHEN COALESCE(completed_at, ${until}) >= ${goal.setAt} THEN 1 ELSE 0 END), 0) AS turnCount
						FROM turns WHERE session_id = ${event.data.sessionId}
						AND state != 'pending' AND COALESCE(started_at, requested_at) <= ${until}`;
					goalTurnIndex = turns?.turnIndex ?? null;
					const countedGoal = { ...goal, turnCount: turns?.turnCount ?? 0 };
					// The completion timestamp bounds ended totals on resync too.
					goalFacts = event.data.goal
						? { ...event.data, goal: countedGoal }
						: { ...event.data, endedGoal: countedGoal };
				}
			}
			const checkedGoal =
				event.type === "session.goal_changed"
					? (event.data.goal ??
						(event.data.ended === "met" ? event.data.endedGoal : undefined))
					: undefined;
			if (event.type === "session.goal_changed" && checkedGoal) {
				const goal = checkedGoal;
				// Read the preceding fact before replacing it. Pauses and status
				// resyncs with unchanged iterations do not create another check.
				yield* sql`INSERT OR IGNORE INTO session_goal_checks
					(event_id, session_id, condition, set_at, iterations, reason, created_at, turn_index, judge_model)
					SELECT ${event.eventId}, id, ${goal.condition}, ${goal.setAt},
						${goal.iterations}, ${goal.lastReason ?? null}, ${event.createdAt},
						${goalTurnIndex},
						${goal.judgeModel ?? null}
					FROM sessions WHERE id = ${event.data.sessionId}
					AND ${goal.iterations} > CASE
						WHEN COALESCE(json_extract(goal_state, '$.goal.setAt'), json_extract(goal_state, '$.endedGoal.setAt')) = ${goal.setAt}
							AND COALESCE(json_extract(goal_state, '$.goal.condition'), json_extract(goal_state, '$.endedGoal.condition')) = ${goal.condition}
							THEN COALESCE(json_extract(goal_state, '$.goal.iterations'), json_extract(goal_state, '$.endedGoal.iterations'), 0)
						ELSE 0 END`;
				if (goal.judgeModel) {
					// A terminal transcript attachment may report the judge after
					// active_goal already reported this check's iteration.
					yield* sql`UPDATE session_goal_checks SET judge_model = ${goal.judgeModel}
						WHERE session_id = ${event.data.sessionId} AND set_at = ${goal.setAt}
						AND condition = ${goal.condition} AND iterations = ${goal.iterations}
						AND judge_model IS NULL`;
				}
			}

			// Every session statement is a single-table write against `sessions`
			// keyed by id, so `RETURNING id` names exactly the rows it wrote: the
			// subagent row for a message filed under its parent, and nothing at
			// all when the auto-title guard declines the rename.
			//
			// A removal is named instead of written, because `RETURNING` cannot
			// report what the cascade takes: the subtree is read first, then the
			// session row goes and the cascade takes the rest. Both arms feed the
			// same list — the stamp pass is what tells a row that moved from one
			// that is gone.
			const [worktree] = CLAUDE_WORKTREE_EVENTS.has(event.type)
				? yield* sql<{ claude_worktree_state: string | null }>`
					SELECT claude_worktree_state FROM sessions
					WHERE id = ${event.sessionId}`
				: [];
			for (const stmt of getSessionStatements(
				event.type === "session.goal_changed" && goalFacts
					? { ...event, data: goalFacts }
					: event,
				worktree?.claude_worktree_state,
			)) {
				if (isSessionRemoval(stmt)) {
					const subtree = yield* sql.unsafe<{ id: string }>(
						SESSION_SUBTREE_SQL,
						[stmt.removeSession],
					);
					// SET NULL preserves Forks of any Source in this subtree. Their
					// lineage and sidebar rows still change under the same delete.
					const forks = yield* sql<{ id: string }>`SELECT id FROM sessions
						WHERE forked_from IN (SELECT value FROM json_each(${JSON.stringify(subtree.map((row) => row.id))}))`;
					const roots = yield* sql<{ root_id: string | null }>`
						SELECT root_id FROM sessions WHERE id = ${stmt.removeSession}`;
					left.push(...roots.flatMap((row) => row.root_id ?? []));
					// Retain each descendant's owner before the cascade removes it.
					yield* sql`
						INSERT INTO session_sidebar (session_id, project_id, version, last_activity, row)
						SELECT id, project_id, ${ctx.version}, 0, NULL FROM sessions
						WHERE id IN (SELECT value FROM json_each(${JSON.stringify(subtree.map((row) => row.id))}))
						ON CONFLICT (session_id) DO UPDATE SET project_id = excluded.project_id`;
					yield* sql.unsafe(REMOVE_SESSION_SQL, [stmt.removeSession]);
					written.push(
						...subtree.map((row) => row.id),
						...forks.map((row) => row.id),
					);
					continue;
				}
				const rows = yield* sql.unsafe<{ id: string }>(
					`${stmt.sql} RETURNING id`,
					[...stmt.params],
				);
				written.push(...rows.map((row) => row.id));
			}
			const inheritsHistory =
				event.type === "session.created" && event.data.inheritsHistory === true;
			if (event.type === "session.created" && inheritsHistory)
				yield* inheritForkHistory(event, ctx.version);
			if (event.type === "session.goal_changed") {
				const goal = event.data.goal;
				let goalStuck: string | null = null;
				if (goal) {
					// Restrict replays to this event's prefix even if later checks
					// already exist in the materialised history.
					const checks = yield* sql<Check>`
						SELECT iterations AS iteration, created_at AS at, reason
						FROM session_goal_checks WHERE session_id = ${event.data.sessionId}
						AND set_at = ${goal.setAt} AND condition = ${goal.condition}
						AND iterations <= ${goal.iterations} ORDER BY iterations ASC`;
					const { stuck } = detectGoalStuck(checks);
					const latest = checks.at(-1);
					const first = stuck
						? checks.find((check) => check.iteration === stuck.sinceIteration)
						: undefined;
					if (stuck && latest && first)
						goalStuck = JSON.stringify({
							since: first.at,
							lastAt: latest.at,
							count: stuck.count,
						});
				}
				// The session statement above already owns this row's version and
				// notification; persist the header before that same stamp commits.
				yield* sql`UPDATE sessions SET goal_stuck = ${goalStuck} WHERE id = ${event.data.sessionId}`;
			}
			// Only these two write a parent.
			if (event.type === "session.created" || event.type === "session.forked")
				left.push(...(yield* rerootSession(event.data.sessionId, ctx.version)));
			const touch = yield* stampSessions(written, ctx.version);
			// A removed session, child or root, leaves a deleted tombstone.
			return {
				...touch,
				collections:
					touch.removed.length > 0
						? ([
								...touch.collections,
								"messages",
								"approvals",
								"inputs",
							] as const)
						: inheritsHistory
							? ([...touch.collections, "messages"] as const)
							: touch.collections,
				sidebar: [...touch.stamped, ...touch.removed, ...left],
			};
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "session",
							operation: "project",
							cause: e,
						}),
			),
		),
}));

export const makeMessageProjector = defineProjector(() => ({
	name: "message",
	handles: [
		"session.rewound",
		"session.rewind_undone",
		"session.rewind_committed",
		"message.created",
		"message.removed",
		"message.part.removed",
		"message.snapshot",
		"text.delta",
		"text.surfaced",
		"thinking.start",
		"thinking.delta",
		"thinking.end",
		"tool.started",
		"tool.running",
		"tool.completed",
		"file.attached",
		"turn.completed",
		"turn.notice",
		"turn.error",
		"turn.interrupted",
		"session.compaction",
		"session.setup_started",
		"session.setup_output",
		"session.setup_finished",
	],
	project: (event, ctx) => {
		if (isEventType(event, "message.removed"))
			return removeMessages(event.sessionId, [event.data.messageId], ctx);
		if (isEventType(event, "session.rewind_committed"))
			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				// Legacy logs already removed the cut with message.removed. A missing
				// cut selects no range, preserving their replay result.
				const removed = yield* sql<{ id: string }>`SELECT m.id FROM messages m
					JOIN messages cut ON cut.id = ${event.data.messageId} AND cut.session_id = m.session_id
					WHERE m.session_id = ${event.sessionId}
					AND (m.created_at, m.id) >= (cut.created_at, cut.id)
					ORDER BY m.created_at, m.id`;
				return yield* removeMessages(event.sessionId, ids(removed), ctx);
			});
		let replacesUserMessage = false;
		let previousMessage:
			| { created_at: number; is_human_sent: number }
			| undefined;
		let authorshipMessageId =
			isEventType(event, "message.created") &&
			(event.data.role === "user" || event.metadata.synthetic === true)
				? event.data.messageId
				: undefined;
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			if (isEventType(event, "session.setup_started")) {
				const messageId = `setup-${event.sessionId}`;
				yield* sql`INSERT INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at, version)
					VALUES (${messageId}, ${event.sessionId}, 'assistant', '', 0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				// Like other daemon notices, this uses the transcript's existing
				// part storage. Typed metadata distinguishes it from agent text.
				yield* sql`INSERT INTO message_parts
					(id, message_id, type, text, metadata, sort_order, created_at, updated_at, version)
					VALUES (${`${messageId}-part`}, ${messageId}, 'text', '',
						${encodeJson({ setup: { source: event.data.source, status: "running" } })},
						0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				return [messageId];
			}
			if (isEventType(event, "session.setup_output")) {
				const messageId = `setup-${event.sessionId}`;
				yield* sql`UPDATE message_parts SET text = text || ${event.data.output},
					updated_at = ${event.createdAt}, version = ${ctx.version} WHERE id = ${`${messageId}-part`}`;
				return ids(
					yield* sql<{ id: string }>`UPDATE messages
					SET updated_at = ${event.createdAt} WHERE id = ${messageId} RETURNING id`,
				);
			}
			if (isEventType(event, "session.setup_finished")) {
				const messageId = `setup-${event.sessionId}`;
				yield* sql`UPDATE message_parts SET
					metadata = json_set(metadata, '$.setup.status', ${event.data.status},
						'$.setup.exitCode', ${event.data.exitCode ?? null},
						'$.setup.message', ${event.data.message ?? null}),
					updated_at = ${event.createdAt}, version = ${ctx.version} WHERE id = ${`${messageId}-part`}`;
				return ids(
					yield* sql<{ id: string }>`UPDATE messages
					SET updated_at = ${event.createdAt}, completed_at = ${event.createdAt}
					WHERE id = ${messageId} RETURNING id`,
				);
			}
			if (
				isEventType(event, "session.rewound") ||
				isEventType(event, "session.rewind_undone")
			) {
				const previousId = event.data.previousMessageId;
				const cutId = isEventType(event, "session.rewound")
					? event.data.messageId
					: null;
				const cutIds = [previousId, cutId].filter(
					(id): id is string => typeof id === "string",
				);
				const cuts =
					previousId === undefined || cutIds.length === 0
						? []
						: yield* sql<RewindCut>`SELECT id, created_at FROM messages
							WHERE session_id = ${event.sessionId} AND id IN ${sql.in(cutIds)}`;
				return yield* restampRewind(
					event.sessionId,
					previousId === null ? null : cuts.find(({ id }) => id === previousId),
					cutId === null ? null : cuts.find(({ id }) => id === cutId),
					ctx.version,
				);
			}
			// A turn that ends without thinking.end must not leave thinking open.
			const closeThinking = (messageId: string) =>
				Effect.map(
					sql<{
						message_id: string;
					}>`UPDATE message_parts SET status = 'completed', version = ${ctx.version}
						WHERE message_id = ${messageId} AND type = 'thinking' AND status = 'running'
						RETURNING message_id`,
					(rows) => [...new Set(rows.map((row) => row.message_id))],
				);
			// A result keyed by its prompt has no answer of its own. Its
			// messageId can name the previous answer, whose usage and time stay put.
			if (isEventType(event, "turn.completed") && event.data.userMessageId)
				return [];
			// Conduit facts also apply to settled OpenCode snapshots. Preserve the
			// part's activity timestamps: judging it is not new agent activity.
			if (isEventType(event, "text.surfaced")) {
				const {
					messageId,
					partId,
					ordinal,
					categorySetVersion,
					model,
					probabilities,
				} = event.data;
				const encoded =
					probabilities === null ? null : encodeJson(probabilities);
				return ids(
					yield* sql<{ id: string }>`
					UPDATE message_parts SET surfacing_ordinal = ${ordinal},
						surfacing_probabilities = ${encoded}, surfacing_set_version = ${categorySetVersion},
						surfacing_model = ${model}, version = ${ctx.version}
					WHERE id = ${partId} AND message_id = ${messageId} AND type = 'text'
						AND EXISTS (SELECT 1 FROM messages WHERE id = ${messageId} AND session_id = ${event.sessionId})
						AND (surfacing_ordinal IS NOT ${ordinal} OR surfacing_probabilities IS NOT ${encoded}
							OR surfacing_set_version IS NOT ${categorySetVersion} OR surfacing_model IS NOT ${model})
					RETURNING message_id AS id`,
				);
			}
			if ("messageId" in event.data && event.type !== "message.snapshot") {
				const rows = yield* sql<{
					rest_digest: string | null;
					session_id: string;
					role: string;
					is_human_sent: number;
					created_at: number;
				}>`
						SELECT rest_digest, session_id, role, is_human_sent, created_at FROM messages WHERE id = ${event.data.messageId}`;
				previousMessage = rows[0];
				if (rows[0]?.role === "user" || rows[0]?.is_human_sent === 1) {
					switch (event.type) {
						case "message.created":
						case "message.part.removed":
						case "text.delta":
						case "file.attached":
						case "thinking.start":
						case "thinking.delta":
						case "tool.started":
						case "tool.running":
						case "tool.completed":
							authorshipMessageId = event.data.messageId;
					}
				}
				if (
					event.type !== "message.part.removed" &&
					event.metadata.rawSource !== "opencode.rest" &&
					rows[0]?.rest_digest != null
				) {
					yield* sql`UPDATE sessions SET history_complete = 0 WHERE id = ${rows[0].session_id}`;
					// A late header can add send identity or synthetic provenance
					// without replacing the snapshot's authoritative content.
					if (
						isEventType(event, "message.created") &&
						(event.data.inputId || event.metadata.synthetic)
					) {
						return ids(
							yield* sql<{
								id: string;
							}>`UPDATE messages SET input_id = COALESCE(input_id, ${event.data.inputId ?? null})
								WHERE id = ${event.data.messageId}
								AND ((input_id IS NULL AND ${event.data.inputId ?? null} IS NOT NULL) OR ${event.metadata.synthetic === true})
								RETURNING id`,
						);
					}
					return [];
				}
			}

			if (isEventType(event, "message.snapshot")) {
				const { message, digest } = event.data;
				const created = message.time?.created ?? event.createdAt;
				const completed = message.time?.completed ?? created;
				const text = message.parts
					.filter(
						(part) => part.type === "text" && typeof part["text"] === "string",
					)
					.map((part) => part["text"])
					.join("");
				// A snapshot can change a stored message's ordering clock. Drive
				// the cut lookup from this message's primary key, never scan sessions
				// on ordinary writes or restamp siblings when the clock is unchanged.
				const existing = yield* sql<{
					is_backfilled: number;
					role: string;
					created_at: number;
					rest_payload: string | null;
					rewind_session_id: string | null;
				}>`SELECT m.is_backfilled, m.role, m.created_at, m.rest_payload, s.id AS rewind_session_id
					FROM messages m LEFT JOIN sessions s
						ON s.id = m.session_id AND s.pending_rewind_message_id = m.id
					WHERE m.id = ${message.id}`;
				replacesUserMessage =
					existing.length > 0 &&
					(existing[0]?.role === "user" || message.role === "user");
				if (message.role === "user" || existing[0]?.role === "user")
					authorshipMessageId = message.id;
				const previousPayload = jsonRecord(existing[0]?.rest_payload ?? null);
				const synthetic =
					event.metadata.synthetic ||
					previousPayload["isSynthetic"] === true ||
					previousPayload["isCompactSummary"] === true;
				const written = yield* sql<{ id: string }>`
					INSERT INTO messages
					(id, session_id, role, text, cost, tokens_in, tokens_out,
					 tokens_cache_read, tokens_cache_write, context_window, context_tokens,
					 is_streaming, is_backfilled, created_at, updated_at,
					 rest_digest, rest_event_id, rest_payload, finish, error, is_inherited)
					VALUES (${message.id}, ${event.sessionId}, ${message.role}, ${text},
					 ${message.cost ?? null}, ${message.tokens?.input ?? null},
					 ${message.tokens?.output ?? null}, ${message.tokens?.cache?.read ?? null},
					 ${message.tokens?.cache?.write ?? null}, ${message.tokens?.contextWindow ?? null},
					 ${message.role === "assistant" && message.summary === true && message.time?.completed != null && message.error == null ? 0 : null},
					 0, ${existing.length === 0 ? 1 : (existing[0]?.is_backfilled ?? 0)},
					 ${created}, ${completed}, ${digest}, ${event.eventId}, ${encodeJson(synthetic ? { ...message, isSynthetic: true } : message)},
					 ${message.finish ?? null},
					 ${message.error === undefined ? null : encodeJson(message.error)},
					 ${event.metadata.inherited ? 1 : 0} OR EXISTS (
						SELECT 1 FROM sessions s WHERE s.id = ${event.sessionId}
						AND (${created}, ${message.id}) <= (s.fork_point_timestamp,
							COALESCE(s.fork_point_message_id, s.fork_point_event, ''))))
					ON CONFLICT (id) DO UPDATE SET
					 role = excluded.role, text = excluded.text, cost = excluded.cost,
					 tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
					 tokens_cache_read = excluded.tokens_cache_read,
					 tokens_cache_write = excluded.tokens_cache_write,
					 context_window = excluded.context_window, is_streaming = 0,
					 context_tokens = excluded.context_tokens,
					 completed_at = NULL,
					 created_at = excluded.created_at, updated_at = excluded.updated_at,
					 rest_digest = excluded.rest_digest, rest_event_id = excluded.rest_event_id,
					 rest_payload = excluded.rest_payload,
					 finish = excluded.finish, error = excluded.error,
					 is_inherited = MAX(messages.is_inherited, excluded.is_inherited)
				RETURNING id`;
				// Replace provider data on retained parts without erasing Conduit's
				// surfacing verdicts. Canonical compaction outcomes also survive.
				const replaced = yield* sql<{ id: string }>`
					DELETE FROM message_parts WHERE message_id = ${message.id}
					AND id NOT IN ${sql.in(message.parts.map((part) => part.id))}
					AND NOT (type = 'compaction' AND rest_payload IS NULL) RETURNING id`;
				for (const { id } of replaced) {
					yield* sql`INSERT INTO message_part_tombstones (session_id, message_id, part_id, version)
						VALUES (${event.sessionId}, ${message.id}, ${id}, ${ctx.version})
						ON CONFLICT (part_id) DO UPDATE SET
						session_id = excluded.session_id, message_id = excluded.message_id,
						version = excluded.version`;
				}
				for (const [index, part] of message.parts.entries()) {
					const partTime = part["time"];
					const time =
						typeof partTime === "object" &&
						partTime !== null &&
						!Array.isArray(partTime)
							? partTime
							: undefined;
					const start =
						time && "start" in time && typeof time.start === "number"
							? time.start
							: created;
					const end =
						time && "end" in time && typeof time.end === "number"
							? time.end
							: start;
					const state = part["state"];
					const toolState =
						typeof state === "object" && state !== null && !Array.isArray(state)
							? state
							: undefined;
					// The daemon owns async answers; the runner's snapshot still has
					// the original unanswered tool output after a user responds.
					const keepAsyncAnswer = sql`message_parts.tool_name = 'AskUserQuestion'
						AND json_extract(message_parts.input, '$.delivery') = 'async'
						AND EXISTS (SELECT 1 FROM pending_approvals pa
							WHERE pa.session_id = ${event.sessionId} AND pa.type = 'question'
								AND pa.status = 'resolved' AND json_extract(pa.details, '$.delivery') = 'async'
								AND json_extract(pa.details, '$.messageId') = excluded.message_id
								AND json_extract(pa.details, '$.partId') = excluded.id)`;
					yield* sql`
						INSERT INTO message_parts
						(id, message_id, type, text, tool_name, call_id, input, result, result_event_seq, result_bytes,
						 status, sort_order, created_at, updated_at, metadata, rest_payload, version)
						VALUES (${part.id}, ${message.id}, ${part.type},
						 ${typeof part["text"] === "string" ? part["text"] : ""},
						 ${typeof part["tool"] === "string" ? part["tool"] : null},
						 ${typeof part["callID"] === "string" ? part["callID"] : null},
						 ${toolState && "input" in toolState ? encodeJson(toolState.input) : null},
						 ${toolState && "output" in toolState ? encodeJson(toolState.output) : null},
						 NULL, NULL,
						 ${toolState && "status" in toolState && typeof toolState.status === "string" ? toolState.status : null},
						 ${index}, ${start}, ${end},
						 ${toolState && "metadata" in toolState ? encodeJson(toolState.metadata) : null},
						 ${encodeJson(part)}, ${ctx.version})
						ON CONFLICT (id) DO UPDATE SET
							type = excluded.type, text = excluded.text, tool_name = excluded.tool_name,
							call_id = excluded.call_id, input = excluded.input,
							result = CASE WHEN ${keepAsyncAnswer} THEN message_parts.result ELSE excluded.result END,
							result_event_seq = CASE WHEN ${keepAsyncAnswer} THEN message_parts.result_event_seq ELSE excluded.result_event_seq END,
							result_bytes = CASE WHEN ${keepAsyncAnswer} THEN message_parts.result_bytes ELSE excluded.result_bytes END,
							status = excluded.status, duration = NULL, sort_order = excluded.sort_order,
							created_at = excluded.created_at, updated_at = excluded.updated_at,
							metadata = excluded.metadata, rest_payload = excluded.rest_payload, version = excluded.version
						WHERE message_parts.message_id = excluded.message_id`;
				}
				const previous = existing[0];
				const moved =
					previous?.rewind_session_id && previous.created_at !== created
						? yield* restampRewind(
								previous.rewind_session_id,
								{ id: message.id, created_at: previous.created_at },
								{ id: message.id, created_at: created },
								ctx.version,
							)
						: [];
				return [...ids(written), ...moved];
			}

			if (isEventType(event, "message.part.removed")) {
				const [message] = yield* sql<{ rest_payload: string | null }>`
					SELECT rest_payload FROM messages WHERE id = ${event.data.messageId}`;
				// Invalidate the snapshot's parts but retain header provenance for
				// later streamed parts; no second provenance column is needed.
				const { parts: _parts, ...header } = jsonRecord(
					message?.rest_payload ?? null,
				);
				const removed = yield* sql<{ id: string }>`DELETE FROM message_parts
					WHERE id = ${event.data.partId} AND message_id = ${event.data.messageId}
					RETURNING id`;
				if (removed.length === 0) return [];
				yield* sql`INSERT INTO message_part_tombstones (session_id, message_id, part_id, version)
					VALUES (${event.sessionId}, ${event.data.messageId}, ${event.data.partId}, ${ctx.version})
					ON CONFLICT (part_id) DO UPDATE SET
					session_id = excluded.session_id, message_id = excluded.message_id,
					version = excluded.version`;
				return ids(
					yield* sql<{ id: string }>`UPDATE messages
					SET text = COALESCE((SELECT group_concat(text, '') FROM (
						SELECT text FROM message_parts WHERE message_id = ${event.data.messageId}
						AND type = 'text' ORDER BY sort_order
					)), ''), rest_payload = ${Object.keys(header).length > 0 ? encodeJson(header) : null}, rest_digest = NULL,
					updated_at = ${event.createdAt}
					WHERE id = ${event.data.messageId} AND session_id = ${event.sessionId}
					RETURNING id`,
				);
			}

			if (isEventType(event, "message.created")) {
				if (event.metadata.rawSource !== "opencode.rest") {
					yield* sql`UPDATE sessions SET history_complete = 0 WHERE id = ${event.sessionId}`;
				}
				// A backfilled message is settled history: it never streams here.
				const isBackfilled = event.data.backfilled ? 1 : 0;
				const created = event.metadata.providerCreatedAt ?? event.createdAt;
				if (
					event.metadata.providerCreatedAt !== undefined &&
					previousMessage?.is_human_sent === 1 &&
					created < previousMessage.created_at
				)
					replacesUserMessage = true;
				const isStreaming =
					event.data.role === "assistant" && !isBackfilled ? 1 : 0;
				// A live user message whose input was sent as a steer, landing while
				// another turn is open, was read mid-turn; the turn projector closes
				// that turn. A steer landing after the turn ended ran as its own.
				const steers = event.data.role === "user" && !isBackfilled;
				const written = yield* sql<{ id: string }>`
						INSERT INTO messages
						(id, session_id, role, text, is_streaming, is_backfilled, created_at, updated_at, parent_id, input_id, is_inherited, steered)
						VALUES (${event.data.messageId}, ${event.data.sessionId}, ${event.data.role}, '', ${isStreaming}, ${isBackfilled}, ${created}, ${event.createdAt}, ${event.data.parentID ?? null}, ${event.data.inputId ?? null},
							${event.metadata.inherited ? 1 : 0} OR EXISTS (
								SELECT 1 FROM sessions s WHERE s.id = ${event.data.sessionId}
								AND (${created}, ${event.data.messageId}) <= (s.fork_point_timestamp,
									COALESCE(s.fork_point_message_id, s.fork_point_event, ''))),
							${steers ? 1 : 0}
								AND EXISTS (SELECT 1 FROM pending_inputs
									WHERE input_id = ${event.data.inputId ?? null}
									AND state = 'steering')
								AND EXISTS (SELECT 1 FROM turns
									WHERE session_id = ${event.data.sessionId}
									AND state IN ('pending', 'running')
									AND id != ${event.data.messageId}))
						ON CONFLICT (id) DO UPDATE SET
							role = excluded.role,
							created_at = CASE WHEN ${event.metadata.providerCreatedAt !== undefined}
								THEN excluded.created_at ELSE messages.created_at END,
							is_streaming = CASE WHEN excluded.role = 'user' THEN 0 ELSE messages.is_streaming END,
							input_id = COALESCE(messages.input_id, excluded.input_id),
							is_inherited = MAX(messages.is_inherited, excluded.is_inherited)
						WHERE messages.role <> excluded.role
							OR ${event.metadata.synthetic === true}
							OR messages.is_inherited < excluded.is_inherited
							OR (${event.metadata.providerCreatedAt !== undefined} AND messages.created_at <> excluded.created_at)
							OR (messages.input_id IS NULL AND excluded.input_id IS NOT NULL)
						RETURNING id`;
				if (
					!previousMessage ||
					event.metadata.providerCreatedAt === undefined ||
					previousMessage.created_at === created ||
					written.length === 0
				)
					return ids(written);
				const [rewind] = yield* sql<{ id: string }>`SELECT id FROM sessions
					WHERE id = ${event.data.sessionId} AND pending_rewind_message_id = ${event.data.messageId}`;
				if (!rewind) return ids(written);
				return [
					...ids(written),
					...(yield* restampRewind(
						rewind.id,
						{
							id: event.data.messageId,
							created_at: previousMessage.created_at,
						},
						{ id: event.data.messageId, created_at: created },
						ctx.version,
					)),
				];
			}

			if (isEventType(event, "text.delta")) {
				if (ctx?.replaying) {
					const msgRows = yield* sql<{
						last_applied_seq: number | null;
					}>`SELECT last_applied_seq FROM messages WHERE id = ${event.data.messageId}`;
					const row = msgRows[0];
					if (
						row?.last_applied_seq != null &&
						event.sequence <= row.last_applied_seq
					)
						return [];
				}

				// Defensive: ensure the messages row exists
				yield* sql`
					INSERT OR IGNORE INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (${event.data.messageId}, ${event.sessionId}, 'assistant', '', 1, ${event.createdAt}, ${event.createdAt})`;

				yield* sql`
					INSERT INTO message_parts (id, message_id, type, text, metadata, sort_order, created_at, updated_at, version)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'text', ${event.data.text},
						${event.metadata.synthetic ? encodeJson({ synthetic: true }) : null},
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO UPDATE SET
						text = message_parts.text || excluded.text,
						metadata = COALESCE(excluded.metadata, message_parts.metadata),
						updated_at = excluded.updated_at, version = excluded.version`;

				return ids(
					yield* sql<{ id: string }>`
						UPDATE messages SET text = text || ${event.data.text}, last_applied_seq = ${event.sequence}, updated_at = ${event.createdAt} WHERE id = ${event.data.messageId}
						RETURNING id`,
				);
			}

			if (isEventType(event, "thinking.start")) {
				yield* sql`
					INSERT OR IGNORE INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (${event.data.messageId}, ${event.sessionId}, 'assistant', '', 1, ${event.createdAt}, ${event.createdAt})`;

				yield* sql`
					INSERT INTO message_parts (id, message_id, type, text, status, sort_order, created_at, updated_at, version)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'thinking', '', 'running',
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;

				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "thinking.delta")) {
				if (ctx?.replaying) {
					const msgRows = yield* sql<{
						last_applied_seq: number | null;
					}>`SELECT last_applied_seq FROM messages WHERE id = ${event.data.messageId}`;
					const row = msgRows[0];
					if (
						row?.last_applied_seq != null &&
						event.sequence <= row.last_applied_seq
					)
						return [];
				}

				yield* sql`
					INSERT OR IGNORE INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (${event.data.messageId}, ${event.sessionId}, 'assistant', '', 1, ${event.createdAt}, ${event.createdAt})`;

				yield* sql`
					INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at, version)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'thinking', ${event.data.text},
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO UPDATE SET
						text = message_parts.text || excluded.text,
						updated_at = excluded.updated_at, version = excluded.version`;

				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET last_applied_seq = ${event.sequence}, updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "thinking.end")) {
				// The part's own span ends here, not at its last delta.
				yield* sql`UPDATE message_parts
					SET status = 'completed', updated_at = ${event.createdAt}, version = ${ctx.version}
					WHERE id = ${event.data.partId} AND type = 'thinking'`;
				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "tool.started")) {
				yield* sql`
					INSERT OR IGNORE INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (${event.data.messageId}, ${event.sessionId}, 'assistant', '', 1, ${event.createdAt}, ${event.createdAt})`;

				const inputJson = encodeJson(event.data.input);
				yield* sql`
					INSERT INTO message_parts
					(id, message_id, type, tool_name, call_id, input, status, sort_order, created_at, updated_at, version)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'tool', ${event.data.toolName}, ${event.data.callId}, ${inputJson}, 'started',
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;

				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			// A part write advances the message that owns the part: a task update can
			// name whichever message is streaming when it lands (a background task
			// finishing after its turn), and that message's refetch misses this part.
			if (isEventType(event, "tool.running")) {
				const resumed =
					getProviderDriver(event.provider)?.reusesSubagentCards === true &&
					event.data.metadata?.["subagentResumed"] === true;
				const rows = yield* sql<{ metadata: string | null }>`
					SELECT metadata FROM message_parts WHERE id = ${event.data.partId}`;
				const metadata = yield* mergeMetadata(
					rows[0]?.metadata ?? null,
					event.data.metadata,
					event.sessionId,
					event.data.partId,
				);
				yield* sql`
					UPDATE message_parts
					SET status = CASE
							WHEN ${resumed} THEN 'running'
							WHEN status IN ('completed', 'error') THEN status
							ELSE 'running'
						END,
						result = CASE WHEN ${resumed} THEN NULL ELSE result END,
						result_bytes = CASE WHEN ${resumed} THEN NULL ELSE result_bytes END,
						result_event_seq = CASE WHEN ${resumed} THEN NULL ELSE result_event_seq END,
						input = COALESCE(${event.data.input === undefined ? null : encodeJson(event.data.input)}, input),
						metadata = ${metadata},
						updated_at = ${event.createdAt},
						version = ${ctx.version}
					WHERE id = ${event.data.partId}`;
				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = COALESCE((SELECT message_id FROM message_parts WHERE id = ${event.data.partId}), ${event.data.messageId}) RETURNING id`,
				);
			}

			if (isEventType(event, "tool.completed")) {
				const resultJson = encodeJson(event.data.result);
				const toolStatus =
					typeof event.data.metadata?.["cursorToolType"] === "string" &&
					event.data.metadata["isError"] === true
						? "error"
						: "completed";
				const rows = yield* sql<{
					metadata: string | null;
					result: string;
					result_bytes: number | null;
				}>`
					WITH completed AS (SELECT ${resultJson} AS result),
					output AS (
						SELECT result, CASE WHEN json_type(result) = 'text'
							THEN json_extract(result, '$') ELSE result END AS output
						FROM completed
					)
					SELECT mp.metadata,
						CASE WHEN mp.type = 'tool'
							AND mp.tool_name NOT IN ${sql.in(NEVER_CUT_TOOL_NAMES)}
							AND length(output) > ${PREVIEW_CODE_POINTS}
							THEN json_quote(substr(output, 1, ${PREVIEW_CODE_POINTS}))
							ELSE output.result END AS result,
						CASE WHEN mp.type = 'tool'
							AND mp.tool_name NOT IN ${sql.in(NEVER_CUT_TOOL_NAMES)}
							AND length(output) > ${PREVIEW_CODE_POINTS}
							THEN length(CAST(output AS BLOB)) END AS result_bytes
					FROM message_parts mp CROSS JOIN output
					WHERE mp.id = ${event.data.partId}`;
				const metadata = yield* mergeMetadata(
					rows[0]?.metadata ?? null,
					event.data.metadata,
					event.sessionId,
					event.data.partId,
				);
				yield* sql`
					UPDATE message_parts
					SET result = ${rows[0]?.result ?? resultJson},
						result_event_seq = ${rows[0]?.result_bytes == null ? null : event.sequence},
						result_bytes = ${rows[0]?.result_bytes ?? null},
						duration = ${event.data.duration}, status = ${toolStatus}, metadata = ${metadata}, updated_at = ${event.createdAt}, version = ${ctx.version},
						input = COALESCE(${event.data.input === undefined ? null : encodeJson(event.data.input)}, input)
					WHERE id = ${event.data.partId}
						-- A completion without a result (the turn-end settle) only closes
						-- unfinished tools; on a finished one it would erase output that
						-- already arrived, e.g. via a forked subagent's transcript.
						AND (${event.data.result == null || event.data.result === "" ? 0 : 1} = 1
							OR status NOT IN ('completed', 'error'))`;
				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = COALESCE((SELECT message_id FROM message_parts WHERE id = ${event.data.partId}), ${event.data.messageId}) RETURNING id`,
				);
			}

			if (isEventType(event, "file.attached")) {
				yield* sql`
					INSERT OR IGNORE INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (${event.data.messageId}, ${event.sessionId}, 'assistant', '', 1, ${event.createdAt}, ${event.createdAt})`;

				const metadata = encodeJson({
					mime: event.data.mime,
					...(event.data.filename != null
						? { filename: event.data.filename }
						: {}),
					url: event.data.url,
				});
				yield* sql`
					INSERT INTO message_parts
					(id, message_id, type, metadata, sort_order, created_at, updated_at, version)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'file', ${metadata},
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;

				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "turn.completed")) {
				// New Claude completions carry cost deltas, so repeated completions add.
				// Other providers and historical Claude events retain latest-wins cost.
				const tokens = event.data.tokens;
				yield* closeThinking(event.data.messageId);
				return ids(
					yield* sql<{ id: string }>`
					UPDATE messages SET
					cost = CASE WHEN ${event.data.providerCostTotalUsd !== undefined ? 1 : 0}
						THEN COALESCE(cost, 0) + ${event.data.cost ?? 0}
						ELSE ${event.data.cost ?? null} END,
					tokens_in = ${tokens?.input ?? null},
					tokens_out = ${tokens?.output ?? null},
					tokens_cache_read = ${tokens?.cacheRead ?? null},
					tokens_cache_write = ${tokens?.cacheWrite ?? null},
					context_tokens = ${event.data.contextTokens ?? null},
					context_window = ${tokens?.contextWindow ?? null},
					is_streaming = 0,
					completed_at = ${event.createdAt},
					updated_at = ${event.createdAt}
					WHERE id = ${event.data.messageId}
					RETURNING id`,
				);
			}

			if (isEventType(event, "turn.notice")) {
				if (!event.metadata.runId) return [];
				const [owner] = yield* sql<{
					id: string;
				}>`SELECT run.id FROM provider_runs requested
					JOIN provider_runs run ON run.id = COALESCE(requested.joined_into, requested.id)
						AND run.session_id = requested.session_id
					WHERE requested.id = ${event.metadata.runId} AND requested.session_id = ${event.sessionId}
						AND run.status = 'running' AND run.started_at IS NOT NULL`;
				if (!owner) return [];
				const messageId = `turn-notice-${event.sequence}`;
				yield* sql`INSERT INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at, version)
					VALUES (${messageId}, ${event.sessionId}, 'assistant', '', 0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				yield* sql`INSERT INTO message_parts
					(id, message_id, type, text, metadata, sort_order, created_at, updated_at, version)
					VALUES (${`turn-notice-part-${event.sequence}`}, ${messageId}, 'text', ${event.data.text},
						${encodeJson({ notice: true })}, 0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				return [messageId];
			}

			if (isEventType(event, "turn.error")) {
				// The error is the turn's last word, so it replays like any
				// content: a synthetic message after the turn's own, keyed on the
				// event sequence. A part on the turn's message would be lost when
				// a REST snapshot rewrites that message's parts.
				const errorMessageId = `turn-error-${event.sequence}`;
				yield* sql`
					INSERT INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at, version)
					VALUES (${errorMessageId}, ${event.sessionId}, 'assistant', '', 0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				yield* sql`
					INSERT INTO message_parts
					(id, message_id, type, text, metadata, sort_order, created_at, updated_at, version)
					VALUES (${`turn-error-part-${event.sequence}`}, ${errorMessageId}, 'error', ${event.data.error},
						${event.data.code === undefined ? null : encodeJson({ code: event.data.code })},
						0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				return [errorMessageId];
			}

			if (isEventType(event, "session.compaction")) {
				// Only the outcomes reach persistence — ingestion drops the transient
				// "started" before the append — but the guard stays because a replay
				// or backfill can hand us one. A failed outcome is kept as status.
				// The `compaction` part keeps the divider and the reduced context gauge
				// across a reload. An auto-compaction lands mid-message, so it joins
				// the in-flight assistant message as its next part: a standalone
				// message would sort by its own time, after that message's result,
				// and split the turn on reload. Between turns it gets a synthetic
				// message. Ids keyed on the event sequence plus DO NOTHING make
				// replay a no-op.
				if (event.data.state === "started") return [];
				const status = event.data.state === "failed" ? "failed" : null;
				const partId = `compaction-part-${event.sequence}`;
				const [latest] = yield* sql<{
					id: string;
					role: string;
					is_streaming: number;
				}>`SELECT id, role, is_streaming FROM messages
					WHERE session_id = ${event.data.sessionId}
					ORDER BY created_at DESC, id DESC LIMIT 1`;
				const metadata = encodeJson({
					...(typeof event.data.preTokens === "number"
						? { preTokens: event.data.preTokens }
						: {}),
					...(typeof event.data.postTokens === "number"
						? { postTokens: event.data.postTokens }
						: {}),
				});
				const summaryId =
					event.provider === "opencode"
						? event.metadata.providerRefs?.providerMessageId
						: undefined;
				const ownerId =
					summaryId ??
					(latest?.role === "assistant" && latest.is_streaming === 1
						? latest.id
						: undefined);
				if (ownerId) {
					yield* sql`
						INSERT INTO message_parts
						(id, message_id, type, text, metadata, status, sort_order, created_at, updated_at, version)
						VALUES (${partId}, ${ownerId}, 'compaction', ${event.data.detail}, ${metadata}, ${status},
							COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${ownerId}), 0),
							${event.createdAt}, ${event.createdAt}, ${ctx.version})
						ON CONFLICT (id) DO NOTHING`;
					return [ownerId];
				}
				const messageId = `compaction-${event.sequence}`;
				yield* sql`
					INSERT INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at, version)
					VALUES (${messageId}, ${event.data.sessionId}, 'assistant', '', 0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				yield* sql`
					INSERT INTO message_parts
					(id, message_id, type, text, metadata, status, sort_order, created_at, updated_at, version)
					VALUES (${partId}, ${messageId}, 'compaction', ${event.data.detail}, ${metadata}, ${status}, 0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				return [messageId];
			}
			return [];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "message",
							operation: "project",
							cause: e,
						}),
			),
			Effect.flatMap((written) =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					for (const messageId of new Set(written)) {
						if (messageId !== authorshipMessageId) continue;
						const [row] = yield* sql<{
							role: string;
							input_id: string | null;
							is_inherited: number;
							is_human_sent: number;
							rest_payload: string | null;
						}>`SELECT role, input_id, is_inherited, is_human_sent, rest_payload
							FROM messages WHERE id = ${messageId}`;
						if (!row) continue;
						const snapshot = jsonRecord(row.rest_payload);
						if (
							isEventType(event, "message.created") &&
							event.metadata.synthetic
						) {
							// A header-only synthetic fact must survive subsequent part events.
							snapshot["isSynthetic"] = true;
							yield* sql`UPDATE messages SET rest_payload = ${encodeJson(snapshot)} WHERE id = ${messageId}`;
						}
						if (row.role !== "user" && row.is_human_sent === 0) continue;
						const storedParts =
							row.role === "user"
								? yield* sql<{
										type: string;
										metadata: string | null;
										rest_payload: string | null;
									}>`SELECT type, metadata, rest_payload FROM message_parts WHERE message_id = ${messageId}`
								: [];
						const parts = storedParts.map((part) => {
							const raw = jsonRecord(part.rest_payload);
							return {
								type: part.type,
								synthetic:
									raw["synthetic"] === true ||
									jsonRecord(part.metadata)["synthetic"] === true,
								ignored: raw["ignored"],
							};
						});
						// Old snapshots may have parts only in rest_payload.
						const ownParts =
							parts.length > 0
								? parts
								: Array.isArray(snapshot["parts"])
									? snapshot["parts"]
											.filter(isRecord)
											.map((part) => ({ ...part, type: part["type"] }))
									: [];
						const [legacy] =
							row.role === "user" &&
							row.is_inherited === 0 &&
							row.rest_payload === null &&
							row.input_id === null &&
							ownParts.length === 0
								? yield* sql<{
										text: string;
									}>`SELECT text FROM messages WHERE id = ${messageId}`
								: [];
						const humanSent = isHumanSentMessage(
							{
								role: row.role,
								inputId: row.input_id,
								inherited: row.is_inherited === 1,
								synthetic:
									snapshot["isSynthetic"] === true ||
									snapshot["isCompactSummary"] === true,
								legacyText: legacy?.text ?? "",
							},
							ownParts,
						);
						if (row.is_human_sent === Number(humanSent)) continue;
						replacesUserMessage ||= row.is_human_sent === 1;
						yield* sql`UPDATE messages SET is_human_sent = ${Number(humanSent)} WHERE id = ${messageId}`;
					}
					const touch = yield* stampMessage(written, ctx);
					if (event.type !== "message.part.removed" && !replacesUserMessage)
						return touch;
					const changed = yield* refreshLastUserMessageAt(
						event.sessionId,
						ctx.version,
					);
					if (changed.length === 0) return touch;
					return {
						...touch,
						stamped: [...new Set([...touch.stamped, ...changed])],
						collections: [
							...new Set<ReadModelCollection>([
								...touch.collections,
								"sessions",
								"sidebar",
							]),
						],
						sidebar: [...new Set([...(touch.sidebar ?? []), ...changed])],
					};
				}),
			),
		);
	},
}));

export function runTerminalStatus(
	event: { readonly type: string; readonly data: unknown },
	provider: string,
): "completed" | "error" | "interrupted" | undefined {
	if (event.type === "turn.error") return "error";
	if (event.type === "turn.interrupted") return "interrupted";
	if (event.type === "turn.completed")
		return getProviderDriver(provider)?.streamsSessionLifecycle === true
			? "completed"
			: undefined;
	if (
		provider === "opencode" &&
		event.type === "session.status" &&
		isRecord(event.data)
	) {
		if (event.data["status"] === "idle") return "completed";
		if (event.data["status"] === "error") return "error";
	}
	return undefined;
}

// Called only by run transitions, in the same projection transaction.
function settleRunCommands(
	runId: string,
	event: {
		readonly type: string;
		readonly provider: string;
		readonly sessionId: string;
		readonly data: unknown;
		readonly createdAt: number;
	},
) {
	return Effect.gen(function* () {
		const status = runTerminalStatus(event, event.provider);
		if (!status) return;
		const sql = yield* SqlClient.SqlClient;
		const data = isRecord(event.data) ? event.data : {};
		const retryable =
			status === "error" &&
			data["retryable"] === true &&
			data["retryHandled"] !== true;
		const code =
			status === "completed"
				? null
				: typeof data["code"] === "string"
					? data["code"]
					: status;
		const commands = yield* sql<{
			request_sequence: number;
			command_id: string;
			project_key: string;
			attempt_count: number;
		}>`
			SELECT request_sequence, command_id, project_key, attempt_count FROM provider_command_outbox
			WHERE session_id = ${event.sessionId} AND effect_type = 'send_turn'
				AND status IN ('pending', 'running', 'retryable_failed')
				AND run_id IN
					(SELECT id FROM provider_runs WHERE session_id = ${event.sessionId}
					 AND (id = ${runId} OR joined_into = ${runId}))`;
		for (const command of commands) {
			const retryAt = retryable
				? typeof data["retryAt"] === "number"
					? data["retryAt"]
					: event.createdAt +
						Math.min(1000 * 2 ** Math.max(0, command.attempt_count - 1), 30_000)
				: null;
			yield* sql`UPDATE provider_command_outbox
				SET status = ${status === "completed" ? "completed" : retryable ? "retryable_failed" : "failed"},
					error_code = ${code}, next_attempt_at = ${retryAt}, updated_at = ${event.createdAt}
				WHERE request_sequence = ${command.request_sequence} AND project_key = ${command.project_key}`;
			yield* sql`UPDATE command_receipts
				SET status = ${status === "completed" ? "side_effect_completed" : "side_effect_failed"},
					error_code = ${code}, updated_at = ${event.createdAt}
				WHERE command_id = ${command.command_id} AND project_key = ${command.project_key}
					AND ${command.request_sequence} = (SELECT MAX(request_sequence) FROM provider_command_outbox
						WHERE command_id = ${command.command_id} AND project_key = ${command.project_key})`;
		}
	});
}

export const makeTurnProjector = defineProjector(() => ({
	name: "turn",
	handles: [
		"run.requested",
		"run.started",
		"message.created",
		"message.snapshot",
		"tool.started",
		"session.status",
		"turn.completed",
		"turn.error",
		"turn.interrupted",
		"turn.model_resolved",
	],
	project: (event, ctx) =>
		Effect.gen(function* () {
			// Codex confirms existing message headers to retain native turn refs.
			// Replaying those confirmations must not recreate a user turn.
			if (
				event.provider === "codex" &&
				isEventType(event, "message.created") &&
				(event.metadata.source === "codex.native-turn" ||
					event.metadata.source === "codex.native-turn.completed")
			)
				return { sessions: [], messages: [] };
			const sql = yield* SqlClient.SqlClient;
			if (isEventType(event, "run.requested")) {
				yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at)
					VALUES (${event.data.runId}, ${event.sessionId}, 'pending', ${event.createdAt})
					ON CONFLICT (id) DO NOTHING`;
				yield* sql`UPDATE sessions SET status = 'busy', last_turn_error_at = NULL
					WHERE id = ${event.sessionId} AND EXISTS (
						SELECT 1 FROM provider_runs WHERE id = ${event.data.runId}
							AND session_id = ${event.sessionId} AND status IN ('pending', 'running'))`;
				yield* sql`UPDATE command_receipts SET status = 'side_effect_requested', error_code = NULL, updated_at = ${event.createdAt}
					WHERE (command_id, project_key) IN (
						SELECT command_id, project_key FROM provider_command_outbox WHERE run_id = ${event.data.runId}
							AND session_id = ${event.sessionId} AND status = 'running'
							AND EXISTS (SELECT 1 FROM provider_runs WHERE id = ${event.data.runId} AND status = 'pending'))`;
				return { sessions: [event.sessionId], messages: [] };
			}
			const runId = event.metadata.runId;
			if (isEventType(event, "run.started")) {
				if (!runId) return { sessions: [], messages: [] };
				if (event.data.requestedRunId === runId)
					yield* sql`INSERT INTO provider_runs
					(id, session_id, status, requested_at, started_at)
					VALUES (${runId}, ${event.sessionId}, 'running', ${event.createdAt}, ${event.createdAt})
					ON CONFLICT (id) DO NOTHING`;

				const [resolved] = yield* sql<{
					status: string;
					started_at: number | null;
					completed_at: number | null;
				}>`
					SELECT status, started_at, completed_at FROM provider_runs WHERE id = ${runId} AND session_id = ${event.sessionId}`;
				if (!resolved || resolved.status === "joined")
					return { sessions: [], messages: [] };
				const open =
					resolved.status === "pending" || resolved.status === "running";
				const startedAt =
					resolved.started_at ?? (open ? event.createdAt : null);
				yield* sql`UPDATE provider_runs SET status = 'joined', completed_at = ${event.createdAt}, joined_into = ${runId}
					WHERE id = ${event.data.requestedRunId} AND session_id = ${event.sessionId}
					AND id <> ${runId} AND status = 'pending'`;
				if (open)
					yield* sql`UPDATE provider_runs SET status = 'running', started_at = ${startedAt}
					WHERE id = ${runId} AND session_id = ${event.sessionId}`;
				const joined = yield* sql<OwnedRow & { id: string }>`UPDATE turns
					SET run_id = ${runId}, state = ${open ? sql`state` : resolved.status},
						completed_at = ${open ? sql`completed_at` : resolved.completed_at}
					WHERE run_id = ${event.data.requestedRunId} AND session_id = ${event.sessionId}
					AND run_id IN (SELECT id FROM provider_runs WHERE joined_into = ${runId})
					RETURNING id, session_id`;
				const written = yield* sql<OwnedRow & { id: string }>`UPDATE turns
					SET state = ${open ? "running" : resolved.status},
						started_at = COALESCE(started_at, ${event.createdAt}), completed_at = ${open ? null : resolved.completed_at}
					WHERE session_id = ${event.sessionId}
					AND (id = ${event.data.userMessageId ?? event.data.inputId} OR user_message_id IN
						(SELECT id FROM messages WHERE session_id = ${event.sessionId} AND input_id = ${event.data.inputId}))
					AND run_id = ${runId}
					RETURNING id, session_id`;
				if (written.length)
					yield* sql`UPDATE messages SET turn_id = id WHERE session_id = ${event.sessionId}
					AND id IN ${sql.in(written.map(({ id }) => id))}`;
				if (!open) {
					// A delayed acceptance follows the run's recorded end, never a new adapter result.
					const ends = yield* sql<{
						type: string;
						data: string;
						provider: string;
					}>`
						SELECT type, data, provider FROM events WHERE session_id = ${event.sessionId}
						AND json_extract(metadata, '$.runId') = ${runId} AND created_at = ${resolved.completed_at}
						ORDER BY sequence`;
					for (const end of ends) {
						const cause = {
							...end,
							sessionId: event.sessionId,
							createdAt: resolved.completed_at ?? event.createdAt,
							data: JSON.parse(end.data) as unknown,
						};
						if (runTerminalStatus(cause, cause.provider) !== resolved.status)
							continue;
						yield* settleRunCommands(runId, cause);
						break;
					}
				}

				return {
					sessions: [event.sessionId],
					messages: ids([...joined, ...written]),
				};
			}

			if (isEventType(event, "message.created") && event.data.role === "user") {
				const [run] = runId
					? yield* sql<{
							id: string;
							status: string;
							completed_at: number | null;
						}>`SELECT run.id, run.status, run.completed_at FROM provider_runs requested
						JOIN provider_runs run ON run.id = COALESCE(requested.joined_into, requested.id)
							AND run.session_id = requested.session_id
						WHERE requested.id = ${runId} AND requested.session_id = ${event.sessionId}`
					: [];
				const written = yield* sql<OwnedRow>`INSERT INTO turns
					(id, session_id, state, user_message_id, requested_at, run_id, completed_at)
					VALUES (${event.data.messageId}, ${event.sessionId}, ${run && !["pending", "running"].includes(run.status) ? run.status : "pending"}, ${event.data.messageId}, ${event.createdAt}, ${run?.id ?? runId ?? null}, ${run?.completed_at ?? null})
					ON CONFLICT (id) DO UPDATE SET run_id = excluded.run_id, state = excluded.state,
						started_at = NULL, completed_at = excluded.completed_at, assistant_message_id = NULL
					WHERE excluded.run_id IS NOT NULL AND (turns.run_id IS NULL OR (
						EXISTS (SELECT 1 FROM provider_runs prior WHERE prior.id = turns.run_id
							AND prior.session_id = turns.session_id AND prior.status IN ('completed', 'error', 'interrupted'))
						AND EXISTS (SELECT 1 FROM provider_runs next WHERE next.id = excluded.run_id
							AND next.session_id = excluded.session_id AND next.status IN ('pending', 'running')))) RETURNING session_id`;
				return { sessions: owners(written), messages: [] };
			}

			if (
				event.metadata.rawSource !== "opencode.rest" &&
				"messageId" in event.data &&
				// Display snapshots cannot suppress an explicitly owned run terminal.
				!(runId && runTerminalStatus(event, event.provider)) &&
				!(isEventType(event, "turn.completed") && event.data.userMessageId)
			) {
				const rows = yield* sql<{
					rest_digest: string | null;
					session_id: string;
				}>`
						SELECT rest_digest, session_id FROM messages WHERE id = ${event.data.messageId}`;
				if (rows[0]?.rest_digest != null) {
					yield* sql`UPDATE sessions SET history_complete = 0 WHERE id = ${rows[0].session_id}`;
					return { sessions: [], messages: [] };
				}
			}

			if (isEventType(event, "message.snapshot")) {
				const { message } = event.data;
				const parentId = message.parentID;
				// The message projector leaves the previous ownership in this row
				// until it can be captured here, before applying the new parent.
				const [previous] = yield* sql<{
					turn_id: string | null;
					parent_id: string | null;
				}>`SELECT turn_id, parent_id FROM messages WHERE id = ${message.id}`;
				const affected = new Set(
					[previous?.turn_id, previous?.parent_id].filter(
						(owner): owner is string => owner != null,
					),
				);
				const messageIds: string[] = [];
				const displayOwners = yield* sql<{ id: string }>`
					SELECT id FROM turns WHERE assistant_message_id = ${message.id}
					AND session_id = ${event.sessionId}`;
				for (const owner of displayOwners) affected.add(owner.id);
				if (message.role === "user") {
					yield* sql`INSERT INTO turns (id, session_id, state, user_message_id, requested_at)
					VALUES (${message.id}, ${event.sessionId}, 'pending', ${message.id}, ${message.time?.created ?? event.createdAt})
					ON CONFLICT (id) DO UPDATE SET requested_at = excluded.requested_at`;
					const children = yield* sql<{ turn_id: string | null }>`
						SELECT DISTINCT turn_id FROM messages WHERE session_id = ${event.sessionId}
						AND parent_id = ${message.id}
						AND role = 'assistant'`;
					for (const child of children) {
						if (child.turn_id) affected.add(child.turn_id);
					}
					yield* sql`UPDATE messages SET turn_id = ${message.id}
						WHERE session_id = ${event.sessionId} AND parent_id = ${message.id}
						AND role = 'assistant'`;
				} else if (parentId) {
					yield* sql`INSERT INTO turns (id, session_id, state, user_message_id, requested_at)
					SELECT id, session_id, 'pending', id, created_at FROM messages
					WHERE id = ${parentId} AND session_id = ${event.sessionId} AND role = 'user'
					ON CONFLICT (id) DO NOTHING`;
				}
				const turn = parentId
					? yield* sql<{
							id: string;
						}>`SELECT id FROM turns WHERE id = ${parentId} AND session_id = ${event.sessionId}`
					: [];
				if (message.role === "assistant") {
					yield* sql`UPDATE messages SET parent_id = ${parentId ?? null},
						turn_id = ${turn.length ? parentId : null} WHERE id = ${message.id}`;
				}
				if (message.role === "user") affected.add(message.id);
				if (turn.length && parentId) affected.add(parentId);
				for (const turnId of affected) {
					const [totals] = yield* sql<{
						cost: number | null;
						tokens_in: number | null;
						tokens_out: number | null;
						started_at: number | null;
						completed_at: number | null;
					}>`SELECT SUM(cost) AS cost, SUM(tokens_in) AS tokens_in,
						SUM(tokens_out) AS tokens_out, MIN(created_at) AS started_at,
						MAX(updated_at) AS completed_at FROM messages
						WHERE session_id = ${event.sessionId} AND turn_id = ${turnId}
						AND role = 'assistant'`;
					const [latest] = yield* sql<{ id: string; is_streaming: number }>`
						SELECT id, is_streaming FROM messages
						WHERE session_id = ${event.sessionId} AND turn_id = ${turnId}
						AND role = 'assistant'
						ORDER BY created_at DESC, id DESC LIMIT 1`;
					// REST repairs display ownership; an owned run keeps its lifecycle and accounting.
					const rows = yield* sql<{
						id: string;
					}>`UPDATE turns SET assistant_message_id = ${latest?.id ?? null},
						state = CASE WHEN run_id IS NULL THEN ${latest ? (latest.is_streaming ? "running" : "completed") : "pending"} ELSE state END,
						started_at = CASE WHEN run_id IS NULL THEN ${totals?.started_at ?? null} ELSE started_at END,
						completed_at = CASE WHEN run_id IS NULL THEN ${latest?.is_streaming ? null : (totals?.completed_at ?? null)} ELSE completed_at END,
						cost = CASE WHEN run_id IS NULL THEN ${totals?.cost ?? null} ELSE cost END,
						tokens_in = CASE WHEN run_id IS NULL THEN ${totals?.tokens_in ?? null} ELSE tokens_in END,
						tokens_out = CASE WHEN run_id IS NULL THEN ${totals?.tokens_out ?? null} ELSE tokens_out END
						WHERE id = ${turnId} RETURNING id`;
					messageIds.push(...ids(rows));
				}
				return {
					sessions: affected.size > 0 ? [event.sessionId] : [],
					messages: messageIds,
				};
			}
			if (
				isEventType(event, "message.created") &&
				event.data.role === "assistant" &&
				event.data.parentID
			) {
				const written = yield* sql<OwnedRow & { id: string }>`UPDATE turns
					SET assistant_message_id = COALESCE((SELECT id FROM messages
						WHERE session_id = ${event.sessionId} AND role = 'assistant'
						AND (turn_id = turns.id OR id = ${event.data.messageId})
						ORDER BY created_at DESC, id DESC LIMIT 1), ${event.data.messageId})
					WHERE id = ${event.data.parentID} AND session_id = ${event.sessionId} AND (${runId ?? null} IS NULL OR run_id = ${runId ?? null})
					RETURNING id, session_id`;
				if (written.length)
					yield* sql`UPDATE messages SET turn_id = ${event.data.parentID}
					WHERE id = ${event.data.messageId} AND session_id = ${event.sessionId}`;
				return { sessions: owners(written), messages: ids(written) };
			}

			// Live ownership is resolved by the adapter. Unplaced events cannot change a turn.
			if (!runId) return { sessions: [], messages: [] };
			const [run] = yield* sql<{
				status: string;
			}>`SELECT status FROM provider_runs
				WHERE id = ${runId} AND session_id = ${event.sessionId}`;
			if (!run) return { sessions: [], messages: [] };

			if (isEventType(event, "turn.model_resolved")) {
				const written = yield* sql<OwnedRow & { id: string }>`UPDATE turns
					SET requested_model = ${event.data.requestedModel ?? null},
						expected_model = ${event.data.expectedModel ?? null}, actual_model = ${event.data.actualModel}
					WHERE run_id = ${runId} AND session_id = ${event.sessionId}
					RETURNING id, session_id`;
				return { sessions: owners(written), messages: ids(written) };
			}

			if (isEventType(event, "turn.completed")) {
				const tokens = event.data.tokens;
				yield* sql`UPDATE turns SET
					cost = CASE WHEN ${event.data.providerCostTotalUsd !== undefined ? 1 : 0}
						THEN COALESCE(cost, 0) + ${event.data.cost ?? 0}
						ELSE COALESCE(${event.data.cost ?? null}, cost) END,
					tokens_in = COALESCE(tokens_in + ${tokens?.input ?? null}, tokens_in, ${tokens?.input ?? null}),
					tokens_out = COALESCE(tokens_out + ${tokens?.output ?? null}, tokens_out, ${tokens?.output ?? null})
					WHERE run_id = ${runId} AND session_id = ${event.sessionId}
					AND id = COALESCE(${event.data.userMessageId ?? null},
						(SELECT turn_id FROM messages WHERE id = ${event.data.messageId}
						 AND session_id = ${event.sessionId}))`;
			}
			if (!["pending", "running"].includes(run.status)) {
				// A background task finishing after its run ended wakes Claude into
				// a new turn under the same run. Its end is new output to read,
				// unless a newer run owns the session or it repeats a counted reply.
				if (isEventType(event, "turn.completed"))
					yield* sql`UPDATE sessions SET updated_at = ${event.createdAt},
						last_turn_end_version = ${event.streamVersion}
						WHERE id = ${event.sessionId}
						AND ${event.streamVersion} > COALESCE(last_turn_end_version, -1)
						AND NOT EXISTS (SELECT 1 FROM provider_runs WHERE session_id = ${event.sessionId}
							AND status IN ('pending', 'running'))
						AND EXISTS (SELECT 1 FROM messages m JOIN provider_runs r ON r.id = ${runId}
							WHERE m.id = ${event.data.messageId} AND m.session_id = ${event.sessionId}
							AND m.created_at > r.completed_at)`;
				return { sessions: [event.sessionId], messages: [] };
			}

			const terminal = runTerminalStatus(event, event.provider);
			if (terminal) {
				const ended = yield* sql<{
					id: string;
				}>`UPDATE provider_runs SET status = ${terminal}, completed_at = ${event.createdAt}
					WHERE id = ${runId} AND session_id = ${event.sessionId} AND status IN ('pending', 'running') RETURNING id`;
				if (!ended.length) return { sessions: [], messages: [] };
				yield* sql`UPDATE sessions SET status = CASE WHEN EXISTS (
					SELECT 1 FROM provider_runs WHERE session_id = ${event.sessionId}
						AND status IN ('pending', 'running')) THEN 'busy' ELSE 'idle' END
					WHERE id = ${event.sessionId}`;
				// Only a run transition with placed members advances the browser's
				// completion boundary; an unplaced refusal cannot erase another end.
				yield* sql`UPDATE sessions SET updated_at = ${event.createdAt},
					last_turn_error_at = ${terminal === "error" ? event.createdAt : null},
					last_turn_end_input_id = (SELECT messages.input_id FROM messages
						JOIN turns ON turns.user_message_id = messages.id
						WHERE turns.run_id = ${runId} AND turns.session_id = ${event.sessionId}
							AND messages.input_id IS NOT NULL
						ORDER BY turns.started_at, turns.requested_at, messages.rowid LIMIT 1),
					last_turn_end_version = ${event.streamVersion}
					WHERE id = ${event.sessionId}
					AND ${event.streamVersion} > COALESCE(last_turn_end_version, -1)
					AND EXISTS (SELECT 1 FROM turns WHERE run_id = ${runId}
						AND session_id = ${event.sessionId})`;
				if (
					isEventType(event, "turn.completed") &&
					event.data.providerStateUpdates
				) {
					const state = yield* makeProviderStateEffect.pipe(
						Effect.provideService(PersistenceProjectTag, {
							projectId: event.projectId,
						}),
					);
					yield* state.saveUpdates(
						event.sessionId,
						event.data.providerStateUpdates,
					);
				}
				yield* settleRunCommands(runId, event);
				const written = yield* sql<OwnedRow & { id: string }>`UPDATE turns
					SET state = ${terminal}, completed_at = ${event.createdAt}
					WHERE run_id = ${runId}
					AND session_id = ${event.sessionId} AND state IN ('pending', 'running')
					RETURNING id, session_id`;
				const messages = yield* sql<{ id: string }>`UPDATE messages
					SET is_streaming = 0, updated_at = ${event.createdAt},
						finish = CASE WHEN ${terminal} = 'interrupted' THEN 'interrupted' ELSE finish END
					WHERE session_id = ${event.sessionId} AND (is_streaming = 1 OR (${terminal} = 'interrupted' AND role = 'user'))
					AND turn_id IN (SELECT id FROM turns WHERE run_id = ${runId}
						AND session_id = ${event.sessionId}) RETURNING id`;
				const thinking = yield* sql<{ message_id: string }>`UPDATE message_parts
					SET status = 'completed', version = ${ctx.version}
					WHERE type = 'thinking' AND status = 'running' AND message_id IN (
						SELECT messages.id FROM messages JOIN turns ON turns.id = messages.turn_id
						WHERE turns.run_id = ${runId} AND turns.session_id = ${event.sessionId})
					RETURNING message_id`;
				ctx.endedRunEvents?.add(event.eventId);
				return {
					sessions: [event.sessionId],
					messages: [
						...ids(written),
						...ids(messages),
						...thinking.map(({ message_id }) => message_id),
					],
				};
			}

			return { sessions: [], messages: [] };
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "turn",
							operation: "project",
							cause: e,
						}),
			),
			Effect.flatMap((written) =>
				Effect.gen(function* () {
					return mergeTouches([
						yield* stampMessage(written.messages, ctx),
						{
							...(yield* stampSessions(written.sessions, ctx.version)),
							sidebar: written.sessions,
						},
					]);
				}),
			),
		),
}));

export const makeApprovalProjector = defineProjector(() => ({
	name: "approval",
	handles: [
		"permission.asked",
		"permission.resolved",
		"question.asked",
		"question.resolved",
	],
	project: (event, ctx) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			// `version` is what the approvals subscription windows on (ni8.9);
			// `details` keeps the rest of the asked payload for the card.
			if (isEventType(event, "permission.asked")) {
				const {
					id,
					sessionId,
					toolName,
					input,
					providerProcessId,
					providerRequestId,
					...details
				} = event.data;
				return yield* sql<OwnedRow & { created_at: number }>`
						INSERT INTO pending_approvals
						(id, session_id, type, status, tool_name, input, details, version, created_at, provider_process_id, provider_request_id)
						VALUES (${id}, ${sessionId}, 'permission', 'pending', ${toolName}, ${encodeJson(input)}, ${encodeJson(details)}, ${ctx.version}, ${event.createdAt}, ${providerProcessId ?? null}, ${providerRequestId ?? null})
						ON CONFLICT DO NOTHING
						RETURNING session_id, created_at`;
			}

			if (isEventType(event, "permission.resolved")) {
				return yield* sql<OwnedRow & { created_at: number }>`
						UPDATE pending_approvals
						SET status = 'resolved', decision = ${event.data.decision}, resolved_at = ${event.createdAt}, version = ${ctx.version}
						WHERE id = ${event.data.id} AND session_id = ${event.sessionId} AND type = 'permission'
						RETURNING session_id, created_at`;
			}

			if (isEventType(event, "question.asked")) {
				const {
					id,
					sessionId,
					questions,
					providerProcessId,
					providerRequestId,
					...details
				} = event.data;
				return yield* sql<OwnedRow & { created_at: number }>`
						INSERT INTO pending_approvals
						(id, session_id, type, status, input, details, version, created_at, provider_process_id, provider_request_id)
						VALUES (${id}, ${sessionId}, 'question', 'pending', ${encodeJson(questions)}, ${encodeJson(details)}, ${ctx.version}, ${event.createdAt}, ${providerProcessId ?? null}, ${providerRequestId ?? null})
						ON CONFLICT DO NOTHING
						RETURNING session_id, created_at`;
			}

			if (isEventType(event, "question.resolved")) {
				const answersJson = encodeJson(event.data.answers);
				return yield* sql<OwnedRow & { created_at: number }>`
						UPDATE pending_approvals
						SET status = 'resolved', decision = ${answersJson}, resolved_at = ${event.createdAt}, version = ${ctx.version}
						WHERE id = ${event.data.id} AND session_id = ${event.sessionId} AND type = 'question'
						RETURNING session_id, created_at`;
			}
			return [];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "approval",
							operation: "project",
							cause: e,
						}),
			),
			Effect.flatMap((written) =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const messageIds: string[] = [];
					for (const approval of written) {
						// Every turn open across the wait reads it (see turnTimingColumns),
						// so a prompt queued behind a running one needs both re-sent.
						const turns = yield* sql<{ id: string }>`
							SELECT id FROM turns
							WHERE session_id = ${approval.session_id}
							AND requested_at <= ${approval.created_at}
							AND (completed_at IS NULL OR completed_at >= ${approval.created_at})`;
						messageIds.push(...ids(turns));
					}
					const sessions = yield* stampSessions(owners(written), ctx.version);
					return mergeTouches([
						yield* stampMessage(messageIds, ctx),
						// The pending counts roll up into the family's row.
						{
							...sessions,
							collections:
								written.length > 0
									? [...sessions.collections, "approvals"]
									: sessions.collections,
							sidebar: sessions.stamped,
						},
					]);
				}),
			),
		),
}));

export const makeProviderProjector = defineProjector(() => ({
	name: "provider",
	handles: ["session.created", "session.provider_changed"],
	project: (event, ctx) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			if (isEventType(event, "session.created")) {
				return owners(
					yield* sql<OwnedRow>`
						INSERT OR IGNORE INTO session_providers (id, session_id, provider, status, activated_at)
						SELECT ${`${event.data.sessionId}:initial`}, id, ${event.data.provider}, 'active', ${event.createdAt}
						FROM sessions WHERE id = ${event.data.sessionId}
						RETURNING session_id`,
				);
			}

			if (isEventType(event, "session.provider_changed")) {
				const stopped = yield* sql<OwnedRow>`
					UPDATE session_providers
					SET status = 'stopped', deactivated_at = ${event.createdAt}
					WHERE session_id = ${event.data.sessionId} AND status = 'active'
					RETURNING session_id`;

				const started = yield* sql<OwnedRow>`
					INSERT OR IGNORE INTO session_providers (id, session_id, provider, status, activated_at)
					VALUES (${`${event.data.sessionId}:${event.sequence}`}, ${event.data.sessionId}, ${event.data.newProvider}, 'active', ${event.createdAt})
					RETURNING session_id`;
				return [...owners(stopped), ...owners(started)];
			}
			return [];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "provider",
							operation: "project",
							cause: e,
						}),
			),
			Effect.flatMap((written) => stampSessions(written, ctx.version)),
		),
}));

// One row per input conduit is holding. Rows are never deleted: a row that
// leaves the tray turns `removed` and takes the event's version, so catch-up
// can report it gone. Its owning session moves with every write.
export const makeInputProjector = defineProjector(() => ({
	name: "input",
	handles: [
		"input.admitted",
		"input.sent",
		"input.requeued",
		"input.cancelled",
		"input.interrupt_requested",
		"message.created",
	],
	project: (event, ctx) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			if (isEventType(event, "input.admitted")) {
				const { request } = event.data;
				const images = request.images ? encodeJson(request.images) : null;
				return owners(
					yield* sql<OwnedRow>`
						INSERT INTO pending_inputs
						(input_id, session_id, text, images, request, state, admitted_at, version)
						VALUES (${event.data.inputId}, ${event.data.sessionId}, ${request.text}, ${images}, ${encodeJson(request)}, 'queued', ${event.createdAt}, ${ctx.version})
						ON CONFLICT (input_id) DO NOTHING
						RETURNING session_id`,
				);
			}

			// The interrupt marker stays in events; the input remains queued.
			if (isEventType(event, "input.interrupt_requested"))
				return [event.data.sessionId];

			// Sent as a steer, the input stays in the tray until its message lands.
			// Otherwise it starts its own turn and leaves now.
			if (isEventType(event, "input.sent")) {
				return owners(
					yield* sql<OwnedRow>`
						UPDATE pending_inputs
						SET state = ${event.data.steer ? "steering" : "removed"},
							version = ${ctx.version}
						WHERE input_id = ${event.data.inputId} AND state = 'queued'
						RETURNING session_id`,
				);
			}

			if (isEventType(event, "input.cancelled")) {
				return owners(
					yield* sql<OwnedRow>`
						UPDATE pending_inputs SET state = 'removed', version = ${ctx.version}
						WHERE input_id = ${event.data.inputId} AND state = 'queued'
						RETURNING session_id`,
				);
			}

			if (isEventType(event, "input.requeued")) {
				return owners(
					yield* sql<OwnedRow>`
						UPDATE pending_inputs SET state = 'queued', version = ${ctx.version},
							admitted_at = CASE WHEN ${event.metadata.runId ?? null} IS NOT NULL THEN admitted_at
								ELSE (SELECT COALESCE(MIN(admitted_at), ${event.createdAt}) - 1
								FROM pending_inputs WHERE session_id = ${event.sessionId}
								AND state IN ('queued', 'steering')) END
						WHERE input_id = ${event.data.inputId} AND session_id = ${event.sessionId}
							AND (state = 'steering' AND NOT EXISTS (SELECT 1 FROM messages WHERE input_id = ${event.data.inputId})
								OR state = 'removed' AND EXISTS (SELECT 1 FROM provider_runs reservation JOIN provider_runs run
									ON run.id = COALESCE(reservation.joined_into, reservation.id) AND run.session_id = reservation.session_id
									WHERE reservation.session_id = ${event.sessionId} AND reservation.id = ${event.metadata.runId ?? null}
										AND run.status IN ('error', 'interrupted')))
							AND ${event.data.sentSequence} = (SELECT MAX(sequence) FROM events
								WHERE session_id = ${event.sessionId} AND type = 'input.sent'
								AND json_extract(data, '$.inputId') = ${event.data.inputId}
								AND sequence < ${event.sequence})
							AND (${ctx.replaying ? 1 : 0} = 1 OR NOT EXISTS (SELECT 1 FROM events
								WHERE session_id = ${event.sessionId} AND type = 'input.sent'
								AND json_extract(data, '$.inputId') = ${event.data.inputId}
								AND sequence > ${event.data.sentSequence}))
						RETURNING session_id`,
				);
			}

			if (
				isEventType(event, "message.created") &&
				event.data.role === "user" &&
				event.data.inputId
			) {
				return owners(
					yield* sql<OwnedRow>`
						UPDATE pending_inputs
						SET state = 'removed', version = ${ctx.version}
						WHERE input_id = ${event.data.inputId} AND state != 'removed'
						RETURNING session_id`,
				);
			}
			return [];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "input",
							operation: "project",
							cause: e,
						}),
			),
			Effect.flatMap((written) => stampSessions(written, ctx.version)),
			Effect.map((touch) => ({
				...touch,
				sidebar: touch.stamped,
				collections:
					touch.stamped.length > 0 && event.type !== "input.interrupt_requested"
						? ([...touch.collections, "inputs"] as const)
						: touch.collections,
			})),
		),
}));

// Session first for foreign keys. Keep factories so callers get fresh projectors.
const PROJECTORS = [
	makeSessionProjector,
	makeMessageProjector,
	makeTurnProjector,
	makeProviderProjector,
	makeApprovalProjector,
	makeInputProjector,
] as const;

type HandledBy<P extends EffectProjector> = P["handles"][number];
type Unhandled = Exclude<
	LiveEventType,
	HandledBy<ReturnType<(typeof PROJECTORS)[number]>>
>;

// Unlike {}, the empty case still rejects stale reason entries.
export type UnprojectedReasons<T extends LiveEventType> = [T] extends [never]
	? Readonly<Record<string, never>>
	: { readonly [K in T]: string };

// Every unhandled live event needs a reason; handled or retired entries are stale.
export const UNPROJECTED: UnprojectedReasons<Unhandled> = {
	"session.provider_cleanup_failed":
		"Audit receipt for failed upstream cleanup; no materialized projection needed",
	"session.handoff_delivered":
		"Delivery receipt needs no materialized projection",
};

/**
 * Creates all Effect-based projectors in the correct order.
 * Order matters for FK compliance: SessionProjector first.
 */
export function createAllEffectProjectors(): EffectProjector[] {
	return PROJECTORS.map((makeProjector) => makeProjector());
}

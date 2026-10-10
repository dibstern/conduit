import type { SqlClient } from "@effect/sql";
import { Effect, Schema } from "effect";
import {
	type ClaudeWorktreeState,
	ClaudeWorktreeStateSchema,
	SessionWorkspaceSchema,
} from "../contracts/session-workspace.js";
import type {
	CanonicalEventType,
	StoredEvent,
} from "../contracts/stored-event.js";
import { effectiveWorkingDirectory } from "./session-workspace.js";

export const CLAUDE_WORKTREE_EVENTS = new Set<CanonicalEventType>([
	"tool.completed",
	"session.workspace_started",
	"session.workspace_changed",
	"input.sent",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
]);

const workspaceResult = Schema.Struct({
	path: Schema.String,
	entered: Schema.Boolean,
});
export const decodeClaudeWorktreeState = Schema.decodeUnknownSync(
	Schema.parseJson(ClaudeWorktreeStateSchema),
);
const decodeWorkspace = Schema.decodeUnknownSync(
	Schema.parseJson(SessionWorkspaceSchema),
);

/** Fold canonical facts during projection; no history inference or backfill. */
export function projectClaudeWorktreeState(
	previous: ClaudeWorktreeState | undefined,
	event: StoredEvent,
): ClaudeWorktreeState | undefined {
	let entered = previous?.entered ?? false;
	let observed = previous?.observed;
	let pending = previous?.pending;
	switch (event.type) {
		case "tool.completed": {
			const workspace = event.data.metadata?.["workspace"];
			if (!Schema.is(workspaceResult)(workspace)) return previous;
			entered = workspace.entered;
			observed = workspace.path;
			break;
		}
		case "session.workspace_started":
			observed = event.data.path;
			break;
		case "session.workspace_changed": {
			// Old resets have no path. Keep them decodable without guessing one.
			const path = event.data.path ?? Object.values(event.data.worktrees)[0];
			if (path === undefined) return previous;
			if (event.data.cause === "user") {
				pending = {
					sequence: event.sequence,
					path,
					needsDirective: entered,
					directiveSent: false,
					turnEnded: false,
				};
			} else if (event.data.cause === "agent") observed = path;
			else return previous;
			break;
		}
		case "input.sent":
			if (!pending || event.data.workspaceMoveSequence !== pending.sequence)
				return previous;
			pending = { ...pending, directiveSent: true };
			break;
		case "turn.completed":
		case "turn.error":
		case "turn.interrupted":
			if (!pending?.directiveSent) return previous;
			pending = { ...pending, turnEnded: true };
			break;
		default:
			return previous;
	}
	if (pending?.path === observed) pending = undefined;
	return {
		entered,
		...(observed === undefined ? {} : { observed }),
		...(pending === undefined ? {} : { pending }),
	};
}

/** Only a completed directive turn can expose non-compliance to the browser. */
export function claudeWorkspaceMismatch(
	state: ClaudeWorktreeState | undefined,
) {
	const pending = state?.pending;
	return pending?.directiveSent &&
		pending.turnEnded &&
		state?.observed !== undefined &&
		state.observed !== pending.path
		? { actualPath: state.observed }
		: undefined;
}

export function deriveClaudeWorktreeState(
	state: ClaudeWorktreeState | undefined,
	recordedPath: string,
) {
	const pending = state?.pending;
	return {
		enteredWorktree: state?.entered ?? false,
		pendingUserMove: pending !== undefined,
		directivePending:
			pending?.needsDirective === true && !pending.directiveSent,
		userMoveSequence: pending?.sequence,
		requestedPath: pending?.path ?? recordedPath,
		workspaceMismatch: claudeWorkspaceMismatch(state),
	};
}

export const readClaudeWorktreeState = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	primary: string,
) =>
	sql<{ workspace: string | null; claude_worktree_state: string | null }>`
		SELECT workspace, claude_worktree_state FROM sessions WHERE id = ${sessionId}`.pipe(
		Effect.map(([row]) =>
			deriveClaudeWorktreeState(
				row?.claude_worktree_state
					? decodeClaudeWorktreeState(row.claude_worktree_state)
					: undefined,
				effectiveWorkingDirectory(
					primary,
					row?.workspace ? decodeWorkspace(row.workspace) : undefined,
				),
			),
		),
	);

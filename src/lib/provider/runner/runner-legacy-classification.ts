import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Fragment } from "effect/sql/Statement";
import type { RunnerHello } from "./runner-protocol.js";
import type { SessionFailure } from "./session-runner.js";

// A leaf: runner modules import these downward, so at runtime it imports only
// effect. Delete with the legacy runner compatibility paths (32.13).

/** The one legacy runner predicate: a runner whose hello carries no send journal. */
export const isLegacyRunner = (hello: {
	readonly sendJournalAnswers?: boolean;
}): boolean => hello.sendJournalAnswers !== true;

/** Whether a runner journals each send before executing it. A cursor row from before
 * migration 0089 records nothing, so it falls back to the runner's build. */
export const journalsBeforeExecution = (
	row: { readonly journals_before_execution: number | null } | undefined,
	currentBuild: boolean,
): boolean =>
	row?.journals_before_execution == null
		? currentBuild
		: row.journals_before_execution === 1;

// These fields restore sinks and answer waiters only. A send is decided by replaying
// its unchanged journal key, exactly as ecb3840d did, never from the legacy hello.
export const legacyRunnerRetainedSends = (
	hello: RunnerHello,
): NonNullable<RunnerHello["sendTokens"]> => hello.sendTokens ?? [];

export const legacyRunnerAnswerCompletions = (
	hello: RunnerHello,
): readonly {
	readonly commandId: string;
	readonly failure?: SessionFailure;
}[] => hello.completedCommands ?? [];

export const legacyRunnerBindings = (
	hello: RunnerHello,
): NonNullable<RunnerHello["bindings"]> => hello.bindings ?? [];

/** One predicate for legacy provenance, also usable in correlated ledger reads. */
export const legacyRunnerRunPredicate = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	runId: string | Fragment,
) => sql`EXISTS (
	SELECT 1 FROM provider_runs legacy_run
	WHERE legacy_run.id = ${runId} AND legacy_run.session_id = ${sessionId}
	AND NOT EXISTS (SELECT 1 FROM events WHERE session_id = legacy_run.session_id
		AND type = 'run.released' AND json_extract(data, '$.runId') = legacy_run.id)
	AND NOT EXISTS (SELECT 1 FROM events WHERE session_id = legacy_run.session_id
		AND type = 'run.dispatched' AND json_extract(data, '$.runId') = legacy_run.id
		AND json_extract(data, '$.commandId') IS NOT NULL)
	AND (EXISTS (
		SELECT 1 FROM claude_runner_cursors legacy_cursor
		JOIN json_each(CASE WHEN json_valid(legacy_cursor.owned_run_ids)
			THEN CASE json_type(legacy_cursor.owned_run_ids) WHEN 'array' THEN legacy_cursor.owned_run_ids ELSE '[]' END
			ELSE '[]' END) cohort
		JOIN provider_runs legacy_owned ON legacy_owned.id = cohort.value AND legacy_owned.session_id = legacy_cursor.session_id
		WHERE legacy_cursor.session_id = legacy_run.session_id AND cohort.type = 'text'
			AND COALESCE(legacy_owned.joined_into, legacy_owned.id) = legacy_run.id
	) OR EXISTS (SELECT 1 FROM events WHERE session_id = legacy_run.session_id AND type = 'run.dispatched'
		AND json_extract(data, '$.runId') = legacy_run.id AND json_extract(data, '$.commandId') IS NULL)
		OR (legacy_run.started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM events
			WHERE session_id = legacy_run.session_id AND type = 'run.dispatched' AND json_extract(data, '$.runId') = legacy_run.id)))
)`;

// claude_runner_cursors exists from migration 0089 on, so no reader creates it.
export const legacyRunnerRunQuery = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	runId: string,
) =>
	sql<{
		legacy: number;
	}>`SELECT ${legacyRunnerRunPredicate(sql, sessionId, runId)} AS legacy`.pipe(
		Effect.map(([row]) => row?.legacy === 1),
	);

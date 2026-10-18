import { Effect, HashMap, type Option, Ref } from "effect";
import { SqlClient } from "effect/sql";
import type { OpenCodeAPI } from "../../../instance/opencode-api.js";
import type {
	SessionDetail,
	SessionStatus,
} from "../../../instance/sdk-types.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import type { SessionRow } from "../../../persistence/read-model-types.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import {
	type SessionActivity,
	SessionActivityTag,
} from "../../daemon/Services/session-activity.js";
import {
	makeSessionRows,
	type SessionRowsScope,
} from "../../daemon/Services/session-rows.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import {
	type RelayStatusSnapshotService,
	RelayStatusSnapshotTag,
} from "./relay-status-snapshot.js";
import type { StatusPollerShape } from "./services.js";
import { SessionManagerError } from "./session-manager-error.js";
import type {
	ListSessionsOptions,
	SessionManagerService,
} from "./session-manager-service.js";
import {
	type SessionManagerState,
	SessionManagerStateTag,
} from "./session-manager-state.js";

const sessionRowsParentMap = (
	rows: readonly Pick<SessionRow, "id" | "parent_id">[],
): HashMap.HashMap<string, string> => {
	let parentMap = HashMap.empty<string, string>();
	for (const row of rows) {
		if (row.parent_id) {
			parentMap = HashMap.set(parentMap, row.id, row.parent_id);
		}
	}
	return parentMap;
};

export const sessionDetailsParentMap = (
	sessions: readonly SessionDetail[],
): HashMap.HashMap<string, string> => {
	let parentMap = HashMap.empty<string, string>();
	for (const session of sessions) {
		const parentID = session.parentID;
		if (parentID) {
			parentMap = HashMap.set(parentMap, session.id, parentID);
		}
	}
	return parentMap;
};

export const updateRelaySessionCountSnapshot = (sessionCount: number) =>
	RelayStatusSnapshotTag.pipe(
		Effect.flatMap((snapshot) => snapshot.setSessionCount(sessionCount)),
	);

export const incrementLastKnownSessionCount = () =>
	Effect.gen(function* () {
		const stateRef = yield* SessionManagerStateTag;
		const sessionCount = yield* Ref.modify(stateRef, (state) => {
			const nextCount = state.lastKnownSessionCount + 1;
			return [
				nextCount,
				{
					...state,
					lastKnownSessionCount: nextCount,
				},
			];
		});
		yield* updateRelaySessionCountSnapshot(sessionCount);
		return sessionCount;
	});

/**
 * Fetch the session list from the API.
 * Caches the child-to-parent map in state for subagent status propagation.
 */
export const listSessions = (
	projectSlug: string,
	options: ListSessionsOptions | undefined,
	scope: SessionRowsScope,
) =>
	Effect.gen(function* () {
		const stateRef = yield* SessionManagerStateTag;
		const readQuery = yield* ReadQueryEffectTag;
		const rows = yield* makeSessionRows(scope);
		const [sessions, lineage] = yield* Effect.all([
			rows.list({
				...(options?.roots !== undefined ? { roots: options.roots } : {}),
				...(options?.limit !== undefined ? { limit: options.limit } : {}),
				...(options?.statuses !== undefined
					? { statuses: options.statuses }
					: {}),
			}),
			readQuery.getSessionLineage({ projectIds: [scope.slug] }),
		]).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({ operation: "listSessions", cause }),
			),
		);
		yield* Ref.update(stateRef, (current) => ({
			...current,
			cachedParentMap: sessionRowsParentMap(lineage.rows),
			cachedSideThreadIds: new Set(
				lineage.rows.flatMap((row) => (row.side_thread === 1 ? [row.id] : [])),
			),
			lastKnownSessionCount: lineage.count,
		}));
		yield* updateRelaySessionCountSnapshot(lineage.count);
		return sessions;
	}).pipe(
		Effect.annotateLogs({ operation: "listSessions", projectSlug }),
		Effect.withSpan("session.listSessions"),
	);

/** Whether this relay's project has the requested session. */
export const sessionExists = (sessionId: string) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const session = yield* readQuery
			.getSession(sessionId)
			.pipe(
				Effect.mapError(
					(cause) =>
						new SessionManagerError({ operation: "sessionExists", cause }),
				),
			);
		return session !== undefined;
	}).pipe(
		Effect.annotateLogs({ operation: "sessionExists", sessionId }),
		Effect.withSpan("session.sessionExists"),
	);

export const makeSessionListOperations = ({
	api,
	stateRef,
	readQuery,
	sql,
	accounts,
	statusPollerOption,
	activity,
	snapshot,
	projectFolders,
	projectSlug,
}: {
	api: OpenCodeAPI;
	stateRef: Ref.Ref<SessionManagerState>;
	readQuery: ReadQueryEffect;
	sql: SqlClient.SqlClient;
	accounts: AccountDirectory["Type"];
	statusPollerOption: Option.Option<StatusPollerShape>;
	activity: SessionActivity;
	snapshot: RelayStatusSnapshotService;
	projectFolders: readonly [string, ...string[]];
	projectSlug: string;
}) => {
	const currentStatuses = (
		explicit?: Record<string, SessionStatus> | undefined,
	): Effect.Effect<Record<string, SessionStatus> | undefined> => {
		if (explicit !== undefined) return Effect.succeed(explicit);
		return statusPollerOption._tag === "Some"
			? statusPollerOption.value.getCurrentStatuses()
			: Effect.succeed(undefined);
	};
	const serviceListSessions = (options?: ListSessionsOptions) =>
		Effect.gen(function* () {
			const statuses = yield* currentStatuses(options?.statuses);
			const base = listSessions(
				projectSlug,
				{
					...options,
					statuses,
				},
				{ slug: projectSlug, folders: projectFolders },
			).pipe(
				Effect.provideService(OpenCodeAPITag, api),
				Effect.provideService(SessionManagerStateTag, stateRef),
				Effect.provideService(SqlClient.SqlClient, sql),
				Effect.provideService(AccountDirectory, accounts),
			);
			const withEffectRead = base.pipe(
				Effect.provideService(ReadQueryEffectTag, readQuery),
			);
			return yield* withEffectRead.pipe(
				Effect.provideService(SessionActivityTag, activity),
				Effect.provideService(RelayStatusSnapshotTag, snapshot),
			);
		});
	const refreshSessionLineage: SessionManagerService["refreshSessionLineage"] =
		() =>
			Effect.gen(function* () {
				const lineage = yield* readQuery
					.getSessionLineage({ projectIds: [projectSlug] })
					.pipe(
						Effect.mapError(
							(cause) =>
								new SessionManagerError({
									operation: "refreshSessionLineage",
									cause,
								}),
						),
					);
				yield* Ref.update(stateRef, (current) => ({
					...current,
					cachedParentMap: sessionRowsParentMap(lineage.rows),
					cachedSideThreadIds: new Set(
						lineage.rows.flatMap((row) =>
							row.side_thread === 1 ? [row.id] : [],
						),
					),
					lastKnownSessionCount: lineage.count,
				}));
				yield* snapshot.setSessionCount(lineage.count);
			});
	return { serviceListSessions, refreshSessionLineage };
};

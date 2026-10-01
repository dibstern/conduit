import { Effect, HashMap, type Option, Ref } from "effect";
import { daemonSessionGitCache } from "../../../git/session-git.js";
import type { OpenCodeAPI } from "../../../instance/opencode-api.js";
import type {
	SessionDetail,
	SessionStatus,
} from "../../../instance/sdk-types.js";
import {
	pendingApprovalCountsByType,
	type ReadQueryEffect,
	ReadQueryEffectTag,
	sessionRowsToSessionInfoList,
} from "../../../persistence/effect/read-query-effect.js";
import type { SessionRow } from "../../../persistence/read-model-types.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import {
	type RelayStatusSnapshotService,
	RelayStatusSnapshotTag,
} from "./relay-status-snapshot.js";
import type { StatusPollerShape, WebSocketHandlerShape } from "./services.js";
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
export const listSessions = (options?: ListSessionsOptions) =>
	Effect.gen(function* () {
		const stateRef = yield* SessionManagerStateTag;
		const readQuery = yield* ReadQueryEffectTag;
		const [sessions, lineage] = yield* Effect.all([
			readQuery.listSessionInfos({
				...(options?.roots !== undefined ? { roots: options.roots } : {}),
				...(options?.limit !== undefined ? { limit: options.limit } : {}),
				...(options?.statuses !== undefined
					? { statuses: options.statuses }
					: {}),
				...(options?.hasLiveBackgroundWork && {
					hasLiveBackgroundWork: options.hasLiveBackgroundWork,
				}),
			}),
			readQuery.getSessionLineage(),
		]).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({ operation: "listSessions", cause }),
			),
		);
		yield* Ref.update(stateRef, (current) => ({
			...current,
			cachedParentMap: sessionRowsParentMap(lineage.rows),
			lastKnownSessionCount: lineage.count,
		}));
		yield* updateRelaySessionCountSnapshot(lineage.count);
		return [...sessions];
	}).pipe(
		Effect.annotateLogs("operation", "listSessions"),
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
	statusPollerOption,
	hasLiveBackgroundWork,
	snapshot,
	wsHandler,
	projectDir,
}: {
	api: OpenCodeAPI;
	stateRef: Ref.Ref<SessionManagerState>;
	readQuery: ReadQueryEffect;
	statusPollerOption: Option.Option<StatusPollerShape>;
	hasLiveBackgroundWork: ((sessionId: string) => boolean) | undefined;
	snapshot: RelayStatusSnapshotService;
	wsHandler: WebSocketHandlerShape;
	projectDir: string;
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
			const base = listSessions({
				...options,
				statuses,
				...(hasLiveBackgroundWork && { hasLiveBackgroundWork }),
			}).pipe(
				Effect.provideService(OpenCodeAPITag, api),
				Effect.provideService(SessionManagerStateTag, stateRef),
			);
			const withEffectRead = base.pipe(
				Effect.provideService(ReadQueryEffectTag, readQuery),
			);
			const sessions = yield* withEffectRead.pipe(
				Effect.provideService(RelayStatusSnapshotTag, snapshot),
			);
			const git = daemonSessionGitCache.peek(projectDir);
			return git
				? sessions.map((session) => ({ ...session, git }))
				: [...sessions];
		});
	const getSessionFamily: SessionManagerService["getSessionFamily"] = (
		sessionId,
	) =>
		Effect.gen(function* () {
			const [rows, approvals] = yield* Effect.all([
				readQuery.getSessionFamily(sessionId),
				readQuery.countPendingApprovalsBySession(),
			]).pipe(
				Effect.mapError(
					(cause) =>
						new SessionManagerError({ operation: "getSessionFamily", cause }),
				),
			);
			// Poller statuses include ancestor propagation; family rows keep their own state.
			const familyStatuses: Record<string, SessionStatus> = {};
			for (const row of rows) {
				familyStatuses[row.id] =
					row.status === "busy" || row.status === "retry"
						? { type: "busy" }
						: { type: "idle" };
			}
			const ids = new Set(rows.map((row) => row.id));
			const root = rows.find(
				(row) => !row.parent_id || !ids.has(row.parent_id),
			);
			return {
				type: "session_family" as const,
				rootId: root?.id ?? sessionId,
				sessions: sessionRowsToSessionInfoList(rows, {
					statuses: familyStatuses,
					...(hasLiveBackgroundWork && { hasLiveBackgroundWork }),
					pendingQuestionCounts:
						pendingApprovalCountsByType(approvals).questions,
					pendingPermissionCounts:
						pendingApprovalCountsByType(approvals).permissions,
				}),
			};
		});
	const pushViewerFamilies: SessionManagerService["pushViewerFamilies"] = () =>
		Effect.gen(function* () {
			const lineage = yield* readQuery.getSessionLineage().pipe(
				Effect.mapError(
					(cause) =>
						new SessionManagerError({
							operation: "pushViewerFamilies",
							cause,
						}),
				),
			);
			yield* Ref.update(stateRef, (current) => ({
				...current,
				cachedParentMap: sessionRowsParentMap(lineage.rows),
				lastKnownSessionCount: lineage.count,
			}));
			yield* snapshot.setSessionCount(lineage.count);
			const ws = wsHandler;
			const parentMap = (yield* Ref.get(stateRef)).cachedParentMap;
			const families = new Map<string, string[]>();
			for (const clientId of ws.getClientIds()) {
				const viewed = ws.getClientSession(clientId);
				if (!viewed) continue;
				let root = viewed;
				const seen = new Set<string>();
				while (!seen.has(root)) {
					seen.add(root);
					const parent = HashMap.get(parentMap, root);
					if (parent._tag === "None") break;
					root = parent.value;
				}
				const viewers = families.get(root) ?? [];
				viewers.push(clientId);
				families.set(root, viewers);
			}
			for (const [root, viewers] of families) {
				const family = yield* getSessionFamily(root);
				const familyIds = new Set(family.sessions.map((session) => session.id));
				for (const clientId of viewers) {
					const viewed = ws.getClientSession(clientId);
					if (viewed && (familyIds.has(viewed) || viewed === family.rootId)) {
						ws.sendTo(clientId, family);
					}
				}
			}
		});
	return { serviceListSessions, getSessionFamily, pushViewerFamilies };
};

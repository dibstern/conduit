import { Effect, HashMap, type Option, Ref } from "effect";
import type { ForkEntry } from "../../../daemon/fork-metadata.js";
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
import {
	type PendingApprovalCounts,
	pendingApprovalCountsByType,
	sessionRowsToSessionInfoList,
} from "../../../persistence/session-list-adapter.js";
import type { RelayMessage, SessionInfo } from "../../../types.js";
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

type SessionListMessage = Extract<RelayMessage, { type: "session_list" }>;

const toReadonlyMap = <K, V>(map: HashMap.HashMap<K, V>): ReadonlyMap<K, V> =>
	new Map(HashMap.toEntries(map));

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
		const rec = session as Record<string, unknown>;
		const apiParentID = rec["parentID"];
		const parentID = typeof apiParentID === "string" ? apiParentID : undefined;
		if (parentID) {
			parentMap = HashMap.set(parentMap, session.id, parentID);
		}
	}
	return parentMap;
};

export const sessionRowsToInfo = (
	rows: readonly SessionRow[],
	options: ListSessionsOptions | undefined,
	state: {
		forkMeta: HashMap.HashMap<string, ForkEntry>;
	},
	pending: PendingApprovalCounts,
	parentMap?: ReadonlyMap<string, string>,
): SessionInfo[] =>
	sessionRowsToSessionInfoList(Array.from(rows), {
		...(options?.statuses !== undefined ? { statuses: options.statuses } : {}),
		forkMeta: toReadonlyMap(state.forkMeta),
		...(parentMap ? { parentMap } : {}),
		pendingQuestionCounts: pending.questions,
		pendingPermissionCounts: pending.permissions,
		...(options?.hasLiveBackgroundWork && {
			hasLiveBackgroundWork: options.hasLiveBackgroundWork,
		}),
	});

export const updateRelaySessionCountSnapshot = (sessionCount: number) =>
	Effect.serviceOption(RelayStatusSnapshotTag).pipe(
		Effect.flatMap((snapshot) =>
			snapshot._tag === "Some"
				? snapshot.value.setSessionCount(sessionCount)
				: Effect.void,
		),
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
		const sqOpts =
			options?.roots !== undefined ? { roots: options.roots } : undefined;
		const state = yield* Ref.get(stateRef);

		const [rows, pendingApprovals, lineage, projectedStatuses] =
			yield* Effect.all([
				readQuery.listSessions(sqOpts),
				readQuery.countPendingApprovalsBySession(),
				readQuery.getSessionLineage(),
				readQuery.getAllSessionStatuses(),
			]).pipe(
				Effect.mapError(
					(cause) =>
						new SessionManagerError({ operation: "listSessions", cause }),
				),
			);
		const parentMap = sessionRowsParentMap(lineage.rows);
		yield* Ref.update(stateRef, (s) => ({
			...s,
			cachedParentMap: parentMap,
			lastKnownSessionCount: lineage.count,
		}));
		yield* updateRelaySessionCountSnapshot(lineage.count);
		// The durable table wins outright here, with no fallback to the relay's
		// in-memory map. The map is only correct for a relay that saw the events
		// live, and a permission decision decrements it even though only a
		// question increments it, so falling back would reintroduce the skew the
		// projection exists to avoid.
		const statuses: Record<string, SessionStatus> = {};
		for (const [id, status] of Object.entries(projectedStatuses)) {
			statuses[id] =
				status === "busy" || status === "retry"
					? { type: "busy" }
					: { type: "idle" };
		}
		Object.assign(statuses, options?.statuses);
		return sessionRowsToInfo(
			rows,
			{ ...options, statuses },
			state,
			pendingApprovalCountsByType(pendingApprovals),
			toReadonlyMap(parentMap),
		);
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

/** Send the roots-only sidebar snapshot. */
export const sendSessionLists = (
	send: (msg: SessionListMessage) => void,
	options?: { statuses?: Record<string, SessionStatus> | undefined },
) =>
	Effect.gen(function* () {
		const roots = yield* listSessions({
			roots: true,
			statuses: options?.statuses,
		});
		send({ type: "session_list", sessions: roots, roots: true });
	});

export const makeSessionListOperations = ({
	api,
	stateRef,
	readQuery,
	statusPollerOption,
	hasLiveBackgroundWork,
	snapshotOption,
	wsHandlerOption,
}: {
	api: OpenCodeAPI;
	stateRef: Ref.Ref<SessionManagerState>;
	readQuery: ReadQueryEffect;
	statusPollerOption: Option.Option<StatusPollerShape>;
	hasLiveBackgroundWork: ((sessionId: string) => boolean) | undefined;
	snapshotOption: Option.Option<RelayStatusSnapshotService>;
	wsHandlerOption: Option.Option<WebSocketHandlerShape>;
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
			return yield* snapshotOption._tag === "Some"
				? withEffectRead.pipe(
						Effect.provideService(RelayStatusSnapshotTag, snapshotOption.value),
					)
				: withEffectRead;
		});
	const getSessionFamily: SessionManagerService["getSessionFamily"] = (
		sessionId,
	) =>
		Effect.gen(function* () {
			const [rows, approvals, state] = yield* Effect.all([
				readQuery.getSessionFamily(sessionId),
				readQuery.countPendingApprovalsBySession(),
				Ref.get(stateRef),
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
				sessions: sessionRowsToInfo(
					rows,
					{
						statuses: familyStatuses,
						...(hasLiveBackgroundWork && { hasLiveBackgroundWork }),
					},
					state,
					pendingApprovalCountsByType(approvals),
				),
			};
		});
	const serviceSendSessionLists: SessionManagerService["sendSessionLists"] = (
		send,
		options,
	) =>
		Effect.gen(function* () {
			const roots = yield* serviceListSessions({
				roots: true,
				statuses: options?.statuses,
			});
			send({ type: "session_list", sessions: roots, roots: true });
			if (wsHandlerOption._tag === "None") return;
			const ws = wsHandlerOption.value;
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
	return { serviceListSessions, getSessionFamily, serviceSendSessionLists };
};

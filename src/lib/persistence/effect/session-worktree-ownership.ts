import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
	type SessionWorktreeOwnership,
	type SessionWorktreeOwnershipSnapshot,
	SessionWorktreeOwnershipSnapshotSchema,
} from "../../contracts/session-workspace.js";
import { SessionWorkspaceChangedPayloadSchema } from "../../contracts/stored-event.js";

const decodeJson = Schema.decodeUnknownResult(
	Schema.fromJsonString(Schema.Unknown),
);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** The latest own snapshot is authoritative, including empty ownership and refusal. */
export const readSessionWorktreeOwnershipSnapshot = (
	projectId: string,
	sessionId: string,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [marker] = yield* sql<{ data: string }>`SELECT data FROM events
			WHERE project_id = ${projectId} AND session_id = ${sessionId} AND type = 'session.deleted'
				AND CASE WHEN json_valid(data) THEN json_extract(data, '$.sessionId') = session_id ELSE 0 END
				AND json_type(data, '$.worktreeOwnership') IS NOT NULL
			ORDER BY sequence DESC LIMIT 1`;
		if (marker) {
			const parsed = decodeJson(marker.data);
			const raw =
				Result.isSuccess(parsed) && isRecord(parsed.success)
					? parsed.success["worktreeOwnership"]
					: undefined;
			const decoded = Schema.decodeUnknownResult(
				SessionWorktreeOwnershipSnapshotSchema,
			)(raw);
			if (Result.isSuccess(decoded)) return decoded.success;
			return {
				_tag: "Conflict",
				reason: "malformed",
				discoveryPaths:
					isRecord(raw) && Array.isArray(raw["discoveryPaths"])
						? [
								...new Set(
									raw["discoveryPaths"].filter(
										(path): path is string => typeof path === "string",
									),
								),
							]
						: [],
			} satisfies SessionWorktreeOwnershipSnapshot;
		}
		const events = yield* sql<{ data: string }>`SELECT data FROM events
			WHERE project_id = ${projectId} AND session_id = ${sessionId} AND type = 'session.workspace_changed'
				AND (CASE WHEN json_valid(data) THEN
					(json_extract(data, '$.cause') = 'launch' AND json_extract(data, '$.origin') = 'conduit')
					OR json_extract(data, '$.cause') = 'branch-rename' ELSE 1 END)
			ORDER BY sequence`;
		if (events.length === 0) return undefined;
		const discoveryPaths = new Set<string>();
		const ownership = new Map<string, SessionWorktreeOwnership>();
		const legacy = new Map<string, string>();
		let modern = false;
		let conflict: "launch" | "branch-rename" | "malformed" | undefined;
		for (const { data } of events) {
			const parsed = decodeJson(data);
			const raw = Result.isSuccess(parsed) ? parsed.success : undefined;
			if (
				isRecord(raw) &&
				raw["cause"] === "launch" &&
				raw["origin"] === "conduit" &&
				isRecord(raw["worktrees"])
			)
				for (const path of Object.values(raw["worktrees"]))
					if (typeof path === "string") discoveryPaths.add(path);
			const decoded = Schema.decodeUnknownResult(
				SessionWorkspaceChangedPayloadSchema,
			)(raw);
			if (Result.isFailure(decoded)) {
				conflict = "malformed";
				continue;
			}
			const launch = decoded.success;
			modern ||= launch.ownership !== undefined;
			for (const owned of launch.ownership ?? []) {
				const previous = ownership.get(owned.path);
				if (launch.cause === "branch-rename") {
					if (
						!previous ||
						previous.folder !== owned.folder ||
						previous.head !== owned.head
					)
						conflict ??= "branch-rename";
				} else if (
					previous &&
					(previous.folder !== owned.folder ||
						previous.branchName !== owned.branchName ||
						previous.head !== owned.head)
				)
					conflict ??= "launch";
				ownership.set(owned.path, owned);
			}
			if (launch.ownership === undefined)
				for (const [folder, path] of Object.entries(launch.worktrees))
					legacy.set(folder, path);
		}
		const paths = [...discoveryPaths];
		if (conflict)
			return {
				_tag: "Conflict",
				reason: conflict,
				discoveryPaths: paths,
			} satisfies SessionWorktreeOwnershipSnapshot;
		return modern
			? ({
					_tag: "Owned",
					ownership: [...ownership.values()],
					discoveryPaths: paths,
				} satisfies SessionWorktreeOwnershipSnapshot)
			: ({
					_tag: "Legacy",
					worktrees: Object.fromEntries(legacy),
					discoveryPaths: paths,
				} satisfies SessionWorktreeOwnershipSnapshot);
	});

/** Shared discovery relation; paths never authorize removal. Bind the project id once. */
export const WORKTREE_CLEANUP_PATHS_SQL = `
	WITH worktree_events AS (
		SELECT session_id, type, CASE WHEN json_valid(data) THEN data ELSE '{}' END AS data, sequence FROM events
		WHERE project_id = ? AND type IN ('session.workspace_changed', 'session.deleted')
	)
	SELECT DISTINCT events.session_id, mapping.value AS path
	FROM worktree_events AS events, json_each(events.data, '$.worktrees') AS mapping
	WHERE events.type = 'session.workspace_changed'
		AND json_extract(events.data, '$.cause') = 'launch'
		AND json_extract(events.data, '$.origin') = 'conduit' AND mapping.type = 'text'
	UNION
	SELECT events.session_id, mapping.value AS path
	FROM worktree_events AS events, json_each(events.data, '$.worktreeOwnership.discoveryPaths') AS mapping
	WHERE events.type = 'session.deleted' AND json_extract(events.data, '$.sessionId') = events.session_id
		AND mapping.type = 'text'`;

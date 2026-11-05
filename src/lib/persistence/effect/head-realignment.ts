import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import {
	getProviderDriver,
	type ProviderDriverKind,
} from "../../contracts/provider-instance.js";
import type { ResumePlan } from "../../contracts/ws-rpc.js";
import { canonicalEvent } from "../events.js";
import { pathToRoot, readHead } from "./history-graph.js";
import { nativeThreadKey } from "./provider-state-effect.js";

/**
 * 82tn.51: a head move lands without calling the provider (3c7y); the next send tells it. The
 * provider still holds the path it last saw: the Head before the first move since the last
 * confirmation. What it must drop starts at the first node of that path off the Head now, and
 * it resumes at the Head's last message. A provider that cannot resume there (a branch it never
 * saw) falls back as it does for a failed cut. Read inside the send's write boundary; with
 * `upstreamRemovedId`, only that removal confirms.
 */
export const readOwedRealignment = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	upstreamRemovedId?: string,
) =>
	Effect.gen(function* () {
		const moves = yield* sql<{
			move_id: string;
			from_node: string | null;
			started_at: number;
		}>`
			SELECT json_extract(moved.data, '$.moveId') AS move_id, started.sequence AS started_at,
				json_extract(started.data, '$.from') AS from_node
			FROM events moved JOIN events started ON started.session_id = moved.session_id
				AND started.type = 'head.move_started'
				AND json_extract(started.data, '$.moveId') = json_extract(moved.data, '$.moveId')
			WHERE moved.session_id = ${sessionId} AND moved.type = 'head.moved'
				AND json_type(moved.data, '$.to') IS NOT NULL
				AND moved.sequence > COALESCE((SELECT MAX(sequence) FROM events
					WHERE session_id = ${sessionId} AND type = 'session.rewind_committed'
					AND json_extract(data, '$.moveId') IS NOT NULL), 0)
			ORDER BY moved.sequence`;
		const first = moves[0];
		const last = moves.at(-1);
		if (!first || !last) return undefined;
		const head = yield* readHead(sessionId);
		const onHead = new Set(yield* pathToRoot(sessionId, head));
		const lost = (yield* pathToRoot(sessionId, first.from_node))
			.filter((id) => !onHead.has(id))
			.reverse();
		const removed =
			lost.length === 0
				? []
				: yield* sql<{ id: string; node: string }>`
					SELECT row_key AS id, node_id AS node FROM history_off_head
					WHERE session_id = ${sessionId} AND source_table = 'messages'
						AND node_id IN ${sql.in(lost)}
					ORDER BY json_extract(row_json, '$.ordinal'), json_extract(row_json, '$.created_at'), row_key`;
		const target = removed.find(({ node }) => node === lost[0])?.id;
		if (upstreamRemovedId !== undefined && upstreamRemovedId !== target)
			return undefined;
		// The provider resumes at the newest row it holds. Conduit's own notices (an error, a
		// compaction marker) never reach it (as inherit-fork-history skips them), and nothing written
		// since the first move did either: a send that reached it would have confirmed the move.
		const [resume] = yield* sql<{ id: string }>`SELECT id FROM messages
			WHERE session_id = ${sessionId}
				AND id NOT GLOB 'compaction-[0-9]*' AND id NOT GLOB 'turn-error-[0-9]*'
				AND id NOT IN (SELECT COALESCE(json_extract(data, '$.messageId'), '') FROM events
					WHERE session_id = ${sessionId} AND sequence > ${first.started_at}
						AND type = 'message.created')
			ORDER BY ordinal DESC, created_at DESC, id DESC LIMIT 1`;
		const [session] = yield* sql<{ provider: string }>`
			SELECT provider FROM sessions WHERE id = ${sessionId}`;
		const removedMessageIds = removed.map(({ id }) => id);
		return {
			removedMessageIds,
			// Nothing the provider holds left the Head (a move and its undo): it only confirms.
			rewind:
				target === undefined
					? undefined
					: {
							resumeSessionAt: resume?.id ?? null,
							targetMessageId: target,
							removedMessageIds,
						},
			events: [
				canonicalEvent(
					"session.rewind_committed",
					sessionId,
					{ messageId: target ?? resume?.id ?? "", moveId: last.move_id },
					{ provider: session?.provider ?? "" },
				),
			],
		};
	}).pipe(Effect.provideService(SqlClient.SqlClient, sql));

/**
 * 82tn.52: the Turn Launcher's resume plan, read from the store before a send (the composer, a
 * head move's preview) as the launch reads it. The provider holds the path to the Head before the
 * first move it has not heard of; a native revert (Codex, OpenCode) can only drop turns from it,
 * so a Head off that path is refused. Claude resumes its own session at the Head when it has one,
 * otherwise it, like Cursor, starts fresh from a recorded handoff. A switch back to a provider
 * with a native session catches it up. A refused native resume still falls back to a handoff at
 * launch, recorded with its reason, so a "native" plan is the expected path, not a promise.
 */
export const readResumePlan = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	instanceId: string,
	driver: ProviderDriverKind,
	head?: string | null,
) =>
	Effect.gen(function* () {
		const traits = getProviderDriver(driver);
		const [owed] = yield* sql<{ from_node: string | null }>`
			SELECT json_extract(started.data, '$.from') AS from_node
			FROM events moved JOIN events started ON started.session_id = moved.session_id
				AND started.type = 'head.move_started'
				AND json_extract(started.data, '$.moveId') = json_extract(moved.data, '$.moveId')
			WHERE moved.session_id = ${sessionId} AND moved.type = 'head.moved'
				AND json_type(moved.data, '$.to') IS NOT NULL
				AND moved.sequence > COALESCE((SELECT MAX(sequence) FROM events
					WHERE session_id = ${sessionId} AND type = 'session.rewind_committed'
					AND json_extract(data, '$.moveId') IS NOT NULL), 0)
			ORDER BY moved.sequence LIMIT 1`;
		const at = head === undefined ? yield* readHead(sessionId) : head;
		const held = owed ? owed.from_node : yield* readHead(sessionId);
		const moved = at !== held;
		if (traits?.revertsConversationNatively)
			return (
				!moved
					? "current"
					: at === null || (yield* pathToRoot(sessionId, held)).includes(at)
						? "native"
						: "refused"
			) satisfies ResumePlan;
		const [facts] = yield* sql<{
			receipt: string | null;
			switched: number | null;
			delivered: number | null;
			history: number;
		}>`SELECT
			(SELECT value FROM provider_state WHERE session_id = ${sessionId}
				AND key = ${nativeThreadKey(instanceId)}) AS receipt,
			(SELECT MAX(sequence) FROM events WHERE session_id = ${sessionId}
				AND type = 'session.provider_changed'
				AND json_extract(data, '$.newProvider') = ${instanceId}
				AND json_extract(data, '$.oldProvider') <> ${instanceId}) AS switched,
			(SELECT MAX(sequence) FROM events WHERE session_id = ${sessionId}
				AND type = 'session.handoff_delivered'
				AND json_extract(data, '$.instanceId') = ${instanceId}) AS delivered,
			EXISTS (SELECT 1 FROM messages WHERE session_id = ${sessionId}) AS history`;
		if (!traits?.supportsNativeResume)
			// planSwitchHandoff (switch-handoff.ts) owes the same handoff at launch.
			return (
				moved ||
				(facts?.switched != null && (facts.delivered ?? 0) < facts.switched)
					? "handoff"
					: "current"
			) satisfies ResumePlan;
		const receipt =
			facts?.receipt == null
				? undefined
				: (JSON.parse(facts.receipt) as { deliveredThrough?: number });
		const through = receipt?.deliveredThrough;
		if (through === undefined)
			return (facts?.history ? "handoff" : "current") satisfies ResumePlan;
		if (moved) return "native" satisfies ResumePlan;
		// As prepare-turn: a rewind it never heard of invalidates the thread; a switch since its
		// receipt is caught up on top of a resume.
		const [since] = yield* sql<{ rewound: number; switched: number }>`SELECT
			EXISTS (SELECT 1 FROM events WHERE session_id = ${sessionId}
				AND type = 'session.rewind_committed' AND sequence > ${through}) AS rewound,
			EXISTS (SELECT 1 FROM events WHERE session_id = ${sessionId}
				AND type = 'session.provider_changed' AND sequence > ${through}
				AND json_extract(data, '$.oldProvider') <> json_extract(data, '$.newProvider')) AS switched`;
		return (
			since?.rewound ? "handoff" : since?.switched ? "catch_up" : "current"
		) satisfies ResumePlan;
	}).pipe(Effect.provideService(SqlClient.SqlClient, sql));

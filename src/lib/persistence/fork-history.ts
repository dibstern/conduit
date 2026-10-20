import { Data, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { EventStoreError } from "./effect/event-store-effect.js";
import { runTerminalStatus } from "./effect/projectors-effect.js";
import {
	decodeStoredEventRow,
	type StoredEventRow,
} from "./effect/stored-event-row.js";
import type { CanonicalEvent, StoredEvent } from "./events.js";

export class ForkRefusal extends Data.TaggedError("ForkRefusal")<{
	readonly reason:
		| "no_completed_turn"
		| "no_transcript"
		| "message_not_found"
		| "point_not_found";
	readonly messageId?: string;
}> {}

export interface ForkSource {
	readonly boundary: {
		readonly messageId: string;
		readonly createdAt: number;
		readonly sequence: number;
	};
	readonly historyMessageId?: string;
	readonly lastRewindCommitSequence: number;
	readonly instanceIds: ReadonlySet<string>;
	readonly retained: readonly {
		readonly id: string;
		readonly role: string;
		readonly created_at: number;
	}[];
	readonly copy: (
		newSessionId: string,
	) => Effect.Effect<
		CanonicalEvent[],
		EventStoreError | SqlError,
		SqlClient.SqlClient
	>;
}

const FORK_HISTORY_TYPES: ReadonlySet<StoredEvent["type"]> = new Set<
	CanonicalEvent["type"]
>([
	"run.requested",
	"run.started",
	"session.status",
	"message.created",
	"text.delta",
	"thinking.start",
	"thinking.delta",
	"thinking.end",
	"tool.started",
	"tool.running",
	"tool.completed",
	"file.attached",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"turn.model_resolved",
	// Projects to the compaction divider and the reduced context gauge.
	"session.compaction",
]);

const FORK_BOUNDARY_TYPES = [
	"session.created",
	"session.provider_changed",
	"session.status",
	"session.rewind_committed",
	"message.created",
	"message.removed",
	"turn.completed",
];

interface BoundaryRow {
	readonly sequence: number;
	readonly type: string;
	readonly message_id: string | null;
	readonly status: string | null;
	readonly provider: string | null;
	readonly old_provider: string | null;
	readonly new_provider: string | null;
	readonly stream_end: number;
}

const readBoundaryRows = Effect.fn("fork.readBoundaryRows")(function* (
	parentId: string,
) {
	const sql = yield* SqlClient.SqlClient;
	return yield* sql<BoundaryRow>`
		SELECT sequence, type,
			json_extract(data, '$.messageId') AS message_id,
			json_extract(data, '$.status') AS status,
			json_extract(data, '$.provider') AS provider,
			json_extract(data, '$.oldProvider') AS old_provider,
			json_extract(data, '$.newProvider') AS new_provider,
			(SELECT MAX(sequence) FROM events WHERE session_id = ${parentId}) AS stream_end
		FROM events INDEXED BY idx_events_session_type
		WHERE session_id = ${parentId} AND type IN ${sql.in(FORK_BOUNDARY_TYPES)}
		ORDER BY sequence`;
});

// OpenCode emits intermediate turn.completed events. Only status idle closes a
// whole turn; a prompt after that idle is already queued before busy arrives.
const midTurnForkBoundary = (rows: readonly BoundaryRow[]) =>
	Effect.gen(function* () {
		let busy = false;
		let idle = -1;
		for (const row of rows) {
			if (row.type !== "session.status") continue;
			busy = row.status !== "idle";
			if (!busy) idle = row.sequence;
		}
		if (
			!busy &&
			(idle < 0 ||
				!rows.some(
					(row) => row.type === "message.created" && row.sequence > idle,
				))
		)
			return undefined;
		const completed = rows.reduce<BoundaryRow | undefined>(
			(completed, row) =>
				row.type === "turn.completed" && row.sequence < idle ? row : completed,
			undefined,
		);
		if (!completed?.message_id)
			return yield* new ForkRefusal({ reason: "no_completed_turn" });
		return completed.message_id;
	});

/** OpenCode needs only the mid-turn decision; its native API owns the copy. */
export const readSideThreadForkBoundary = Effect.fn(
	"fork.readSideThreadForkBoundary",
)(function* (parentId: string) {
	return yield* midTurnForkBoundary(yield* readBoundaryRows(parentId));
});

/** Resolve a fork without reading message parts or decoding transcript content. */
export const readForkSource = Effect.fn("fork.readForkSource")(function* (
	parentId: string,
	at: { readonly messageId?: string; readonly sideThread: boolean },
) {
	const sql = yield* SqlClient.SqlClient;
	return yield* sql.withTransaction(
		Effect.gen(function* () {
			const rows = yield* readBoundaryRows(parentId);
			const messageId =
				at.messageId ??
				(at.sideThread ? yield* midTurnForkBoundary(rows) : undefined);
			const messages = yield* sql<{
				readonly id: string;
				readonly role: string;
				readonly created_at: number;
				readonly current_provider: string;
				readonly pending_rewind_message_id: string | null;
			}>`
		SELECT m.id, m.role, m.created_at,
			s.provider AS current_provider, s.pending_rewind_message_id
		FROM messages m JOIN sessions s ON s.id = m.session_id
		WHERE m.session_id = ${parentId}
			AND NOT EXISTS (
				SELECT 1 FROM sessions pending JOIN messages cut
					ON cut.id = pending.pending_rewind_message_id AND cut.session_id = pending.id
				WHERE pending.id = m.session_id
					AND (m.created_at > cut.created_at
						OR (m.created_at = cut.created_at AND m.id >= cut.id))
			)
		ORDER BY m.created_at ASC, m.id ASC`;
			const point =
				messageId === undefined
					? messages.at(-1)
					: messages.find((message) => message.id === messageId);
			if (!point)
				return yield* new ForkRefusal({
					reason:
						messageId === undefined ? "no_transcript" : "message_not_found",
					...(messageId !== undefined && { messageId }),
				});
			const removedMessageIds = new Set(
				rows.flatMap((row) =>
					row.type === "message.removed" && row.message_id !== null
						? [row.message_id]
						: [],
				),
			);
			const creation = rows.find(
				(row) => row.type === "message.created" && row.message_id === point.id,
			);
			if (
				!creation ||
				(messageId !== undefined && removedMessageIds.has(messageId))
			)
				return yield* new ForkRefusal({
					reason: "point_not_found",
					...(messageId !== undefined && { messageId }),
				});
			const lastRewindCommitSequence = rows.reduce(
				(sequence, row) =>
					row.type === "session.rewind_committed" ? row.sequence : sequence,
				0,
			);
			const historyMessageId =
				messageId ??
				(point.pending_rewind_message_id !== null ||
				lastRewindCommitSequence > 0
					? point.id
					: undefined);
			const instanceIds = new Set([point.current_provider]);
			for (const row of rows) {
				if (row.type === "session.created" && row.provider !== null)
					instanceIds.add(row.provider);
				if (row.type === "session.provider_changed") {
					if (row.old_provider !== null) instanceIds.add(row.old_provider);
					if (row.new_provider !== null) instanceIds.add(row.new_provider);
				}
			}
			const retained = messages.map(({ id, role, created_at }) => ({
				id,
				role,
				created_at,
			}));
			const retainedMessageIds = new Set(retained.map((message) => message.id));
			const streamEnd = rows[0]?.stream_end ?? 0;
			const source: ForkSource = {
				boundary: {
					messageId: point.id,
					createdAt: point.created_at,
					sequence: creation.sequence,
				},
				...(historyMessageId !== undefined && { historyMessageId }),
				lastRewindCommitSequence,
				instanceIds,
				retained,
				copy: (newSessionId) =>
					Effect.gen(function* () {
						if (
							historyMessageId !== undefined &&
							removedMessageIds.has(historyMessageId)
						)
							return [];
						// Cut at the LAST target event, but retain messages created before its
						// FIRST event. Adjacent turn events are determined from the full parent
						// stream: omitted parent events break the run; other sessions do not.
						const content = yield* sql<
							StoredEventRow & { readonly first_target_sequence: number | null }
						>`
				WITH target AS (
					SELECT MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence,
						MAX(json_extract(metadata, '$.runId')) AS run_id
					FROM events
					WHERE session_id = ${parentId} AND sequence <= ${streamEnd}
						AND ${historyMessageId ?? null} IS NOT NULL
						AND json_extract(data, '$.messageId') = ${historyMessageId ?? null}
				), cut AS (
					SELECT COALESCE((
						SELECT MIN(sequence) FROM events
						WHERE session_id = ${parentId} AND sequence <= ${streamEnd}
							AND sequence > (SELECT last_sequence FROM target)
							AND type NOT LIKE 'turn.%'
							AND NOT (type = 'session.status' AND json_extract(metadata, '$.runId') IS NOT NULL
								AND json_extract(metadata, '$.runId') = (SELECT run_id FROM target))
					), ${streamEnd + 1}) AS excluded_sequence
				)
				SELECT project_id, sequence, event_id, session_id, stream_version,
					type, data, metadata, provider, created_at,
					(SELECT first_sequence FROM target) AS first_target_sequence
				FROM events INDEXED BY idx_events_session_seq
				WHERE session_id = ${parentId} AND sequence <= ${streamEnd}
					AND sequence < (SELECT excluded_sequence FROM cut)
					AND type IN ${sql.in([...FORK_HISTORY_TYPES])}
				ORDER BY sequence`;
						const firstTargetSequence = content[0]?.first_target_sequence;
						const keptMessageIds =
							historyMessageId === undefined
								? undefined
								: new Set([historyMessageId]);
						if (
							keptMessageIds &&
							firstTargetSequence !== null &&
							firstTargetSequence !== undefined
						)
							for (const row of rows)
								if (
									row.type === "message.created" &&
									row.message_id !== null &&
									row.sequence < firstTargetSequence
								)
									keptMessageIds.add(row.message_id);
						const events = yield* Effect.forEach(content, (row) =>
							decodeStoredEventRow(
								row,
								(cause) =>
									new EventStoreError({
										operation: "decodeStoredEventRow",
										cause,
									}),
							),
						);
						return copyForkHistory(events, {
							newSessionId,
							removedMessageIds,
							retainedMessageIds,
							...(keptMessageIds !== undefined && { keptMessageIds }),
						});
					}),
			};
			return source;
		}),
	);
});

const messageIdOf = (event: StoredEvent) =>
	"messageId" in event.data && typeof event.data.messageId === "string"
		? event.data.messageId
		: undefined;

function copyForkHistory(
	parentEvents: readonly StoredEvent[],
	input: {
		readonly newSessionId: string;
		readonly retainedMessageIds: ReadonlySet<string>;
		readonly removedMessageIds: ReadonlySet<string>;
		readonly keptMessageIds?: ReadonlySet<string>;
	},
): CanonicalEvent[] {
	const suffix = `_${input.newSessionId}`;
	const rekey = (id: string) => `${id}${suffix}`;
	const events: CanonicalEvent[] = [];
	const retained = (messageId: string) =>
		!input.removedMessageIds.has(messageId) &&
		input.retainedMessageIds.has(messageId) &&
		(input.keptMessageIds?.has(messageId) ?? true);
	const runs = new Set(
		parentEvents.flatMap((event) =>
			event.type === "message.created" &&
			event.data.role === "user" &&
			retained(event.data.messageId) &&
			event.metadata.runId
				? [event.metadata.runId]
				: [],
		),
	);
	// A fork imports finished history, never the parent's native execution.
	const ended = new Set(
		parentEvents.flatMap((event) =>
			event.metadata.runId && runTerminalStatus(event, event.provider)
				? [event.metadata.runId]
				: [],
		),
	);
	for (const event of parentEvents)
		if (
			event.type === "run.started" &&
			runs.has(event.data.requestedRunId) &&
			event.metadata.runId &&
			ended.has(event.metadata.runId)
		) {
			runs.add(event.metadata.runId);
			ended.add(event.data.requestedRunId);
		}
	for (const runId of runs) if (!ended.has(runId)) runs.delete(runId);
	for (const event of parentEvents) {
		if (!FORK_HISTORY_TYPES.has(event.type)) continue;
		if (event.type === "run.requested" && !runs.has(event.data.runId)) continue;
		if (event.type === "run.started" && !runs.has(event.data.requestedRunId))
			continue;
		const retainedTerminal =
			event.metadata.runId &&
			runs.has(event.metadata.runId) &&
			runTerminalStatus(event, event.provider);
		if (event.type === "session.status" && !retainedTerminal) continue;
		const messageId = messageIdOf(event);
		if (messageId !== undefined && !retained(messageId) && !retainedTerminal)
			continue;
		const data: Record<string, unknown> = { ...event.data };
		delete data["providerStateUpdates"];
		delete data["providerSessionId"];
		for (const field of [
			"messageId",
			"parentID",
			"partId",
			"callId",
			"turnId",
			"inputId",
			"userMessageId",
			"runId",
			"requestedRunId",
		] as const) {
			if (typeof data[field] === "string") data[field] = rekey(data[field]);
		}
		if ("sessionId" in data) data["sessionId"] = input.newSessionId;
		// A streamed part arrives as thousands of fragments that project to their
		// concatenation; copying each one makes a long session slow to fork.
		const previous = events.at(-1);
		if (
			(event.type === "text.delta" || event.type === "thinking.delta") &&
			previous?.type === event.type &&
			previous.data.partId === data["partId"] &&
			previous.data.messageId === data["messageId"]
		) {
			events[events.length - 1] = {
				...previous,
				data: { ...previous.data, text: previous.data.text + event.data.text },
			};
			continue;
		}
		// Build a fresh envelope: StoredEvent sequence and streamVersion belong to
		// the parent stream and must be assigned by the event store on append.
		const { runId, schemaVersion, source } = event.metadata;
		events.push({
			eventId: rekey(event.eventId),
			sessionId: input.newSessionId,
			type: event.type,
			data,
			metadata: {
				inherited: true,
				...(schemaVersion !== undefined && { schemaVersion }),
				...(source !== undefined && { source }),
				...(runId && runs.has(runId) && { runId: rekey(runId) }),
			},
			provider: event.provider,
			createdAt: event.createdAt,
		} as CanonicalEvent);
	}
	// A heartbeat with no payload only says the tool is still running, which
	// any later event for that tool also says. Long tools emit thousands. Keyed
	// by message too: a part whose row is gone falls back to the event's message.
	const toolKey = (data: { messageId: string; partId: string }) =>
		`${data.messageId}\0${data.partId}`;
	const lastToolEvent = new Map<string, number>();
	events.forEach((event, index) => {
		if (event.type === "tool.running" || event.type === "tool.completed")
			lastToolEvent.set(toolKey(event.data), index);
	});
	return events.filter(
		(event, index) =>
			event.type !== "tool.running" ||
			lastToolEvent.get(toolKey(event.data)) === index ||
			Object.keys(event.data).some(
				(key) => key !== "messageId" && key !== "partId",
			),
	);
}

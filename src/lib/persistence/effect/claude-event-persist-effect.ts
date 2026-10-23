import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Context, Data, Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { AttachmentRef } from "../../contracts/attachment-ref.js";
import type { KnownProviderDriverKind } from "../../contracts/provider-instance.js";
import { sessionCreatedLineage } from "../../contracts/session-ref.js";
import {
	resolveServerSessionPick,
	sessionPickEvents,
	storedSessionPick,
} from "../../domain/relay/Services/session-pick.js";
import type { ClaudeSubagentTranscriptSnapshot } from "../../provider/claude/types.js";
import {
	isPickRejection,
	type PickRejection,
} from "../../provider/turn-settings.js";
import { isRecord } from "../../utils.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	EventId,
	type SessionHandoffDeliveredPayload,
	type StoredEvent,
} from "../events.js";
import { boundProjectMismatch } from "./bind-event-store-effect.js";
import {
	type CommitAndSignalProject,
	makeUnboundCommitAndSignal,
} from "./commit-and-signal.js";
import {
	EventStoreEffectTag,
	type UnboundEventStoreEffect,
	UnboundEventStoreEffectTag,
} from "./event-store-effect.js";
import { runTerminalStatus } from "./projectors-effect.js";
import { heldCatchUpKey } from "./provider-state-effect.js";
import { isSessionDeleted } from "./session-seeder-effect.js";

export class ClaudeEventPersistEffectError extends Data.TaggedError(
	"ClaudeEventPersistEffectError",
)<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

export class ClaudeSessionLifecycleError extends Data.TaggedError(
	"ClaudeSessionLifecycleError",
)<{
	readonly operation:
		| "persistEvent"
		| "persistEvents"
		| "persistUserMessage"
		| "ensureClaudeSubagentSession";
	readonly sessionId: string;
	readonly role: "existing-session" | "subagent-parent" | "subagent-child";
	readonly reason: "missing-session" | "conflicting-subagent-session";
}> {}

export type ClaudeEventPersistFailure =
	| ClaudeEventPersistEffectError
	| ClaudeSessionLifecycleError;

export interface ClaudeEventPersistEffect {
	readonly persistHandoffDelivered: (
		sessionId: string,
		handoff: SessionHandoffDeliveredPayload,
		commandId: string,
		projectId?: string,
		provider?: string,
	) => Effect.Effect<void, ClaudeEventPersistFailure>;

	readonly persistEvent: (
		event: CanonicalEvent,
		options?: { readonly publish?: boolean; readonly projectId?: string },
	) => Effect.Effect<void, ClaudeEventPersistFailure>;

	readonly persistEvents: (
		events: readonly CanonicalEvent[],
		options?: { readonly publish?: boolean; readonly projectId?: string },
	) => Effect.Effect<void, ClaudeEventPersistFailure>;

	readonly persistUserMessage: (
		sessionId: string,
		text: string,
		options?: {
			readonly projectId?: string;
			/** Reuse an owning write seam; this handle enforces its transaction. */
			readonly project?: CommitAndSignalProject;
			readonly publish?: boolean;
			readonly messageId?: string;
			/** The send that placed this message; an existing row for it wins. */
			readonly inputId?: string;
			/** The reservation this placement belongs to; this does not prove intake. */
			readonly runId?: string;
			readonly provider?: string;
			readonly images?: readonly AttachmentRef[];
			/** Place an unsent input and its owned failure in one transaction. */
			readonly failure?: {
				readonly message: string;
				readonly code?: string;
				readonly retryable?: boolean;
				readonly retryAt?: number | undefined;
			};
		},
	) => Effect.Effect<void, ClaudeEventPersistFailure>;

	readonly ensureClaudeSubagentSession: (input: {
		readonly projectId?: string;
		readonly provider?: KnownProviderDriverKind;
		readonly childSessionId: string;
		readonly parentSessionId: string;
		readonly providerSessionId: string;
		readonly title: string;
		readonly instanceId?: string;
		readonly modelId?: string;
	}) => Effect.Effect<void, ClaudeEventPersistFailure | PickRejection>;

	readonly readClaudeSubagentTranscript: (
		childSessionId: string,
	) => Effect.Effect<
		ClaudeSubagentTranscriptSnapshot,
		ClaudeEventPersistFailure
	>;
}

export class ClaudeEventPersistEffectTag extends Context.Service<
	ClaudeEventPersistEffectTag,
	ClaudeEventPersistEffect
>()("ClaudeEventPersistEffect") {}

export class UnboundClaudeEventPersistEffectTag extends Context.Service<
	UnboundClaudeEventPersistEffectTag,
	ClaudeEventPersistEffect
>()("UnboundClaudeEventPersistEffect") {}

/**
 * Terminal events that may act on an existing read-model session without a
 * durable lifecycle root. Keep this list narrow: content events must prove
 * canonical creation or an active provider binding before persistence.
 */
const LIFECYCLE_ROOT_OPTIONAL_EVENT_TYPES: ReadonlySet<CanonicalEvent["type"]> =
	new Set(["session.deleted"]);

function claudeSubagentSessionCreatedEventId(
	childSessionId: string,
	provider: string,
): EventId {
	return Schema.decodeSync(EventId)(
		`evt_${provider}_subagent_session_created_${childSessionId}`,
	);
}

/** Called inside the append transaction by both Claude persistence and runtime ingestion. */
const makeAppendEventsWithClaudeTurnCostsForStore = Effect.fn(function* (
	eventStore: UnboundEventStoreEffect,
) {
	const sql = yield* SqlClient.SqlClient;

	return (events: readonly CanonicalEvent[], projectId?: string) =>
		Effect.gen(function* () {
			if (
				!events.some(
					(event) =>
						(event.metadata.runId !== undefined &&
							runTerminalStatus(event, event.provider) !== undefined) ||
						event.metadata.rawSource === "claude.subagent.transcript" ||
						(event.provider === "claude" &&
							(event.type === "turn.completed" ||
								event.type === "message.completed") &&
							event.data.providerCostTotalUsd !== undefined),
				)
			)
				return yield* eventStore.appendBatch(events, projectId);

			// Acquire the writer before reading ownership, including when another
			// persistence connection can commit a terminal concurrently.
			yield* sql`UPDATE sessions SET project_id = project_id WHERE 0`;
			const stored: StoredEvent[] = [];
			const seenTranscriptIds = new Set<string>();
			for (let event of events) {
				if (
					event.metadata.runId !== undefined &&
					runTerminalStatus(event, event.provider) !== undefined
				) {
					const [run] = yield* sql<{ id: string; status: string }>`
						SELECT effective.id, effective.status FROM provider_runs reservation
						JOIN provider_runs effective ON effective.id = COALESCE(reservation.joined_into, reservation.id)
							AND effective.session_id = reservation.session_id
						WHERE reservation.id = ${event.metadata.runId} AND reservation.session_id = ${event.sessionId}`;
					// The existing failed-send guard uses the effective run's open
					// state. Extend it to provider terminals before they reach the log.
					// Read the log too: aliases do not terminalize their owner, and
					// earlier terminals in this batch have not projected yet.
					const previous = yield* sql<{
						type: string;
						provider: string;
						data: string;
					}>`
						SELECT type, provider, data FROM events WHERE session_id = ${event.sessionId}
							AND json_extract(metadata, '$.runId') IN (${event.metadata.runId}, ${run?.id ?? event.metadata.runId})
							AND type IN ('turn.error', 'turn.interrupted', 'turn.completed', 'session.status')`;
					const ended = previous
						.map((stored) =>
							runTerminalStatus(
								{
									type: stored.type,
									data: JSON.parse(stored.data),
								},
								stored.provider,
							),
						)
						.find((status) => status !== undefined);
					const closed = run && !["pending", "running"].includes(run.status);
					if (closed || ended) {
						// Late Claude results keep accounting after any terminal outcome.
						// The event log still owns the result if its run row is missing.
						if (
							event.provider === "claude" &&
							event.type === "turn.completed"
						) {
							const runId = run?.id ?? event.metadata.runId;
							if (
								(!event.data.messageId && !event.data.userMessageId) ||
								runId !== event.metadata.runId
							)
								continue;
							const messageId = event.data.messageId;
							const created = [...stored]
								.reverse()
								.find(
									(earlier) =>
										earlier.type === "message.created" &&
										earlier.sessionId === event.sessionId &&
										earlier.data.messageId === messageId &&
										earlier.data.role === "assistant" &&
										(earlier.metadata.runId === undefined ||
											earlier.metadata.runId === runId),
								);
							const parentId =
								created?.type === "message.created"
									? created.data.parentID
									: undefined;
							// A retry can reassign this prompt's projected run. Its original
							// run.started record still proves ownership of the late result.
							// SDK-local results name their prompt explicitly; messageId can
							// still name the preceding run's assistant answer.
							const [message] = yield* sql`SELECT turn.id FROM turns turn
							WHERE turn.session_id = ${event.sessionId} AND EXISTS (
								SELECT 1 FROM events started WHERE started.session_id = turn.session_id
									AND started.type = 'run.started' AND json_extract(started.metadata, '$.runId') = ${runId}
									AND (turn.id = COALESCE(json_extract(started.data, '$.userMessageId'), json_extract(started.data, '$.inputId'))
										OR EXISTS (SELECT 1 FROM messages prompt WHERE prompt.id = turn.user_message_id
											AND prompt.session_id = turn.session_id AND prompt.input_id = json_extract(started.data, '$.inputId'))))
								AND (${event.data.userMessageId ?? null} IS NOT NULL OR NOT EXISTS (
									SELECT 1 FROM events created WHERE created.session_id = turn.session_id
									AND created.type = 'message.created' AND json_extract(created.data, '$.messageId') = ${messageId}
									AND json_extract(created.data, '$.role') = 'assistant' AND json_extract(created.metadata, '$.runId') <> ${runId}))
								AND (turn.id = COALESCE(${event.data.userMessageId ?? null},
									(SELECT message.parent_id FROM messages message WHERE message.id = ${messageId}
										AND message.session_id = turn.session_id AND message.role = 'assistant'),
									${parentId ?? null}) OR (${event.data.userMessageId ?? null} IS NULL AND EXISTS (
									SELECT 1 FROM messages message WHERE message.turn_id = turn.id
										AND message.session_id = turn.session_id AND message.role = 'assistant'
										AND message.id = ${messageId})))`;
							if (!message) continue;
							const accounted = yield* sql<{
								event_id: string;
								data: string;
								created_at: number;
							}>`SELECT event_id, data, created_at FROM events
							WHERE session_id = ${event.sessionId} AND type IN ('turn.completed', 'message.completed')
								AND json_extract(metadata, '$.runId') = ${runId}
								AND json_extract(data, '$.messageId') = ${messageId}`;
							const completion = event.data;
							if (
								accounted.some((earlier) => {
									if (earlier.event_id === event.eventId) return true;
									if (earlier.created_at !== event.createdAt) return false;
									const data: unknown = JSON.parse(earlier.data);
									return (
										isRecord(data) &&
										isDeepStrictEqual(
											{
												...data,
												cost:
													completion.providerCostTotalUsd === undefined
														? data["cost"]
														: undefined,
											},
											{
												...completion,
												cost:
													completion.providerCostTotalUsd === undefined
														? completion.cost
														: undefined,
											},
										)
									);
								})
							)
								continue;
							event = { ...event, type: "message.completed" };
						} else continue;
					}
				}
				if (event.metadata.rawSource === "claude.subagent.transcript") {
					if (seenTranscriptIds.has(event.eventId)) continue;
					seenTranscriptIds.add(event.eventId);
					const [existing] =
						yield* sql`SELECT event_id FROM events WHERE event_id = ${event.eventId}`;
					if (existing) {
						// A message replacement can cascade-delete parts while their
						// events remain. Append the restoration after that replacement
						// so replay reproduces the live projection.
						let restore = false;
						if (event.type === "message.created") {
							const rows =
								yield* sql`SELECT id FROM messages WHERE id = ${event.data.messageId} AND session_id = ${event.sessionId}`;
							restore = rows.length === 0;
						} else if ("partId" in event.data) {
							const [part] = yield* sql<{
								text: string | null;
								status: string | null;
							}>`
								SELECT text, status FROM message_parts WHERE id = ${event.data.partId}`;
							restore =
								!part ||
								((event.type === "text.delta" ||
									event.type === "thinking.delta") &&
									!part.text &&
									event.data.text.length > 0) ||
								((event.type === "thinking.end" ||
									event.type === "tool.completed") &&
									part.status !== "completed" &&
									part.status !== "error");
						}
						if (restore) {
							const [latest] = yield* sql<{ sequence: number | null }>`
								SELECT MAX(sequence) AS sequence FROM events WHERE session_id = ${event.sessionId}`;
							const eventId = Schema.decodeSync(EventId)(
								`evt_${createHash("sha256")
									.update(
										JSON.stringify([event.eventId, latest?.sequence ?? 0]),
									)
									.digest("hex")
									.slice(0, 24)}`,
							);
							stored.push(
								...(yield* eventStore.appendBatch(
									[{ ...event, eventId }],
									projectId,
								)),
							);
						}
						continue;
					}
				}
				let normalized = event;
				if (
					event.provider === "claude" &&
					(event.type === "turn.completed" ||
						event.type === "message.completed") &&
					event.data.providerCostTotalUsd !== undefined
				) {
					const total = event.data.providerCostTotalUsd;
					const [previous] = yield* sql<{ total: number }>`
						SELECT json_extract(data, '$.providerCostTotalUsd') AS total
						FROM events
						WHERE session_id = ${event.sessionId} AND type IN ('turn.completed', 'message.completed')
							AND provider = 'claude'
							AND json_extract(data, '$.providerSessionId') = ${event.data.providerSessionId ?? null}
							AND json_extract(data, '$.providerCostTotalUsd') IS NOT NULL
						ORDER BY sequence DESC LIMIT 1`;
					const delta = total - (previous?.total ?? 0);
					if (delta < 0) {
						yield* Effect.logWarning(
							`Claude cost total went backwards: session=${event.sessionId} providerSessionId=${event.data.providerSessionId} previous=${previous?.total ?? 0} total=${total}`,
						);
					}
					normalized = {
						...event,
						data: { ...event.data, cost: Math.max(0, delta) },
					};
				}
				// Append before looking up the next total, including within one batch.
				stored.push(
					...(yield* eventStore.appendBatch([normalized], projectId)),
				);
			}
			return stored;
		});
});

const makeClaudeEventPersistForStore = Effect.fn(function* (
	eventStore: UnboundEventStoreEffect & { readonly projectId?: string },
) {
	const sql = yield* SqlClient.SqlClient;
	const requireUndeletedSession = (
		sessionId: string,
		operation: ClaudeSessionLifecycleError["operation"],
		role: ClaudeSessionLifecycleError["role"],
	) =>
		Effect.gen(function* () {
			if (
				yield* isSessionDeleted(sessionId).pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
				)
			)
				return yield* new ClaudeSessionLifecycleError({
					operation,
					sessionId,
					role,
					reason: "missing-session",
				});
		});
	const requireLiveCreationRefs = (
		event: CanonicalEvent,
		operation: "persistEvent" | "persistEvents",
	) =>
		Effect.gen(function* () {
			if (event.type !== "session.created") return;
			for (const id of [
				event.sessionId,
				event.data.sessionId,
				...sessionCreatedLineage(event.data),
			])
				yield* requireUndeletedSession(id, operation, "existing-session");
		});

	const seedClaudeSubagentSession = (input: {
		readonly projectId: string;
		readonly provider?: KnownProviderDriverKind;
		readonly childSessionId: string;
		readonly parentSessionId: string;
		readonly providerSessionId: string;
		readonly title: string;
		readonly instanceId?: string;
	}): Effect.Effect<void, SqlError> => {
		const now = Date.now();
		return sql`
			INSERT OR IGNORE INTO sessions
			(id, project_id, provider, provider_sid, title, status, parent_id, created_at, updated_at)
			VALUES (${input.childSessionId}, ${input.projectId}, ${input.instanceId ?? input.provider ?? "claude"}, ${input.providerSessionId}, ${input.title}, 'idle', ${input.parentSessionId}, ${now}, ${now})`.pipe(
			Effect.asVoid,
		);
	};

	const requireSession = (
		sessionId: string,
		operation: ClaudeSessionLifecycleError["operation"],
		role: ClaudeSessionLifecycleError["role"],
	): Effect.Effect<void, SqlError | ClaudeSessionLifecycleError> =>
		sql<{ readonly id: string }>`
			SELECT sessions.id
			FROM sessions
			WHERE sessions.id = ${sessionId}
				AND (
					EXISTS (
						SELECT 1
						FROM events
						WHERE events.session_id = sessions.id
							AND events.type = 'session.created'
					)
					OR EXISTS (
						SELECT 1
						FROM session_providers
						WHERE session_providers.session_id = sessions.id
							AND session_providers.status = 'active'
					)
				)
			LIMIT 1
		`.pipe(
			Effect.flatMap((rows) =>
				rows.length > 0
					? Effect.void
					: Effect.fail(
							new ClaudeSessionLifecycleError({
								operation,
								sessionId,
								role,
								reason: "missing-session",
							}),
						),
			),
		);

	const requireReadModelSession = (
		sessionId: string,
		operation: ClaudeSessionLifecycleError["operation"],
		role: ClaudeSessionLifecycleError["role"],
	): Effect.Effect<void, SqlError | ClaudeSessionLifecycleError> =>
		sql<{ readonly id: string }>`
			SELECT id FROM sessions WHERE id = ${sessionId} LIMIT 1
		`.pipe(
			Effect.flatMap((rows) =>
				rows.length > 0
					? Effect.void
					: Effect.fail(
							new ClaudeSessionLifecycleError({
								operation,
								sessionId,
								role,
								reason: "missing-session",
							}),
						),
			),
		);

	const commitAndSignal = yield* makeUnboundCommitAndSignal.pipe(
		Effect.provideService(UnboundEventStoreEffectTag, eventStore),
	);
	const appendEvents =
		yield* makeAppendEventsWithClaudeTurnCostsForStore(eventStore);

	const mapPersistError =
		(operation: string) =>
		(cause: unknown): ClaudeEventPersistFailure =>
			cause instanceof ClaudeEventPersistEffectError ||
			cause instanceof ClaudeSessionLifecycleError
				? cause
				: new ClaudeEventPersistEffectError({ operation, cause });

	const readClaudeSubagentTranscript: ClaudeEventPersistEffect["readClaudeSubagentTranscript"] =
		(childSessionId) =>
			sql
				.withTransaction(
					Effect.gen(function* () {
						const messages = yield* sql<
							ClaudeSubagentTranscriptSnapshot["messages"][number]
						>`
				SELECT id, role FROM messages
				WHERE session_id = ${childSessionId} AND role IN ('user', 'assistant')`;
						const parts = yield* sql<
							ClaudeSubagentTranscriptSnapshot["parts"][number]
						>`
				SELECT p.id, p.message_id AS messageId, p.type, p.text, p.status
				FROM message_parts p JOIN messages m ON m.id = p.message_id
				WHERE m.session_id = ${childSessionId}`;
						return { messages, parts };
					}),
				)
				.pipe(Effect.mapError(mapPersistError("readClaudeSubagentTranscript")));

	const persistEvent = (
		event: CanonicalEvent,
		options?: { readonly publish?: boolean; readonly projectId?: string },
	): Effect.Effect<void, ClaudeEventPersistFailure> =>
		commitAndSignal
			.write(
				(project) =>
					Effect.gen(function* () {
						yield* requireLiveCreationRefs(event, "persistEvent");
						yield* LIFECYCLE_ROOT_OPTIONAL_EVENT_TYPES.has(event.type)
							? requireReadModelSession(
									event.sessionId,
									"persistEvent",
									"existing-session",
								)
							: requireSession(
									event.sessionId,
									"persistEvent",
									"existing-session",
								);
						yield* project(yield* appendEvents([event], options?.projectId));
					}),
				options,
			)
			.pipe(Effect.mapError(mapPersistError("persistEvent")));

	const persistHandoffDelivered: ClaudeEventPersistEffect["persistHandoffDelivered"] =
		(sessionId, handoff, commandId, projectId, provider = "claude") =>
			Effect.gen(function* () {
				const mismatch = boundProjectMismatch(eventStore.projectId, projectId);
				if (mismatch) return yield* mismatch;
				yield* requireSession(sessionId, "persistEvent", "existing-session");
				const event = canonicalEvent(
					"session.handoff_delivered",
					sessionId,
					handoff,
					{
						provider,
						eventId: Schema.decodeSync(EventId)(
							`evt_${provider}_handoff_delivered_${commandId}`,
						),
					},
				);
				yield* commitAndSignal.write((project) =>
					Effect.gen(function* () {
						const completed =
							yield* sql`SELECT command_id FROM provider_command_outbox
							WHERE command_id = ${commandId} AND session_id = ${sessionId} AND status = 'completed'`;
						if (completed.length === 0) return;
						const existing = yield* sql<{ event_id: string }>`SELECT event_id
							FROM events WHERE event_id = ${event.eventId} LIMIT 1`;
						if (existing.length > 0) return;
						yield* project(yield* eventStore.appendBatch([event], projectId));
						if (handoff.instanceId)
							yield* sql`DELETE FROM provider_state WHERE session_id = ${sessionId}
							AND key = ${heldCatchUpKey(handoff.instanceId)}`;
					}),
				);
			}).pipe(Effect.mapError(mapPersistError("persistHandoffDelivered")));

	const persistEvents = (
		events: readonly CanonicalEvent[],
		options?: { readonly publish?: boolean; readonly projectId?: string },
	): Effect.Effect<void, ClaudeEventPersistFailure> =>
		Effect.gen(function* () {
			const mismatch = boundProjectMismatch(
				eventStore.projectId,
				options?.projectId,
			);
			if (mismatch) return yield* mismatch;
			if (events.length === 0) return;

			yield* commitAndSignal.write(
				(project) =>
					Effect.gen(function* () {
						for (const sessionId of new Set(
							events.map((event) => event.sessionId),
						))
							yield* requireSession(
								sessionId,
								"persistEvents",
								"existing-session",
							);
						if (events.some((event) => event.type === "session.created")) {
							// Project earlier deletions before checking a later creation,
							// including the descendant markers the cascade appends.
							for (const event of events) {
								yield* requireLiveCreationRefs(event, "persistEvents");
								yield* project(
									yield* appendEvents([event], options?.projectId),
								);
							}
						} else
							yield* project(yield* appendEvents(events, options?.projectId));
					}),
				options,
			);
		}).pipe(Effect.mapError(mapPersistError("persistEvents")));

	const persistUserMessage: ClaudeEventPersistEffect["persistUserMessage"] = (
		sessionId,
		text,
		options,
	) => {
		const persist = (project: CommitAndSignalProject) =>
			Effect.gen(function* () {
				const mismatch = boundProjectMismatch(
					eventStore.projectId,
					options?.projectId,
				);
				if (mismatch) return yield* mismatch;
				yield* requireSession(
					sessionId,
					"persistUserMessage",
					"existing-session",
				);
				// The check and append share the seam's transaction on redispatch.
				const messageId = options?.messageId;
				const inputId = options?.inputId;
				const [existing] =
					messageId || inputId
						? yield* sql<{
								readonly id: string;
								readonly run_id: string | null;
							}>`
					SELECT messages.id, turns.run_id FROM messages
					LEFT JOIN turns ON turns.session_id = messages.session_id AND turns.user_message_id = messages.id
					WHERE messages.session_id = ${sessionId}
						AND (messages.id = ${messageId ?? null} OR messages.input_id = ${inputId ?? null}) LIMIT 1`
						: [];
				const existingRunId =
					options?.runId ?? (options?.failure ? existing?.run_id : undefined);
				const runId =
					existingRunId ?? (options?.failure ? crypto.randomUUID() : undefined);
				let alreadyPlaced = false;
				if (existing) {
					if (!runId) return;
					const [run] = yield* sql<{
						id: string;
					}>`SELECT COALESCE(joined_into, id) AS id
					FROM provider_runs WHERE session_id = ${sessionId} AND id = ${runId}`;
					alreadyPlaced = existing.run_id === (run?.id ?? runId);
					if (alreadyPlaced && !options?.failure) return;
				}

				const now = Date.now();
				const userMsgId = existing?.id ?? messageId ?? crypto.randomUUID();
				const provider = options?.provider ?? "claude";
				const events: CanonicalEvent[] = alreadyPlaced
					? []
					: [
							canonicalEvent(
								"message.created",
								sessionId,
								{
									messageId: userMsgId,
									role: "user",
									sessionId,
									...(inputId ? { inputId } : {}),
								},
								{
									provider,
									createdAt: now,
									...(runId ? { metadata: { runId } } : {}),
								},
							),
						];
				if (!existing && text !== "") {
					events.push(
						canonicalEvent(
							"text.delta",
							sessionId,
							{
								messageId: userMsgId,
								partId: `${userMsgId}-0`,
								text,
							},
							{ provider, createdAt: now },
						),
					);
				}
				for (const [index, ref] of (alreadyPlaced
					? []
					: (options?.images ?? [])
				).entries()) {
					events.push(
						canonicalEvent(
							"file.attached",
							sessionId,
							{
								messageId: userMsgId,
								partId: `${userMsgId}-attachment-${index}`,
								mime: ref.mime,
								...(ref.name !== undefined ? { filename: ref.name } : {}),
								source: ref,
							},
							{ provider, createdAt: now },
						),
					);
				}
				if (options?.failure && runId) {
					const canFail =
						!existingRunId ||
						(yield* sql`
					SELECT 1 FROM provider_runs reservation JOIN provider_runs effective
						ON effective.id = COALESCE(reservation.joined_into, reservation.id)
						AND effective.session_id = reservation.session_id
					WHERE reservation.id = ${runId} AND reservation.session_id = ${sessionId}
						AND effective.status IN ('pending', 'running')`).length > 0;
					const meta = { provider, createdAt: now, metadata: { runId } };
					if (!existingRunId)
						events.unshift(
							canonicalEvent(
								"run.requested",
								sessionId,
								{ runId, inputId: inputId ?? userMsgId },
								meta,
							),
						);
					if (canFail)
						events.push(
							canonicalEvent(
								"turn.error",
								sessionId,
								{
									messageId: userMsgId,
									error: options.failure.message,
									...(options.failure.code
										? { code: options.failure.code }
										: {}),
									retryable: options.failure.retryable ?? false,
									...(options.failure.retryAt !== undefined
										? { retryAt: options.failure.retryAt }
										: {}),
								},
								meta,
							),
						);
				}
				const stored = yield* appendEvents(events, options?.projectId);
				yield* project(stored);
			});
		return (
			options?.project
				? persist(options.project)
				: commitAndSignal.write(persist, options)
		).pipe(Effect.mapError(mapPersistError("persistUserMessage")));
	};

	const ensureClaudeSubagentSession: ClaudeEventPersistEffect["ensureClaudeSubagentSession"] =
		(input) =>
			// Keep session seeding, append and projection in the seam's transaction.
			commitAndSignal
				.write(
					(project) =>
						Effect.gen(function* () {
							const provider = input.provider ?? "claude";
							const binding = input.instanceId ?? provider;
							yield* requireUndeletedSession(
								input.childSessionId,
								"ensureClaudeSubagentSession",
								"subagent-child",
							);
							yield* requireUndeletedSession(
								input.parentSessionId,
								"ensureClaudeSubagentSession",
								"subagent-parent",
							);
							yield* requireSession(
								input.parentSessionId,
								"ensureClaudeSubagentSession",
								"subagent-parent",
							);
							const [parentOwner] = yield* sql<{
								project_id: string | null;
							}>`SELECT project_id FROM sessions WHERE id = ${input.parentSessionId}`;
							if (!parentOwner?.project_id)
								return yield* new ClaudeEventPersistEffectError({
									operation: "ensureClaudeSubagentSession",
									cause: `Parent session ${input.parentSessionId} has no project`,
								});
							const projectId = parentOwner.project_id;
							const existingChildRows = yield* sql<{
								project_id: string | null;
								provider: string;
								parent_id: string | null;
								provider_sid: string | null;
								model_id: string | null;
							}>`
							SELECT project_id, provider, parent_id, provider_sid, model_id
							FROM sessions
							WHERE id = ${input.childSessionId}
							LIMIT 1`;
							const existingChild = existingChildRows[0];
							if (
								existingChild &&
								((existingChild.project_id &&
									existingChild.project_id !== projectId) ||
									existingChild.provider !== binding ||
									existingChild.parent_id !== input.parentSessionId ||
									existingChild.provider_sid !== input.providerSessionId)
							) {
								return yield* Effect.fail(
									new ClaudeSessionLifecycleError({
										operation: "ensureClaudeSubagentSession",
										sessionId: input.childSessionId,
										role: "subagent-child",
										reason: "conflicting-subagent-session",
									}),
								);
							}
							let pickEvents: CanonicalEvent[] = [];
							if (
								!existingChild?.model_id?.trim() ||
								(input.modelId !== undefined &&
									input.modelId !== existingChild.model_id)
							) {
								const [parent] = yield* sql<{
									model_id: string | null;
									model_provider: string | null;
									variant: string | null;
									context_window: string | null;
								}>`SELECT model_id, model_provider, variant, context_window
								FROM sessions WHERE id = ${input.parentSessionId}`;
								const pick = resolveServerSessionPick(
									provider,
									storedSessionPick(parent, provider),
								);
								if (Result.isFailure(pick)) return yield* pick.failure;
								pickEvents = sessionPickEvents(
									input.childSessionId,
									input.modelId
										? {
												...pick.success,
												model: {
													...pick.success.model,
													modelId: input.modelId,
												},
											}
										: pick.success,
								);
							}
							if (!existingChild)
								yield* seedClaudeSubagentSession({ ...input, projectId });

							const event = canonicalEvent(
								"session.created",
								input.childSessionId,
								{
									sessionId: input.childSessionId,
									title: input.title,
									provider: binding,
									parentId: input.parentSessionId,
									providerSessionId: input.providerSessionId,
								},
								{
									eventId: claudeSubagentSessionCreatedEventId(
										input.childSessionId,
										provider,
									),
									provider,
								},
							);
							const created = yield* sql<{ event_id: string }>`
							SELECT event_id FROM events WHERE event_id = ${event.eventId} LIMIT 1`;
							const stored = yield* eventStore.appendBatch(
								[...(created.length > 0 ? [] : [event]), ...pickEvents],
								projectId,
							);
							yield* project(stored);
						}),
					input.projectId === undefined ? {} : { projectId: input.projectId },
				)
				.pipe(
					Effect.mapError((cause) =>
						isPickRejection(cause)
							? cause
							: mapPersistError("ensureClaudeSubagentSession")(cause),
					),
				);

	return {
		persistHandoffDelivered,
		persistEvent,
		persistEvents,
		persistUserMessage,
		ensureClaudeSubagentSession,
		readClaudeSubagentTranscript,
	} satisfies ClaudeEventPersistEffect;
});

export const makeAppendEventsWithClaudeTurnCosts = Effect.flatMap(
	EventStoreEffectTag,
	makeAppendEventsWithClaudeTurnCostsForStore,
);

export const makeUnboundClaudeEventPersistEffect = Effect.flatMap(
	UnboundEventStoreEffectTag,
	makeClaudeEventPersistForStore,
);

export const makeClaudeEventPersistEffect = Effect.flatMap(
	EventStoreEffectTag,
	makeClaudeEventPersistForStore,
);

import { createHash } from "node:crypto";
import { Context, Data, Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { KnownProviderDriverKind } from "../../contracts/provider-instance.js";
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
import {
	type CanonicalEvent,
	canonicalEvent,
	EventId,
	type SessionHandoffDeliveredPayload,
	type StoredEvent,
} from "../events.js";
import { makeCommitAndSignal } from "./commit-and-signal.js";
import { EventStoreEffectTag } from "./event-store-effect.js";

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
	) => Effect.Effect<void, ClaudeEventPersistFailure>;

	readonly persistEvent: (
		event: CanonicalEvent,
		options?: { readonly publish?: boolean },
	) => Effect.Effect<void, ClaudeEventPersistFailure>;

	readonly persistEvents: (
		events: readonly CanonicalEvent[],
		options?: { readonly publish?: boolean },
	) => Effect.Effect<void, ClaudeEventPersistFailure>;

	readonly persistUserMessage: (
		sessionId: string,
		text: string,
		options?: {
			readonly publish?: boolean;
			readonly messageId?: string;
			/** The send that placed this message; an existing row for it wins. */
			readonly inputId?: string;
			readonly provider?: string;
		},
	) => Effect.Effect<void, ClaudeEventPersistFailure>;

	readonly ensureClaudeSubagentSession: (input: {
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
export const makeAppendEventsWithClaudeTurnCosts = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const eventStore = yield* EventStoreEffectTag;

	return (events: readonly CanonicalEvent[]) =>
		Effect.gen(function* () {
			if (
				!events.some(
					(event) =>
						event.metadata.rawSource === "claude.subagent.transcript" ||
						(event.provider === "claude" &&
							event.type === "turn.completed" &&
							event.data.providerCostTotalUsd !== undefined),
				)
			)
				return yield* eventStore.appendBatch(events);

			const stored: StoredEvent[] = [];
			const seenTranscriptIds = new Set<string>();
			for (const event of events) {
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
								...(yield* eventStore.appendBatch([{ ...event, eventId }])),
							);
						}
						continue;
					}
				}
				let normalized = event;
				if (
					event.provider === "claude" &&
					event.type === "turn.completed" &&
					event.data.providerCostTotalUsd !== undefined
				) {
					const total = event.data.providerCostTotalUsd;
					const [previous] = yield* sql<{ total: number }>`
						SELECT json_extract(data, '$.providerCostTotalUsd') AS total
						FROM events
						WHERE session_id = ${event.sessionId} AND type = 'turn.completed'
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
				stored.push(...(yield* eventStore.appendBatch([normalized])));
			}
			return stored;
		});
});

export const makeClaudeEventPersistEffect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	const seedClaudeSubagentSession = (input: {
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
			VALUES (${input.childSessionId}, ${eventStore.projectId}, ${input.instanceId ?? input.provider ?? "claude"}, ${input.providerSessionId}, ${input.title}, 'idle', ${input.parentSessionId}, ${now}, ${now})`.pipe(
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

	const commitAndSignal = yield* makeCommitAndSignal;
	const eventStore = yield* EventStoreEffectTag;
	const appendEvents = yield* makeAppendEventsWithClaudeTurnCosts;

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
		options?: { readonly publish?: boolean },
	): Effect.Effect<void, ClaudeEventPersistFailure> =>
		Effect.gen(function* () {
			yield* LIFECYCLE_ROOT_OPTIONAL_EVENT_TYPES.has(event.type)
				? requireReadModelSession(
						event.sessionId,
						"persistEvent",
						"existing-session",
					)
				: requireSession(event.sessionId, "persistEvent", "existing-session");
			yield* commitAndSignal.write(
				(project) => Effect.flatMap(appendEvents([event]), project),
				options,
			);
		}).pipe(Effect.mapError(mapPersistError("persistEvent")));

	const persistHandoffDelivered: ClaudeEventPersistEffect["persistHandoffDelivered"] =
		(sessionId, handoff, commandId) =>
			Effect.gen(function* () {
				yield* requireSession(sessionId, "persistEvent", "existing-session");
				const event = canonicalEvent(
					"session.handoff_delivered",
					sessionId,
					handoff,
					{
						provider: "claude",
						eventId: Schema.decodeSync(EventId)(
							`evt_claude_handoff_delivered_${commandId}`,
						),
					},
				);
				// Recovery can observe a completed SDK command after its delivery
				// event committed but before the outbox completion did.
				yield* commitAndSignal.write((project) =>
					Effect.gen(function* () {
						const existing = yield* sql<{ event_id: string }>`SELECT event_id
							FROM events WHERE event_id = ${event.eventId} LIMIT 1`;
						if (existing.length > 0) return;
						yield* project(yield* eventStore.appendBatch([event]));
					}),
				);
			}).pipe(Effect.mapError(mapPersistError("persistHandoffDelivered")));

	const persistEvents = (
		events: readonly CanonicalEvent[],
		options?: { readonly publish?: boolean },
	): Effect.Effect<void, ClaudeEventPersistFailure> =>
		Effect.gen(function* () {
			if (events.length === 0) return;

			for (const sessionId of new Set(events.map((event) => event.sessionId))) {
				yield* requireSession(sessionId, "persistEvents", "existing-session");
			}
			yield* commitAndSignal.write(
				(project) => Effect.flatMap(appendEvents(events), project),
				options,
			);
		}).pipe(Effect.mapError(mapPersistError("persistEvents")));

	const persistUserMessage = (
		sessionId: string,
		text: string,
		options?: {
			readonly publish?: boolean;
			readonly messageId?: string;
			readonly inputId?: string;
			readonly provider?: string;
		},
	): Effect.Effect<void, ClaudeEventPersistFailure> =>
		commitAndSignal
			.write(
				(project) =>
					Effect.gen(function* () {
						yield* requireSession(
							sessionId,
							"persistUserMessage",
							"existing-session",
						);
						// The check and append share the seam's transaction on redispatch.
						const messageId = options?.messageId;
						const inputId = options?.inputId;
						if (messageId || inputId) {
							const existing = yield* sql<{ readonly id: string }>`
								SELECT id FROM messages
								WHERE id = ${messageId ?? null} OR input_id = ${inputId ?? null}
								LIMIT 1`;
							if (existing.length > 0) return;
						}

						const now = Date.now();
						const userMsgId = messageId ?? crypto.randomUUID();
						const provider = options?.provider ?? "claude";
						const events: CanonicalEvent[] = [
							canonicalEvent(
								"message.created",
								sessionId,
								{
									messageId: userMsgId,
									role: "user",
									sessionId,
									...(inputId ? { inputId } : {}),
								},
								{ provider, createdAt: now },
							),
						];
						if (text !== "") {
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
						const stored = yield* eventStore.appendBatch(events);
						yield* project(stored);
					}),
				options,
			)
			.pipe(Effect.mapError(mapPersistError("persistUserMessage")));

	const ensureClaudeSubagentSession: ClaudeEventPersistEffect["ensureClaudeSubagentSession"] =
		(input) =>
			// Keep session seeding, append and projection in the seam's transaction.
			commitAndSignal
				.write((project) =>
					Effect.gen(function* () {
						const provider = input.provider ?? "claude";
						const binding = input.instanceId ?? provider;
						yield* requireSession(
							input.parentSessionId,
							"ensureClaudeSubagentSession",
							"subagent-parent",
						);
						const existingChildRows = yield* sql<{
							provider: string;
							parent_id: string | null;
							provider_sid: string | null;
							model_id: string | null;
						}>`
							SELECT provider, parent_id, provider_sid, model_id
							FROM sessions
							WHERE id = ${input.childSessionId}
							LIMIT 1`;
						const existingChild = existingChildRows[0];
						if (
							existingChild &&
							(existingChild.provider !== binding ||
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
											model: { ...pick.success.model, modelId: input.modelId },
										}
									: pick.success,
							);
						}
						if (!existingChild) yield* seedClaudeSubagentSession(input);

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
						const stored = yield* eventStore.appendBatch([
							...(created.length > 0 ? [] : [event]),
							...pickEvents,
						]);
						yield* project(stored);
					}),
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

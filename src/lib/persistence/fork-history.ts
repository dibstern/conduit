import type { CanonicalEvent, StoredEvent } from "./events.js";

const FORK_HISTORY_TYPES = new Set<CanonicalEvent["type"]>([
	"message.created",
	"text.delta",
	"thinking.start",
	"thinking.delta",
	"thinking.end",
	"tool.started",
	"tool.running",
	"tool.completed",
	"tool.input_updated",
	"file.attached",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"turn.model_resolved",
	// Projects to the compaction divider and the reduced context gauge.
	"session.compaction",
]);

const messageIdOf = (event: StoredEvent | CanonicalEvent) =>
	"messageId" in event.data && typeof event.data.messageId === "string"
		? event.data.messageId
		: undefined;

export function copyForkHistory(
	parentEvents: readonly (StoredEvent | CanonicalEvent)[],
	input: { readonly newSessionId: string; readonly upToMessageId?: string },
): { events: CanonicalEvent[]; forkMessageId?: string } | undefined {
	let end = parentEvents.length - 1;
	// A prompt queued mid-turn is created before the target turn ends, so the
	// cut is by message, not only by position: keep messages created no later
	// than the target.
	let keptMessageIds: Set<string> | undefined;
	if (input.upToMessageId !== undefined) {
		keptMessageIds = new Set([input.upToMessageId]);
		end = -1;
		for (let index = 0; index < parentEvents.length; index++) {
			const event = parentEvents[index];
			if (!event) continue;
			const messageId = messageIdOf(event);
			if (messageId === input.upToMessageId) end = index;
			else if (
				end < 0 &&
				messageId !== undefined &&
				event.type === "message.created"
			)
				keptMessageIds.add(messageId);
		}
		if (end < 0) return undefined;
		while (
			end + 1 < parentEvents.length &&
			parentEvents[end + 1]?.type.startsWith("turn.")
		) {
			end++;
		}
	}

	const suffix = `_${input.newSessionId}`;
	const rekey = (id: string) => `${id}${suffix}`;
	const events: CanonicalEvent[] = [];
	let lastMessageId: string | undefined;
	for (const event of parentEvents.slice(0, end + 1)) {
		if (!FORK_HISTORY_TYPES.has(event.type)) continue;
		const messageId = messageIdOf(event);
		if (messageId !== undefined && keptMessageIds?.has(messageId) === false)
			continue;
		const data: Record<string, unknown> = { ...event.data };
		for (const field of ["messageId", "partId", "callId", "turnId"] as const) {
			if (typeof data[field] === "string") data[field] = rekey(data[field]);
		}
		if ("sessionId" in data) data["sessionId"] = input.newSessionId;
		if (event.type === "message.created") {
			lastMessageId = rekey(event.data.messageId);
		}
		// Build a fresh envelope: StoredEvent sequence and streamVersion belong to
		// the parent stream and must be assigned by the event store on append.
		events.push({
			eventId: rekey(event.eventId),
			sessionId: input.newSessionId,
			type: event.type,
			data,
			metadata: event.metadata,
			provider: event.provider,
			createdAt: event.createdAt,
		} as CanonicalEvent);
	}
	const forkMessageId =
		input.upToMessageId !== undefined
			? rekey(input.upToMessageId)
			: lastMessageId;
	return { events, ...(forkMessageId !== undefined && { forkMessageId }) };
}

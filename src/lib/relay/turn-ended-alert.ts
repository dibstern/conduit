import type { CanonicalEvent } from "../persistence/events.js";
import type { RelayMessage } from "../shared-types.js";

export function turnEndedAlert(
	event: CanonicalEvent,
): Extract<RelayMessage, { type: "done" }> | undefined {
	if (
		event.type !== "turn.completed" &&
		event.type !== "turn.error" &&
		event.type !== "turn.interrupted"
	)
		return undefined;

	const originId = event.data.messageId || event.eventId;
	return {
		type: "done",
		sessionId: event.sessionId,
		code: event.type === "turn.completed" ? 0 : 1,
		alertId: JSON.stringify(
			event.type === "turn.error"
				? [event.sessionId, originId, "error", event.data.error]
				: [event.sessionId, originId, "done"],
		),
		...(event.type === "turn.error" ? { error: event.data.error } : {}),
	};
}

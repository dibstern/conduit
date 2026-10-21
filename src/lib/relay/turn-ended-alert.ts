import { runTerminalStatus } from "../persistence/effect/projectors-effect.js";
import type { CanonicalEvent } from "../persistence/events.js";
import type { RelayMessage } from "../shared-types.js";
import { isRecord } from "../utils.js";

export function turnEndedAlert(
	event: Pick<CanonicalEvent, "eventId" | "sessionId" | "provider"> & {
		readonly type: string;
		readonly data: unknown;
	},
): Extract<RelayMessage, { type: "done" }> | undefined {
	const status = runTerminalStatus(event, event.provider);
	if (!status) return undefined;
	const data: Record<string, unknown> = isRecord(event.data) ? event.data : {};
	const error =
		status === "error" ? String(data["error"] ?? "Provider error") : undefined;
	const originId = data["messageId"] || event.eventId;
	return {
		type: "done",
		sessionId: event.sessionId,
		code: status === "completed" ? 0 : 1,
		alertId: JSON.stringify(
			status === "error"
				? [event.sessionId, originId, "error", error]
				: [event.sessionId, originId, "done"],
		),
		...(error !== undefined ? { error } : {}),
	};
}

import { Effect } from "effect";
import type { SessionStatus } from "../instance/sdk-types.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";

export const readSessionStatusesFromEffect = Effect.gen(function* () {
	const readQuery = yield* ReadQueryEffectTag;
	const raw = yield* readQuery.getAllSessionStatuses();
	const result: Record<string, SessionStatus> = {};

	for (const [id, status] of Object.entries(raw)) {
		result[id] = { type: status } as SessionStatus;
	}

	return result;
});

export const isSessionProcessingFromEffect = (sessionId: string) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const status = yield* readQuery.getSessionStatus(sessionId);
		return status === "busy" || status === "retry";
	});

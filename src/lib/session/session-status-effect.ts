import { Effect } from "effect";
import type { SessionStatus } from "../instance/sdk-types.js";
import { EventStoreEffectTag } from "../persistence/effect/event-store-effect.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";

export const readSessionStatusesFromEffect = Effect.gen(function* () {
	const readQuery = yield* ReadQueryEffectTag;
	const eventStore = yield* EventStoreEffectTag;
	const raw = yield* readQuery.getAllSessionStatuses({
		projectIds: [eventStore.projectId],
	});
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

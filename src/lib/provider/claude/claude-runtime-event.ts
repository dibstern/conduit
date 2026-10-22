import type {
	ProviderRuntimeEventPayloadMap,
	ProviderRuntimeEventType,
} from "../../contracts/providers/provider-runtime-event.js";
import { createEventId } from "../../persistence/events.js";
import { providerRefsFromRuntimeData } from "../provider-runtime-refs.js";

export function claudeRuntimeEvent<K extends ProviderRuntimeEventType>(
	type: K,
	sessionId: string,
	data: ProviderRuntimeEventPayloadMap[K],
	runId?: string,
) {
	return {
		eventId: createEventId(),
		type,
		providerId: "claude",
		sessionId,
		providerRefs: providerRefsFromRuntimeData(type, data),
		rawSource: { kind: "claude.provider-runtime" },
		createdAt: Date.now(),
		data,
		...(runId ? { runId } : {}),
	};
}

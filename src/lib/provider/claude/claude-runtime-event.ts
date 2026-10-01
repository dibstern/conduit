import type {
	ProviderRuntimeEvent,
	ProviderRuntimeEventType,
} from "../../contracts/providers/provider-runtime-event.js";
import {
	createEventId,
	type EventPayloadMap,
} from "../../persistence/events.js";
import { providerRefsFromRuntimeData } from "../provider-runtime-refs.js";

export function claudeRuntimeEvent<K extends ProviderRuntimeEventType>(
	type: K,
	sessionId: string,
	data: EventPayloadMap[K],
): ProviderRuntimeEvent {
	return {
		eventId: createEventId(),
		type,
		providerId: "claude",
		sessionId,
		providerRefs: providerRefsFromRuntimeData(type, data),
		rawSource: { kind: "claude.provider-runtime" },
		createdAt: Date.now(),
		data,
	};
}

import type { ProviderRuntimeEvent } from "../../src/lib/contracts/providers/provider-runtime-event.js";
import type {
	CanonicalEvent,
	CanonicalEventType,
	EventPayloadMap,
} from "../../src/lib/persistence/events.js";

export function providerRuntimeEvent<K extends CanonicalEventType>(
	type: K,
	sessionId: string,
	data: EventPayloadMap[K],
	options: {
		readonly eventId?: string;
		readonly providerId?: string;
		readonly createdAt?: number | string;
		readonly metadata?: Record<string, unknown>;
		readonly rawSourceKind?: string;
	} = {},
): ProviderRuntimeEvent {
	return {
		eventId: options.eventId ?? `evt_${type}`,
		type,
		providerId: options.providerId ?? "claude",
		sessionId,
		providerRefs: {},
		rawSource: { kind: options.rawSourceKind ?? "test.provider-runtime" },
		createdAt: options.createdAt ?? Date.now(),
		data,
		...(options.metadata ? { metadata: options.metadata } : {}),
	};
}

export function providerRuntimeEventFromCanonical(
	event: CanonicalEvent,
	options: {
		readonly rawSourceKind?: string;
	} = {},
): ProviderRuntimeEvent {
	const metadata = metadataRecord(event.metadata);
	return {
		eventId: event.eventId,
		type: event.type,
		providerId: event.provider,
		sessionId: event.sessionId,
		providerRefs: {},
		rawSource: { kind: options.rawSourceKind ?? "test.canonical-fixture" },
		createdAt: event.createdAt,
		data: event.data,
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	};
}

function metadataRecord(metadata: CanonicalEvent["metadata"]) {
	const record: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (value !== undefined) record[key] = value;
	}
	return record;
}

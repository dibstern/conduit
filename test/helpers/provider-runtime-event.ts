import type { ProviderRuntimeEvent } from "../../src/lib/contracts/providers/provider-runtime-event.js";
import type {
	CanonicalEvent,
	EventPayloadMap,
} from "../../src/lib/persistence/events.js";

export function providerRuntimeEvent<K extends ProviderRuntimeEvent["type"]>(
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
	if (
		event.type === "session.deleted" ||
		event.type === "session.forked" ||
		event.type === "session.permission_mode_changed" ||
		event.type === "session.read" ||
		event.type === "session.unread" ||
		event.type === "session.settled" ||
		event.type === "session.unsettled" ||
		event.type === "session.pinned" ||
		event.type === "session.unpinned" ||
		event.type === "session.snoozed" ||
		event.type === "session.auto_settle_set" ||
		event.type === "session.unsnoozed"
	) {
		throw new Error(`${event.type} is not a provider runtime event`);
	}
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

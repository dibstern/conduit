// src/lib/persistence/events.ts
import { randomUUID } from "node:crypto";
import { Schema } from "effect";

import {
	type CanonicalEvent,
	type CanonicalEventType,
	CommandId,
	EventId,
	type EventMetadata,
	type EventPayloadMap,
	type LiveEventType,
} from "../contracts/stored-event.js";

export * from "../contracts/stored-event.js";

export function createEventId(): EventId {
	return Schema.decodeSync(EventId)(`evt_${randomUUID()}`);
}

export function createCommandId(): CommandId {
	return Schema.decodeSync(CommandId)(`cmd_${randomUUID()}`);
}

export function canonicalEvent<K extends LiveEventType>(
	type: K,
	sessionId: string,
	data: EventPayloadMap[K],
	opts?: {
		eventId?: EventId;
		metadata?: EventMetadata;
		provider?: string;
		createdAt?: number;
	},
): CanonicalEvent & { readonly type: K; readonly data: EventPayloadMap[K] } {
	return {
		eventId: opts?.eventId ?? createEventId(),
		sessionId,
		type,
		data,
		metadata: opts?.metadata ?? {},
		provider: opts?.provider ?? "opencode",
		createdAt: opts?.createdAt ?? Date.now(),
	} as CanonicalEvent & { readonly type: K; readonly data: EventPayloadMap[K] };
}

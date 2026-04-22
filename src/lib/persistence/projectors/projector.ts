// src/lib/persistence/projectors/projector.ts

import { PersistenceError } from "../errors.js";
import type {
	CanonicalEventType,
	EventPayloadMap,
	StoredEvent,
} from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";

export interface ProjectionContext {
	readonly replaying?: boolean;
}

export interface Projector {
	readonly name: string;
	readonly handles: readonly CanonicalEventType[];
	project(event: StoredEvent, db: SqliteClient, ctx?: ProjectionContext): void;
}

export function assertHandledOrIgnored(
	projector: Projector,
	event: StoredEvent,
): void {
	if ((projector.handles as readonly string[]).includes(event.type)) {
		throw new PersistenceError(
			"PROJECTION_FAILED",
			`Projector "${projector.name}" declares it handles "${event.type}" but has no implementation`,
			{
				projectorName: projector.name,
				eventType: event.type,
				sequence: event.sequence,
				sessionId: event.sessionId,
			},
		);
	}
}

export function isEventType<K extends CanonicalEventType>(
	event: StoredEvent,
	type: K,
): event is StoredEvent & { type: K; data: EventPayloadMap[K] } {
	return event.type === type;
}

export function encodeJson(value: unknown): string {
	if (value === undefined) return "null";
	return JSON.stringify(value);
}

export function decodeJson<T = unknown>(raw: string | null): T | undefined {
	if (raw == null || raw === "") return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

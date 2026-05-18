import { Schema } from "effect";
import type { ProviderRuntimeEvent } from "../contracts/providers/provider-runtime-event.js";
import {
	type CanonicalEvent,
	CanonicalEventSchema,
	type EventMetadata,
} from "../persistence/events.js";

export class ProviderRuntimeEventTranslationError extends Error {
	readonly _tag = "ProviderRuntimeEventTranslationError";

	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "ProviderRuntimeEventTranslationError";
	}
}

function createdAtToNumber(
	createdAt: ProviderRuntimeEvent["createdAt"],
): number {
	if (typeof createdAt === "number") return createdAt;
	const parsed = Date.parse(createdAt);
	if (Number.isNaN(parsed)) {
		throw new ProviderRuntimeEventTranslationError(
			`Invalid ProviderRuntimeEvent.createdAt: ${createdAt}`,
		);
	}
	return parsed;
}

function metadataForProviderRuntimeEvent(
	event: ProviderRuntimeEvent,
): EventMetadata {
	return {
		...(event.metadata ?? {}),
		providerRuntimeSource: "provider-runtime",
		providerRefs: event.providerRefs,
		rawSource: event.rawSource,
		...(event.turnId != null ? { providerTurnId: event.turnId } : {}),
		...(event.metadata != null
			? { providerRuntimeMetadata: event.metadata }
			: {}),
	};
}

export function providerRuntimeEventToCanonicalEvent(
	event: ProviderRuntimeEvent,
): CanonicalEvent {
	const candidate = {
		eventId: event.eventId,
		sessionId: event.sessionId,
		type: event.type,
		data: event.data,
		metadata: metadataForProviderRuntimeEvent(event),
		provider: event.providerId,
		createdAt: createdAtToNumber(event.createdAt),
	};

	try {
		return Schema.decodeUnknownSync(CanonicalEventSchema)(candidate);
	} catch (cause) {
		throw new ProviderRuntimeEventTranslationError(
			`ProviderRuntimeEvent ${event.type} cannot be translated to canonical event`,
			cause,
		);
	}
}

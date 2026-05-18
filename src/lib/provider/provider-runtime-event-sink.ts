import { randomUUID } from "node:crypto";
import type {
	ProviderRuntimeEvent,
	ProviderRuntimeEventType,
	ProviderRuntimeProviderRefs,
	ProviderRuntimeRawSource,
} from "../contracts/providers/provider-runtime-event.js";
import type { EventMetadata, EventPayloadMap } from "../persistence/events.js";

type RuntimeEventType = keyof EventPayloadMap & ProviderRuntimeEventType;
type RuntimeEventEnvelope<K extends RuntimeEventType> = Omit<
	ProviderRuntimeEvent,
	"type" | "data" | "metadata"
> & {
	readonly type: K;
	readonly data: EventPayloadMap[K];
	readonly metadata?: Record<string, unknown>;
};

export type ProviderRuntimeKnownEvent = {
	[K in RuntimeEventType]: RuntimeEventEnvelope<K>;
}[RuntimeEventType];

export interface MakeProviderRuntimeEventOptions {
	readonly eventId?: string;
	readonly providerId: string;
	readonly turnId?: string;
	readonly providerRefs?: ProviderRuntimeProviderRefs;
	readonly rawSource?: ProviderRuntimeRawSource;
	readonly createdAt?: number | string;
	readonly metadata?: EventMetadata | Record<string, unknown>;
}

export function makeProviderRuntimeEvent<K extends RuntimeEventType>(
	type: K,
	sessionId: string,
	data: EventPayloadMap[K],
	opts: MakeProviderRuntimeEventOptions,
): RuntimeEventEnvelope<K> {
	const metadata =
		opts.metadata == null
			? undefined
			: Object.fromEntries(Object.entries(opts.metadata));
	return {
		eventId: opts.eventId ?? `evt_${randomUUID()}`,
		type,
		providerId: opts.providerId,
		sessionId,
		...(opts.turnId != null ? { turnId: opts.turnId } : {}),
		providerRefs: opts.providerRefs ?? {},
		rawSource: opts.rawSource ?? { kind: opts.providerId },
		createdAt: opts.createdAt ?? Date.now(),
		data,
		...(metadata != null ? { metadata } : {}),
	};
}

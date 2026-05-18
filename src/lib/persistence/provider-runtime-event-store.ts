import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../contracts/providers/provider-runtime-event.js";
import { providerRuntimeEventToCanonicalEvent } from "../provider/provider-runtime-event-to-canonical.js";
import type { EventStore } from "./event-store.js";
import type { StoredEvent } from "./events.js";

const RAW_PROVIDER_PAYLOAD_KEYS = new Set([
	"raw",
	"payload",
	"rawPayload",
	"sdkPayload",
	"providerPayload",
]);
const MAX_RUNTIME_METADATA_BYTES = 8 * 1024;

export class ProviderRuntimeEventStoreError extends Error {
	readonly _tag = "ProviderRuntimeEventStoreError";

	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "ProviderRuntimeEventStoreError";
	}
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function rejectRawProviderPayloadKeys(value: unknown, path: string): void {
	if (value == null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		value.forEach((entry, index) => {
			rejectRawProviderPayloadKeys(entry, `${path}[${index}]`);
		});
		return;
	}

	for (const [key, entry] of Object.entries(value)) {
		if (RAW_PROVIDER_PAYLOAD_KEYS.has(key)) {
			throw new ProviderRuntimeEventStoreError(
				`Raw provider payload metadata is not stored in SQLite (${path}.${key})`,
			);
		}
		rejectRawProviderPayloadKeys(entry, `${path}.${key}`);
	}
}

function assertRawMetadataPolicy(event: ProviderRuntimeEvent): void {
	rejectRawProviderPayloadKeys(event.metadata, "metadata");
	const metadataBytes = byteLength({
		providerRefs: event.providerRefs,
		rawSource: event.rawSource,
		metadata: event.metadata ?? {},
	});
	if (metadataBytes > MAX_RUNTIME_METADATA_BYTES) {
		throw new ProviderRuntimeEventStoreError(
			`Provider runtime metadata exceeds ${MAX_RUNTIME_METADATA_BYTES} bytes`,
		);
	}
}

function decodeRuntimeEvent(raw: unknown): ProviderRuntimeEvent {
	try {
		return decodeProviderRuntimeEvent(raw);
	} catch (cause) {
		throw new ProviderRuntimeEventStoreError(
			"Invalid ProviderRuntimeEvent envelope",
			cause,
		);
	}
}

export class ProviderRuntimeEventStore {
	constructor(private readonly eventStore: EventStore) {}

	appendUnknown(raw: unknown): StoredEvent {
		return this.appendDecoded(decodeRuntimeEvent(raw));
	}

	append(event: ProviderRuntimeEvent): StoredEvent {
		return this.appendDecoded(decodeRuntimeEvent(event));
	}

	private appendDecoded(event: ProviderRuntimeEvent): StoredEvent {
		assertRawMetadataPolicy(event);
		return this.eventStore.append(providerRuntimeEventToCanonicalEvent(event));
	}

	appendBatch(events: readonly ProviderRuntimeEvent[]): StoredEvent[] {
		const decoded = events.map(decodeRuntimeEvent);
		for (const event of decoded) {
			assertRawMetadataPolicy(event);
		}
		return this.eventStore.appendBatch(
			decoded.map(providerRuntimeEventToCanonicalEvent),
		);
	}
}

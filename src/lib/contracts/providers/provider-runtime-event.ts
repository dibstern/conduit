import { Schema } from "effect";

const NonBlankString = Schema.String.pipe(
	Schema.filter((value) => value.trim().length > 0 && value === value.trim()),
);

const RequiredUnknown = Schema.Unknown.pipe(
	Schema.filter((value) => value !== undefined),
);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};

const hasOwnKey = (value: object, key: string) => Object.hasOwn(value, key);

export const PROVIDER_RUNTIME_EVENT_TYPES = [
	"message.created",
	"text.delta",
	"thinking.start",
	"thinking.delta",
	"thinking.end",
	"tool.started",
	"tool.running",
	"tool.completed",
	"file.attached",
	"tool.input_updated",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"session.created",
	"session.renamed",
	"session.status",
	"session.provider_changed",
	"permission.asked",
	"permission.resolved",
	"question.asked",
	"question.resolved",
] as const;

export const HISTORICAL_PROVIDER_RUNTIME_EVENT_TYPES = [
	"tool.input_updated",
] as const;

const historicalProviderRuntimeEventTypes = new Set<string>(
	HISTORICAL_PROVIDER_RUNTIME_EVENT_TYPES,
);

export const ACTIVE_PROVIDER_RUNTIME_EVENT_TYPES =
	PROVIDER_RUNTIME_EVENT_TYPES.filter(
		(type) => !historicalProviderRuntimeEventTypes.has(type),
	);

export const ProviderRuntimeEventTypeSchema = Schema.Literal(
	...PROVIDER_RUNTIME_EVENT_TYPES,
);
export type ProviderRuntimeEventType = Schema.Schema.Type<
	typeof ProviderRuntimeEventTypeSchema
>;
export type ActiveProviderRuntimeEventType = Exclude<
	ProviderRuntimeEventType,
	(typeof HISTORICAL_PROVIDER_RUNTIME_EVENT_TYPES)[number]
>;

const RAW_SOURCE_METADATA_KEYS = [
	"kind",
	"providerMessageType",
	"providerMessageSubtype",
	"sdkVariant",
	"streamEventType",
	"endpoint",
	"sourceSchema",
] as const;
const rawSourceMetadataKeys = new Set<string>(RAW_SOURCE_METADATA_KEYS);

const isRawSourceMetadataOnly = (value: unknown) =>
	isPlainRecord(value) &&
	Object.keys(value).every((key) => rawSourceMetadataKeys.has(key));

const ProviderRuntimeRawSourceStruct = Schema.Struct({
	kind: NonBlankString,
	providerMessageType: Schema.optional(NonBlankString),
	providerMessageSubtype: Schema.optional(NonBlankString),
	sdkVariant: Schema.optional(NonBlankString),
	streamEventType: Schema.optional(NonBlankString),
	endpoint: Schema.optional(NonBlankString),
	sourceSchema: Schema.optional(NonBlankString),
});

export const ProviderRuntimeRawSourceSchema = Schema.Unknown.pipe(
	Schema.filter(isRawSourceMetadataOnly),
	Schema.compose(ProviderRuntimeRawSourceStruct),
);
export type ProviderRuntimeRawSource = Schema.Schema.Type<
	typeof ProviderRuntimeRawSourceSchema
>;

const PROVIDER_RUNTIME_PROVIDER_REF_KEYS = [
	"providerSessionId",
	"providerMessageId",
	"providerTurnId",
	"providerToolUseId",
	"providerRequestId",
	"providerTaskId",
	"parentProviderTaskId",
] as const;
const providerRuntimeProviderRefKeys = new Set<string>(
	PROVIDER_RUNTIME_PROVIDER_REF_KEYS,
);

const isProviderRefsMetadataOnly = (value: unknown) =>
	isPlainRecord(value) &&
	Object.keys(value).every((key) => providerRuntimeProviderRefKeys.has(key));

const ProviderRuntimeProviderRefsStruct = Schema.Struct({
	providerSessionId: Schema.optional(NonBlankString),
	providerMessageId: Schema.optional(NonBlankString),
	providerTurnId: Schema.optional(NonBlankString),
	providerToolUseId: Schema.optional(NonBlankString),
	providerRequestId: Schema.optional(NonBlankString),
	providerTaskId: Schema.optional(NonBlankString),
	parentProviderTaskId: Schema.optional(NonBlankString),
});

export const ProviderRuntimeProviderRefsSchema = Schema.Unknown.pipe(
	Schema.filter(isProviderRefsMetadataOnly),
	Schema.compose(ProviderRuntimeProviderRefsStruct),
);
export type ProviderRuntimeProviderRefs = Schema.Schema.Type<
	typeof ProviderRuntimeProviderRefsSchema
>;

const ProviderRuntimeCreatedAtSchema = Schema.Union(
	Schema.Number,
	NonBlankString,
);

const REQUIRED_PROVIDER_RUNTIME_EVENT_KEYS = [
	"eventId",
	"type",
	"providerId",
	"sessionId",
	"providerRefs",
	"rawSource",
	"createdAt",
	"data",
] as const;

const PROVIDER_RUNTIME_EVENT_ENVELOPE_KEYS = [
	...REQUIRED_PROVIDER_RUNTIME_EVENT_KEYS,
	"turnId",
	"metadata",
] as const;
const providerRuntimeEventEnvelopeKeys = new Set<string>(
	PROVIDER_RUNTIME_EVENT_ENVELOPE_KEYS,
);

const hasOnlyProviderRuntimeEventEnvelopeKeys = (value: unknown) =>
	isPlainRecord(value) &&
	REQUIRED_PROVIDER_RUNTIME_EVENT_KEYS.every((key) => hasOwnKey(value, key)) &&
	Object.keys(value).every((key) => providerRuntimeEventEnvelopeKeys.has(key));

const ProviderRuntimeEventEnvelopeSchema = Schema.Struct({
	eventId: NonBlankString,
	type: ProviderRuntimeEventTypeSchema,
	providerId: NonBlankString,
	sessionId: NonBlankString,
	turnId: Schema.optional(NonBlankString),
	providerRefs: ProviderRuntimeProviderRefsSchema,
	rawSource: ProviderRuntimeRawSourceSchema,
	createdAt: ProviderRuntimeCreatedAtSchema,
	data: RequiredUnknown,
	metadata: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	),
});

export const ProviderRuntimeEventSchema = Schema.Unknown.pipe(
	Schema.filter(hasOnlyProviderRuntimeEventEnvelopeKeys),
	Schema.compose(ProviderRuntimeEventEnvelopeSchema),
);
export type ProviderRuntimeEvent = Schema.Schema.Type<
	typeof ProviderRuntimeEventSchema
>;

export const ProviderRuntimeEventsSchema = Schema.Array(
	ProviderRuntimeEventSchema,
);

const decodeProviderRuntimeEventEnvelope = Schema.decodeUnknownSync(
	ProviderRuntimeEventSchema,
);
const decodeProviderRuntimeEventsEnvelope = Schema.decodeUnknownSync(
	ProviderRuntimeEventsSchema,
);
const isProviderRuntimeEventEnvelope = Schema.is(ProviderRuntimeEventSchema);

export function decodeProviderRuntimeEvent(raw: unknown): ProviderRuntimeEvent {
	return decodeProviderRuntimeEventEnvelope(raw);
}

export function decodeProviderRuntimeEvents(
	raw: unknown,
): ReadonlyArray<ProviderRuntimeEvent> {
	return decodeProviderRuntimeEventsEnvelope(raw);
}

export function isProviderRuntimeEvent(
	raw: unknown,
): raw is ProviderRuntimeEvent {
	return isProviderRuntimeEventEnvelope(raw);
}

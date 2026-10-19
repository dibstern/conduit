import { Schema } from "effect";
import type { EventPayloadMap } from "../stored-event.js";

const NonBlankString = Schema.String.pipe(
	Schema.check(
		Schema.makeFilter(
			(value) => value.trim().length > 0 && value === value.trim(),
		),
	),
);

const RequiredUnknown = Schema.Unknown.pipe(
	Schema.check(Schema.makeFilter((value) => value !== undefined)),
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
	"run.started",
	"message.created",
	"message.removed",
	"message.part.removed",
	"message.snapshot",
	"text.delta",
	"thinking.start",
	"thinking.delta",
	"thinking.end",
	"tool.started",
	"tool.running",
	"tool.completed",
	"file.attached",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"turn.model_resolved",
	"session.created",
	"session.deleted",
	"session.renamed",
	"session.status",
	"session.compaction",
	"session.provider_changed",
	"session.permission_mode_changed",
	"session.goal_changed",
	"session.usage_limited",
	"workspace.changed",
	"permission.asked",
	"permission.resolved",
	"question.asked",
	"question.resolved",
] as const;

export const ProviderRuntimeEventTypeSchema = Schema.Literals([
	...PROVIDER_RUNTIME_EVENT_TYPES,
]);
export type ProviderRuntimeEventType = Schema.Schema.Type<
	typeof ProviderRuntimeEventTypeSchema
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
	Schema.check(Schema.makeFilter(isRawSourceMetadataOnly)),
	Schema.decodeTo(ProviderRuntimeRawSourceStruct),
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
	"providerProcessId",
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
	providerProcessId: Schema.optional(NonBlankString),
	providerTaskId: Schema.optional(NonBlankString),
	parentProviderTaskId: Schema.optional(NonBlankString),
});

export const ProviderRuntimeProviderRefsSchema = Schema.Unknown.pipe(
	Schema.check(Schema.makeFilter(isProviderRefsMetadataOnly)),
	Schema.decodeTo(ProviderRuntimeProviderRefsStruct),
);
export type ProviderRuntimeProviderRefs = Schema.Schema.Type<
	typeof ProviderRuntimeProviderRefsSchema
>;

const ProviderRuntimeCreatedAtSchema = Schema.Union([
	Schema.Number,
	NonBlankString,
]);

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
	"runId",
	"metadata",
] as const;
const providerRuntimeEventEnvelopeKeys = new Set<string>(
	PROVIDER_RUNTIME_EVENT_ENVELOPE_KEYS,
);

const hasOnlyProviderRuntimeEventEnvelopeKeys = (value: unknown) =>
	isPlainRecord(value) &&
	REQUIRED_PROVIDER_RUNTIME_EVENT_KEYS.every((key) => hasOwnKey(value, key)) &&
	Object.keys(value).every((key) => providerRuntimeEventEnvelopeKeys.has(key));

const ProviderRuntimeEventEnvelopeFields = {
	eventId: NonBlankString,
	providerId: NonBlankString,
	sessionId: NonBlankString,
	turnId: Schema.optional(NonBlankString),
	runId: Schema.optional(NonBlankString),
	providerRefs: ProviderRuntimeProviderRefsSchema,
	rawSource: ProviderRuntimeRawSourceSchema,
	createdAt: ProviderRuntimeCreatedAtSchema,
	metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
};

export const ProviderWorkspaceChangedDataSchema = Schema.Struct({
	path: NonBlankString,
	source: Schema.Literals(["tool", "start"]),
});
export type ProviderWorkspaceChangedData = Schema.Schema.Type<
	typeof ProviderWorkspaceChangedDataSchema
>;

export type ProviderRuntimeEventPayloadMap = Pick<
	EventPayloadMap,
	Exclude<ProviderRuntimeEventType, "workspace.changed">
> & {
	"workspace.changed": ProviderWorkspaceChangedData;
};

const ProviderRuntimeEventEnvelopeSchema = Schema.Union([
	Schema.Struct({
		...ProviderRuntimeEventEnvelopeFields,
		type: Schema.Literal("workspace.changed"),
		data: ProviderWorkspaceChangedDataSchema,
	}),
	Schema.Struct({
		...ProviderRuntimeEventEnvelopeFields,
		type: Schema.Literals([
			...PROVIDER_RUNTIME_EVENT_TYPES.filter(
				(type) => type !== "workspace.changed",
			),
		]),
		data: RequiredUnknown,
	}),
]);

export const ProviderRuntimeEventSchema = Schema.Unknown.pipe(
	Schema.check(Schema.makeFilter(hasOnlyProviderRuntimeEventEnvelopeKeys)),
	Schema.decodeTo(ProviderRuntimeEventEnvelopeSchema),
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

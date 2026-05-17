import { Schema } from "effect";

const NonBlankString = Schema.String.pipe(
	Schema.filter((value) => value.trim().length > 0 && value === value.trim()),
);

export const ProviderRuntimeEventTypeSchema = Schema.Literal(
	"message.created",
	"text.delta",
	"thinking.start",
	"thinking.delta",
	"thinking.end",
	"tool.started",
	"tool.running",
	"tool.completed",
	"tool.input_updated", // Historical compatibility only; new provider runtimes should not emit it.
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
);
export type ProviderRuntimeEventType = Schema.Schema.Type<
	typeof ProviderRuntimeEventTypeSchema
>;

export const ProviderRuntimeProviderRefsSchema = Schema.Struct({
	providerSessionId: Schema.optionalWith(NonBlankString, { exact: true }),
	providerMessageId: Schema.optionalWith(NonBlankString, { exact: true }),
	providerTurnId: Schema.optionalWith(NonBlankString, { exact: true }),
	providerToolUseId: Schema.optionalWith(NonBlankString, { exact: true }),
	providerRequestId: Schema.optionalWith(NonBlankString, { exact: true }),
	providerTaskId: Schema.optionalWith(NonBlankString, { exact: true }),
	parentProviderTaskId: Schema.optionalWith(NonBlankString, { exact: true }),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type ProviderRuntimeProviderRefs = Schema.Schema.Type<
	typeof ProviderRuntimeProviderRefsSchema
>;

export const ProviderRuntimeRawSourceSchema = Schema.Struct({
	kind: NonBlankString,
	providerMessageType: Schema.optionalWith(NonBlankString, { exact: true }),
	providerMessageSubtype: Schema.optionalWith(NonBlankString, { exact: true }),
	sdkVariant: Schema.optionalWith(NonBlankString, { exact: true }),
	streamEventType: Schema.optionalWith(NonBlankString, { exact: true }),
	endpoint: Schema.optionalWith(NonBlankString, { exact: true }),
	sourceSchema: Schema.optionalWith(NonBlankString, { exact: true }),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type ProviderRuntimeRawSource = Schema.Schema.Type<
	typeof ProviderRuntimeRawSourceSchema
>;

const ProviderRuntimeDataSchema = Schema.Unknown.pipe(
	Schema.filter((value) => value !== undefined),
);

const ProviderRuntimeMetadataSchema = Schema.Record({
	key: Schema.String,
	value: Schema.Unknown,
});

const ProviderRuntimeEventBaseFields = {
	eventId: NonBlankString,
	providerId: NonBlankString,
	sessionId: NonBlankString,
	turnId: Schema.optionalWith(NonBlankString, { exact: true }),
	providerRefs: ProviderRuntimeProviderRefsSchema,
	rawSource: ProviderRuntimeRawSourceSchema,
	createdAt: Schema.Number,
	data: ProviderRuntimeDataSchema,
	metadata: Schema.optionalWith(ProviderRuntimeMetadataSchema, { exact: true }),
};

function providerRuntimeEvent<T extends ProviderRuntimeEventType>(type: T) {
	return Schema.Struct({
		...ProviderRuntimeEventBaseFields,
		type: Schema.Literal(type),
	}).annotations({ parseOptions: { onExcessProperty: "error" } });
}

const MessageCreatedEvent = providerRuntimeEvent("message.created");
const TextDeltaEvent = providerRuntimeEvent("text.delta");
const ThinkingStartEvent = providerRuntimeEvent("thinking.start");
const ThinkingDeltaEvent = providerRuntimeEvent("thinking.delta");
const ThinkingEndEvent = providerRuntimeEvent("thinking.end");
const ToolStartedEvent = providerRuntimeEvent("tool.started");
const ToolRunningEvent = providerRuntimeEvent("tool.running");
const ToolCompletedEvent = providerRuntimeEvent("tool.completed");
const ToolInputUpdatedEvent = providerRuntimeEvent("tool.input_updated");
const TurnCompletedEvent = providerRuntimeEvent("turn.completed");
const TurnErrorEvent = providerRuntimeEvent("turn.error");
const TurnInterruptedEvent = providerRuntimeEvent("turn.interrupted");
const SessionCreatedEvent = providerRuntimeEvent("session.created");
const SessionRenamedEvent = providerRuntimeEvent("session.renamed");
const SessionStatusEvent = providerRuntimeEvent("session.status");
const SessionProviderChangedEvent = providerRuntimeEvent(
	"session.provider_changed",
);
const PermissionAskedEvent = providerRuntimeEvent("permission.asked");
const PermissionResolvedEvent = providerRuntimeEvent("permission.resolved");
const QuestionAskedEvent = providerRuntimeEvent("question.asked");
const QuestionResolvedEvent = providerRuntimeEvent("question.resolved");

export const ProviderRuntimeEventSchema = Schema.Union(
	MessageCreatedEvent,
	TextDeltaEvent,
	ThinkingStartEvent,
	ThinkingDeltaEvent,
	ThinkingEndEvent,
	ToolStartedEvent,
	ToolRunningEvent,
	ToolCompletedEvent,
	ToolInputUpdatedEvent,
	TurnCompletedEvent,
	TurnErrorEvent,
	TurnInterruptedEvent,
	SessionCreatedEvent,
	SessionRenamedEvent,
	SessionStatusEvent,
	SessionProviderChangedEvent,
	PermissionAskedEvent,
	PermissionResolvedEvent,
	QuestionAskedEvent,
	QuestionResolvedEvent,
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

export function decodeProviderRuntimeEvent(
	value: unknown,
): ProviderRuntimeEvent {
	return decodeProviderRuntimeEventEnvelope(value);
}

export function decodeProviderRuntimeEvents(
	value: unknown,
): ReadonlyArray<ProviderRuntimeEvent> {
	return decodeProviderRuntimeEventsEnvelope(value);
}

export function isProviderRuntimeEvent(
	value: unknown,
): value is ProviderRuntimeEvent {
	return isProviderRuntimeEventEnvelope(value);
}

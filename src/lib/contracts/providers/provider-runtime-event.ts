import { Schema } from "effect";

const NonBlankString = Schema.String.pipe(
	Schema.filter((value) => value.trim().length > 0 && value === value.trim()),
);

export const ProviderRuntimeEventId = NonBlankString;
export type ProviderRuntimeEventId = Schema.Schema.Type<
	typeof ProviderRuntimeEventId
>;

export const ProviderRuntimeThreadId = NonBlankString;
export type ProviderRuntimeThreadId = Schema.Schema.Type<
	typeof ProviderRuntimeThreadId
>;

export const ProviderRuntimeTurnId = NonBlankString;
export type ProviderRuntimeTurnId = Schema.Schema.Type<
	typeof ProviderRuntimeTurnId
>;

export const ProviderRuntimeItemId = NonBlankString;
export type ProviderRuntimeItemId = Schema.Schema.Type<
	typeof ProviderRuntimeItemId
>;

export const ProviderRuntimeRequestId = NonBlankString;
export type ProviderRuntimeRequestId = Schema.Schema.Type<
	typeof ProviderRuntimeRequestId
>;

export const ProviderRuntimeProviderId = NonBlankString;
export type ProviderRuntimeProviderId = Schema.Schema.Type<
	typeof ProviderRuntimeProviderId
>;

export const ProviderRuntimeProviderInstanceId = NonBlankString;
export type ProviderRuntimeProviderInstanceId = Schema.Schema.Type<
	typeof ProviderRuntimeProviderInstanceId
>;

export const ProviderRuntimeRawSource = Schema.Literal(
	"claude.sdk.message",
	"claude.sdk.result",
	"claude.sdk.permission",
	"opencode.sdk.event",
	"opencode.sdk.response",
	"opencode.gap.response",
	"conduit.provider.request",
	"conduit.provider.translator",
	"conduit.provider.runtime",
);
export type ProviderRuntimeRawSource = Schema.Schema.Type<
	typeof ProviderRuntimeRawSource
>;

export const ProviderRuntimeRaw = Schema.Struct({
	source: ProviderRuntimeRawSource,
	method: Schema.optional(Schema.String),
	messageType: Schema.optional(Schema.String),
	payload: Schema.Unknown,
});
export type ProviderRuntimeRaw = Schema.Schema.Type<typeof ProviderRuntimeRaw>;

export const ProviderRuntimeProviderRefs = Schema.Struct({
	providerTurnId: Schema.optional(Schema.String),
	providerItemId: Schema.optional(Schema.String),
	providerRequestId: Schema.optional(Schema.String),
	providerSessionId: Schema.optional(Schema.String),
});
export type ProviderRuntimeProviderRefs = Schema.Schema.Type<
	typeof ProviderRuntimeProviderRefs
>;

const ProviderRuntimeTimestamp = Schema.Union(Schema.String, Schema.Number);

const ProviderRuntimeEventBaseFields = {
	eventId: ProviderRuntimeEventId,
	provider: ProviderRuntimeProviderId,
	providerInstanceId: Schema.optional(ProviderRuntimeProviderInstanceId),
	threadId: ProviderRuntimeThreadId,
	createdAt: ProviderRuntimeTimestamp,
	turnId: Schema.optional(ProviderRuntimeTurnId),
	itemId: Schema.optional(ProviderRuntimeItemId),
	requestId: Schema.optional(ProviderRuntimeRequestId),
	providerRefs: Schema.optional(ProviderRuntimeProviderRefs),
	raw: Schema.optional(ProviderRuntimeRaw),
};

export const ProviderRuntimeEventBase = Schema.Struct(
	ProviderRuntimeEventBaseFields,
);
export type ProviderRuntimeEventBase = Schema.Schema.Type<
	typeof ProviderRuntimeEventBase
>;

const ProviderRuntimeSessionState = Schema.Literal(
	"starting",
	"ready",
	"running",
	"waiting",
	"stopped",
	"error",
);

const ProviderRuntimeThreadState = Schema.Literal(
	"active",
	"idle",
	"archived",
	"closed",
	"compacted",
	"error",
);

const ProviderRuntimeTurnTerminalState = Schema.Literal(
	"completed",
	"failed",
	"interrupted",
	"cancelled",
);

const ProviderRuntimeItemType = Schema.Literal(
	"user_message",
	"assistant_message",
	"reasoning",
	"tool_call",
	"permission_request",
	"question_request",
	"error",
	"unknown",
);

const ProviderRuntimeItemStatus = Schema.Literal(
	"inProgress",
	"completed",
	"failed",
	"declined",
);

const ProviderRuntimeContentStreamKind = Schema.Literal(
	"assistant_text",
	"reasoning_text",
	"tool_output",
	"command_output",
	"unknown",
);

const ProviderRuntimeRequestType = Schema.Literal(
	"tool_permission",
	"file_permission",
	"command_permission",
	"provider_permission",
	"unknown",
);

const ProviderRuntimeIssueClass = Schema.Literal(
	"provider",
	"transport",
	"permission",
	"validation",
	"unknown",
);

const SessionStartedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("session.started"),
});

const SessionStateChangedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("session.state.changed"),
	payload: Schema.Struct({ state: ProviderRuntimeSessionState }),
});

const SessionMetadataUpdatedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("session.metadata.updated"),
	payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

const ThreadStartedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("thread.started"),
});

const ThreadStateChangedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("thread.state.changed"),
	payload: Schema.Struct({ state: ProviderRuntimeThreadState }),
});

const TurnStartedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("turn.started"),
});

const TurnCompletedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("turn.completed"),
	payload: Schema.Struct({
		state: ProviderRuntimeTurnTerminalState,
		durationMs: Schema.optional(Schema.Number),
		cost: Schema.optional(Schema.Unknown),
		tokens: Schema.optional(Schema.Unknown),
	}),
});

const TurnAbortedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("turn.aborted"),
	payload: Schema.optional(
		Schema.Struct({
			state: Schema.optional(ProviderRuntimeTurnTerminalState),
			reason: Schema.optional(Schema.String),
		}),
	),
});

const RuntimeItemPayload = Schema.Struct({
	itemType: ProviderRuntimeItemType,
	status: Schema.optional(ProviderRuntimeItemStatus),
	title: Schema.optional(Schema.String),
	input: Schema.optional(Schema.Unknown),
	output: Schema.optional(Schema.Unknown),
});

const ItemStartedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("item.started"),
	payload: RuntimeItemPayload,
});

const ItemUpdatedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("item.updated"),
	payload: RuntimeItemPayload,
});

const ItemCompletedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("item.completed"),
	payload: RuntimeItemPayload,
});

const ContentDeltaEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("content.delta"),
	payload: Schema.Struct({
		streamKind: ProviderRuntimeContentStreamKind,
		text: Schema.String,
	}),
});

const RequestOpenedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("request.opened"),
	payload: Schema.Struct({
		requestType: ProviderRuntimeRequestType,
		title: Schema.optional(Schema.String),
		description: Schema.optional(Schema.String),
		toolName: Schema.optional(Schema.String),
		input: Schema.optional(Schema.Unknown),
	}),
});

const RequestResolvedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("request.resolved"),
	payload: Schema.Struct({
		requestType: ProviderRuntimeRequestType,
		decision: Schema.String,
		reason: Schema.optional(Schema.String),
		output: Schema.optional(Schema.Unknown),
	}),
});

const UserInputQuestion = Schema.Struct({
	id: Schema.optional(Schema.String),
	header: Schema.optional(Schema.String),
	question: Schema.String,
	options: Schema.optional(Schema.Array(Schema.String)),
	multiSelect: Schema.optional(Schema.Boolean),
});

const UserInputRequestedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("user-input.requested"),
	payload: Schema.Struct({
		questions: Schema.Array(UserInputQuestion),
	}),
});

const UserInputResolvedEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("user-input.resolved"),
	payload: Schema.Struct({
		answers: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	}),
});

const RuntimeIssuePayload = Schema.Struct({
	errorClass: ProviderRuntimeIssueClass,
	message: Schema.String,
	code: Schema.optional(Schema.String),
	retryable: Schema.optional(Schema.Boolean),
});

const RuntimeWarningEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("runtime.warning"),
	payload: RuntimeIssuePayload,
});

const RuntimeErrorEvent = Schema.Struct({
	...ProviderRuntimeEventBaseFields,
	type: Schema.Literal("runtime.error"),
	payload: RuntimeIssuePayload,
});

export const ProviderRuntimeEvent = Schema.Union(
	SessionStartedEvent,
	SessionStateChangedEvent,
	SessionMetadataUpdatedEvent,
	ThreadStartedEvent,
	ThreadStateChangedEvent,
	TurnStartedEvent,
	TurnCompletedEvent,
	TurnAbortedEvent,
	ItemStartedEvent,
	ItemUpdatedEvent,
	ItemCompletedEvent,
	ContentDeltaEvent,
	RequestOpenedEvent,
	RequestResolvedEvent,
	UserInputRequestedEvent,
	UserInputResolvedEvent,
	RuntimeWarningEvent,
	RuntimeErrorEvent,
);
export type ProviderRuntimeEvent = Schema.Schema.Type<
	typeof ProviderRuntimeEvent
>;

export const ProviderRuntimeEventSchema = ProviderRuntimeEvent;
export const ProviderRuntimeEventsSchema = Schema.Array(ProviderRuntimeEvent);

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

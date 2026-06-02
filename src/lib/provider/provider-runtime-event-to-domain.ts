import type { ProviderRuntimeEvent } from "../contracts/providers/provider-runtime-event.js";
import {
	type CanonicalEvent,
	type CanonicalEventType,
	type CanonicalToolInput,
	canonicalEvent,
	type EventId,
	type EventMetadata,
	type MessageRole,
	type PermissionDecision,
	type SessionCreatedPayload,
	type SessionStatusValue,
	type TurnCompletedPayload,
	type TurnErrorPayload,
} from "../persistence/events.js";

export type ProviderRuntimeDomainMapperState = {
	readonly currentAssistantMessageIds: ReadonlyMap<string, string>;
	readonly itemMessageIds: ReadonlyMap<string, string>;
	readonly startedToolPartIds: ReadonlySet<string>;
};

export const emptyProviderRuntimeDomainMapperState: ProviderRuntimeDomainMapperState =
	{
		currentAssistantMessageIds: new Map(),
		itemMessageIds: new Map(),
		startedToolPartIds: new Set(),
	};

export function translateProviderRuntimeEventToDomain(
	event: ProviderRuntimeEvent,
	state: ProviderRuntimeDomainMapperState = emptyProviderRuntimeDomainMapperState,
): {
	readonly events: readonly CanonicalEvent[];
	readonly state: ProviderRuntimeDomainMapperState;
} {
	const data = dataRecord(event);

	if (event.type === "message.created") {
		const messageId = messageIdFromData(event, data);
		const role = messageRole(data["role"]);
		const nextState =
			role === "assistant"
				? withCurrentAssistantMessageId(event, state, messageId)
				: state;
		return {
			events: [
				canonicalEvent(
					"message.created",
					event.sessionId,
					{
						messageId,
						role,
						sessionId: stringField(data["sessionId"]) ?? event.sessionId,
						...(event.turnId ? { turnId: event.turnId } : {}),
					},
					eventOptions(event),
				),
			],
			state: nextState,
		};
	}

	if (event.type === "text.delta") {
		const messageId = messageIdFromData(event, data);
		return {
			events: [
				canonicalEvent(
					"text.delta",
					event.sessionId,
					{
						messageId,
						partId: stringField(data["partId"]) ?? `${messageId}:text`,
						text: stringField(data["text"]) ?? "",
					},
					eventOptions(event),
				),
			],
			state,
		};
	}

	if (event.type === "thinking.start") {
		const partId = partIdFromData(event, data);
		const messageId = messageIdFromDataOrState(event, data, state);
		return {
			events: [
				canonicalEvent(
					"thinking.start",
					event.sessionId,
					{ messageId, partId },
					eventOptions(event),
				),
			],
			state: withItemMessageId(event, state, partId, messageId),
		};
	}

	if (event.type === "thinking.delta") {
		const partId = partIdFromData(event, data);
		return {
			events: [
				canonicalEvent(
					"thinking.delta",
					event.sessionId,
					{
						messageId: messageIdForPart(event, data, state, partId),
						partId,
						text: stringField(data["text"]) ?? "",
					},
					eventOptions(event),
				),
			],
			state,
		};
	}

	if (event.type === "thinking.end") {
		const partId = partIdFromData(event, data);
		return {
			events: [
				canonicalEvent(
					"thinking.end",
					event.sessionId,
					{
						messageId: messageIdForPart(event, data, state, partId),
						partId,
					},
					eventOptions(event),
				),
			],
			state,
		};
	}

	if (event.type === "tool.started") {
		const partId = partIdFromData(event, data);
		const messageId = messageIdFromDataOrState(event, data, state);
		return {
			events: [toolStartedEvent(event, data, messageId, partId, event.eventId)],
			state: withStartedToolPartId(
				event,
				withItemMessageId(event, state, partId, messageId),
				partId,
			),
		};
	}

	if (event.type === "tool.running") {
		const partId = partIdFromData(event, data);
		return {
			events: [
				canonicalEvent(
					"tool.running",
					event.sessionId,
					{
						messageId: messageIdForPart(event, data, state, partId),
						partId,
						...(isRecord(data["metadata"])
							? { metadata: data["metadata"] }
							: {}),
					},
					eventOptions(event),
				),
			],
			state,
		};
	}

	if (event.type === "tool.completed") {
		const partId = partIdFromData(event, data);
		const messageId = messageIdForPart(event, data, state, partId);
		const events: CanonicalEvent[] = [];
		const toolWasStarted = state.startedToolPartIds.has(partKey(event, partId));
		if (!toolWasStarted) {
			events.push(
				toolStartedEvent(
					event,
					data,
					messageId,
					partId,
					`${event.eventId}:tool.started`,
				),
			);
		}
		events.push(
			canonicalEvent(
				"tool.completed",
				event.sessionId,
				{
					messageId,
					partId,
					result: data["result"] ?? "",
					duration: numberFieldValue(data["duration"]) ?? 0,
				},
				eventOptions(event),
			),
		);
		return {
			events,
			state: withStartedToolPartId(
				event,
				withItemMessageId(event, state, partId, messageId),
				partId,
			),
		};
	}

	if (event.type === "turn.completed") {
		const cost = numberFieldValue(data["cost"]);
		const tokens = tokensValue(data["tokens"]);
		const duration =
			numberFieldValue(data["duration"]) ??
			numberFieldValue(data["durationMs"]);
		const payload = {
			messageId: messageIdFromDataOrState(event, data, state),
			...(cost != null ? { cost } : {}),
			...(tokens != null ? { tokens } : {}),
			...(duration != null ? { duration } : {}),
		} satisfies TurnCompletedPayload;
		return singleEvent(event, state, "turn.completed", payload);
	}

	if (event.type === "turn.error") {
		const code = stringField(data["code"]);
		const payload = {
			messageId: messageIdFromDataOrState(event, data, state),
			error:
				stringField(data["error"]) ??
				stringField(data["message"]) ??
				"Provider runtime error",
			...(code != null ? { code } : {}),
		} satisfies TurnErrorPayload;
		return singleEvent(event, state, "turn.error", payload);
	}

	if (event.type === "turn.interrupted") {
		return singleEvent(event, state, "turn.interrupted", {
			messageId: messageIdFromDataOrState(event, data, state),
		});
	}

	if (event.type === "session.created") {
		const parentId = stringField(data["parentId"]);
		const providerSessionId =
			stringField(data["providerSessionId"]) ??
			event.providerRefs.providerSessionId;
		const payload = {
			sessionId: stringField(data["sessionId"]) ?? event.sessionId,
			title: stringField(data["title"]) ?? "Untitled",
			provider: stringField(data["provider"]) ?? event.providerId,
			...(parentId != null ? { parentId } : {}),
			...(providerSessionId != null ? { providerSessionId } : {}),
		} satisfies SessionCreatedPayload;
		return singleEvent(event, state, "session.created", payload);
	}

	if (event.type === "session.renamed") {
		const title = stringField(data["title"]);
		if (title == null || title.length === 0) return { events: [], state };
		return singleEvent(event, state, "session.renamed", {
			sessionId: event.sessionId,
			title,
		});
	}

	if (event.type === "session.status") {
		const status = sessionStatus(data["status"]);
		return singleEvent(event, state, "session.status", {
			sessionId: event.sessionId,
			status,
			...(event.turnId ? { turnId: event.turnId } : {}),
		});
	}

	if (event.type === "session.provider_changed") {
		const oldProvider = stringField(data["oldProvider"]);
		const newProvider = stringField(data["newProvider"]);
		if (oldProvider == null || newProvider == null)
			return { events: [], state };
		return singleEvent(event, state, "session.provider_changed", {
			sessionId: event.sessionId,
			oldProvider,
			newProvider,
		});
	}

	if (event.type === "permission.asked") {
		return singleEvent(event, state, "permission.asked", {
			id: requestId(event, data),
			sessionId: event.sessionId,
			toolName: stringField(data["toolName"]) ?? "Unknown",
			input: data["input"],
		});
	}

	if (event.type === "permission.resolved") {
		return singleEvent(event, state, "permission.resolved", {
			id: requestId(event, data),
			decision: permissionDecision(stringField(data["decision"]) ?? ""),
		});
	}

	if (event.type === "question.asked") {
		return singleEvent(event, state, "question.asked", {
			id: requestId(event, data),
			sessionId: event.sessionId,
			questions: data["questions"],
		});
	}

	if (event.type === "question.resolved") {
		return singleEvent(event, state, "question.resolved", {
			id: requestId(event, data),
			answers: isRecord(data["answers"]) ? data["answers"] : {},
		});
	}

	if (event.type === "tool.input_updated") {
		const partId = partIdFromData(event, data);
		return {
			events: [
				canonicalEvent(
					"tool.input_updated",
					event.sessionId,
					{
						messageId: messageIdForPart(event, data, state, partId),
						partId,
						...data,
					},
					eventOptions(event),
				),
			],
			state,
		};
	}

	return { events: [], state };
}

function singleEvent<K extends CanonicalEventType>(
	event: ProviderRuntimeEvent,
	state: ProviderRuntimeDomainMapperState,
	type: K,
	data: Parameters<typeof canonicalEvent<K>>[2],
): {
	readonly events: readonly CanonicalEvent[];
	readonly state: ProviderRuntimeDomainMapperState;
} {
	return {
		events: [canonicalEvent(type, event.sessionId, data, eventOptions(event))],
		state,
	};
}

function toolStartedEvent(
	event: ProviderRuntimeEvent,
	data: Record<string, unknown>,
	messageId: string,
	partId: string,
	eventId: string,
): CanonicalEvent {
	const toolName = stringField(data["toolName"]) ?? "Unknown";
	return canonicalEvent(
		"tool.started",
		event.sessionId,
		{
			messageId,
			partId,
			toolName,
			callId:
				stringField(data["callId"]) ??
				event.providerRefs.providerToolUseId ??
				partId,
			input: normalizeToolInput(toolName, data["input"]),
		},
		eventOptions(event, { schemaVersion: 2 }, eventId),
	);
}

function withCurrentAssistantMessageId(
	event: ProviderRuntimeEvent,
	state: ProviderRuntimeDomainMapperState,
	messageId: string,
): ProviderRuntimeDomainMapperState {
	const currentAssistantMessageIds = new Map(state.currentAssistantMessageIds);
	currentAssistantMessageIds.set(messageKey(event), messageId);
	return { ...state, currentAssistantMessageIds };
}

function withItemMessageId(
	event: ProviderRuntimeEvent,
	state: ProviderRuntimeDomainMapperState,
	partId: string,
	messageId: string,
): ProviderRuntimeDomainMapperState {
	const itemMessageIds = new Map(state.itemMessageIds);
	itemMessageIds.set(partKey(event, partId), messageId);
	return { ...state, itemMessageIds };
}

function withStartedToolPartId(
	event: ProviderRuntimeEvent,
	state: ProviderRuntimeDomainMapperState,
	partId: string,
): ProviderRuntimeDomainMapperState {
	const startedToolPartIds = new Set(state.startedToolPartIds);
	startedToolPartIds.add(partKey(event, partId));
	return { ...state, startedToolPartIds };
}

function currentMessageId(
	event: ProviderRuntimeEvent,
	state: ProviderRuntimeDomainMapperState,
): string {
	return (
		state.currentAssistantMessageIds.get(messageKey(event)) ??
		state.currentAssistantMessageIds.get(event.sessionId) ??
		event.providerRefs.providerMessageId ??
		event.eventId
	);
}

function messageIdForPart(
	event: ProviderRuntimeEvent,
	data: Record<string, unknown>,
	state: ProviderRuntimeDomainMapperState,
	partId: string,
): string {
	return (
		stringField(data["messageId"]) ??
		state.itemMessageIds.get(partKey(event, partId)) ??
		currentMessageId(event, state)
	);
}

function messageIdFromData(
	event: ProviderRuntimeEvent,
	data: Record<string, unknown>,
): string {
	return (
		stringField(data["messageId"]) ??
		event.providerRefs.providerMessageId ??
		event.eventId
	);
}

function messageIdFromDataOrState(
	event: ProviderRuntimeEvent,
	data: Record<string, unknown>,
	state: ProviderRuntimeDomainMapperState,
): string {
	return stringField(data["messageId"]) ?? currentMessageId(event, state);
}

function messageKey(event: ProviderRuntimeEvent): string {
	return event.turnId ? `${event.sessionId}:${event.turnId}` : event.sessionId;
}

function partKey(event: ProviderRuntimeEvent, partId: string): string {
	return `${event.sessionId}:${event.turnId ?? ""}:${partId}`;
}

function partIdFromData(
	event: ProviderRuntimeEvent,
	data: Record<string, unknown>,
): string {
	return (
		stringField(data["partId"]) ??
		event.providerRefs.providerToolUseId ??
		event.providerRefs.providerMessageId ??
		event.eventId
	);
}

function eventOptions(
	event: ProviderRuntimeEvent,
	metadata?: EventMetadata,
	eventId: string = event.eventId,
): {
	eventId: EventId;
	metadata: EventMetadata;
	provider: string;
	createdAt: number;
} {
	return {
		eventId: eventId as EventId,
		metadata: { ...eventMetadata(event), ...metadata },
		provider: event.providerId,
		createdAt: parseCreatedAt(event.createdAt),
	};
}

function eventMetadata(event: ProviderRuntimeEvent): EventMetadata {
	return {
		...runtimeMetadata(event.metadata),
		providerRuntimeEventId: event.eventId,
		rawSource: event.rawSource.kind,
		providerRefs: providerRefsMetadata(event.providerRefs),
	};
}

function runtimeMetadata(
	metadata: ProviderRuntimeEvent["metadata"],
): EventMetadata {
	if (!isRecord(metadata)) return {};
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

function parseCreatedAt(createdAt: ProviderRuntimeEvent["createdAt"]): number {
	if (typeof createdAt === "number") return createdAt;
	const parsed = Date.parse(createdAt);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeToolInput(
	toolName: string,
	input: unknown,
): CanonicalToolInput {
	if (!isRecord(input)) return { tool: "Unknown", name: toolName, raw: {} };
	const canonical = canonicalToolInput(input);
	if (canonical) return canonical;

	if (
		input["tool"] === "Task" &&
		typeof input["description"] === "string" &&
		typeof input["prompt"] === "string"
	) {
		return {
			tool: "Task",
			description: input["description"],
			prompt: input["prompt"],
			...(typeof input["subagentType"] === "string"
				? { subagentType: input["subagentType"] }
				: {}),
		};
	}

	if (input["tool"] === "Bash" && typeof input["command"] === "string") {
		return {
			tool: "Bash",
			command: input["command"],
			...(typeof input["description"] === "string"
				? { description: input["description"] }
				: {}),
			...(typeof input["timeoutMs"] === "number"
				? { timeoutMs: input["timeoutMs"] }
				: {}),
		};
	}

	if (toolName === "Bash" && typeof input["command"] === "string") {
		return {
			tool: "Bash",
			command: input["command"],
			...(typeof input["description"] === "string"
				? { description: input["description"] }
				: {}),
			...(typeof input["timeoutMs"] === "number"
				? { timeoutMs: input["timeoutMs"] }
				: {}),
			...(typeof input["timeout_ms"] === "number"
				? { timeoutMs: input["timeout_ms"] }
				: {}),
		};
	}

	return { tool: "Unknown", name: toolName, raw: input };
}

function canonicalToolInput(
	input: Record<string, unknown>,
): CanonicalToolInput | undefined {
	if (input["tool"] === "Read" && typeof input["filePath"] === "string") {
		return {
			tool: "Read",
			filePath: input["filePath"],
			...(typeof input["offset"] === "number"
				? { offset: input["offset"] }
				: {}),
			...(typeof input["limit"] === "number" ? { limit: input["limit"] } : {}),
		};
	}
	if (input["tool"] === "Edit" && typeof input["filePath"] === "string") {
		return {
			tool: "Edit",
			filePath: input["filePath"],
			oldString:
				typeof input["oldString"] === "string" ? input["oldString"] : "",
			newString:
				typeof input["newString"] === "string" ? input["newString"] : "",
			...(typeof input["replaceAll"] === "boolean"
				? { replaceAll: input["replaceAll"] }
				: {}),
		};
	}
	if (input["tool"] === "Write" && typeof input["filePath"] === "string") {
		return {
			tool: "Write",
			filePath: input["filePath"],
			content: typeof input["content"] === "string" ? input["content"] : "",
		};
	}
	if (input["tool"] === "Grep" && typeof input["pattern"] === "string") {
		return {
			tool: "Grep",
			pattern: input["pattern"],
			...(typeof input["path"] === "string" ? { path: input["path"] } : {}),
			...(typeof input["include"] === "string"
				? { include: input["include"] }
				: {}),
			...(typeof input["fileType"] === "string"
				? { fileType: input["fileType"] }
				: {}),
		};
	}
	if (input["tool"] === "Glob" && typeof input["pattern"] === "string") {
		return {
			tool: "Glob",
			pattern: input["pattern"],
			...(typeof input["path"] === "string" ? { path: input["path"] } : {}),
		};
	}
	if (input["tool"] === "WebFetch" && typeof input["url"] === "string") {
		return {
			tool: "WebFetch",
			url: input["url"],
			...(typeof input["prompt"] === "string"
				? { prompt: input["prompt"] }
				: {}),
		};
	}
	if (input["tool"] === "WebSearch" && typeof input["query"] === "string") {
		return { tool: "WebSearch", query: input["query"] };
	}
	if (
		input["tool"] === "Task" &&
		typeof input["description"] === "string" &&
		typeof input["prompt"] === "string"
	) {
		return {
			tool: "Task",
			description: input["description"],
			prompt: input["prompt"],
			...(typeof input["subagentType"] === "string"
				? { subagentType: input["subagentType"] }
				: {}),
		};
	}
	if (input["tool"] === "LSP" && typeof input["operation"] === "string") {
		return {
			tool: "LSP",
			operation: input["operation"],
			...(typeof input["filePath"] === "string"
				? { filePath: input["filePath"] }
				: {}),
		};
	}
	if (input["tool"] === "Skill" && typeof input["name"] === "string") {
		return { tool: "Skill", name: input["name"] };
	}
	if (input["tool"] === "AskUserQuestion") {
		return { tool: "AskUserQuestion", questions: input["questions"] };
	}
	if (
		input["tool"] === "Unknown" &&
		typeof input["name"] === "string" &&
		isRecord(input["raw"])
	) {
		return { tool: "Unknown", name: input["name"], raw: input["raw"] };
	}
	return undefined;
}

function dataRecord(event: ProviderRuntimeEvent): Record<string, unknown> {
	return isRecord(event.data) ? event.data : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFieldValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function providerRefsMetadata(
	refs: ProviderRuntimeEvent["providerRefs"],
): NonNullable<EventMetadata["providerRefs"]> {
	return {
		...(refs.providerSessionId
			? { providerSessionId: refs.providerSessionId }
			: {}),
		...(refs.providerMessageId
			? { providerMessageId: refs.providerMessageId }
			: {}),
		...(refs.providerTurnId ? { providerTurnId: refs.providerTurnId } : {}),
		...(refs.providerToolUseId
			? { providerToolUseId: refs.providerToolUseId }
			: {}),
		...(refs.providerRequestId
			? { providerRequestId: refs.providerRequestId }
			: {}),
		...(refs.providerTaskId ? { providerTaskId: refs.providerTaskId } : {}),
		...(refs.parentProviderTaskId
			? { parentProviderTaskId: refs.parentProviderTaskId }
			: {}),
	};
}

function requestId(
	event: ProviderRuntimeEvent,
	data: Record<string, unknown>,
): string {
	return (
		stringField(data["id"]) ??
		event.providerRefs.providerRequestId ??
		event.providerRefs.providerToolUseId ??
		event.eventId
	);
}

function permissionDecision(decision: string): PermissionDecision {
	const normalized = decision.trim().toLowerCase();
	if (normalized === "always") return "always";
	if (
		normalized === "once" ||
		normalized === "allow" ||
		normalized === "allowed"
	) {
		return "once";
	}
	return "reject";
}

function messageRole(value: unknown): MessageRole {
	return value === "user" ? "user" : "assistant";
}

function sessionStatus(value: unknown): SessionStatusValue {
	if (value === "busy" || value === "retry" || value === "error") return value;
	return "idle";
}

function tokensValue(value: unknown):
	| {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
	  }
	| undefined {
	if (!isRecord(value)) return undefined;
	const tokens: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	} = {};
	if (typeof value["input"] === "number") tokens.input = value["input"];
	if (typeof value["output"] === "number") tokens.output = value["output"];
	if (typeof value["cacheRead"] === "number")
		tokens.cacheRead = value["cacheRead"];
	if (typeof value["cacheWrite"] === "number")
		tokens.cacheWrite = value["cacheWrite"];
	return Object.keys(tokens).length > 0 ? tokens : undefined;
}

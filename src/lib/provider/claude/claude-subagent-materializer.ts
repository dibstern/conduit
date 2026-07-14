import { createHash } from "node:crypto";
import {
	getSubagentMessages,
	listSubagents,
	type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import type { ProviderRuntimeEvent } from "../../contracts/providers/provider-runtime-event.js";
import type { ClaudeEventPersistEffect } from "../../persistence/effect/claude-event-persist-effect.js";
import type {
	CanonicalEvent,
	CanonicalEventType,
	EventPayloadMap,
	MessageRole,
} from "../../persistence/events.js";
import {
	emptyProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "../provider-runtime-event-to-domain.js";
import { providerRefsFromRuntimeData } from "../provider-runtime-refs.js";
import { normalizeToolInput } from "./normalize-tool-input.js";

const PROVIDER = "claude" as const;

export interface ClaudeSubagentSdk {
	listSubagents(
		parentClaudeSessionId: string,
		options: { dir: string },
	): Promise<readonly string[]>;

	getSubagentMessages(
		parentClaudeSessionId: string,
		sdkSubagentId: string,
		options: { dir: string },
	): Promise<readonly SessionMessage[]>;
}

export interface MaterializeClaudeSubagentsInput {
	readonly parentConduitSessionId: string;
	readonly parentClaudeSessionId: string;
	readonly workspaceRoot: string;
	readonly knownTasks: ReadonlyMap<
		string,
		{
			readonly toolUseId: string;
			readonly description?: string;
			readonly subagentType?: string;
		}
	>;
}

export interface MaterializedClaudeSubagent {
	readonly sdkSubagentId: string;
	readonly childSessionId: string;
	readonly parentToolUseId?: string;
}

export interface ClaudeSubagentPersist {
	readonly persistClaudeSubagent: ClaudeEventPersistEffect["persistClaudeSubagent"];
}

export interface ClaudeSubagentTranscriptCursor {
	readonly messageRoles: Map<string, "user" | "assistant">;
	readonly textOffsets: Map<string, number>;
	readonly thinkingOffsets?: Map<string, number>;
	readonly toolStarts: Set<string>;
	readonly toolCompletions: Set<string>;
}

export interface ClaudeSubagentTranscriptStage {
	readonly events: ProviderRuntimeEvent[];
	readonly cursor: ClaudeSubagentTranscriptCursor;
}

type MutableClaudeSubagentTranscriptCursor = {
	messageRoles: Map<string, "user" | "assistant">;
	textOffsets: Map<string, number>;
	thinkingOffsets?: Map<string, number>;
	toolStarts: Set<string>;
	toolCompletions: Set<string>;
};

export const defaultClaudeSubagentSdk: ClaudeSubagentSdk = {
	listSubagents: (parentClaudeSessionId, options) =>
		listSubagents(parentClaudeSessionId, options),
	getSubagentMessages: (parentClaudeSessionId, sdkSubagentId, options) =>
		getSubagentMessages(parentClaudeSessionId, sdkSubagentId, options),
};

export function claudeSubagentSessionId(input: {
	readonly parentConduitSessionId: string;
	readonly parentClaudeSessionId: string;
	readonly sdkSubagentId: string;
}): string {
	const hash = createHash("sha256")
		.update(
			`${input.parentConduitSessionId}\0${input.parentClaudeSessionId}\0${input.sdkSubagentId}`,
		)
		.digest("hex")
		.slice(0, 24);
	return `claude-subagent-${hash}`;
}

export function makeClaudeSubagentMaterializer(deps: {
	readonly sdk: ClaudeSubagentSdk;
	readonly persist: ClaudeSubagentPersist;
}): (
	input: MaterializeClaudeSubagentsInput,
) => Effect.Effect<readonly MaterializedClaudeSubagent[], unknown> {
	return (input) =>
		Effect.gen(function* () {
			const subagentIds = yield* Effect.tryPromise({
				try: () =>
					deps.sdk.listSubagents(input.parentClaudeSessionId, {
						dir: input.workspaceRoot,
					}),
				catch: (cause) => cause,
			});
			const materialized: MaterializedClaudeSubagent[] = [];

			for (const sdkSubagentId of subagentIds) {
				const task = input.knownTasks.get(sdkSubagentId);
				const childSessionId = claudeSubagentSessionId({
					parentConduitSessionId: input.parentConduitSessionId,
					parentClaudeSessionId: input.parentClaudeSessionId,
					sdkSubagentId,
				});
				const messages = yield* Effect.tryPromise({
					try: () =>
						deps.sdk.getSubagentMessages(
							input.parentClaudeSessionId,
							sdkSubagentId,
							{ dir: input.workspaceRoot },
						),
					catch: (cause) => cause,
				});
				const title = task?.subagentType
					? `${capitalize(task.subagentType)} Agent`
					: "Claude Subagent";

				yield* deps.persist.persistClaudeSubagent({
					childSessionId,
					parentSessionId: input.parentConduitSessionId,
					providerSessionId: sdkSubagentId,
					title,
					events: sessionMessagesToEvents(childSessionId, messages),
				});

				materialized.push({
					sdkSubagentId,
					childSessionId,
					...(task ? { parentToolUseId: task.toolUseId } : {}),
				});
			}

			return materialized;
		});
}

function capitalize(value: string): string {
	if (value.length === 0) return value;
	return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function sessionMessagesToEvents(
	sessionId: string,
	messages: readonly SessionMessage[],
): CanonicalEvent[] {
	return diffSessionMessagesToEvents({
		childSessionId: sessionId,
		messages,
		cursor: createClaudeSubagentTranscriptCursor(),
	});
}

function createClaudeSubagentTranscriptCursor(): ClaudeSubagentTranscriptCursor {
	return {
		messageRoles: new Map(),
		textOffsets: new Map(),
		thinkingOffsets: new Map(),
		toolStarts: new Set(),
		toolCompletions: new Set(),
	};
}

export function cloneClaudeSubagentTranscriptCursor(
	cursor: ClaudeSubagentTranscriptCursor,
): ClaudeSubagentTranscriptCursor {
	return {
		messageRoles: new Map(cursor.messageRoles),
		textOffsets: new Map(cursor.textOffsets),
		thinkingOffsets: new Map(cursor.thinkingOffsets ?? []),
		toolStarts: new Set(cursor.toolStarts),
		toolCompletions: new Set(cursor.toolCompletions),
	};
}

/**
 * Live pollers should use stageSessionMessagesToEvents(), persist the emitted
 * events, then commit the staged cursor only after persistence succeeds.
 */
export function commitClaudeSubagentTranscriptCursor(
	target: ClaudeSubagentTranscriptCursor,
	source: ClaudeSubagentTranscriptCursor,
): void {
	if (target === source) return;
	replaceMap(target.messageRoles, source.messageRoles);
	replaceMap(target.textOffsets, source.textOffsets);
	replaceMap(getThinkingOffsets(target), getThinkingOffsets(source));
	replaceSet(target.toolStarts, source.toolStarts);
	replaceSet(target.toolCompletions, source.toolCompletions);
}

export function diffSessionMessagesToEvents(input: {
	readonly childSessionId: string;
	readonly messages: readonly SessionMessage[];
	readonly cursor: ClaudeSubagentTranscriptCursor;
}): CanonicalEvent[] {
	const stage = stageSessionMessagesToEvents(input);
	commitClaudeSubagentTranscriptCursor(input.cursor, stage.cursor);
	return runtimeEventsToDomain(stage.events);
}

function runtimeEventsToDomain(
	events: readonly ProviderRuntimeEvent[],
): CanonicalEvent[] {
	// Offline transcript materialization: these runtime-shaped events are staged
	// from already-fetched child-session messages, not live provider output.
	let state = emptyProviderRuntimeDomainMapperState;
	const domainEvents: CanonicalEvent[] = [];
	for (const event of events) {
		const result = translateProviderRuntimeEventToDomain(event, state);
		domainEvents.push(...result.events);
		state = result.state;
	}
	return domainEvents;
}

function providerRuntimeEvent<K extends CanonicalEventType>(
	type: K,
	sessionId: string,
	data: EventPayloadMap[K],
	options: { readonly provider?: typeof PROVIDER; readonly createdAt: number },
): ProviderRuntimeEvent {
	return {
		eventId: `evt_${createHash("sha256")
			.update(
				`${sessionId}:${type}:${options.createdAt}:${JSON.stringify(data)}`,
			)
			.digest("hex")
			.slice(0, 24)}`,
		type,
		providerId: options.provider ?? PROVIDER,
		sessionId,
		providerRefs: providerRefsFromRuntimeData(type, data),
		rawSource: { kind: "claude.subagent.transcript" },
		createdAt: options.createdAt,
		data,
	};
}

export function stageSessionMessagesToEvents(input: {
	readonly childSessionId: string;
	readonly messages: readonly SessionMessage[];
	readonly cursor: ClaudeSubagentTranscriptCursor;
}): ClaudeSubagentTranscriptStage {
	const events: ProviderRuntimeEvent[] = [];
	const cursor = cloneClaudeSubagentTranscriptCursor(input.cursor);
	const toolMessageIds = new Map<string, string>();
	const baseCreatedAt = Date.now();
	let eventIndex = 0;
	const eventOptions = () => ({
		provider: PROVIDER,
		createdAt: baseCreatedAt + eventIndex++,
	});

	for (const message of input.messages) {
		if (message.type !== "user" && message.type !== "assistant") continue;
		const role: MessageRole = message.type;
		const messageId = message.uuid;
		const content = readContent(message.message);
		if (
			shouldCreateTranscriptMessage(role, content) &&
			!cursor.messageRoles.has(messageId)
		) {
			cursor.messageRoles.set(messageId, role);
			events.push(
				providerRuntimeEvent(
					"message.created",
					input.childSessionId,
					{ messageId, role, sessionId: input.childSessionId },
					eventOptions(),
				),
			);
		}

		for (const [index, block] of content.entries()) {
			appendContentBlockEvents({
				events,
				sessionId: input.childSessionId,
				messageId,
				block,
				index,
				cursor,
				toolMessageIds,
				eventOptions,
			});
		}
	}

	return { events, cursor };
}

function readContent(message: unknown): readonly unknown[] {
	if (!isRecord(message) || !("content" in message)) return [];
	const content = message["content"];
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content;
	return [];
}

function shouldCreateTranscriptMessage(
	role: MessageRole,
	content: readonly unknown[],
): boolean {
	if (role === "assistant") return true;
	return content.some(
		(block) =>
			isRecord(block) &&
			block["type"] === "text" &&
			typeof block["text"] === "string" &&
			block["text"].length > 0,
	);
}

function appendContentBlockEvents(input: {
	readonly events: ProviderRuntimeEvent[];
	readonly sessionId: string;
	readonly messageId: string;
	readonly block: unknown;
	readonly index: number;
	readonly cursor: ClaudeSubagentTranscriptCursor;
	readonly toolMessageIds: Map<string, string>;
	readonly eventOptions: () => { provider: typeof PROVIDER; createdAt: number };
}): void {
	if (!isRecord(input.block)) return;
	const type = input.block["type"];

	if (type === "text" && typeof input.block["text"] === "string") {
		const offsetKey = `${input.messageId}:${input.index}`;
		const previousOffset = input.cursor.textOffsets.get(offsetKey);
		const text = input.block["text"];
		if (previousOffset === undefined || text.length > previousOffset) {
			input.events.push(
				providerRuntimeEvent(
					"text.delta",
					input.sessionId,
					{
						messageId: input.messageId,
						partId: `${input.messageId}-${input.index}`,
						text: text.slice(previousOffset ?? 0),
					},
					input.eventOptions(),
				),
			);
		}
		input.cursor.textOffsets.set(
			offsetKey,
			Math.max(previousOffset ?? 0, text.length),
		);
		return;
	}

	if (type === "thinking" && typeof input.block["thinking"] === "string") {
		const partId = `${input.messageId}-${input.index}`;
		const offsetKey = `${input.messageId}:${input.index}`;
		const thinkingOffsets = getThinkingOffsets(input.cursor);
		const previousOffset = thinkingOffsets.get(offsetKey);
		const text = input.block["thinking"];
		if (previousOffset === undefined) {
			input.events.push(
				providerRuntimeEvent(
					"thinking.start",
					input.sessionId,
					{ messageId: input.messageId, partId },
					input.eventOptions(),
				),
			);
			input.events.push(
				providerRuntimeEvent(
					"thinking.delta",
					input.sessionId,
					{ messageId: input.messageId, partId, text },
					input.eventOptions(),
				),
			);
			input.events.push(
				providerRuntimeEvent(
					"thinking.end",
					input.sessionId,
					{ messageId: input.messageId, partId },
					input.eventOptions(),
				),
			);
		}
		thinkingOffsets.set(offsetKey, Math.max(previousOffset ?? 0, text.length));
		return;
	}

	if (
		type === "tool_use" ||
		type === "server_tool_use" ||
		type === "mcp_tool_use"
	) {
		const partId =
			typeof input.block["id"] === "string"
				? input.block["id"]
				: `${input.messageId}-${input.index}`;
		const toolName =
			typeof input.block["name"] === "string" ? input.block["name"] : "unknown";
		const normalizedInput = normalizeToolInput(toolName, input.block["input"]);
		input.toolMessageIds.set(partId, input.messageId);
		if (input.cursor.toolStarts.has(partId)) return;
		input.cursor.toolStarts.add(partId);
		input.events.push(
			providerRuntimeEvent(
				"tool.started",
				input.sessionId,
				{
					messageId: input.messageId,
					partId,
					toolName:
						normalizedInput &&
						typeof normalizedInput === "object" &&
						"tool" in normalizedInput &&
						normalizedInput.tool === "Task"
							? "Task"
							: toolName,
					callId: partId,
					input: normalizedInput,
				},
				input.eventOptions(),
			),
		);
		return;
	}

	if (
		type === "tool_result" &&
		typeof input.block["tool_use_id"] === "string"
	) {
		const partId = input.block["tool_use_id"];
		if (input.cursor.toolCompletions.has(partId)) return;
		input.cursor.toolCompletions.add(partId);
		input.events.push(
			providerRuntimeEvent(
				"tool.completed",
				input.sessionId,
				{
					messageId: input.toolMessageIds.get(partId) ?? input.messageId,
					partId,
					result: readToolResultContent(input.block["content"]),
					duration: 0,
				},
				input.eventOptions(),
			),
		);
	}
}

function readToolResultContent(value: unknown): unknown {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((item) =>
				isRecord(item) && typeof item["text"] === "string" ? item["text"] : "",
			)
			.filter((text) => text.length > 0)
			.join("\n");
	}
	return value ?? null;
}

function getThinkingOffsets(
	cursor: ClaudeSubagentTranscriptCursor,
): Map<string, number> {
	const mutable = cursor as MutableClaudeSubagentTranscriptCursor;
	mutable.thinkingOffsets ??= new Map();
	return mutable.thinkingOffsets;
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
	if (target === source) return;
	target.clear();
	for (const [key, value] of source) {
		target.set(key, value);
	}
}

function replaceSet<T>(target: Set<T>, source: Set<T>): void {
	if (target === source) return;
	target.clear();
	for (const value of source) {
		target.add(value);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

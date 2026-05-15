import { createHash } from "node:crypto";
import {
	getSubagentMessages,
	listSubagents,
	type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import type { ClaudeEventPersistEffect } from "../../persistence/effect/claude-event-persist-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	type MessageRole,
} from "../../persistence/events.js";

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
	const events: CanonicalEvent[] = [];
	const toolMessageIds = new Map<string, string>();

	for (const message of messages) {
		if (message.type !== "user" && message.type !== "assistant") continue;
		const role: MessageRole = message.type;
		const messageId = message.uuid;
		events.push(
			canonicalEvent(
				"message.created",
				sessionId,
				{ messageId, role, sessionId },
				{ provider: PROVIDER },
			),
		);

		const content = readContent(message.message);
		for (const [index, block] of content.entries()) {
			appendContentBlockEvents({
				events,
				sessionId,
				messageId,
				block,
				index,
				toolMessageIds,
			});
		}
	}

	return events;
}

function readContent(message: unknown): readonly unknown[] {
	if (!isRecord(message) || !("content" in message)) return [];
	const content = message["content"];
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content;
	return [];
}

function appendContentBlockEvents(input: {
	readonly events: CanonicalEvent[];
	readonly sessionId: string;
	readonly messageId: string;
	readonly block: unknown;
	readonly index: number;
	readonly toolMessageIds: Map<string, string>;
}): void {
	if (!isRecord(input.block)) return;
	const type = input.block["type"];

	if (type === "text" && typeof input.block["text"] === "string") {
		input.events.push(
			canonicalEvent(
				"text.delta",
				input.sessionId,
				{
					messageId: input.messageId,
					partId: `${input.messageId}-${input.index}`,
					text: input.block["text"],
				},
				{ provider: PROVIDER },
			),
		);
		return;
	}

	if (type === "thinking" && typeof input.block["thinking"] === "string") {
		const partId = `${input.messageId}-${input.index}`;
		input.events.push(
			canonicalEvent(
				"thinking.start",
				input.sessionId,
				{ messageId: input.messageId, partId },
				{ provider: PROVIDER },
			),
			canonicalEvent(
				"thinking.delta",
				input.sessionId,
				{ messageId: input.messageId, partId, text: input.block["thinking"] },
				{ provider: PROVIDER },
			),
			canonicalEvent(
				"thinking.end",
				input.sessionId,
				{ messageId: input.messageId, partId },
				{ provider: PROVIDER },
			),
		);
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
		input.toolMessageIds.set(partId, input.messageId);
		input.events.push(
			canonicalEvent(
				"tool.started",
				input.sessionId,
				{
					messageId: input.messageId,
					partId,
					toolName,
					callId: partId,
					input: isRecord(input.block["input"]) ? input.block["input"] : {},
				},
				{ provider: PROVIDER },
			),
		);
		return;
	}

	if (
		type === "tool_result" &&
		typeof input.block["tool_use_id"] === "string"
	) {
		const partId = input.block["tool_use_id"];
		input.events.push(
			canonicalEvent(
				"tool.completed",
				input.sessionId,
				{
					messageId: input.toolMessageIds.get(partId) ?? input.messageId,
					partId,
					result: readToolResultContent(input.block["content"]),
					duration: 0,
				},
				{ provider: PROVIDER },
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

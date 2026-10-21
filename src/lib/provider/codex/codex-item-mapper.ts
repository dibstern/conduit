import { createHash } from "node:crypto";
import type {
	ProviderRuntimeEvent,
	ProviderRuntimeEventPayloadMap,
	ProviderRuntimeEventType,
} from "../../contracts/providers/provider-runtime-event.js";
import type { CanonicalToolInput } from "../../contracts/stored-event.js";
import type { TurnTokens } from "../types.js";
import type {
	KnownNotification,
	ThreadItemSchema,
	TokenUsageBreakdownSchema,
} from "./app-server/protocol.js";

type ToolPart = {
	readonly kind: "tool";
	readonly id: string;
	readonly itemId: string;
	readonly toolName: string;
	readonly input: CanonicalToolInput;
	readonly result: unknown;
	readonly metadata: Record<string, unknown>;
	readonly duration: number;
	readonly output: string;
	readonly lastOutputAt?: number;
	readonly closed: boolean;
};

type ContentPart =
	| {
			readonly kind: "text";
			readonly id: string;
			readonly itemId: string;
			readonly text: string;
			readonly closed: boolean;
	  }
	| {
			readonly kind: "thinking";
			readonly id: string;
			readonly itemId: string;
			/** Codex streams summaries and raw reasoning as separately indexed parts. */
			readonly stream: "summary" | "content";
			readonly index: number;
			readonly text: string;
			readonly closed: boolean;
	  }
	| ToolPart;

/** Bound output by UTF-8 bytes, without cutting a multibyte character. */
function outputTail(output: string): string {
	const bytes = Buffer.from(output);
	let start = Math.max(0, bytes.length - 64 * 1024);
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

function toolForItem(
	item: typeof ThreadItemSchema.Type,
	output: string,
	sessionId: string,
): Pick<ToolPart, "toolName" | "input" | "result" | "metadata" | "duration"> {
	const generic = (raw: unknown) => ({
		toolName: item.type,
		input: { tool: "Unknown", name: item.type, raw: { item: raw } } as const,
		result: raw,
		metadata: {},
		duration: 0,
	});
	if ("raw" in item) return generic(item.raw);
	const metadata: Record<string, unknown> =
		"status" in item
			? { isError: item.status === "failed" || item.status === "declined" }
			: {};
	const duration = "durationMs" in item ? (item.durationMs ?? 0) : 0;
	switch (item.type) {
		case "commandExecution": {
			const finalOutput = item.aggregatedOutput ?? output;
			const exitCode = item.exitCode ?? null;
			return {
				toolName: "Bash",
				input: {
					tool: "Bash",
					command: item.command,
					workingDirectory: item.cwd,
				},
				result: finalOutput,
				metadata: {
					...metadata,
					output: outputTail(finalOutput),
					exitCode,
					isError:
						metadata["isError"] === true ||
						(exitCode !== null && exitCode !== 0),
				},
				duration,
			};
		}
		case "fileChange":
			return {
				toolName: "Patch",
				input: {
					tool: "Patch",
					patch: item.changes.map(({ diff }) => diff).join("\n"),
					filePaths: item.changes.map(({ path }) => path),
				},
				result: item.changes,
				metadata: { ...metadata, ...(output ? { output } : {}) },
				duration,
			};
		case "mcpToolCall": {
			const name = `mcp__${item.server}__${item.tool}`;
			return {
				toolName: name,
				input: {
					tool: "Unknown",
					name,
					raw:
						typeof item.arguments === "object" &&
						item.arguments !== null &&
						!Array.isArray(item.arguments)
							? (item.arguments as Record<string, unknown>)
							: { arguments: item.arguments },
				},
				result: item.error ?? item.result ?? null,
				metadata: {
					...metadata,
					isError: metadata["isError"] === true || item.error != null,
				},
				duration,
			};
		}
		case "webSearch":
			return {
				toolName: "WebSearch",
				input: { tool: "WebSearch", query: item.query },
				result: item.results ?? null,
				metadata,
				duration,
			};
		case "imageView":
			return {
				toolName: "Read",
				input: { tool: "Read", filePath: item.path },
				result: null,
				metadata,
				duration,
			};
		case "collabAgentToolCall":
			return {
				toolName: "Task",
				input: {
					tool: "Task",
					description:
						item.prompt?.split("\n")[0]?.slice(0, 100) || "Codex subagent",
					prompt: item.prompt ?? "",
					subagentType: "Codex",
				},
				result: Object.values(item.agentsStates)
					.map(({ message }) => message)
					.filter(Boolean)
					.join("\n"),
				metadata: {
					...metadata,
					...(item.receiverThreadIds[0]
						? {
								childSessionId: codexSubagentSessionId(
									sessionId,
									item.receiverThreadIds[0],
								),
							}
						: {}),
					...(item.model ? { subagentModel: item.model } : {}),
					backgrounded: true,
				},
				duration,
			};
		default:
			return generic(item);
	}
}

export function codexSubagentSessionId(
	parentSessionId: string,
	threadId: string,
): string {
	return `codex-subagent-${createHash("sha256").update(`${parentSessionId}\0${threadId}`).digest("hex").slice(0, 24)}`;
}

function toolCompletion(
	part: ToolPart,
	messageId: string,
): ProviderRuntimeEventPayloadMap["tool.completed"] {
	return {
		messageId,
		partId: part.id,
		input: part.input,
		result: part.result,
		metadata: part.metadata,
		duration: part.duration,
	};
}

export interface CodexItemState {
	readonly sessionId: string;
	readonly turnId: string;
	readonly messageId: string;
	readonly providerId: string;
	readonly threadId: string;
	readonly nativeTurnId?: string | undefined;
	readonly now: number;
	readonly sequence: number;
	readonly parts: readonly ContentPart[];
	readonly tokens: TurnTokens;
	readonly tokenUsageBaseline?:
		| typeof TokenUsageBreakdownSchema.Type
		| undefined;
	readonly tokenUsageTotal?: typeof TokenUsageBreakdownSchema.Type | undefined;
	readonly contextTokens?: number | undefined;
}

/** Inputs carry the clock and identities, so replay has no I/O or hidden state. */
export function mapCodexItem(
	state: CodexItemState,
	notification: KnownNotification,
): readonly [CodexItemState, ProviderRuntimeEvent[]] {
	let next = { ...state, parts: [...state.parts] };
	const events: ProviderRuntimeEvent[] = [];
	const emit = <
		K extends Exclude<ProviderRuntimeEventType, "workspace.changed">,
	>(
		type: K,
		data: ProviderRuntimeEventPayloadMap[K],
		itemId?: string,
	) => {
		const [updated, event] = codexRuntimeEvent(next, type, data, itemId);
		next = { ...updated, parts: [...updated.parts] };
		events.push(event);
	};
	const text = (itemId: string, value: string, complete: boolean) => {
		let index = next.parts.findIndex(
			(part) => part.kind === "text" && part.itemId === itemId,
		);
		if (index < 0) {
			index = next.parts.length;
			next.parts.push({
				kind: "text",
				id: `${state.messageId}:text:${itemId}`,
				itemId,
				text: "",
				closed: false,
			});
		}
		const part = next.parts[index];
		if (!part || part.kind !== "text" || part.closed) return;
		const finalText = complete ? value : part.text + value;
		next.parts[index] = { ...part, text: finalText, closed: complete };
		if (finalText.startsWith(part.text)) {
			const suffix = finalText.slice(part.text.length);
			if (suffix)
				emit(
					"text.delta",
					{ messageId: state.messageId, partId: part.id, text: suffix },
					itemId,
				);
		} else {
			// A replacement cannot be represented by an append. Preserve all other
			// parts in the authoritative snapshot, as Cursor does for corrections.
			const message = codexMessageSnapshot(next);
			emit(
				"message.snapshot",
				{
					messageId: state.messageId,
					digest: createHash("sha256")
						.update(JSON.stringify(message))
						.digest("hex"),
					message,
				},
				itemId,
			);
		}
	};
	const thinking = (
		itemId: string,
		stream: "summary" | "content",
		streamIndex: number,
		value: string,
		complete: boolean,
	) => {
		let index = next.parts.findIndex(
			(part) =>
				part.kind === "thinking" &&
				part.itemId === itemId &&
				part.stream === stream &&
				part.index === streamIndex,
		);
		if (index < 0) {
			index = next.parts.length;
			const id = `${state.messageId}:${stream === "summary" ? "thinking" : "reasoning"}:${itemId}:${streamIndex}`;
			next.parts.push({
				kind: "thinking",
				id,
				itemId,
				stream,
				index: streamIndex,
				text: "",
				closed: false,
			});
			emit(
				"thinking.start",
				{ messageId: state.messageId, partId: id },
				itemId,
			);
		}
		const part = next.parts[index];
		if (!part || part.kind !== "thinking" || part.closed) return;
		const finalText = complete ? value : part.text + value;
		next.parts[index] = { ...part, text: finalText, closed: complete };
		if (finalText.startsWith(part.text)) {
			const suffix = finalText.slice(part.text.length);
			if (suffix)
				emit(
					"thinking.delta",
					{ messageId: state.messageId, partId: part.id, text: suffix },
					itemId,
				);
		} else {
			const message = codexMessageSnapshot(next);
			emit(
				"message.snapshot",
				{
					messageId: state.messageId,
					digest: createHash("sha256")
						.update(JSON.stringify(message))
						.digest("hex"),
					message,
				},
				itemId,
			);
		}
		if (complete)
			emit(
				"thinking.end",
				{ messageId: state.messageId, partId: part.id },
				itemId,
			);
	};
	const closeItem = (itemId: string) => {
		for (let index = 0; index < next.parts.length; index++) {
			const part = next.parts[index];
			if (!part || part.itemId !== itemId || part.closed) continue;
			next.parts[index] = { ...part, closed: true };
			if (part.kind === "thinking")
				emit(
					"thinking.end",
					{ messageId: state.messageId, partId: part.id },
					itemId,
				);
			if (part.kind === "tool")
				emit("tool.completed", toolCompletion(part, state.messageId), itemId);
		}
	};
	switch (notification.method) {
		case "item/agentMessage/delta": {
			const { itemId, delta } = notification.params;
			text(itemId, delta, false);
			break;
		}
		case "item/plan/delta": {
			const { itemId, delta } = notification.params;
			text(itemId, delta, false);
			break;
		}
		case "item/commandExecution/outputDelta":
		case "item/fileChange/outputDelta": {
			const { itemId, delta } = notification.params;
			const index = next.parts.findIndex(
				(part) => part.kind === "tool" && part.itemId === itemId,
			);
			const part = next.parts[index];
			if (!part || part.kind !== "tool" || part.closed) break;
			const output = outputTail(part.output + delta);
			const publish =
				part.lastOutputAt === undefined || state.now - part.lastOutputAt >= 250;
			next.parts[index] = {
				...part,
				output,
				result: part.input.tool === "Bash" ? output : part.result,
				metadata: { ...part.metadata, output },
				...(publish ? { lastOutputAt: state.now } : {}),
			};
			if (publish)
				emit(
					"tool.running",
					{ messageId: state.messageId, partId: part.id, metadata: { output } },
					itemId,
				);
			break;
		}
		case "turn/plan/updated": {
			const { turnId, plan } = notification.params;
			const itemId = `plan:${turnId}`;
			const input: CanonicalToolInput = {
				tool: "Unknown",
				name: "TodoWrite",
				raw: {
					todos: plan.map(({ step, status }) => ({
						content: step,
						status: status === "inProgress" ? "in_progress" : status,
					})),
				},
			};
			const index = next.parts.findIndex(
				(part) => part.kind === "tool" && part.itemId === itemId,
			);
			const result = input.raw;
			if (index < 0) {
				const id = `${state.messageId}:tool:${itemId}`;
				next.parts.push({
					kind: "tool",
					id,
					itemId,
					toolName: "TodoWrite",
					input,
					result,
					metadata: {},
					duration: 0,
					output: "",
					closed: true,
				});
				emit(
					"tool.started",
					{
						messageId: state.messageId,
						partId: id,
						callId: itemId,
						toolName: "TodoWrite",
						input,
					},
					itemId,
				);
			} else {
				const part = next.parts[index];
				if (part?.kind !== "tool") break;
				next.parts[index] = { ...part, input, result };
			}
			// Updating the plan is synchronous. Each version is complete, so the
			// todo read model can publish it while the surrounding turn continues.
			emit(
				"tool.completed",
				{
					messageId: state.messageId,
					partId: `${state.messageId}:tool:${itemId}`,
					input,
					result,
					duration: 0,
				},
				itemId,
			);
			break;
		}
		case "item/reasoning/summaryPartAdded": {
			const { itemId, summaryIndex } = notification.params;
			thinking(itemId, "summary", summaryIndex, "", false);
			break;
		}
		case "item/reasoning/summaryTextDelta": {
			const { itemId, summaryIndex, delta } = notification.params;
			thinking(itemId, "summary", summaryIndex, delta, false);
			break;
		}
		case "item/reasoning/textDelta": {
			const { itemId, contentIndex, delta } = notification.params;
			thinking(itemId, "content", contentIndex, delta, false);
			break;
		}
		case "item/started":
		case "item/completed": {
			const { item } = notification.params;
			const complete = notification.method === "item/completed";
			if (
				!("raw" in item) &&
				(item.type === "subAgentActivity" ||
					(item.type === "collabAgentToolCall" && item.tool !== "spawnAgent"))
			)
				break;
			// Conduit already stored the prompt when it admitted the input.
			if (item.type === "userMessage" && !("raw" in item)) break;
			if (
				(item.type === "agentMessage" || item.type === "plan") &&
				"text" in item
			) {
				if (complete) text(item.id, item.text, true);
				if (
					complete &&
					item.type === "agentMessage" &&
					item.delivery === "async" &&
					item.questions?.length &&
					!next.parts.some(
						(part) => part.kind === "tool" && part.itemId === item.id,
					)
				) {
					const questions = item.questions.map(({ title, options }) => ({
						question: title,
						header: "",
						options: (options ?? []).map((label) => ({ label })),
						multiSelect: false,
						custom: true,
					}));
					const part: ToolPart = {
						kind: "tool",
						id: `${state.messageId}:tool:${item.id}`,
						itemId: item.id,
						toolName: "AskUserQuestion",
						input: { tool: "AskUserQuestion", delivery: "async", questions },
						result: null,
						metadata: {},
						duration: 0,
						output: "",
						closed: true,
					};
					next.parts.push(part);
					emit(
						"tool.started",
						{
							messageId: state.messageId,
							partId: part.id,
							callId: item.id,
							toolName: part.toolName,
							input: part.input,
						},
						item.id,
					);
					emit(
						"tool.completed",
						toolCompletion(part, state.messageId),
						item.id,
					);
					emit(
						"question.asked",
						{
							id: item.id,
							sessionId: state.sessionId,
							toolUseId: item.id,
							providerId: state.providerId,
							delivery: "async",
							messageId: state.messageId,
							partId: part.id,
							questions,
						},
						item.id,
					);
				}
			} else if (item.type === "reasoning" && "summary" in item) {
				if (complete) {
					item.summary.forEach((value, index) => {
						thinking(item.id, "summary", index, value, true);
					});
					item.content.forEach((value, index) => {
						thinking(item.id, "content", index, value, true);
					});
					closeItem(item.id);
				}
			} else {
				let index = next.parts.findIndex(
					(part) => part.itemId === item.id && part.kind === "tool",
				);
				const previous = next.parts[index];
				const tool = toolForItem(
					item,
					previous?.kind === "tool" ? previous.output : "",
					state.sessionId,
				);
				if (index < 0) {
					index = next.parts.length;
					const id = `${state.messageId}:tool:${item.id}`;
					next.parts.push({
						kind: "tool",
						id,
						itemId: item.id,
						...tool,
						output: "",
						closed: false,
					});
					emit(
						"tool.started",
						{
							messageId: state.messageId,
							partId: id,
							callId: item.id,
							toolName: tool.toolName,
							input: tool.input,
						},
						item.id,
					);
				}
				const part = next.parts[index];
				if (part?.kind === "tool" && !part.closed)
					next.parts[index] = { ...part, ...tool };
				if (item.type === "collabAgentToolCall" && !("raw" in item)) {
					emit(
						"tool.running",
						{
							messageId: state.messageId,
							partId: `${state.messageId}:tool:${item.id}`,
							metadata: tool.metadata,
						},
						item.id,
					);
				} else if (complete) closeItem(item.id);
			}
			break;
		}
		case "thread/tokenUsage/updated": {
			const { total, last, modelContextWindow } =
				notification.params.tokenUsage;
			const before = next.tokenUsageBaseline;
			const input = Math.max(0, total.inputTokens - (before?.inputTokens ?? 0));
			const cacheRead = Math.max(
				0,
				total.cachedInputTokens - (before?.cachedInputTokens ?? 0),
			);
			const cacheWrite = Math.max(
				0,
				total.cacheWriteInputTokens - (before?.cacheWriteInputTokens ?? 0),
			);
			next = {
				...next,
				tokenUsageTotal: total,
				contextTokens: last.inputTokens,
				tokens: {
					input: Math.max(0, input - cacheRead - cacheWrite),
					output: Math.max(0, total.outputTokens - (before?.outputTokens ?? 0)),
					cacheRead,
					cacheWrite,
					reasoning: Math.max(
						0,
						total.reasoningOutputTokens - (before?.reasoningOutputTokens ?? 0),
					),
					...(modelContextWindow !== null
						? { contextWindow: modelContextWindow }
						: {}),
				},
			};
			break;
		}
	}
	return [next, events];
}

export function settleCodexItems(
	state: CodexItemState,
): readonly [CodexItemState, ProviderRuntimeEvent[]] {
	let next = state;
	const events: ProviderRuntimeEvent[] = [];
	const parts: ContentPart[] = [];
	for (const part of state.parts) {
		if (part.kind === "tool" && part.metadata["childSessionId"]) {
			parts.push(part);
			continue;
		}
		parts.push({ ...part, closed: true });
		if (part.closed || part.kind === "text") continue;
		const [updated, event] =
			part.kind === "thinking"
				? codexRuntimeEvent(
						next,
						"thinking.end",
						{ messageId: state.messageId, partId: part.id },
						part.itemId,
					)
				: codexRuntimeEvent(
						next,
						"tool.completed",
						toolCompletion(part, state.messageId),
						part.itemId,
					);
		next = updated;
		events.push(event);
	}
	return [{ ...next, parts }, events];
}

export function codexRuntimeEvent<
	K extends Exclude<ProviderRuntimeEventType, "workspace.changed">,
>(
	state: CodexItemState,
	type: K,
	data: ProviderRuntimeEventPayloadMap[K],
	itemId?: string,
): readonly [CodexItemState, ProviderRuntimeEvent] {
	const sequence = state.sequence + 1;
	return [
		{ ...state, sequence },
		{
			eventId: `${state.messageId}:codex:${sequence}`,
			type,
			providerId: state.providerId,
			sessionId: state.sessionId,
			turnId: state.turnId,
			providerRefs: {
				providerSessionId: state.threadId,
				providerMessageId: state.messageId,
				...(state.nativeTurnId ? { providerTurnId: state.nativeTurnId } : {}),
				...(itemId ? { providerToolUseId: itemId } : {}),
			},
			rawSource: { kind: "codex.app-server.translator" },
			createdAt: state.now,
			data,
		},
	];
}

/** A goal-held conduit turn can acquire several native IDs without text. */
export function recordCodexTurnRefs(state: CodexItemState, completed = false) {
	let next = state;
	const events: ProviderRuntimeEvent[] = [];
	for (const [messageId, role] of [
		[state.turnId, "user"],
		[state.messageId, "assistant"],
	] as const) {
		const [items, event] = codexRuntimeEvent(next, "message.created", {
			sessionId: state.sessionId,
			messageId,
			role,
		});
		next = items;
		events.push({
			...event,
			providerRefs: { ...event.providerRefs, providerMessageId: messageId },
			metadata: {
				source: completed ? "codex.native-turn.completed" : "codex.native-turn",
			},
		});
	}
	return { items: next, events };
}

function codexMessageSnapshot(
	state: CodexItemState,
): ProviderRuntimeEventPayloadMap["message.snapshot"]["message"] {
	return {
		id: state.messageId,
		sessionID: state.sessionId,
		role: "assistant",
		parts: state.parts.map((part) =>
			part.kind === "tool"
				? {
						id: part.id,
						type: "tool",
						tool: part.toolName,
						callID: part.itemId,
						state: {
							status: part.closed ? "completed" : "running",
							input: part.input,
							output:
								typeof part.result === "string"
									? part.result
									: JSON.stringify(part.result),
							metadata: part.metadata,
						},
					}
				: { id: part.id, type: part.kind, text: part.text },
		),
	};
}

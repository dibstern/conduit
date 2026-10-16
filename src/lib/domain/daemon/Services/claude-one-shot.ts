import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { Data, Effect, Schema } from "effect";
import {
	type ClaudeConfigDir,
	makeClaudeSdkEnv,
} from "../../../provider/claude/claude-sdk-env.js";

export type ClaudeOneShotQueryFactory = (params: {
	readonly prompt: string;
	readonly options?: SDKOptions;
}) => AsyncIterable<unknown>;

export class ClaudeOneShotFailure extends Data.TaggedError(
	"ClaudeOneShotFailure",
)<{
	readonly reason: "query" | "empty" | "schema";
	readonly cause?: unknown;
}> {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractTextContent(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const texts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			texts.push(block);
			continue;
		}
		if (!isRecord(block)) continue;
		const text = block["text"];
		if (typeof text === "string") {
			texts.push(text);
		}
	}
	return texts;
}

function extractAssistantMessageText(
	message: Record<string, unknown>,
): string[] {
	const sdkMessage = message["message"];
	if (!isRecord(sdkMessage)) return [];
	return extractTextContent(sdkMessage["content"]);
}

function extractStreamEventText(event: unknown): string | undefined {
	if (!isRecord(event)) return undefined;
	if (event["type"] === "content_block_delta") {
		const delta = event["delta"];
		if (!isRecord(delta)) return undefined;
		const text = delta["text"];
		return typeof text === "string" ? text : undefined;
	}
	if (event["type"] === "content_block_start") {
		const contentBlock = event["content_block"];
		if (!isRecord(contentBlock)) return undefined;
		const text = contentBlock["text"];
		return typeof text === "string" ? text : undefined;
	}
	return undefined;
}

async function collectGeneratedText(
	query: AsyncIterable<unknown>,
): Promise<string | undefined> {
	const assistantTexts: string[] = [];
	const partialTexts: string[] = [];
	const resultTexts: string[] = [];

	for await (const message of query) {
		if (!isRecord(message)) continue;

		switch (message["type"]) {
			case "assistant":
				assistantTexts.push(...extractAssistantMessageText(message));
				break;
			case "stream_event": {
				const text = extractStreamEventText(message["event"]);
				if (text) partialTexts.push(text);
				break;
			}
			case "result": {
				const result = message["result"];
				if (typeof result === "string") resultTexts.push(result);
				break;
			}
		}
	}

	const assistantText = assistantTexts.join("\n").trim();
	if (assistantText) return assistantText;

	const resultText = resultTexts.join("\n").trim();
	if (resultText) return resultText;

	const partialText = partialTexts.join("").trim();
	return partialText || undefined;
}

/** Callers own their prompt, model, timeout and failure policy. */
export const makeClaudeOneShot = (options: {
	readonly configDir: ClaudeConfigDir;
	readonly cwd: string;
	readonly systemPrompt: string;
	readonly onStderr?: (data: string) => void;
	readonly queryFactory?: ClaudeOneShotQueryFactory;
}) => {
	const queryFactory = options.queryFactory ?? ((params) => sdkQuery(params));
	return {
		ask: <A, I>(prompt: string, schema: Schema.Schema<A, I>, model: string) =>
			Effect.gen(function* () {
				const abortController = new AbortController();
				const text = yield* Effect.tryPromise({
					try: () =>
						collectGeneratedText(
							queryFactory({
								prompt,
								options: {
									cwd: options.cwd,
									// Skip startup telemetry and update traffic for these short calls.
									env: {
										...makeClaudeSdkEnv(options),
										CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
									},
									model,
									thinking: { type: "disabled" },
									// Keep user hooks, CLAUDE.md and output styles out of this query.
									systemPrompt: options.systemPrompt,
									settings: {
										disableAllHooks: true,
										outputStyle: "default",
										claudeMdExcludes: ["**"],
									},
									persistSession: false,
									maxTurns: 1,
									allowedTools: [],
									tools: [],
									abortController,
									...(options.onStderr === undefined
										? {}
										: { stderr: options.onStderr }),
								},
							}),
						),
					catch: (cause) =>
						new ClaudeOneShotFailure({ reason: "query", cause }),
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							if (!abortController.signal.aborted) abortController.abort();
						}),
					),
				);
				if (!text) {
					return yield* new ClaudeOneShotFailure({ reason: "empty" });
				}
				return yield* Schema.decodeUnknown(schema)(text).pipe(
					// Preserve plain-text replies; structured schemas decode JSON internally.
					Effect.orElse(() =>
						Schema.decodeUnknown(Schema.parseJson(schema))(text),
					),
					Effect.mapError(
						(cause) => new ClaudeOneShotFailure({ reason: "schema", cause }),
					),
				);
			}),
	};
};

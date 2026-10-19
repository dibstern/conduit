import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { Duration, Effect } from "effect";
import type { Logger } from "../../../logger.js";
import {
	type ClaudeConfigDir,
	makeClaudeSdkEnv,
} from "../../../provider/claude/claude-sdk-env.js";
import {
	generationFailureReason,
	SessionTitleGenerationFailure,
	type TitleGenerator,
} from "./title-generator.js";

const TITLE_GENERATION_TIMEOUT = Duration.seconds(30);
const TITLE_SYSTEM_PROMPT =
	"You write concise sidebar titles for coding-assistant sessions.";

export type ClaudeTitleQueryFactory = (params: {
	readonly prompt: string;
	readonly options?: SDKOptions;
}) => AsyncIterable<unknown>;

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

export const makeClaudeTitleGenerator = (options: {
	readonly model: string;
	readonly configDir: ClaudeConfigDir;
	readonly log: Logger;
	readonly queryFactory?: ClaudeTitleQueryFactory;
}): TitleGenerator => {
	const queryFactory = options.queryFactory ?? ((params) => sdkQuery(params));
	return ({ prompt, cwd }) =>
		Effect.gen(function* () {
			const abortController = new AbortController();
			const rawTitle = yield* Effect.tryPromise({
				try: async () => {
					const titleQuery = queryFactory({
						prompt,
						options: {
							cwd,
							// Skipping startup telemetry/update traffic saves ~0.5s.
							env: {
								...makeClaudeSdkEnv(options),
								CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
							},
							model: options.model,
							// Default thinking adds ~5s to a title call without improving it.
							thinking: { type: "disabled" },
							// The user's hooks, CLAUDE.md files and output style otherwise
							// reach this prompt and leak into the title (e.g. a timestamp
							// hook's context echoed as a prefix). Flag settings override
							// them for this query only, keeping auth and env settings.
							systemPrompt: TITLE_SYSTEM_PROMPT,
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
							stderr: (data) =>
								options.log.debug(`Claude title generation stderr: ${data}`),
						},
					});
					return collectGeneratedText(titleQuery);
				},
				catch: (cause) =>
					new SessionTitleGenerationFailure({
						reason: generationFailureReason(cause),
					}),
			}).pipe(
				Effect.timeoutOrElse({
					duration: TITLE_GENERATION_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new SessionTitleGenerationFailure({
								reason: "Timed out waiting for Claude title generation",
							}),
						),
				}),
				Effect.ensuring(
					Effect.sync(() => {
						if (!abortController.signal.aborted) abortController.abort();
					}),
				),
			);

			if (!rawTitle) {
				return yield* new SessionTitleGenerationFailure({
					reason: "Claude returned no title text",
				});
			}
			return rawTitle;
		});
};

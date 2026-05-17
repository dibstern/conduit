import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { SqlClient } from "@effect/sql";
import {
	Cause,
	Context,
	Data,
	Duration,
	Effect,
	HashSet,
	Layer,
	Ref,
} from "effect";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import { makeClaudeSdkEnv } from "../../../provider/claude/claude-sdk-env.js";
import { ConfigTag, LoggerTag, WebSocketHandlerTag } from "./services.js";
import { SessionManagerServiceTag } from "./session-manager-service.js";

const TITLE_GENERATION_TIMEOUT = Duration.seconds(30);
const AUTO_TITLE_SOURCE = "auto-title";

export function sanitizeGeneratedTitle(raw: string): string | undefined {
	const cleaned = raw
		// biome-ignore lint/suspicious/noControlCharactersInRegex: title sanitizer intentionally collapses ASCII control characters.
		.replace(/[\u0000-\u001F\u007F]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/[.]+$/g, "")
		.trim();

	if (!cleaned) return undefined;

	const title = cleaned
		.split(/\s+/)
		.slice(0, 6)
		.join(" ")
		.replace(/[.]+$/g, "")
		.trim();
	return isDefaultSessionTitle(title) ? undefined : title;
}

export function isDefaultSessionTitle(title: string | undefined): boolean {
	const normalized = title?.trim().toLowerCase();
	return (
		!normalized ||
		normalized === "claude session" ||
		normalized === "untitled" ||
		normalized === "new session" ||
		normalized.startsWith("new session ")
	);
}

export function formatClaudeTitleFallback(now = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const hour = String(now.getHours()).padStart(2, "0");
	const minute = String(now.getMinutes()).padStart(2, "0");
	return `Claude Session ${year}-${month}-${day} ${hour}:${minute}`;
}

export interface SessionTitleService {
	readonly startForFirstClaudeMessage: (input: {
		readonly sessionId: string;
		readonly firstMessage: string;
	}) => Effect.Effect<void>;
}

export class SessionTitleServiceTag extends Context.Tag("SessionTitleService")<
	SessionTitleServiceTag,
	SessionTitleService
>() {}

export type ClaudeTitleQueryFactory = (params: {
	readonly prompt: string;
	readonly options?: SDKOptions;
}) => AsyncIterable<unknown>;

interface SessionTitleServiceLiveOptions {
	readonly queryFactory?: ClaudeTitleQueryFactory;
	readonly now?: () => Date;
}

class SessionTitleGenerationFailure extends Data.TaggedError(
	"SessionTitleGenerationFailure",
)<{
	readonly reason: string;
}> {}

function buildTitlePrompt(firstMessage: string): string {
	return `Create a concise sidebar title for this coding-assistant session.

Rules:
- Summarize the domain and intent of the user's first message.
- Return only the title.
- Use at most six words.
- Do not include quotes.
- Do not use "Claude Session", "Untitled", or "New session".

First message:
<message>
${firstMessage}
</message>`;
}

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

function generationFailureReason(cause: unknown): string {
	if (cause instanceof SessionTitleGenerationFailure) return cause.reason;
	if (cause instanceof Error) return cause.message;
	return String(cause);
}

function isClaudeSessionProvider(provider: string): boolean {
	return provider === "claude" || provider === "claude-sdk";
}

function withSql<A, E>(
	effect: Effect.Effect<A, E, SqlClient.SqlClient>,
	sql: SqlClient.SqlClient,
): Effect.Effect<A, E> {
	return effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
}

export const makeSessionTitleServiceLive = (
	options: SessionTitleServiceLiveOptions = {},
): Layer.Layer<
	SessionTitleServiceTag,
	never,
	LoggerTag | SessionManagerServiceTag
> =>
	Layer.scoped(
		SessionTitleServiceTag,
		Effect.gen(function* () {
			const scope = yield* Effect.scope;
			const log = yield* LoggerTag;
			const wsHandlerOption = yield* Effect.serviceOption(WebSocketHandlerTag);
			const sessionManagerService = yield* SessionManagerServiceTag;
			const configOption = yield* Effect.serviceOption(ConfigTag);
			const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
			const eventStoreOption = yield* Effect.serviceOption(EventStoreEffectTag);
			const projectionRunnerOption = yield* Effect.serviceOption(
				ProjectionRunnerEffectTag,
			);
			const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
			const inFlight = yield* Ref.make(HashSet.empty<string>());
			const queryFactory =
				options.queryFactory ?? ((params) => sdkQuery(params));
			const now = options.now ?? (() => new Date());
			const cwd =
				configOption._tag === "Some"
					? (configOption.value.projectDir ?? process.cwd())
					: process.cwd();

			const generateTitle = (firstMessage: string) =>
				Effect.gen(function* () {
					const abortController = new AbortController();
					const rawTitle = yield* Effect.tryPromise({
						try: async () => {
							const titleQuery = queryFactory({
								prompt: buildTitlePrompt(firstMessage),
								options: {
									cwd,
									env: makeClaudeSdkEnv(),
									model: "haiku",
									persistSession: false,
									maxTurns: 1,
									allowedTools: [],
									tools: [],
									abortController,
									stderr: (data) =>
										log.debug(`Claude title generation stderr: ${data}`),
								},
							});
							return collectGeneratedText(titleQuery);
						},
						catch: (cause) =>
							new SessionTitleGenerationFailure({
								reason: generationFailureReason(cause),
							}),
					}).pipe(
						Effect.timeoutFail({
							duration: TITLE_GENERATION_TIMEOUT,
							onTimeout: () =>
								new SessionTitleGenerationFailure({
									reason: "Timed out waiting for Claude title generation",
								}),
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

					const title = sanitizeGeneratedTitle(rawTitle);
					if (!title) {
						return yield* new SessionTitleGenerationFailure({
							reason: "Claude returned a default-equivalent title",
						});
					}
					return title;
				});

			const broadcastGenerationFailure = (
				sessionId: string,
				reason: string,
				fallbackTitle: string,
			) =>
				Effect.sync(() => {
					log.warn(
						`SESSION_TITLE_GENERATION_FAILED sessionId=${sessionId} reason=${reason}`,
					);
					if (wsHandlerOption._tag === "None") return;
					wsHandlerOption.value.broadcast({
						type: "system_error",
						code: "SESSION_TITLE_GENERATION_FAILED",
						message:
							"Claude session title generation failed; using fallback title.",
						details: {
							sessionId,
							reason,
							fallbackTitle,
						},
					});
				});

			const applyTitleIfStillDefault = (sessionId: string, title: string) =>
				Effect.gen(function* () {
					if (readQueryOption._tag === "None") return false;

					const currentResult = yield* Effect.either(
						readQueryOption.value.getSession(sessionId),
					);
					if (currentResult._tag === "Left") return false;

					const current = currentResult.right;
					if (!current) return false;
					if (!isClaudeSessionProvider(current.provider)) return false;
					if (!isDefaultSessionTitle(current.title)) return false;
					if (
						eventStoreOption._tag === "None" ||
						projectionRunnerOption._tag === "None" ||
						sqlOption._tag === "None"
					) {
						return false;
					}

					const eventStore = eventStoreOption.value;
					const projectionRunner = projectionRunnerOption.value;
					const sql = sqlOption.value;

					const recovered = yield* projectionRunner.isRecovered();
					if (!recovered) {
						yield* withSql(projectionRunner.recover(), sql).pipe(Effect.asVoid);
					}

					const createdAt = Date.now();
					const stored = yield* eventStore.append(
						canonicalEvent(
							"session.renamed",
							sessionId,
							{
								sessionId,
								title,
							},
							{
								provider: current.provider,
								createdAt,
								metadata: { source: AUTO_TITLE_SOURCE },
							},
						),
					);

					yield* withSql(projectionRunner.projectEvent(stored), sql);

					const rows = yield* sql<{ title: string; provider: string }>`
						SELECT title, provider FROM sessions WHERE id = ${sessionId}`;
					const appliedRow = rows[0];
					const applied =
						appliedRow?.title === title &&
						isClaudeSessionProvider(appliedRow.provider);
					if (!applied) return false;

					if (wsHandlerOption._tag === "Some") {
						yield* sessionManagerService.sendDualSessionLists((message) =>
							wsHandlerOption.value.broadcast(message),
						);
					}
					return true;
				});

			const runTitleJob = (input: {
				readonly sessionId: string;
				readonly firstMessage: string;
			}) =>
				Effect.gen(function* () {
					const titleResult = yield* Effect.either(
						generateTitle(input.firstMessage),
					);
					if (titleResult._tag === "Right") {
						yield* applyTitleIfStillDefault(input.sessionId, titleResult.right);
						return;
					}

					const reason = titleResult.left.reason;
					const fallbackTitle = formatClaudeTitleFallback(now());
					const applied = yield* applyTitleIfStillDefault(
						input.sessionId,
						fallbackTitle,
					);
					if (applied) {
						yield* broadcastGenerationFailure(
							input.sessionId,
							reason,
							fallbackTitle,
						);
					}
				});

			return {
				startForFirstClaudeMessage: (input) =>
					Effect.gen(function* () {
						const shouldStart = yield* Ref.modify(inFlight, (sessions) => {
							if (HashSet.has(sessions, input.sessionId)) {
								return [false, sessions];
							}
							return [true, HashSet.add(sessions, input.sessionId)];
						});
						if (!shouldStart) return;

						const job = runTitleJob(input).pipe(
							Effect.ensuring(
								Ref.update(inFlight, (sessions) =>
									HashSet.remove(sessions, input.sessionId),
								),
							),
							Effect.catchAllCause((cause) =>
								Cause.isInterruptedOnly(cause)
									? Effect.interrupt
									: Effect.sync(() => {
											log.warn(
												`Session title job failed for ${input.sessionId}: ${Cause.pretty(cause)}`,
											);
										}),
							),
						);

						yield* job.pipe(Effect.forkIn(scope));
					}),
			} satisfies SessionTitleService;
		}),
	);

export const SessionTitleServiceLive = makeSessionTitleServiceLive();

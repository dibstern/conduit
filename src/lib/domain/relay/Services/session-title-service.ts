import { SqlClient } from "@effect/sql";
import {
	Cause,
	Context,
	Effect,
	HashSet,
	Layer,
	Match,
	Ref,
	Schema,
} from "effect";
import {
	AUTO_TITLE_SOURCE,
	isPlaceholderTitle,
	type SessionTitleModel,
} from "../../../contracts/session-title.js";
import { SessionWorkspaceSchema } from "../../../contracts/session-workspace.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import {
	type ClaudeTitleQueryFactory,
	makeClaudeTitleGenerator,
} from "./claude-title-generator.js";
import { ConfigTag, LoggerTag } from "./services.js";
import { applySessionCommand } from "./session-command.js";
import {
	generationFailureReason,
	SessionTitleGenerationFailure,
	type TitleGenerator,
} from "./title-generator.js";

function resolveSessionTitleModel(): SessionTitleModel {
	return { harness: "claude", model: "opus" };
}

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
	return isPlaceholderTitle(title) ? undefined : title;
}

export function formatTitleFallback(now = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const hour = String(now.getHours()).padStart(2, "0");
	const minute = String(now.getMinutes()).padStart(2, "0");
	return `Session ${year}-${month}-${day} ${hour}:${minute}`;
}

export interface SessionTitleService {
	readonly titleFromMessage: (input: {
		readonly sessionId: string;
		readonly message: string;
	}) => Effect.Effect<void>;
}

export class SessionTitleServiceTag extends Context.Tag("SessionTitleService")<
	SessionTitleServiceTag,
	SessionTitleService
>() {}

interface SessionTitleServiceLiveOptions {
	readonly queryFactory?: ClaudeTitleQueryFactory;
	readonly now?: () => Date;
}

function buildTitlePrompt(message: string): string {
	return `Create a concise sidebar title for this coding-assistant session.

Rules:
- Summarize the domain and intent of the user's first message.
- Return only the title.
- Use at most six words.
- Do not include quotes.
- Do not return a placeholder title such as "Untitled" or "New session".

First message:
<message>
${message}
</message>`;
}

export const makeSessionTitleServiceLive = (
	options: SessionTitleServiceLiveOptions = {},
): Layer.Layer<
	SessionTitleServiceTag,
	never,
	| LoggerTag
	| OpenCodeAPITag
	| ConfigTag
	| ReadQueryEffectTag
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag
	| SqlClient.SqlClient
> =>
	Layer.scoped(
		SessionTitleServiceTag,
		Effect.gen(function* () {
			const scope = yield* Effect.scope;
			const log = yield* LoggerTag;
			const api = yield* OpenCodeAPITag;
			const config = yield* ConfigTag;
			const readQuery = yield* ReadQueryEffectTag;
			const eventStore = yield* EventStoreEffectTag;
			const projectionRunner = yield* ProjectionRunnerEffectTag;
			const sql = yield* SqlClient.SqlClient;
			const inFlight = yield* Ref.make(HashSet.empty<string>());
			const now = options.now ?? (() => new Date());
			const primaryFolder = config.projectDir;

			const generateTitle = (sessionId: string, message: string) =>
				Effect.gen(function* () {
					const session = yield* readQuery.getSession(sessionId);
					const workspace =
						session?.workspace == null
							? null
							: yield* Schema.decodeUnknown(
									Schema.parseJson(SessionWorkspaceSchema),
								)(session.workspace);
					const cwd = effectiveWorkingDirectory(primaryFolder, workspace);
					const generator: TitleGenerator = Match.value(
						resolveSessionTitleModel(),
					).pipe(
						Match.discriminator("harness")("claude", ({ model }) =>
							makeClaudeTitleGenerator({
								model,
								log,
								...(options.queryFactory === undefined
									? {}
									: { queryFactory: options.queryFactory }),
							}),
						),
						Match.exhaustive,
					);
					const rawTitle = yield* generator({
						prompt: buildTitlePrompt(message),
						cwd,
					});

					const title = sanitizeGeneratedTitle(rawTitle);
					if (!title) {
						return yield* new SessionTitleGenerationFailure({
							reason: "Generator returned a placeholder title",
						});
					}
					return title;
				}).pipe(
					Effect.mapError(
						(cause) =>
							new SessionTitleGenerationFailure({
								reason: generationFailureReason(cause),
							}),
					),
				);

			const applyTitleIfStillDefault = (sessionId: string, title: string) =>
				Effect.gen(function* () {
					const currentResult = yield* Effect.either(
						readQuery.getSession(sessionId),
					);
					if (currentResult._tag === "Left") return false;

					const current = currentResult.right;
					if (!current) return false;
					if (!isPlaceholderTitle(current.title)) return false;
					const recovered = yield* projectionRunner.isRecovered();
					if (!recovered) {
						yield* projectionRunner
							.recover()
							.pipe(
								Effect.provideService(SqlClient.SqlClient, sql),
								Effect.asVoid,
							);
					}

					yield* applySessionCommand(
						{ type: "session.renamed", data: { sessionId, title } },
						{ source: AUTO_TITLE_SOURCE },
					).pipe(
						Effect.provideService(OpenCodeAPITag, api),
						Effect.provideService(LoggerTag, log),
						Effect.provideService(ConfigTag, config),
						Effect.provideService(ReadQueryEffectTag, readQuery),
						Effect.provideService(EventStoreEffectTag, eventStore),
						Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
						Effect.provideService(SqlClient.SqlClient, sql),
					);

					const rows = yield* sql<{ title: string }>`
						SELECT title FROM sessions WHERE id = ${sessionId}`;
					return rows[0]?.title === title;
				});

			const runTitleJob = (input: {
				readonly sessionId: string;
				readonly message: string;
			}) =>
				Effect.gen(function* () {
					const titleResult = yield* Effect.either(
						generateTitle(input.sessionId, input.message),
					);
					if (titleResult._tag === "Right") {
						yield* applyTitleIfStillDefault(input.sessionId, titleResult.right);
						return;
					}

					const reason = titleResult.left.reason;
					const fallbackTitle = formatTitleFallback(now());
					const applied = yield* applyTitleIfStillDefault(
						input.sessionId,
						fallbackTitle,
					);
					// A background-task failure (fork 3.2): the fallback title is the
					// user-visible outcome, so the failure itself is log only.
					if (applied) {
						log.warn(
							`SESSION_TITLE_GENERATION_FAILED sessionId=${input.sessionId} reason=${reason}`,
						);
					}
				});

			return {
				titleFromMessage: (input) =>
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

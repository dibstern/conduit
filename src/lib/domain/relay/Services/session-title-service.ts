import { Context, Effect, HashSet, Layer, Ref } from "effect";
import { SqlClient } from "effect/sql";
import type { Account } from "../../../contracts/account.js";
import {
	AUTO_TITLE_SOURCE,
	isPlaceholderTitle,
} from "../../../contracts/session-title.js";
import type { TitleGenerationSelection } from "../../../contracts/title-generation.js";
import * as Failure from "../../../effect/failure-classification.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import { resolveTitleGeneration } from "../../../provider/title-generation.js";
import { catalogFromProviderList } from "../../../provider/turn-settings.js";
import { loadRelaySettings } from "../../../relay/relay-settings.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import { ProjectSettingsTag } from "./project-settings.js";
import { ConfigTag, LoggerTag } from "./services.js";
import { applySessionCommand } from "./session-command.js";

const TITLE_INSTRUCTIONS =
	"You write concise sidebar titles for coding-assistant sessions.";

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

export class SessionTitleServiceTag extends Context.Service<
	SessionTitleServiceTag,
	SessionTitleService
>()("SessionTitleService") {}

interface SessionTitleServiceLiveOptions {
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
	| AccountDirectory
	| ProviderRegistryTag
> =>
	Layer.effect(
		SessionTitleServiceTag,
		Effect.gen(function* () {
			const accounts = yield* AccountDirectory;
			const providers = yield* ProviderRegistryTag;
			const scope = yield* Effect.scope;
			const log = yield* LoggerTag;
			const api = yield* OpenCodeAPITag;
			const instances = yield* Effect.serviceOption(OpenCodeInstancesTag);
			const config = yield* ConfigTag;
			const projectSettings = yield* Effect.serviceOption(ProjectSettingsTag);
			const readQuery = yield* ReadQueryEffectTag;
			const eventStore = yield* EventStoreEffectTag;
			const projectionRunner = yield* ProjectionRunnerEffectTag;
			const sql = yield* SqlClient.SqlClient;
			const inFlight = yield* Ref.make(HashSet.empty<string>());
			const now = options.now ?? (() => new Date());

			const generateTitle = (
				account: Account,
				pick: TitleGenerationSelection,
				message: string,
			) =>
				Effect.gen(function* () {
					const provider = yield* providers.getInstanceEffect(account.driver);
					const rawTitle = yield* provider.generateTextEffect({
						account,
						model: { providerId: pick.providerId, modelId: pick.modelId },
						effort: pick.effort,
						instructions: TITLE_INSTRUCTIONS,
						prompt: buildTitlePrompt(message),
					});

					const title = sanitizeGeneratedTitle(rawTitle);
					if (!title) {
						return yield* Effect.fail(
							new Error("Generator returned a placeholder title"),
						);
					}
					return title;
				}).pipe(
					Effect.timeoutOrElse({
						duration: "30 seconds",
						orElse: () =>
							Effect.fail(new Error("Timed out waiting for title generation")),
					}),
				);

			const applyTitleIfStillDefault = (sessionId: string, title: string) =>
				Effect.gen(function* () {
					const currentResult = yield* Effect.result(
						readQuery.getSession(sessionId),
					);
					if (currentResult._tag === "Failure") return false;

					const current = currentResult.success;
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

					const rename = applySessionCommand(
						{ type: "session.renamed", data: { sessionId, title } },
						{ source: AUTO_TITLE_SOURCE },
					).pipe(
						Effect.provideService(OpenCodeAPITag, api),
						Effect.provideService(AccountDirectory, accounts),
						Effect.provideService(LoggerTag, log),
						Effect.provideService(ConfigTag, config),
						Effect.provideService(ReadQueryEffectTag, readQuery),
						Effect.provideService(EventStoreEffectTag, eventStore),
						Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
						Effect.provideService(SqlClient.SqlClient, sql),
					);
					yield* instances._tag === "Some"
						? rename.pipe(
								Effect.provideService(OpenCodeInstancesTag, instances.value),
							)
						: rename;

					const rows = yield* sql<{ title: string }>`
						SELECT title FROM sessions WHERE id = ${sessionId}`;
					return rows[0]?.title === title;
				});

			const runTitleJob = (input: {
				readonly sessionId: string;
				readonly message: string;
			}) =>
				Effect.gen(function* () {
					const state = yield* accounts.snapshot;
					const facts =
						projectSettings._tag === "Some"
							? yield* Ref.get(projectSettings.value.live)
							: undefined;
					const catalogFor = (account: Account) => {
						const catalog = facts?.[`providerModels:${account.id}`];
						return catalog
							? catalogFromProviderList(catalog.providers)
							: undefined;
					};
					const resolved = resolveTitleGeneration(
						loadRelaySettings(config.configDir).titleGeneration,
						state,
						catalogFor,
					);
					const pick =
						resolved.status === "ok" || resolved.status === "unverified"
							? resolved.pick
							: resolveTitleGeneration(undefined, state, catalogFor).pick;
					const account = yield* Effect.result(accounts.resolve(pick.account));
					const titleResult =
						account._tag === "Failure"
							? account
							: yield* Effect.result(
									generateTitle(account.success, pick, input.message),
								);
					if (titleResult._tag === "Success") {
						yield* applyTitleIfStillDefault(
							input.sessionId,
							titleResult.success,
						);
						return;
					}

					const reason = titleResult.failure.message;
					const fallbackTitle = formatTitleFallback(now());
					const applied = yield* applyTitleIfStillDefault(
						input.sessionId,
						fallbackTitle,
					);
					// A background-task failure (fork 3.2): the fallback title is the
					// user-visible outcome, so the failure itself is log only.
					if (applied) {
						log.warn(
							`SESSION_TITLE_GENERATION_FAILED sessionId=${input.sessionId} harness=${account._tag === "Success" ? account.success.driver : "claude"} account=${account._tag === "Success" ? account.success.id : "default"} model=${pick.providerId}/${pick.modelId} reason=${reason}`,
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
							Effect.catchCause((cause) =>
								Failure.isInterruptedOnly(cause)
									? Effect.interrupt
									: Effect.sync(() => {
											log.warn(
												`Session title job failed for ${input.sessionId}: ${Failure.renderCause(cause)}`,
											);
										}),
							),
						);

						yield* job.pipe(
							Effect.forkIn(scope, { uninterruptible: "inherit" }),
						);
					}),
			} satisfies SessionTitleService;
		}),
	);

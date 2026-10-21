import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import type { ProviderStateEffect } from "../../persistence/effect/provider-state-effect.js";
import type { ReadQueryEffect } from "../../persistence/effect/read-query-effect.js";
import { ProviderInstanceFailure } from "../errors.js";
import { renderForkDigest } from "../fork-digest.js";
import { historicalMessageText } from "../historical-message-text.js";
import { resolveRunnerForkDigest } from "../runner/runner-fork-digest.js";
import type { RunnerDriverPieces } from "../runner/runner-provider-instance.js";
import { discoverCodex, discoverCodexEffect } from "./codex-discovery.js";
import { codexAccountHome, prepareCodexAccount } from "./codex-home.js";
import { readCodexNativeTurns } from "./codex-native-history.js";
import {
	readCodexSessionIdentity,
	writeCodexSessionIdentity,
} from "./codex-session-store.js";

const decodeParameters = Schema.decodeUnknownResult(
	Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.String })),
);

export const makeCodexRunnerDriver = (
	workspaceRoot: string,
	persistence?: {
		readonly read: ReadQueryEffect;
		readonly state: ProviderStateEffect;
		readonly sql?: SqlClient.SqlClient;
	},
	configDir = DEFAULT_CONFIG_DIR,
): RunnerDriverPieces => ({
	driverKind: "codex",
	discoverEffect: (directory, account) =>
		discoverCodexEffect(account, directory ?? workspaceRoot, configDir),
	prepareTurnEffect: (input) =>
		Effect.gen(function* () {
			const continuationHistory =
				input.continuation && persistence
					? yield* persistence.read
							.getSessionMessagesWithParts(input.sessionId)
							.pipe(
								Effect.mapError(
									(cause) =>
										new ProviderInstanceFailure({
											providerId: "codex",
											operation: "continuation history",
											cause,
										}),
								),
							)
					: undefined;
			const cut = input.continuation?.cutOffMessageId;
			const cutMessage = cut
				? continuationHistory?.find((message) => message.id === cut)
				: undefined;
			const prompt = cutMessage
				? historicalMessageText(cutMessage)
				: input.prompt;
			if (input.continuation && !prompt.trim())
				return yield* Effect.fail(
					new ProviderInstanceFailure({
						providerId: "codex",
						operation: "continuation prompt",
						cause: "The interrupted request could not be read.",
					}),
				);
			const { home, env } = yield* prepareCodexAccount(
				input.account,
				configDir,
			);
			const catalog = yield* discoverCodex(
				home,
				env,
				input.workspaceRoot ?? workspaceRoot,
				true,
			);
			// The runner owns the auth error and its durable turn terminal.
			const model = (catalog.signedIn ? catalog.models : []).find(
				({ id }) => id === input.model?.modelId,
			);
			const command = /^\/([^\s]+)(?:\s|$)/.exec(prompt)?.[1];
			const skill = catalog.signedIn
				? catalog.skills.find(({ name }) => name === command)
				: undefined;
			const variants = model?.variants ?? {};
			const selected = input.variant ? variants[input.variant] : undefined;
			if (model && input.variant && !selected) {
				return yield* Effect.fail(
					new ProviderInstanceFailure({
						providerId: "codex",
						operation: "prepare turn",
						cause: new Error("Codex reasoning effort is not offered"),
					}),
				);
			}
			const variant =
				selected ??
				Object.values(variants).find((value) => value["isDefault"] === true);
			const params = decodeParameters(variant?.["params"] ?? []);
			const resolvedEffort = Result.isSuccess(params)
				? params.success.find(({ id }) => id === "effort")?.value
				: undefined;
			const digest = yield* resolveRunnerForkDigest(
				input,
				"codex.forkDigest",
				persistence,
			).pipe(
				Effect.mapError(
					(cause) =>
						new ProviderInstanceFailure({
							providerId: "codex",
							operation: "fork seed",
							cause,
						}),
				),
			);
			const identity = yield* Effect.try({
				try: () => readCodexSessionIdentity(configDir, input.sessionId),
				catch: (cause) =>
					new ProviderInstanceFailure({
						providerId: "codex",
						operation: "session identity",
						cause,
					}),
			});
			const sql = persistence?.sql;
			let revertBeforeTurnId: string | undefined;
			const rewind = input.rewind;
			if (rewind && sql) {
				revertBeforeTurnId = yield* Effect.gen(function* () {
					const messages = yield* sql<{
						id: string;
						turnId: string;
					}>`SELECT id, COALESCE(turn_id, id) AS turnId
						FROM messages WHERE session_id = ${input.sessionId} ORDER BY created_at, id`;
					const kept = rewind.resumeSessionAt;
					const keptIndex =
						kept === null ? -1 : messages.findIndex(({ id }) => id === kept);
					if (kept !== null && keptIndex < 0)
						return yield* Effect.fail(
							new Error(`Codex rewind kept message ${kept} was not found`),
						);
					const removed = new Set(
						messages.slice(keptIndex + 1).map(({ turnId }) => turnId),
					);
					const refs = yield* readCodexNativeTurns(input.sessionId).pipe(
						Effect.provideService(SqlClient.SqlClient, sql),
					);
					return refs.find(
						({ turnId, threadId }) =>
							removed.has(turnId) &&
							(!identity ||
								threadId === identity.threadId ||
								identity.inheritedThreadIds?.includes(threadId) ||
								threadId === identity.forkSource?.threadId),
					)?.nativeTurnId;
				}).pipe(
					Effect.mapError(
						(cause) =>
							new ProviderInstanceFailure({
								providerId: "codex",
								operation: "rewind boundary",
								cause,
							}),
					),
				);
			}
			const previousHome =
				identity?.codexHome ?? codexAccountHome(undefined, configDir);
			if (revertBeforeTurnId && !identity)
				return yield* Effect.fail(
					new ProviderInstanceFailure({
						providerId: "codex",
						operation: "rewind",
						cause:
							"Codex conversation rewind failed: native thread identity is missing",
					}),
				);
			if (identity && previousHome !== home) {
				const shared = yield* Effect.try(
					() =>
						realpathSync(join(previousHome, "sessions")) ===
						realpathSync(join(home, "sessions")),
				).pipe(Effect.orElseSucceed(() => false));
				// Pending forks keep their frozen cut when the launch account changes.
				let resumeFallbackDigest =
					identity.forkSource || identity.forkSeedPending
						? identity.resumeFallbackDigest
						: undefined;
				if (!shared && persistence && !resumeFallbackDigest) {
					const history =
						continuationHistory ??
						(yield* persistence.read
							.getSessionMessagesWithParts(input.sessionId)
							.pipe(
								Effect.mapError(
									(cause) =>
										new ProviderInstanceFailure({
											providerId: "codex",
											operation: "continuation history",
											cause,
										}),
								),
							));
					const index = cut
						? history.findIndex((message) => message.id === cut)
						: -1;
					resumeFallbackDigest = renderForkDigest(
						index >= 0 ? history.slice(0, index) : history,
					);
				}
				yield* Effect.try({
					try: () => {
						const moved = {
							...identity,
							codexHome: home,
							continuationKind: "native-thread" as const,
							continuationInputId: input.inputId,
						};
						if (resumeFallbackDigest)
							moved.resumeFallbackDigest = resumeFallbackDigest;
						else delete moved.resumeFallbackDigest;
						writeCodexSessionIdentity(configDir, input.sessionId, moved);
					},
					catch: (cause) =>
						new ProviderInstanceFailure({
							providerId: "codex",
							operation: "switch account home",
							cause,
						}),
				});
			}
			return {
				input: {
					...input,
					prompt,
					instanceId: input.account?.id ?? input.instanceId ?? "codex",
					providerState: {
						...input.providerState,
						...(revertBeforeTurnId
							? { "codex.revertBeforeTurnId": revertBeforeTurnId }
							: {}),
						"codex.skill": skill
							? { type: "skill", name: skill.name, path: skill.path }
							: null,
						...(resolvedEffort ? { "codex.effort": resolvedEffort } : {}),
						...(typeof digest === "string"
							? { "codex.forkDigest": digest }
							: {}),
					},
				},
			};
		}),
});

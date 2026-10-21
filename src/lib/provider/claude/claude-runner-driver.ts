import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Fiber, Option, Schema } from "effect";
import type { Account } from "../../contracts/account.js";
import { PROVIDER_DRIVERS } from "../../contracts/provider-instance.js";
import {
	loadDaemonConfigResult,
	resolveClaudeLaunchConfig,
} from "../../daemon/config-persistence.js";
import {
	ClaudeOneShotFailure,
	makeClaudeOneShot,
} from "../../domain/daemon/Services/claude-one-shot.js";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { createLogger } from "../../logger.js";
import { ProviderInstanceFailure } from "../errors.js";
import type { RunnerDriverPieces } from "../runner/runner-provider-instance.js";
import type { ProviderCapabilities } from "../types.js";
import type { ClaudeProviderInstanceDeps } from "./claude-provider-runtime.js";
import { discoverCapabilitiesEffect } from "./claude-runtime-discovery.js";

const log = createLogger("claude-runner-driver");

export const makeClaudeRunnerDriver = (
	deps: ClaudeProviderInstanceDeps,
): RunnerDriverPieces => {
	const discoverEffect = (
		workspaceRoot?: string,
		account?: Account,
		options?: { readonly refresh?: boolean },
	): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> => {
		return Effect.gen(function* () {
			const configDir =
				account?.driver === "claude"
					? account.folder
					: resolveClaudeLaunchConfig(
							yield* Effect.suspend(() =>
								Effect.fromResult(loadDaemonConfigResult(deps.daemonConfigDir)),
							).pipe(Effect.catchTag("NotFound", () => Effect.succeed(null))),
						).configDir;
			return yield* discoverCapabilitiesEffect(
				workspaceRoot ?? deps.workspaceRoot,
				deps.capabilitiesService,
				configDir,
				options,
			);
		}).pipe(
			Effect.mapError(
				(cause) =>
					new ProviderInstanceFailure({
						providerId: "claude",
						operation: "discover",
						cause,
					}),
			),
		);
	};
	return {
		driverKind: "claude",
		discoverEffect,
		generateTextEffect: (input) =>
			Effect.gen(function* () {
				const account =
					input.account.driver === "claude"
						? input.account
						: yield* Effect.fail(
								new Error("Claude text generation requires a Claude account"),
							);
				const scratchRoot = join(
					deps.daemonConfigDir ?? DEFAULT_CONFIG_DIR,
					"text-generation",
				);
				return yield* Effect.acquireUseRelease(
					Effect.tryPromise(async () => {
						await mkdir(scratchRoot, { recursive: true });
						return mkdtemp(join(scratchRoot, "run-"));
					}),
					(cwd) =>
						makeClaudeOneShot({
							configDir: {
								...account.folder,
								path: resolve(deps.workspaceRoot, account.folder.path),
							},
							...(account.env ? { accountEnv: account.env } : {}),
							cwd,
							systemPrompt: input.instructions,
							isolation: {
								settingSources: ["user"],
								strictMcpConfig: true,
								mcpServers: {},
							},
							onStderr: (data) =>
								log.debug(`Claude text generation stderr: ${data}`),
							...(deps.generateTextQueryFactory
								? { queryFactory: deps.generateTextQueryFactory }
								: {}),
						}).ask(
							input.prompt,
							Schema.String,
							input.model.modelId,
							input.effort,
						),
					(cwd) =>
						Effect.tryPromise(() => rm(cwd, { recursive: true, force: true })),
				);
			}).pipe(
				Effect.mapError(
					(cause) =>
						new ProviderInstanceFailure({
							providerId: "claude",
							operation: "generateText",
							cause:
								cause instanceof ClaudeOneShotFailure
									? (cause.cause ?? new Error("Claude returned no text"))
									: cause,
						}),
				),
			),
		nativeSession: true,
		stopTask: true,
		prepareTurnEffect: (input) =>
			Effect.gen(function* () {
				const account = input.account;
				if (
					account &&
					PROVIDER_DRIVERS[account.driver].accountKind !== "config-directory"
				)
					return yield* Effect.fail(
						new ProviderInstanceFailure({
							providerId: "claude",
							operation: "sendTurn",
							cause: new Error("Claude turn requires a Claude account"),
						}),
					);
				const folder =
					(account?.driver === "claude" ? account.folder : undefined) ??
					input.configDir;
				if (folder === undefined)
					return yield* Effect.fail(
						new ProviderInstanceFailure({
							providerId: "claude",
							operation: "sendTurn",
							cause: new Error(
								"Claude turn requires a resolved account or explicit config directory",
							),
						}),
					);
				const turn = {
					...input,
					configDir: folder,
					folderSource: input.folderSource ?? "account",
					...(account ? { instanceId: account.id } : {}),
				};
				const claudeSettingsOverrides = yield* Effect.try({
					try: () => deps.claudeSettingsOverrides?.(),
					catch: (cause) =>
						new ProviderInstanceFailure({
							providerId: "claude",
							operation: "sendTurn",
							cause,
						}),
				});
				return { input: turn, claudeSettingsOverrides };
			}),
		preparePreWarmEffect: (input, scope) => {
			return Effect.gen(function* () {
				const account = input.account;
				if (
					account &&
					PROVIDER_DRIVERS[account.driver].accountKind !== "config-directory"
				)
					return yield* Effect.fail(
						new ProviderInstanceFailure({
							providerId: "claude",
							operation: "preWarmSession",
							cause: new Error("Claude warm-up requires a Claude account"),
						}),
					);
				const folder =
					(account?.driver === "claude" ? account.folder : undefined) ??
					input.configDir;
				if (folder === undefined)
					return yield* Effect.fail(
						new ProviderInstanceFailure({
							providerId: "claude",
							operation: "preWarmSession",
							cause: new Error(
								"Claude warm-up requires a resolved account or explicit config directory",
							),
						}),
					);
				let model = input.model;
				if (!model) {
					// Discovery is shared with sends; cancellation only stops this waiter.
					const discovery = yield* Effect.forkIn(
						discoverEffect(input.workspaceRoot, account),
						scope,
					);
					const { models } = yield* Fiber.join(discovery);
					const inferred =
						models.find((item) => item.id === "default") ?? models[0];
					if (!inferred) return;
					model = { providerId: inferred.providerId, modelId: inferred.id };
				}
				const prepareShellEnv = deps.prepareShellEnv;
				if (prepareShellEnv) {
					// Keep capture owned by the resolver when this request times out.
					const ready = yield* Effect.tryPromise({
						try: () => prepareShellEnv(input.workspaceRoot),
						catch: (cause) =>
							new ProviderInstanceFailure({
								providerId: "claude",
								operation: "preWarmSession",
								cause,
							}),
					}).pipe(Effect.timeoutOption("10 seconds"));
					if (Option.isNone(ready) || !ready.value) return;
				}
				const claudeSettingsOverrides = yield* Effect.try({
					try: () => deps.claudeSettingsOverrides?.(),
					catch: (cause) =>
						new ProviderInstanceFailure({
							providerId: "claude",
							operation: "preWarmSession",
							cause,
						}),
				});
				return {
					type: "pre-warm",
					sessionId: input.sessionId,
					input: {
						...input,
						model,
						configDir: folder,
						folderSource: input.folderSource ?? "account",
						...(account ? { instanceId: account.id } : {}),
					},
					claudeSettingsOverrides,
				} as const;
			});
		},
	};
};

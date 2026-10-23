import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Fiber, Schema } from "effect";
import type { Account } from "../../contracts/account.js";
import { PROVIDER_DRIVERS } from "../../contracts/provider-instance.js";
import {
	ClaudeOneShotFailure,
	makeClaudeOneShot,
} from "../../domain/daemon/Services/claude-one-shot.js";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { createLogger } from "../../logger.js";
import { ProviderInstanceFailure } from "../errors.js";
import type { RunnerDriverPieces } from "../runner/runner-provider-instance.js";
import type {
	PreWarmSessionInput,
	ProviderCall,
	ProviderCapabilities,
} from "../types.js";
import type { ClaudeAccountScopes } from "./claude-account-scopes.js";
import type { ClaudeProviderInstanceDeps } from "./claude-provider-runtime.js";
import {
	discoverCapabilitiesEffect,
	expectedApiModelIdEffect,
} from "./claude-runtime-discovery.js";

const log = createLogger("claude-runner-driver");

export const makeClaudeRunnerDriver = (
	deps: ClaudeProviderInstanceDeps,
	accounts: ClaudeAccountScopes["Service"],
): RunnerDriverPieces => {
	const expectedModel = (input: PreWarmSessionInput) =>
		input.account
			? accounts
					.use(input.account, ({ account, capabilities }) =>
						expectedApiModelIdEffect(
							deps.capabilitiesService ?? capabilities,
							input.model?.modelId,
							input.contextWindow,
							input.workspaceRoot,
							input.agent,
							{
								...input,
								account,
								projectId: input.projectId ?? "",
								shellEnv: input.shellEnv ?? process.env,
							},
						),
					)
					.pipe(
						Effect.mapError(
							(cause) =>
								new ProviderInstanceFailure({
									providerId: "claude",
									operation: "probeCapabilities",
									cause,
								}),
						),
					)
			: Effect.succeed(undefined);
	const discoverEffect = (
		workspaceRoot?: string,
		account?: Account,
		options?: { readonly refresh?: boolean },
		call?: ProviderCall,
	): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> => {
		return Effect.gen(function* () {
			const selectedAccount =
				call?.account ?? account ?? (yield* accounts.defaultAccount);
			const root = call?.workspaceRoot ?? workspaceRoot;
			if (!root)
				return yield* Effect.fail(
					new Error("Claude discovery requires a workspace directory"),
				);
			return yield* accounts.use(selectedAccount, ({ account, capabilities }) =>
				discoverCapabilitiesEffect(
					root,
					deps.capabilitiesService ?? capabilities,
					account.folder,
					options,
					call
						? { ...call, account }
						: deps.capabilitiesService
							? undefined
							: {
									projectId: "",
									sessionId: "",
									workspaceRoot: root,
									extraFolders: [],
									shellEnv: process.env,
									account,
								},
				),
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
			accounts
				.use(input.account, ({ account }) =>
					Effect.gen(function* () {
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
									configDir: account.folder,
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
								Effect.tryPromise(() =>
									rm(cwd, { recursive: true, force: true }),
								),
						);
					}),
				)
				.pipe(
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
					...(account
						? { expectedApiModelId: (yield* expectedModel(input)) ?? null }
						: {}),
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
					const call =
						input.projectId !== undefined && account && input.shellEnv
							? {
									...input,
									projectId: input.projectId,
									account,
									shellEnv: input.shellEnv,
								}
							: undefined;
					// Discovery is shared with sends; cancellation only stops this waiter.
					const discovery = yield* Effect.forkIn(
						discoverEffect(input.workspaceRoot, account, undefined, call),
						scope,
					);
					const { models } = yield* Fiber.join(discovery);
					const inferred =
						models.find((item) => item.id === "default") ?? models[0];
					if (!inferred) return;
					model = { providerId: inferred.providerId, modelId: inferred.id };
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
						...(account
							? {
									expectedApiModelId:
										(yield* expectedModel({ ...input, model })) ?? null,
								}
							: {}),
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

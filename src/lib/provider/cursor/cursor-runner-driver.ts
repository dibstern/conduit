import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema, Semaphore } from "effect";
import type { Account } from "../../contracts/account.js";
import { PROVIDER_DRIVERS } from "../../contracts/provider-instance.js";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import type { ProviderStateEffect } from "../../persistence/effect/provider-state-effect.js";
import type { ReadQueryEffect } from "../../persistence/effect/read-query-effect.js";
import { ProviderInstanceFailure } from "../errors.js";
import type { RunnerDriverPieces } from "../runner/runner-provider-instance.js";
import type { ModelInfo, ProviderCapabilities } from "../types.js";
import { CursorAccountResources } from "./cursor-account-resources.js";
import { resolveCursorCredential } from "./cursor-credential.js";
import { renderCursorForkDigest } from "./cursor-fork-digest.js";
import { createCursorSdkPort } from "./cursor-sdk.js";
import { discoverCursorSkillsEffect } from "./cursor-skill-discovery.js";
import { cursorTurnError } from "./sdk-error.js";
import type {
	CursorAgent,
	CursorCredential,
	CursorModel,
	CursorRun,
	CursorSdkPort,
	CursorStore,
} from "./sdk-port.js";

export const CursorModelParameters = Schema.Array(
	Schema.Struct({ id: Schema.String, value: Schema.String }),
);

/** Picker keys describe combinations; the values retain Cursor's native ids. */
export function cursorModelInfo(model: CursorModel): ModelInfo {
	const sdkDefault = model.variants?.find(({ isDefault }) => isDefault);
	// Keep the SDK's default combination, with paid Fast off when it has a twin.
	const defaultVariant =
		model.variants?.find(
			({ params }) =>
				sdkDefault?.params.some(
					({ id, value }) => id === "fast" && value === "true",
				) &&
				params.length === sdkDefault.params.length &&
				params.every(({ id, value }) =>
					id === "fast"
						? value === "false"
						: sdkDefault.params.some(
								(parameter) => parameter.id === id && parameter.value === value,
							),
				),
		) ?? sdkDefault;
	const variants = model.variants
		?.filter(({ params }) => params.length > 0)
		.map((variant) => {
			const labels = variant.params.flatMap(({ id, value }) => {
				const parameter = model.parameters?.find((entry) => entry.id === id);
				const label = parameter?.values
					.find((entry) => entry.value === value)
					?.displayName?.replace(/[\u200b-\u200d\ufeff]/g, "")
					.trim();
				if (id === "fast") return value === "false" ? [] : [label || "Fast"];
				if (id === "thinking")
					return [value === "true" ? "Thinking" : "No thinking"];
				if (id === "effort" || id === "reasoning_effort" || id === "reasoning")
					return [value];
				return [label || `${parameter?.displayName ?? id}: ${value}`];
			});
			return { key: labels.join(" · ") || "Standard", variant };
		})
		.sort((left, right) => {
			// Keep each captured parameter order, with standard before paid Fast.
			if (left.key === "Standard") return -1;
			if (right.key === "Standard") return 1;
			return 0;
		});
	return {
		id: model.id,
		name: model.displayName,
		providerId: "cursor",
		...(variants?.length
			? {
					variants: Object.fromEntries(
						variants.map(({ key, variant }) => [
							key,
							{
								params: variant.params.map(({ id, value }) => ({ id, value })),
								...(variant === defaultVariant ? { isDefault: true } : {}),
							},
						]),
					),
					parameters: {
						rows: (model.parameters ?? []).map((parameter) => ({
							id: parameter.id,
							label: parameter.displayName || parameter.id,
							values: parameter.values.map(({ value, displayName }) => ({
								value,
								label:
									displayName?.replace(/[\u200b-\u200d\ufeff]/g, "").trim() ||
									value,
							})),
						})),
						combinations: variants.map(({ key, variant }) => ({
							variant: key,
							values: Object.fromEntries(
								variant.params.map(({ id, value }) => [id, value]),
							),
							...(variant === defaultVariant ? { isDefault: true } : {}),
						})),
					},
				}
			: {}),
	};
}

const discoveryFailure = (reason: string, authRequired = false) =>
	new ProviderInstanceFailure({
		providerId: "cursor",
		operation: "discover",
		cause: new Error(reason),
		...(authRequired ? { code: "auth_required" as const } : {}),
	});

let defaultPort: CursorSdkPort | undefined;
// Local SDK transcript paths use process-global environment variables. Session
// agents live in child runners; serialize all in-daemon text calls across relays.
const textGenerationLock = Semaphore.makeUnsafe(1);
const catalogs = new WeakMap<
	CursorSdkPort,
	{
		lock: ReturnType<typeof Semaphore.makeUnsafe>;
		entries: Map<
			string,
			{
				expiresAt: number;
				models: readonly ModelInfo[];
			}
		>;
	}
>();
export const discoverCursorEffect = (
	port?: CursorSdkPort,
	account?: Account,
	workspaceRoot?: string,
	shellEnv?: Readonly<Record<string, string | undefined>>,
	credentialEffect?: Effect.Effect<CursorCredential | undefined, unknown>,
): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> =>
	Effect.gen(function* () {
		const resources = yield* Effect.serviceOption(CursorAccountResources);
		if (!port && account && resources._tag === "Some") {
			return yield* resources.value
				.use(account.id, ({ sdk, credential }) =>
					discoverCursorEffect(
						sdk,
						account,
						workspaceRoot,
						shellEnv,
						credential,
					),
				)
				.pipe(
					Effect.mapError((cause) =>
						cause instanceof ProviderInstanceFailure
							? cause
							: discoveryFailure(cause.message),
					),
				);
		}
		const adapter = yield* Effect.try({
			try: () =>
				port ??
				(account
					? createCursorSdkPort({ id: account.id })
					: (defaultPort ??= createCursorSdkPort())),
			catch: () => discoveryFailure("Cursor SDK could not load"),
		});
		const runtime = yield* Effect.tryPromise({
			try: () => adapter.probeRuntime(),
			catch: () => discoveryFailure("Cursor SDK could not load"),
		});
		if (!runtime.available)
			return yield* Effect.fail(
				discoveryFailure(runtime.reason ?? "Cursor SDK could not load"),
			);
		const credential = yield* (
			credentialEffect ??
			Effect.tryPromise(() =>
				resolveCursorCredential(adapter, {
					NODE_ENV: process.env["NODE_ENV"],
					...(account ? {} : (shellEnv ?? process.env)),
					...account?.env,
				}),
			)
		).pipe(
			Effect.mapError(() =>
				discoveryFailure("Cursor credential lookup failed"),
			),
		);
		if (!credential)
			return yield* Effect.fail(
				discoveryFailure(
					"Cursor authentication required. Log in to Cursor in Settings.",
					true,
				),
			);
		// Keyed by credential, so a login or logout reads a fresh catalog.
		const key = JSON.stringify([
			account?.id ?? "cursor",
			credential.fingerprint,
		]);
		let catalog = catalogs.get(adapter);
		if (!catalog) {
			catalog = { entries: new Map(), lock: Semaphore.makeUnsafe(1) };
			catalogs.set(adapter, catalog);
		}
		const { entries: cache, lock } = catalog;
		const models = yield* lock.withPermits(1)(
			Effect.gen(function* () {
				const cached = cache.get(key);
				if (cached && cached.expiresAt > Date.now()) return cached.models;
				cache.delete(key);
				const listed = yield* Effect.tryPromise({
					try: () => adapter.modelsList(credential),
					catch: (cause) => {
						const authRequired =
							cursorTurnError(cause).code === "auth_required";
						return discoveryFailure(
							authRequired
								? "Cursor authentication failed. Log in to Cursor in Settings."
								: "Cursor model list failed",
							authRequired,
						);
					},
				}).pipe(
					Effect.timeoutOrElse({
						duration: "15 seconds",
						orElse: () =>
							Effect.fail(discoveryFailure("Cursor model list failed")),
					}),
				);
				if (listed.length === 0)
					return yield* Effect.fail(
						discoveryFailure("Cursor model list is empty"),
					);
				const models = listed.map(cursorModelInfo);
				const ttlOverride =
					process.env["NODE_ENV"] === "test"
						? Number(process.env["CONDUIT_TEST_CURSOR_CATALOG_TTL_MS"])
						: Number.NaN;
				const ttlMs =
					Number.isFinite(ttlOverride) && ttlOverride > 0
						? ttlOverride
						: 30 * 60_000;
				cache.set(key, { expiresAt: Date.now() + ttlMs, models });
				return models;
			}),
		);
		return {
			models,
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: false,
			supportsQuestions: true,
			supportsAttachments: false,
			supportsFork:
				PROVIDER_DRIVERS.cursor.forkStrategy === "transcript-digest",
			supportsRevert: false,
			commands: workspaceRoot
				? yield* discoverCursorSkillsEffect(workspaceRoot)
				: [],
		};
	});

export const makeCursorRunnerDriver = (
	workspaceRoot: string,
	port?: CursorSdkPort,
	persistence?: {
		readonly read: ReadQueryEffect;
		readonly state: Omit<ProviderStateEffect, "projectId">;
	},
	daemonConfigDir = DEFAULT_CONFIG_DIR,
	resources?: CursorAccountResources["Service"],
): RunnerDriverPieces => {
	const discover = (
		account?: Account,
		directory?: string,
		shellEnv?: Readonly<Record<string, string | undefined>>,
	) => {
		const discovery = discoverCursorEffect(
			port,
			account,
			directory ?? workspaceRoot,
			shellEnv,
		);
		return resources
			? discovery.pipe(Effect.provideService(CursorAccountResources, resources))
			: discovery;
	};
	return {
		driverKind: "cursor",
		discoverEffect: (directory, account, _options, call) =>
			discover(
				call?.account ?? account,
				call?.workspaceRoot ?? directory ?? workspaceRoot,
				call?.shellEnv,
			),
		generateTextEffect: (input) => {
			const generate = (
				adapter: CursorSdkPort,
				credentialEffect?: Effect.Effect<CursorCredential | undefined, unknown>,
			) =>
				Effect.gen(function* () {
					const account =
						input.account.driver === "cursor" &&
						input.model.providerId === "cursor"
							? input.account
							: yield* Effect.fail(
									new Error(
										"Cursor text generation requires a Cursor account and model",
									),
								);
					const credential = yield* credentialEffect ??
						Effect.tryPromise(() =>
							resolveCursorCredential(adapter, {
								NODE_ENV: process.env["NODE_ENV"],
								...account.env,
							}),
						);
					if (!credential)
						return yield* Effect.fail(
							new ProviderInstanceFailure({
								providerId: "cursor",
								operation: "generateText",
								code: "auth_required",
								cause: new Error("Cursor authentication required"),
							}),
						);
					const catalog = yield* discoverCursorEffect(
						adapter,
						account,
						undefined,
						undefined,
						Effect.succeed(credential),
					);
					const model = catalog.models.find(
						({ id }) => id === input.model.modelId,
					);
					if (!model)
						return yield* Effect.fail(
							new Error("Cursor title model is not offered"),
						);
					// Captured parameter values are cheapest-first. Composer lists its paid
					// Fast variant first, so neither variant order nor isDefault is suitable.
					const variant =
						input.effort ||
						model.parameters?.combinations.find(({ values }) =>
							model.parameters?.rows.every(
								(row) => values[row.id] === row.values[0]?.value,
							),
						)?.variant;
					if (
						(input.effort && !model.variants?.[input.effort]) ||
						(model.parameters && !variant)
					)
						return yield* Effect.fail(
							new Error("Cursor title model parameter choice is not offered"),
						);
					const params = yield* Schema.decodeUnknownEffect(
						CursorModelParameters,
					)(variant ? model.variants?.[variant]?.["params"] : []);
					const scratchRoot = join(daemonConfigDir, "text-generation");
					return yield* Effect.acquireUseRelease(
						Effect.tryPromise(async () => {
							await mkdir(scratchRoot, { recursive: true });
							return mkdtemp(join(scratchRoot, "cursor-"));
						}),
						(root) =>
							Effect.uninterruptibleMask((restore) => {
								const cwd = join(root, "cwd");
								const storePath = join(root, "store");
								let store: CursorStore | undefined;
								let agent: CursorAgent | undefined;
								let run: CursorRun | undefined;
								let finished = false;
								const previous = {
									CURSOR_DATA_DIR: process.env["CURSOR_DATA_DIR"],
									CURSOR_SANDBOX_POLICY_DIR:
										process.env["CURSOR_SANDBOX_POLICY_DIR"],
								};
								// Register cleanup before any uncancellable SDK acquisition. Only the
								// stream/wait is interruptible; late-created handles still get released.
								return Effect.acquireUseRelease(
									Effect.sync(() => {
										// local.store does not redirect transcripts or sandbox-policy writes.
										process.env["CURSOR_DATA_DIR"] = join(root, "data");
										process.env["CURSOR_SANDBOX_POLICY_DIR"] = join(
											root,
											"sandbox-policies",
										);
									}),
									() =>
										Effect.gen(function* () {
											yield* Effect.tryPromise(() => mkdir(cwd));
											store = yield* Effect.tryPromise(() =>
												adapter.openStore(storePath, cwd),
											);
											const openedStore = store;
											agent = yield* Effect.tryPromise(() =>
												adapter.createAgent(
													{
														cwd,
														dirs: [],
														settingSources: [],
														storePath,
														sandboxOptions: { enabled: true },
														autoReview: false,
														tools: [],
														disallowedTools: ["mcp", "task"],
														customToolNames: [],
														subagentInherit: { reportedWorkspacePath: cwd },
														credentialFingerprint: credential.fingerprint,
													},
													credential,
													openedStore,
												),
											);
											const openedAgent = agent;
											run = yield* Effect.tryPromise(() =>
												openedAgent.send(
													`${input.instructions}\n\n${input.prompt}`,
													{
														model: { id: model.id, params },
														mode: "agent",
													},
													() => {},
												),
											);
											const activeRun = run;
											const result = yield* restore(
												Effect.tryPromise(async () => {
													const drained = (async () => {
														for await (const _ of activeRun.stream) {
															/* Drain the independent SDK stream. */
														}
													})();
													const [terminal] = await Promise.all([
														activeRun.wait(),
														drained,
													]);
													return terminal;
												}).pipe(
													Effect.flatMap(
														Schema.decodeUnknownEffect(
															Schema.Struct({
																status: Schema.Literal("finished"),
																result: Schema.String,
															}),
														),
													),
												),
											);
											finished = true;
											return result.result;
										}),
									() =>
										Effect.tryPromise(async () => {
											try {
												if (!finished) await run?.cancel();
											} finally {
												try {
													await agent?.close();
												} finally {
													try {
														if (agent && store)
															await adapter.deleteAgent(agent.id, cwd, store);
													} finally {
														await store?.dispose();
													}
												}
											}
										}).pipe(
											Effect.ensuring(
												Effect.sync(() => {
													for (const [key, value] of Object.entries(previous)) {
														if (value === undefined) delete process.env[key];
														else process.env[key] = value;
													}
												}),
											),
										),
								);
							}),
						(root) =>
							Effect.tryPromise(() =>
								rm(root, { recursive: true, force: true }),
							),
					);
				});
			return (
				resources
					? resources.use(input.account.id, ({ sdk, credential }) =>
							generate(sdk, credential),
						)
					: Effect.try(
							() =>
								port ??
								createCursorSdkPort({
									id: input.account.id,
									configDir: daemonConfigDir,
								}),
						).pipe(Effect.flatMap(generate))
			).pipe(
				textGenerationLock.withPermits(1),
				Effect.mapError(
					(cause) =>
						new ProviderInstanceFailure({
							providerId: "cursor",
							operation: "generateText",
							cause,
							...(cause instanceof ProviderInstanceFailure && cause.code
								? { code: cause.code }
								: {}),
						}),
				),
			);
		},
		prepareTurnEffect: (input) => {
			const prepare = (
				adapter: CursorSdkPort,
				credentialEffect: Effect.Effect<CursorCredential | undefined, unknown>,
			) =>
				Effect.gen(function* () {
					const credential = yield* credentialEffect.pipe(
						Effect.mapError(() =>
							discoveryFailure("Cursor credential lookup failed"),
						),
					);
					if (!credential)
						return yield* Effect.fail(
							discoveryFailure(
								"Cursor authentication required. Log in to Cursor in Settings.",
								true,
							),
						);
					const catalog = yield* discoverCursorEffect(
						adapter,
						input.account,
						input.workspaceRoot,
						input.shellEnv,
						Effect.succeed(credential),
					).pipe(
						Effect.catch((failure) =>
							// The runner owns the auth error and its durable turn terminal.
							failure.code === "auth_required"
								? Effect.succeed({ models: [] })
								: Effect.fail(failure),
						),
					);
					const model = catalog.models.find(
						({ id }) => id === input.model?.modelId,
					);
					const variants = model?.variants ?? {};
					const selected = input.variant ? variants[input.variant] : undefined;
					if (model && input.variant && !selected)
						return yield* Effect.fail(
							discoveryFailure("Cursor model parameter choice is not offered"),
						);
					const variant =
						selected ??
						Object.values(variants).find(
							(variant) => variant["isDefault"] === true,
						);
					const params = variant?.["params"] ?? [];
					const digest = yield* Effect.gen(function* () {
						const supplied = input.providerState["cursor.forkDigest"];
						if (typeof supplied === "string" || !persistence) return supplied;
						const { read, state } = persistence;
						const stored = (yield* state.getState(input.sessionId))[
							"cursor.forkDigest"
						];
						if (stored !== undefined) return stored;
						const session = yield* read.getSession(input.sessionId);
						if (
							!session?.forked_from &&
							!(session?.side_thread === 1 && session.parent_id)
						)
							return undefined;
						const inherited = (yield* read.getSessionMessagesWithParts(
							input.sessionId,
						)).filter((message) => message.is_inherited === 1);
						if (inherited.length === 0) return undefined;
						const rendered = renderCursorForkDigest(inherited);
						// Persist before the runner hop. Rejected sends and recovered commands
						// reuse this snapshot; forkSeedPending still owns seed settlement.
						yield* state.saveUpdates(input.sessionId, [
							{ key: "cursor.forkDigest", value: rendered },
						]);
						return rendered;
					}).pipe(
						Effect.mapError(
							(cause) =>
								new ProviderInstanceFailure({
									providerId: "cursor",
									operation: "fork seed",
									cause,
								}),
						),
					);
					return {
						cursorCredential: { ...credential, apiKey: credential.apiKey },
						input: {
							...input,
							instanceId: input.account?.id ?? input.instanceId ?? "cursor",
							providerState: {
								...input.providerState,
								"cursor.modelParams": params,
								...(typeof digest === "string"
									? { "cursor.forkDigest": digest }
									: {}),
							},
						},
					};
				});
			if (resources && input.account)
				return resources
					.use(input.account.id, ({ sdk, credential }) =>
						prepare(sdk, credential),
					)
					.pipe(
						Effect.mapError((cause) =>
							cause instanceof ProviderInstanceFailure
								? cause
								: discoveryFailure(cause.message),
						),
					);
			return Effect.try(
				() =>
					port ??
					createCursorSdkPort(
						input.account
							? { id: input.account.id, configDir: daemonConfigDir }
							: undefined,
					),
			).pipe(
				Effect.mapError(() => discoveryFailure("Cursor SDK could not load")),
				Effect.flatMap((sdk) =>
					prepare(
						sdk,
						Effect.tryPromise(() =>
							resolveCursorCredential(sdk, {
								NODE_ENV: process.env["NODE_ENV"],
								...(input.account ? {} : (input.shellEnv ?? process.env)),
								...input.account?.env,
							}),
						),
					),
				),
			);
		},
	};
};

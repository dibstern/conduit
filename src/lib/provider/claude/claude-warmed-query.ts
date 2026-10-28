import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import { Deferred, Effect, Exit, FiberMap, Semaphore } from "effect";
import { getProviderDriver } from "../../contracts/provider-instance.js";
import {
	type ClaudeAdapterError,
	ClaudeBoundaryError,
	ClaudeResumeRefused,
	ClaudeRuntimeError,
} from "../event-sink-errors.js";
import { makeClaudeForkQuery } from "./claude-fork-query.js";
import type { ReadClaudeGoalStatus } from "./claude-goal-tracker.js";
import type { ClaudePermissionBridge } from "./claude-permission-bridge.js";
import type { ClaudeProviderInstanceDeps } from "./claude-provider-runtime.js";
import { buildClaudeQueryOptions } from "./claude-query-options.js";
import { makeClaudeQueryProcesses } from "./claude-query-processes.js";
import {
	type ClaudeConfigDir,
	type ClaudeLaunchConfig,
	type ClaudeLogin,
	makeClaudeSdkEnv,
	sameClaudeLogin,
} from "./claude-sdk-env.js";
import { makeEffectPromptQueue } from "./effect-prompt-queue.js";
import type {
	CanUseTool,
	ClaudePreWarmSessionInput,
	ClaudeSessionContext,
	PromptQueueController,
	Query,
	Options as SDKOptions,
	SDKUserMessage,
} from "./types.js";

export interface EmptyClaudeQuery<Q extends { close(): void }> {
	readonly query: Q;
	readonly promptQueue: PromptQueueController;
	readonly options: SDKOptions;
	readonly configDir: ClaudeConfigDir;
	readonly abortController: AbortController;
	readonly stopProcesses: () => Promise<void>;
}

export interface WarmedClaudeQuery extends EmptyClaudeQuery<Query> {
	bindContext(context: ClaudeSessionContext): void;
}

/** Shared idle launch path: no prompt is enqueued until a real turn adopts it. */
export const makeClaudeEmptyQuery = <Q extends { close(): void }>(
	queryFactory: (params: {
		configDir: ClaudeConfigDir;
		prompt: AsyncIterable<SDKUserMessage>;
		options?: SDKOptions;
	}) => Q,
	makeOptions: (abortController: AbortController) => SDKOptions,
	launchConfig: Pick<ClaudeLaunchConfig, "configDir"> &
		Pick<ClaudePreWarmSessionInput, "account"> & {
			readonly killProcessGroup?: boolean;
		},
	prepareQuery?: () => Promise<void>,
): Effect.Effect<EmptyClaudeQuery<Q>, ClaudeAdapterError> =>
	Effect.gen(function* () {
		if (prepareQuery)
			yield* Effect.tryPromise({
				try: prepareQuery,
				catch: (cause) =>
					new ClaudeBoundaryError({ operation: "prepareQuery", cause }),
			}).pipe(Effect.interruptible);
		const promptQueue = yield* makeEffectPromptQueue();
		const abortController = new AbortController();
		let stderr: SDKOptions["stderr"];
		const processes = makeClaudeQueryProcesses({
			// Usage owns a group; adopted warm queries stay in their runner's group.
			killProcessGroup: launchConfig.killProcessGroup ?? false,
			stderr: (data) => stderr?.(data),
		});
		const drainProcesses = Effect.tryPromise({
			try: processes.stop,
			catch: (cause) =>
				new ClaudeBoundaryError({ operation: "closeEmptyQuery", cause }),
		}).pipe(Effect.orDie);
		return yield* Effect.try({
			try: () => {
				const launch = makeOptions(abortController);
				stderr = launch.stderr;
				const options: SDKOptions = {
					...launch,
					spawnClaudeCodeProcess: processes.spawnClaudeCodeProcess,
					env: makeClaudeSdkEnv({
						...launchConfig,
						baseEnv: launch.env,
						accountEnv:
							getProviderDriver(launchConfig.account?.driver)?.accountKind ===
							"config-directory"
								? launchConfig.account?.env
								: undefined,
					}),
				};
				return {
					configDir: launchConfig.configDir,
					promptQueue,
					abortController,
					stopProcesses: processes.stop,
					options,
					query: queryFactory({
						configDir: launchConfig.configDir,
						prompt: promptQueue,
						options,
					}),
				};
			},
			catch: (cause) =>
				new ClaudeBoundaryError({ operation: "preWarm", cause }),
		}).pipe(
			Effect.onError(() =>
				promptQueue
					.close()
					.pipe(
						Effect.andThen(Effect.sync(() => abortController.abort())),
						Effect.andThen(drainProcesses),
					),
			),
		);
	});

export const closeClaudeEmptyQuery = <Q extends { close(): void }>(
	resource: EmptyClaudeQuery<Q>,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		// A stopped SDK iterator can already have shut down its queue.
		yield* Effect.exit(resource.promptQueue.close());
		resource.abortController.abort();
		yield* Effect.try(() => resource.query.close()).pipe(Effect.ignore);
		yield* Effect.tryPromise({
			try: resource.stopProcesses,
			catch: (cause) =>
				new ClaudeBoundaryError({ operation: "closeEmptyQuery", cause }),
		}).pipe(Effect.orDie);
	});

interface PendingWarmedQuery {
	readonly initializingKey: symbol;
	readonly resource: WarmedClaudeQuery;
	readonly login: ClaudeLogin;
	readonly ready: Deferred.Deferred<WarmedClaudeQuery, ClaudeAdapterError>;
	readonly inheritedSettings: string | undefined;
	readonly inheritedSettingsFrozen: boolean;
}

export interface ClaudeWarmedQueryOwner {
	preWarmEffect(
		input: ClaudePreWarmSessionInput,
		settings: Settings | undefined,
		shellEnv: Readonly<Record<string, string | undefined>> | undefined,
		bridge: ClaudePermissionBridge,
		inheritedSettingsFrozen?: boolean,
	): Effect.Effect<void, ClaudeAdapterError>;
	takeEffect(
		sessionId: string,
		options: SDKOptions,
		login: ClaudeLogin,
	): Effect.Effect<WarmedClaudeQuery | undefined, ClaudeAdapterError>;
	discardEffect(sessionId: string): Effect.Effect<void>;
	clearEffect(): Effect.Effect<void>;
}

function immutableOptions(options: SDKOptions) {
	const {
		abortController: _abort,
		canUseTool: _permission,
		spawnClaudeCodeProcess: _spawn,
		env: _env,
		...launch
	} = options;
	if (launch.forkSession) {
		if (launch.sessionId) launch.resume = launch.sessionId;
		else delete launch.resume;
		delete launch.sessionId;
		delete launch.forkSession;
		delete launch.resumeSessionAt;
	}
	return launch;
}

/** File metadata is cheap to recheck once, without resolving settings on a send. */
export function inheritedSettingsFingerprint(
	options: SDKOptions,
	folder: ClaudeConfigDir,
): string | undefined {
	try {
		const cwd = resolve(options.cwd ?? process.cwd());
		const configDir = resolve(cwd, folder.path);
		const files = new Set([
			join(configDir, "settings.json"),
			join(cwd, ".claude", "settings.json"),
		]);
		for (let directory = cwd; ; directory = dirname(directory)) {
			files.add(join(directory, ".claude", "settings.local.json"));
			const gitFile = join(directory, ".git");
			const git = statSync(gitFile, { throwIfNoEntry: false });
			if (git?.isFile()) {
				if (git.size > 4096) return;
				const marker = readFileSync(gitFile, "utf8").trim();
				if (marker.startsWith("gitdir:")) {
					const gitDir = resolve(directory, marker.slice(7).trim());
					const commonFile = join(gitDir, "commondir");
					const common = statSync(commonFile, { throwIfNoEntry: false });
					if (common?.isFile()) {
						if (common.size > 4096) return;
						const mainRoot = dirname(
							resolve(gitDir, readFileSync(commonFile, "utf8").trim()),
						);
						files.add(join(mainRoot, ".claude", "settings.local.json"));
					}
				}
			}
			if (directory === dirname(directory)) break;
		}
		return [...files]
			.map((file) => {
				const metadata = statSync(file, {
					bigint: true,
					throwIfNoEntry: false,
				});
				return metadata
					? `${file}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`
					: `${file}:missing`;
			})
			.join("\n");
	} catch {
		// If a file cannot be checked, the speculative query cannot be adopted.
		return;
	}
}

/** Owns empty queries until initialization succeeds and a real turn adopts them. */
export const makeClaudeWarmedQueryOwner = (
	queryFactory: NonNullable<ClaudeProviderInstanceDeps["queryFactory"]>,
	prepareQuery?: (input: ClaudePreWarmSessionInput) => Promise<void>,
	readGoalStatus?: ReadClaudeGoalStatus,
	onNativeSessionId?: (sessionId: string, nativeSessionId: string) => void,
) =>
	Effect.gen(function* () {
		const initializing = yield* FiberMap.make<symbol, void>();
		const lock = yield* Semaphore.make(1);
		const pending = new Map<string, PendingWarmedQuery>();
		let closing = false;
		const close = (entry: PendingWarmedQuery) =>
			closeClaudeEmptyQuery(entry.resource);
		const discardEntry = (sessionId: string, entry: PendingWarmedQuery) =>
			Effect.gen(function* () {
				if (pending.get(sessionId) !== entry) return;
				pending.delete(sessionId);
				yield* Deferred.fail(
					entry.ready,
					new ClaudeBoundaryError({
						operation: "discardPreWarm",
						cause: new Error("Unused Claude query discarded"),
					}),
				);
				yield* FiberMap.remove(initializing, entry.initializingKey);
				yield* close(entry);
			}).pipe(Effect.uninterruptible);
		const owner: ClaudeWarmedQueryOwner = {
			preWarmEffect: (
				input,
				settings,
				shellEnv,
				bridge,
				inheritedSettingsFrozen = false,
			) =>
				Effect.gen(function* () {
					const entry = yield* lock.withPermits(1)(
						Effect.gen(function* () {
							if (closing)
								return yield* Effect.fail(
									new ClaudeRuntimeError({
										message: "Claude query owner is shutting down",
									}),
								);
							const existing = pending.get(input.sessionId);
							if (existing) {
								if (
									sameClaudeLogin(existing.login, {
										...input,
										root: input.workspaceRoot,
									})
								)
									return existing;
								yield* discardEntry(input.sessionId, existing);
							}
							let inheritedSettings: string | undefined;
							let context: ClaudeSessionContext | undefined;
							const canUseTool: CanUseTool = async (...args) =>
								context
									? bridge.canUseTool(context, ...args)
									: {
											behavior: "deny",
											message: "Claude session is not ready",
										};
							const empty = yield* makeClaudeEmptyQuery(
								(params) =>
									input.clearInheritedGoal
										? makeClaudeForkQuery(
												(prompt) => queryFactory({ ...params, prompt }),
												params.prompt,
												input,
												readGoalStatus,
												(nativeId) =>
													onNativeSessionId?.(input.sessionId, nativeId),
											)
										: queryFactory(params),
								(abortController) => {
									const options = buildClaudeQueryOptions(
										input,
										abortController,
										canUseTool,
										settings,
										shellEnv,
									);
									inheritedSettings = inheritedSettingsFingerprint(
										options,
										input.configDir,
									);
									return options;
								},
								input,
								prepareQuery ? () => prepareQuery(input) : undefined,
							);
							const resource: WarmedClaudeQuery = {
								...empty,
								bindContext: (ctx) => {
									context = ctx;
								},
							};
							const created: PendingWarmedQuery = {
								initializingKey: Symbol(),
								resource,
								login: { ...input, root: input.workspaceRoot },
								inheritedSettings,
								inheritedSettingsFrozen,
								ready: yield* Deferred.make<
									WarmedClaudeQuery,
									ClaudeAdapterError
								>(),
							};
							pending.set(input.sessionId, created);
							yield* FiberMap.run(
								initializing,
								created.initializingKey,
								Effect.tryPromise({
									try: () => resource.query.initializationResult(),
									catch: (cause) =>
										cause instanceof ClaudeResumeRefused
											? cause
											: new ClaudeBoundaryError({
													operation: "preWarm",
													cause,
												}),
								}).pipe(
									Effect.timeoutOrElse({
										duration: "10 seconds",
										orElse: () =>
											Effect.fail(
												new ClaudeRuntimeError({
													message: "Claude pre-warm initialization timed out",
												}),
											),
									}),
									Effect.onExit((exit) =>
										Effect.gen(function* () {
											if (Exit.isSuccess(exit)) {
												yield* Deferred.succeed(created.ready, resource);
											} else {
												if (pending.get(input.sessionId) === created) {
													pending.delete(input.sessionId);
													yield* close(created);
												}
												yield* Deferred.failCause(created.ready, exit.cause);
											}
										}),
									),
									Effect.ignore,
								),
							);
							return created;
						}).pipe(Effect.uninterruptible),
					);
					yield* Deferred.await(entry.ready);
				}),
			takeEffect: (sessionId, options, login) =>
				Effect.gen(function* () {
					const entry = yield* lock.withPermits(1)(
						Effect.sync(() => pending.get(sessionId)),
					);
					if (!entry) return;
					if (
						!sameClaudeLogin(entry.login, login) ||
						!isDeepStrictEqual(
							immutableOptions(entry.resource.options),
							immutableOptions(options),
						)
					) {
						yield* discardEntry(sessionId, entry);
						return;
					}
					const resource = yield* Deferred.await(entry.ready).pipe(
						Effect.catch((error) =>
							error instanceof ClaudeBoundaryError &&
							error.operation === "discardPreWarm"
								? Effect.fail(error)
								: Effect.succeed(undefined),
						),
					);
					if (!resource || pending.get(sessionId) !== entry) return;
					if (
						!entry.inheritedSettingsFrozen &&
						(entry.inheritedSettings === undefined ||
							entry.inheritedSettings !==
								inheritedSettingsFingerprint(options, login.configDir))
					) {
						yield* discardEntry(sessionId, entry);
						return;
					}
					pending.delete(sessionId);
					return resource;
				}),
			discardEffect: (sessionId) =>
				lock.withPermits(1)(
					Effect.suspend(() => {
						const entry = pending.get(sessionId);
						return entry ? discardEntry(sessionId, entry) : Effect.void;
					}),
				),
			clearEffect: () =>
				lock.withPermits(1)(
					Effect.suspend(() => {
						closing = true;
						return Effect.forEach(
							[...pending],
							([sessionId, entry]) => discardEntry(sessionId, entry),
							{ discard: true },
						);
					}),
				),
		};
		yield* Effect.addFinalizer(() => owner.clearEffect());
		return owner;
	});

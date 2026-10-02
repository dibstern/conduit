import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import { Deferred, Effect, Exit, FiberMap } from "effect";
import {
	type ClaudeAdapterError,
	ClaudeBoundaryError,
	ClaudeRuntimeError,
} from "../event-sink-errors.js";
import type { PreWarmSessionInput } from "../types.js";
import type { ClaudePermissionBridge } from "./claude-permission-bridge.js";
import type { ClaudeProviderInstanceDeps } from "./claude-provider-runtime.js";
import { buildClaudeQueryOptions } from "./claude-query-options.js";
import { makeEffectPromptQueue } from "./effect-prompt-queue.js";
import type {
	CanUseTool,
	ClaudeSessionContext,
	PromptQueueController,
	Query,
	Options as SDKOptions,
} from "./types.js";

export interface WarmedClaudeQuery {
	readonly query: Query;
	readonly promptQueue: PromptQueueController;
	readonly options: SDKOptions;
	readonly abortController: AbortController;
	bindContext(context: ClaudeSessionContext): void;
}

interface PendingWarmedQuery {
	readonly resource: WarmedClaudeQuery;
	readonly ready: Deferred.Deferred<WarmedClaudeQuery, ClaudeAdapterError>;
	readonly inheritedSettings: string | undefined;
}

export interface ClaudeWarmedQueryOwner {
	preWarmEffect(
		input: PreWarmSessionInput,
		settings: Settings | undefined,
		shellEnv: Readonly<Record<string, string | undefined>> | undefined,
		bridge: ClaudePermissionBridge,
	): Effect.Effect<void, ClaudeAdapterError>;
	takeEffect(
		sessionId: string,
		options: SDKOptions,
	): Effect.Effect<WarmedClaudeQuery | undefined, ClaudeAdapterError>;
	discardEffect(sessionId: string): Effect.Effect<void>;
	clearEffect(): Effect.Effect<void>;
}

function immutableOptions(options: SDKOptions) {
	const {
		abortController: _abort,
		canUseTool: _permission,
		...launch
	} = options;
	return launch;
}

/** File metadata is cheap to recheck once, without resolving settings on a send. */
function inheritedSettingsFingerprint(options: SDKOptions): string | undefined {
	try {
		const cwd = resolve(options.cwd ?? process.cwd());
		const configDir = resolve(
			cwd,
			options.env?.["CLAUDE_CONFIG_DIR"] ??
				join(options.env?.["HOME"] ?? homedir(), ".claude"),
		);
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
) =>
	Effect.gen(function* () {
		const initializing = yield* FiberMap.make<PendingWarmedQuery, void>();
		const lock = yield* Effect.makeSemaphore(1);
		const pending = new Map<string, PendingWarmedQuery>();
		let closing = false;
		const close = (entry: PendingWarmedQuery) =>
			Effect.gen(function* () {
				// A stopped SDK iterator can already have shut down its queue.
				yield* Effect.exit(entry.resource.promptQueue.close());
				entry.resource.abortController.abort();
				yield* Effect.try(() => entry.resource.query.close()).pipe(
					Effect.ignore,
				);
			});
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
				yield* FiberMap.remove(initializing, entry);
				yield* close(entry);
			}).pipe(Effect.uninterruptible);
		const owner: ClaudeWarmedQueryOwner = {
			preWarmEffect: (input, settings, shellEnv, bridge) =>
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
							if (existing) return existing;
							const promptQueue = yield* makeEffectPromptQueue();
							const abortController = new AbortController();
							let inheritedSettings: string | undefined;
							let context: ClaudeSessionContext | undefined;
							const canUseTool: CanUseTool = async (...args) =>
								context
									? bridge.canUseTool(context, ...args)
									: {
											behavior: "deny",
											message: "Claude session is not ready",
										};
							const resource = yield* Effect.try({
								try: () => {
									const options = buildClaudeQueryOptions(
										input,
										abortController,
										canUseTool,
										settings,
										shellEnv,
									);
									inheritedSettings = inheritedSettingsFingerprint(options);
									return {
										promptQueue,
										abortController,
										options,
										query: queryFactory({ prompt: promptQueue, options }),
										bindContext: (ctx: ClaudeSessionContext) => {
											context = ctx;
										},
									};
								},
								catch: (cause) =>
									new ClaudeBoundaryError({ operation: "preWarm", cause }),
							}).pipe(
								Effect.onError(() =>
									promptQueue
										.close()
										.pipe(
											Effect.andThen(
												Effect.sync(() => abortController.abort()),
											),
										),
								),
							);
							const created: PendingWarmedQuery = {
								resource,
								inheritedSettings,
								ready: yield* Deferred.make<
									WarmedClaudeQuery,
									ClaudeAdapterError
								>(),
							};
							pending.set(input.sessionId, created);
							yield* FiberMap.run(
								initializing,
								created,
								Effect.tryPromise({
									try: () => resource.query.initializationResult(),
									catch: (cause) =>
										new ClaudeBoundaryError({ operation: "preWarm", cause }),
								}).pipe(
									Effect.timeoutFail({
										duration: "10 seconds",
										onTimeout: () =>
											new ClaudeRuntimeError({
												message: "Claude pre-warm initialization timed out",
											}),
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
			takeEffect: (sessionId, options) =>
				Effect.gen(function* () {
					const entry = yield* lock.withPermits(1)(
						Effect.sync(() => pending.get(sessionId)),
					);
					if (!entry) return;
					if (
						!isDeepStrictEqual(
							immutableOptions(entry.resource.options),
							immutableOptions(options),
						)
					) {
						yield* discardEntry(sessionId, entry);
						return;
					}
					const resource = yield* Deferred.await(entry.ready).pipe(
						Effect.catchAll((error) =>
							error instanceof ClaudeBoundaryError &&
							error.operation === "discardPreWarm"
								? Effect.fail(error)
								: Effect.succeed(undefined),
						),
					);
					if (!resource || pending.get(sessionId) !== entry) return;
					if (
						entry.inheritedSettings === undefined ||
						entry.inheritedSettings !== inheritedSettingsFingerprint(options)
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

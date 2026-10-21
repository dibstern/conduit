import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	HashMap,
	Layer,
	Option,
	Ref,
	Schema,
	Semaphore,
} from "effect";
import * as Failure from "../../effect/failure-classification.js";
import { ClaudeBoundaryError } from "../event-sink-errors.js";
import type { ProviderCall } from "../types.js";
import type { ProbeResult } from "./claude-capabilities-probe.js";
import {
	type ProbeDeps,
	probeClaudeCapabilities,
} from "./claude-capabilities-probe.js";
import {
	ClaudeConfigDirSchema,
	type ClaudeLaunchConfig,
} from "./claude-sdk-env.js";

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const ContextWindowOptionSchema = Schema.Struct({
	value: Schema.String,
	label: Schema.String,
	isDefault: Schema.optionalKey(Schema.Boolean),
});

const CacheFileSchema = Schema.Struct({
	version: Schema.Literal(1),
	workspaceRoot: Schema.String,
	configDir: ClaudeConfigDirSchema,
	probedAt: Schema.Number,
	result: Schema.Struct({
		models: Schema.Array(
			Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				providerId: Schema.String,
				resolvedModel: Schema.optionalKey(Schema.String),
				limit: Schema.optionalKey(
					Schema.Struct({
						context: Schema.optionalKey(Schema.Number),
						output: Schema.optionalKey(Schema.Number),
					}),
				),
				variants: Schema.optionalKey(
					Schema.Record(
						Schema.String,
						Schema.Record(Schema.String, Schema.Unknown),
					),
				),
				routingOptions: Schema.optionalKey(
					Schema.Array(ContextWindowOptionSchema),
				),
				contextWindowOptions: Schema.optionalKey(
					Schema.Array(ContextWindowOptionSchema),
				),
			}),
		),
		subscriptionType: Schema.optionalKey(Schema.String),
		commands: Schema.Array(
			Schema.Struct({
				name: Schema.String,
				description: Schema.optionalKey(Schema.String),
				args: Schema.optionalKey(Schema.String),
				source: Schema.Literals([
					"builtin",
					"user-command",
					"project-command",
					"user-skill",
					"project-skill",
					"plugin-skill",
					"sdk",
				]),
			}),
		),
		agents: Schema.Array(
			Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				description: Schema.optionalKey(Schema.String),
				model: Schema.optionalKey(Schema.String),
			}),
		),
	}),
});

type AssertExtends<_A extends B, B> = true;
type _CachedResultFitsProbeResult = AssertExtends<
	typeof CacheFileSchema.Type.result,
	ProbeResult
>;

const decodeCacheFile = Schema.decodeUnknownEffect(
	Schema.fromJsonString(CacheFileSchema),
);

interface CacheEntry {
	readonly expiresAt: number;
	readonly value?: ProbeResult;
	readonly inFlight?: Deferred.Deferred<ProbeResult, ClaudeBoundaryError>;
}

const instrumentCapabilityProbe = <A, E, R>(
	workspaceRoot: string,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
	const attributes = { providerId: "claude", workspaceRoot };
	return effect.pipe(
		Effect.annotateLogs(attributes),
		Effect.withSpan("claude.capabilities.probe", { attributes }),
	);
};

export interface ClaudeCapabilitiesService {
	/** Serves cached capabilities; refresh waits for a shared probe and propagates failure. */
	readonly get: (
		workspaceRoot: string,
		options?: { readonly refresh?: boolean; readonly call?: ProviderCall },
	) => Effect.Effect<ProbeResult, ClaudeBoundaryError>;
}

export class ClaudeCapabilitiesServiceTag extends Context.Service<
	ClaudeCapabilitiesServiceTag,
	ClaudeCapabilitiesService
>()("ClaudeCapabilitiesService") {}

export interface ClaudeCapabilitiesServiceDeps {
	readonly launchConfig: () => ClaudeLaunchConfig;
	readonly queryFactory?: ProbeDeps["queryFactory"];
	readonly ttlMs?: number;
	readonly cacheDir?: string;
}

const makeClaudeCapabilitiesServiceWithCache = (
	cacheRef: Ref.Ref<HashMap.HashMap<string, CacheEntry>>,
	lock: Semaphore.Semaphore,
	deps: ClaudeCapabilitiesServiceDeps,
): ClaudeCapabilitiesService => {
	const ttlMs = deps.ttlMs ?? CAPABILITY_CACHE_TTL_MS;
	const cacheDir = deps.cacheDir;

	const get: ClaudeCapabilitiesService["get"] = (workspaceRoot, options) =>
		instrumentCapabilityProbe(
			workspaceRoot,
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const refresh = options?.refresh === true;
					const call = options?.call;
					const launch = yield* Effect.try({
						try: () =>
							call?.account.driver === "claude"
								? {
										configDir: call.account.folder,
										folderSource: "account" as const,
									}
								: deps.launchConfig(),
						catch: (cause) =>
							new ClaudeBoundaryError({
								operation: "probeCapabilities",
								cause,
							}),
					});
					const configPath = resolve(workspaceRoot, launch.configDir.path);
					const key = [
						launch.configDir._tag,
						configPath,
						workspaceRoot,
						...(call
							? [
									JSON.stringify([
										call.projectId,
										call.account.id,
										Object.entries(call.shellEnv).sort(),
										Object.entries(call.account.env ?? {}).sort(),
										call.extraFolders,
									]),
								]
							: []),
					].join("\0");
					const file =
						cacheDir === undefined
							? undefined
							: join(
									cacheDir,
									`${createHash("sha256").update(key).digest("hex")}.json`,
								);

					const lookup = yield* lock.withPermits(1)(
						Effect.gen(function* () {
							const state = yield* Ref.get(cacheRef);
							let existing = Option.getOrUndefined(HashMap.get(state, key));
							let fromDisk = false;
							if (existing === undefined && file !== undefined) {
								const persisted = yield* Effect.tryPromise(() =>
									readFile(file, "utf8"),
								).pipe(Effect.flatMap(decodeCacheFile), Effect.option);
								if (Option.isSome(persisted)) {
									const entry = persisted.value;
									if (
										entry.workspaceRoot === workspaceRoot &&
										entry.configDir._tag === launch.configDir._tag &&
										resolve(workspaceRoot, entry.configDir.path) === configPath
									) {
										// Always stale: a daemon restart is how users pick up
										// new plugins and conduit changes, so it must refresh.
										const seeded = { value: entry.result, expiresAt: 0 };
										existing = seeded;
										yield* Ref.update(cacheRef, (cache) =>
											HashMap.set(cache, key, seeded),
										);
										fromDisk = true;
									}
								}
							}

							const now = yield* Clock.currentTimeMillis;
							yield* Effect.annotateCurrentSpan(
								"cache",
								refresh
									? "refresh"
									: fromDisk
										? "disk"
										: existing?.value
											? existing.expiresAt > now
												? "fresh"
												: "stale"
											: "miss",
							);
							if (
								!refresh &&
								existing?.value &&
								(existing.expiresAt > now || existing.inFlight)
							) {
								return { _tag: "Cached" as const, value: existing.value };
							}
							if (existing?.inFlight) {
								return {
									_tag: "InFlight" as const,
									inFlight: existing.inFlight,
								};
							}

							const inFlight = yield* Deferred.make<
								ProbeResult,
								ClaudeBoundaryError
							>();
							yield* Ref.update(cacheRef, (cache) =>
								HashMap.set(cache, key, {
									...existing,
									expiresAt: existing?.expiresAt ?? 0,
									inFlight,
								}),
							);
							return {
								_tag: "Probe" as const,
								inFlight,
								staleValue: existing?.value,
							};
						}),
					);
					if (lookup._tag === "Cached") return lookup.value;
					if (lookup._tag === "InFlight")
						return yield* restore(Deferred.await(lookup.inFlight));

					const { inFlight, staleValue } = lookup;
					const probe = restore(
						Effect.tryPromise({
							try: () =>
								probeClaudeCapabilities({
									workspaceRoot,
									...launch,
									...(call
										? {
												baseEnv: call.shellEnv,
												extraFolders: call.extraFolders,
											}
										: {}),
									...(call?.account.env
										? { accountEnv: call.account.env }
										: {}),
									...(deps.queryFactory
										? { queryFactory: deps.queryFactory }
										: {}),
								}),
							catch: (cause) =>
								new ClaudeBoundaryError({
									operation: "probeCapabilities",
									cause,
								}),
						}),
					).pipe(
						Effect.tap((value) =>
							Effect.gen(function* () {
								const probedAt = yield* Clock.currentTimeMillis;
								yield* Ref.update(cacheRef, (cache) =>
									HashMap.set(cache, key, {
										value,
										expiresAt: probedAt + ttlMs,
									}),
								);
								// An empty catalogue means the probe found nothing; keep the last
								// one, which is what the next start serves while it refreshes.
								if (
									cacheDir !== undefined &&
									file !== undefined &&
									value.models.length > 0
								) {
									yield* Effect.tryPromise(async () => {
										await mkdir(cacheDir, { recursive: true });
										const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
										await writeFile(
											temp,
											JSON.stringify({
												version: 1,
												workspaceRoot,
												configDir: launch.configDir,
												probedAt,
												result: value,
											}),
										);
										await rename(temp, file);
									}).pipe(
										Effect.catch((cause) =>
											Effect.logWarning(
												"Failed to persist Claude capabilities",
												cause,
											),
										),
									);
								}
								yield* Deferred.succeed(inFlight, value);
							}),
						),
						Effect.onExit((exit) =>
							Exit.isFailure(exit)
								? Effect.gen(function* () {
										const error = Option.getOrElse(
											Failure.firstFailure(exit.cause),
											() =>
												new ClaudeBoundaryError({
													operation: "probeCapabilities",
													cause: Failure.squashCause(exit.cause),
												}),
										);
										const failedAt = yield* Clock.currentTimeMillis;
										yield* Ref.update(cacheRef, (cache) =>
											Option.getOrUndefined(HashMap.get(cache, key))
												?.inFlight === inFlight
												? staleValue
													? HashMap.set(cache, key, {
															value: staleValue,
															expiresAt: failedAt + ttlMs,
														})
													: HashMap.remove(cache, key)
												: cache,
										);
										yield* Deferred.fail(inFlight, error);
										if (staleValue)
											yield* Effect.logWarning(
												"Failed to refresh Claude capabilities",
												error,
											);
									})
								: Effect.void,
						),
					);
					if (staleValue && !refresh) {
						// The service has no Scope; the daemon refresh is bounded by the probe's own abort.
						yield* probe.pipe(
							Effect.withSpan("claude.capabilities.refresh", {
								attributes: {
									providerId: "claude",
									workspaceRoot,
									cache: "stale",
								},
							}),
							Effect.catchCause(() => Effect.void),
							Effect.forkDetach,
						);
						return staleValue;
					}
					return yield* probe;
				}),
			),
		);

	return { get };
};

export const makeClaudeCapabilitiesService = (
	deps: ClaudeCapabilitiesServiceDeps,
): Effect.Effect<ClaudeCapabilitiesService> =>
	Effect.gen(function* () {
		const cacheRef = yield* Ref.make(HashMap.empty<string, CacheEntry>());
		const lock = yield* Semaphore.make(1);
		if (deps.cacheDir !== undefined) {
			const cacheDir = deps.cacheDir;
			yield* Effect.tryPromise(async () => {
				const cutoff = Date.now() - CACHE_MAX_AGE_MS;
				const files = await readdir(cacheDir, { withFileTypes: true });
				await Promise.allSettled(
					files
						.filter(
							(file) =>
								file.isFile() &&
								(file.name.endsWith(".json") || file.name.endsWith(".tmp")),
						)
						.map(async (file) => {
							const path = join(cacheDir, file.name);
							if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
						}),
				);
			}).pipe(Effect.ignore, Effect.forkDetach);
		}
		return makeClaudeCapabilitiesServiceWithCache(cacheRef, lock, deps);
	});

export const ClaudeCapabilitiesServiceLive = (
	deps: ClaudeCapabilitiesServiceDeps,
): Layer.Layer<ClaudeCapabilitiesServiceTag> =>
	Layer.effect(
		ClaudeCapabilitiesServiceTag,
		makeClaudeCapabilitiesService(deps),
	);

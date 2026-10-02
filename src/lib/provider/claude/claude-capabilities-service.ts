import {
	Cause,
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	HashMap,
	Layer,
	Option,
	Ref,
} from "effect";
import { ClaudeBoundaryError } from "../event-sink-errors.js";
import type { ProbeResult } from "./claude-capabilities-probe.js";
import {
	type ProbeDeps,
	probeClaudeCapabilities,
} from "./claude-capabilities-probe.js";

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

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
	readonly get: (
		workspaceRoot: string,
	) => Effect.Effect<ProbeResult, ClaudeBoundaryError>;
}

export class ClaudeCapabilitiesServiceTag extends Context.Tag(
	"ClaudeCapabilitiesService",
)<ClaudeCapabilitiesServiceTag, ClaudeCapabilitiesService>() {}

export interface ClaudeCapabilitiesServiceDeps {
	readonly queryFactory?: ProbeDeps["queryFactory"];
	readonly ttlMs?: number;
}

const makeClaudeCapabilitiesServiceWithCache = (
	cacheRef: Ref.Ref<HashMap.HashMap<string, CacheEntry>>,
	deps: ClaudeCapabilitiesServiceDeps,
): ClaudeCapabilitiesService => {
	const ttlMs = deps.ttlMs ?? CAPABILITY_CACHE_TTL_MS;

	const get = (workspaceRoot: string) =>
		instrumentCapabilityProbe(
			workspaceRoot,
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				const state = yield* Ref.get(cacheRef);
				const existing = Option.getOrUndefined(
					HashMap.get(state, workspaceRoot),
				);

				if (existing?.value && existing.expiresAt > now) {
					return existing.value;
				}
				if (existing?.inFlight) {
					return yield* Deferred.await(existing.inFlight);
				}

				const inFlight = yield* Deferred.make<
					ProbeResult,
					ClaudeBoundaryError
				>();
				const result = yield* Ref.update(cacheRef, (cache) =>
					HashMap.set(cache, workspaceRoot, {
						expiresAt: 0,
						inFlight,
					}),
				).pipe(
					Effect.zipRight(
						Effect.tryPromise({
							try: () =>
								probeClaudeCapabilities({
									workspaceRoot,
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
					),
					Effect.tap((value) =>
						Ref.update(cacheRef, (cache) =>
							HashMap.set(cache, workspaceRoot, {
								expiresAt: now + ttlMs,
								value,
							}),
						),
					),
					Effect.tap((value) =>
						Deferred.succeed(inFlight, value).pipe(Effect.ignore),
					),
					Effect.onExit((exit) =>
						Exit.isFailure(exit)
							? Effect.gen(function* () {
									const error = Option.getOrElse(
										Cause.failureOption(exit.cause),
										() =>
											new ClaudeBoundaryError({
												operation: "probeCapabilities",
												cause: Cause.squash(exit.cause),
											}),
									);
									yield* Ref.update(cacheRef, (cache) =>
										Option.getOrUndefined(HashMap.get(cache, workspaceRoot))
											?.inFlight === inFlight
											? HashMap.remove(cache, workspaceRoot)
											: cache,
									);
									yield* Deferred.fail(inFlight, error);
								})
							: Effect.void,
					),
				);

				return result;
			}),
		);

	return { get };
};

export const makeClaudeCapabilitiesService = (
	deps: ClaudeCapabilitiesServiceDeps = {},
): Effect.Effect<ClaudeCapabilitiesService> =>
	Effect.gen(function* () {
		const cacheRef = yield* Ref.make(HashMap.empty<string, CacheEntry>());
		return makeClaudeCapabilitiesServiceWithCache(cacheRef, deps);
	});

export const ClaudeCapabilitiesServiceLive = (
	deps: ClaudeCapabilitiesServiceDeps = {},
): Layer.Layer<ClaudeCapabilitiesServiceTag> =>
	Layer.effect(
		ClaudeCapabilitiesServiceTag,
		makeClaudeCapabilitiesService(deps),
	);

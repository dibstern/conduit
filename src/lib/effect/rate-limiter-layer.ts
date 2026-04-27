// ─── RateLimiter Effect Layer ───────────────────────────────────────────────
// Sliding window token bucket. Uses HashMap for per-IP buckets.
// Background cleanup fiber evicts stale entries every 60s.

import {
	Context,
	Duration,
	Effect,
	HashMap,
	Layer,
	Ref,
	Schedule,
} from "effect";

/** Result from a rate-limit check. */
export interface RateLimitResult {
	/** Whether the request is allowed. */
	allowed: boolean;
	/** If rejected, how many ms until the next slot opens. */
	retryAfterMs?: number;
}

interface RateLimiterService {
	checkLimit: (ip: string) => Effect.Effect<RateLimitResult>;
}

export class RateLimiterTag extends Context.Tag("RateLimiter")<
	RateLimiterTag,
	RateLimiterService
>() {}

interface BucketEntry {
	tokens: ReadonlyArray<number>;
}

interface RateLimiterState {
	buckets: HashMap.HashMap<string, BucketEntry>;
}

interface RateLimiterConfig {
	maxRequests: number;
	windowMs: number;
}

const tryConsume =
	(ip: string, config: RateLimiterConfig, now: number) =>
	(state: RateLimiterState): [RateLimitResult, RateLimiterState] => {
		const existing = HashMap.get(state.buckets, ip);
		const entry =
			existing._tag === "Some" ? existing.value : { tokens: [] as number[] };
		const validTokens = entry.tokens.filter((t) => now - t < config.windowMs);
		if (validTokens.length >= config.maxRequests) {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			const oldest = validTokens[0]!;
			const retryAfterMs = oldest + config.windowMs - now;
			return [
				{ allowed: false, retryAfterMs },
				{ buckets: HashMap.set(state.buckets, ip, { tokens: validTokens }) },
			];
		}
		return [
			{ allowed: true },
			{
				buckets: HashMap.set(state.buckets, ip, {
					tokens: [...validTokens, now],
				}),
			},
		];
	};

export const RateLimiterLive = (config: RateLimiterConfig) =>
	Layer.scoped(
		RateLimiterTag,
		Effect.gen(function* () {
			const state = yield* Ref.make<RateLimiterState>({
				buckets: HashMap.empty(),
			});

			// Cleanup stale entries every 60s
			yield* Effect.sync(() => Date.now()).pipe(
				Effect.flatMap((now) =>
					Ref.update(state, (s) => {
						let buckets = HashMap.empty<string, BucketEntry>();
						for (const [ip, entry] of HashMap.toEntries(s.buckets)) {
							const valid = entry.tokens.filter(
								(t) => now - t < config.windowMs,
							);
							if (valid.length > 0)
								buckets = HashMap.set(buckets, ip, { tokens: valid });
						}
						return { buckets };
					}),
				),
				Effect.repeat(Schedule.spaced(Duration.minutes(1))),
				Effect.forkScoped,
			);

			return {
				checkLimit: (ip: string) =>
					Effect.sync(() => Date.now()).pipe(
						Effect.flatMap((now) =>
							Ref.modify(state, tryConsume(ip, config, now)),
						),
					),
			};
		}),
	);

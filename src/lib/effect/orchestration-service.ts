// ─── OrchestrationEngine Service (Effect) ─────────────────────────────────────
// Pure Effect orchestration layer with idempotency-based deduplication.
// Commands are routed to a Provider, and repeated command IDs are rejected
// via a Ref-backed idempotency set with TTL-based background eviction.
//
// Uses native Map (not HashMap) — insertion-order iteration for TTL eviction.

import { Context, Duration, Effect, Layer, Ref, Schedule } from "effect";

// ─── Idempotency state ────────────────────────────────────────────────────────

interface IdempotencyEntry {
	id: string;
	addedAt: number;
}

interface IdempotencyState {
	entries: Map<string, IdempotencyEntry>;
}

export class IdempotencySetTag extends Context.Tag("IdempotencySet")<
	IdempotencySetTag,
	Ref.Ref<IdempotencyState>
>() {}

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes
const EVICTION_INTERVAL = Duration.minutes(1);

export const makeIdempotencySetLive = (): Layer.Layer<IdempotencySetTag> =>
	Layer.scoped(
		IdempotencySetTag,
		Effect.gen(function* () {
			const ref = yield* Ref.make<IdempotencyState>({
				entries: new Map(),
			});

			// Background eviction fiber — removes expired entries every minute
			yield* Effect.sync(() => Date.now()).pipe(
				Effect.flatMap((now) =>
					Ref.update(ref, (s) => {
						const entries = new Map<string, IdempotencyEntry>();
						for (const [id, entry] of s.entries) {
							if (now - entry.addedAt < IDEMPOTENCY_TTL_MS) {
								entries.set(id, entry);
							}
						}
						return { entries };
					}),
				),
				Effect.repeat(Schedule.spaced(EVICTION_INTERVAL)),
				Effect.forkScoped,
			);

			return ref;
		}),
	);

// ─── Command routing ──────────────────────────────────────────────────────────

export interface Command {
	id: string;
	type: string;
	payload: unknown;
}

export interface Provider {
	execute: (cmd: Command) => Effect.Effect<unknown>;
}

export const routeCommand = (cmd: Command, provider: Provider) =>
	Effect.gen(function* () {
		const seenRef = yield* IdempotencySetTag;
		const now = Date.now();

		const isDuplicate = yield* Ref.modify(seenRef, (s) => {
			if (s.entries.has(cmd.id)) return [true, s];
			const entries = new Map(s.entries);
			entries.set(cmd.id, { id: cmd.id, addedAt: now });
			return [false, { entries }];
		});

		if (isDuplicate) return { deduplicated: true };
		return yield* provider.execute(cmd);
	});

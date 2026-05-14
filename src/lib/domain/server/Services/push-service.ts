// ─── Push Notification Service ──────────────────────────────────────────────
// Bounded-concurrency broadcast with per-send failure isolation.
// Uses Ref<Map> for subscription tracking — native Map is a documented
// exception here since values are iterated for broadcast fan-out.

import { Context, Effect, Layer, Ref } from "effect";

export interface PushSubscription {
	id: string;
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

interface PushPayload {
	title: string;
	body: string;
}

interface PushService {
	subscribe: (sub: PushSubscription) => Effect.Effect<void>;
	unsubscribe: (id: string) => Effect.Effect<void>;
	broadcast: (payload: PushPayload) => Effect.Effect<void>;
}

export class PushManagerTag extends Context.Tag("PushManager")<
	PushManagerTag,
	PushService
>() {}

interface PushManagerConfig {
	sendPush: (
		sub: PushSubscription,
		payload: PushPayload,
	) => Effect.Effect<void, Error>;
}

export const PushManagerLive = (config: PushManagerConfig) =>
	Layer.scoped(
		PushManagerTag,
		Effect.gen(function* () {
			const subscriptions = yield* Ref.make<Map<string, PushSubscription>>(
				new Map(),
			);

			return {
				subscribe: (sub: PushSubscription) =>
					Ref.update(subscriptions, (m) => {
						const next = new Map(m);
						next.set(sub.id, sub);
						return next;
					}),

				unsubscribe: (id: string) =>
					Ref.update(subscriptions, (m) => {
						const next = new Map(m);
						next.delete(id);
						return next;
					}),

				broadcast: (payload: PushPayload) =>
					Effect.gen(function* () {
						const subs = yield* Ref.get(subscriptions);
						yield* Effect.forEach(
							[...subs.values()],
							(sub) =>
								config
									.sendPush(sub, payload)
									.pipe(
										Effect.catchAll((e) =>
											Effect.logWarning(`Push send failed for ${sub.id}: ${e}`),
										),
									),
							{ concurrency: 10, discard: true },
						);
					}),
			};
		}),
	);

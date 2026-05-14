// ─── Push Notification Service ──────────────────────────────────────────────
// Bounded-concurrency broadcast with per-send failure isolation.
// Uses Ref<Map> for subscription tracking — native Map is a documented
// exception here since values are iterated for broadcast fan-out.

import { Context, Effect, Layer, Option, Ref } from "effect";
import {
	PushNotificationManager,
	type PushNotificationSender,
	type PushPayload,
	type PushSubscriptionData,
} from "../../../server/push.js";

export interface PushSubscription {
	id: string;
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

interface PushService {
	subscribe: (sub: PushSubscription) => Effect.Effect<void>;
	unsubscribe: (id: string) => Effect.Effect<void>;
	broadcast: (payload: PushPayload) => Effect.Effect<void>;
	getPublicKey: Effect.Effect<string | undefined>;
	addSubscription: (
		endpoint: string,
		subscription: PushSubscriptionData,
	) => Effect.Effect<void>;
	removeSubscription: (endpoint: string) => Effect.Effect<void>;
	sendToAll: (payload: PushPayload) => Effect.Effect<void>;
	getLegacyManager: Effect.Effect<Option.Option<PushNotificationSender>>;
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
				getPublicKey: Effect.succeed(undefined),
				addSubscription: (endpoint, subscription) =>
					Ref.update(subscriptions, (m) => {
						const next = new Map(m);
						next.set(endpoint, {
							id: endpoint,
							endpoint,
							keys: {
								p256dh: subscription.keys?.p256dh ?? "",
								auth: subscription.keys?.auth ?? "",
							},
						});
						return next;
					}),
				removeSubscription: (endpoint) =>
					Ref.update(subscriptions, (m) => {
						const next = new Map(m);
						next.delete(endpoint);
						return next;
					}),
				sendToAll: (payload) =>
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
				getLegacyManager: Effect.succeed(Option.none()),
			};
		}),
	);

const disabledPushManager: PushService = {
	subscribe: () => Effect.void,
	unsubscribe: () => Effect.void,
	broadcast: () => Effect.void,
	getPublicKey: Effect.succeed(undefined),
	addSubscription: () => Effect.void,
	removeSubscription: () => Effect.void,
	sendToAll: () => Effect.void,
	getLegacyManager: Effect.succeed(Option.none()),
};

export const PushNotificationManagerLive = (configDir: string) =>
	Layer.effect(
		PushManagerTag,
		Effect.gen(function* () {
			const maybeManager = yield* Effect.tryPromise({
				try: async () => {
					const manager = new PushNotificationManager({ configDir });
					await manager.init();
					return manager;
				},
				catch: (cause) => cause,
			}).pipe(
				Effect.tapError((cause) =>
					Effect.logWarning(`Push notifications unavailable: ${String(cause)}`),
				),
				Effect.option,
			);

			if (Option.isNone(maybeManager)) {
				return disabledPushManager;
			}

			const manager = maybeManager.value;
			return {
				subscribe: (sub: PushSubscription) =>
					Effect.sync(() =>
						manager.addSubscription(sub.id, {
							endpoint: sub.endpoint,
							keys: sub.keys,
						}),
					),
				unsubscribe: (id: string) =>
					Effect.sync(() => manager.removeSubscription(id)),
				broadcast: (payload: PushPayload) =>
					Effect.tryPromise(() => manager.sendToAll(payload)).pipe(
						Effect.catchAll((cause) =>
							Effect.logWarning(`Push broadcast failed: ${String(cause)}`),
						),
					),
				getPublicKey: Effect.sync(() => manager.getPublicKey() ?? undefined),
				addSubscription: (endpoint, subscription) =>
					Effect.sync(() => manager.addSubscription(endpoint, subscription)),
				removeSubscription: (endpoint) =>
					Effect.sync(() => manager.removeSubscription(endpoint)),
				sendToAll: (payload) =>
					Effect.tryPromise(() => manager.sendToAll(payload)).pipe(
						Effect.catchAll((cause) =>
							Effect.logWarning(`Push send failed: ${String(cause)}`),
						),
					),
				getLegacyManager: Effect.succeed(Option.some(manager)),
			} satisfies PushService;
		}),
	);

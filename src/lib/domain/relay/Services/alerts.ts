// Project Alerts Subscription (conduit-test-ni8.15)
// A session finished or failed while no tab was viewing it. Push covers
// subscribed browsers; this feed is the in-app ding for every open tab, which
// is the only one a browser without push gets.
//
// Live-only: an alert is an event, not state, so a subscribe opens with no
// snapshot and a reconnect or reload never re-fires one. Tabs dedupe the same
// alert across each other by alertId.

import { Context, Effect, Layer, PubSub, Stream } from "effect";
import type { Alert, AlertsEnvelope } from "../../../contracts/ws-rpc.js";

export class AlertsTag extends Context.Tag("Alerts")<
	AlertsTag,
	PubSub.PubSub<Alert>
>() {}

export const AlertsLive: Layer.Layer<AlertsTag> = Layer.effect(
	AlertsTag,
	PubSub.unbounded<Alert>(),
);

export const publishAlert = (alert: Alert) =>
	Effect.flatMap(AlertsTag, (alerts) => PubSub.publish(alerts, alert));

export const subscribeAlerts = (): Stream.Stream<
	AlertsEnvelope,
	never,
	AlertsTag
> =>
	Stream.unwrapScoped(
		Effect.map(Effect.flatMap(AlertsTag, PubSub.subscribe), (dequeue) =>
			Stream.concat(
				Stream.make<AlertsEnvelope[]>({ _tag: "synchronized" }),
				Stream.fromQueue(dequeue),
			),
		),
	);

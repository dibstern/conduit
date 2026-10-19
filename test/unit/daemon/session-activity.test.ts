import { describe, it } from "@effect/vitest";
import { Clock, Effect, Layer, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import {
	DaemonEventBusLive,
	DaemonEventBusTag,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	makeSessionActivity,
	SessionActivityDaemonLive,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

describe("Session Activity", () => {
	it.effect(
		"signals each changed session and stays silent for unchanged state",
		() =>
			Effect.gen(function* () {
				const activity = yield* makeSessionActivity;
				const changes: string[] = [];
				const stream = yield* activity.subscribe;
				yield* stream.pipe(
					Stream.runForEach((id) => Effect.sync(() => changes.push(id))),
					Effect.forkScoped,
				);
				const background = {
					sessionId: "background",
					kind: "snapshot" as const,
					tasks: [
						{
							id: "task",
							type: "local_bash",
							description: "Watching files",
							firstSeenAt: 1,
						},
					],
				};
				activity.background.record(background);
				activity.background.record(background);
				expect(activity.background.backgroundOf("background")?.work).toBe(
					"monitoring",
				);
				activity.background.record({
					sessionId: "background",
					kind: "session-ended",
				});
				activity.background.record({
					sessionId: "background",
					kind: "session-ended",
				});

				const compaction = canonicalEvent("session.compaction", "compaction", {
					sessionId: "compaction",
					state: "started",
					detail: "Making room",
				});
				activity.compactions.observe([compaction]);
				activity.compactions.observe([compaction]);
				expect(activity.compactions.compactingOf("compaction")).toBe(
					"Making room",
				);
				activity.compactions.observe([
					canonicalEvent("session.status", "compaction", {
						sessionId: "compaction",
						status: "idle",
					}),
				]);

				const retry = canonicalEvent("session.status", "retry", {
					sessionId: "retry",
					status: "retry",
					message: "Waiting for provider",
				});
				activity.retries.observe([retry]);
				activity.retries.observe([retry]);
				expect(activity.retries.retryingOf("retry")).toBe(
					"Waiting for provider",
				);
				activity.retries.observe([
					canonicalEvent("session.status", "retry", {
						sessionId: "retry",
						status: "idle",
					}),
				]);

				activity.hintDismissals.set("hint", 7);
				activity.hintDismissals.set("hint", 7);
				activity.hintDismissals.set("hint", 8);
				activity.hintDismissals.delete("missing");
				activity.hintDismissals.delete("hint");
				activity.hintDismissals.clear();
				activity.hintDismissals.set("hint-a", 1);
				activity.hintDismissals.set("hint-b", 2);
				activity.hintDismissals.clear();
				yield* TestClock.adjust("0 millis");
				expect(changes).toEqual([
					"background",
					"background",
					"compaction",
					"compaction",
					"retry",
					"retry",
					"hint",
					"hint",
					"hint",
					"hint-a",
					"hint-b",
					"hint-a",
					"hint-b",
				]);
				expect(activity.hintDismissals.size).toBe(0);
				expect(activity.background.backgroundOf("background")).toBeUndefined();
				expect(activity.compactions.compactingOf("compaction")).toBeUndefined();
				expect(activity.retries.retryingOf("retry")).toBeUndefined();
			}),
	);

	it.effect(
		"keeps separate daemon instances isolated without a project store",
		() =>
			Effect.gen(function* () {
				const first = yield* makeSessionActivity;
				const second = yield* makeSessionActivity;
				first.background.record({
					sessionId: "same-session-id",
					kind: "snapshot",
					tasks: [{ id: "task", type: "local_bash", description: "Watching" }],
				});
				first.hintDismissals.set("same-session-id", 1);
				expect(
					second.background.backgroundOf("same-session-id"),
				).toBeUndefined();
				expect(second.hintDismissals.has("same-session-id")).toBe(false);
			}),
	);

	it.effect(
		"publishes at most once per second with a final trailing refresh during continuous changes",
		() =>
			Effect.gen(function* () {
				const activity = yield* SessionActivityTag;
				const bus = yield* DaemonEventBusTag;
				const events = yield* PubSub.subscribe(bus);
				const publishedAt: number[] = [];
				yield* Stream.fromSubscription(events).pipe(
					Stream.filter((event) => event._tag === "DaemonSessionsChanged"),
					Stream.runForEach(() =>
						Clock.currentTimeMillis.pipe(
							Effect.tap((time) => Effect.sync(() => publishedAt.push(time))),
						),
					),
					Effect.forkScoped,
				);
				activity.changed("session-b");
				yield* TestClock.adjust("0 millis");
				expect(publishedAt).toEqual([0]);
				for (let step = 0; step < 12; step++) {
					yield* TestClock.adjust("200 millis");
					activity.changed("session-b");
					yield* TestClock.adjust("0 millis");
				}
				expect(publishedAt).toEqual([0, 1000, 2000]);
				yield* TestClock.adjust("599 millis");
				expect(publishedAt).toEqual([0, 1000, 2000]);
				yield* TestClock.adjust("1 millis");
				expect(publishedAt).toEqual([0, 1000, 2000, 3000]);
				yield* TestClock.adjust("2 seconds");
				expect(publishedAt).toEqual([0, 1000, 2000, 3000]);
			}).pipe(
				Effect.provide(
					Layer.fresh(
						SessionActivityDaemonLive.pipe(
							Layer.provideMerge(
								Layer.merge(DaemonEventBusLive, SessionEventBusLive),
							),
						),
					),
				),
			),
	);
});

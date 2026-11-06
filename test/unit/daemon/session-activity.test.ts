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
import { EventDelivery } from "../../../src/lib/server/event-audiences.js";
import { publishLedgerTasks } from "../../helpers/ledger-tasks.js";

describe("Session Activity", () => {
	it.effect(
		"follows live connection Interests through overlapping holds and release",
		() =>
			Effect.gen(function* () {
				const activity = yield* makeSessionActivity;
				const first = new EventDelivery();
				const second = new EventDelivery();
				const releaseFirst = activity.watchInterests(first);
				const releaseSecond = activity.watchInterests(second);
				const interests = {
					sessions: new Set(["session-a"]),
					projects: new Set(["project-a"]),
					ptys: new Map<string, ReadonlySet<string>>(),
				};
				const firstHold = first.subscription(interests);
				const overlap = first.subscription(interests);
				second.view(interests);
				expect(activity.connectionInterests.size).toBe(2);
				expect(activity.connectionInterests.get(first)).toEqual(interests);
				firstHold.release();
				expect(activity.connectionInterests.get(first)).toEqual(interests);
				overlap.update({ ...interests, sessions: new Set(["session-b"]) });
				expect(activity.connectionInterests.get(first)?.sessions).toEqual(
					new Set(["session-b"]),
				);
				expect(activity.connectionInterests.get(second)?.sessions).toEqual(
					new Set(["session-a"]),
				);
				first.close();
				expect(activity.connectionInterests.has(first)).toBe(false);
				expect(activity.connectionInterests.size).toBe(1);
				releaseFirst();
				releaseFirst();
				releaseSecond();
				second.view(interests);
				expect(activity.connectionInterests.size).toBe(0);
				expect(activity.hasViewers("session-a")).toBe(false);
			}),
	);

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
				publishLedgerTasks(activity.background, background);
				publishLedgerTasks(activity.background, background);
				// 8.2 (CONTRACT.md 2778-2781): a shell is work.
				expect(activity.background.backgroundOf("background")?.work).toBe(
					"working",
				);
				publishLedgerTasks(activity.background, {
					sessionId: "background",
					kind: "session-ended",
				});
				publishLedgerTasks(activity.background, {
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

	// 8.7 failure modes, now read from the Run Ledger's hand-over (82tn.32.30 deletes the interim
	// copy): a session-level awaited server leaves the session idle or calm; a serving one makes an
	// idle session read busy; a task the ledger classes serving reads working; the row's server list
	// or the Preview Gate's ports drift from the ledger; a gate link moves no row.
	it.effect(
		"reads Servers and their roles from the ledger's hand-over, with the gate's link (8.7)",
		() =>
			Effect.gen(function* () {
				const activity = yield* makeSessionActivity;
				const server = {
					key: { port: 3000, pid: 600, startedAt: 1 },
					command: "node server.js",
					cwd: "/w",
					source: "declared",
					role: "serving",
				} as const;
				const none = { tag: "none" } as const;
				const hand = (
					tasks: Parameters<typeof activity.background.publish>[1],
					...servers: (typeof server | Record<string, unknown>)[]
				) =>
					activity.background.publish("s", tasks, undefined, {
						servers: new Map(
							servers.map((entry) => [3000, { ...server, ...entry }]),
						),
					});
				const read = () => ({
					background: activity.background.backgroundOf("s"),
					label: activity.background.activityOf("s", {
						approvals: 0,
						questions: 0,
					}).label,
				});
				hand(none, server);
				expect(read()).toEqual({ background: undefined, label: "background" });
				hand(none, { role: "awaited" });
				expect(read()).toEqual({
					background: { work: "working", tasks: [] },
					label: "working",
				});
				const serving = {
					tag: "live",
					label: "s-runner:1",
					tasks: [
						{
							key: { taskId: "w1" },
							taskType: "local_workflow",
							description: "Dev server",
							ambient: false,
							kind: "workflow",
							class: "serving",
						},
					],
				} as const;
				hand(serving, { taskKey: { taskId: "w1" } });
				expect(read()).toMatchObject({
					background: { work: "monitoring" },
					label: "background",
				});
				hand(serving, { taskKey: { taskId: "w1" }, role: "awaited" });
				expect(read()).toMatchObject({
					background: { work: "working" },
					label: "working",
				});
				const moved: string[] = [];
				activity.onServersMoved.add((id) => moved.push(id));
				activity.gateUrls.set(3000, "https://box.ts.net:3000");
				expect(activity.background.ports()).toEqual(new Map([[3000, "s"]]));
				expect(
					activity.background.serversOf("s", activity.gateUrls),
				).toMatchObject([
					{ port: 3000, taskId: "w1", gateUrl: "https://box.ts.net:3000" },
				]);
				expect(moved).toEqual(["s"]);
				hand(none);
				expect(read()).toEqual({ background: undefined, label: "idle" });
				expect(activity.background.ports().size).toBe(0);
			}),
	);

	it.effect(
		"keeps separate daemon instances isolated without a project store",
		() =>
			Effect.gen(function* () {
				const first = yield* makeSessionActivity;
				const second = yield* makeSessionActivity;
				publishLedgerTasks(first.background, {
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

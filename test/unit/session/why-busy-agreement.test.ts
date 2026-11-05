// Why busy (82tn.56): the view and the busy indicator read the same. Each reason is driven on and
// off through the real Session Activity service and read model; at every step the view opens
// exactly when the row's indicator reads busy, with exactly the reasons Session Activity holds.
// How it could fail (lane-56 audit):
// 1. a reason Session Activity does not hold; 2. a reason it holds is missing;
// 3. open tool rows on a calm session open the view; 4, 5. an ended-by-run or finished tool lists;
// 7. the indicator reads busy (a member's Run) and the view has no reason;
// 8. the view opens beside a calm indicator (error tier, done-unread);
// 10. checking shows the last known tasks as live; 14. one call listed twice;
// 15. reasons move order.

import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { makeSessionRows } from "../../../src/lib/domain/daemon/Services/session-rows.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { whyBusy } from "../../../src/lib/session/why-busy.js";
import type {
	HistoryMessage,
	SessionAttention,
} from "../../../src/lib/shared-types.js";
import { publishLedgerTasks, publishRun } from "../../helpers/ledger-tasks.js";
import { makeMockAccountDirectory } from "../../helpers/mock-factories.js";

/** The indicator's busy tiers: the glyph that spins or asks (SessionStatusGlyph). */
const BUSY_TIERS: readonly SessionAttention[] = [
	"needs-approval",
	"needs-reply",
	"working",
	"monitoring",
];

const tool = (
	id: string,
	state: NonNullable<NonNullable<HistoryMessage["parts"]>[number]["state"]>,
	callID = id,
) => ({
	id,
	type: "tool" as const,
	callID,
	tool: "Bash",
	state,
	time: { start: 1_000 },
});

/** One open call (twice, as two parts), one ended by the run, one finished, one failed. */
const transcript: HistoryMessage[] = [
	{
		id: "assistant",
		role: "assistant",
		parts: [
			tool("open", { status: "running" }),
			tool("open-again", { status: "running" }, "open"),
			tool("ended", { status: "running", outcome: "endedByRun" }),
			tool("done", { status: "completed", outcome: "succeeded" }),
			tool("failed", { status: "error", outcome: "failed" }),
		],
	},
];

describe("Why busy agrees with the busy indicator", () => {
	it.effect("for every Session Activity reason, on and off", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;
			const { background } = yield* SessionActivityTag;
			const rows = yield* makeSessionRows({
				slug: "project",
				folders: ["/tmp"],
			});
			yield* commit([
				canonicalEvent("session.created", "root", {
					sessionId: "root",
					title: "Root",
					provider: "claude",
				}),
				canonicalEvent("session.created", "child", {
					sessionId: "child",
					title: "Subagent",
					provider: "claude",
					parentId: "root",
				}),
			]);
			const seen: unknown[] = [];
			/** Reads the root row; the view must open exactly when its indicator reads busy. */
			const expectView = (
				label: string,
				kinds: readonly string[] | null,
				options: { readonly messages?: HistoryMessage[] } = {},
			) =>
				Effect.gen(function* () {
					const row = (yield* rows.list()).find(({ id }) => id === "root");
					if (!row) throw new Error("Expected the root row");
					const view = whyBusy(row, {
						pending: [],
						messages: options.messages ?? [],
					});
					seen.push({ label, attention: row.attention, view });
					const busy = BUSY_TIERS.includes(row.attention ?? "idle");
					expect({ label, open: view !== undefined }).toEqual({
						label,
						open: busy,
					});
					expect(
						{ label, kinds: view?.reasons.map(({ kind }) => kind) ?? null },
						JSON.stringify(seen.at(-1)),
					).toEqual({ label, kinds });
					if (view) expect(view.reasons.length, label).toBeGreaterThan(0);
					return view;
				});
			const none = () => background.publish("root", { tag: "none" });

			yield* expectView("idle", null);
			yield* expectView("open tool rows on a calm session", null, {
				messages: transcript,
			});

			publishRun(background, "root");
			const run = yield* expectView("an input Run", ["run"], {
				messages: transcript,
			});
			expect(run?.tools).toEqual([
				{ callId: "open", tool: "Bash", since: 1_000 },
			]);
			expect(run?.reasons[0]).toEqual({
				kind: "run",
				origin: "input",
				queued: 0,
			});
			none();
			yield* expectView("the input Run over", null);

			publishLedgerTasks(background, {
				sessionId: "root",
				kind: "snapshot",
				tasks: [
					{
						id: "shell",
						type: "local_bash",
						description: "sleep 8",
						firstSeenAt: 2_000,
					},
				],
			});
			const work = yield* expectView("background work", ["background"]);
			expect(work?.reasons[0]).toMatchObject({
				activity: "work",
				tasks: [{ label: expect.stringContaining("sleep 8"), since: 2_000 }],
			});
			background.publish("root", { tag: "none" }, undefined, {
				active: {
					runId: "wake",
					inputs: [],
					origin: "wake",
					wakeTask: { taskId: "shell" },
					tag: "Running",
				},
			});
			const wake = yield* expectView("a wake Run", ["run"]);
			expect(wake?.reasons[0]).toEqual({
				kind: "run",
				origin: "wake",
				task: "sleep 8",
				queued: 0,
			});
			none();
			yield* expectView("the wake Run over", null);

			publishLedgerTasks(background, {
				sessionId: "root",
				kind: "snapshot",
				tasks: [
					{
						id: "watch",
						type: "monitor",
						description: "tail the log",
						firstSeenAt: 3_000,
					},
				],
			});
			const monitoring = yield* expectView("monitoring", ["background"]);
			expect(monitoring?.reasons[0]).toMatchObject({ activity: "monitoring" });
			background.publish("root", {
				tag: "unknown",
				label: "root-runner:2",
				stale: [
					{
						key: { taskId: "watch" },
						taskType: "monitor",
						description: "tail the log",
						ambient: false,
						kind: "monitor",
						class: "monitoring",
					},
				],
			});
			const checking = yield* expectView("checking", ["checking"]);
			expect(checking?.reasons[0]).toMatchObject({
				stale: [{ label: expect.stringContaining("tail the log") }],
			});
			none();
			yield* expectView("checking over", null);

			const server = {
				key: { pid: 42, startedAt: 4_000, port: 5173 },
				command: "vite",
				cwd: "/tmp",
				source: "detected" as const,
				role: "serving" as const,
			};
			background.publish("root", { tag: "none" }, undefined, {
				servers: new Map([[5173, server]]),
			});
			const serving = yield* expectView("serving", ["background"]);
			expect(serving?.reasons[0]).toEqual({
				kind: "background",
				activity: "serving",
				tasks: [],
				servers: [{ label: "vite :5173", since: 4_000 }],
			});
			none();
			yield* expectView("serving over", null);

			yield* commit([
				canonicalEvent("permission.asked", "root", {
					id: "approval",
					sessionId: "root",
					toolName: "Bash",
					input: {},
				}),
			]);
			const approval = yield* expectView("an approval", ["needs-you"]);
			expect(approval?.reasons[0]).toEqual({
				kind: "needs-you",
				approvals: 1,
				questions: 0,
			});
			publishRun(background, "root");
			yield* expectView("an approval during a Run", ["needs-you", "run"]);
			none();
			yield* commit([
				canonicalEvent("permission.resolved", "root", {
					id: "approval",
					decision: "once",
				}),
			]);
			yield* expectView("the approval answered", null);

			yield* commit([
				canonicalEvent("question.asked", "child", {
					id: "question",
					sessionId: "child",
					questions: [],
				}),
			]);
			const reply = yield* expectView("a subagent's question", ["needs-you"]);
			expect(reply?.reasons[0]).toEqual({
				kind: "needs-you",
				approvals: 0,
				questions: 1,
			});
			yield* commit([
				canonicalEvent("question.resolved", "child", {
					id: "question",
					answers: {},
				}),
			]);
			yield* expectView("the question answered", null);

			publishRun(background, "child");
			yield* expectView("a subagent's Run", ["members"]);
			publishRun(background, "root");
			yield* expectView("a subagent's Run beside the root's", ["run"]);
			none();
			background.publish("child", { tag: "none" });
			yield* expectView("the subagent's Run over", null);

			// The indicator's calm tiers mask Session Activity; the view follows the indicator.
			publishRun(background, "root");
			yield* sql`UPDATE sessions SET last_turn_error_at = 1 WHERE id = 'root'`;
			yield* expectView("a Run beside an error", null);
			expect(seen.at(-1)).toMatchObject({ attention: "error" });
			none();
			publishLedgerTasks(background, {
				sessionId: "root",
				kind: "snapshot",
				tasks: [
					{
						id: "shell",
						type: "local_bash",
						description: "sleep 8",
						firstSeenAt: 2_000,
					},
				],
			});
			yield* expectView("background work beside an error", null);
			expect(seen.at(-1)).toMatchObject({ attention: "error" });
			yield* sql`UPDATE sessions SET last_turn_error_at = NULL, last_turn_end_version = 1, seen_version = 0 WHERE id = 'root'`;
			yield* expectView("background work, unread", ["background"]);
			none();
			yield* expectView("done, unread", null);
			expect(seen.at(-1)).toMatchObject({ attention: "done-unread" });
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePersistenceEffectLayer(":memory:", "project"),
					Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
					Layer.effect(SessionActivityTag, makeSessionActivity),
				),
			),
		),
	);
});

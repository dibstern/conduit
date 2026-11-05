// What a session is doing reads the same on every feed at every step (82tn.32.30; CONTRACT.md 8.1
// "SessionActivity is a read-only view"), over the isolated process harness and the recorded
// background-shell-turn trace: the user turn (shell task started, trace line 56), the gap after its
// result (line 84) while the shell still runs, and Claude's wake turn (held before its result at
// line 153). How it could fail (lane audit):
// 1. a wake Run reads idle or done on the sidebar (4ejl7);
// 3. tasks running after the turn make the foreground read working, or read idle;
// 12. the shell feed (sidebar) and the family feed (chat) send different answers for one step;
// 15. a stored sidebar row keeps reading working after the session goes idle;
// 18. a fresh connection (a reload) reads a different answer than the live page.

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const PROOF = "test-results/82tn-32-30-session-activity.json";

/** The latest session_row each feed sent for the session. */
const latest = (browser: ProcessBrowser, sessionId: string) => {
	let feed = "";
	const last: Record<string, Record<string, unknown>> = {};
	for (const { message } of browser.frames) {
		if (message["type"] === "shell" || message["type"] === "family")
			feed = String(message["type"]);
		if (message["type"] === "session_row" && message["id"] === sessionId)
			last[feed] = message;
	}
	return last;
};

const shown = (row: Record<string, unknown> | undefined) => ({
	activity: row?.["activity"] ?? null,
	attention: row?.["attention"] ?? null,
	processing: row?.["processing"] ?? false,
	wakeRun: row?.["wakeRun"] ?? null,
});

describe("Session activity over a Claude background shell and its wake", () => {
	let harness: ProcessHarness | undefined;
	const proof: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			proof[task.name] = {
				...(proof[task.name] as object),
				outcome: task.result?.state === "pass" ? "passed" : "failed",
			};
			mkdirSync("test-results", { recursive: true });
			writeFileSync(PROOF, `${JSON.stringify(proof, null, 2)}\n`);
			harness = undefined;
		}
	});

	it("reads one answer on the sidebar and chat feeds at every step, and after a reload", async () => {
		const name =
			"reads one answer on the sidebar and chat feeds at every step, and after a reload";
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			claudeReplay: { turns: ["background-shell-turn"] },
		});
		harness = fixture;
		const browser = await fixture.connect();
		await browser.followSessions();
		const sessionId = await browser.createSession("Session activity");
		await browser.followFamily(sessionId);
		const hold = join(fixture.root, "claude-replay-hold");
		const reached = () =>
			existsSync(`${hold}.reached`)
				? readFileSync(`${hold}.reached`, "utf8").split("\n").filter(Boolean)
						.length
				: 0;
		const steps: Record<string, unknown>[] = [];
		proof[name] = { sessionId, steps };
		const projectProcessing = async () =>
			(
				(await (await fetch(`${fixture.baseUrl}/api/projects`)).json()) as {
					projects: { slug: string; isProcessing: boolean }[];
				}
			).projects.find((project) => project.slug === "process-test")
				?.isProcessing;
		/** Holds the replay before `message`, then waits until both feeds read `expected`. */
		const step = async (
			label: string,
			message: number,
			expected: ReturnType<typeof shown>,
			start?: () => void,
		) => {
			const id = steps.length + 1;
			writeFileSync(hold, JSON.stringify({ turn: 1, message, id }));
			start?.();
			// test-waits-allow polling: the held replay line reports only through this file.
			await vi.waitFor(() => expect(reached()).toBe(id), { timeout: 10_000 });
			const record: Record<string, unknown> = { label, message, expected };
			steps.push(record);
			// Every step is recorded before any is judged, so a red run shows them all.
			// test-waits-allow polling: rows are coalesced up to a second after the change.
			await vi
				.waitFor(
					() => {
						const rows = latest(browser, sessionId);
						record["shell"] = shown(rows["shell"]);
						record["family"] = shown(rows["family"]);
						expect(record["shell"]).toEqual(expected);
						expect(record["family"]).toEqual(expected);
					},
					{ timeout: 5_000 },
				)
				.catch(() => {});
			// 21. The project reads processing from the same answer; it is refreshed each status poll.
			// test-waits-allow polling: the project snapshot moves only on the status poll interval.
			await vi
				.waitFor(
					async () => {
						record["project"] = await projectProcessing();
						expect(record["project"]).toBe(expected.processing);
					},
					{ timeout: 10_000 },
				)
				.catch(() => {});
			// A reload: a fresh connection's first rows on both feeds.
			const reload = await fixture.connect();
			await reload.followSessions();
			await reload.followFamily(sessionId);
			const rows = latest(reload, sessionId);
			record["reload"] = {
				shell: shown(rows["shell"]),
				family: shown(rows["family"]),
			};
			await reload.close();
		};

		await step(
			"the user turn, its shell started",
			84,
			{
				activity: {
					foreground: "working",
					background: "work",
					label: "working",
				},
				attention: "working",
				processing: true,
				wakeRun: null,
			},
			() => {
				browser
					.send(sessionId, "Run sleep 8 in the background")
					.catch(() => {});
			},
		);
		await step("after the turn's result, the shell still running", 85, {
			activity: { foreground: "idle", background: "work", label: "working" },
			attention: "working",
			processing: true,
			wakeRun: null,
		});
		await step("Claude's wake turn (4ejl7)", 153, {
			activity: { foreground: "working", background: "none", label: "working" },
			attention: "working",
			processing: true,
			wakeRun: { task: "sleep 8" },
		});
		rmSync(hold);
		const done: Record<string, unknown> = { label: "after the wake" };
		steps.push(done);
		const idle = {
			foreground: "idle",
			background: "none",
			label: "idle",
		};
		// test-waits-allow polling: rows are coalesced up to a second after the change.
		await vi
			.waitFor(
				() => {
					const rows = latest(browser, sessionId);
					done["shell"] = shown(rows["shell"]);
					done["family"] = shown(rows["family"]);
					expect(done["shell"]).toMatchObject({ activity: idle });
					expect(done["family"]).toMatchObject({ activity: idle });
				},
				{ timeout: 10_000 },
			)
			.catch(() => {});
		for (const {
			label,
			expected,
			shell,
			family,
			reload,
			project,
		} of steps.slice(0, -1))
			expect({ shell, family, reload, project }, String(label)).toEqual({
				shell: expected,
				family: expected,
				reload: { shell: expected, family: expected },
				project: (expected as ReturnType<typeof shown>).processing,
			});
		expect(done["shell"]).toMatchObject({
			activity: idle,
			processing: false,
			wakeRun: null,
		});
		expect(done["family"]).toEqual(done["shell"]);
		// test-waits-allow polling: the project snapshot moves only on the status poll interval.
		await vi.waitFor(
			async () => {
				done["project"] = await projectProcessing();
				expect(done["project"]).toBe(false);
			},
			{ timeout: 10_000 },
		);
	});

	// 20. The "done" ding fires when the user turn ends while its shell still runs, and again after
	// Claude's wake turn. With no tab viewing the session, every done reaches the project's alerts.
	it("sends one done alert, after the wake, not while the shell runs", async () => {
		const name =
			"sends one done alert, after the wake, not while the shell runs";
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			claudeReplay: { turns: ["background-shell-turn"] },
		});
		harness = fixture;
		// Follows the sidebar only, so it never views the session.
		const watcher = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		const alerts: Record<string, unknown>[] = [];
		const alertFiber = Effect.runFork(
			Stream.runForEach(watcher.rpc.SubscribeAlerts({}), (envelope) =>
				Effect.sync(() => {
					if (envelope._tag !== "alert") return;
					// Whether the sidebar had shown Claude's wake turn before this alert.
					const afterTheWake = watcher.frames.some(
						({ message }) =>
							message["type"] === "session_row" &&
							message["id"] === envelope.sessionId &&
							message["wakeRun"] != null,
					);
					alerts.push({ ...envelope, afterTheWake });
				}),
			),
		);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Done after the wake");
		proof[name] = { sessionId, alerts };
		const hold = join(fixture.root, "claude-replay-hold");
		writeFileSync(hold, JSON.stringify({ turn: 1, message: 84, id: 1 }));
		browser.send(sessionId, "Run sleep 8 in the background").catch(() => {});
		// test-waits-allow polling: the held replay line reports only through this file.
		await vi.waitFor(() => expect(existsSync(`${hold}.reached`)).toBe(true), {
			timeout: 10_000,
		});
		// No tab views the session from here, so each done is an alert.
		await browser.close();
		rmSync(hold);
		const done = () =>
			alerts
				.filter((alert) => alert["kind"] === "done")
				.map(({ sessionId, afterTheWake }) => ({ sessionId, afterTheWake }));
		// test-waits-allow polling: the wake's done reaches the alerts feed after the wake ends.
		await vi
			.waitFor(
				() => expect(done()).toContainEqual({ sessionId, afterTheWake: true }),
				{ timeout: 20_000 },
			)
			.catch(() => {});
		await Effect.runPromise(Fiber.interrupt(alertFiber));
		expect(done()).toEqual([{ sessionId, afterTheWake: true }]);
	});

	// 32, 33. Rewind is a foreground action (gap review 1B): refused while the user turn or
	// Claude's wake runs, let through while only the shell runs.
	it("refuses rewind while the turn runs and allows it while only the shell runs", async () => {
		const name =
			"refuses rewind while the turn runs and allows it while only the shell runs";
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			claudeReplay: { turns: ["background-shell-turn"] },
		});
		harness = fixture;
		const browser = await fixture.connect();
		await browser.followSessions();
		const sessionId = await browser.createSession("Rewind beside a shell");
		const hold = join(fixture.root, "claude-replay-hold");
		const steps: Record<string, unknown>[] = [];
		proof[name] = { sessionId, steps };
		const holdAt = (message: number, id: number) =>
			writeFileSync(hold, JSON.stringify({ turn: 1, message, id }));
		const reached = async (id: number) => {
			// test-waits-allow polling: the held replay line reports only through this file.
			await vi.waitFor(
				() =>
					expect(
						existsSync(`${hold}.reached`)
							? readFileSync(`${hold}.reached`, "utf8")
									.split("\n")
									.filter(Boolean).length
							: 0,
					).toBe(id),
				{ timeout: 10_000 },
			);
		};
		const rewind = async (label: string) => {
			const messageId = (await browser.history(sessionId)).find(
				(message) => message.role === "user",
			)?.id;
			const result = await fixture
				.requestRpc({
					_tag: "RewindSession",
					sessionId,
					messageId: String(messageId),
				})
				.then(
					() => "rewound",
					(error: unknown) => String(error),
				);
			const undo =
				result === "rewound"
					? await fixture.requestRpc({ _tag: "UndoRewind", sessionId }).then(
							() => "undone",
							(error: unknown) => String(error),
						)
					: undefined;
			steps.push({
				label,
				activity: latest(browser, sessionId)["shell"]?.["activity"] ?? null,
				result,
				...(undo === undefined ? {} : { undo }),
			});
			return { result, undo };
		};
		holdAt(84, 1);
		browser.send(sessionId, "Run sleep 8 in the background").catch(() => {});
		await reached(1);
		const during = await rewind("the user turn, its shell started");
		holdAt(85, 2);
		await reached(2);
		// test-waits-allow polling: rows are coalesced up to a second after the change.
		await vi.waitFor(
			() =>
				expect(latest(browser, sessionId)["shell"]?.["activity"]).toMatchObject(
					{ foreground: "idle", background: "work" },
				),
			{ timeout: 5_000 },
		);
		const beside = await rewind(
			"after the turn's result, the shell still running",
		);
		holdAt(153, 3);
		await reached(3);
		const wake = await rewind("Claude's wake turn");
		rmSync(hold);
		expect(during.result).toMatch(/Stop the current turn/);
		expect(beside).toEqual({ result: "rewound", undo: "undone" });
		expect(wake.result).toMatch(/Stop the current turn/);
	});

	// 30. The session's own family row lags its sidebar row, so a reader that takes the family row
	// shows an old goal phase (lane 3226: the last family row read queued by Claude while the
	// sidebar read Cleared).
	it("sends the same goal phase on the sidebar and chat feeds through a mid-turn clear", async () => {
		const name =
			"sends the same goal phase on the sidebar and chat feeds through a mid-turn clear";
		const fixture = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		harness = fixture;
		await fixture.restart();
		const browser = await fixture.connect();
		await browser.setAutoSettle(null);
		await browser.followSessions();
		const sessionId = await browser.createSession("Goal phase on both feeds");
		await browser.followFamily(sessionId);
		const goal = (row: Record<string, unknown> | undefined) => ({
			goalPhase: row?.["goalPhase"] ?? null,
			activityGoal:
				(row?.["activity"] as Record<string, unknown> | undefined)?.["goal"] ??
				null,
		});
		const steps: Record<string, unknown>[] = [];
		proof[name] = { sessionId, steps };
		/** Waits until both feeds' latest rows read `expected`, recording what each read. */
		const both = async (label: string, expected: ReturnType<typeof goal>) => {
			const record: Record<string, unknown> = { label, expected };
			steps.push(record);
			// test-waits-allow polling: rows are coalesced up to a second after the change.
			await vi
				.waitFor(
					() => {
						const rows = latest(browser, sessionId);
						record["shell"] = goal(rows["shell"]);
						record["family"] = goal(rows["family"]);
						expect(record["shell"]).toEqual(expected);
						expect(record["family"]).toEqual(expected);
					},
					{ timeout: 10_000 },
				)
				.catch(() => {});
		};
		const turn = browser
			.send(sessionId, "goal-long-turn")
			.catch(() => undefined);
		await fixture.waitForMark(
			(mark) => mark.kind === "enqueue" && mark.prompt === "goal-long-turn",
		);
		await fixture.requestRpc({
			_tag: "ClearGoal",
			sessionId,
			commandId: randomUUID(),
		});
		await fixture.waitForMark(
			(mark) => mark.kind === "input-queued" && mark.prompt === "/goal clear",
		);
		const queued = {
			tag: "Pending",
			action: { kind: "clear" },
			send: "Queued",
		};
		await both("a clear queued by Claude", {
			goalPhase: queued,
			activityGoal: queued,
		});
		await fixture.requestRpc({
			_tag: "CancelSession",
			sessionId,
			commandId: randomUUID(),
		});
		await turn;
		await both("cleared after the turn", {
			goalPhase: null,
			activityGoal: null,
		});
		for (const { label, expected, shell, family } of steps)
			expect({ shell, family }, String(label)).toEqual({
				shell: expected,
				family: expected,
			});
	});
});

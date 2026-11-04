import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeRunnerSocket } from "../../../src/lib/provider/claude/claude-runner-protocol.js";
import type { RunnerMessage } from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	type ProcessBrowser,
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

async function sessionBackground(browser: ProcessBrowser, sessionId: string) {
	const envelopes = await Effect.runPromise(
		browser.rpc.SubscribeShell({}).pipe(
			Stream.filter((frame) => frame._tag !== "projects"),
			Stream.take(1),
			Stream.runCollect,
			Effect.timeout("5 seconds"),
		),
	);
	const snapshot = [...envelopes][0];
	const session =
		snapshot?._tag === "snapshot"
			? snapshot.rows.find((session) => session.id === sessionId)
			: undefined;
	return {
		backgroundWork: session?.backgroundWork ?? null,
		backgroundTasks: session?.backgroundTasks ?? [],
		tasksChecking: session?.tasksChecking ?? false,
	};
}

describe("foreground daemon process harness", () => {
	let harness: ProcessHarness | undefined;

	afterEach(async (context) => {
		if (!harness) return;
		try {
			await harness.dispose();
		} finally {
			mkdirSync("test-results/process-harness", { recursive: true });
			writeFileSync(
				`test-results/process-harness/${context.task.name.replace(/\W+/g, "-")}.json`,
				JSON.stringify(harness.proof(), null, 2),
			);
			harness = undefined;
		}
	});

	it("sends over browser RPC and receives projected response text", async () => {
		harness = await ProcessHarness.start({ enqueueMarkDelayMs: 250 });
		const browser = await harness.connect();
		const sessionId = await browser.createSession();
		const turn = await browser.send(sessionId, "stream-proof");
		expect(turn.chunks.join("")).toBe(responseChunks("stream-proof").join(""));
		expect(turn.done["status"]).toBe("idle");
		await vi.waitFor(
			() => {
				expect(
					harness?.marks.filter((mark) => mark.kind === "enqueue"),
				).toHaveLength(1);
			},
			{ timeout: 5000 },
		);
		expect(harness.generations[0]?.pid).not.toBe(process.pid);
		expect(harness.generations[0]?.instances).toEqual([
			{ managed: false, url: "http://127.0.0.1:0" },
			{ managed: false },
		]);
		expect(harness.generations[0]?.projects).toEqual([harness.projectDir]);
	});

	it("exits locally when the parent IPC channel disappears", async () => {
		harness = await ProcessHarness.start();
		await harness.disconnectParent();
		expect(harness.generations[0]?.exitCode).toBe(0);
		expect(harness.generations[0]?.signal).toBeNull();
	});

	it("kills a tracked detached runner during teardown even without its registration", async () => {
		harness = await ProcessHarness.start();
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Tracked teardown proof");
		await browser.send(sessionId, "tracked-teardown");
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner");
		await harness.kill();
		process.kill(runner.pid, "SIGSTOP");
		rmSync(`${runner.socketPath}.json`);
		try {
			await harness.dispose();
			expect(harness.runnerPids()).toContain(runner.pid);
			expect(harness.remainingRunnerPids()).toEqual([]);
		} finally {
			try {
				process.kill(runner.pid, "SIGKILL");
			} catch {
				// Successful teardown already killed this fixture-owned PID.
			}
		}
	});

	it("survives SIGKILL, reconnects on the same dirs, and reads persisted history", async () => {
		harness = await ProcessHarness.start();
		const browser = await harness.connect();
		const sessionId = await browser.createSession();
		await browser.send(sessionId, "restart-proof");
		const before = await browser.history(sessionId);
		expect(before.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(before[0]?.text).toBe("restart-proof");
		expect(before[1]?.parts?.map((part) => part.text ?? "").join("")).toBe(
			responseChunks("restart-proof").join(""),
		);
		await harness.kill();
		expect(harness.generations[0]?.signal).toBe("SIGKILL");
		await harness.restart();
		const reconnected = await harness.connect(sessionId);
		const after = await reconnected.history(sessionId);
		expect(after).toEqual(before);
		expect(harness.generations[1]?.pid).not.toBe(harness.generations[0]?.pid);
		expect(harness.generations[1]?.projects).toEqual([harness.projectDir]);
		await reconnected.send(sessionId, "after-restart-proof");
		const continued = await reconnected.history(sessionId);
		expect(continued.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(new Set(continued.map((message) => message.id)).size).toBe(4);
	});

	it("restores background tasks after each server restart without another SDK message", async () => {
		harness = await ProcessHarness.start({ restartProof: true });
		let browser = await harness.connect();
		const sessionId = await browser.createSession("Background restart proof");
		await browser.send(sessionId, "restart-background-work");
		const expected = {
			// 8.2 (CONTRACT.md 2778-2781): a shell is work.
			backgroundWork: "working",
			backgroundTasks: [
				{
					id: "restart-background-task",
					type: "local_bash",
					kind: "shell",
					description: "Background restart proof",
					firstSeenAt: expect.any(Number),
				},
			],
			tasksChecking: false,
		};
		const states: Awaited<ReturnType<typeof sessionBackground>>[] = [];
		try {
			await vi.waitFor(
				async () => {
					expect(await sessionBackground(browser, sessionId)).toEqual(expected);
					expect(
						harness?.marks.filter((mark) => mark.kind === "background-work"),
					).toHaveLength(1);
				},
				{ timeout: 5000 },
			);
			states.push(await sessionBackground(browser, sessionId));
			const runner = harness.marks.find(
				(mark) => mark.kind === "runner-started",
			);
			if (runner?.kind !== "runner-started")
				throw new Error("Missing background runner proof");
			for (let restart = 0; restart < 2; restart++) {
				await harness.kill();
				expect(() => process.kill(runner.pid, 0)).not.toThrow();
				await harness.restart();
				browser = await harness.connect(sessionId);
				await vi.waitFor(
					async () => {
						states[restart + 1] = await sessionBackground(browser, sessionId);
						// Start time included, so the elapsed timer doesn't reset.
						expect(states[restart + 1]).toEqual(states[0]);
					},
					{ timeout: 5000 },
				);
				expect(
					harness.marks.filter((mark) => mark.kind === "runner-started").at(-1),
				).toMatchObject({ pid: runner.pid, socketPath: runner.socketPath });
			}
			const sdkMarks = readFileSync(
				join(harness.root, "sdk-proof.ndjson"),
				"utf8",
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string });
			expect(
				sdkMarks.filter((mark) => mark.kind === "background-work"),
			).toHaveLength(1);
			expect(sdkMarks.filter((mark) => mark.kind === "enqueue")).toHaveLength(
				1,
			);
			expect(sdkMarks.filter((mark) => mark.kind === "query")).toHaveLength(1);
		} finally {
			mkdirSync("test-results/process-harness", { recursive: true });
			writeFileSync(
				"test-results/process-harness/background-restart-state.json",
				JSON.stringify(
					{ sessionId, before: states[0], after: states.slice(1) },
					null,
					2,
				),
			);
		}
	}, 60_000);

	// 8.3: a fresh launch has no tasks; a reattach is unknown until the catch-up snapshot. L1
	// (CONTRACT.md 350-353): a reattach at the same querySeq changes nothing, so only one whose
	// query was replaced reads as checking.
	it("reads a reattached runner's tasks as checking until its catch-up list", async () => {
		harness = await ProcessHarness.start({ restartProof: true });
		let browser = await harness.connect();
		const sessionId = await browser.createSession("Background checking proof");
		type State = Awaited<ReturnType<typeof sessionBackground>>;
		const states: Record<string, State> = {};
		const none: State = {
			backgroundWork: null,
			backgroundTasks: [],
			tasksChecking: false,
		};
		const stateOf = (row: Record<string, unknown>) =>
			({
				backgroundWork: row["backgroundWork"] ?? null,
				backgroundTasks: row["backgroundTasks"] ?? [],
				tasksChecking: row["tasksChecking"] ?? false,
			}) as State;
		const rows = (cursor: number) =>
			browser.frames
				.slice(cursor)
				.flatMap(({ message }) =>
					message["type"] === "session_row" && message["id"] === sessionId
						? [stateOf(message)]
						: [],
				);
		// The row as the sidebar feed carries it, waited for by frame rather than polled.
		const settle = async (
			name: string,
			matches: (state: State) => boolean,
			cursor = 0,
		) => {
			try {
				states[name] = stateOf(
					await browser.waitFor(
						(message) =>
							message["type"] === "session_row" &&
							message["id"] === sessionId &&
							matches(stateOf(message)),
						cursor,
						5000,
					),
				);
			} catch (cause) {
				states[name] = rows(cursor).at(-1) ?? none;
				throw cause;
			}
		};
		const same = (expected: State) => (state: State) =>
			JSON.stringify(state) === JSON.stringify(expected);
		// The ledger's task lists for this session, in order, with the label each came under.
		const taskLists = () => {
			const db = new DatabaseSync(harness?.daemonStorePath() ?? "", {
				readOnly: true,
			});
			try {
				return (
					db
						.prepare(
							"SELECT json_extract(entry_json, '$.command.observation.label') AS label, json_array_length(json_extract(entry_json, '$.command.observation.tasks')) AS tasks FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.command.observation.kind') = 'tasks_snapshot' ORDER BY entry_seq",
						)
						.all(sessionId) as { label: string; tasks: number }[]
				).map(({ label, tasks }) => ({ label, tasks }));
			} finally {
				db.close();
			}
		};
		const querySeqOf = (label: string | undefined) =>
			Number(label?.slice(label.lastIndexOf(":") + 1));
		let lists: ReturnType<typeof taskLists> = [];
		const restart = async (holdCatchUp: boolean) => {
			await harness?.kill();
			await harness?.restart(
				holdCatchUp
					? {
							serviceEnvironment: {
								CONDUIT_TEST_HOLD_RUNNER_OUTPUT: "evidence.tasks_snapshot",
							},
						}
					: {},
			);
			browser = (await harness?.connect(sessionId)) ?? browser;
		};
		try {
			await settle("fresh", () => true);
			expect(states["fresh"]).toEqual(none);
			await browser.send(sessionId, "restart-background-work");
			await settle("launched", (state) => state.backgroundTasks.length > 0);
			expect(states["launched"]?.backgroundTasks).toMatchObject([
				{ id: "restart-background-task", kind: "shell" },
			]);
			const launched = states["launched"] ?? none;
			// The same query reattached: the stored list shows while its catch-up is held.
			await restart(true);
			await settle("same-query", same(launched));
			await restart(false);
			await settle("caught-up", same(launched));
			// The query ends and the next send starts another in the same runner.
			const ending = browser.frames.length;
			writeFileSync(join(harness.root, "restart-background-change"), "end");
			await settle("ended", same(none), ending);
			// Failure modes (lane audit 193-196): 193. the new query keeps the ended query's
			// certainty instead of starting Unknown under its own label; 194. the new query lists
			// nothing, so the session reads as checking until a task starts; 195. the host replays
			// the ended query's list under its old label, which the ledger ignores, so a reattach
			// reads as checking for good; 196. the new query's list carries the replaced one's
			// tasks. The SDK lists nothing when a CLI process starts (sdk.d.ts
			// background_tasks_changed), so a new query's list is empty under its own label.
			const sending = browser.frames.length;
			await browser.send(sessionId, "second query");
			// The row the turn ended on: the new query's empty list has settled it, not checking.
			states["second-query"] = stateOf(
				await browser.waitFor(
					(message) =>
						message["type"] === "session_row" &&
						message["id"] === sessionId &&
						message["status"] === "idle",
					sending,
					5000,
				),
			);
			expect(states["second-query"]).toEqual(none);
			lists = taskLists();
			const [ended, replaced] = lists.slice(-2);
			expect(replaced?.tasks).toEqual(0);
			expect(ended?.label).toMatch(/:\d+$/);
			expect(querySeqOf(replaced?.label)).toBe(querySeqOf(ended?.label) + 1);
			// Reattached after its query was replaced: the list is the new query's (L1, CONTRACT.md
			// 350-353), so it shows while the catch-up is held and after it lands.
			await restart(true);
			await settle("replaced-query", same(none));
			await restart(false);
			await settle("replaced-caught-up", same(none));
		} finally {
			mkdirSync("test-results/process-harness", { recursive: true });
			writeFileSync(
				"test-results/process-harness/background-checking-state.json",
				JSON.stringify({ sessionId, states, taskLists: lists }, null, 2),
			);
		}
	});

	it("retains one background snapshot across replay retries on the same connection", async () => {
		harness = await ProcessHarness.start({ restartProof: true });
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Background replay retries");
		await browser.send(sessionId, "restart-background-work");
		await vi.waitFor(
			() => {
				expect(
					harness?.marks.filter((mark) => mark.kind === "background-work"),
				).toHaveLength(1);
			},
			{ timeout: 5000 },
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing background runner proof");
		await harness.kill();
		const frames: RunnerMessage[] = [];
		const { projectDir, configDir } = harness;
		const socket = createConnection(runner.socketPath);
		const peer = new ClaudeRunnerSocket(
			socket,
			(message) => frames.push(message),
			() => {},
		);
		socket.once("connect", () =>
			peer.write({
				type: "hello",
				protocolVersion: runner.protocolVersion,
				buildId: runner.buildId,
				config: {
					workspaceRoot: projectDir,
					daemonConfigDir: configDir,
				},
			}),
		);
		try {
			await vi.waitFor(
				() => {
					expect(
						frames.some(
							(frame) => frame.type === "hello" && frame.pid === runner.pid,
						),
					).toBe(true);
				},
				{ timeout: 5000 },
			);
			peer.write({ type: "replay", acknowledgedSequence: 0 });
			await vi.waitFor(
				() => {
					expect(
						frames.some(
							(frame) =>
								frame.type === "output" &&
								frame.output.type === "event" &&
								frame.output.event.type === "evidence.tasks_snapshot",
						),
					).toBe(true);
				},
				{ timeout: 5000 },
			);
			for (let retry = 0; retry < 3; retry++) {
				const cursor = frames.length;
				peer.write({ type: "replay", acknowledgedSequence: 0 });
				await vi.waitFor(
					() => {
						expect(
							frames
								.slice(cursor)
								.some((frame) => frame.type === "upgrade-state"),
						).toBe(true);
					},
					{ timeout: 5000 },
				);
			}
			peer.destroy();
			let sequences: (number | undefined)[] = [];
			await vi.waitFor(
				() => {
					const retained = readFileSync(`${runner.socketPath}.spool`, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as RunnerMessage);
					sequences = retained.flatMap((frame) =>
						frame.type === "output" &&
						frame.output.type === "event" &&
						frame.output.event.type === "evidence.tasks_snapshot"
							? [frame.sequence]
							: [],
					);
					expect(sequences).toHaveLength(1);
				},
				{ timeout: 5000 },
			);
			mkdirSync("test-results/process-harness", { recursive: true });
			writeFileSync(
				"test-results/process-harness/background-replay-retries.json",
				JSON.stringify(
					{ sessionId, runnerPid: runner.pid, retries: 3, sequences },
					null,
					2,
				),
			);
		} finally {
			peer.destroy();
		}
	}, 60_000);

	it.each([
		"replace",
		"clear",
		"end",
	] as const)("keeps the latest background state when the SDK emits %s while the server is down", async (change) => {
		harness = await ProcessHarness.start({ restartProof: true });
		let browser = await harness.connect();
		const sessionId = await browser.createSession("Detached background proof");
		await browser.send(sessionId, "restart-background-work");
		await vi.waitFor(
			() => {
				expect(
					harness?.marks.filter((mark) => mark.kind === "background-work"),
				).toHaveLength(1);
			},
			{ timeout: 5000 },
		);
		const before = await sessionBackground(browser, sessionId);
		expect(before.backgroundTasks).toMatchObject([
			{ id: "restart-background-task" },
		]);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing background runner proof");
		const tasks =
			change === "replace"
				? [
						{
							id: "replacement-background-task",
							type: "local_agent",
							description: "Latest background snapshot",
						},
					]
				: [];
		let after: Awaited<ReturnType<typeof sessionBackground>> | undefined;
		try {
			await harness.kill();
			writeFileSync(join(harness.root, "restart-background-change"), change);
			await vi.waitFor(
				() => {
					const frames = readFileSync(`${runner.socketPath}.spool`, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as RunnerMessage);
					expect(
						frames
							.reverse()
							.find(
								(frame) =>
									frame.type === "output" &&
									frame.output.type === "event" &&
									frame.output.event.type === "evidence.tasks_snapshot",
							),
					).toMatchObject({
						output: {
							type: "event",
							event: {
								type: "evidence.tasks_snapshot",
								data: {
									tasks: tasks.map(({ id, type, description }) => ({
										key: { taskId: id },
										taskType: type,
										description,
									})),
								},
							},
						},
					});
				},
				{ timeout: 5000 },
			);
			expect(() => process.kill(runner.pid, 0)).not.toThrow();
			await harness.restart();
			browser = await harness.connect(sessionId);
			await vi.waitFor(
				() => {
					expect(readFileSync(`${runner.socketPath}.spool`, "utf8")).toBe("");
				},
				{ timeout: 5000 },
			);
			await vi.waitFor(
				async () => {
					after = await sessionBackground(browser, sessionId);
					expect(after).toEqual({
						backgroundWork: change === "replace" ? "working" : null,
						backgroundTasks: tasks.map((task) => ({
							...task,
							kind: "subagent",
							firstSeenAt: expect.any(Number),
						})),
						tasksChecking: false,
					});
				},
				{ timeout: 5000 },
			);
		} finally {
			mkdirSync("test-results/process-harness", { recursive: true });
			writeFileSync(
				`test-results/process-harness/background-restart-${change}.json`,
				JSON.stringify(
					{ sessionId, runnerPid: runner.pid, before, after },
					null,
					2,
				),
			);
		}
	}, 60_000);
});

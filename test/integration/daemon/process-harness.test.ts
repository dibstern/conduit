import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ClaudeRunnerMessage,
	ClaudeRunnerSocket,
} from "../../../src/lib/provider/claude/claude-runner-protocol.js";
import {
	type ProcessBrowser,
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

async function sessionBackground(browser: ProcessBrowser, sessionId: string) {
	const envelopes = await Effect.runPromise(
		browser.rpc
			.SubscribeShell({ projectSlug: "process-test" })
			.pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds")),
	);
	const snapshot = [...envelopes][0];
	const session =
		snapshot?._tag === "snapshot"
			? snapshot.rows.find((session) => session.id === sessionId)
			: undefined;
	return {
		backgroundWork: session?.backgroundWork ?? null,
		backgroundTasks: session?.backgroundTasks ?? [],
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

	it("sends over browser RPC and receives each streamed response chunk", async () => {
		harness = await ProcessHarness.start({ enqueueMarkDelayMs: 250 });
		const browser = await harness.connect();
		const sessionId = await browser.createSession();
		const turn = await browser.send(sessionId, "stream-proof");
		expect(turn.chunks).toEqual(responseChunks("stream-proof"));
		expect(turn.done["code"]).toBe(0);
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

	it.each([
		"allow",
		"deny",
	] as const)("resolves a tool approval through browser RPC with decision %s", async (decision) => {
		harness = await ProcessHarness.start();
		const browser = await harness.connect();
		const sessionId = await browser.createSession();
		const cursor = browser.frames.length;
		const pending = browser.send(sessionId, "approval-proof");
		const request = await browser.waitFor(
			(message) => message["type"] === "permission_request",
			cursor,
		);
		expect(request["toolName"]).toBe("Bash");
		expect(request["toolInput"]).toEqual({
			command: "printf harness-approved",
		});
		expect(
			browser.frames
				.slice(cursor)
				.some(({ message }) => message["type"] === "tool_result"),
		).toBe(false);
		await browser.answerApproval(request, decision);
		const turn = await pending;
		expect(turn.chunks).toEqual(responseChunks("approval-proof"));
		const resolved = await browser.waitFor(
			(message) =>
				message["type"] === "permission_resolved" &&
				message["requestId"] === request["requestId"],
			cursor,
		);
		expect(resolved["decision"]).toBe(decision === "allow" ? "once" : "reject");
		const result = await browser.waitFor(
			(message) => message["type"] === "tool_result",
			cursor,
		);
		expect(result["content"]).toBe(
			decision === "allow" ? "harness-approved" : "harness-denied",
		);
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
			backgroundWork: "monitoring",
			backgroundTasks: [
				{
					id: "restart-background-task",
					type: "local_bash",
					description: "Background restart proof",
					firstSeenAt: expect.any(Number),
				},
			],
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
						expect(states[restart + 1]).toEqual(expected);
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
		const frames: ClaudeRunnerMessage[] = [];
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
					materializeSubagents: false,
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
								frame.output.type === "background-task",
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
						.map((line) => JSON.parse(line) as ClaudeRunnerMessage);
					sequences = retained.flatMap((frame) =>
						frame.type === "output" && frame.output.type === "background-task"
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
						.map((line) => JSON.parse(line) as ClaudeRunnerMessage);
					expect(
						frames
							.reverse()
							.find(
								(frame) =>
									frame.type === "output" &&
									frame.output.type === "background-task",
							),
					).toMatchObject({
						output: {
							type: "background-task",
							transition:
								change === "end"
									? { kind: "session-ended" }
									: { kind: "snapshot", tasks },
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
							firstSeenAt: expect.any(Number),
						})),
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

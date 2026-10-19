import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import {
	type ProcessBrowser,
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

const capabilityModels = ["sonnet", "claude-sonnet-4"].map((id) => ({
	id,
	name: id,
	providerId: "claude",
	contextWindowOptions: [{ value: "200k", label: "200K" }],
}));

async function sessionSnapshot(browser: ProcessBrowser, sessionId: string) {
	const envelopes = await Effect.runPromise(
		browser.rpc.SubscribeShell({}).pipe(
			Stream.filter((frame) => frame._tag !== "projects"),
			Stream.take(1),
			Stream.runCollect,
			Effect.timeout("5 seconds"),
		),
	);
	const snapshot = [...envelopes][0];
	if (snapshot?._tag !== "snapshot") throw new Error("Missing shell snapshot");
	const session = snapshot.rows.find((row) => row.id === sessionId);
	if (!session) throw new Error("Missing session row");
	return session;
}

function persisted(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			session: db
				.prepare(
					"SELECT status, last_turn_end_input_id FROM sessions WHERE id = ?",
				)
				.get(sessionId) as {
				status: string;
				last_turn_end_input_id: string | null;
			},
			turns: db
				.prepare("SELECT state FROM turns WHERE session_id = ?")
				.all(sessionId) as Array<{ state: string }>,
			turnRows: db
				.prepare(
					"SELECT turns.id, turns.state, turns.completed_at, messages.input_id FROM turns LEFT JOIN messages ON messages.id = turns.id WHERE turns.session_id = ? ORDER BY turns.requested_at, turns.rowid",
				)
				.all(sessionId) as Array<{
				id: string;
				state: string;
				completed_at: number | null;
				input_id: string | null;
			}>,
			pendingInputs: db
				.prepare(
					"SELECT input_id, state FROM pending_inputs WHERE session_id = ?",
				)
				.all(sessionId) as Array<{ input_id: string; state: string }>,
			terminalEvents: db
				.prepare(
					"SELECT type FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.interrupted', 'turn.error') ORDER BY sequence",
				)
				.all(sessionId) as Array<{ type: string }>,
			statusEvents: db
				.prepare(
					"SELECT data, metadata FROM events WHERE session_id = ? AND type = 'session.status' ORDER BY sequence",
				)
				.all(sessionId) as Array<{ data: string; metadata: string }>,
		};
	} finally {
		db.close();
	}
}

// Failure cases: restart marks a surviving turn idle, adoption emits a terminal
// event, a stale poller snapshot hides busy, or the adopted runner stops streaming.
describe("running Claude turn status across restart", () => {
	let harness: ProcessHarness | undefined;
	const proofs: Array<Record<string, unknown>> = [];
	afterEach(async () => {
		await harness?.dispose();
		const remainingRunnerPids = harness?.remainingRunnerPids();
		expect(remainingRunnerPids).toEqual([]);
		const lastProof = proofs.at(-1);
		if (lastProof) lastProof["remainingRunnerPids"] = remainingRunnerPids;
		harness = undefined;
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/conduit-test-ujwl-restart-status.json",
			JSON.stringify(proofs, null, 2),
		);
	});

	it.each([
		{ restart: "SIGINT", opencodeAvailable: false },
		{ restart: "RestartWithConfig", opencodeAvailable: false },
		{ restart: "SIGINT", opencodeAvailable: true },
		{ restart: "RestartWithConfig", opencodeAvailable: true },
	] as const)("reports an adopted running turn as processing after $restart with OpenCode available=$opencodeAvailable", async ({
		restart,
		opencodeAvailable,
	}) => {
		harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			foregroundCli: true,
			restartProof: true,
			capabilityModels,
			...(opencodeAvailable && { opencodeRecording: "chat-simple" }),
		});
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Running across restart");
		await Effect.runPromise(
			browser.rpc.SwitchModel({
				sessionId,
				originId: browser.originId,
				providerId: "claude",
				modelId: "claude-sonnet-4",
			}),
		);
		// This fixture pauses after its first delta until release-upgrade-turn.
		const prompt = "upgrade-long-turn";
		void browser.send(sessionId, prompt).catch(() => undefined);
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["role"] === "assistant" &&
				(message["parts"] as HistoryMessage["parts"])?.some(
					(part) => part.type === "text" && Boolean(part.text),
				) === true &&
				message["sessionId"] === sessionId,
		);
		await vi.waitFor(() => {
			if (!harness) throw new Error("Missing harness");
			expect(persisted(harness, sessionId).session.status).toBe("busy");
		});
		const before = persisted(harness, sessionId);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing runner PID");
		if (restart === "SIGINT") await harness.signal("SIGINT");
		else {
			await browser.restartServer();
			await harness.waitForExit();
		}
		expect(() => process.kill(runner.pid, 0)).not.toThrow();
		const stopped = persisted(harness, sessionId);
		await harness.restart();
		const reconnected = await harness.connect(sessionId);
		const initSnapshot = await sessionSnapshot(reconnected, sessionId);
		await reconnected.view(sessionId);
		const snapshot = await sessionSnapshot(reconnected, sessionId);
		const adopted = harness.marks
			.filter((mark) => mark.kind === "runner-started")
			.at(-1);
		const resumed = persisted(harness, sessionId);
		const proof: Record<string, unknown> = {
			restart,
			opencodeAvailable,
			sessionId,
			runnerPid: runner.pid,
			adopted,
			before,
			stopped,
			resumed,
			initSnapshot,
			snapshot,
		};
		proofs.push(proof);
		expect(adopted).toMatchObject({ pid: runner.pid });
		expect(initSnapshot.status).toBe("busy");
		expect(snapshot.status).toBe("busy");
		expect(resumed.session.status).toBe("busy");
		expect(resumed.terminalEvents).toEqual(before.terminalEvents);
		expect(resumed.turns).toEqual([{ state: "running" }]);
		const streamingCursor = reconnected.frames.length;
		proof["restartTerminalEvents"] = resumed.terminalEvents;
		const done = reconnected.waitForTurnEnd(sessionId, streamingCursor);
		writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
		expect((await done)["status"]).toBe("idle");
		await reconnected.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["role"] === "assistant" &&
				message["sessionId"] === sessionId &&
				(message["parts"] as HistoryMessage["parts"])
					?.filter((part) => part.type === "text")
					.map((part) => part.text ?? "")
					.join("") === responseChunks(prompt).join(""),
			streamingCursor,
		);
		const continuedProjectionCount = reconnected.frames
			.slice(streamingCursor)
			.filter(
				({ message }) =>
					message["type"] === "transcript_message" &&
					message["role"] === "assistant" &&
					(message["parts"] as HistoryMessage["parts"])?.some(
						(part) => part.type === "text" && Boolean(part.text),
					) === true &&
					message["sessionId"] === sessionId,
			).length;
		proof["continuedProjectionCount"] = continuedProjectionCount;
		expect(continuedProjectionCount).toBeGreaterThan(0);
		await vi.waitFor(() => {
			if (!harness) throw new Error("Missing harness");
			expect(persisted(harness, sessionId).session.status).toBe("idle");
		});
		proof["completed"] = persisted(harness, sessionId);
	}, 30_000);
});

// Failure cases: the row stays idle until the model streams, so SDK-local work
// such as /compact runs "blind" (conduit-test-6t7n); a busy reported at the
// start is never cleared, or lands after the turn's idle; the turn, which no
// assistant message names, stays open and holds every later input in the
// queue, while its result re-completes the previous turn instead
// (conduit-test-jyr9.12); a mid-turn permission-mode change reports idle,
// which shows the session idle and lets queued input drain into the running
// turn.
describe("Claude turn status before the model streams", () => {
	let harness: ProcessHarness | undefined;
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("persists busy during SDK-local work, then settles the turn and drains the queue", async () => {
		harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			capabilityModels,
		});
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Local work");
		await Effect.runPromise(
			browser.rpc.SwitchModel({
				sessionId,
				originId: browser.originId,
				providerId: "claude",
				modelId: "claude-sonnet-4",
			}),
		);
		// A prior answer makes the bare result below name that answer, as a
		// /compact after real work does.
		await browser.send(sessionId, "before-local-work");
		const [previous] = persisted(harness, sessionId).turnRows;
		// The fake SDK holds this prompt, then ends it with a bare result.
		const sent = browser.send(sessionId, "local-work-turn");
		await vi.waitFor(() => {
			expect(
				harness?.marks.some((mark) => mark.kind === "pre-assistant-held"),
			).toBe(true);
		}, 15_000);
		const held = persisted(harness, sessionId);
		writeFileSync(join(harness.root, "release-local-work"), "release");
		await sent;
		await vi.waitFor(() => {
			if (!harness) throw new Error("Missing harness");
			expect(persisted(harness, sessionId).session.status).toBe("idle");
		}, 15_000);
		const settled = persisted(harness, sessionId);
		const next = await browser
			.send(sessionId, "after-local-work", 15_000)
			.catch((error: unknown) => ({ error: String(error) }));
		const drained = persisted(harness, sessionId);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/conduit-test-6t7n-jyr9.12-local-work.json",
			JSON.stringify(
				{ sessionId, previous, held, settled, next, drained },
				null,
				2,
			),
		);
		expect(held.session.status).toBe("busy");
		expect(settled.turns).toEqual([
			{ state: "completed" },
			{ state: "completed" },
		]);
		expect(settled.turnRows[0]).toEqual(previous);
		// The end names the send it answered, so a browser waiting on this
		// send sees its turn end (conduit-test-jyr9.10).
		expect(settled.session.last_turn_end_input_id).toBe(
			settled.turnRows[1]?.input_id,
		);
		expect("chunks" in next ? next.chunks.join("") : next).toBe(
			responseChunks("after-local-work").join(""),
		);
		expect(drained.turns).toEqual([
			{ state: "completed" },
			{ state: "completed" },
			{ state: "completed" },
		]);
	}, 60_000);

	it("keeps consecutive inputs on their own turns after a bare result", async () => {
		harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			capabilityModels,
		});
		const fixture = harness;
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Bare result admission");
		await browser.send(sessionId, "before-local-work");
		writeFileSync(join(fixture.root, "release-local-work"), "release");
		const inputIds: string[] = [];
		const observations: Array<{
			prompt: string;
			turns: Array<{ input: number; state: string }>;
			endedInput: number;
		}> = [];
		try {
			// Send again as soon as the public idle row arrives, while the prior
			// result's publication and runner acknowledgement may still be finishing.
			for (let cycle = 0; cycle < 8; cycle++) {
				for (const prompt of ["local-work-turn", `after-local-work-${cycle}`]) {
					const inputId = randomUUID();
					inputIds.push(inputId);
					const cursor = browser.frames.length;
					await Effect.runPromise(
						browser.rpc["input.submit"]({
							sessionId,
							originId: browser.originId,
							inputId,
							delivery: "queue",
							text: prompt,
						}),
					);
					await browser.waitForTurnEnd(sessionId, cursor);
					const state = persisted(fixture, sessionId);
					observations.push({
						prompt,
						turns: state.turnRows.map((turn) => ({
							input: inputIds.indexOf(turn.input_id ?? "") + 1,
							state: turn.state,
						})),
						endedInput:
							inputIds.indexOf(state.session.last_turn_end_input_id ?? "") + 1,
					});
					expect(state.session.last_turn_end_input_id).toBe(inputId);
					expect(state.turnRows).toHaveLength(inputIds.length + 1);
					expect(state.turnRows.at(-1)).toMatchObject({
						id: inputId,
						state: "completed",
					});
				}
			}
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn23-claude-bare-result-admission.json",
				`${JSON.stringify(observations, null, 2)}\n`,
			);
		}
	}, 60_000);

	it("keeps a turn busy and its queue held across a mid-turn permission-mode change", async () => {
		harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			capabilityModels,
		});
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Mode change");
		const payload = {
			projectSlug: "process-test",
			sessionId,
			originId: browser.originId,
		};
		await Effect.runPromise(
			browser.rpc.SwitchModel({
				...payload,
				providerId: "claude",
				modelId: "claude-sonnet-4",
			}),
		);
		// This fixture pauses after its first delta until release-upgrade-turn.
		const prompt = "upgrade-long-turn";
		const sent = browser
			.send(sessionId, prompt, 30_000)
			.catch((error: unknown) => ({ error: String(error) }));
		await vi.waitFor(() => {
			if (!harness) throw new Error("Missing harness");
			expect(persisted(harness, sessionId).session.status).toBe("busy");
			expect(
				harness.marks.some(
					(mark) => mark.kind === "emit" && mark.prompt === prompt,
				),
			).toBe(true);
		}, 15_000);
		await Effect.runPromise(
			browser.rpc.SwitchPermissionMode({ ...payload, mode: "full" }),
		);
		// The SDK's own report of the change: its status message is the one
		// that used to read as idle.
		await vi.waitFor(() => {
			if (!harness) throw new Error("Missing harness");
			const db = new Database(harness.daemonStorePath(), { readonly: true });
			try {
				expect(
					db
						.prepare(
							"SELECT 1 FROM events WHERE session_id = ? AND type = 'session.permission_mode_changed' AND metadata LIKE '%claude.sdk.translator%'",
						)
						.get(sessionId),
				).toBeDefined();
			} finally {
				db.close();
			}
		}, 15_000);
		const inputId = randomUUID();
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				...payload,
				inputId,
				delivery: "queue",
				text: "after-mode-change",
			}),
		);
		await vi.waitFor(() => {
			if (!harness) throw new Error("Missing harness");
			expect(
				persisted(harness, sessionId).pendingInputs.some(
					(row) => row.input_id === inputId,
				),
			).toBe(true);
		}, 15_000);
		const held = persisted(harness, sessionId);
		writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
		await sent;
		await vi
			.waitFor(() => {
				if (!harness) throw new Error("Missing harness");
				const now = persisted(harness, sessionId);
				expect(now.turnRows.map((row) => row.state)).toEqual([
					"completed",
					"completed",
				]);
				expect(now.session.status).toBe("idle");
			}, 30_000)
			.catch(() => undefined);
		const drained = persisted(harness, sessionId);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/conduit-test-jyr9.12-mode-change.json",
			JSON.stringify({ sessionId, inputId, held, drained }, null, 2),
		);
		expect(held.session.status).toBe("busy");
		expect(
			held.statusEvents.map(
				(row) => (JSON.parse(row.data) as { status: string }).status,
			),
		).not.toContain("idle");
		expect(held.turns).toEqual([{ state: "running" }]);
		expect(held.pendingInputs).toContainEqual({
			input_id: inputId,
			state: "queued",
		});
		expect(drained.turnRows.map((row) => [row.id, row.state])).toEqual([
			[expect.any(String), "completed"],
			[inputId, "completed"],
		]);
		expect(drained.session.status).toBe("idle");
	}, 60_000);
});

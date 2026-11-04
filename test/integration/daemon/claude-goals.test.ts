// Claude goals as native commands end to end (82tn.32.26; CONTRACT.md 8.1, 8.5, 8.6), over the
// isolated process harness and the fake Claude process SDK. How it could fail (lane-3226 audit.md):
// 12. a clear goes with priority "now";
// 13. a clear interrupts the running turn;
// 14. Stop clears the goal by itself, or the queued clear never runs after Stop;
// 15. the clear's zero-turn result ends the foreground Run, or starts a wake Run;
// 16. the clear waits in the inbox behind the busy turn instead of reaching Claude at once;
// 22. an idle clear does not complete at once;
// 23. Stop during Clearing leaves the clear queued;
// 29-31. with no live process the clear fails, or the next launch sends the prompt first, renders
//     the clear's reply as chat or ends that launch's Run with the clear's result;
// 34. the row shows no phase while Claude queues the clear, or keeps it after the reply;
// 37, 39, 40. the process dies after the clear is sent and the clear is never resent, is resent
//     under the dead id, or goes after the next launch's prompt;
// 42. Pause or Resume reaches Claude, which has no goal pause, instead of being refused.
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	evolve,
	initialSessionLedgerState,
	type LedgerEvent,
	viewLedger,
} from "../../../src/lib/provider/run-ledger/run-ledger-decider.js";
import { runnerProcessTable } from "../../../src/lib/provider/runner/runner-registry.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const EVIDENCE = "test-results/lane-3226-claude-goals.json";

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		const entries = db
			.prepare(
				"SELECT entry_json AS entry FROM run_ledger_entries WHERE session_id = ? ORDER BY entry_seq",
			)
			.all(sessionId) as { entry: string }[];
		return {
			nativeCommands: viewLedger(
				entries.reduce(
					(state, { entry }) => evolve(state, JSON.parse(entry) as LedgerEvent),
					initialSessionLedgerState(sessionId, "claude"),
				),
			).nativeCommands,
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as { id: string; status: string }[],
			events: (
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? ORDER BY sequence",
					)
					.all(sessionId) as { type: string }[]
			).map(({ type }) => type),
		};
	} finally {
		db.close();
	}
};

const sessionRow = async (harness: ProcessHarness, sessionId: string) =>
	(
		await harness.requestRpc({
			_tag: "ListDaemonSessions",
			projectSlug: "process-test",
		})
	).sessions.find((session) => session.id === sessionId);

const goalPhase = async (harness: ProcessHarness, sessionId: string) =>
	(
		await harness.requestRpc({
			_tag: "ListDaemonSessions",
			projectSlug: "process-test",
		})
	).sessions.find((session) => session.id === sessionId)?.goalPhase;

describe("Claude goals as native commands", () => {
	let harness: ProcessHarness | undefined;
	const proofs: Record<string, unknown>[] = [];
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			EVIDENCE,
			JSON.stringify({ ticket: "conduit-test-82tn.32.26", proofs }, null, 2),
		);
		const scratch = process.env["LANE_EVIDENCE_DIR"];
		if (scratch)
			copyFileSync(EVIDENCE, `${scratch}/lane-3226-claude-goals.json`);
	});

	const start = async () => {
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		await harness.restart();
		const browser = await harness.connect();
		await browser.setAutoSettle(null);
		return { fixture: harness, browser };
	};

	it("completes an idle clear at once, without a Run", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude goal idle clear");
		await browser.send(sessionId, "goal-idle-seed");
		const before = read(fixture, sessionId);
		const commandId = randomUUID();
		await fixture.requestRpc({ _tag: "ClearGoal", sessionId, commandId });
		// test-waits-allow polling: the native command's result reaches the store with no browser frame.
		const after = await vi.waitFor(() => {
			const ledger = read(fixture, sessionId);
			expect(ledger.nativeCommands).toEqual([{ commandId, tag: "Completed" }]);
			return ledger;
		}, 10_000);
		const input = await fixture.waitForMark(
			(mark) => mark.kind === "enqueue" && mark.prompt === "/goal clear",
		);
		// 8.6: never priority "now"; 8.2: its zero-turn result starts and ends no Run.
		expect(input).not.toMatchObject({ priority: "now" });
		expect(after.runs).toEqual(before.runs);
		expect(after.events).not.toContain("evidence.turn_started");
		proofs.push({
			case: "idle-clear",
			sessionId,
			input,
			nativeCommands: after.nativeCommands,
			runs: after.runs,
		});
	});

	it("queues a mid-turn clear behind the turn without interrupting it, and Stop then runs it", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude goal mid-turn clear");
		const turn = browser
			.send(sessionId, "goal-long-turn")
			.catch(() => undefined);
		await fixture.waitForMark(
			(mark) => mark.kind === "enqueue" && mark.prompt === "goal-long-turn",
		);
		const commandId = randomUUID();
		await fixture.requestRpc({ _tag: "ClearGoal", sessionId, commandId });
		const queued = await fixture.waitForMark(
			(mark) => mark.kind === "input-queued" && mark.prompt === "/goal clear",
		);
		// test-waits-allow polling: Claude's queued receipt reaches the store with no browser frame.
		const whileQueued = await vi.waitFor(() => {
			const ledger = read(fixture, sessionId);
			expect(ledger.nativeCommands).toEqual([{ commandId, tag: "Queued" }]);
			return ledger;
		}, 10_000);
		// test-waits-allow polling: the row follows the arm's hand-over, which sends no frame here.
		const phaseWhileQueued = await vi.waitFor(async () => {
			const phase = await goalPhase(fixture, sessionId);
			expect(phase).toEqual({
				tag: "Pending",
				action: { kind: "clear" },
				send: "Queued",
			});
			return phase;
		}, 10_000);
		// 8.6: the clear never interrupts the turn, and never goes with priority "now".
		expect(queued).not.toMatchObject({ priority: "now" });
		expect(whileQueued.runs.map(({ status }) => status)).toEqual(["running"]);
		expect(
			fixture.marks.some((mark) => mark.kind === "query-interrupted"),
		).toBe(false);
		await fixture.requestRpc({
			_tag: "CancelSession",
			sessionId,
			commandId: randomUUID(),
		});
		await turn;
		// test-waits-allow polling: the interrupted Run and the clear's result reach the store with no browser frame.
		const after = await vi.waitFor(() => {
			const ledger = read(fixture, sessionId);
			expect(ledger.nativeCommands).toEqual([{ commandId, tag: "Completed" }]);
			expect(ledger.runs.map(({ status }) => status)).toEqual(["interrupted"]);
			return ledger;
		}, 10_000);
		const interrupted = fixture.marks.findIndex(
			(mark) => mark.kind === "query-interrupted",
		);
		const ran = fixture.marks.findIndex(
			(mark) => mark.kind === "enqueue" && mark.prompt === "/goal clear",
		);
		// Stop interrupts, then the clear runs (8.6).
		expect(interrupted).toBeGreaterThanOrEqual(0);
		expect(ran).toBeGreaterThan(interrupted);
		expect(after.events).not.toContain("evidence.turn_started");
		// test-waits-allow polling: the reply's confirmation reaches the row with no browser frame.
		await vi.waitFor(
			async () => expect(await goalPhase(fixture, sessionId)).toBeUndefined(),
			10_000,
		);
		proofs.push({
			case: "mid-turn-clear-then-stop",
			phaseWhileQueued,
			sessionId,
			queued,
			nativeCommands: {
				whileQueued: whileQueued.nativeCommands,
				after: after.nativeCommands,
			},
			runs: { whileQueued: whileQueued.runs, after: after.runs },
			order: { interrupted, ran },
		});
	});

	it("sends a clear made with no live process first at the next launch", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude goal cold clear");
		const commandId = randomUUID();
		await fixture.requestRpc({ _tag: "ClearGoal", sessionId, commandId });
		// test-waits-allow polling: the kept clear's phase reaches the row with no browser frame.
		const phaseBefore = await vi.waitFor(async () => {
			const phase = await goalPhase(fixture, sessionId);
			expect(phase).toEqual({
				tag: "Pending",
				action: { kind: "clear" },
				send: "Sent",
			});
			return phase;
		}, 10_000);
		// Not failed for want of a process (lane brief; CONTRACT.md 8.5).
		expect(read(fixture, sessionId).nativeCommands).toEqual([
			expect.objectContaining({ commandId, tag: "Sent" }),
		]);
		await browser.send(sessionId, "goal-after-cold-clear");
		// test-waits-allow polling: the clear's result reaches the store with no browser frame.
		const after = await vi.waitFor(() => {
			const ledger = read(fixture, sessionId);
			expect(ledger.nativeCommands).toEqual([{ commandId, tag: "Completed" }]);
			expect(ledger.runs.map(({ status }) => status)).toEqual(["completed"]);
			return ledger;
		}, 10_000);
		const clear = fixture.marks.findIndex(
			(mark) => mark.kind === "enqueue" && mark.prompt === "/goal clear",
		);
		const prompt = fixture.marks.findIndex(
			(mark) =>
				mark.kind === "enqueue" && mark.prompt === "goal-after-cold-clear",
		);
		expect(clear).toBeGreaterThanOrEqual(0);
		expect(prompt).toBeGreaterThan(clear);
		expect(fixture.marks[clear]).not.toMatchObject({ priority: "now" });
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		const replyAsChat = db
			.prepare(
				"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND (type LIKE 'message.%' OR type LIKE 'text.%') AND data LIKE '%Goal cleared%'",
			)
			.get(sessionId) as { n: number };
		db.close();
		expect(replyAsChat.n).toBe(0);
		// test-waits-allow polling: the reply's confirmation reaches the row with no browser frame.
		await vi.waitFor(
			async () => expect(await goalPhase(fixture, sessionId)).toBeUndefined(),
			10_000,
		);
		proofs.push({
			case: "cold-clear-first-at-next-launch",
			sessionId,
			phaseBefore,
			nativeCommands: after.nativeCommands,
			runs: after.runs,
			order: { clear, prompt },
		});
	});
	// goal-long-turn-unset: the SDK drops its active goal before Claude runs the clear, which is
	// not a confirmation, so the clear is still resent (CONTRACT.md 8.6, 2963).
	it.each([
		"goal-long-turn",
		"goal-long-turn-unset",
	])("resends a clear first at the next launch when the process dies after sending it (%s)", async (turnPrompt) => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude goal process death");
		await browser.send(sessionId, "goal-rebind");
		// test-waits-allow polling: the goal's confirmation reaches the row with no browser frame.
		await vi.waitFor(async () => {
			const row = await sessionRow(fixture, sessionId);
			expect(row?.goalState?.goal?.condition).toBe("After rebinding");
		}, 10_000);
		const turn = browser.send(sessionId, turnPrompt).catch(() => undefined);
		await fixture.waitForMark(
			(mark) => mark.kind === "enqueue" && mark.prompt === turnPrompt,
		);
		const commandId = randomUUID();
		await fixture.requestRpc({ _tag: "ClearGoal", sessionId, commandId });
		await fixture.waitForMark(
			(mark) => mark.kind === "input-queued" && mark.prompt === "/goal clear",
		);
		if (turnPrompt === "goal-long-turn-unset")
			// test-waits-allow polling: the dropped active goal reaches the row with no browser frame.
			await vi.waitFor(async () => {
				const row = await sessionRow(fixture, sessionId);
				expect(row?.goalState?.goal).toBeFalsy();
			}, 10_000);
		const runner = fixture.marks.find(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
		);
		if (runner?.kind !== "runner-started") throw new Error("no runner mark");
		const owned = runnerProcessTable.inspect(runner.pid);
		if (owned.state !== "running") throw new Error("runner not running");
		process.kill(runner.pid, "SIGKILL");
		await turn;
		// test-waits-allow polling: the process death and the resend reach the store with no browser frame.
		const afterDeath = await vi.waitFor(() => {
			const ledger = read(fixture, sessionId);
			expect(ledger.nativeCommands).toEqual([
				{ commandId, tag: "Failed", code: "process_lost" },
				expect.objectContaining({ tag: "Sent" }),
			]);
			return ledger;
		}, 15_000);
		const resent = afterDeath.nativeCommands[1]?.commandId;
		expect(resent).not.toBe(commandId);
		// The clear still shows as pending, not failed: Active does not confirm a clear (8.6).
		expect(await goalPhase(fixture, sessionId)).toEqual({
			tag: "Pending",
			action: { kind: "clear" },
			send: "Sent",
		});
		const deathMark = fixture.marks.length;
		await browser.send(sessionId, "goal-after-death");
		// test-waits-allow polling: the resent clear's result reaches the store with no browser frame.
		const after = await vi.waitFor(() => {
			const ledger = read(fixture, sessionId);
			expect(ledger.nativeCommands.at(-1)).toEqual({
				commandId: resent,
				tag: "Completed",
			});
			return ledger;
		}, 15_000);
		const later = fixture.marks.slice(deathMark);
		const clear = later.findIndex(
			(mark) => mark.kind === "enqueue" && mark.prompt === "/goal clear",
		);
		const prompt = later.findIndex(
			(mark) => mark.kind === "enqueue" && mark.prompt === "goal-after-death",
		);
		expect(clear).toBeGreaterThanOrEqual(0);
		expect(prompt).toBeGreaterThan(clear);
		// test-waits-allow polling: the reply's confirmation reaches the row with no browser frame.
		await vi.waitFor(async () => {
			const row = await sessionRow(fixture, sessionId);
			expect(row?.goalPhase).toBeUndefined();
			expect(row?.goalState?.goal).toBeFalsy();
		}, 10_000);
		proofs.push({
			case: `process-death-resends-clear-first (${turnPrompt})`,
			sessionId,
			deadCommand: commandId,
			resent,
			nativeCommands: after.nativeCommands,
			runs: after.runs,
			order: { clear, prompt },
		});
	});
	it("refuses Pause and Resume for Claude, which has no goal pause, and sends nothing", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude goal pause");
		await browser.send(sessionId, "goal-pause-seed");
		const refusals = [
			await fixture.requestRpc({
				_tag: "PauseGoal",
				sessionId,
				commandId: randomUUID(),
			}),
			await fixture.requestRpc({
				_tag: "ResumeGoal",
				sessionId,
				commandId: randomUUID(),
			}),
		];
		expect(refusals).toEqual([
			{ ok: false, reason: "goal_pause_unsupported" },
			{ ok: false, reason: "goal_pause_unsupported" },
		]);
		expect(read(fixture, sessionId).nativeCommands).toEqual([]);
		expect(await goalPhase(fixture, sessionId)).toBeUndefined();
		proofs.push({ case: "pause-refused", sessionId, refusals });
	});
});

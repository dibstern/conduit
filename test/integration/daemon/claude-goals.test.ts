// Claude goals as native commands end to end (82tn.32.26; CONTRACT.md 8.1, 8.5, 8.6), over the
// isolated process harness and the fake Claude process SDK. How it could fail (lane-3226 audit.md):
// 12. a clear goes with priority "now";
// 13. a clear interrupts the running turn;
// 14. Stop clears the goal by itself, or the queued clear never runs after Stop;
// 15. the clear's zero-turn result ends the foreground Run, or starts a wake Run;
// 16. the clear waits in the inbox behind the busy turn instead of reaching Claude at once;
// 22. an idle clear does not complete at once;
// 23. Stop during Clearing leaves the clear queued.
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
		proofs.push({
			case: "mid-turn-clear-then-stop",
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
});

// Claude on the Run Ledger end to end (82tn.32.6; CONTRACT.md 2.1 row 215, 6.1, 6.9), over the
// isolated process harness and the fake Claude process SDK. How it could fail (lane audit F40-F48):
// 40. no process_started for a Claude runner, so the ledger drops all its unsolicited evidence;
// 41. process_started lands after the runner's first frame reaches the ledger;
// 42. a candidate's hello reports one, so two runners serve at once;
// 43. a recover() adoption reports reattached false;
// 44. a spawned runner reports reattached true;
// 45. the swap commit misses R's process_started, or lands it before old's process_lost or in
//     another write;
// 47. the label's querySeq is not the hello's;
// and the send's transcript changes, or its Run ends other than once.
import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

const OLD_BUILD = "82tn-32-6-before";
const NEW_BUILD = "82tn-32-6-after";

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare(
					"SELECT sequence, type, json_extract(data, '$.runnerId') AS runnerId, json_extract(data, '$.label') AS label, json_extract(data, '$.reattached') AS reattached FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as {
				sequence: number;
				type: string;
				runnerId: string | null;
				label: string | null;
				reattached: number | null;
			}[],
			ends: db
				.prepare(
					"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.reason.tag') AS reason FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
				)
				.all(sessionId) as { runId: string; reason: string }[],
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as { id: string; status: string }[],
			runners: db
				.prepare(
					"SELECT runner_id AS runnerId, role, retired_at AS retiredAt FROM claude_runner_cursors WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as {
				runnerId: string;
				role: string;
				retiredAt: number | null;
			}[],
		};
	} finally {
		db.close();
	}
};
type Ledger = ReturnType<typeof read>;

const processEvidence = (ledger: Ledger) =>
	ledger.events
		.filter((event) => event.type.startsWith("evidence.process_"))
		.map(({ type, runnerId, label, reattached }) => ({
			type,
			runnerId,
			label,
			reattached,
		}));

/** Every Run main started ends in the ledger exactly once (2.1, 3.8). */
const endsOnce = (ledger: Ledger) => {
	expect(ledger.runs.length).toBeGreaterThan(0);
	expect(ledger.runs.every((run) => run.status === "completed")).toBe(true);
	expect(ledger.ends.map((end) => end.runId).sort()).toEqual(
		ledger.runs.map((run) => run.id).sort(),
	);
};

describe("Claude on the Run Ledger", () => {
	let harness: ProcessHarness | undefined;
	const proofs: Record<string, unknown>[] = [];
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn-32-6-claude-ledger.json",
			JSON.stringify({ ticket: "conduit-test-82tn.32.6", proofs }, null, 2),
		);
	});

	const start = async (buildId?: string) => {
		harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			...(buildId ? { buildId } : {}),
		});
		const browser = await harness.connect();
		await browser.setAutoSettle(null);
		return { fixture: harness, browser };
	};
	const runnerOf = (ledger: Ledger) => {
		const [runner] = ledger.runners;
		if (!runner) throw new Error("no runner registered");
		return runner.runnerId;
	};

	it("reports a spawned runner's start before its first frame, and its send's Run ends once", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude ledger send");
		const prompt = "claude-ledger-send";
		const { chunks } = await browser.send(sessionId, prompt);
		expect(chunks.join("")).toBe(responseChunks(prompt).join(""));
		// The send's done follows its Run's end, folded in the same write (2.1).
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		const runnerId = runnerOf(ledger);
		expect(processEvidence(ledger)).toEqual([
			{
				type: "evidence.process_started",
				runnerId,
				label: `${runnerId}:0`,
				reattached: 0,
			},
		]);
		// 6.1: before any of its frames reach the ledger (its hold, its output).
		const started = ledger.events.find(
			(event) => event.type === "evidence.process_started",
		);
		const firstFrame = ledger.events.find(
			(event) =>
				event.type === "run.dispatched" || event.type === "message.created",
		);
		expect(started?.sequence).toBeLessThan(
			firstFrame?.sequence ?? Number.POSITIVE_INFINITY,
		);
		proofs.push({
			case: "spawn",
			sessionId,
			evidence: processEvidence(ledger),
			ends: ledger.ends,
			runs: ledger.runs,
		});
	});

	it("reports reattached true when a daemon restart recovers the surviving runner", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude ledger reattach");
		await browser.send(sessionId, "claude-ledger-before-restart");
		const runnerId = runnerOf(read(fixture, sessionId));
		await fixture.kill();
		await fixture.restart();
		const after = await fixture.connect(sessionId);
		const prompt = "claude-ledger-after-restart";
		expect((await after.send(sessionId, prompt)).chunks.join("")).toBe(
			responseChunks(prompt).join(""),
		);
		const ledger = read(fixture, sessionId);
		expect(ledger.runs).toHaveLength(2);
		endsOnce(ledger);
		// The same runner served both sends: no loss, one fresh start, one reattach.
		expect(ledger.runners.map((runner) => runner.runnerId)).toEqual([runnerId]);
		expect(processEvidence(ledger)).toEqual([
			{
				type: "evidence.process_started",
				runnerId,
				label: `${runnerId}:0`,
				reattached: 0,
			},
			{
				type: "evidence.process_started",
				runnerId,
				label: `${runnerId}:0`,
				reattached: 1,
			},
		]);
		proofs.push({
			case: "reattach",
			sessionId,
			evidence: processEvidence(ledger),
			ends: ledger.ends,
			runs: ledger.runs,
		});
	});

	it("lands old's process_lost and R's process_started together in the swap commit", async () => {
		const { fixture, browser } = await start(OLD_BUILD);
		const sessionId = await browser.createSession("Claude ledger swap");
		await browser.send(sessionId, "claude-ledger-before-swap");
		const old = runnerOf(read(fixture, sessionId));
		const oldPid = fixture.marks.find(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
		);
		if (oldPid?.kind !== "runner-started") throw new Error("no runner hello");
		await fixture.kill();
		await fixture.restart({ buildId: NEW_BUILD });
		const after = await fixture.connect(sessionId);
		await fixture.waitForMark(
			(mark) =>
				mark.kind === "runner-upgrade" &&
				mark.phase === "switched" &&
				mark.oldPid === oldPid.pid,
		);
		const prompt = "claude-ledger-after-swap";
		expect((await after.send(sessionId, prompt)).chunks.join("")).toBe(
			responseChunks(prompt).join(""),
		);
		const ledger = read(fixture, sessionId);
		expect(ledger.runs).toHaveLength(2);
		endsOnce(ledger);
		const replacement = ledger.runners.find(
			(runner) => runner.runnerId !== old && runner.retiredAt === null,
		);
		if (!replacement) throw new Error("no serving replacement");
		const evidence = processEvidence(ledger);
		// The restart recovers old (reattached), then the swap commit retires it and starts R.
		expect(evidence).toEqual([
			{
				type: "evidence.process_started",
				runnerId: old,
				label: `${old}:0`,
				reattached: 0,
			},
			{
				type: "evidence.process_started",
				runnerId: old,
				label: `${old}:0`,
				reattached: 1,
			},
			{
				type: "evidence.process_lost",
				runnerId: old,
				label: null,
				reattached: null,
			},
			{
				type: "evidence.process_started",
				runnerId: replacement.runnerId,
				label: `${replacement.runnerId}:0`,
				reattached: 0,
			},
		]);
		// One write: R's start directly follows old's loss in the session's stream (6.9).
		const lost = ledger.events.findIndex(
			(event) => event.type === "evidence.process_lost",
		);
		expect(ledger.events[lost + 1]).toMatchObject({
			type: "evidence.process_started",
			runnerId: replacement.runnerId,
		});
		proofs.push({
			case: "swap",
			sessionId,
			old,
			replacement: replacement.runnerId,
			evidence,
			ends: ledger.ends,
			runs: ledger.runs,
		});
	});
});

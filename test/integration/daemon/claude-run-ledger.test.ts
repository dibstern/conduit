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
// 50. a send's own turn reports a turn_started;
// 51. a wake's turn_ended is missing at its first clear (its result);
// 52. one wake reports two turn_endeds;
// 53. a wake's label is not its runner's querySeq;
// and the send's transcript changes, or its Run ends other than once.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
					"SELECT sequence, type, json_extract(data, '$.runnerId') AS runnerId, json_extract(data, '$.label') AS label, json_extract(data, '$.reattached') AS reattached, json_extract(data, '$.wakeTask.taskId') AS wakeTask FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as {
				sequence: number;
				type: string;
				runnerId: string | null;
				label: string | null;
				reattached: number | null;
				wakeTask: string | null;
			}[],
			ends: db
				.prepare(
					"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.reason.tag') AS reason FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
				)
				.all(sessionId) as { runId: string; reason: string }[],
			facts: db
				.prepare(
					"SELECT event_sequence AS sequence, coalesce(json_extract(entry_json, '$.command.observation.kind'), json_extract(entry_json, '$.command.settlement.kind')) AS kind, json_extract(entry_json, '$.command.observation.runId') AS runId, json_extract(entry_json, '$.command.observation.runnerId') AS runnerId FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'fact' ORDER BY entry_seq",
				)
				.all(sessionId) as {
				sequence: number;
				kind: string | null;
				runId: string | null;
				runnerId: string | null;
			}[],
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
	const ids = ledger.runs.map((run) => run.id);
	expect(
		ledger.ends
			.map((end) => end.runId)
			.filter((runId) => ids.includes(runId))
			.sort(),
	).toEqual(ids.sort());
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

	const start = async (
		options: Omit<Parameters<typeof ProcessHarness.start>[0], "dist"> = {},
	) => {
		harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			...options,
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
		// A send's own turn is no wake: it reports no turn evidence (2.1 row 215).
		expect(
			ledger.events.filter((event) => event.type.startsWith("evidence.turn_")),
		).toEqual([]);
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
		const { fixture, browser } = await start({ buildId: OLD_BUILD });
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
	it("gives a send held through the swap commit authority on R's first evidence", async () => {
		const { fixture, browser } = await start({ buildId: OLD_BUILD });
		const sessionId = await browser.createSession("Claude ledger held swap");
		await browser.send(sessionId, "claude-ledger-before-held-swap");
		const old = runnerOf(read(fixture, sessionId));
		await fixture.kill();
		// Hold the swap right after its commit (6.9), before upgrade-activate.
		const gate = join(
			fixture.root,
			"conduit-test-hold-runner-swap-after-commit",
		);
		writeFileSync(gate, "pause");
		await fixture.restart({
			buildId: NEW_BUILD,
			serviceEnvironment: { CONDUIT_TEST_RUNNER_SWAP_PAUSE: "after-commit" },
		});
		const after = await fixture.connect(sessionId);
		const paused = await fixture.waitForMark(
			(mark) =>
				mark.kind === "runner-swap-paused" && mark.sessionId === sessionId,
		);
		if (paused.kind !== "runner-swap-paused") throw new Error("no swap pause");
		const prompt = "claude-ledger-held-through-swap";
		const sent = after.send(sessionId, prompt);
		// The send is admitted while the swap is held after its commit. Its Run row is the only
		// witness: nothing reaches the browser or the runner until the permit is released.
		// test-waits-allow polling: the held swap emits no event for an admitted send.
		await vi.waitFor(() =>
			expect(read(fixture, sessionId).runs).toHaveLength(2),
		);
		rmSync(gate);
		expect((await sent).chunks.join("")).toBe(responseChunks(prompt).join(""));
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		const replacement = paused.newRunnerId;
		const heldRun = ledger.runs[1]?.id;
		expect(processEvidence(ledger).slice(-2)).toEqual([
			{
				type: "evidence.process_lost",
				runnerId: old,
				label: null,
				reattached: null,
			},
			{
				type: "evidence.process_started",
				runnerId: replacement,
				label: `${replacement}:0`,
				reattached: 0,
			},
		]);
		const startedAt = ledger.events.find(
			(event) =>
				event.type === "evidence.process_started" &&
				event.runnerId === replacement,
		)?.sequence;
		// Its first evidence, the hold naming R, is folded (a dropped one records no fact) after
		// R's start, and its result then ends the Run completed.
		const facts = ledger.facts.filter(
			(fact) =>
				fact.runId === heldRun &&
				!["run_requested", "run_started"].includes(fact.kind ?? ""),
		);
		expect(facts[0]).toMatchObject({
			kind: "run_dispatched",
			runnerId: replacement,
		});
		expect(facts[0]?.sequence).toBeGreaterThan(
			startedAt ?? Number.POSITIVE_INFINITY,
		);
		expect(ledger.ends.find((end) => end.runId === heldRun)?.reason).toBe(
			"completed",
		);
		proofs.push({
			case: "send-held-through-swap",
			sessionId,
			old,
			replacement,
			heldRun,
			facts,
			ends: ledger.ends,
			runs: ledger.runs,
		});
	});
	it("runs a send that reaches R before upgrade-activate as serving, with changed settings", async () => {
		const { fixture, browser } = await start({ buildId: OLD_BUILD });
		// Project instructions make a settings replay impossible, as in any real repository.
		writeFileSync(join(fixture.projectDir, "CLAUDE.md"), "Project rules.\n");
		const settings = join(fixture.root, "claude/settings.json");
		writeFileSync(settings, JSON.stringify({ autoCompactEnabled: false }));
		const sessionId = await browser.createSession("Claude ledger early send");
		await browser.send(sessionId, "claude-ledger-before-early-send");
		const old = runnerOf(read(fixture, sessionId));
		await fixture.kill();
		// Hold the swap after the lock's release, before upgrade-activate (6.9).
		const gate = join(
			fixture.root,
			"conduit-test-hold-runner-swap-before-activate",
		);
		writeFileSync(gate, "pause");
		await fixture.restart({
			buildId: NEW_BUILD,
			serviceEnvironment: { CONDUIT_TEST_RUNNER_SWAP_PAUSE: "before-activate" },
		});
		const after = await fixture.connect(sessionId);
		const paused = await fixture.waitForMark(
			(mark) =>
				mark.kind === "runner-swap-paused" && mark.sessionId === sessionId,
		);
		if (paused.kind !== "runner-swap-paused") throw new Error("no swap pause");
		// AI3: the database's serving row names R alone once the commit lands.
		const serving = () =>
			read(fixture, sessionId)
				.runners.filter(
					(runner) => runner.role === "serving" && runner.retiredAt === null,
				)
				.map((runner) => runner.runnerId);
		expect(serving()).toEqual([paused.newRunnerId]);
		// The user changes settings that cannot be replayed while R is still a Candidate.
		writeFileSync(settings, JSON.stringify({ autoCompactEnabled: true }));
		// A stopped send ends R's warm query, so the next send prepares a new one on R.
		const stall = "stall-before-activate";
		const stalled = after.send(sessionId, stall).catch(() => undefined);
		await fixture.waitForMark(
			(mark) => mark.kind === "enqueue" && mark.prompt === stall,
		);
		await fixture.requestRpc({
			_tag: "CancelSession",
			sessionId,
			commandId: randomUUID(),
		});
		await stalled;
		const prompt = "claude-ledger-before-activate";
		// The whole send completes while upgrade-activate is still held.
		expect((await after.send(sessionId, prompt)).chunks.join("")).toBe(
			responseChunks(prompt).join(""),
		);
		const enqueued = fixture.marks.find(
			(mark) => mark.kind === "enqueue" && mark.prompt === prompt,
		);
		const query = fixture.marks.find(
			(mark) =>
				mark.kind === "query" &&
				enqueued?.kind === "enqueue" &&
				mark.queryId === enqueued.queryId,
		);
		if (query?.kind !== "query") throw new Error("no query for the send");
		// A new query on R that read the changed files natively, as a serving runner does.
		expect(query.pid).toBe(paused.newPid);
		expect(JSON.parse(query.effectiveSettingsJson)).toMatchObject({
			autoCompactEnabled: true,
		});
		expect(
			fixture.marks.some(
				(mark) => mark.kind === "runner-upgrade" && mark.phase === "switched",
			),
		).toBe(false);
		rmSync(gate);
		await fixture.waitForMark(
			(mark) =>
				mark.kind === "runner-upgrade" &&
				mark.phase === "switched" &&
				mark.sessionId === sessionId,
		);
		const ledger = read(fixture, sessionId);
		expect(ledger.runs).toHaveLength(3);
		// Each Run, the stopped one included, ends in the ledger exactly once.
		expect(
			ledger.ends
				.map((end) => end.runId)
				.filter((runId) => ledger.runs.some((run) => run.id === runId))
				.sort(),
		).toEqual(ledger.runs.map((run) => run.id).sort());
		expect(serving()).toEqual([paused.newRunnerId]);
		const early = ledger.runs[2]?.id;
		const dispatched = ledger.facts.find(
			(fact) => fact.runId === early && fact.kind === "run_dispatched",
		);
		expect(dispatched?.runnerId).toBe(paused.newRunnerId);
		proofs.push({
			case: "send-before-upgrade-activate",
			sessionId,
			old,
			replacement: paused.newRunnerId,
			dispatched,
			ends: ledger.ends,
			runs: ledger.runs,
		});
	});
	it("reports a Claude wake's turn_started and turn_ended under its runner's label", async () => {
		const { fixture, browser } = await start({
			claudeReplay: {
				// The background shell's notification wakes the agent after the first result.
				turns: ["background-shell-turn", "pong-thinking-text-turn"],
			},
		});
		const sessionId = await browser.createSession("Claude ledger wake");
		await browser.send(sessionId, "Run sleep 8 in the background");
		// A start waits for the wake's turn (8.3), so the second send ends after the wake.
		await browser.send(sessionId, "ping");
		const ledger = read(fixture, sessionId);
		expect(ledger.runs).toHaveLength(2);
		endsOnce(ledger);
		const runnerId = runnerOf(ledger);
		const label = `${runnerId}:0`;
		const turns = ledger.events.filter((event) =>
			event.type.startsWith("evidence.turn_"),
		);
		expect(turns.map(({ type, label }) => ({ type, label }))).toEqual([
			{ type: "evidence.turn_started", label },
			{ type: "evidence.turn_ended", label },
		]);
		expect(turns[0]?.wakeTask).toBe("bxtrbpf91");
		// The wake falls between the first send's end and the second's dispatch.
		const dispatched = ledger.events.filter(
			(event) => event.type === "run.dispatched",
		);
		const completed = ledger.events.filter(
			(event) => event.type === "turn.completed",
		);
		expect(turns[0]?.sequence).toBeGreaterThan(completed[0]?.sequence ?? 0);
		expect(turns[1]?.sequence).toBeLessThan(
			dispatched[1]?.sequence ?? Number.POSITIVE_INFINITY,
		);
		// The ledger records the wake as a Run of its own and ends it at its turn_ended.
		const wakeEnds = ledger.ends.filter(
			(end) => !ledger.runs.some((run) => run.id === end.runId),
		);
		expect(wakeEnds).toHaveLength(1);
		proofs.push({
			case: "wake",
			sessionId,
			turns,
			ends: ledger.ends,
			runs: ledger.runs,
		});
	});
});

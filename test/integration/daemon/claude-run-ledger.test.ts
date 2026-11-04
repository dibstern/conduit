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
// 80. a Stop over only a wake leaves the wake's end to the alarm (forced), or never reports it;
// 81. the Queued Run behind that wake waits for the alarm instead of the wake's turn_ended;
// 86. a wake's stream failure ends it without turn_ended, or before the translator's endTurn;
// 87. that failed wake's work ends forced, by the alarm;
// 94. a draft pre-warm's runner never reports its start once CreateSession stores its session,
//     so the ledger refuses every labelled fact it sends;
// 95. that runner reports its start twice, or after its first send's first frame;
// 96. a wake whose result is an SDK error ends completed, its error never reaching its Run;
// 97. that failed wake's result ends a user Run, or folds twice;
// 90. a wake that took a merged steer reports no turn_ended, or two, once stopped;
// 91. that wake's work ends forced, by the ledger stop deadline's alarm;
// 92. the steer's Run ends twice or not at all;
// 93. the Stop's interrupt fails the replay (an unrecorded interrupt) instead of ending the turn;
// 153. a send waiting behind a wake when its runner dies is never delivered, or its Run stays
//      Queued in the ledger (82tn.32.10; CONTRACT.md 3.6, 685-698);
// 154. that start is handed to the dead runner, or delivered twice;
// 155. its Run ends twice, or main's run never ends;
// 320. the test releases the held wake before killing its runner, so the wake can end first and the
//      runner take the send: that hand-over and its release then count as a second dispatch;
// and the send's transcript changes, or its Run ends other than once.
// 390. a restart's reattach report, which changes nothing, re-stamps the session row or its sidebar
//      row (82tn.32.38), so every browser re-reads both.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
					"SELECT sequence, type, json_extract(data, '$.runnerId') AS runnerId, json_extract(data, '$.label') AS label, json_extract(data, '$.reattached') AS reattached, json_extract(data, '$.wakeTask.taskId') AS wakeTask, created_at AS createdAt, json_extract(data, '$.stop.deadlineAt') AS deadlineAt FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as {
				sequence: number;
				type: string;
				runnerId: string | null;
				label: string | null;
				reattached: number | null;
				wakeTask: string | null;
				createdAt: number;
				deadlineAt: number | null;
			}[],
			ends: db
				.prepare(
					"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.reason.tag') AS reason, json_extract(entry_json, '$.reason.forced') AS forced FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
				)
				.all(sessionId) as {
				runId: string;
				reason: string;
				forced: number | null;
			}[],
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
		boot?: Parameters<ProcessHarness["restart"]>[0],
	) => {
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			...options,
		});
		await harness.restart(boot);
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

	it("keeps the session and sidebar rows unstamped across a restart that changes nothing", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession(
			"Claude ledger quiet restart",
		);
		await browser.send(sessionId, "claude-ledger-quiet-restart");
		const rows = () => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return {
					session: db
						.prepare("SELECT version FROM sessions WHERE id = ?")
						.get(sessionId),
					sidebar: db
						.prepare(
							"SELECT version, row FROM session_sidebar WHERE session_id = (SELECT root_id FROM sessions WHERE id = ?)",
						)
						.get(sessionId),
				};
			} finally {
				db.close();
			}
		};
		await fixture.terminate();
		const before = rows();
		const cursor = fixture.marks.length;
		await fixture.restart();
		// The restart reports the surviving runner reattached (CONTRACT.md 2121-2125) and projects
		// that report before the runner's attach mark; nothing a browser reads has changed.
		await fixture.waitForMark(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
			cursor,
		);
		expect(
			read(fixture, sessionId).events.some((event) => event.reattached === 1),
		).toBe(true);
		await fixture.connect(sessionId);
		await fixture.terminate();
		const after = rows();
		expect(after).toEqual(before);
		proofs.push({ case: "quiet restart", sessionId, before, after });
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

	it("ends a wake stopped alone at its dispose, not forced, and launches the Queued Run", async () => {
		const { fixture, browser } = await start({
			claudeReplay: {
				turns: ["background-shell-turn", "pong-thinking-text-turn"],
			},
		});
		const sessionId = await browser.createSession("Claude ledger wake stop");
		// Hold the wake before its result (trace line 153), so it is still in flight.
		const hold = join(fixture.root, "claude-replay-hold");
		writeFileSync(hold, JSON.stringify({ turn: 1, message: 153, id: 1 }));
		await browser.send(sessionId, "Run sleep 8 in the background");
		// test-waits-allow polling: the held replay line reports only through this file.
		await vi.waitFor(() => expect(existsSync(`${hold}.reached`)).toBe(true), {
			timeout: 10_000,
		});
		// A start waits for the wake's turn (8.3), so this send stays Queued.
		const queued = browser.send(sessionId, "ping");
		// test-waits-allow polling: the browser sees no frame when a Queued send is admitted.
		await vi.waitFor(() =>
			expect(
				read(fixture, sessionId).events.filter(
					(event) => event.type === "input.admitted",
				),
			).toHaveLength(2),
		);
		await fixture.requestRpc({
			_tag: "CancelSession",
			sessionId,
			commandId: randomUUID(),
		});
		// The replayed pong trace answers the Queued send.
		expect((await queued).chunks.join("")).toBe("pong");
		const ledger = read(fixture, sessionId);
		const turns = ledger.events.filter((event) =>
			event.type.startsWith("evidence.turn_"),
		);
		expect(turns.map(({ type }) => type)).toEqual([
			"evidence.turn_started",
			"evidence.turn_ended",
		]);
		// The wake's work ends at the dispose's turn_ended, not by the alarm.
		const wakeEnds = ledger.ends.filter(
			(end) => !ledger.runs.some((run) => run.id === end.runId),
		);
		expect(wakeEnds).toEqual([
			expect.objectContaining({ reason: "interrupted", forced: 0 }),
		]);
		// The Queued Run launches after the wake's turn_ended and completes.
		const launched = ledger.facts.find(
			(fact) =>
				fact.kind === "run_dispatched" && fact.runId === ledger.runs[1]?.id,
		);
		expect(launched?.sequence).toBeGreaterThan(turns[1]?.sequence ?? 0);
		expect(
			ledger.ends.find((end) => end.runId === ledger.runs[1]?.id)?.reason,
		).toBe("completed");
		// Before the Stop's deadline: the alarm has nothing left to force (L6, trace W).
		const stop = ledger.events.find(
			(event) => event.type === "interrupt.requested",
		);
		const dispatched = ledger.events.filter(
			(event) => event.type === "run.dispatched",
		);
		expect(dispatched).toHaveLength(2);
		expect(dispatched[1]?.createdAt).toBeLessThan(
			stop?.deadlineAt ?? Number.NEGATIVE_INFINITY,
		);
		proofs.push({
			case: "wake-stopped-alone",
			sessionId,
			turns,
			ends: ledger.ends,
			runs: ledger.runs,
			types: ledger.events.map((event) => event.type),
		});
	});

	it("delivers a send waiting behind a wake once on a new runner when its runner dies", async () => {
		const { fixture, browser } = await start({
			claudeReplay: {
				turns: ["background-shell-turn", "pong-thinking-text-turn"],
				// The replacement runner continues the turn plan where the dead one stopped.
				followWorkspaceDirectives: true,
			},
		});
		const sessionId = await browser.createSession("Claude ledger fence loss");
		const hold = join(fixture.root, "claude-replay-hold");
		writeFileSync(hold, JSON.stringify({ turn: 1, message: 153, id: 1 }));
		await browser.send(sessionId, "Run sleep 8 in the background");
		// test-waits-allow polling: the held replay line reports only through this file.
		await vi.waitFor(() => expect(existsSync(`${hold}.reached`)).toBe(true), {
			timeout: 10_000,
		});
		// A start waits for the wake's turn (8.3); main holds this send until the wake ends.
		const queued = browser.send(sessionId, "ping");
		// test-waits-allow polling: the browser sees no frame when a Queued send is admitted.
		await vi.waitFor(() =>
			expect(
				read(fixture, sessionId).events.filter(
					(event) => event.type === "input.admitted",
				),
			).toHaveLength(2),
		);
		// F320: kill before releasing the hold; a runner released first can end its wake and take the send.
		const [dead] = fixture.runnerPids();
		expect(dead && fixture.signalOwnedRunner(dead, "SIGKILL")).toBe(true);
		rmSync(hold, { force: true });
		// F153: the replacement runner answers the waiting send.
		expect((await queued).chunks.join("")).toBe("pong");
		const ledger = read(fixture, sessionId);
		// F155: each of main's runs ends once in the ledger, as main ended it.
		endsOnce(ledger);
		// F154: the waiting start is handed over once, to the new runner, after the old one's loss.
		const lost = ledger.events.filter(
			(event) => event.type === "evidence.process_lost",
		);
		expect(lost).toHaveLength(1);
		const ping = ledger.runs[1]?.id;
		const handed = ledger.facts.filter(
			(fact) => fact.kind === "run_dispatched" && fact.runId === ping,
		);
		expect(handed).toHaveLength(1);
		expect(handed[0]?.sequence).toBeGreaterThan(lost[0]?.sequence ?? 0);
		expect(handed[0]?.runnerId).toBe(runnerOf(ledger));
		expect(handed[0]?.runnerId).not.toBe(lost[0]?.runnerId);
		proofs.push({
			case: "fence-runner-lost",
			sessionId,
			lost,
			handed,
			ends: ledger.ends,
			runs: ledger.runs,
			types: ledger.events.map(({ type }) => type),
		});
	});

	it("ends a send's Run once on a new runner when its runner dies after the send launched, before its hold", async () => {
		const { fixture, browser } = await start(
			{
				claudeReplay: {
					turns: ["background-shell-turn", "pong-thinking-text-turn"],
					followWorkspaceDirectives: true,
				},
			},
			{
				serviceEnvironment: {
					CONDUIT_TEST_SEND_CONTINUATION_PAUSE: "before-hold",
				},
			},
		);
		const sessionId = await browser.createSession("Claude ledger hold loss");
		const hold = join(fixture.root, "claude-replay-hold");
		writeFileSync(hold, JSON.stringify({ turn: 1, message: 153, id: 1 }));
		await browser.send(sessionId, "Run sleep 8 in the background");
		// test-waits-allow polling: the held replay line reports only through this file.
		await vi.waitFor(() => expect(existsSync(`${hold}.reached`)).toBe(true), {
			timeout: 10_000,
		});
		const queued = browser.send(sessionId, "ping");
		// test-waits-allow polling: the browser sees no frame when a Queued send is admitted.
		await vi.waitFor(() =>
			expect(
				read(fixture, sessionId).events.filter(
					(event) => event.type === "input.admitted",
				),
			).toHaveLength(2),
		);
		// F321: the wake ends on its runner, main launches the send there and pauses before its hold.
		const gate = join(
			fixture.root,
			"conduit-test-send-continuation-before-hold",
		);
		writeFileSync(gate, "hold");
		rmSync(hold, { force: true });
		await fixture.waitForMark(
			(mark) =>
				mark.kind === "send-continuation-paused" &&
				mark["point"] === "before-hold",
		);
		const [dead] = fixture.runnerPids();
		expect(dead && fixture.signalOwnedRunner(dead, "SIGKILL")).toBe(true);
		// test-waits-allow polling: a runner's loss reaches the browser as no frame.
		await vi.waitFor(() =>
			expect(
				read(fixture, sessionId).events.some(
					(event) => event.type === "evidence.process_lost",
				),
			).toBe(true),
		);
		rmSync(gate, { force: true });
		// F322: the send is answered once, by the new runner.
		expect((await queued).chunks.join("")).toBe("pong");
		const ledger = read(fixture, sessionId);
		// The send's Run launched on the old runner before its loss, and main requested it again
		// once after (CONTRACT 674-679).
		const types = ledger.events.map(({ type }) => type);
		const lost = types.indexOf("evidence.process_lost");
		expect(types.indexOf("run.requested")).toBeLessThan(lost);
		expect(
			types.slice(lost).filter((type) => type === "run.requested"),
		).toHaveLength(1);
		// F321, F323: every Run main started ends once in the ledger, the relaunched send's included.
		endsOnce(ledger);
		proofs.push({
			case: "hold-runner-lost",
			sessionId,
			ends: ledger.ends,
			runs: ledger.runs,
			types,
		});
	});

	it("ends a wake whose stream fails at the translator's endTurn", async () => {
		const { fixture, browser } = await start({
			claudeReplay: {
				turns: ["background-shell-turn", "pong-thinking-text-turn"],
			},
		});
		const sessionId = await browser.createSession("Claude ledger wake failure");
		// The wake's stream throws in place of its result (trace line 153).
		const hold = join(fixture.root, "claude-replay-hold");
		writeFileSync(
			hold,
			JSON.stringify({ turn: 1, message: 153, id: 1, fail: true }),
		);
		await browser.send(sessionId, "Run sleep 8 in the background");
		const ended = () =>
			read(fixture, sessionId).events.filter(
				(event) => event.type === "evidence.turn_ended",
			);
		// test-waits-allow polling: a wake has no send, so the browser awaits no frame for it.
		await vi.waitFor(() => expect(ended()).toHaveLength(1), {
			timeout: 10_000,
		});
		const ledger = read(fixture, sessionId);
		const turns = ledger.events.filter((event) =>
			event.type.startsWith("evidence.turn_"),
		);
		expect(turns.map(({ type }) => type)).toEqual([
			"evidence.turn_started",
			"evidence.turn_ended",
		]);
		// The stream threw in place of the result, so no turn completed; the translator's
		// endTurn reports idle, and turn_ended follows it (E13). A run-less wake's turn.error
		// is not stored (see the lane report).
		const wake = ledger.events.filter(
			(event) =>
				event.sequence > (turns[0]?.sequence ?? 0) &&
				event.sequence <= (turns[1]?.sequence ?? 0),
		);
		expect(wake.some((event) => event.type === "turn.completed")).toBe(false);
		// A task snapshot may land between them; it is no part of the wake's ending.
		expect(
			wake
				.filter(({ type }) => type !== "evidence.tasks_snapshot")
				.slice(-2)
				.map(({ type }) => type),
		).toEqual(["session.status", "evidence.turn_ended"]);
		expect(
			ledger.events.some((event) => event.type === "interrupt.requested"),
		).toBe(false);
		const wakeEnds = ledger.ends.filter(
			(end) => !ledger.runs.some((run) => run.id === end.runId),
		);
		expect(wakeEnds).toHaveLength(1);
		expect(wakeEnds[0]?.forced).not.toBe(1);
		endsOnce(ledger);
		proofs.push({
			case: "wake-stream-failed",
			sessionId,
			turns,
			wake: wake.map(({ type }) => type),
			ends: ledger.ends,
			runs: ledger.runs,
		});
	});
	it("reports a draft pre-warm's start once CreateSession stores its session, before its first send", async () => {
		const { fixture, browser } = await start();
		const draftId = randomUUID();
		await browser.preWarmDraft(draftId);
		// test-waits-allow polling: a pre-warm returns before its runner's SDK initializes.
		await vi.waitFor(
			() =>
				expect(
					fixture.marks.filter((mark) => mark.kind === "initialization-ready"),
				).toHaveLength(1),
			{ timeout: 5000 },
		);
		const sessionId = await browser.createSession(
			"Claude ledger draft",
			undefined,
			"claude",
			{ draftId },
		);
		const prompt = "claude-ledger-draft-send";
		const { chunks } = await browser.send(sessionId, prompt);
		expect(chunks.join("")).toBe(responseChunks(prompt).join(""));
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
		// 6.1: main's claim may precede it; none of the runner's own frames may.
		const started = ledger.events.find(
			(event) => event.type === "evidence.process_started",
		);
		const firstFrame = ledger.events.find(
			(event) =>
				event.type === "message.created" || event.type === "run.started",
		);
		expect(started?.sequence).toBeLessThan(
			firstFrame?.sequence ?? Number.POSITIVE_INFINITY,
		);
		proofs.push({
			case: "draft-prewarm",
			sessionId,
			evidence: processEvidence(ledger),
			ends: ledger.ends,
			runs: ledger.runs,
		});
	});
	it("ends a wake whose result is an SDK error with that error, not completed", async () => {
		// The wake's result (trace line 153) fails as the SDK wraps an upstream error.
		const traces = join(
			import.meta.dirname,
			"../../fixtures/claude-sdk-traces",
		);
		const variant = readFileSync(
			join(traces, "background-shell-turn.jsonl"),
			"utf8",
		)
			.trimEnd()
			.split("\n")
			.map((line, index) =>
				index === 152
					? JSON.stringify({
							...JSON.parse(line),
							is_error: true,
							result: "API Error: 529 overloaded",
						})
					: line,
			);
		const replay = {
			turns: ["background-shell-turn"] as const,
			tracesDir: "",
		};
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			claudeReplay: replay,
		});
		const fixture = harness;
		replay.tracesDir = join(fixture.root, "traces");
		mkdirSync(replay.tracesDir);
		writeFileSync(
			join(replay.tracesDir, "background-shell-turn.jsonl"),
			variant.join("\n"),
		);
		await fixture.restart();
		const browser = await fixture.connect();
		await browser.setAutoSettle(null);
		const sessionId = await browser.createSession("Claude ledger wake error");
		await browser.send(sessionId, "Run sleep 8 in the background");
		// test-waits-allow polling: a wake has no send, so the browser awaits no frame for it.
		await vi.waitFor(
			() =>
				expect(
					read(fixture, sessionId).events.filter(
						(event) => event.type === "evidence.turn_ended",
					),
				).toHaveLength(1),
			{ timeout: 10_000 },
		);
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		const wakeEnds = ledger.ends.filter(
			(end) => !ledger.runs.some((run) => run.id === end.runId),
		);
		expect(wakeEnds).toEqual([
			expect.objectContaining({ reason: "provider_error", forced: null }),
		]);
		proofs.push({
			case: "wake-error-result",
			sessionId,
			ends: ledger.ends,
			runs: ledger.runs,
			types: ledger.events.map((event) => event.type),
		});
	});
	it("ends a wake that took a merged steer and is then stopped at its first clear, not forced", async () => {
		// A test-made variant of background-shell-turn: command frames for the first input,
		// the steer queued and started inside the wake (after line 89), and a recorded
		// interrupt that names the steer, from stop-with-steer-pending's lines 28-30.
		const traces = join(
			import.meta.dirname,
			"../../fixtures/claude-sdk-traces",
		);
		const shell = readFileSync(
			join(traces, "background-shell-turn.jsonl"),
			"utf8",
		)
			.split("\n")
			.filter((line) => line.trim() !== "");
		const stopped = readFileSync(
			join(traces, "stop-with-steer-pending.jsonl"),
			"utf8",
		)
			.split("\n")
			.slice(27, 30);
		const nativeSession = "cbaaf0cc-998e-4144-afef-e7bf0042615b";
		const [first, steer] = [randomUUID(), randomUUID()];
		const command = (commandId: string, state: string) =>
			JSON.stringify({
				type: "command_lifecycle",
				command_uuid: commandId,
				state,
				uuid: randomUUID(),
				session_id: nativeSession,
			});
		const result = JSON.stringify({
			...JSON.parse(shell[83] ?? "{}"),
			user_message_uuid: first,
			user_message_uuids: [first],
		});
		const interrupt = stopped.map((line) =>
			line
				.replaceAll("f186b7cd-6f1a-468c-9871-349c497272d0", nativeSession)
				.replaceAll("a565acb8-fa93-4d55-bafb-9b9417677be7", steer)
				.replace(
					"[Request interrupted by user for tool use]",
					"[Request interrupted by user]",
				),
		);
		const variant = [
			...shell.slice(0, 6),
			command(first, "queued"),
			command(first, "started"),
			...shell.slice(6, 83),
			result,
			command(first, "completed"),
			...shell.slice(84, 89),
			command(steer, "queued"),
			command(steer, "started"),
			...shell.slice(89, 141),
			...interrupt,
		];
		const replay = { turns: ["background-shell-turn"] as const, tracesDir: "" };
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			claudeReplay: replay,
		});
		const fixture = harness;
		replay.tracesDir = join(fixture.root, "traces");
		mkdirSync(replay.tracesDir);
		writeFileSync(
			join(replay.tracesDir, "background-shell-turn.jsonl"),
			variant.join("\n"),
		);
		await fixture.restart();
		const browser = await fixture.connect();
		await browser.setAutoSettle(null);
		const sessionId = await browser.createSession(
			"Claude ledger wake steer stop",
		);
		await browser.send(sessionId, "Run sleep 8 in the background");
		const types = () => read(fixture, sessionId).events.map(({ type }) => type);
		// test-waits-allow polling: a wake has no send, so the browser awaits no frame for it.
		await vi.waitFor(() => expect(types()).toContain("evidence.turn_started"), {
			timeout: 10_000,
		});
		// The wake is in flight and the replay waits for the steer at its queued frame.
		const steered = browser.send(
			sessionId,
			"and then stop",
			undefined,
			"steer",
		);
		// The replay then waits at its recorded interrupt for the Stop.
		// test-waits-allow polling: the steer's start reaches only the store.
		await vi.waitFor(
			() =>
				expect(types().filter((type) => type === "run.started")).toHaveLength(
					2,
				),
			{ timeout: 10_000 },
		);
		await fixture.requestRpc({
			_tag: "CancelSession",
			sessionId,
			commandId: randomUUID(),
		});
		await steered;
		// test-waits-allow polling: the wake's end reaches only the store.
		await vi.waitFor(() => expect(types()).toContain("evidence.turn_ended"), {
			timeout: 10_000,
		});
		const ledger = read(fixture, sessionId);
		const turns = ledger.events.filter((event) =>
			event.type.startsWith("evidence.turn_"),
		);
		expect(turns.map(({ type }) => type)).toEqual([
			"evidence.turn_started",
			"evidence.turn_ended",
		]);
		// The steer's Run is active, so the Stop interrupts it as any Run (CONTRACT.md 983-984);
		// 6486's "disposed" is read as that Stop, the wake still ending at its own first clear.
		const stop = ledger.events.find(
			(event) => event.type === "interrupt.requested",
		);
		expect(turns[1]?.sequence).toBeGreaterThan(
			stop?.sequence ?? Number.POSITIVE_INFINITY,
		);
		// The recorded interrupt answered the Stop; the replay did not fail it.
		expect(ledger.events.some((event) => event.type === "turn.error")).toBe(
			false,
		);
		// The wake's work ends at its turn_ended, not forced by the ledger stop deadline's alarm.
		const wakeEnds = ledger.ends.filter(
			(end) => !ledger.runs.some((run) => run.id === end.runId),
		);
		expect(wakeEnds).toHaveLength(1);
		expect(wakeEnds[0]?.forced).not.toBe(1);
		// Each send's Run, the steer's included, ends exactly once.
		expect(ledger.runs).toHaveLength(2);
		for (const run of ledger.runs)
			expect(ledger.ends.filter((end) => end.runId === run.id)).toHaveLength(1);
		proofs.push({
			case: "wake-steer-stopped",
			sessionId,
			turns,
			ends: ledger.ends,
			runs: ledger.runs,
			types: ledger.events.map(({ type }) => type),
		});
	});

	it("folds a Claude permission and main's answer once across a daemon restart, the answer reaching the SDK once", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude ledger answer");
		const prompt = "approval-ledger-answer";
		const pending = browser.send(sessionId, prompt).catch(() => undefined);
		const asked = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		// The interaction outlives the daemon: its rebuilt ledger still reads it Pending.
		await fixture.kill();
		await pending;
		await fixture.restart();
		const after = await fixture.connect(sessionId);
		await after.view(sessionId);
		const recovered = await after.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				message["requestId"] === asked["requestId"],
		);
		await after.answerApproval(recovered, "allow");
		await after.waitForTurnEnd(sessionId);
		// test-waits-allow polling: the reactor completes the outbox row after the runner's reply, with no browser event.
		const answer = await vi.waitFor(
			() => {
				const found = answers(fixture, sessionId);
				expect(found.outbox.map((row) => row.status)).toEqual(["completed"]);
				// 3.10, 3.12: the delivered answer holds the session open no longer.
				expect(found.state).toBe("Quiescent");
				return found;
			},
			{ timeout: 10_000, interval: 50 },
		);
		proofs.push({ case: "answer-across-restart", sessionId, ...answer });
		const [resolved] = answer.events.filter(
			(event) => event.source === "conduit.control-outbox",
		);
		const [row] = answer.outbox;
		expect(resolved?.commandId).toBe(row?.commandId);
		const interactionId = resolved?.id;
		// 3.10: the interaction is its runner's label's, requested once and answered once by main's
		// answer, whose one transmission's outcome the ledger folds.
		expect(answer.requested).toEqual([
			{ interactionId, label: `${runnerOf(read(fixture, sessionId))}:0` },
		]);
		expect(answer.answers).toEqual([
			{ commandId: row?.commandId, interactionId },
		]);
		expect(answer.outcomes).toEqual([
			{ commandId: row?.commandId, transmission: 1, outcome: "succeeded" },
		]);
		expect(row?.attempts).toBe(1);
		// 3.10, D61: the runner's own resolution confirms the delivery as ledger evidence alone; the
		// UI's events keep main's one resolution.
		expect(answer.events.map(({ type, source }) => [type, source])).toEqual([
			["permission.asked", null],
			["permission.resolved", "conduit.control-outbox"],
			["evidence.interaction_resolved", null],
		]);
		expect(answer.resolved).toEqual([{ interactionId }]);
		// The answer reached the SDK once.
		expect(
			sdkMarks(fixture).filter(
				(mark) => mark["kind"] === "approval" && mark["prompt"] === prompt,
			),
		).toEqual([expect.objectContaining({ behavior: "allow" })]);
		endsOnce(read(fixture, sessionId));
	});
});

const sdkMarks = (harness: ProcessHarness) =>
	readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);

/** A session's prompts and answers: main's events, its outbox rows and the ledger's facts (3.10). */
const answers = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		const facts = (path: string, where: string) =>
			db
				.prepare(
					`SELECT ${path} FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'fact' AND ${where} ORDER BY entry_seq`,
				)
				.all(sessionId);
		return {
			state: (
				db
					.prepare("SELECT state FROM run_ledger_sessions WHERE session_id = ?")
					.get(sessionId) as { state: string } | undefined
			)?.state,
			events: db
				.prepare(
					"SELECT type, json_extract(data, '$.id') AS id, json_extract(metadata, '$.commandId') AS commandId, json_extract(metadata, '$.source') AS source FROM events WHERE session_id = ? AND type IN ('permission.asked', 'permission.resolved', 'evidence.interaction_resolved') ORDER BY sequence",
				)
				.all(sessionId) as {
				type: string;
				id: string;
				commandId: string | null;
				source: string | null;
			}[],
			outbox: db
				.prepare(
					"SELECT command_id AS commandId, status, attempt_count AS attempts FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'resolve_permission' ORDER BY request_sequence",
				)
				.all(sessionId) as {
				commandId: string;
				status: string;
				attempts: number;
			}[],
			requested: facts(
				"json_extract(entry_json, '$.command.observation.interactionId') AS interactionId, json_extract(entry_json, '$.command.observation.label') AS label",
				"json_extract(entry_json, '$.command.observation.kind') = 'interaction_requested'",
			),
			answers: facts(
				"json_extract(entry_json, '$.command.control.commandId') AS commandId, json_extract(entry_json, '$.command.control.interactionId') AS interactionId",
				"json_extract(entry_json, '$.command.control.kind') = 'answer'",
			),
			resolved: facts(
				"json_extract(entry_json, '$.command.observation.interactionId') AS interactionId",
				"json_extract(entry_json, '$.command.observation.kind') = 'interaction_resolved'",
			),
			outcomes: facts(
				"json_extract(entry_json, '$.command.observation.transmission.commandId') AS commandId, json_extract(entry_json, '$.command.observation.transmission.transmission') AS transmission, json_extract(entry_json, '$.command.observation.outcome.tag') AS outcome",
				"json_extract(entry_json, '$.command.observation.kind') = 'effect_outcome' AND json_extract(entry_json, '$.command.observation.transmission.commandId') IN (SELECT command_id FROM provider_command_outbox WHERE effect_type = 'resolve_permission')",
			),
		};
	} finally {
		db.close();
	}
};

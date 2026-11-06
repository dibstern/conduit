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
// 391. a retryable answer failure after the SDK took the answer reads as never received, so at
//      main's cap an answered prompt reopens; or its retry gives the SDK the answer twice (82tn.32.39).
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	evolve,
	initialSessionLedgerState,
	type LedgerEvent,
	viewLedger,
} from "../../../src/lib/provider/run-ledger/run-ledger-decider.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";
import { proveToolRowsOnLedger } from "../../helpers/tool-rows-proof.js";

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

// 82tn.32.35: only an OpenCode probe records what it read; this provider's probes record nothing.
const probeFindings = (fixture: ProcessHarness | undefined) => {
	if (!fixture) return 0;
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return (
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM events WHERE type = 'evidence.probe_result'",
				)
				.get() as { n: number }
		).n;
	} finally {
		db.close();
	}
};

describe("Claude on the Run Ledger", () => {
	let harness: ProcessHarness | undefined;
	const proofs: Record<string, unknown>[] = [];
	afterEach(async () => {
		const findings = probeFindings(harness);
		await harness?.dispose();
		harness = undefined;
		expect(findings).toBe(0);
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

	it("stamps every tool row of a recorded subagent turn, the subagent's too, with its Run's id and the project folder (82tn.45)", async () => {
		const { fixture, browser } = await start({
			claudeReplay: { turns: ["subagent-task-turn"] },
		});
		const sessionId = await browser.createSession("Claude tool rows");
		await browser.send(sessionId, "Ask a subagent to summarise package.json");
		endsOnce(read(fixture, sessionId));
		proveToolRowsOnLedger("claude", fixture);
	});

	// 82tn.45: the subagent's terminal event (its task_notification, line 39 of the trace) ends the
	// subagent, never the parent's Run. How it could fail: the parent's Run ends there, as completed
	// or ended by the run; the parent session reads idle while its own turn still runs.
	it("leaves the parent's Run running past its subagent's terminal event, on a recorded turn (82tn.45)", async () => {
		const { fixture, browser } = await start({
			claudeReplay: {
				turns: ["subagent-task-turn"],
				plan: { holdBefore: { turn: 1, message: 40 } },
			},
		});
		const sessionId = await browser.createSession("Claude subagent end");
		await browser.followSession(sessionId);
		const sent = browser.send(
			sessionId,
			"Ask a subagent to summarise package.json",
		);
		await fixture.claudeReplayer?.held();
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["sessionId"] === sessionId &&
				JSON.stringify(message["parts"]).includes('"outcome":"completed"'),
		);
		const held = read(fixture, sessionId);
		expect(held.ends).toEqual([]);
		expect(held.runs).toEqual([{ id: expect.any(String), status: "running" }]);
		fixture.claudeReplayer?.release();
		await sent;
		const after = read(fixture, sessionId);
		expect(after.ends).toEqual([
			{ runId: held.runs[0]?.id, reason: "completed", forced: null },
		]);
		proofs.push({
			case: "82tn.45 subagent terminal event",
			atSubagentEnd: { ends: held.ends, runs: held.runs },
			after: { ends: after.ends, runs: after.runs },
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
		// A start waits for a wake its ledger has folded (8.3, CONTRACT.md 2832-2833); a send admitted
		// before the wake's turn_started reaches main is dispatched at once, as it should be.
		// test-waits-allow polling: the wake's turn_started reaches the browser as no frame of its own.
		await vi.waitFor(() =>
			expect(
				read(fixture, sessionId).events.some(
					(event) => event.type === "evidence.turn_started",
				),
			).toBe(true),
		);
		// So the second send ends after the wake.
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

	it("sends the runner nothing for an idle Stop, so the next send reuses the open query", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude ledger idle stop");
		const first = "claude-ledger-idle-stop-first";
		expect((await browser.send(sessionId, first)).chunks.join("")).toBe(
			responseChunks(first).join(""),
		);
		const commandId = randomUUID();
		await fixture.requestRpc({ _tag: "CancelSession", sessionId, commandId });
		// test-waits-allow polling: the reactor settles the Stop's control row with no browser frame.
		await vi.waitFor(() => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				expect(
					db
						.prepare(
							"SELECT status FROM provider_command_outbox WHERE command_id = ?",
						)
						.get(commandId),
				).toEqual({ status: "completed" });
			} finally {
				db.close();
			}
		});
		const marks = () =>
			readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		// 5.1: with neither an active Run nor label work, Stop issues nothing (F358, F359).
		expect(
			marks().filter(
				(mark) =>
					mark["kind"] === "runner-control" && mark["type"] === "interrupt",
			),
		).toEqual([]);
		expect(marks().filter((mark) => mark["kind"] === "query-closed")).toEqual(
			[],
		);
		const second = "claude-ledger-idle-stop-second";
		expect((await browser.send(sessionId, second)).chunks.join("")).toBe(
			responseChunks(second).join(""),
		);
		// The open query serves the next send (F359, F360).
		expect(marks().filter((mark) => mark["kind"] === "query")).toHaveLength(1);
		// An empty Stop opens no stop, so nothing ends forced (F362).
		const ledger = read(fixture, sessionId);
		endsOnce(ledger);
		expect(ledger.ends.filter((end) => end.forced === 1)).toEqual([]);
		proofs.push({
			case: "idle-stop",
			sessionId,
			commandId,
			ends: ledger.ends,
			runs: ledger.runs,
			controls: marks().filter((mark) => mark["kind"] === "runner-control"),
		});
	});

	it("leaves a running goal active when Stop interrupts its turn", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude ledger goal stop");
		const stall = "stall-goal";
		const stalled = browser.send(sessionId, stall).catch(() => undefined);
		const goals = () => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return db
					.prepare(
						"SELECT data FROM events WHERE session_id = ? AND type = 'session.goal_changed' ORDER BY sequence",
					)
					.all(sessionId)
					.map((row) => JSON.parse((row as { data: string }).data) as object);
			} finally {
				db.close();
			}
		};
		// The goal fact lands after a full provider round trip, so it gets this file's store-read budget.
		// test-waits-allow polling: the goal fact reaches the store with no browser frame.
		await vi.waitFor(() => expect(goals()).toHaveLength(1), {
			timeout: 10_000,
			interval: 50,
		});
		await fixture.waitForMark(
			(mark) => mark.kind === "enqueue" && mark.prompt === stall,
		);
		await fixture.requestRpc({
			_tag: "CancelSession",
			sessionId,
			commandId: randomUUID(),
		});
		await stalled;
		// test-waits-allow polling: the interrupted Run's end reaches the store with no browser frame.
		const ledger = await vi.waitFor(() => {
			const read_ = read(fixture, sessionId);
			expect(read_.runs.map((run) => run.status)).toEqual(["interrupted"]);
			expect(read_.ends.map((end) => end.runId)).toEqual(
				read_.runs.map((run) => run.id),
			);
			return read_;
		}, 10_000);
		// Stop is not a goal action (CONTRACT.md 2057, 2970): the goal stays as it was.
		expect(goals().at(-1)).toMatchObject({
			goal: expect.objectContaining({ condition: "Finish the stalled goal" }),
		});
		expect(goals().at(-1)).not.toHaveProperty("pausedReason");
		proofs.push({
			case: "goal-stop",
			sessionId,
			goals: goals(),
			ends: ledger.ends,
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

	// 82tn.32.48 (lane audit 1-4): the ledger ends a lost runner's Run at its loss, before main's
	// Gone settlement writes the failed turn's error. The gate holds that settlement open.
	const lostRunnerGap = async () => {
		const started = await start(
			{},
			{
				serviceEnvironment: {
					CONDUIT_TEST_SEND_CONTINUATION_PAUSE: "before-gone",
				},
			},
		);
		const { fixture, browser } = started;
		const sessionId = await browser.createSession("Claude ledger loss gap");
		const failed = browser
			.send(sessionId, "local-work-turn")
			.catch((error: unknown) => error);
		await fixture.waitForMark(
			(mark) =>
				mark.kind === "pre-assistant-held" &&
				mark["prompt"] === "local-work-turn",
		);
		const gate = join(
			fixture.root,
			"conduit-test-send-continuation-before-gone",
		);
		writeFileSync(gate, "hold");
		const [dead] = fixture.runnerPids();
		expect(dead && fixture.signalOwnedRunner(dead, "SIGKILL")).toBe(true);
		await fixture.waitForMark(
			(mark) =>
				mark.kind === "send-continuation-paused" &&
				mark["point"] === "before-gone",
		);
		const shellStatus = () =>
			browser.frames
				.map(({ message }) => message)
				.filter(
					(message) =>
						message["type"] === "session_row" && message["id"] === sessionId,
				)
				.at(-1)?.["status"];
		// test-waits-allow polling: the loss reaches the browser only as a row change.
		await vi.waitFor(() => expect(shellStatus()).toBe("idle"));
		return { ...started, sessionId, gate, failed, shellStatus };
	};
	const sentInputs = (fixture: ProcessHarness, sessionId: string) => {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return db
				.prepare(
					"SELECT json_extract(data, '$.inputId') AS inputId FROM events WHERE session_id = ? AND type = 'input.sent' ORDER BY sequence",
				)
				.all(sessionId)
				.map((row) => (row as { inputId: string }).inputId);
		} finally {
			db.close();
		}
	};
	const promptsSent = (fixture: ProcessHarness, prompt: string) =>
		fixture.marks.filter(
			(mark) => mark.kind === "enqueue" && mark.prompt.endsWith(prompt),
		).length;
	const admitted = (
		fixture: ProcessHarness,
		sessionId: string,
		count: number,
	) =>
		// test-waits-allow polling: the browser sees no frame when an input is admitted.
		vi.waitFor(() =>
			expect(
				read(fixture, sessionId).events.filter(
					(event) => event.type === "input.admitted",
				),
			).toHaveLength(count),
		);

	it("sends a message sent after its runner's loss once, after the failed turn's error (82tn.32.48)", async () => {
		const { fixture, browser, sessionId, gate, failed, shellStatus } =
			await lostRunnerGap();
		// Lane audit 1: the shell shows idle, so the send must go once the failed turn closes.
		const gapSend = browser.send(sessionId, "after-loss");
		await admitted(fixture, sessionId, 2);
		// Lane audit 4: nothing reaches a runner while the failed turn is still open.
		expect(promptsSent(fixture, "after-loss")).toBe(0);
		rmSync(gate, { force: true });
		await failed;
		const answered = await gapSend;
		expect(answered.chunks.join("")).toBe(
			responseChunks("after-loss").join(""),
		);
		// Lane audit 2, 3: sent once, to a new runner.
		const ledger = read(fixture, sessionId);
		expect(promptsSent(fixture, "after-loss")).toBe(1);
		expect(sentInputs(fixture, sessionId)).toHaveLength(2);
		const lost = ledger.events.filter(
			(event) => event.type === "evidence.process_lost",
		);
		expect(lost).toHaveLength(1);
		expect(ledger.runners.at(-1)?.runnerId).not.toBe(lost[0]?.runnerId);
		expect(ledger.runs.map((run) => run.status)).toEqual([
			"error",
			"completed",
		]);
		proofs.push({
			case: "send-after-loss",
			sessionId,
			runs: ledger.runs,
			ends: ledger.ends,
			types: ledger.events.map(({ type }) => type),
		});
	});

	it("sends two messages sent after its runner's loss once each, in order (82tn.32.48)", async () => {
		const { fixture, browser, sessionId, gate, failed } = await lostRunnerGap();
		// Lane audit 7, 8: the second queues behind the first, and the failed turn's late error
		// must not hold it once the first completes.
		const first = browser.send(sessionId, "gap-first");
		await admitted(fixture, sessionId, 2);
		const second = browser.send(sessionId, "gap-second");
		await admitted(fixture, sessionId, 3);
		rmSync(gate, { force: true });
		await failed;
		await Promise.all([first, second]);
		// test-waits-allow polling: two sends share one browser, so turn ends do not name a send.
		await vi.waitFor(
			() =>
				expect(read(fixture, sessionId).runs.map((run) => run.status)).toEqual([
					"error",
					"completed",
					"completed",
				]),
			{ timeout: 20_000 },
		);
		// Each once, the first first.
		const order = fixture.marks.flatMap((mark) =>
			mark.kind === "enqueue"
				? ["gap-first", "gap-second"].filter((prompt) =>
						mark.prompt.endsWith(prompt),
					)
				: [],
		);
		expect(order).toEqual(["gap-first", "gap-second"]);
		expect(sentInputs(fixture, sessionId)).toHaveLength(3);
		const ledger = read(fixture, sessionId);
		proofs.push({
			case: "two-sends-after-loss",
			sessionId,
			runs: ledger.runs,
			ends: ledger.ends,
		});
	});

	it("sends a message sent after its runner's loss once across a daemon restart (82tn.32.48)", async () => {
		const { fixture, browser, sessionId, gate, failed } = await lostRunnerGap();
		// Lane audit 9: the daemon dies in the gap; its next start writes the failed turn's error.
		browser.send(sessionId, "gap-restart").catch(() => undefined);
		await admitted(fixture, sessionId, 2);
		await fixture.kill();
		await failed;
		rmSync(gate, { force: true });
		await fixture.restart();
		await fixture.connect(sessionId);
		// test-waits-allow polling: the send's browser died with the daemon.
		await vi.waitFor(
			() =>
				expect(read(fixture, sessionId).runs.map((run) => run.status)).toEqual([
					"error",
					"completed",
				]),
			{ timeout: 20_000 },
		);
		expect(promptsSent(fixture, "gap-restart")).toBe(1);
		expect(sentInputs(fixture, sessionId)).toHaveLength(2);
		const ledger = read(fixture, sessionId);
		proofs.push({
			case: "send-after-loss-restart",
			sessionId,
			runs: ledger.runs,
			ends: ledger.ends,
		});
	});

	// 82tn.32.50 (lane 3250 audit): a send paused at its hold, before (not yet delivered, CONTRACT
	// 664-666) or just after (possibly reached) the runner has it.
	const pausedSend = async (
		point: "before-hold" | "after-hold",
		prompt: string,
	) => {
		const started = await start(
			{},
			{ serviceEnvironment: { CONDUIT_TEST_SEND_CONTINUATION_PAUSE: point } },
		);
		const { fixture, browser } = started;
		const sessionId = await browser.createSession(`Claude ledger ${point}`);
		const gate = join(fixture.root, `conduit-test-send-continuation-${point}`);
		writeFileSync(gate, "hold");
		const sent = browser
			.send(sessionId, prompt)
			.catch((error: unknown) => error);
		await fixture.waitForMark(
			(mark) =>
				mark.kind === "send-continuation-paused" && mark["point"] === point,
		);
		return { ...started, sessionId, gate, sent };
	};
	const terminals = (fixture: ProcessHarness, sessionId: string) =>
		read(fixture, sessionId)
			.events.map(({ type }) => type)
			.filter((type) =>
				["turn.completed", "turn.interrupted", "turn.error"].includes(type),
			);

	for (const point of ["before-hold", "after-hold"] as const) {
		// Audit 1-3, 5, 10: two Stops end the Run once, interrupted; the prompt reaches the SDK at
		// most once (never before its hold); the queued input waits for Send now and is sent once.
		it(`ends a send stopped twice ${point} interrupted once, and sends the next input once on Send now (82tn.32.50)`, async () => {
			const prompt = `stop-${point}`;
			const { fixture, browser, sessionId, gate, sent } = await pausedSend(
				point,
				prompt,
			);
			browser.send(sessionId, "after-stop").catch(() => undefined);
			await admitted(fixture, sessionId, 2);
			for (const _ of [1, 2])
				await fixture.requestRpc({
					_tag: "CancelSession",
					sessionId,
					commandId: randomUUID(),
				});
			rmSync(gate, { force: true });
			await sent;
			// test-waits-allow polling: the Stop's end reaches the browser only as a row change.
			await vi.waitFor(
				() =>
					expect(terminals(fixture, sessionId)).toEqual(["turn.interrupted"]),
				{ timeout: 15_000 },
			);
			expect(promptsSent(fixture, prompt)).toBeLessThanOrEqual(
				point === "before-hold" ? 0 : 1,
			);
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			const queued = db
				.prepare(
					"SELECT input_id AS inputId FROM pending_inputs WHERE session_id = ? AND state = 'queued'",
				)
				.all(sessionId) as { inputId: string }[];
			// 82tn.83: the stopped send's end names its input, so the browser settles it with no later turn.
			const end = db
				.prepare(
					"SELECT sessions.last_turn_end_input_id AS ended, pending.input_id AS stopped FROM sessions JOIN pending_inputs pending ON pending.session_id = sessions.id WHERE sessions.id = ? AND pending.text = ?",
				)
				.get(sessionId, prompt) as { ended: string | null; stopped: string };
			db.close();
			expect(end.ended).toBe(end.stopped);
			expect(queued).toHaveLength(1);
			await browser.sendNow(sessionId, queued[0]?.inputId ?? "");
			// test-waits-allow polling: Send now's turn reaches this browser only through history.
			await vi.waitFor(
				() =>
					expect(terminals(fixture, sessionId)).toEqual([
						"turn.interrupted",
						"turn.completed",
					]),
				{ timeout: 15_000 },
			);
			expect(promptsSent(fixture, "after-stop")).toBe(1);
			const ledger = read(fixture, sessionId);
			expect(ledger.runs.map((run) => run.status)).toEqual([
				"interrupted",
				"completed",
			]);
			expect(ledger.ends.map((end) => end.runId)).toEqual(
				ledger.runs.map((run) => run.id),
			);
			proofs.push({ case: `stop-${point}`, sessionId, ends: ledger.ends });
		});
	}

	// Audit 6-7: a restart before the hold relaunches the send under its commandId once (CONTRACT
	// 667-672, 689-691); audit 9: one just after the hold may have reached the agent, so it ends once
	// and is never sent again.
	for (const point of ["before-hold", "after-hold"] as const)
		it(`ends a send a restart caught ${point} once, sending it at most once (82tn.32.50)`, async () => {
			const prompt = `restart-${point}`;
			const { fixture, sessionId, gate } = await pausedSend(point, prompt);
			await fixture.terminate();
			rmSync(gate, { force: true });
			await fixture.restart();
			await fixture.connect(sessionId);
			// test-waits-allow polling: the send's browser died with the daemon.
			await vi.waitFor(
				() =>
					expect(
						read(fixture, sessionId).runs.every(
							(run) => run.status !== "pending" && run.status !== "running",
						),
					).toBe(true),
				{ timeout: 20_000 },
			);
			const ledger = read(fixture, sessionId);
			if (point === "before-hold") {
				expect(promptsSent(fixture, prompt)).toBe(1);
				expect(terminals(fixture, sessionId)).toEqual(["turn.completed"]);
				endsOnce(ledger);
			} else {
				expect(promptsSent(fixture, prompt)).toBeLessThanOrEqual(1);
				expect(terminals(fixture, sessionId)).toHaveLength(1);
				expect(ledger.ends.map((end) => end.runId)).toEqual(
					ledger.runs.map((run) => run.id),
				);
			}
			proofs.push({ case: `restart-${point}`, sessionId, ends: ledger.ends });
		});

	// Lane audit 12: a subagent child's open run is its shown foreground while the ledger holds no
	// Run (82tn.68); the inbox reads the same, so a send to the child waits for that run.
	it("holds a send to a running subagent child until its run ends, then sends it once (82tn.32.48)", async () => {
		const { fixture, browser } = await start({
			claudeReplay: {
				turns: ["subagent-task-turn", "pong-thinking-text-turn"],
				plan: { holdBefore: { turn: 1, message: 36 } },
			},
		});
		const root = await browser.createSession("Claude child inbox");
		await browser.followSession(root);
		const turn = browser.send(root, "Ask a subagent to summarise package.json");
		await fixture.claudeReplayer?.held();
		const child = browser.frames.find(
			({ message }) =>
				message["type"] === "session_row" && message["parentID"] === root,
		)?.message["id"];
		if (typeof child !== "string") throw new Error("no child row");
		expect(read(fixture, child).runs).toEqual([
			{ id: expect.any(String), status: "running" },
		]);
		const childSend = browser
			.send(child, "child-follow-up")
			.catch((error: unknown) => error);
		await admitted(fixture, child, 1);
		expect(sentInputs(fixture, child)).toEqual([]);
		fixture.claudeReplayer?.release();
		await turn;
		// test-waits-allow polling: the child's drain has no frame the root's browser awaits.
		await vi.waitFor(() => expect(sentInputs(fixture, child)).toHaveLength(1), {
			timeout: 20_000,
		});
		await childSend;
		expect(sentInputs(fixture, child)).toHaveLength(1);
		proofs.push({
			case: "child-send-held",
			sessionId: child,
			runs: read(fixture, child).runs,
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

	// Lane 32.9 audit 12-16: a rebuilt permission never times out; the timeout's answer folds or
	// reaches the SDK twice, as allow, or never; a later user answer wins over it.
	it("answers a Claude permission timed out after a daemon restart once, rejected, and refuses a later answer", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude ledger timeout");
		const prompt = "approval-ledger-timeout";
		const pending = browser.send(sessionId, prompt).catch(() => undefined);
		const asked = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		await fixture.kill();
		await pending;
		// Only the restarted daemon times permissions out, at its first check (3.10: main's timeout).
		await fixture.restart({
			serviceEnvironment: {
				CONDUIT_PERMISSION_TIMEOUT_MS: "1",
				CONDUIT_PERMISSION_TIMEOUT_CHECK_MS: "100",
			},
		});
		const after = await fixture.connect(sessionId);
		await after.view(sessionId);
		await after.waitForTurnEnd(sessionId);
		// test-waits-allow polling: the reactor completes the outbox row after the runner's reply, with no browser event.
		const answer = await vi.waitFor(
			() => {
				const found = answers(fixture, sessionId);
				expect(found.outbox.map((row) => row.status)).toEqual(["completed"]);
				expect(found.state).toBe("Quiescent");
				return found;
			},
			{ timeout: 10_000, interval: 50 },
		);
		// First answer wins (3.10): the user's answer after the timeout changes nothing.
		await after
			.answerApproval({ requestId: asked["requestId"] }, "allow")
			.catch(() => undefined);
		// Another restart neither re-enqueues nor re-folds the timeout's answer.
		await fixture.kill();
		await fixture.restart();
		await (await fixture.connect(sessionId)).view(sessionId);
		const settled = answers(fixture, sessionId);
		proofs.push({ case: "timeout-across-restart", sessionId, ...settled });
		expect(settled).toEqual(answer);
		const [resolved] = answer.events.filter(
			(event) => event.type === "permission.resolved",
		);
		const commandId = `legacy-answer:${resolved?.eventId}`;
		expect(answer.events.map(({ type, source }) => [type, source])).toEqual([
			["permission.asked", null],
			["permission.resolved", "permission-timeout"],
			["evidence.interaction_resolved", null],
		]);
		expect(answer.outbox).toEqual([
			{ commandId, status: "completed", attempts: 1 },
		]);
		// main's timeout answer carries the rejection alone; CONTRACT.md 1009-1012 names no reason field.
		expect(answer.decisions).toEqual(["reject"]);
		const interactionId = resolved?.id;
		expect(answer.answers).toEqual([{ commandId, interactionId }]);
		expect(answer.outcomes).toEqual([
			{ commandId, transmission: 1, outcome: "succeeded" },
		]);
		expect(answer.resolved).toEqual([{ interactionId }]);
		// The rejection reached the SDK once.
		expect(
			sdkMarks(fixture).filter(
				(mark) => mark["kind"] === "approval" && mark["prompt"] === prompt,
			),
		).toEqual([expect.objectContaining({ behavior: "deny" })]);
		endsOnce(read(fixture, sessionId));
	});

	// Lane 32.9 audit 17-22: a refused answer reads Answered or names no refusal; its answer is lost;
	// the runner replays its refusal on every retry; the refusal lingers; the SDK gets it twice.
	it("keeps a refused Claude answer Pending with its refusal while delivery retries, then delivers it once", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude ledger refusal");
		const prompt = "approval-ledger-refusal";
		const pending = browser.send(sessionId, prompt).catch(() => undefined);
		const asked = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		const runner = fixture.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started") throw new Error("Missing runner");
		const refuse = join(
			dirname(runner.socketPath),
			"conduit-test-refuse-answer",
		);
		writeFileSync(refuse, "refuse");
		// The answer is kept and main retries its delivery, so the request succeeds (3.10, 10B).
		await browser.answerApproval(asked, "allow");
		// test-waits-allow polling: the reactor records the runner's refusal with no browser event.
		const refused = await vi.waitFor(
			() => {
				const found = answers(fixture, sessionId);
				expect(found.outbox.map((row) => row.status)).toEqual([
					"retryable_failed",
				]);
				expect(found.outcomes).toEqual([
					expect.objectContaining({ outcome: "retryable" }),
				]);
				return found;
			},
			{ timeout: 10_000, interval: 50 },
		);
		const [row] = refused.outbox;
		const interactionId = refused.events[0]?.id;
		// 3.10 (10B): Pending, naming the refused transmission and its code, the answer kept.
		expect(interactionsOf(fixture, sessionId)).toEqual([
			{
				tag: "Pending",
				interactionId,
				kind: "permission",
				lastRefusal: {
					attempt: { commandId: row?.commandId, transmission: 1 },
					code: "test_answer_refused",
				},
			},
		]);
		expect(refused.state).toBe("Open");
		// The browser's allow is kept as main's decision "once".
		expect(refused.decisions).toEqual(["once"]);
		expect(refused.answers).toEqual([
			{ commandId: row?.commandId, interactionId },
		]);
		rmSync(refuse);
		await browser.waitForTurnEnd(sessionId);
		await pending;
		// test-waits-allow polling: the reactor completes the outbox row after the runner's reply, with no browser event.
		const answer = await vi.waitFor(
			() => {
				const found = answers(fixture, sessionId);
				expect(found.outbox.map((row) => row.status)).toEqual(["completed"]);
				expect(found.state).toBe("Quiescent");
				return found;
			},
			{ timeout: 10_000, interval: 50 },
		);
		proofs.push({ case: "refused-answer-retried", sessionId, ...answer });
		// The retry's success settles it: the refusal is gone.
		expect(interactionsOf(fixture, sessionId)).toEqual([
			{
				tag: "Answered",
				interactionId,
				kind: "permission",
				delivery: "settled",
			},
		]);
		expect(answer.answers).toEqual([
			{ commandId: row?.commandId, interactionId },
		]);
		expect(answer.outcomes).toEqual([
			{ commandId: row?.commandId, transmission: 1, outcome: "retryable" },
			{ commandId: row?.commandId, transmission: 2, outcome: "succeeded" },
		]);
		expect(answer.resolved).toEqual([{ interactionId }]);
		expect(
			sdkMarks(fixture).filter(
				(mark) => mark["kind"] === "approval" && mark["prompt"] === prompt,
			),
		).toEqual([expect.objectContaining({ behavior: "allow" })]);
		endsOnce(read(fixture, sessionId));
	});

	// Lane 32.9 audit 23 and 35: at the cap the delivery ends, and the prompt reopens since the runner never took it.
	// test-waits-allow timeout-override: main's 1, 2, 4 and 8 s retry backoff runs on the daemon's wall clock.
	it("reopens a Claude answer refused through the cap, and delivers the new answer once", async () => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession("Claude ledger refusal cap");
		const prompt = "approval-ledger-cap";
		const pending = browser.send(sessionId, prompt).catch(() => undefined);
		const asked = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		const runner = fixture.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started") throw new Error("Missing runner");
		const refuse = join(
			dirname(runner.socketPath),
			"conduit-test-refuse-answer",
		);
		writeFileSync(refuse, "refuse");
		const cursor = browser.frames.length;
		await browser.answerApproval(asked, "allow");
		// test-waits-allow polling: main's retries back off 1s, 2s, 4s, 8s with no browser event.
		const capped = await vi.waitFor(
			() => {
				const found = answers(fixture, sessionId);
				expect(found.outbox.map((row) => row.status)).toEqual(["failed"]);
				return found;
			},
			{ timeout: 25_000, interval: 100 },
		);
		proofs.push({ case: "refused-answer-capped", sessionId, ...capped });
		const [row] = capped.outbox;
		const interactionId = capped.events[0]?.id;
		expect(row?.attempts).toBe(5);
		expect(capped.outcomes).toEqual([
			...[1, 2, 3, 4].map((transmission) => ({
				commandId: row?.commandId,
				transmission,
				outcome: "retryable",
			})),
			{ commandId: row?.commandId, transmission: 5, outcome: "permanent" },
		]);
		// 3.10: the runner never took the answer, so main reopens the prompt as a new request
		// and the SDK's callback, still waiting, can be answered again.
		const reopened = await browser.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				message["requestId"] === asked["requestId"],
			cursor,
			10_000,
		);
		expect(interactionsOf(fixture, sessionId)).toEqual([
			{ tag: "Pending", interactionId, kind: "permission" },
		]);
		rmSync(refuse);
		await browser.answerApproval(reopened, "allow");
		await browser.waitForTurnEnd(sessionId);
		await pending;
		// test-waits-allow polling: the reactor completes the outbox row after the runner's reply, with no browser event.
		const answered = await vi.waitFor(
			() => {
				const found = answers(fixture, sessionId);
				expect(found.outbox.map((row) => row.status)).toEqual([
					"failed",
					"completed",
				]);
				expect(found.state).toBe("Quiescent");
				return found;
			},
			{ timeout: 10_000, interval: 50 },
		);
		proofs.push({ case: "refused-answer-reopened", sessionId, ...answered });
		expect(interactionsOf(fixture, sessionId)).toEqual([
			{
				tag: "Answered",
				interactionId,
				kind: "permission",
				delivery: "settled",
			},
		]);
		expect(answered.answers).toEqual(
			answered.outbox.map((sent) => ({
				commandId: sent.commandId,
				interactionId,
			})),
		);
		expect(
			sdkMarks(fixture).filter(
				(mark) => mark["kind"] === "approval" && mark["prompt"] === prompt,
			),
		).toEqual([expect.objectContaining({ behavior: "allow" })]);
		endsOnce(read(fixture, sessionId));
	}, 60_000);

	// 82tn.32.39 (lane bugs3 audit 1-6): a retryable failure reported after the SDK took the answer
	// (a test hook; no product path raises one) retries, or at the cap reopens an answered prompt.
	const refusedAfterTake = async (title: string, prompt: string) => {
		const { fixture, browser } = await start();
		const sessionId = await browser.createSession(title);
		const pending = browser.send(sessionId, prompt).catch(() => undefined);
		const asked = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		const runner = fixture.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started") throw new Error("Missing runner");
		const refuse = join(
			dirname(runner.socketPath),
			"conduit-test-refuse-answer-after-take",
		);
		writeFileSync(refuse, "refuse");
		const cursor = browser.frames.length;
		await browser.answerApproval(asked, "allow");
		// The SDK took the answer, so the turn runs to its end.
		await browser.waitForTurnEnd(sessionId);
		await pending;
		const reopened = () =>
			browser
				.waitFor(
					(message) =>
						message["type"] === "permission_pending" &&
						message["requestId"] === asked["requestId"],
					cursor,
					// test-waits-allow timeout-override: proves an absence after main's last retry read.
					3_000,
				)
				.then(
					() => true,
					() => false,
				);
		return { fixture, sessionId, prompt, refuse, reopened };
	};
	const takenOnce = (fixture: ProcessHarness, prompt: string) =>
		expect(
			sdkMarks(fixture).filter(
				(mark) => mark["kind"] === "approval" && mark["prompt"] === prompt,
			),
		).toEqual([expect.objectContaining({ behavior: "allow" })]);
	const evidence = (name: string, proof: Record<string, unknown>) => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/82tn-32-39-${name}.json`,
			JSON.stringify({ ticket: "conduit-test-82tn.32.39", ...proof }, null, 2),
		);
	};

	it("settles a Claude answer whose one retryable failure came after the SDK took it, with no second take (82tn.32.39)", async () => {
		const { fixture, sessionId, prompt, refuse, reopened } =
			await refusedAfterTake(
				"Claude answer refused after take",
				"approval-after-take",
			);
		// test-waits-allow polling: the reactor records the runner's refusal with no browser event.
		await vi.waitFor(
			() =>
				expect(answers(fixture, sessionId).outcomes).toEqual([
					expect.objectContaining({ transmission: 1, outcome: "retryable" }),
				]),
			{ timeout: 10_000, interval: 50 },
		);
		rmSync(refuse);
		// test-waits-allow polling: main's retry backs off 1s with no browser event.
		const answer = await vi.waitFor(
			() => {
				const found = answers(fixture, sessionId);
				expect(found.outbox.map((row) => row.status)).toEqual(["completed"]);
				expect(found.state).toBe("Quiescent");
				return found;
			},
			{ timeout: 10_000, interval: 50 },
		);
		const interactions = interactionsOf(fixture, sessionId);
		const again = await reopened();
		evidence("one-retry", {
			sessionId,
			...answer,
			interactions,
			reopened: again,
		});
		expect(again).toBe(false);
		expect(answer.outcomes).toEqual([
			expect.objectContaining({ transmission: 1, outcome: "retryable" }),
			expect.objectContaining({ transmission: 2, outcome: "succeeded" }),
		]);
		expect(interactions).toEqual([
			expect.objectContaining({ tag: "Answered", delivery: "settled" }),
		]);
		takenOnce(fixture, prompt);
		endsOnce(read(fixture, sessionId));
	});

	// test-waits-allow timeout-override: main's 1, 2, 4 and 8 s retry backoff runs on the daemon's wall clock.
	it("never reopens a Claude prompt whose answer the SDK took, though every delivery reports a retryable failure (82tn.32.39)", async () => {
		const { fixture, sessionId, prompt, reopened } = await refusedAfterTake(
			"Claude answer refused after take cap",
			"approval-after-take-cap",
		);
		// test-waits-allow polling: main's retries back off 1s, 2s, 4s, 8s with no browser event.
		const capped = await vi.waitFor(
			() => {
				const found = answers(fixture, sessionId);
				expect(found.outbox.map((row) => row.status)).toEqual(["failed"]);
				return found;
			},
			{ timeout: 25_000, interval: 100 },
		);
		const again = await reopened();
		const interactions = interactionsOf(fixture, sessionId);
		evidence("cap", { sessionId, ...capped, interactions, reopened: again });
		expect(again).toBe(false);
		expect(interactions).not.toEqual([
			expect.objectContaining({ tag: "Pending" }),
		]);
		takenOnce(fixture, prompt);
		endsOnce(read(fixture, sessionId));
	}, 60_000);
});

/** The session's interactions as the ledger's view reads them, rebuilt from its entries (3.10). */
const interactionsOf = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		const entries = db
			.prepare(
				"SELECT entry_json AS entry FROM run_ledger_entries WHERE session_id = ? ORDER BY entry_seq",
			)
			.all(sessionId) as { entry: string }[];
		return viewLedger(
			entries.reduce(
				(state, { entry }) => evolve(state, JSON.parse(entry) as LedgerEvent),
				initialSessionLedgerState(sessionId, "claude"),
			),
		).interactions;
	} finally {
		db.close();
	}
};

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
					"SELECT type, event_id AS eventId, json_extract(data, '$.id') AS id, json_extract(metadata, '$.commandId') AS commandId, json_extract(metadata, '$.source') AS source FROM events WHERE session_id = ? AND type IN ('permission.asked', 'permission.resolved', 'evidence.interaction_resolved') ORDER BY sequence",
				)
				.all(sessionId) as {
				type: string;
				eventId: string;
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
			decisions: (
				db
					.prepare(
						"SELECT json_extract(payload_json, '$.decision') AS decision FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'resolve_permission' ORDER BY request_sequence",
					)
					.all(sessionId) as { decision: string }[]
			).map((row) => row.decision),
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

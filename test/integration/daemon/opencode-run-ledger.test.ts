// OpenCode on the Run Ledger end to end (82tn.32.11; CONTRACT.md 9 "OpenCode adapter", 2.1 row
// 215), over the isolated process harness and its managed fake OpenCode. How it could fail:
// 1. a replaced process never retires its id, so the mid-Run Run stays open in the ledger, or it
//    ends by anything but process loss, or twice;
// 2. the next send runs under the old id, or under no id, so it has no authority;
// 3. the ledger's id and the control path's promptProcessId differ for the same process;
// 4. a conduit stop writes no loss, or one per settlement instead of one;
// 5. a daemon restart that reuses the process reports a new id, or no reattach, or ends the Run;
// 6. a session on a named instance ("managed-test") reads as Claude's, so a crash unlaunches the
//    held Run instead of ending it as lost.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	AccountIdSchema,
	MANAGED_OPENCODE_ACCOUNT_ID,
} from "../../../src/lib/contracts/account.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// The default managed instance: its sessions' provider names the OpenCode driver.
const instanceId = MANAGED_OPENCODE_ACCOUNT_ID;

describe("OpenCode on the Run Ledger", () => {
	let harness: ProcessHarness | undefined;
	const proofs: Record<string, unknown>[] = [];
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn-32-11-opencode-ledger.json",
			JSON.stringify({ ticket: "conduit-test-82tn.32.11", proofs }, null, 2),
		);
	});

	const start = async (id = instanceId) => {
		harness = await ProcessHarness.start({
			managedOpenCode: true,
			managedOpenCodeId: id,
			autoStartOpenCode: true,
			managedOpenCodeStopGraceMs: 100,
		});
		return harness;
	};
	const spawned = (fixture: ProcessHarness) => {
		const file = join(fixture.configDir, "fake-opencode-pids.jsonl");
		return existsSync(file)
			? readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { pid: number })
			: [];
	};
	const read = (fixture: ProcessHarness, sessionId: string) => {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return {
				evidence: db
					.prepare(
						"SELECT type, json_extract(data, '$.runnerId') AS runnerId, json_extract(data, '$.label') AS label, json_extract(data, '$.reattached') AS reattached FROM events WHERE session_id = ? AND type LIKE 'evidence.process_%' ORDER BY sequence",
					)
					.all(sessionId) as {
					type: string;
					runnerId: string;
					label: string | null;
					reattached: number | null;
				}[],
				ends: db
					.prepare(
						"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.reason.tag') AS reason FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
					)
					.all(sessionId) as { runId: string; reason: string }[],
				// Control rows carry the control path's promptProcessId; send_turn rows carry none.
				controls: db
					.prepare(
						"SELECT effect_type AS effect, provider_process_id AS processId, status FROM provider_command_outbox WHERE session_id = ? AND effect_type <> 'send_turn' ORDER BY request_sequence",
					)
					.all(sessionId) as {
					effect: string;
					processId: string | null;
					status: string;
				}[],
				runs: db
					.prepare(
						"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
					)
					.all(sessionId) as { id: string; status: string }[],
			};
		} finally {
			db.close();
		}
	};
	type Ledger = ReturnType<typeof read>;
	/** Submits a turn the fake holds busy, and confirms its user message so main runs it. */
	const hold = async (
		fixture: ProcessHarness,
		browser: Awaited<ReturnType<ProcessHarness["connect"]>>,
		sessionId: string,
		id = instanceId,
	) => {
		const held = join(fixture.configDir, "fake-opencode-hold-turn");
		const prompts = fixture
			.opencodeRequestBodies()
			.filter(({ path }) => path === `/session/${sessionId}/prompt_async`);
		writeFileSync(held, "hold");
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: "held",
			}),
		);
		let messageId: string | undefined;
		await vi.waitFor(
			() => {
				messageId = (
					JSON.parse(
						fixture
							.opencodeRequestBodies()
							.filter(
								({ path }) => path === `/session/${sessionId}/prompt_async`,
							)
							.at(prompts.length)?.body ?? "{}",
					) as { messageID?: string }
				).messageID;
				expect(messageId).toBeTruthy();
			},
			{ timeout: 15_000 },
		);
		unlinkSync(held);
		await fixture.emitOpenCodeEvent(
			{
				directory: realpathSync(fixture.projectDir),
				payload: {
					id: randomUUID(),
					type: "message.updated",
					properties: {
						info: {
							id: messageId,
							sessionID: sessionId,
							role: "user",
							time: { created: Date.now() },
						},
					},
				},
			},
			id,
		);
		await vi.waitFor(
			() =>
				expect(read(fixture, sessionId).runs.at(-1)?.status).toBe("running"),
			{ timeout: 15_000 },
		);
		return read(fixture, sessionId);
	};
	/** Waits for `opens` streams from the fake process at `index`, so its events reach the daemon. */
	const streaming = (fixture: ProcessHarness, index: number, opens = 1) =>
		vi.waitFor(
			() => {
				const pid = spawned(fixture)[index]?.pid;
				expect(
					fixture
						.opencodeStreamConnections()
						.filter((stream) => stream.pid === pid && stream.action === "open"),
				).toHaveLength(opens);
			},
			{ timeout: 30_000, interval: 100 },
		);
	const idle = (fixture: ProcessHarness, sessionId: string, id = instanceId) =>
		fixture.setOpenCodeStatus(
			fixture.projectDir,
			sessionId,
			{ type: "idle" },
			id,
		);
	const started = (ledger: Ledger) =>
		ledger.evidence.filter(({ type }) => type === "evidence.process_started");
	const lost = (ledger: Ledger) =>
		ledger.evidence.filter(({ type }) => type === "evidence.process_lost");

	// A named instance's sessions carry its id, not the driver kind, as their provider.
	it.each([
		instanceId,
		AccountIdSchema.make("managed-test"),
	])("on %s, a restart after a crash mid-Run ends that Run as lost, once, and the next send runs under the new id", async (id) => {
		const fixture = await start(id);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Crash mid-Run",
			id,
			"opencode",
		);
		const before = await hold(fixture, browser, sessionId, id);
		const [first] = started(before);
		const heldRun = before.runs[0]?.id;
		expect(first).toMatchObject({
			label: `${first?.runnerId}:0`,
			reattached: 0,
		});

		const [victim] = spawned(fixture);
		if (!victim) throw new Error("No fake OpenCode");
		process.kill(victim.pid, "SIGKILL");
		// The supervisor respawns it.
		await streaming(fixture, 1);
		// The replacement's first event for the session reports its start, retiring the old id.
		await idle(fixture, sessionId, id);
		await vi.waitFor(
			() => expect(started(read(fixture, sessionId))).toHaveLength(2),
			{ timeout: 15_000 },
		);
		await browser.send(sessionId, "after the restart");

		const after = read(fixture, sessionId);
		const [, second] = started(after);
		const nextRun = after.runs[1]?.id;
		proofs.push({ scenario: `crash-restart:${id}`, before, after });
		expect(second?.runnerId).not.toBe(first?.runnerId);
		expect(second).toMatchObject({
			label: `${second?.runnerId}:0`,
			reattached: 0,
		});
		// No conduit stop: the old id retires at the new id's start (L1), with no loss event
		// (CONTRACT.md 2.1 row 215, D59).
		expect(lost(after)).toEqual([]);
		expect(after.ends).toEqual([
			{ runId: heldRun, reason: "process_lost" },
			{ runId: nextRun, reason: "completed" },
		]);
	});

	it("a conduit Stop of the instance mid-Run writes its loss once, and the next send runs under a new id", async () => {
		const fixture = await start();
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Stop instance mid-Run",
			instanceId,
			"opencode",
		);
		const before = await hold(fixture, browser, sessionId);
		const [first] = started(before);
		const heldRun = before.runs[0]?.id;

		await browser.stopInstance(instanceId);
		await browser.startInstance(instanceId);
		await streaming(fixture, 1);
		await browser.send(sessionId, "after the stop");

		const after = read(fixture, sessionId);
		const [, second] = started(after);
		const nextRun = after.runs.at(-1)?.id;
		proofs.push({ scenario: "instance-stop-start", before, after });
		expect(lost(after)).toEqual([
			{
				type: "evidence.process_lost",
				runnerId: first?.runnerId,
				label: null,
				reattached: null,
			},
		]);
		expect(second?.runnerId).not.toBe(first?.runnerId);
		expect(after.ends).toEqual([
			{ runId: heldRun, reason: "process_lost" },
			{ runId: nextRun, reason: "completed" },
		]);
	});

	it("a send, a refused steer and a Stop go through the ledger under the instance's id", async () => {
		const fixture = await start();
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Send, steer and Stop",
			instanceId,
			"opencode",
		);
		await browser.send(sessionId, "plain send");
		const before = await hold(fixture, browser, sessionId);
		const [sentRun, heldRun] = before.runs.map(({ id }) => id);
		const [first] = started(before);
		// OpenCode's composer never offers a steer (CONTRACT.md 4431-4432): the inbox refuses it and
		// admits nothing, so the ledger never sees it.
		const steerId = randomUUID();
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId: steerId,
					delivery: "steer",
					text: "steered",
				}),
			),
		).toEqual({ ok: false, reason: "no_steering" });
		const commandId = randomUUID();
		const stopping = Effect.runPromise(
			browser.rpc.CancelSession({ sessionId, commandId }),
		);
		await vi.waitFor(
			() =>
				expect(
					fixture
						.opencodeRequests()
						.some(
							({ method, url }) =>
								method === "POST" &&
								url.split("?")[0] === `/session/${sessionId}/abort`,
						),
				).toBe(true),
			{ timeout: 15_000 },
		);
		// OpenCode settles an aborted turn idle.
		await idle(fixture, sessionId);
		expect(await stopping).toMatchObject({ ok: true });
		await vi.waitFor(
			() => expect(read(fixture, sessionId).ends).toHaveLength(2),
			{ timeout: 15_000 },
		);

		const after = read(fixture, sessionId);
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		const facts = (
			db
				.prepare(
					"SELECT json_extract(entry_json, '$.command') AS command FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'fact' ORDER BY entry_seq",
				)
				.all(sessionId) as { command: string }[]
		).map(({ command }) => JSON.parse(command) as Record<string, unknown>);
		db.close();
		proofs.push({ scenario: "send-steer-stop", before, after, facts });
		expect(started(after)).toEqual([first]);
		expect(
			facts
				.filter(({ verb }) => verb === "admit")
				.map(({ inputId }) => inputId),
		).not.toContain(steerId);
		// The Stop is the ledger's control fact, and main's interrupt is addressed to the process
		// the ledger's label names (the control path's promptProcessId).
		expect(facts).toContainEqual(
			expect.objectContaining({
				verb: "control",
				control: expect.objectContaining({ kind: "stop", commandId }),
			}),
		);
		expect(after.controls).toContainEqual({
			effect: "interrupt_turn",
			processId: first?.runnerId,
			status: "completed",
		});
		// Each Run ends once, by main's terminal; the fake's abort settles idle, not aborted.
		expect(after.ends).toEqual([
			{ runId: sentRun, reason: "completed" },
			{ runId: heldRun, reason: "completed" },
		]);
	});

	it("a daemon restart that reuses the instance mid-Run reports a reattach with the same id and ends no Run", async () => {
		const fixture = await start();
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Daemon restart mid-Run",
			instanceId,
			"opencode",
		);
		const before = await hold(fixture, browser, sessionId);
		const [first] = started(before);
		const heldRun = before.runs[0]?.id;

		await fixture.terminate();
		await fixture.restart();
		expect(spawned(fixture)).toHaveLength(1);
		// The restarted daemon reopens the reused process's stream.
		await streaming(fixture, 0, 2);
		await idle(fixture, sessionId);
		await vi.waitFor(
			() =>
				expect(read(fixture, sessionId).runs).toEqual([
					{ id: heldRun, status: "completed" },
				]),
			{ timeout: 15_000 },
		);

		const after = read(fixture, sessionId);
		proofs.push({ scenario: "daemon-restart-reuse", before, after });
		expect(started(after)).toEqual([first, { ...first, reattached: 1 }]);
		expect(lost(after)).toEqual([]);
		expect(after.ends).toEqual([{ runId: heldRun, reason: "completed" }]);
	});
});

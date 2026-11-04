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
// 7. a lost prompt (its send comes back unknown, then it runs late) is read absent and re-sent, or
//    its Run ends twice, or probing never ends because no probe records what it read, or its echo
//    is never read as received, so it ends as a failure though it ran (82tn.32.35).
// 8. a process that dies while the daemon is down leaves its held Run open after the daemon starts,
//    ends it as completed though the work died, or ends it again when the next process starts.
// 9. a session OpenCode made itself on a named instance, with no model pick when the ledger first
//    reads it, is stored as Claude's, so its send is no direct start and a crash ends nothing
//    (82tn.32.41).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, Result } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	AccountIdSchema,
	MANAGED_OPENCODE_ACCOUNT_ID,
} from "../../../src/lib/contracts/account.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { resolveRealOpenCode } from "../../helpers/real-opencode.js";
import { proveToolRowsOnLedger } from "../../helpers/tool-rows-proof.js";

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

	const start = async (id = instanceId, probeMs?: number) => {
		harness = ProcessHarness.create({
			managedOpenCode: true,
			managedOpenCodeId: id,
			autoStartOpenCode: true,
			managedOpenCodeStopGraceMs: 100,
		});
		await harness.restart(
			probeMs === undefined
				? {}
				: {
						serviceEnvironment: {
							CONDUIT_TEST_RUN_LEDGER_PROBE_MS: String(probeMs),
						},
					},
		);
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
	/** What each probe read, its target taken from the probe row its token names (3.4). */
	const probing = (fixture: ProcessHarness, sessionId: string) => {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return {
				findings: db
					.prepare(
						"SELECT json_extract(o.payload_json, '$.effect.target.tag') AS target, json_extract(e.data, '$.finding.tag') AS finding, e.created_at AS at FROM events e JOIN provider_command_outbox o ON json_extract(o.payload_json, '$.token') = json_extract(e.data, '$.token') WHERE e.session_id = ? AND e.type = 'evidence.probe_result' ORDER BY e.sequence",
					)
					.all(sessionId) as { target: string; finding: string; at: number }[],
				probes: db
					.prepare(
						"SELECT json_extract(payload_json, '$.effect.target.tag') AS target, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'probe' ORDER BY request_sequence",
					)
					.all(sessionId) as { target: string; status: string }[],
				unknown: (
					db
						.prepare(
							"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'evidence.delivery_indeterminate'",
						)
						.get(sessionId) as { n: number }
				).n,
				alarmAt: (
					db
						.prepare(
							"SELECT alarm_at FROM run_ledger_sessions WHERE session_id = ?",
						)
						.get(sessionId) as { alarm_at: number | null } | undefined
				)?.alarm_at,
			};
		} finally {
			db.close();
		}
	};
	/** The daemon's ledger lives in another process's store, with no event to await. */
	const until = (check: () => void, timeout = 8_000) =>
		// test-waits-allow polling: the ledger's writes land in the daemon's store, another process.
		vi.waitFor(check, { timeout, interval: 100 });
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

	it("on a named instance, a session OpenCode made itself, with no model pick, keeps OpenCode's rules: a crash mid-Run ends its Run as lost (82tn.32.41)", async () => {
		const id = AccountIdSchema.make("managed-test");
		const fixture = await start(id);
		const browser = await fixture.connect();
		const sessionId = `ses_native_${randomUUID().replaceAll("-", "")}`;
		// A conduit session starts the instance and its stream.
		await browser.createSession("Warm", id, "opencode");
		await streaming(fixture, 0);
		// A session conduit never created, as OpenCode's own TUI makes one: the fake knows it, and
		// its first event seeds it in conduit with no model pick.
		const [store] = readdirSync(fixture.configDir).filter((name) =>
			name.endsWith("-sessions.json"),
		);
		if (!store) throw new Error("No fake OpenCode session store");
		const storePath = join(fixture.configDir, store);
		writeFileSync(
			storePath,
			JSON.stringify([
				...(JSON.parse(readFileSync(storePath, "utf8")) as unknown[]),
				{
					id: sessionId,
					slug: "native-session",
					version: "1.18.34",
					projectID: "global",
					directory: realpathSync(fixture.projectDir),
					title: "Native session",
					time: { created: Date.now(), updated: Date.now() },
				},
			]),
		);
		await fixture.setOpenCodeStatus(
			fixture.projectDir,
			sessionId,
			{ type: "busy" },
			id,
		);
		await idle(fixture, sessionId, id);
		await until(() =>
			expect(started(read(fixture, sessionId))).toHaveLength(1),
		);
		const driver = () => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return db
					.prepare(
						"SELECT s.model_provider AS pick, l.provider AS ledger FROM sessions s LEFT JOIN run_ledger_sessions l ON l.session_id = s.id WHERE s.id = ?",
					)
					.get(sessionId) as { pick: string | null; ledger: string | null };
			} finally {
				db.close();
			}
		};
		const created = driver();
		expect(created.pick).toBeNull();
		// A send needs a pick; the user makes one after the ledger first read the session.
		await Effect.runPromise(
			browser.rpc.SwitchModel({
				sessionId,
				originId: browser.originId,
				providerId: "fake",
				modelId: "fake-model",
			}),
		);

		const before = await hold(fixture, browser, sessionId, id);
		const heldRun = before.runs[0]?.id;
		const [victim] = spawned(fixture);
		if (!victim) throw new Error("No fake OpenCode");
		process.kill(victim.pid, "SIGKILL");
		await streaming(fixture, 1);
		await idle(fixture, sessionId, id);
		await until(
			() => expect(started(read(fixture, sessionId))).toHaveLength(2),
			15_000,
		);
		await until(
			() => expect(read(fixture, sessionId).ends).toHaveLength(1),
			15_000,
		);

		const after = read(fixture, sessionId);
		writeFileSync(
			"test-results/82tn-32-41-native-session-driver.json",
			JSON.stringify(
				{
					ticket: "conduit-test-82tn.32.41",
					scenario: "native-session-on-named-instance-crash",
					instance: id,
					created,
					stored: driver(),
					before,
					after,
				},
				null,
				2,
			),
		);
		// Stored when the session was made, before any pick, and kept.
		expect(created.ledger).toBe("opencode");
		expect(driver()).toEqual({ pick: "fake", ledger: "opencode" });
		expect(after.ends).toEqual([{ runId: heldRun, reason: "process_lost" }]);
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

	it("stamps every tool row of a recorded OpenCode turn with its Run's id and the project folder (82tn.45)", async () => {
		const fixture = await start();
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Tool rows",
			instanceId,
			"opencode",
		);
		await browser.followSessions();
		const held = await hold(fixture, browser, sessionId);
		// The recorded session's assistant turn, a bash tool call in it, replayed into the held Run.
		const recorded = "ses_ef595184dffetwQFDMZsHDkJzm";
		const payloads = readFileSync(
			"test/fixtures/opencode-wire/global-stream-1.18.34.jsonl",
			"utf8",
		)
			.split("\n")
			.filter((line) => line.includes(recorded))
			.map(
				(line) =>
					(
						JSON.parse(line.replaceAll(recorded, sessionId)) as {
							payload: {
								type: string;
								properties?: {
									info?: { id: string; role: string };
									part?: { messageID: string };
									messageID?: string;
								};
							};
						}
					).payload,
			);
		const users = new Set(
			payloads.flatMap(({ properties }) =>
				properties?.info?.role === "user" ? [properties.info.id] : [],
			),
		);
		for (const payload of payloads.filter(
			({ type, properties }) =>
				(type === "message.updated" &&
					properties?.info?.role === "assistant") ||
				((type === "message.part.updated" || type === "message.part.delta") &&
					!users.has(
						properties?.part?.messageID ?? properties?.messageID ?? "",
					)),
		))
			await fixture.emitOpenCodeEvent(
				{ directory: realpathSync(fixture.projectDir), payload },
				instanceId,
			);
		const cursor = browser.frames.length;
		await idle(fixture, sessionId);
		await browser.waitForTurnEnd(sessionId, cursor);
		expect(read(fixture, sessionId).ends).toEqual([
			{ runId: held.runs[0]?.id, reason: "completed" },
		]);
		proveToolRowsOnLedger("opencode", fixture);
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

	it("a prompt whose send comes back unknown and then runs late keeps its Run live while the work runs, probes until an idle read after the work, and ends it once", async () => {
		const fixture = await start(instanceId, 500);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Lost prompt",
			instanceId,
			"opencode",
		);
		const promptPath = `/session/${sessionId}/prompt_async`;
		const prompts = () =>
			fixture
				.opencodeRequestBodies()
				.filter(({ path }) => path === promptPath)
				.map(
					({ body }) => (JSON.parse(body) as { messageID?: string }).messageID,
				);
		const drop = join(fixture.configDir, "fake-opencode-drop-prompt");
		writeFileSync(drop, "drop");
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: "lost",
			}),
		);
		// Every try of the request died unanswered: the send comes back unknown.
		await until(() => expect(probing(fixture, sessionId).unknown).toBe(1));
		unlinkSync(drop);
		const sent = prompts();
		expect(new Set(sent).size).toBe(1);

		// The input probe reads the prompt absent, its work then begins (as live), and the idle probe
		// that follows reads it busy.
		await until(() =>
			expect(probing(fixture, sessionId).findings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						target: "native_session",
						finding: "native_busy",
					}),
				]),
			),
		);
		// The Run stays live while the late work runs.
		const during = read(fixture, sessionId);
		expect(during.ends).toEqual([]);
		const workEndedAt = Date.now();
		await idle(fixture, sessionId);
		await until(() => {
			const now = probing(fixture, sessionId);
			expect(now.findings.at(-1)?.finding).toBe("native_idle");
			// Nothing is left to probe or to wake for.
			expect(now.alarmAt ?? null).toBeNull();
			expect(read(fixture, sessionId).ends).toHaveLength(1);
		});

		const after = {
			...read(fixture, sessionId),
			...probing(fixture, sessionId),
		};
		proofs.push({
			scenario: "lost-prompt-late-work",
			during,
			after,
			sent: prompts(),
		});
		expect(
			after.findings.map(({ target, finding }) => `${target}:${finding}`),
		).toEqual([
			"input:input_absent",
			...after.findings.slice(1, -1).map(() => "native_session:native_busy"),
			"native_session:native_idle",
		]);
		// The idle read that ends probing came after the work.
		expect(after.findings.at(-1)?.at).toBeGreaterThanOrEqual(workEndedAt);
		expect(after.probes.every(({ status }) => status === "completed")).toBe(
			true,
		);
		// Never re-sent; one Run, ended once by its own work, as main ends its run.
		expect(prompts()).toEqual(sent);
		expect(after.runs).toEqual([
			{ id: after.runs[0]?.id, status: "completed" },
		]);
		// OpenCode's echo of the prompt is a later acceptance: it beats the absent reading, so the
		// unknown delivery no longer folds as a failure and the Run ends as its work did (CONTRACT.md
		// 564, 3101-3102, 3128-3131).
		expect(after.ends).toEqual([
			{ runId: after.runs[0]?.id, reason: "completed" },
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

	it("a process that dies while the daemon is down ends its held Run once, as main's restart recovery ends it, and the next send runs under a new id", async () => {
		const fixture = await start();
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Process dies while the daemon is down",
			instanceId,
			"opencode",
		);
		const before = await hold(fixture, browser, sessionId);
		const [first] = started(before);
		const heldRun = before.runs[0]?.id;

		await fixture.terminate();
		const [victim] = spawned(fixture);
		if (!victim) throw new Error("No fake OpenCode");
		process.kill(victim.pid, "SIGKILL");
		await fixture.restart();
		// Startup re-adopts only a live process, so main's recovery ends the orphaned run, and the
		// ledger folds that one terminal (CONTRACT.md 2.1 D59: a Run with an open main run ends as
		// main), with no new process yet to retire the old id.
		await until(() =>
			expect(read(fixture, sessionId).ends).toEqual([
				{ runId: heldRun, reason: "provider_error" },
			]),
		);
		const recovered = read(fixture, sessionId);
		// The next send starts a new process; its start retires the old id with the Run already ended.
		await (await fixture.connect()).send(sessionId, "after the daemon restart");

		const after = read(fixture, sessionId);
		const [, second] = started(after);
		const nextRun = after.runs.at(-1)?.id;
		proofs.push({
			scenario: "death-while-daemon-down",
			before,
			recovered,
			after,
		});
		expect(spawned(fixture)).toHaveLength(2);
		expect(recovered.runs).toEqual([{ id: heldRun, status: "error" }]);
		expect(second).toMatchObject({
			label: `${second?.runnerId}:0`,
			reattached: 0,
		});
		expect(second?.runnerId).not.toBe(first?.runnerId);
		expect(started(after)).toHaveLength(2);
		// Conduit stopped nothing, so no loss is written (CONTRACT.md 2.1 row 215, 9).
		expect(lost(after)).toEqual([]);
		expect(after.ends).toEqual([
			{ runId: heldRun, reason: "provider_error" },
			{ runId: nextRun, reason: "completed" },
		]);
	});

	// Live checks against the pinned real OpenCode, with a local model server so no credential is
	// needed (CONTRACT.md 9 "Open, needs a live check": OpenCode `prompt_async`/abort executing after
	// the client request ended). How these could fail, beyond 1 to 8 above:
	// 9. a real abort never reaches OpenCode, or reaches it under another process id than the label's;
	// 10. a real crash or a conduit restart of the instance leaves the held Run open, or ends it twice;
	// 11. a daemon restart that reuses the real server reports a new id or ends the held Run;
	// 12. the recorded wire behaviour (late execution after the client request ended) differs from
	//     what the ledger assumes, unnoticed.
	describe("live, against a real OpenCode", () => {
		type ModelCall = {
			at: number;
			model: string;
			text: string;
			outcome: "answered" | "held" | "released" | "aborted";
		};
		let model: Server | undefined;
		let calls: ModelCall[] = [];
		let releases: (() => void)[] = [];
		afterEach(async () => {
			for (const release of releases) release();
			releases = [];
			await new Promise<void>((done) =>
				model ? model.close(() => done()) : done(),
			);
			model = undefined;
		});
		/** OpenAI-compatible model: a last user message containing HOLD streams nothing until released. */
		const serveModel = async () => {
			calls = [];
			model = createServer(async (request, response) => {
				let body = "";
				for await (const chunk of request) body += String(chunk);
				const input = JSON.parse(body) as {
					model: string;
					stream?: boolean;
					messages: { role: string; content: unknown }[];
				};
				const content = input.messages
					.filter(({ role }) => role === "user")
					.at(-1)?.content;
				const text =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content
									.map((part) => (part as { text?: string }).text ?? "")
									.join("")
							: "";
				const call: ModelCall = {
					at: Date.now(),
					model: input.model,
					text,
					outcome: "answered",
				};
				calls.push(call);
				const chunk = (delta: object, finish: string | null) =>
					`data: ${JSON.stringify({ id: "live", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
				const answer = () => {
					response.write(chunk({ role: "assistant", content: "Done." }, null));
					response.write(chunk({}, "stop"));
					response.end("data: [DONE]\n\n");
				};
				if (!input.stream) {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end(
						JSON.stringify({
							id: "live",
							object: "chat.completion",
							created: 1,
							model: input.model,
							choices: [
								{
									index: 0,
									message: { role: "assistant", content: "Title" },
									finish_reason: "stop",
								},
							],
							usage: {
								prompt_tokens: 1,
								completion_tokens: 1,
								total_tokens: 2,
							},
						}),
					);
					return;
				}
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.flushHeaders();
				if (input.model !== "main" || !text.includes("HOLD")) return answer();
				call.outcome = "held";
				response.once("close", () => {
					if (call.outcome === "held") call.outcome = "aborted";
				});
				releases.push(() => {
					if (call.outcome !== "held") return;
					call.outcome = "released";
					answer();
				});
			});
			await new Promise<void>((done) =>
				model?.listen(0, "127.0.0.1", () => done()),
			);
			const address = model.address();
			if (!address || typeof address === "string")
				throw new Error("Missing model port");
			return {
				enabled_providers: ["ledger-live"],
				model: "ledger-live/main",
				small_model: "ledger-live/title",
				provider: {
					"ledger-live": {
						npm: "@ai-sdk/openai-compatible",
						options: {
							baseURL: `http://127.0.0.1:${address.port}/v1`,
							apiKey: "live",
						},
						models: {
							main: { name: "Main", limit: { context: 16384, output: 1024 } },
							title: { name: "Title", limit: { context: 16384, output: 64 } },
						},
					},
				},
			};
		};
		const startReal = async () => {
			const config = await serveModel();
			const fixture = ProcessHarness.create({
				managedOpenCode: true,
				managedOpenCodeId: instanceId,
				realOpenCode: resolveRealOpenCode(),
			});
			harness = fixture;
			const seed = Result.getOrThrowWith(
				loadDaemonConfigResult(fixture.configDir),
				(error) => error,
			);
			writeFileSync(
				join(fixture.configDir, "daemon.json"),
				JSON.stringify({
					...seed,
					instances: seed?.instances?.map((instance) => ({
						...instance,
						env: {
							...instance.env,
							OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
						},
					})),
				}),
			);
			await fixture.restart();
			const browser = await fixture.connect();
			// test-waits-allow polling: the real server takes a while to listen.
			await vi.waitFor(() => browser.startInstance(instanceId), {
				timeout: 60_000,
				interval: 500,
			});
			const sessionId = await browser.createSession(
				"Live OpenCode",
				instanceId,
				"opencode",
				{ modelProviderId: "ledger-live", modelId: "main" },
			);
			return { fixture, browser, sessionId };
		};
		/** Submits a turn the model holds, and waits until main runs it. */
		const holdReal = async (
			fixture: ProcessHarness,
			browser: Awaited<ReturnType<ProcessHarness["connect"]>>,
			sessionId: string,
		) => {
			const text = `HOLD ${randomUUID()}`;
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId: randomUUID(),
					delivery: "queue",
					text,
				}),
			);
			await until(() => {
				expect(calls).toContainEqual(
					expect.objectContaining({ text, outcome: "held" }),
				);
				expect(read(fixture, sessionId).runs.at(-1)?.status).toBe("running");
			}, 20_000);
			return read(fixture, sessionId);
		};
		const wire = (fixture: ProcessHarness, sessionId: string) =>
			fixture
				.opencodeRequests()
				.filter(({ url }) => url.includes(sessionId))
				.map(({ pid, at, method, url }) => ({
					pid,
					at,
					method,
					path: url.split("?")[0],
				}));

		/** Main's run and turn events, so a proof shows which terminal each Run folded. */
		const turns = (fixture: ProcessHarness, sessionId: string) => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return db
					.prepare(
						"SELECT type, json_extract(data, '$.code') AS code, json_extract(data, '$.error') AS error FROM events WHERE session_id = ? AND (type LIKE 'turn.%' OR type LIKE 'run.%') AND type NOT IN ('turn.started') ORDER BY sequence",
					)
					.all(sessionId) as {
					type: string;
					code: string | null;
					error: string | null;
				}[];
			} finally {
				db.close();
			}
		};
		const live = (
			scenario: string,
			fixture: ProcessHarness,
			sessionId: string,
			states: Record<string, unknown>,
		) =>
			proofs.push({
				scenario: `live:${scenario}`,
				opencode: resolveRealOpenCode(),
				...states,
				turns: turns(fixture, sessionId),
				model: calls,
				wire: wire(fixture, sessionId),
			});

		it("a send, a refused steer and a Stop go through the ledger, and the abort reaches the real OpenCode under the label's id", async () => {
			const { fixture, browser, sessionId } = await startReal();
			await browser.send(sessionId, "plain send");
			const before = await holdReal(fixture, browser, sessionId);
			const [sentRun, heldRun] = before.runs.map(({ id }) => id);
			const [first] = started(before);
			expect(
				await Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId,
						originId: browser.originId,
						inputId: randomUUID(),
						delivery: "steer",
						text: "steered",
					}),
				),
			).toEqual({ ok: false, reason: "no_steering" });
			const commandId = randomUUID();
			expect(
				await Effect.runPromise(
					browser.rpc.CancelSession({ sessionId, commandId }),
				),
			).toMatchObject({ ok: true });
			await until(() => expect(read(fixture, sessionId).ends).toHaveLength(2));

			const after = read(fixture, sessionId);
			live("send-steer-stop", fixture, sessionId, { before, after });
			expect(started(after)).toEqual([first]);
			expect(
				fixture
					.opencodeRequests()
					.filter(
						({ method, url }) =>
							method === "POST" &&
							url.split("?")[0] === `/session/${sessionId}/abort`,
					)
					.every(({ pid }) => pid === spawned(fixture)[0]?.pid),
			).toBe(true);
			expect(after.controls).toContainEqual({
				effect: "interrupt_turn",
				processId: first?.runnerId,
				status: "completed",
			});
			// The real model call was cut by the abort.
			expect(calls.map(({ outcome }) => outcome)).toEqual([
				"answered",
				"aborted",
			]);
			// Each Run ends once, by main's terminal: OpenCode reports the abort as a session error.
			expect(after.ends).toEqual([
				{ runId: sentRun, reason: "completed" },
				{ runId: heldRun, reason: "provider_error" },
			]);
		});

		it("a crash of the real OpenCode mid-Run ends that Run as lost once, at the new process's start, while main leaves its run open", async () => {
			const { fixture, browser, sessionId } = await startReal();
			const before = await holdReal(fixture, browser, sessionId);
			const [first] = started(before);
			const heldRun = before.runs[0]?.id;
			const [victim] = spawned(fixture) as { pid: number; childPid?: number }[];
			if (!victim?.childPid) throw new Error("No real OpenCode");
			process.kill(victim.childPid, "SIGKILL");
			// The supervisor respawns it; the new process sends nothing for the held session.
			await streaming(fixture, 1);
			await until(
				() =>
					expect(read(fixture, sessionId).ends).toEqual([
						{ runId: heldRun, reason: "process_lost" },
					]),
				20_000,
			);

			const after = read(fixture, sessionId);
			const [, second] = started(after);
			live("crash-restart", fixture, sessionId, { before, after });
			expect(second?.runnerId).not.toBe(first?.runnerId);
			expect(second).toMatchObject({
				label: `${second?.runnerId}:0`,
				reattached: 0,
			});
			expect(started(after)).toHaveLength(2);
			// No conduit stop, so no loss event: the old id retires at the new id's start (L1), and
			// main settles that nowhere and leaves its run open (CONTRACT.md 2.1, 9).
			expect(lost(after)).toEqual([]);
			expect(after.runs).toEqual([{ id: heldRun, status: "running" }]);
		});

		it("a conduit stop and start of the real instance mid-Run writes its loss once, and the next send runs under a new id", async () => {
			const { fixture, browser, sessionId } = await startReal();
			const before = await holdReal(fixture, browser, sessionId);
			const [first] = started(before);
			const heldRun = before.runs[0]?.id;
			await browser.stopInstance(instanceId);
			await browser.startInstance(instanceId);
			await streaming(fixture, 1);
			await browser.send(sessionId, "after the stop");

			const after = read(fixture, sessionId);
			const [, second] = started(after);
			live("instance-stop-start", fixture, sessionId, { before, after });
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
				{ runId: after.runs.at(-1)?.id, reason: "completed" },
			]);
		});

		it("a daemon restart that reuses the real OpenCode mid-Run reports a reattach with the same id and ends the Run by its own work", async () => {
			const { fixture, browser, sessionId } = await startReal();
			const before = await holdReal(fixture, browser, sessionId);
			const [first] = started(before);
			const heldRun = before.runs[0]?.id;
			await fixture.terminate();
			await fixture.restart();
			expect(spawned(fixture)).toHaveLength(1);
			await streaming(fixture, 0, 2);
			for (const release of releases) release();
			await until(() =>
				expect(read(fixture, sessionId).runs).toEqual([
					{ id: heldRun, status: "completed" },
				]),
			);

			const after = read(fixture, sessionId);
			live("daemon-restart-reuse", fixture, sessionId, { before, after });
			expect(started(after)).toEqual([first, { ...first, reattached: 1 }]);
			expect(lost(after)).toEqual([]);
			expect(after.ends).toEqual([{ runId: heldRun, reason: "completed" }]);
		});

		// CONTRACT.md 3125-3131: the decider reads an absent OpenCode prompt only through a later idle
		// read, because a prompt or abort whose client request ended may still run. This pins that
		// wire behaviour of the real server, so a change to it fails here (12 above).
		it("the real OpenCode runs a prompt and an abort whose client request ended, but not a cut-short body", async () => {
			const config = await serveModel();
			const root = mkdtempSync(join(tmpdir(), "oc-wire-"));
			for (const dir of ["home", "project", "config", "data", "state", "cache"])
				mkdirSync(join(root, dir));
			writeFileSync(join(root, "models.json"), "{}");
			// OpenCode's --port 0 tries 4096 first, so reserve a free port instead.
			const reservation = createServer();
			await new Promise<void>((done) =>
				reservation.listen(0, "127.0.0.1", () => done()),
			);
			const reserved = reservation.address();
			if (!reserved || typeof reserved === "string")
				throw new Error("Missing OpenCode port");
			await new Promise<void>((done) => reservation.close(() => done()));
			const server = spawn(
				resolveRealOpenCode(),
				["serve", "--hostname", "127.0.0.1", "--port", String(reserved.port)],
				{
					cwd: join(root, "project"),
					env: {
						PATH: process.env["PATH"],
						HOME: join(root, "home"),
						npm_config_offline: "true",
						OPENCODE_MODELS_PATH: join(root, "models.json"),
						OPENCODE_DISABLE_MODELS_FETCH: "true",
						OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
						OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
						XDG_CONFIG_HOME: join(root, "config"),
						XDG_DATA_HOME: join(root, "data"),
						XDG_STATE_HOME: join(root, "state"),
						XDG_CACHE_HOME: join(root, "cache"),
					},
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			try {
				let output = "";
				const base = await new Promise<string>((done, fail) => {
					server.once("exit", () =>
						fail(new Error(`OpenCode exited: ${output}`)),
					);
					server.stdout?.on("data", (chunk: Buffer) => {
						output += chunk.toString("utf8");
						const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
						if (url) done(url);
					});
				});
				const port = Number(new URL(base).port);
				expect([2633, 4096]).not.toContain(port);
				const json = async (method: string, path: string, body?: object) =>
					(await fetch(`${base}${path}`, {
						method,
						headers: { "Content-Type": "application/json" },
						...(body ? { body: JSON.stringify(body) } : {}),
					}).then(async (response) =>
						JSON.parse((await response.text()) || "null"),
					)) as unknown;
				const session = async () =>
					((await json("POST", "/session", {})) as { id: string }).id;
				type Message = {
					info: {
						role: string;
						error?: { name: string };
						time: { completed?: number };
					};
				};
				const messages = async (id: string) =>
					((await json("GET", `/session/${id}/message`)) as Message[]).map(
						({ info }) => ({
							role: info.role,
							error: info.error?.name,
							completed: info.time.completed !== undefined,
						}),
					);
				/** Writes the request on a raw socket and destroys it at once, so no reply is read. */
				const cut = (path: string, body: object, sent?: number) =>
					new Promise<void>((done) => {
						const data = JSON.stringify(body);
						const socket = connect(port, "127.0.0.1", () =>
							socket.write(
								`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\n\r\n${data.slice(0, sent)}`,
								() => {
									socket.destroy();
									done();
								},
							),
						);
					});
				const prompt = (text: string) => ({
					parts: [{ type: "text", text }],
					model: { providerID: "ledger-live", modelID: "main" },
				});

				const partial = await session();
				await cut(`/session/${partial}/prompt_async`, prompt("PARTIAL"), 20);
				const late = await session();
				await cut(`/session/${late}/prompt_async`, prompt("LATE"));
				await until(
					() =>
						expect(calls).toContainEqual(
							expect.objectContaining({
								model: "main",
								text: "LATE",
								outcome: "answered",
							}),
						),
					20_000,
				);
				const aborted = await session();
				await json("POST", `/session/${aborted}/prompt_async`, prompt("HOLD"));
				await until(() =>
					expect(calls).toContainEqual(
						expect.objectContaining({ text: "HOLD", outcome: "held" }),
					),
				);
				await cut(`/session/${aborted}/abort`, {});
				await until(() =>
					expect(calls).toContainEqual(
						expect.objectContaining({ text: "HOLD", outcome: "aborted" }),
					),
				);

				const wire = {
					late: await messages(late),
					partial: await messages(partial),
					aborted: await messages(aborted),
				};
				proofs.push({
					scenario: "live:client-request-ended",
					opencode: resolveRealOpenCode(),
					model: calls,
					wire,
				});
				expect(calls.filter(({ text }) => text === "PARTIAL")).toEqual([]);
				expect(wire.partial).toEqual([]);
				expect(wire.late).toEqual([
					{ role: "user", error: undefined, completed: false },
					{ role: "assistant", error: undefined, completed: true },
				]);
				expect(wire.aborted).toEqual([
					{ role: "user", error: undefined, completed: false },
					{ role: "assistant", error: "MessageAbortedError", completed: true },
				]);
			} finally {
				server.kill("SIGKILL");
				rmSync(root, { recursive: true, force: true });
			}
		});
	});
});

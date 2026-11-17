import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
	makeProductionProcessTable,
	sameProcess,
} from "../../../src/lib/provider/runner/process-table.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

const processTable = makeProductionProcessTable();
const evidenceDirectory =
	process.env["CONDUIT_RUNNER_EVIDENCE_DIR"] ??
	mkdtempSync(join(tmpdir(), "send-continuation-evidence-"));
mkdirSync(evidenceDirectory, { recursive: true });

function records(path: string): Array<Record<string, unknown>> {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
		: [];
}

function durable(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			commands: db
				.prepare(
					"SELECT command_id,run_id,status,error_code,payload_json FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId) as Array<{
				command_id: string;
				run_id: string;
				status: string;
				error_code: string | null;
				payload_json: string;
			}>,
			runs: db
				.prepare(
					"SELECT id,status,runner_id,held_transmission FROM provider_runs WHERE session_id = ? ORDER BY requested_at,id",
				)
				.all(sessionId) as Array<{
				id: string;
				status: string;
				runner_id: string | null;
				held_transmission: number | null;
			}>,
			events: db
				.prepare(
					"SELECT type,data,metadata FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as Array<{
				type: string;
				data: string;
				metadata: string;
			}>,
			controls: db
				.prepare(
					"SELECT effect_type,payload_json,status FROM provider_command_outbox WHERE session_id = ? AND effect_type IN ('interrupt_turn','end_session') ORDER BY request_sequence",
				)
				.all(sessionId),
			runners: db
				.prepare(
					"SELECT runner_id,pid,start_time,stop_reason,retired_at,role FROM claude_runner_cursors WHERE session_id = ? ORDER BY runner_id",
				)
				.all(sessionId),
		};
	} finally {
		db.close();
	}
}

function runEvents(
	state: ReturnType<typeof durable>,
	runId: string,
	type: string,
) {
	return state.events.filter(
		(event) =>
			event.type === type &&
			((JSON.parse(event.metadata) as { runId?: string }).runId === runId ||
				(JSON.parse(event.data) as { runId?: string }).runId === runId),
	);
}

function installContinuationFixture(harness: ProcessHarness) {
	const dist = resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist");
	const moduleUrl = (path: string) =>
		pathToFileURL(join(dist, "src/lib", path)).href;
	const effectUrl = pathToFileURL(
		createRequire(import.meta.url).resolve("effect"),
	).href;
	appendFileSync(
		join(harness.root, "runner-identity-fixture.mjs"),
		`
import { RunnerSocket as ContinuationSocket } from ${JSON.stringify(moduleUrl("provider/runner/runner-protocol.js"))};
import { ClaudeTranslationService as ContinuationTranslator } from ${JSON.stringify(moduleUrl("provider/claude/claude-translation-service.js"))};
import { Effect as ContinuationEffect } from ${JSON.stringify(effectUrl)};
const continuationControl = () => existsSync(join(root,"continuation-control.json")) ? JSON.parse(readFileSync(join(root,"continuation-control.json"),"utf8")) : {};
const continuationRecord = (kind,fields={}) => fs.appendFileSync(join(root,"continuation-wire.ndjson"),JSON.stringify({kind,pid:process.pid,...fields})+"\\n");
const continuationHost = /claude-session-runner\\.(js|ts)$/.test(process.argv[1]??"");
const continuationWrite = ContinuationSocket.prototype.write;
ContinuationSocket.prototype.write = function(message) {
  const control=continuationControl();
  if(continuationHost) {
    if(message.type==="hello") continuationRecord("host-hello",{message});
    if(message.type==="command-refused" || message.type==="command-reply") continuationRecord("host-reply",{message});
    if(message.type==="idle-exit" && control.suppressIdle && control.pid===process.pid) { continuationRecord("host-exiting"); return; }
    const result=continuationWrite.call(this,message);
    if(message.type==="command-reply" && control.pauseReads && control.pid===process.pid && !this.continuationReadPaused) {
      this.continuationReadPaused=true;
      const reader=this.socket;
      const timer=setInterval(()=>{
        if(!existsSync(join(root,"continuation-read-pause-ready"))) return;
        clearInterval(timer);
        reader.pause();
        continuationRecord("host-read-paused");
        const resume=setInterval(()=>{ if(!existsSync(join(root,"continuation-host-read-gate"))) { clearInterval(resume); reader.resume(); continuationRecord("host-read-resumed"); } },10);
        resume.unref();
      },10);
      timer.unref();
    }
    return result;
  }
  if(message.type==="command") {
    continuationRecord("daemon-command",{message});
    if(message.command.type==="send-turn" && message.command.input.prompt===control.prompt && existsSync(join(root,"continuation-delay-send"))) {
      const owner=this;
      continuationRecord("frame-delayed",{message});
      const timer=setInterval(()=>{ if(!existsSync(join(root,"continuation-delay-send"))) { clearInterval(timer); continuationWrite.call(owner,message); continuationRecord("frame-written",{message}); } },10);
      timer.unref();
      return;
    }
  }
  const result=continuationWrite.call(this,message);
  if(message.type==="command" && message.command.type==="send-turn") continuationRecord("frame-written",{message});
  return result;
};
if(continuationHost) {
  setTimeout(()=>process.exit(0),120_000).unref();
  const translateError=ContinuationTranslator.prototype.translateError;
  ContinuationTranslator.prototype.translateError=function(...args) {
    const result=translateError.apply(this,args);
    return continuationControl().abandon && continuationControl().pid===process.pid
      ? result.pipe(ContinuationEffect.andThen(ContinuationEffect.fail({operation:"translateError",message:"Fixture failed the terminal delivery after committing it"})))
      : result;
  };
}
`,
	);
}

async function waitRecord(
	harness: ProcessHarness,
	kind: string,
	predicate: (record: Record<string, unknown>) => boolean = () => true,
) {
	let record: Record<string, unknown> | undefined;
	await vi.waitFor(
		() => {
			record = records(join(harness.root, "continuation-wire.ndjson")).find(
				(item) => item["kind"] === kind && predicate(item),
			);
			expect(record).toBeDefined();
		},
		{ timeout: harness.remainingTimeMs(15_000), interval: 20 },
	);
	assert(record);
	return record;
}

async function waitPause(harness: ProcessHarness, point: string) {
	let record: Record<string, unknown> | undefined;
	await vi.waitFor(
		() => {
			record = records(join(harness.root, "sdk-proof.ndjson")).find(
				(item) =>
					item["kind"] === "send-continuation-paused" &&
					item["point"] === point,
			);
			expect(record).toBeDefined();
		},
		{ timeout: harness.remainingTimeMs(15_000), interval: 20 },
	);
	assert(record);
	return record;
}

async function completed(
	harness: ProcessHarness,
	sessionId: string,
	inputId: string,
	prompt: string,
) {
	let command: ReturnType<typeof durable>["commands"][number] | undefined;
	await vi.waitFor(
		() => {
			const state = durable(harness, sessionId);
			command = state.commands.find((row) => row.command_id === inputId);
			assert(command);
			expect(command.status).toBe("completed");
			expect(state.runs.find((run) => run.id === command?.run_id)?.status).toBe(
				"completed",
			);
		},
		{ timeout: harness.remainingTimeMs(20_000), interval: 30 },
	);
	assert(command);
	const enqueues = records(join(harness.root, "sdk-proof.ndjson")).filter(
		(mark) => mark["kind"] === "enqueue" && mark["request"] === prompt,
	);
	expect(enqueues).toHaveLength(1);
	const state = durable(harness, sessionId);
	expect(
		state.runs.filter(
			(run) => run.status === "running" || run.status === "pending",
		),
	).toEqual([]);
	expect(runEvents(state, command.run_id, "turn.completed")).toHaveLength(1);
	return { command, state, enqueues };
}

function ownRunner(harness: ProcessHarness, sessionId: string) {
	const mark = harness.marks.find(
		(item) => item.kind === "runner-started" && item.sessionId === sessionId,
	);
	assert(mark?.kind === "runner-started");
	const observed = processTable.identify([mark.pid]).get(mark.pid);
	assert(observed?.state === "running");
	return { ...mark, startTime: observed.startTime };
}

function signalRunner(runner: ReturnType<typeof ownRunner>, signal: "SIGKILL") {
	const current = processTable.identify([runner.pid]).get(runner.pid);
	assert(
		sameProcess(runner, current) === "same",
		"Only the fixture-owned original process may be signalled",
	);
	process.kill(runner.pid, signal);
}

describe("send continuation through real daemon and runner processes", () => {
	for (const mode of [19, 20, 26, 29, 30, 34, 35, 40, 43] as const) {
		it(`SEND-CONTINUATION ${mode}: ${{ 19: "idle refusal continues once", 20: "plain Stop refusal never delivers", 26: "restart feeds an unheld running send", 29: "abandoned-run retirement continues once", 30: "adoption never adds a transmission", 34: "old unread socket is drained before adoption", 35: "Stop fences a late bound transmission", 40: "live reconciliation releases an exited reader", 43: "adoption releases a never-written hold" }[mode]}`, async () => {
			const harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
				restartProof: true,
				deadline: performance.now() + 100_000,
				runnerLifecycle:
					mode === 19
						? { idleDayMs: 700, idleExitDelayMs: 1200 }
						: { idleTimeoutMs: null },
			});
			const artifact = join(
				evidenceDirectory,
				`send-continuation-${mode}-${randomUUID()}.json`,
			);
			const evidence: Record<string, unknown> = { mode, passed: false };
			let sessionId: string | undefined;
			try {
				installContinuationFixture(harness);
				const point = mode === 26 ? "before-hold" : "after-hold";
				await harness.restart({
					serviceEnvironment: { CONDUIT_TEST_SEND_CONTINUATION_PAUSE: point },
				});
				let browser = await harness.connect();
				sessionId = await browser.createSession(`Send continuation ${mode}`);
				if (mode === 19) await browser.setAutoSettle(1);
				await browser.send(sessionId, "continuation-setup");
				const runner = ownRunner(harness, sessionId);
				evidence["originalRunner"] = runner;
				const prompt =
					mode === 30 ? "upgrade-long-turn" : `continuation-target-${mode}`;
				const control = {
					pid: runner.pid,
					prompt,
					suppressIdle: mode === 19 || mode === 20,
					pauseReads: mode === 34 || mode === 40,
					abandon: mode === 29,
				};
				writeFileSync(
					join(harness.root, "continuation-control.json"),
					JSON.stringify(control),
				);
				if (mode === 34 || mode === 40) {
					writeFileSync(
						join(harness.root, "continuation-host-read-gate"),
						"hold",
					);
					await browser.send(sessionId, "continuation-arm-read-pause");
					writeFileSync(
						join(harness.root, "continuation-read-pause-ready"),
						"arming input completed",
					);
					await waitRecord(harness, "host-read-paused");
				}
				let abandoned: Promise<unknown> | undefined;
				if (mode === 29) {
					writeFileSync(
						join(harness.root, "conduit-test-hold-abandoned-run-retirement"),
						"hold",
					);
					abandoned = browser.send(sessionId, "fail-before-assistant-restart");
					void abandoned.catch(() => undefined);
					await harness.waitForMark(
						(mark) =>
							mark.kind === "pre-assistant-held" &&
							mark.prompt === "fail-before-assistant-restart",
					);
				}
				const pauseGate = join(
					harness.root,
					`conduit-test-send-continuation-${point}`,
				);
				if (mode !== 30 && mode !== 20 && mode !== 35)
					writeFileSync(pauseGate, "hold");
				if (mode === 20 || mode === 35)
					writeFileSync(join(harness.root, "continuation-delay-send"), "hold");
				// Submit the target before waiting on it. Browser.send's history
				// prelude cannot run behind the deliberately held abandoned input.
				const inputId = randomUUID();
				expect(
					(
						await harness.requestRpc({
							_tag: "input.submit",
							sessionId,
							inputId,
							delivery: "queue",
							text: prompt,
						})
					).ok,
				).toBe(true);
				evidence["targetInputId"] = inputId;
				if (mode === 29) {
					writeFileSync(
						join(harness.root, "release-before-assistant"),
						"release",
					);
					await vi.waitFor(
						() =>
							expect(
								records(join(harness.root, "sdk-proof.ndjson")).some(
									(mark) =>
										mark["kind"] === "runner-abandoned-retirement-paused",
								),
							).toBe(true),
						{ timeout: harness.remainingTimeMs(15_000), interval: 20 },
					);
					// A queue left behind by a failed turn needs the tray's Resume
					// action. The retired host remains alive behind its own gate.
					await browser.sendNow(sessionId, inputId);
				}
				if (mode === 20 || mode === 35) {
					await waitRecord(harness, "frame-delayed");
					const stop = harness.requestRpc({
						_tag: "CancelSession",
						sessionId,
						commandId: randomUUID(),
					});
					void stop.catch(() => undefined);
					await vi.waitFor(
						() => {
							const state = durable(harness, sessionId ?? "");
							expect(
								state.controls.some(
									(row) =>
										(row as { effect_type: string }).effect_type ===
										"interrupt_turn",
								),
							).toBe(true);
						},
						{ timeout: harness.remainingTimeMs(15_000), interval: 20 },
					);
					await waitRecord(harness, "host-reply", (item) => {
						const message = item["message"] as { commandId?: string };
						return records(join(harness.root, "continuation-wire.ndjson")).some(
							(entry) => {
								const command = entry["message"] as
									| { commandId?: string; command?: { type?: string } }
									| undefined;
								return (
									entry["kind"] === "daemon-command" &&
									command?.commandId === message.commandId &&
									command?.command?.type === "interrupt"
								);
							},
						);
					});
					rmSync(join(harness.root, "continuation-delay-send"), {
						force: true,
					});
					await waitRecord(harness, "host-reply", (item) => {
						const message = item["message"] as {
							type?: string;
							reason?: string;
						};
						return (
							message.type === "command-refused" &&
							message.reason === "interrupted"
						);
					});
					await stop;
					await vi.waitFor(
						() => {
							const state = durable(harness, sessionId ?? "");
							const command = state.commands.find(
								(row) => row.command_id === inputId,
							);
							assert(command);
							expect(
								state.runs.find((run) => run.id === command.run_id)?.status,
							).toBe("interrupted");
							expect(
								runEvents(state, command.run_id, "turn.interrupted"),
							).toHaveLength(1);
							// The Stop committed after the write permission was taken, so only
							// the host's refusal (4.6) may release it, never a pre-write NotSent.
							expect(
								runEvents(state, command.run_id, "run.released").map(
									(event) =>
										(JSON.parse(event.data) as { reason: string }).reason,
								),
							).toEqual(["Refused"]);
							expect(
								runEvents(state, command.run_id, "turn.error"),
							).toHaveLength(0);
							expect(
								records(join(harness.root, "sdk-proof.ndjson")).filter(
									(mark) =>
										mark["kind"] === "enqueue" && mark["request"] === prompt,
								),
							).toEqual([]);
							expect(
								new Set(
									harness.marks
										.filter((mark) => mark.kind === "runner-started")
										.map((mark) => mark.pid),
								).size,
							).toBe(1);
						},
						{ timeout: harness.remainingTimeMs(15_000), interval: 30 },
					);
				} else if (mode === 30) {
					await harness.waitForMark(
						(mark) => mark.kind === "assistant-held" && mark.prompt === prompt,
					);
					const run = durable(harness, sessionId).commands.at(-1);
					assert(run);
					for (let count = 0; count < 3; count++) {
						await harness.kill();
						expect(
							processTable.identify([runner.pid]).get(runner.pid),
						).toMatchObject({
							state: "running",
							startTime: runner.startTime,
						});
						await harness.restart();
						browser = await harness.connect(sessionId);
						expect(
							runEvents(
								durable(harness, sessionId),
								run.run_id,
								"run.dispatched",
							),
						).toHaveLength(1);
					}
					writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
					evidence["completed"] = await completed(
						harness,
						sessionId,
						inputId,
						prompt,
					);
					expect(
						runEvents(durable(harness, sessionId), run.run_id, "run.released"),
					).toHaveLength(0);
				} else {
					const paused = await waitPause(harness, point);
					evidence["paused"] = paused;
					const before = durable(harness, sessionId);
					const command = before.commands.find(
						(row) => row.command_id === inputId,
					);
					assert(command);
					if (mode === 19) {
						await waitRecord(harness, "host-exiting");
						rmSync(pauseGate, { force: true });
						await waitRecord(harness, "host-reply", (item) => {
							const message = item["message"] as {
								type?: string;
								reason?: string;
							};
							return (
								message.type === "command-refused" &&
								message.reason === "exiting"
							);
						});
					} else if (mode === 29) {
						rmSync(pauseGate, { force: true });
						await waitRecord(harness, "host-reply", (item) => {
							const message = item["message"] as {
								type?: string;
								reason?: string;
							};
							return (
								message.type === "command-refused" &&
								message.reason === "retiring"
							);
						});
						rmSync(
							join(harness.root, "conduit-test-hold-abandoned-run-retirement"),
							{ force: true },
						);
						await abandoned;
					} else if (mode === 40 || mode === 34) {
						rmSync(pauseGate, { force: true });
						// A send's frame id is its Send Token; its run id names the run.
						await waitRecord(
							harness,
							"frame-written",
							(item) =>
								(item["message"] as { command?: { runId?: string } }).command
									?.runId === command.run_id,
						);
						expect(
							records(join(harness.root, "sdk-proof.ndjson")).filter(
								(mark) =>
									mark["kind"] === "enqueue" && mark["request"] === prompt,
							),
						).toEqual([]);
						if (mode === 40) signalRunner(runner, "SIGKILL");
						else {
							await harness.kill();
							expect(
								processTable.identify([runner.pid]).get(runner.pid),
							).toMatchObject({
								state: "running",
								startTime: runner.startTime,
							});
						}
						rmSync(join(harness.root, "continuation-host-read-gate"), {
							force: true,
						});
						if (mode === 34) {
							await harness.restart();
							browser = await harness.connect(sessionId);
						}
					} else {
						const held = before.runs.find((run) => run.id === command.run_id);
						expect(held?.runner_id).toBe(
							mode === 26 ? null : paused["runnerId"],
						);
						expect(command.status).toBe("running");
						await harness.kill();
						rmSync(pauseGate, { force: true });
						expect(
							processTable.identify([runner.pid]).get(runner.pid),
						).toMatchObject({
							state: "running",
							startTime: runner.startTime,
						});
						await harness.restart();
						browser = await harness.connect(sessionId);
					}
					const result = await completed(harness, sessionId, inputId, prompt);
					evidence["completed"] = result;
					// A release the stop commit carried may be appended again by the
					// write fiber; that stale repeat is a no-op (CONTRACT 4.5).
					const releases = [
						...new Map(
							runEvents(result.state, command.run_id, "run.released").map(
								(event) => {
									const data = JSON.parse(event.data) as {
										reason: string;
										runnerId: string;
										transmission: number;
									};
									return [`${data.runnerId}:${data.transmission}`, data];
								},
							),
						).values(),
					];
					const reason =
						mode === 19 || mode === 29
							? "Refused"
							: mode === 40
								? "JournalAbsent"
								: mode === 43
									? "NotSent"
									: undefined;
					expect(releases.map((event) => event.reason)).toEqual(
						reason ? [reason] : [],
					);
					expect(
						runEvents(result.state, command.run_id, "run.dispatched"),
					).toHaveLength(reason ? 2 : 1);
					const history = await browser.history(sessionId);
					expect(JSON.stringify(history)).toContain(
						responseChunks(prompt).join(""),
					);
				}
				evidence["durable"] = durable(harness, sessionId);
				evidence["passed"] = true;
			} finally {
				try {
					for (const file of [
						"continuation-host-read-gate",
						"continuation-read-pause-ready",
						"continuation-delay-send",
						"conduit-test-send-continuation-before-hold",
						"conduit-test-send-continuation-after-hold",
						"conduit-test-send-continuation-after-release",
						"conduit-test-hold-abandoned-run-retirement",
					])
						rmSync(join(harness.root, file), { force: true });
					writeFileSync(join(harness.root, "release-upgrade-turn"), "cleanup");
					writeFileSync(
						join(harness.root, "release-before-assistant"),
						"cleanup",
					);
					evidence["wire"] = records(
						join(harness.root, "continuation-wire.ndjson"),
					);
					evidence["sdk"] = records(join(harness.root, "sdk-proof.ndjson"));
					if (sessionId) {
						try {
							evidence["finalDurable"] = durable(harness, sessionId);
						} catch (cause) {
							evidence["captureFailure"] = String(cause);
						}
					}
				} catch (cause) {
					evidence["passed"] = false;
					evidence["captureFailure"] = String(cause);
					await Promise.reject(cause);
				} finally {
					try {
						await harness.dispose();
					} catch (cause) {
						evidence["passed"] = false;
						evidence["cleanupFailure"] = String(cause);
						await Promise.reject(cause);
					} finally {
						evidence["cleanup"] = harness.proof();
						writeFileSync(artifact, JSON.stringify(evidence, null, 2));
						process.stdout.write(
							`SEND-CONTINUATION ${mode} evidence: ${artifact}\n`,
						);
					}
				}
			}
		}, 120_000);
	}
});

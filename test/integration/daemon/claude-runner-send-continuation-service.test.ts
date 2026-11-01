import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

interface RunRow {
	id: string;
	status: string;
	runner_id: string | null;
	held_transmission: number | null;
}
interface CommandRow {
	command_id: string;
	run_id: string | null;
	request_sequence: number;
	effect_type: string;
	status: string;
	payload_json: string;
}
interface EventRow {
	type: string;
	data: string;
	metadata: string;
}

function persisted(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			runs: db
				.prepare<[string], RunRow>(
					"SELECT id, status, runner_id, held_transmission FROM provider_runs WHERE session_id = ? ORDER BY requested_at, id",
				)
				.all(sessionId),
			commands: db
				.prepare<[string], CommandRow>(
					"SELECT command_id, run_id, request_sequence, effect_type, status, payload_json FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
				)
				.all(sessionId),
			events: db
				.prepare<[string], EventRow>(
					"SELECT type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId),
		};
	} finally {
		db.close();
	}
}

function proof(harness: ProcessHarness): Array<Record<string, unknown>> {
	const file = join(harness.root, "sdk-proof.ndjson");
	return existsSync(file)
		? readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
		: [];
}

function terminalEvents(
	harness: ProcessHarness,
	sessionId: string,
	runId: string,
) {
	return persisted(harness, sessionId).events.filter(
		(event) =>
			["turn.completed", "turn.interrupted", "turn.error"].includes(
				event.type,
			) &&
			(JSON.parse(event.metadata) as Record<string, unknown>)["runId"] ===
				runId,
	);
}

const sendGate = (harness: ProcessHarness) =>
	join(harness.root, "conduit-test-send-continuation-before-hold");
const stopGate = (harness: ProcessHarness) =>
	join(harness.root, "conduit-test-stop-acceptance");

// Every cohort is created by CancelSession -> ProviderTurnService -> engine.
// The only SQL mutations inject an uncertain delivery or recommit sequence;
// neither writes a Stop control, cohort, run outcome or runner lifecycle state.
describe("Send continuation through the provider service and engine", () => {
	const fixtures: Array<{
		harness: ProcessHarness;
		mode: string;
		details: Record<string, unknown>;
	}> = [];
	afterEach(async (context) => {
		for (const { harness, mode, details } of fixtures.splice(0)) {
			let sdk: ReturnType<typeof proof> = [];
			let durable: ReturnType<typeof persisted> | undefined;
			try {
				sdk = proof(harness);
				durable =
					typeof details["sessionId"] === "string"
						? persisted(harness, details["sessionId"])
						: undefined;
			} catch (cause) {
				details["captureFailure"] = String(cause);
				throw cause;
			} finally {
				try {
					rmSync(sendGate(harness), { force: true });
					rmSync(stopGate(harness), { force: true });
					writeFileSync(
						join(harness.root, "task-stop-correction-release-steer"),
						"cleanup release",
					);
				} finally {
					try {
						await harness.dispose();
						expect(harness.remainingRunnerPids()).toEqual([]);
					} finally {
						const directory =
							process.env["CONDUIT_RUNNER_EVIDENCE_DIR"] ??
							join(tmpdir(), "r2-send-continuation-evidence");
						mkdirSync(directory, { recursive: true });
						writeFileSync(
							join(
								directory,
								`send-continuation-service-${mode}-${randomUUID()}.json`,
							),
							JSON.stringify(
								{
									test: context.task.name,
									assertionErrors:
										context.task.result?.errors?.map(
											(error) => error.message,
										) ?? [],
									...details,
									sdk,
									durable,
									cleanup: {
										remainingRunnerPids: harness.remainingRunnerPids(),
										proof: harness.proof(),
									},
								},
								null,
								2,
							),
						);
					}
				}
			}
		}
	});

	async function start(mode: string, idle = false) {
		const harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			deadline: performance.now() + 60_000,
			runnerLifecycle: { nonDefaultConfigDir: true, idleDayMs: 500 },
		});
		const details: Record<string, unknown> = {};
		fixtures.push({ harness, mode, details });
		await harness.restart({
			serviceEnvironment: {
				CONDUIT_TEST_SEND_CONTINUATION_PAUSE: "before-hold",
			},
		});
		const browser = await harness.connect();
		await browser.setAutoSettle(idle ? 1 : null);
		const sessionId = await browser.createSession(
			`Send continuation service ${mode}`,
		);
		details["sessionId"] = sessionId;
		const baseline = `service-before-${mode}`;
		expect((await browser.send(sessionId, baseline)).chunks.join("")).toBe(
			responseChunks(baseline).join(""),
		);
		return { harness, browser, sessionId, details };
	}

	async function waitingSend(
		harness: ProcessHarness,
		sessionId: string,
		prompt: string,
	) {
		writeFileSync(sendGate(harness), "pause before hold");
		const commandId = randomUUID();
		const submitted = await harness.requestRpc({
			_tag: "input.submit",
			sessionId,
			inputId: commandId,
			delivery: "queue",
			text: prompt,
		});
		expect(submitted.ok).toBe(true);
		await vi.waitFor(
			() =>
				expect(
					proof(harness).some(
						(mark) =>
							mark["kind"] === "send-continuation-paused" &&
							mark["point"] === "before-hold" &&
							mark["commandId"] === commandId,
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		const send = persisted(harness, sessionId).commands.find(
			(row) => row.command_id === commandId,
		);
		assert(send?.run_id);
		return { commandId, runId: send.run_id, prompt };
	}

	async function acceptedStop(
		harness: ProcessHarness,
		sessionId: string,
		commandId: string,
	) {
		await vi.waitFor(
			() =>
				expect(
					persisted(harness, sessionId).commands.some(
						(row) =>
							row.command_id === commandId &&
							["interrupt_turn", "end_session"].includes(row.effect_type),
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		const control = persisted(harness, sessionId).commands.find(
			(row) => row.command_id === commandId,
		);
		assert(control);
		return control;
	}

	async function stoppedBeforeDelivery(
		harness: ProcessHarness,
		sessionId: string,
		send: { runId: string; prompt: string },
	) {
		await vi.waitFor(
			() =>
				expect(
					persisted(harness, sessionId).runs.find(
						(row) => row.id === send.runId,
					),
				).toMatchObject({
					status: "interrupted",
					runner_id: null,
					held_transmission: null,
				}),
			{ timeout: 10_000 },
		);
		expect(terminalEvents(harness, sessionId, send.runId)).toMatchObject([
			{
				type: "turn.interrupted",
				data: JSON.stringify({
					messageId: "",
					reason: "Stopped before delivery",
				}),
			},
		]);
		expect(
			proof(harness).filter(
				(mark) => mark["kind"] === "enqueue" && mark["prompt"] === send.prompt,
			),
		).toEqual([]);
		expect(
			persisted(harness, sessionId).runs.some(
				(row) => row.status === "running",
			),
		).toBe(false);
	}

	it.each([
		"21-idle-end-session",
		"22-admission",
		"23-after-stop",
		"33-recommit",
		"44-replay",
	] as const)("service %s uses the production immutable Stop cohort", async (mode) => {
		const { harness, sessionId, details } = await start(
			mode,
			mode === "21-idle-end-session",
		);
		const send = await waitingSend(
			harness,
			sessionId,
			`service-covered-${mode}`,
		);
		details["send"] = send;
		const runnersBefore = harness.marks.filter(
			(mark) => mark.kind === "runner-started",
		).length;
		if (mode === "21-idle-end-session" || mode === "23-after-stop") {
			if (mode === "21-idle-end-session")
				await harness.waitForMark(
					(mark) => mark.kind === "runner-idle-exit-started",
				);
			const db = new Database(harness.daemonStorePath());
			try {
				db.prepare(
					"UPDATE provider_command_outbox SET error_code = 'delivery_indeterminate' WHERE command_id = ?",
				).run(send.commandId);
			} finally {
				db.close();
			}
		}
		const stopId = randomUUID();
		const stopping = harness.requestRpc({
			_tag: "CancelSession",
			sessionId,
			commandId: stopId,
		});
		void stopping.catch(() => undefined);
		const control = await acceptedStop(harness, sessionId, stopId);
		details["acceptedStop"] = control;
		expect(control.effect_type).toBe(
			mode === "21-idle-end-session" || mode === "23-after-stop"
				? "end_session"
				: "interrupt_turn",
		);
		const payload = JSON.parse(control.payload_json) as {
			stop: { owners: Array<{ runId: string }> };
		};
		expect(payload.stop.owners).toEqual([{ runId: send.runId }]);
		if (mode === "33-recommit") {
			const db = new Database(harness.daemonStorePath());
			try {
				db.prepare(
					"UPDATE provider_command_outbox SET request_sequence = (SELECT MAX(request_sequence) + 1 FROM provider_command_outbox) WHERE command_id = ?",
				).run(send.commandId);
			} finally {
				db.close();
			}
			expect(
				persisted(harness, sessionId).commands.find(
					(row) => row.command_id === send.commandId,
				)?.request_sequence,
			).toBeGreaterThan(control.request_sequence);
		}
		rmSync(sendGate(harness));
		await stoppedBeforeDelivery(harness, sessionId, send);
		await stopping;
		expect(
			harness.marks.filter((mark) => mark.kind === "runner-started"),
		).toHaveLength(runnersBefore);
		if (mode === "23-after-stop" || mode === "44-replay") {
			const laterId = randomUUID();
			const later = `service-later-${mode}`;
			expect(
				(
					await harness.requestRpc({
						_tag: "input.submit",
						sessionId,
						inputId: laterId,
						delivery: "queue",
						text: later,
					})
				).ok,
			).toBe(true);
			await vi.waitFor(
				() =>
					expect(
						persisted(harness, sessionId).commands.find(
							(row) => row.command_id === laterId,
						)?.status,
					).toBe("completed"),
				{ timeout: 10_000 },
			);
			expect(
				proof(harness).filter(
					(mark) => mark["kind"] === "enqueue" && mark["prompt"] === later,
				),
			).toHaveLength(1);
			if (mode === "23-after-stop")
				expect(
					harness.marks.filter((mark) => mark.kind === "runner-started"),
				).toHaveLength(runnersBefore + 1);
			if (mode === "44-replay") {
				await harness.requestRpc({
					_tag: "CancelSession",
					sessionId,
					commandId: stopId,
				});
				expect(
					persisted(harness, sessionId)
						.commands.filter((row) => row.command_id === stopId)
						.map((row) => row.payload_json),
				).toEqual([control.payload_json]);
				expect(
					persisted(harness, sessionId).events.filter(
						(event) => event.type === "interrupt.requested",
					),
				).toHaveLength(1);
			}
		}
		expect(
			persisted(harness, sessionId).runs.some((row) =>
				["pending", "running"].includes(row.status),
			),
		).toBe(false);
	}, 60_000);

	it("service 24 never exposes a gap between the Stop snapshot and control acceptance", async () => {
		const { harness, sessionId, details } = await start("24-one-stop-commit");
		const send = await waitingSend(harness, sessionId, "service-stop-atomic");
		details["send"] = send;
		writeFileSync(stopGate(harness), "pause inside Stop write");
		const stopId = randomUUID();
		const stopping = harness.requestRpc({
			_tag: "CancelSession",
			sessionId,
			commandId: stopId,
		});
		void stopping.catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					proof(harness).some(
						(mark) =>
							mark["kind"] === "stop-accept-paused" &&
							mark["commandId"] === stopId,
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		rmSync(sendGate(harness));
		expect(
			persisted(harness, sessionId).commands.some(
				(row) => row.command_id === stopId,
			),
		).toBe(false);
		expect(
			persisted(harness, sessionId).events.filter(
				(event) =>
					event.type === "run.dispatched" &&
					(JSON.parse(event.metadata) as Record<string, unknown>)["runId"] ===
						send.runId,
			),
		).toEqual([]);
		rmSync(stopGate(harness));
		await acceptedStop(harness, sessionId, stopId);
		await stoppedBeforeDelivery(harness, sessionId, send);
		await stopping;
	}, 60_000);

	it("service Stop keeps a retained steer outside its cohort and delivers it once", async () => {
		const { harness, sessionId, details } = await start("retained-steer");
		const activeId = randomUUID();
		const active = "task-stop-foreground-correction-steer-boundary-no-tasks";
		expect(
			(
				await harness.requestRpc({
					_tag: "input.submit",
					sessionId,
					inputId: activeId,
					delivery: "queue",
					text: active,
				})
			).ok,
		).toBe(true);
		await vi.waitFor(
			() =>
				expect(
					proof(harness).some(
						(mark) =>
							mark["kind"] === "task-stop-turn" &&
							mark["phase"] === "streaming" &&
							mark["request"] === active,
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		const steerId = randomUUID();
		const steer = "service-retained-steer";
		expect(
			(
				await harness.requestRpc({
					_tag: "input.submit",
					sessionId,
					inputId: steerId,
					delivery: "steer",
					text: steer,
				})
			).ok,
		).toBe(true);
		await vi.waitFor(
			() =>
				expect(
					persisted(harness, sessionId).commands.find(
						(row) => row.command_id === steerId,
					)?.status,
				).toBe("running"),
			{ timeout: 10_000 },
		);
		const steerRun = persisted(harness, sessionId).commands.find(
			(row) => row.command_id === steerId,
		)?.run_id;
		assert(steerRun);
		const stopId = randomUUID();
		const stopping = harness.requestRpc({
			_tag: "CancelSession",
			sessionId,
			commandId: stopId,
		});
		void stopping.catch(() => undefined);
		const control = await acceptedStop(harness, sessionId, stopId);
		details["acceptedStop"] = control;
		const payload = JSON.parse(control.payload_json) as {
			stop: { owners: Array<{ runId: string }>; retainedSteers: boolean };
		};
		expect(payload.stop.retainedSteers).toBe(true);
		expect(payload.stop.owners).not.toContainEqual({ runId: steerRun });
		await stopping;
		expect(terminalEvents(harness, sessionId, steerRun)).toEqual([]);
		writeFileSync(
			join(harness.root, "task-stop-correction-release-steer"),
			"release retained input",
		);
		await vi.waitFor(
			() =>
				expect(
					persisted(harness, sessionId).commands.find(
						(row) => row.command_id === steerId,
					)?.status,
				).toBe("completed"),
			{ timeout: 10_000 },
		);
		expect(
			proof(harness).filter(
				(mark) => mark["kind"] === "enqueue" && mark["prompt"] === steer,
			),
		).toHaveLength(1);
		expect(
			persisted(harness, sessionId).runs.some((row) =>
				["pending", "running"].includes(row.status),
			),
		).toBe(false);
	}, 60_000);
});

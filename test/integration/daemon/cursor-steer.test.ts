// Failure modes: a steer is delivered twice, declined text disappears, image
// steers reach the text-only SDK call, terminal/cancel races strand an input,
// a runner crash leaves Steering forever, or child waits block steering.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProcessHarness } from "../../helpers/process-harness.js";

interface TraceRow {
	kind?: string;
	data?: Record<string, unknown>;
	[key: string]: unknown;
}
interface StoredEvent {
	sequence: number;
	type: string;
	sessionId: string;
	data: Record<string, unknown>;
	metadata: Record<string, unknown>;
}
type Replay =
	| "delivered"
	| "delivered-error"
	| "shell"
	| "declined"
	| "images"
	| "missing-method"
	| "pending-terminal"
	| "landed-pending-terminal"
	| "pending-interrupt"
	| "pending-crash"
	| "identical-text"
	| "background";
const TIMEOUT = 120_000;
const TEXT = "After the tool, say STEER_SEEN_7931.";

function rows(path: string): TraceRow[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TraceRow);
}
function capture(name: string) {
	return rows(resolve(`test/fixtures/cursor-sdk-traces/${name}.jsonl`));
}
function snapshot(harness: ProcessHarness, id: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare<
					[],
					{
						sequence: number;
						type: string;
						session_id: string;
						data: string;
						metadata: string;
					}
				>(
					"SELECT sequence, type, session_id, data, metadata FROM events ORDER BY sequence",
				)
				.all()
				.map<StoredEvent>((row) => ({
					sequence: row.sequence,
					type: row.type,
					sessionId: row.session_id,
					data: JSON.parse(row.data) as Record<string, unknown>,
					metadata: JSON.parse(row.metadata) as Record<string, unknown>,
				})),
			inputs: db
				.prepare<[string], { input_id: string; state: string }>(
					"SELECT input_id, state FROM pending_inputs WHERE session_id = ? ORDER BY admitted_at, rowid",
				)
				.all(id),
			messages: db
				.prepare<
					[string],
					{
						id: string;
						input_id: string;
						turn_id: string | null;
						steered: number;
					}
				>(
					"SELECT id, input_id, turn_id, steered FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at, rowid",
				)
				.all(id),
			assistantMessages: db
				.prepare<
					[string],
					{ id: string; turn_id: string | null; parent_id: string | null }
				>(
					"SELECT id, turn_id, parent_id FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at, rowid",
				)
				.all(id),
			turns: db
				.prepare<
					[string],
					{ id: string; state: string; run_id: string | null }
				>(
					"SELECT id, state, run_id FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(id),
			commands: db
				.prepare<
					[string],
					{ command_id: string; status: string; attempt_count: number }
				>(
					"SELECT command_id, status, attempt_count FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(id),
			sessions: db
				.prepare<
					[],
					{
						id: string;
						parent_id: string | null;
						status: string;
						last_turn_end_input_id: string | null;
					}
				>("SELECT id, parent_id, status, last_turn_end_input_id FROM sessions")
				.all(),
		};
	} finally {
		db.close();
	}
}

// Only operation wrappers, native agent identity and public user-message/terminal
// fields are edited. README.md records the source and exact edits for each replay case.
function replay(kind: Replay): TraceRow[] {
	let trace = capture(kind === "shell" ? "steer-shell" : "steer");
	const steer = trace.find((row) => row.kind === "steer.call");
	const ack = trace.find((row) => row.kind === "steer.ack");
	if (!steer || !ack) throw new Error("Missing captured steer operations");
	const landed = (row: TraceRow) =>
		(row.kind === "delta" && row.data?.["type"] === "user-message-appended") ||
		(row.kind === "stream" && row.data?.["type"] === "user");
	if (kind === "identical-text") {
		// Both calls start before the first receipt. The duplicate user
		// channel cannot consume the second input's pending operation.
		trace.splice(trace.indexOf(steer) + 1, 0, structuredClone(steer));
	}
	if (kind === "background") {
		const native = trace.filter(landed);
		trace = capture("subagent-background-follow-up");
		const handle = trace.find((row) => row.kind === "run.handle");
		if (!handle?.data) throw new Error("Missing background run");
		handle.data["steer"] = "function";
		const task = trace.findIndex(
			(row) =>
				row.kind === "delta" &&
				row.data?.["type"] === "tool-call-completed" &&
				(row.data["toolCall"] as Record<string, unknown> | undefined)?.[
					"type"
				] === "task",
		);
		if (task < 0) throw new Error("Missing captured background Task");
		for (const row of native) {
			if (!row.data) continue;
			if (row.kind === "delta") {
				const message = row.data["userMessage"] as Record<string, unknown>;
				message["session_id"] = handle.data["agentId"];
			} else {
				row.data["agent_id"] = handle.data["agentId"];
				row.data["run_id"] = handle.data["id"];
			}
		}
		trace.splice(task + 1, 0, steer, ack, ...native);
	} else if (
		![
			"delivered",
			"delivered-error",
			"shell",
			"landed-pending-terminal",
			"identical-text",
		].includes(kind)
	) {
		trace = trace.filter((row) => !landed(row));
	}
	if (kind === "declined")
		ack.data = { ...ack.data, outcome: "revert_to_followup" };
	if (kind === "delivered-error") {
		const terminal = trace.find((row) => row.kind === "wait.result");
		if (!terminal?.data) throw new Error("Missing captured terminal");
		terminal.data = {
			...terminal.data,
			status: "error",
			error: {
				message: "The delivered steer run disconnected.",
				code: "connection_stalled",
			},
		};
	}
	if (
		["pending-terminal", "landed-pending-terminal", "pending-crash"].includes(
			kind,
		)
	)
		trace = trace.filter((row) => row.kind !== "steer.ack");
	if (kind === "pending-interrupt" || kind === "pending-crash") {
		const terminal = trace.find((row) => row.kind === "wait.result");
		if (!terminal?.data) throw new Error("Missing captured terminal");
		terminal.data["status"] = "cancelled";
		if (kind === "pending-interrupt") {
			// The late success races with cancellation. It cannot consume the
			// input after the pending steer has already been declined.
			trace = trace.filter((row) => row.kind !== "steer.ack");
			trace.splice(trace.indexOf(terminal) + 1, 0, ack);
		}
	}
	if (kind === "images" || kind === "missing-method") {
		trace = trace.filter(
			(row) => row.kind !== "steer.call" && row.kind !== "steer.ack",
		);
		if (kind === "missing-method") {
			const handle = trace.find((row) => row.kind === "run.handle");
			if (handle?.data) delete handle.data["steer"];
		}
	}
	if (
		![
			"delivered",
			"delivered-error",
			"shell",
			"landed-pending-terminal",
			"background",
		].includes(kind)
	) {
		const basic = capture("basic");
		const agentId = trace.find((row) => row.kind === "run.handle")?.data?.[
			"agentId"
		];
		if (typeof agentId !== "string") throw new Error("Missing resumed agent");
		const followup = basic.slice(
			basic.findIndex((row) => row.kind === "send.options"),
		);
		// This captured turn runs on the retained agent, whose identity must
		// agree with the stream's actual intake acknowledgement.
		for (const row of followup) {
			if (row.kind === "run.handle" && row.data) row.data["agentId"] = agentId;
			if (row.kind === "stream" && row.data) row.data["agent_id"] = agentId;
		}
		trace.push(...followup);
	}
	trace.splice(1, 0, {
		kind: "credential.store",
		data: {
			apiKey: "[REDACTED]",
			backendUrl: "https://api2.cursor.sh",
			createdAtMs: 0,
		},
	});
	if (!trace.some((row) => row.kind === "models.list")) {
		const catalog = capture("basic").find((row) => row.kind === "models.list");
		if (!catalog) throw new Error("Missing captured model catalogue");
		trace.splice(1, 0, catalog);
	}
	return trace;
}

describe("Cursor steering through the built daemon and detached runner", () => {
	let harness: ProcessHarness | undefined;
	let sessionId = "";
	let tracePath = "";
	let capturePath = "";
	let scenario: Replay | "late-start" = "delivered";
	let observations: Record<string, unknown> = {};
	const evidence: Record<string, unknown>[] = [];

	async function start(kind: Replay) {
		scenario = kind;
		observations = {};
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		tracePath = join(harness.root, "cursor-steer-replay.jsonl");
		capturePath = join(harness.root, "cursor-steer-capture.jsonl");
		writeFileSync(
			tracePath,
			`${replay(kind)
				.map((row) => JSON.stringify(row))
				.join("\n")}\n`,
		);
		await harness.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CURSOR_SDK_TRACE: tracePath,
				CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
				CONDUIT_TEST_CURSOR_DELTA_DELAY_MS: "2",
				CONDUIT_TEST_CURSOR_WAIT_DELAY_MS:
					kind === "images" || kind === "missing-method" ? "2000" : "0",
			},
		});
		const account = await harness.requestRpc({
			_tag: "AddInstance",
			name: "Cursor steer replay",
			driver: "cursor",
		});
		if (!account.addedInstanceId) throw new Error("Missing Cursor account");
		const browser = await harness.connect();
		sessionId = await browser.createSession(
			kind,
			account.addedInstanceId,
			"cursor",
			{
				modelId: "composer-2.5",
				contextWindow: "",
				permissionMode: "ask",
			},
		);
		const firstId = randomUUID();
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: firstId,
				delivery: "queue",
				text: "Replay the captured running turn.",
			}),
		);
		const fixture = harness;
		await vi.waitFor(
			() => {
				expect(rows(capturePath).some((row) => row.kind === "run.handle")).toBe(
					true,
				);
				expect(
					snapshot(fixture, sessionId).events.some(
						(event) =>
							event.sessionId === sessionId && event.type === "tool.started",
					),
				).toBe(true);
				expect(
					snapshot(fixture, sessionId).turns.map((row) => row.state),
				).toEqual(["running"]);
			},
			{ timeout: TIMEOUT },
		);
		return { fixture, browser, id: sessionId, firstId };
	}
	async function turns(fixture: ProcessHarness, id: string, states: string[]) {
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, id).turns.map((row) => row.state)).toEqual(
					states,
				),
			{ timeout: TIMEOUT },
		);
	}
	function oneMessage(fixture: ProcessHarness, id: string, inputId: string) {
		const state = snapshot(fixture, id);
		expect(
			state.messages.filter((row) => row.input_id === inputId),
		).toHaveLength(1);
		expect(
			state.inputs.some(
				(row) =>
					row.input_id === inputId &&
					["steering", "queued"].includes(row.state),
			),
		).toBe(false);
		return state;
	}
	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const state = existsSync(fixture.daemonStorePath())
			? snapshot(fixture, sessionId)
			: undefined;
		const captured = rows(capturePath);
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
			const runnerExitProof = fixture.runnerPids().map((pid) => {
				try {
					process.kill(pid, 0);
					return { pid, outcome: "alive" };
				} catch (cause) {
					return {
						pid,
						outcome:
							typeof cause === "object" && cause !== null && "code" in cause
								? String(cause.code)
								: "unknown",
					};
				}
			});
			observations["runnerExitProof"] = runnerExitProof;
			expect(runnerExitProof.every(({ outcome }) => outcome === "ESRCH")).toBe(
				true,
			);
		} finally {
			evidence.push({
				scenario,
				result: task.result?.state,
				errors: task.result?.errors?.map(({ message }) => message) ?? [],
				sourceCapture:
					scenario === "shell"
						? "steer-shell.jsonl"
						: scenario === "background"
							? "subagent-background-follow-up.jsonl + steer.jsonl"
							: "steer.jsonl",
				liveCaptureProof:
					scenario === "shell"
						? "SDK backgrounded an active shell on delivered steer"
						: scenario === "delivered"
							? "native delivered steer"
							: "derived replay, not live Cursor proof",
				observations,
				state,
				operations: captured.filter((row) =>
					[
						"send.options",
						"steer.call",
						"steer.ack",
						"wait.result",
						"cancel.call",
						"resume.options",
					].includes(row.kind ?? ""),
				),
				process: fixture.proof(),
				remainingRunnerPids: fixture.remainingRunnerPids(),
			});
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/conduit-test-xqsg.12.json",
				`${JSON.stringify({ ticket: "conduit-test-xqsg.12", scenarios: evidence }, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	it.each([
		"delivered",
		"shell",
		"landed-pending-terminal",
		"background",
	] as const)("delivers %s exactly once in the running turn", async (kind) => {
		const { fixture, browser, id } = await start(kind);
		if (kind === "background") {
			await vi.waitFor(
				() => {
					const state = snapshot(fixture, id);
					const child = state.sessions.find((row) => row.parent_id === id);
					expect(child?.status).toBe("busy");
					const taskPart = state.events.find(
						(event) =>
							event.type === "tool.started" &&
							event.sessionId === id &&
							event.data["toolName"] === "Task",
					)?.data["partId"];
					expect(taskPart).toBeTypeOf("string");
					expect(
						state.events.some(
							(event) =>
								event.type === "tool.completed" &&
								event.sessionId === id &&
								event.data["partId"] === taskPart,
						),
					).toBe(true);
				},
				{ timeout: TIMEOUT },
			);
		}
		const inputId = randomUUID();
		const text =
			kind === "shell"
				? "Also include STEER_SEEN_5523 in your final answer."
				: TEXT;
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId,
					delivery: "steer",
					text,
				}),
			),
		).toMatchObject({ ok: true });
		await turns(fixture, id, ["completed", "completed"]);
		const state = oneMessage(fixture, id, inputId);
		const steeredMessage = state.messages.find(
			(row) => row.input_id === inputId,
		);
		expect(steeredMessage?.steered).toBe(1);
		expect(
			state.assistantMessages.some(
				(message) =>
					message.parent_id === steeredMessage?.id &&
					message.turn_id === steeredMessage?.id,
			),
		).toBe(true);
		expect(
			rows(capturePath).filter((row) => row.kind === "steer.call"),
		).toHaveLength(1);
		expect(
			rows(capturePath).filter((row) => row.kind === "send.options"),
		).toHaveLength(1);
		expect(
			state.events.filter(
				(event) =>
					event.type === "input.requeued" && event.data["inputId"] === inputId,
			),
		).toHaveLength(0);
		if (kind === "shell") {
			const history = await browser.history(id);
			const tools = history
				.flatMap((message) => message.parts ?? [])
				.filter((part) => part.type === "tool");
			expect(
				tools.filter(
					(part) =>
						(part.state?.["metadata"] as Record<string, unknown> | undefined)?.[
							"movedToBackground"
						] === true,
				),
			).toHaveLength(1);
			expect(tools[0]?.state?.["metadata"]).toMatchObject({
				cursorToolType: "shell",
				movedToBackground: true,
			});
			observations["shellRows"] = tools;
		}
		observations["deliveredOnceInSameSdkRun"] = true;
	}, 240_000);

	it.each([
		"declined",
		"images",
		"missing-method",
		"pending-terminal",
	] as const)("requeues %s at the front and runs it once as the next turn", async (kind) => {
		const { fixture, browser, id } = await start(kind);
		const queuedId = randomUUID();
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId: queuedId,
					delivery: "queue",
					text: "Run after the recovered steer.",
				}),
			),
		).toMatchObject({ ok: true });
		const inputId = randomUUID();
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId,
					delivery: "steer",
					text: TEXT,
					...(kind === "images"
						? {
								images: [
									"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfZkAAAAASUVORK5CYII=",
								],
							}
						: {}),
				}),
			),
		).toMatchObject({ ok: true });
		await turns(fixture, id, ["completed", "completed", "completed"]);
		const state = oneMessage(fixture, id, inputId);
		expect(state.messages.map((row) => row.input_id).slice(1)).toEqual([
			inputId,
			queuedId,
		]);
		expect(
			state.commands
				.filter((command) => command.command_id === inputId)
				.map(({ status: commandStatus, attempt_count }) => ({
					status: commandStatus,
					attempt_count,
				})),
		).toEqual([
			{ status: "failed", attempt_count: 1 },
			{ status: "completed", attempt_count: 2 },
		]);
		expect(
			state.events.filter(
				(event) =>
					event.type === "input.requeued" && event.data["inputId"] === inputId,
			),
		).toHaveLength(1);
		expect(
			rows(capturePath).filter((row) => row.kind === "send.options"),
		).toHaveLength(3);
		expect(
			rows(capturePath).filter((row) => row.kind === "steer.call"),
		).toHaveLength(kind === "images" || kind === "missing-method" ? 0 : 1);
		observations["requeuedAheadOfExistingInput"] = true;
	}, 240_000);

	it("ends both accepted inputs on their shared run's error and attributes the error to the delivered input", async () => {
		const { fixture, browser, id, firstId } = await start("delivered-error");
		const inputId = randomUUID();
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId,
					delivery: "steer",
					text: TEXT,
				}),
			),
		).toMatchObject({ ok: true });
		await turns(fixture, id, ["error", "error"]);
		const state = oneMessage(fixture, id, inputId);
		const accepted = state.events.filter(
			(event) => event.type === "run.started" && event.sessionId === id,
		);
		expect(accepted.map((event) => event.data["inputId"])).toEqual([
			firstId,
			inputId,
		]);
		const runId = accepted[0]?.metadata["runId"];
		expect(runId).toEqual(expect.any(String));
		expect(accepted.map((event) => event.metadata["runId"])).toEqual([
			runId,
			runId,
		]);
		expect(state.turns.map((turn) => turn.run_id)).toEqual([runId, runId]);
		const terminals = state.events.filter(
			(event) =>
				event.sessionId === id &&
				["turn.completed", "turn.error", "turn.interrupted"].includes(
					event.type,
				),
		);
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({
			type: "turn.error",
			metadata: { runId },
		});
		const messageId = state.messages.find(
			(row) => row.input_id === inputId,
		)?.id;
		expect(state.assistantMessages).toContainEqual({
			id: terminals[0]?.data["messageId"],
			turn_id: messageId,
			parent_id: messageId,
		});
		expect(
			state.messages.find((row) => row.input_id === inputId)?.steered,
		).toBe(1);
		expect(
			state.events
				.filter(
					(event) => event.type === "turn.error" && event.sessionId === id,
				)
				.map((event) => event.data),
		).toEqual([
			expect.objectContaining({
				error:
					"The delivered steer run disconnected.\n\nYou can retry this turn.",
				code: "network_error",
				retryable: true,
			}),
		]);
		expect(
			state.sessions.find((session) => session.id === id)
				?.last_turn_end_input_id,
		).toBe(firstId);
		expect(
			state.events.filter(
				(event) =>
					event.type === "input.requeued" && event.data["inputId"] === inputId,
			),
		).toHaveLength(0);
		expect(
			rows(capturePath).filter((row) => row.kind === "send.options"),
		).toHaveLength(1);
		expect(
			rows(capturePath).filter((row) => row.kind === "steer.call"),
		).toHaveLength(1);
		observations["errorAttributedToLatestDeliveredSteer"] = true;
		observations["acceptedInputsShareOneTerminalError"] = true;
	}, 240_000);

	it("interrupts a pending steer before a late delivered acknowledgement without duplicating it", async () => {
		const { fixture, browser, id } = await start("pending-interrupt");
		const inputId = randomUUID();
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId,
					delivery: "steer",
					text: TEXT,
				}),
			),
		).toMatchObject({ ok: true });
		await vi.waitFor(
			() =>
				expect(
					rows(capturePath).filter((row) => row.kind === "steer.call"),
				).toHaveLength(1),
			{ timeout: TIMEOUT },
		);
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
		);
		await turns(fixture, id, ["interrupted"]);
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, id).inputs).toContainEqual({
					input_id: inputId,
					state: "queued",
				}),
			{ timeout: TIMEOUT },
		);
		const stopped = snapshot(fixture, id);
		expect(
			stopped.messages.filter((message) => message.input_id === inputId),
		).toHaveLength(0);
		expect(
			stopped.events.filter(
				(event) =>
					event.type === "input.requeued" && event.data["inputId"] === inputId,
			),
		).toHaveLength(1);
		expect(
			rows(capturePath).filter((row) => row.kind === "steer.ack"),
		).toHaveLength(1);
		expect(
			rows(capturePath).filter((row) => row.kind === "cancel.call"),
		).toHaveLength(1);
		expect(
			rows(capturePath).filter((row) => row.kind === "send.options"),
		).toHaveLength(1);
		// Stop pauses the inbox. Resuming the queued input is explicit, and
		// the late SDK receipt must not have consumed it while paused.
		await browser.sendNow(id, inputId);
		await turns(fixture, id, ["interrupted", "completed"]);
		oneMessage(fixture, id, inputId);
		expect(
			rows(capturePath).filter((row) => row.kind === "send.options"),
		).toHaveLength(2);
		observations["lateAcknowledgementDidNotDeliverTwice"] = true;
	}, 240_000);

	it("uses one delivered acknowledgement and its duplicate user channel for only the first identical-text steer", async () => {
		const { fixture, browser, id } = await start("identical-text");
		const firstSteerId = randomUUID();
		const secondSteerId = randomUUID();
		for (const inputId of [firstSteerId, secondSteerId]) {
			expect(
				await Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId: id,
						originId: browser.originId,
						inputId,
						delivery: "steer",
						text: TEXT,
					}),
				),
			).toMatchObject({ ok: true });
		}
		await turns(fixture, id, ["completed", "completed", "completed"]);
		const state = oneMessage(fixture, id, firstSteerId);
		oneMessage(fixture, id, secondSteerId);
		expect(
			state.messages.find((row) => row.input_id === firstSteerId)?.steered,
		).toBe(1);
		expect(
			state.messages.find((row) => row.input_id === secondSteerId)?.steered,
		).toBe(0);
		for (const inputId of [firstSteerId, secondSteerId]) {
			const messageId = state.messages.find(
				(row) => row.input_id === inputId,
			)?.id;
			expect(
				state.assistantMessages.some(
					(message) =>
						message.turn_id === messageId && message.parent_id === messageId,
				),
			).toBe(true);
		}
		expect(
			state.events
				.filter((event) => event.type === "input.requeued")
				.map((event) => event.data["inputId"]),
		).toEqual([secondSteerId]);
		expect(
			rows(capturePath).filter((row) => row.kind === "steer.call"),
		).toHaveLength(2);
		expect(
			rows(capturePath).filter((row) => row.kind === "steer.ack"),
		).toHaveLength(1);
		expect(
			rows(capturePath).filter((row) => row.kind === "send.options"),
		).toHaveLength(2);
		observations["identicalTextReceiptConsumedOnlyFirstSteer"] = true;
	}, 240_000);

	it("recovers a pending steer after its owned runner crashes and resumes it once", async () => {
		const { fixture, browser, id } = await start("pending-crash");
		const inputId = randomUUID();
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId,
					delivery: "steer",
					text: TEXT,
				}),
			),
		).toMatchObject({ ok: true });
		await vi.waitFor(
			() => {
				expect(
					rows(capturePath).filter((row) => row.kind === "steer.call"),
				).toHaveLength(1);
				expect(snapshot(fixture, id).inputs).toContainEqual({
					input_id: inputId,
					state: "steering",
				});
			},
			{ timeout: TIMEOUT },
		);
		const pids = fixture.runnerPids();
		expect(pids).toHaveLength(1);
		const pid = pids[0];
		if (!pid) throw new Error("Missing owned runner PID");
		process.kill(pid, "SIGKILL");
		await vi.waitFor(
			() => {
				const state = snapshot(fixture, id);
				expect(state.inputs).toContainEqual({
					input_id: inputId,
					state: "queued",
				});
				expect(state.turns.map((row) => row.state)).toEqual(["error"]);
			},
			{ timeout: TIMEOUT },
		);
		const basic = replay("missing-method");
		const firstSend = basic.findIndex((row) => row.kind === "send.options");
		const secondSend = basic.findIndex(
			(row, index) => index > firstSend && row.kind === "send.options",
		);
		writeFileSync(
			tracePath,
			`${[...basic.slice(0, firstSend), ...basic.slice(secondSend)].map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		await browser.sendNow(id, inputId);
		await turns(fixture, id, ["error", "completed"]);
		oneMessage(fixture, id, inputId);
		// The outbox row completes after sendTurn returns, just behind the turn row.
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture, id)
						.commands.filter((row) => row.command_id === inputId)
						.map((row) => row.status),
				).toEqual(["failed", "completed"]),
			{ timeout: TIMEOUT },
		);
		expect(fixture.runnerPids()).toHaveLength(2);
		observations["killedOwnedRunnerPid"] = pid;
		observations["recoveredOnceByInbox"] = true;
	}, 240_000);

	it("starts a steer submitted after the previous turn ended as its own turn", async () => {
		const { fixture, browser, id, firstId } = await start("missing-method");
		scenario = "late-start";
		await turns(fixture, id, ["completed"]);
		const inputId = randomUUID();
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: id,
					originId: browser.originId,
					inputId,
					delivery: "steer",
					text: "A later ordinary turn.",
				}),
			),
		).toMatchObject({ ok: true });
		await turns(fixture, id, ["completed", "completed"]);
		const state = oneMessage(fixture, id, inputId);
		expect(
			state.messages.find((message) => message.input_id === inputId)?.steered,
		).toBe(0);
		expect(
			state.messages.find((row) => row.input_id === inputId)?.turn_id,
		).not.toBe(state.messages.find((row) => row.input_id === firstId)?.turn_id);
		expect(
			rows(capturePath).filter((row) => row.kind === "steer.call"),
		).toHaveLength(0);
		expect(
			rows(capturePath).filter((row) => row.kind === "send.options"),
		).toHaveLength(2);
		observations["lateInputBecameItsOwnTurn"] = true;
	}, 240_000);
});

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDetailItemSchema } from "../../../src/lib/contracts/ws-rpc.js";
import { SessionInboxTag } from "../../../src/lib/domain/relay/Services/session-inbox.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { createProjectRelay } from "../../../src/lib/relay/relay-stack.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

function inbox(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.projectStorePath(), { readonly: true });
	try {
		return {
			session: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string },
			inputs: db
				.prepare(
					"SELECT input_id, state FROM pending_inputs WHERE session_id = ? ORDER BY admitted_at, rowid",
				)
				.all(sessionId) as Array<{ input_id: string; state: string }>,
			turns: db
				.prepare(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId) as Array<{ state: string }>,
			messages: db
				.prepare(
					"SELECT input_id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at, rowid",
				)
				.all(sessionId) as Array<{ input_id: string }>,
			commands: db
				.prepare(
					"SELECT command_id, status, attempt_count FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId) as Array<{
				command_id: string;
				status: string;
				attempt_count: number;
			}>,
			events: db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? AND (type LIKE 'input.%' OR type LIKE 'turn.%' OR type = 'session.status') ORDER BY sequence",
				)
				.all(sessionId) as Array<{ type: string; data: string }>,
		};
	} finally {
		db.close();
	}
}

// Failure modes: a dead runner leaves Steering forever, a synthetic failed
// message consumes the steer, the queue drains despite failure, or retry sends twice.
describe("Claude pending steer recovery through the process seam", () => {
	let harness: ProcessHarness | undefined;
	afterEach(async ({ task }) => {
		if (task.result?.errors?.length && harness) {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/conduit-test-xqsg-20-failure.log",
				harness.logTail,
			);
		}
		await harness?.dispose();
		harness = undefined;
	});
	it("keeps a pending steer owned by Claude after an interrupt", async () => {
		harness = await ProcessHarness.start({
			dist: "dist",
			claudeReplay: { turns: ["stop-with-steer-pending"], delayMs: 100 },
		});
		const running = harness;
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Interrupt pending steer");
		void browser.send(sessionId, "Alpha").catch(() => undefined);
		await vi.waitFor(
			() => {
				const db = new Database(running.projectStorePath(), { readonly: true });
				try {
					expect(
						db
							.prepare(
								"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'tool.started'",
							)
							.get(sessionId),
					).toMatchObject({ n: 1 });
				} finally {
					db.close();
				}
			},
			{ timeout: 10_000 },
		);
		const steerId = randomUUID();
		expect(
			(
				await Effect.runPromise(
					browser.rpc.input.submit({
						projectSlug: "process-test",
						sessionId,
						originId: browser.originId,
						inputId: steerId,
						delivery: "steer",
						text: "Bravo",
					}),
				)
			).ok,
		).toBe(true);
		const before = inbox(harness, sessionId);
		expect(before.inputs).toContainEqual({
			input_id: steerId,
			state: "steering",
		});
		await Effect.runPromise(
			browser.rpc.CancelSession({
				projectSlug: "process-test",
				sessionId,
				commandId: randomUUID(),
			}),
		);
		await vi.waitFor(
			() => {
				const state = inbox(running, sessionId);
				expect(state.session.status).toBe("idle");
				expect(
					state.messages.filter((message) => message.input_id === steerId),
				).toHaveLength(1);
				expect(state.turns.map((turn) => turn.state)).toEqual([
					"interrupted",
					"completed",
				]);
			},
			{ timeout: 15_000 },
		);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/conduit-test-xqsg-20-interrupt.json",
			JSON.stringify(
				{
					scenario: "captured Claude Stop with pending steer",
					before,
					after: inbox(harness, sessionId),
				},
				null,
				2,
			),
		);
	}, 45_000);

	it.each([
		"live",
		"adopted",
		"offline",
	] as const)("requeues a stranded steer with the server %s, pauses, and sends it exactly once", async (mode) => {
		harness = ProcessHarness.create({
			dist: "dist",
			restartProof: true,
			logLevel: "warn",
		});
		await harness.restart();
		const running = harness;
		let browser = await harness.connect();
		const sessionId = await browser.createSession("Stranded steer");
		void browser.send(sessionId, "upgrade-long-turn").catch(() => undefined);
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["role"] === "assistant" &&
				message["sessionId"] === sessionId,
		);
		const queuedId = randomUUID();
		const steerId = randomUUID();
		for (const [inputId, delivery, text] of [
			[queuedId, "queue", "later queued input"],
			[steerId, "steer", "correction after runner death"],
		] as const) {
			const result = await Effect.runPromise(
				browser.rpc.input.submit({
					projectSlug: "process-test",
					sessionId,
					originId: browser.originId,
					inputId,
					delivery,
					text,
				}),
			);
			expect(result.ok).toBe(true);
		}
		await vi.waitFor(() =>
			expect(inbox(running, sessionId).inputs).toContainEqual({
				input_id: steerId,
				state: "steering",
			}),
		);
		const before = inbox(harness, sessionId);
		await vi.waitFor(() =>
			expect(running.marks.some((mark) => mark.kind === "runner-started")).toBe(
				true,
			),
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner PID");
		if (mode !== "live") {
			await harness.signal("SIGINT");
			if (mode === "adopted") {
				await harness.restart();
				browser = await harness.connect(sessionId);
			}
		}
		process.kill(runner.pid, "SIGKILL");
		if (mode === "offline") {
			await harness.restart();
			browser = await harness.connect(sessionId);
		}
		await vi.waitFor(
			() => {
				const state = inbox(running, sessionId);
				expect(state.session.status).toBe("idle");
				expect(
					state.commands.every((command) => command.status === "failed"),
				).toBe(true);
			},
			{ timeout: 10_000 },
		);
		const after = inbox(harness, sessionId);
		expect(
			after.inputs
				.filter((input) => input.state === "queued")
				.map((input) => input.input_id),
		).toEqual([steerId, queuedId]);
		const details = () =>
			browser.frames.flatMap(({ message }) => {
				if (
					message["type"] !== "session_detail" ||
					message["sessionId"] !== sessionId
				)
					return [];
				const values =
					message["_tag"] === "snapshot" ? message["rows"] : [message["item"]];
				return Array.isArray(values)
					? values.flatMap((value: unknown) => {
							const decoded = Schema.decodeUnknownOption(
								SessionDetailItemSchema,
							)(value);
							return decoded._tag === "Some" ? [decoded.value] : [];
						})
					: [];
			});
		await vi.waitFor(() => {
			expect(details()).toContainEqual(
				expect.objectContaining({
					_tag: "pendingInput",
					input: expect.objectContaining({ inputId: steerId, state: "queued" }),
				}),
			);
			expect(
				details()
					.filter((row) => row._tag === "inbox")
					.at(-1),
			).toMatchObject({ inbox: { paused: true } });
		});
		// Leave only the recovered input, so exactly one requested turn can run.
		await Effect.runPromise(
			browser.rpc.input.cancel({
				projectSlug: "process-test",
				sessionId,
				inputId: queuedId,
			}),
		);
		await browser.sendNow(sessionId, steerId);
		const duplicate = await Effect.runPromise(
			browser.rpc.input.sendNow({
				projectSlug: "process-test",
				sessionId,
				originId: browser.originId,
				inputId: steerId,
			}),
		);
		expect(duplicate).toMatchObject({ ok: false, reason: "already_started" });
		await vi.waitFor(
			() => {
				const state = inbox(running, sessionId);
				expect(state.session.status).toBe("idle");
				expect(state.turns.map((turn) => turn.state)).toEqual([
					"error",
					"completed",
				]);
				expect(
					state.messages.filter((message) => message.input_id === steerId),
				).toHaveLength(1);
				expect(
					state.commands
						.filter((command) => command.command_id === steerId)
						.map((command) => command.status),
				).toEqual(["failed", "completed"]);
				expect(
					state.commands
						.filter((command) => command.command_id === steerId)
						.map((command) => command.attempt_count),
				).toEqual([1, 2]);
			},
			{ timeout: 15_000 },
		);
		const final = inbox(harness, sessionId);
		const states = (state: ReturnType<typeof inbox>) =>
			state.inputs
				.filter((input) => input.input_id === steerId)
				.map((input) => input.state);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/conduit-test-xqsg-20-steer-recovery-${mode}.json`,
			JSON.stringify(
				{
					scenario: `runner SIGKILL with pending steer, server ${mode}`,
					inboxStatesObserved: {
						before: states(before),
						recovered: states(after),
						sent: states(final),
					},
					sessionStatus: {
						before: before.session.status,
						recovered: after.session.status,
						final: final.session.status,
					},
					turnCount: {
						before: before.turns.length,
						recovered: after.turns.length,
						final: final.turns.length,
					},
					invariants: {
						queuedAtFront: true,
						paused: true,
						idleAfterFailure: true,
						duplicateSendRejected: true,
						deliveredUserMessages: 1,
						requestedTurns: 1,
						requeueEvents: final.events.filter(
							(event) => event.type === "input.requeued",
						).length,
					},
				},
				null,
				2,
			),
		);
	}, 90_000);
});

// Exercise the provider-facing operation through a real relay, store, projectors
// and pending-tray query. The handoff facts stand in for a provider's decline.
it("returns a declined steer to the front and ignores duplicate or obsolete recovery", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-declined-steer-"));
	const server = createServer();
	const relay = await createProjectRelay({
		httpServer: server,
		persistenceDbPath: join(root, "events.db"),
		projectDir: root,
		configDir: join(root, "config"),
		slug: "declined-steer",
		noServer: true,
		opencodeUrl: "http://127.0.0.1:1",
		publishGlobalSetting: () => Effect.void,
		log: createSilentLogger(),
	});
	try {
		const proof = await relay.effectRuntime.runtime.runPromise(
			Effect.gen(function* () {
				const persistService = yield* Effect.serviceOption(
					ClaudeEventPersistEffectTag,
				);
				const inboxService = yield* Effect.serviceOption(SessionInboxTag);
				if (persistService._tag === "None" || inboxService._tag === "None")
					return yield* Effect.die(
						new Error("Relay inbox or persistence service missing"),
					);
				const persist = persistService.value;
				const read = yield* ReadQueryEffectTag;
				const sessionInbox = inboxService.value;
				const sessionId = "declined-steer";
				const store = yield* EventStoreEffectTag;
				const projectors = yield* ProjectionRunnerEffectTag;
				const created = yield* store.append(
					canonicalEvent("session.created", sessionId, {
						sessionId,
						title: "Decline",
						provider: "claude",
					}),
				);
				yield* projectors.projectBatch([created]);
				yield* persist.persistEvents([
					canonicalEvent("session.status", sessionId, {
						sessionId,
						status: "busy",
					}),
					...(["older", "declined"] as const).map((inputId) =>
						canonicalEvent("input.admitted", sessionId, {
							sessionId,
							inputId,
							delivery: "queue",
							request: { text: inputId },
						}),
					),
					canonicalEvent("input.sent", sessionId, {
						sessionId,
						inputId: "declined",
						steer: true,
					}),
				]);
				const before = yield* read.readPendingInputs(sessionId, {
					through: Number.MAX_SAFE_INTEGER,
				});
				yield* sessionInbox.steerDeclined(sessionId, "declined");
				const declined = yield* read.readPendingInputs(sessionId, {
					through: Number.MAX_SAFE_INTEGER,
				});
				yield* sessionInbox.steerDeclined(sessionId, "declined");
				const duplicate = yield* read.readPendingInputs(sessionId, {
					through: Number.MAX_SAFE_INTEGER,
				});
				const db = new Database(join(root, "events.db"), { readonly: true });
				let requeued: { data: string };
				try {
					requeued = db
						.prepare("SELECT data FROM events WHERE type = 'input.requeued'")
						.get() as { data: string };
				} finally {
					db.close();
				}
				const data = JSON.parse(requeued.data) as {
					sessionId: string;
					inputId: string;
					sentSequence: number;
					reason: "declined";
				};
				yield* persist.persistEvent(
					canonicalEvent("input.requeued", sessionId, data),
				);
				const replayed = yield* read.readPendingInputs(sessionId, {
					through: Number.MAX_SAFE_INTEGER,
				});
				yield* persist.persistEvent(
					canonicalEvent("input.sent", sessionId, {
						sessionId,
						inputId: "declined",
						steer: true,
					}),
				);
				yield* persist.persistEvent(
					canonicalEvent("input.requeued", sessionId, data),
				);
				const obsolete = yield* read.readPendingInputs(sessionId, {
					through: Number.MAX_SAFE_INTEGER,
				});
				// A runner may die after the preceding turn completed. With no
				// failed turn row, the failed recovery itself must hold the queue.
				yield* persist.persistEvent(
					canonicalEvent(
						"session.resume_cancelled",
						sessionId,
						{},
						{ metadata: { source: "inbox-reset" } },
					),
				);
				const failedHandoff = new Database(join(root, "events.db"), {
					readonly: true,
				});
				let sentSequence: number;
				try {
					sentSequence = (
						failedHandoff
							.prepare(
								"SELECT MAX(sequence) AS sequence FROM events WHERE type = 'input.sent' AND json_extract(data, '$.inputId') = 'declined'",
							)
							.get() as { sequence: number }
					).sequence;
				} finally {
					failedHandoff.close();
				}
				const failedData = {
					sessionId,
					inputId: "declined",
					sentSequence,
					reason: "failed",
				} as const;
				yield* persist.persistEvent(
					canonicalEvent("input.requeued", sessionId, failedData),
				);
				const failedInbox = yield* read.readInboxState(sessionId);
				yield* persist.persistEvent(
					canonicalEvent("input.sent", sessionId, {
						sessionId,
						inputId: "older",
					}),
				);
				yield* persist.persistEvent(
					canonicalEvent("input.requeued", sessionId, failedData),
				);
				const duplicateFailure = yield* read.readInboxState(sessionId);
				yield* persist.persistUserMessage(sessionId, "declined", {
					messageId: "declined",
					inputId: "declined",
				});
				yield* sessionInbox.steerDeclined(sessionId, "declined");
				const placed = yield* read.readPendingInputs(sessionId, {
					through: Number.MAX_SAFE_INTEGER,
				});
				return {
					before,
					declined,
					duplicate,
					replayed,
					obsolete,
					placed,
					failedInbox,
					duplicateFailure,
				};
			}),
		);
		expect(proof.before.rows.map((row) => row.state)).toEqual([
			"queued",
			"steering",
		]);
		expect(proof.declined.rows.map((row) => [row.inputId, row.state])).toEqual([
			["declined", "queued"],
			["older", "queued"],
		]);
		expect(proof.duplicate).toEqual(proof.declined);
		expect(proof.replayed).toEqual(proof.declined);
		expect(
			proof.obsolete.rows.find((row) => row.inputId === "declined")?.state,
		).toBe("steering");
		expect(proof.placed.rows).toEqual([]);
		expect(proof.failedInbox?.paused).toBe(true);
		expect(proof.duplicateFailure?.paused).toBe(false);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/conduit-test-xqsg-20-decline.json",
			JSON.stringify(
				{
					scenario: "decline through the relay inbox operation",
					invariants: {
						frontOfQueue: true,
						duplicateOperationIdempotent: true,
						eventReplayIdempotent: true,
						obsoleteRecoveryIgnored: true,
						placedInputNeverRequeued: true,
						pausedWithoutFailedTurn: true,
						duplicateFailureDoesNotPauseNewHandoff: true,
					},
				},
				null,
				2,
			),
		);
	} finally {
		await relay.stop();
		rmSync(root, { recursive: true, force: true });
	}
}, 45_000);

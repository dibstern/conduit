import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { decodeClaudeSDKMessage } from "../../../../src/lib/contracts/providers/claude-agent-sdk.js";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { makeClaudeSessionRunner } from "../../../../src/lib/provider/claude/claude-provider-runtime.js";
import type { SDKMessage } from "../../../../src/lib/provider/claude/types.js";
import { EventSinkIngestionError } from "../../../../src/lib/provider/event-sink-errors.js";
import { isRecord } from "../../../../src/lib/utils.js";
import { makeTestClaudeProviderInstance } from "../../../helpers/claude-provider-instance.js";
import { makeEffectProjectionHarness } from "../../../helpers/effect-projection-harness.js";
import {
	createMockEventSink,
	createMockQuery,
	makeBaseSendTurnInput,
	makeErrorResult,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";
import { providerRuntimeEvent } from "../../../helpers/provider-runtime-event.js";

describe("Claude accepted run ownership", () => {
	it.each([
		false,
		true,
	])("retains captured background-result segments and accounting without reopening their ended run (queued input: %s)", async (queuedInput) => {
		const sessionId = "background-result-ownership";
		const inputId = "11111111-1111-4111-8111-111111111111";
		const runId = "background-result-run";
		const nextInputId = "22222222-2222-4222-8222-222222222222";
		const nextRunId = "queued-result-run";
		const firstResult = Deferred.makeUnsafe<void>();
		const queuedHandoff = Deferred.makeUnsafe<void>();
		const resumeBackground = Deferred.makeUnsafe<void>();
		const acceptNext = Deferred.makeUnsafe<void>();
		const messages = readFileSync(
			join(
				import.meta.dirname,
				"../../../fixtures/claude-sdk-traces/concurrent-background-work-turn.jsonl",
			),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => decodeClaudeSDKMessage(JSON.parse(line)) as SDKMessage);
		const harness = makeEffectProjectionHarness();
		const events: ProviderRuntimeEvent[] = [];
		const sink = createMockEventSink();
		sink.push = (event) =>
			Effect.tryPromise({
				try: async () => {
					await harness.ingest(event);
					events.push(event);
				},
				catch: (cause) => new EventSinkIngestionError({ cause }),
			});
		const instance = makeTestClaudeProviderInstance({
			subagentSdk: {
				listSubagents: async () => [],
				getSubagentMessages: async () => [],
			},
			queryFactory: ({ prompt }) => {
				if (typeof prompt === "string")
					throw new Error("Expected streaming input");
				const inputs = prompt[Symbol.asyncIterator]();
				return Object.assign(createMockQuery([]), {
					[Symbol.asyncIterator]: () =>
						(async function* (): AsyncGenerator<SDKMessage> {
							await inputs.next();
							yield {
								type: "command_lifecycle",
								state: "started",
								command_uuid: inputId,
								session_id: "captured-background-sdk",
								uuid: crypto.randomUUID(),
							};
							let results = 0;
							let nextPrompt: ReturnType<typeof inputs.next> | undefined;
							for (const message of messages) {
								yield message;
								if (
									queuedInput &&
									message.type === "result" &&
									++results === 1
								) {
									nextPrompt = inputs.next().then((value) => {
										Effect.runSync(Deferred.succeed(queuedHandoff, undefined));
										return value;
									});
									Effect.runSync(Deferred.succeed(firstResult, undefined));
									await Effect.runPromise(Deferred.await(resumeBackground));
								}
							}
							if (queuedInput) {
								await Effect.runPromise(Deferred.await(acceptNext));
								await nextPrompt;
								yield {
									type: "command_lifecycle",
									state: "started",
									command_uuid: nextInputId,
									session_id: "captured-background-sdk",
									uuid: crypto.randomUUID(),
								};
								yield makeSuccessResult({ user_message_uuid: nextInputId });
							}
						})(),
				});
			},
		});
		try {
			await harness.query(
				"INSERT INTO sessions (id, provider, title, created_at, updated_at) VALUES (?, 'claude', 'Background reply', 1, 1)",
				[sessionId],
			);
			await harness.query(
				"INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (?, ?, 'pending', 1)",
				[runId, sessionId],
			);
			await harness.ingest(
				providerRuntimeEvent(
					"message.created",
					sessionId,
					{ messageId: inputId, inputId, sessionId, role: "user" },
					{ runId },
				),
			);
			const send = (inputId: string, runId: string) =>
				Effect.runPromise(
					instance.sendTurnEffect(
						makeBaseSendTurnInput({
							sessionId,
							inputId,
							runId,
							eventSink: sink,
							model: { providerId: "claude", modelId: "claude-fable-5" },
						}),
					),
				);
			await send(inputId, runId);
			let next: ReturnType<typeof send> | undefined;
			if (queuedInput) {
				await Effect.runPromise(Deferred.await(firstResult));
				await harness.query(
					"INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (?, ?, 'pending', 2)",
					[nextRunId, sessionId],
				);
				await harness.query(
					"INSERT INTO command_receipts (command_id, session_id, status, command_type, project_key, created_at, updated_at) VALUES (?, ?, 'side_effect_requested', 'send_turn', 'test-project', 2, 2)",
					[nextInputId, sessionId],
				);
				await harness.query(
					"INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at) VALUES (1, ?, 'test-project', ?, 'claude', 'send_turn', ?, '{}', 'running', 1, 2, 2)",
					[nextInputId, sessionId, nextRunId],
				);
				next = send(nextInputId, nextRunId);
				void next.catch(() => undefined);
				await Effect.runPromise(Deferred.await(queuedHandoff));
				Effect.runSync(Deferred.succeed(resumeBackground, undefined));
			}
			await vi.waitFor(() =>
				expect(
					events.filter((event) => event.type === "turn.completed"),
				).toHaveLength(4),
			);
			const completions = events.filter(
				(
					event,
				): event is ProviderRuntimeEvent & { data: Record<string, unknown> } =>
					event.type === "turn.completed" && isRecord(event.data),
			);
			expect(completions.map((event) => event.data["contextTokens"])).toEqual([
				26827, 27383, 27940, 28393,
			]);
			expect(completions.map((event) => event.data["messageId"])).toEqual([
				"msg_011CfsViaBWMXumNpUgpmz6V",
				"msg_011CfsVk8dQemFquExeySJL5",
				"msg_011CfsVkWgxx9BEJXzuyJGmf",
				"msg_011CfsVmfX3tKRTyYnVs9sY1",
			]);
			expect(completions.map((event) => event.runId)).toEqual([
				runId,
				runId,
				runId,
				runId,
			]);
			expect(
				events.filter(
					(event) =>
						event.sessionId === sessionId &&
						event.type === "message.created" &&
						isRecord(event.data) &&
						event.data["role"] === "assistant",
				),
			).toHaveLength(4);
			for (const event of events.filter(
				(event) =>
					event.sessionId === sessionId &&
					event.type === "message.created" &&
					isRecord(event.data) &&
					event.data["role"] === "assistant",
			)) {
				expect(event.runId).toBe(runId);
				expect(event.data).toHaveProperty("parentID", inputId);
			}
			for (const event of events)
				if (
					event.sessionId === sessionId &&
					isRecord(event.data) &&
					"messageId" in event.data &&
					event.data["messageId"] !== nextInputId
				)
					expect(event.runId, event.type).toBe(runId);
			expect(
				await harness.query(
					"SELECT id, turn_id, context_tokens FROM messages WHERE session_id = ? AND role = 'assistant' AND context_tokens IS NOT NULL ORDER BY rowid",
					[sessionId],
				),
			).toEqual(
				completions.map((event) => ({
					id: event.data["messageId"],
					turn_id: inputId,
					context_tokens: event.data["contextTokens"],
				})),
			);
			const terminal = (await harness.storedEvents(sessionId)).find(
				(event) => event.type === "turn.completed",
			);
			expect(
				await harness.query(
					"SELECT status, completed_at FROM provider_runs WHERE id = ?",
					[runId],
				),
			).toEqual([{ status: "completed", completed_at: terminal?.createdAt }]);
			expect(
				await harness.query(
					"SELECT last_turn_end_version FROM sessions WHERE id = ?",
					[sessionId],
				),
			).toEqual([{ last_turn_end_version: terminal?.streamVersion }]);
			if (queuedInput) {
				expect(
					await harness.query(
						"SELECT status, started_at, joined_into FROM provider_runs WHERE id = ?",
						[nextRunId],
					),
				).toEqual([{ status: "pending", started_at: null, joined_into: null }]);
				expect(
					await harness.query(
						"SELECT status FROM command_receipts WHERE command_id = ?",
						[nextInputId],
					),
				).toEqual([{ status: "side_effect_requested" }]);
				Effect.runSync(Deferred.succeed(acceptNext, undefined));
				await next;
				await vi.waitFor(async () =>
					expect(
						await harness.query(
							"SELECT status, joined_into FROM provider_runs WHERE id = ?",
							[nextRunId],
						),
					).toEqual([{ status: "completed", joined_into: null }]),
				);
				expect(
					await harness.query(
						"SELECT status FROM command_receipts WHERE command_id = ?",
						[nextInputId],
					),
				).toEqual([{ status: "side_effect_completed" }]);
			}
		} finally {
			Effect.runSync(Deferred.succeed(resumeBackground, undefined));
			Effect.runSync(Deferred.succeed(acceptNext, undefined));
			await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
			await harness.dispose();
		}
	}, 20_000);
	it.each([
		{ lateStoppedResult: false, lateRejection: false },
		{ lateStoppedResult: true, lateRejection: false },
		{ lateStoppedResult: false, lateRejection: true },
	])("keeps a replacement out of the background run retired by Stop (late stopped result: $lateStoppedResult, late rejection: $lateRejection)", async ({
		lateStoppedResult,
		lateRejection,
	}) => {
		const harness = makeEffectProjectionHarness();
		const sessionId = "stop-retired-run";
		const inputs: [string, string] = [
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
		];
		const finish = Deferred.makeUnsafe<void>();
		const stoppedResult = Deferred.makeUnsafe<void>();
		const backgroundReady = Deferred.makeUnsafe<void>();
		const interruptAck = Deferred.makeUnsafe<undefined, Error>();
		const query = createMockQuery([]);
		if (lateRejection)
			query.interrupt = vi.fn(() =>
				Effect.runPromise(Deferred.await(interruptAck)),
			);
		const sink = createMockEventSink();
		sink.push = (event) =>
			Effect.tryPromise({
				try: () => harness.ingest(event),
				catch: (cause) => new EventSinkIngestionError({ cause }),
			}).pipe(Effect.asVoid);
		const instance = makeTestClaudeProviderInstance({
			queryFactory: ({ prompt }) => {
				if (typeof prompt === "string")
					throw new Error("Expected streaming input");
				const iterator = prompt[Symbol.asyncIterator]();
				return Object.assign(query, {
					[Symbol.asyncIterator]: () =>
						(async function* (): AsyncGenerator<SDKMessage> {
							for (const inputId of inputs) {
								await iterator.next();
								yield {
									type: "command_lifecycle",
									state: "started",
									command_uuid: inputId,
									session_id: "stop-retired-sdk",
									uuid: crypto.randomUUID(),
								};
								if (inputId === inputs[0]) {
									yield {
										type: "system",
										subtype: "background_tasks_changed",
										session_id: "stop-retired-sdk",
										uuid: crypto.randomUUID(),
										tasks: [
											{
												task_id: "monitor",
												task_type: "monitor_mcp",
												description: "Watch",
												ambient: false,
											},
										],
									};
									Effect.runSync(Deferred.succeed(backgroundReady, undefined));
								}
							}
							if (lateStoppedResult) {
								await Effect.runPromise(Deferred.await(stoppedResult));
								yield makeErrorResult({ user_message_uuid: inputs[0] });
							}
							await Effect.runPromise(Deferred.await(finish));
							yield makeSuccessResult({ user_message_uuid: inputs[1] });
						})(),
				});
			},
		});
		const send = (index: 0 | 1) =>
			Effect.runPromise(
				instance.sendTurnEffect(
					makeBaseSendTurnInput({
						sessionId,
						inputId: inputs[index],
						runId: `run-${index}`,
						eventSink: sink,
						model: { providerId: "claude", modelId: "claude-fable-5" },
					}),
				),
			);
		try {
			await harness.query(
				"INSERT INTO sessions (id, provider, title, created_at, updated_at) VALUES (?, 'claude', 'Stop retirement', 1, 1)",
				[sessionId],
			);
			for (const [index, inputId] of inputs.entries()) {
				await harness.query(
					"INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (?, ?, 'pending', ?)",
					[`run-${index}`, sessionId, index + 1],
				);
				await harness.ingest(
					providerRuntimeEvent(
						"message.created",
						sessionId,
						{ messageId: inputId, sessionId, role: "user" },
						{ eventId: `placement-${index}`, runId: `run-${index}` },
					),
				);
				await harness.query(
					"INSERT INTO command_receipts (command_id, session_id, status, command_type, project_key, created_at, updated_at) VALUES (?, ?, 'side_effect_requested', 'send_turn', 'test-project', 1, 1)",
					[inputId, sessionId],
				);
				await harness.query(
					"INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at) VALUES (?, ?, 'test-project', ?, 'claude', 'send_turn', ?, '{}', 'running', 1, 1, 1)",
					[index + 1, inputId, sessionId, `run-${index}`],
				);
			}
			expect((await send(0)).status).toBe("accepted");
			await Effect.runPromise(Deferred.await(backgroundReady));
			// A live monitor keeps the query open. The interrupt is acknowledged,
			// but no SDK result arrives before Stop's bound retires this cohort.
			const stopping = Effect.runPromise(
				instance
					.interruptTurnEffect(sessionId, [inputs[0]])
					.pipe(Effect.result),
			);
			await vi.waitFor(() => expect(query.interrupt).toHaveBeenCalledOnce());
			if (!lateRejection) expect((await stopping)._tag).toBe("Success");
			expect(query.close).not.toHaveBeenCalled();
			await harness.ingest(
				providerRuntimeEvent(
					"turn.interrupted",
					sessionId,
					{ messageId: "", reason: "Stopped by the user" },
					{ runId: "run-0" },
				),
			);
			if (lateRejection) {
				Effect.runSync(
					Deferred.fail(
						interruptAck,
						new Error("Interrupt rejected after retirement"),
					),
				);
				expect((await stopping)._tag).toBe("Failure");
			}
			expect((await send(1)).status).toBe("accepted");
			expect(
				await harness.query(
					"SELECT id, status, joined_into FROM provider_runs ORDER BY requested_at",
				),
			).toEqual([
				{ id: "run-0", status: "interrupted", joined_into: null },
				{ id: "run-1", status: "running", joined_into: null },
			]);
			expect(
				await harness.query(
					"SELECT state, run_id FROM turns ORDER BY requested_at, rowid",
				),
			).toEqual([
				{ state: "interrupted", run_id: "run-0" },
				{ state: "running", run_id: "run-1" },
			]);
			if (lateStoppedResult) {
				Effect.runSync(Deferred.succeed(stoppedResult, undefined));
				await vi.waitFor(async () =>
					expect(
						(await harness.storedEvents(sessionId)).filter(
							(event) =>
								event.type === "turn.interrupted" &&
								event.metadata?.["runId"] === "run-0",
						),
					).toHaveLength(2),
				);
				expect(
					await harness.query(
						"SELECT status FROM provider_runs ORDER BY requested_at",
					),
				).toEqual([{ status: "interrupted" }, { status: "running" }]);
			}
			Effect.runSync(Deferred.succeed(finish, undefined));
			await vi.waitFor(async () =>
				expect(
					await harness.query(
						"SELECT status FROM command_receipts ORDER BY rowid",
					),
				).toEqual([
					{ status: "side_effect_failed" },
					{ status: "side_effect_completed" },
				]),
			);
			expect(
				await harness.query(
					"SELECT status FROM provider_runs ORDER BY requested_at",
				),
			).toEqual([{ status: "interrupted" }, { status: "completed" }]);
			expect(
				await harness.query(
					"SELECT state, run_id FROM turns ORDER BY requested_at, rowid",
				),
			).toEqual([
				{ state: "interrupted", run_id: "run-0" },
				{ state: "completed", run_id: "run-1" },
			]);
			expect(
				await harness.query(
					"SELECT status FROM provider_command_outbox ORDER BY request_sequence",
				),
			).toEqual([{ status: "failed" }, { status: "completed" }]);
			expect(
				(await harness.storedEvents(sessionId))
					.filter((event) => event.type === "turn.completed")
					.map((event) => event.metadata?.["runId"]),
			).toEqual(["run-1"]);
		} finally {
			Effect.runSync(Deferred.succeed(interruptAck, undefined));
			Effect.runSync(Deferred.succeed(stoppedResult, undefined));
			Effect.runSync(Deferred.succeed(finish, undefined));
			await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
			await harness.dispose();
		}
	});

	it.each(
		[
			{
				subtype: "success",
				makeResult: makeSuccessResult,
				status: "completed",
				commandStatus: "completed",
				receiptStatus: "side_effect_completed",
				limited: false,
			},
			{
				subtype: "error_during_execution",
				makeResult: makeErrorResult,
				status: "error",
				commandStatus: "failed",
				receiptStatus: "side_effect_failed",
				limited: false,
			},
			{
				subtype: "blocking_limit",
				makeResult: (overrides: Parameters<typeof makeSuccessResult>[0]) =>
					makeSuccessResult({
						...overrides,
						terminal_reason: "blocking_limit",
						is_error: true,
						result: "Pending input reached its limit",
					}),
				status: "completed",
				commandStatus: "completed",
				receiptStatus: "side_effect_completed",
				limited: true,
			},
		].flatMap((testCase) =>
			[false, true].flatMap((activeFirst) =>
				[false, true].map((cohort) => ({ ...testCase, activeFirst, cohort })),
			),
		),
	)("settles an exact $subtype result before intake without inventing acceptance (active run: $activeFirst, cohort: $cohort)", async ({
		makeResult,
		status,
		commandStatus,
		receiptStatus,
		activeFirst,
		cohort,
		limited,
	}) => {
		const harness = makeEffectProjectionHarness();
		const sessionId = "pre-intake-result-session";
		const inputId = "11111111-1111-4111-8111-111111111111";
		const runId = "pre-intake-result-run";
		const activeInputId = "22222222-2222-4222-8222-222222222222";
		const activeRunId = "still-active-run";
		const finishActive = Deferred.makeUnsafe<void>();
		const assistantId = crypto.randomUUID();
		const sink = createMockEventSink();
		sink.push = (event) =>
			Effect.tryPromise({
				try: () => harness.ingest(event),
				catch: (cause) => new EventSinkIngestionError({ cause }),
			}).pipe(Effect.asVoid);
		const instance = makeTestClaudeProviderInstance({
			queryFactory: ({ prompt }) => {
				if (typeof prompt === "string")
					throw new Error("Expected streaming input");
				const inputs = prompt[Symbol.asyncIterator]();
				return Object.assign(createMockQuery([]), {
					[Symbol.asyncIterator]: () =>
						(async function* () {
							await inputs.next();
							if (activeFirst) {
								yield {
									type: "command_lifecycle",
									command_uuid: activeInputId,
									state: "started",
									session_id: "sdk-session-1",
									uuid: crypto.randomUUID(),
								};
							}
							if (limited && activeFirst && !cohort) {
								for (const event of [
									{
										type: "message_start",
										message: {
											id: assistantId,
											role: "assistant",
											model: "claude-fable-5",
											content: [],
										},
									},
									{
										type: "content_block_start",
										index: 0,
										content_block: { type: "text", text: "Before B limit" },
									},
								])
									yield decodeClaudeSDKMessage({
										type: "stream_event",
										event,
										session_id: "sdk-session-1",
										uuid: crypto.randomUUID(),
										parent_tool_use_id: null,
									});
							}
							if (activeFirst || cohort) await inputs.next();
							yield makeResult({
								user_message_uuid: inputId,
								...(cohort
									? { user_message_uuids: [activeInputId, inputId] }
									: {}),
								uuid: crypto.randomUUID(),
							});
							if (limited && activeFirst && !cohort)
								yield decodeClaudeSDKMessage({
									type: "stream_event",
									event: {
										type: "content_block_delta",
										index: 0,
										delta: { type: "text_delta", text: "After B limit" },
									},
									session_id: "sdk-session-1",
									uuid: crypto.randomUUID(),
									parent_tool_use_id: null,
								});
							if (cohort) await Effect.runPromise(Deferred.await(finishActive));
							if (activeFirst && !cohort) {
								await Effect.runPromise(Deferred.await(finishActive));
								yield makeSuccessResult({
									user_message_uuid: activeInputId,
									uuid: crypto.randomUUID(),
								});
							}
						})(),
				});
			},
		});
		const send = (inputId: string, runId: string) =>
			Effect.runPromise(
				instance.sendTurnEffect(
					makeBaseSendTurnInput({
						sessionId,
						inputId,
						runId,
						eventSink: sink,
						model: { providerId: "claude", modelId: "claude-fable-5" },
					}),
				),
			);
		try {
			await harness.query(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, 'claude', 'Pre-intake result', 'idle', 1, 1)",
				[sessionId],
			);
			await harness.query(
				"INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (?, ?, 'pending', 1)",
				[runId, sessionId],
			);
			await harness.ingest(
				providerRuntimeEvent(
					"message.created",
					sessionId,
					{ messageId: inputId, sessionId, role: "user" },
					{ runId },
				),
			);
			await harness.query(
				"INSERT INTO command_receipts (command_id, session_id, status, command_type, project_key, created_at, updated_at) VALUES ('command', ?, 'side_effect_requested', 'send_turn', 'test-project', 1, 1)",
				[sessionId],
			);
			await harness.query(
				"INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at) VALUES (2, 'command', 'test-project', ?, 'claude', 'send_turn', ?, '{}', 'running', 1, 1, 1)",
				[sessionId, runId],
			);
			let otherSend: ReturnType<typeof send> | undefined;
			if (activeFirst || cohort) {
				await harness.query(
					"INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (?, ?, 'pending', 1)",
					[activeRunId, sessionId],
				);
				await harness.ingest(
					providerRuntimeEvent(
						"message.created",
						sessionId,
						{ messageId: activeInputId, sessionId, role: "user" },
						{ eventId: "active-user-placement", runId: activeRunId },
					),
				);
				await harness.query(
					"INSERT INTO command_receipts (command_id, session_id, status, command_type, project_key, created_at, updated_at) VALUES ('other-command', ?, 'side_effect_requested', 'send_turn', 'test-project', 1, 1)",
					[sessionId],
				);
				await harness.query(
					"INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at) VALUES (1, 'other-command', 'test-project', ?, 'claude', 'send_turn', ?, '{}', 'running', 1, 1, 1)",
					[sessionId, activeRunId],
				);
				otherSend = send(activeInputId, activeRunId);
				if (activeFirst) expect((await otherSend).status).toBe("accepted");
			}
			expect((await send(inputId, runId)).status).toBe(status);
			expect(
				await harness.query(
					"SELECT status, started_at FROM provider_runs WHERE id = ?",
					[runId],
				),
			).toEqual([{ status, started_at: null }]);
			expect(
				await harness.query(
					"SELECT state, started_at, run_id FROM turns WHERE id = ?",
					[inputId],
				),
			).toEqual([{ state: status, started_at: null, run_id: runId }]);
			expect(
				await harness.query(
					"SELECT status FROM provider_command_outbox WHERE command_id = 'command'",
				),
			).toEqual([{ status: commandStatus }]);
			expect(
				await harness.query(
					"SELECT status FROM command_receipts WHERE command_id = 'command'",
				),
			).toEqual([{ status: receiptStatus }]);
			const events = await harness.storedEvents(sessionId);
			expect(
				events.filter(
					(event) =>
						event.type === "run.started" && event.metadata?.["runId"] === runId,
				),
			).toEqual([]);
			expect(
				events
					.filter(
						(event) =>
							event.type ===
							`turn.${status === "completed" ? "completed" : "error"}`,
					)
					.map((event) => event.metadata?.["runId"]),
			).toEqual(cohort ? [activeRunId, runId] : [runId]);
			expect(
				events.filter(
					(event) =>
						event.type === "turn.completed" && event.data.tokens !== undefined,
				),
			).toHaveLength(status === "completed" ? 1 : 0);
			expect(
				events.filter(
					(event) => event.type === "text.delta" && event.data.text === "Done",
				),
			).toHaveLength(status === "completed" && !limited ? 1 : 0);
			if (status === "completed")
				expect(
					await harness.query(
						"SELECT SUM(cost) AS cost, SUM(tokens_in) AS input, SUM(tokens_out) AS output FROM turns WHERE session_id = ?",
						[sessionId],
					),
				).toEqual([{ cost: 0.05, input: 100, output: 50 }]);
			if (cohort) {
				if (!activeFirst) expect((await otherSend)?.status).toBe(status);
				expect(
					await harness.query(
						"SELECT status, started_at FROM provider_runs WHERE id = ?",
						[activeRunId],
					),
				).toEqual([
					{ status, started_at: activeFirst ? expect.any(Number) : null },
				]);
				expect(
					await harness.query(
						"SELECT status FROM provider_command_outbox WHERE command_id = 'other-command'",
					),
				).toEqual([{ status: commandStatus }]);
				expect(
					await harness.query(
						"SELECT status FROM command_receipts WHERE command_id = 'other-command'",
					),
				).toEqual([{ status: receiptStatus }]);
			}
			if (activeFirst && !cohort) {
				if (limited) {
					await vi.waitFor(async () =>
						expect(
							(await harness.storedEvents(sessionId))
								.filter((event) => event.type === "text.delta")
								.map((event) => event.data.text),
						).toEqual(["Before B limit", "After B limit"]),
					);
					expect(
						(await harness.storedEvents(sessionId))
							.filter((event) => event.type === "session.usage_limited")
							.map((event) => event.data.cutOffMessageId),
					).toEqual([inputId]);
				}
				expect(
					await harness.query("SELECT status FROM provider_runs WHERE id = ?", [
						activeRunId,
					]),
				).toEqual([{ status: "running" }]);
				Effect.runSync(Deferred.succeed(finishActive, undefined));
				await vi.waitFor(async () =>
					expect(
						await harness.query(
							"SELECT status FROM provider_runs WHERE id = ?",
							[activeRunId],
						),
					).toEqual([{ status: "completed" }]),
				);
			}
		} finally {
			Effect.runSync(Deferred.succeed(finishActive, undefined));
			await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
			await harness.dispose();
		}
	});

	it("recalls an already-aborted input before creating a native query", async () => {
		const queryFactory = vi.fn(() => createMockQuery([]));
		const instance = makeTestClaudeProviderInstance({
			queryFactory,
		});
		const controller = new AbortController();
		controller.abort();
		const sink = createMockEventSink();
		const result = await Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					inputId: "11111111-1111-4111-8111-111111111111",
					runId: "pre-aborted-run",
					abortSignal: controller.signal,
					eventSink: sink,
					model: { providerId: "claude", modelId: "claude-fable-5" },
				}),
			),
		);
		expect(result.status).toBe("cancelled");
		expect(queryFactory).not.toHaveBeenCalled();
		expect(sink.push).not.toHaveBeenCalled();
	});

	it("keeps an SDK-handed input reserved until its real start after the previous run ends", async () => {
		const harness = makeEffectProjectionHarness();
		const sessionId = "queued-handoff-session";
		const ids = [
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
		] as const;
		const runs = ["queued-handoff-a", "queued-handoff-b"] as const;
		const finishFirst = Deferred.makeUnsafe<void>();
		const startSecond = Deferred.makeUnsafe<void>();
		let handed = false;
		const sink = createMockEventSink();
		sink.push = (event) =>
			Effect.tryPromise({
				try: () => harness.ingest(event),
				catch: (cause) => new EventSinkIngestionError({ cause }),
			}).pipe(Effect.asVoid);
		const instance = makeTestClaudeProviderInstance({
			queryFactory: ({ prompt }) => {
				if (typeof prompt === "string")
					throw new Error("Expected streaming input");
				const inputs = prompt[Symbol.asyncIterator]();
				return Object.assign(createMockQuery([]), {
					[Symbol.asyncIterator]: () =>
						(async function* (): AsyncGenerator<SDKMessage> {
							await inputs.next();
							yield {
								type: "command_lifecycle",
								command_uuid: ids[0],
								state: "started",
								session_id: "queued-handoff-sdk",
								uuid: crypto.randomUUID(),
							};
							await inputs.next();
							handed = true;
							await Effect.runPromise(Deferred.await(finishFirst));
							yield makeSuccessResult({
								session_id: "queued-handoff-sdk",
								user_message_uuid: ids[0],
							});
							await Effect.runPromise(Deferred.await(startSecond));
							yield {
								type: "command_lifecycle",
								command_uuid: ids[1],
								state: "started",
								session_id: "queued-handoff-sdk",
								uuid: crypto.randomUUID(),
							};
							yield makeSuccessResult({
								session_id: "queued-handoff-sdk",
								user_message_uuid: ids[1],
							});
						})(),
				});
			},
		});
		const controller = new AbortController();
		const send = (index: 0 | 1) =>
			Effect.runPromise(
				instance.sendTurnEffect(
					makeBaseSendTurnInput({
						sessionId,
						inputId: ids[index],
						runId: runs[index],
						eventSink: sink,
						model: { providerId: "claude", modelId: "claude-fable-5" },
						...(index === 1 ? { abortSignal: controller.signal } : {}),
					}),
				),
			);
		const states = () =>
			harness.query<{
				id: string;
				status: string;
				started_at: number | null;
				joined_into: string | null;
			}>(
				"SELECT id, status, started_at, joined_into FROM provider_runs WHERE session_id = ? ORDER BY id",
				[sessionId],
			);
		try {
			await harness.query(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, 'claude', 'Queued handoff', 'idle', 1, 1)",
				[sessionId],
			);
			for (const index of [0, 1] as const) {
				await harness.query(
					"INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (?, ?, 'pending', 1)",
					[runs[index], sessionId],
				);
				await harness.ingest(
					providerRuntimeEvent(
						"message.created",
						sessionId,
						{ messageId: ids[index], sessionId, role: "user" },
						{ eventId: `placed-${index}`, runId: runs[index] },
					),
				);
			}
			expect((await send(0)).status).toBe("accepted");
			const second = send(1);
			await vi.waitFor(() => expect(handed).toBe(true));
			controller.abort();
			expect((await second).status).toBe("indeterminate");
			expect((await states())[1]).toMatchObject({
				status: "pending",
				started_at: null,
				joined_into: null,
			});
			await harness.ingest(
				providerRuntimeEvent(
					"turn.notice",
					sessionId,
					{
						text: "No response for 2 minutes. The model may be unavailable or your usage quota may be used up. Stop this turn to try a different model.",
					},
					{ eventId: "handoff-silence-notice", runId: runs[0] },
				),
			);
			expect((await states()).map(({ status }) => status)).toEqual([
				"running",
				"pending",
			]);
			Effect.runSync(Deferred.succeed(finishFirst, undefined));
			await vi.waitFor(async () =>
				expect((await states()).map(({ status }) => status)).toEqual([
					"completed",
					"pending",
				]),
			);
			expect(
				await harness.query(
					"SELECT state, started_at FROM turns WHERE id = ?",
					[ids[1]],
				),
			).toEqual([{ state: "pending", started_at: null }]);
			Effect.runSync(Deferred.succeed(startSecond, undefined));
			await vi.waitFor(async () =>
				expect((await states()).map(({ status }) => status)).toEqual([
					"completed",
					"completed",
				]),
			);
			expect((await states())[1]).toMatchObject({
				joined_into: null,
				started_at: expect.any(Number),
			});
			expect(
				await harness.query("SELECT state, run_id FROM turns WHERE id = ?", [
					ids[1],
				]),
			).toEqual([{ state: "completed", run_id: runs[1] }]);
		} finally {
			Effect.runSync(Deferred.succeed(finishFirst, undefined));
			Effect.runSync(Deferred.succeed(startSecond, undefined));
			await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
			await harness.dispose();
		}
	});

	it("allows retuning after pre-intake cancellation on a query that stays open", async () => {
		const ids = [
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
		] as const;
		const finish = Effect.runSync(Deferred.make<void>());
		const events: ProviderRuntimeEvent[] = [];
		const sink = createMockEventSink();
		sink.push = (event) =>
			Effect.sync(() => {
				events.push(event);
			});
		const instance = makeTestClaudeProviderInstance({
			queryFactory: ({ prompt }) => {
				if (typeof prompt === "string")
					throw new Error("Expected streaming input");
				const inputs = prompt[Symbol.asyncIterator]();
				return Object.assign(createMockQuery([]), {
					[Symbol.asyncIterator]: () =>
						(async function* () {
							await inputs.next();
							yield {
								type: "command_lifecycle",
								command_uuid: ids[0],
								state: "cancelled",
								session_id: "cancel-sdk",
								uuid: crypto.randomUUID(),
							};
							await inputs.next();
							yield {
								type: "command_lifecycle",
								command_uuid: ids[1],
								state: "started",
								session_id: "cancel-sdk",
								uuid: crypto.randomUUID(),
							};
							await Effect.runPromise(Deferred.await(finish));
							yield makeSuccessResult({
								session_id: "cancel-sdk",
								user_message_uuid: ids[1],
							});
						})(),
				});
			},
		});
		const send = (inputId: string, runId: string, modelId: string) =>
			Effect.runPromise(
				instance.sendTurnEffect(
					makeBaseSendTurnInput({
						sessionId: "cancel-session",
						inputId,
						runId,
						eventSink: sink,
						model: { providerId: "claude", modelId },
					}),
				),
			);
		expect((await send(ids[0], "cancel-run", "claude-fable-5")).status).toBe(
			"cancelled",
		);
		expect(
			events
				.filter((event) => event.type === "turn.interrupted")
				.map((event) => event.runId),
		).toEqual(["cancel-run"]);
		expect(events.filter((event) => event.type === "run.started")).toHaveLength(
			0,
		);
		const replies: string[] = [];
		const second = send(ids[1], "next-run", "claude-fable-6").then((reply) => {
			replies.push(reply.status);
		});
		try {
			await vi.waitFor(() => expect(replies).toEqual(["accepted"]));
			Effect.runSync(Deferred.succeed(finish, undefined));
			await vi.waitFor(() =>
				expect(
					events
						.filter((event) => event.type === "turn.completed")
						.map((event) => event.runId),
				).toEqual(["next-run"]),
			);
		} finally {
			Effect.runSync(Deferred.succeed(finish, undefined));
			await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
			await second.catch(() => undefined);
		}
	});

	it("retires before reporting native idle when terminal persistence fails after intake", async () => {
		const finish = Effect.runSync(Deferred.make<void>());
		const inputId = "11111111-1111-4111-8111-111111111111";
		const lifecycle: string[] = [];
		const sink = createMockEventSink();
		sink.push = (event) =>
			event.type === "turn.completed" || event.type === "turn.error"
				? Effect.fail(
						new EventSinkIngestionError({
							cause: new Error("terminal ingestion failed"),
						}),
					)
				: Effect.void;
		const instance = makeTestClaudeProviderInstance({
			runnerFactory: (deps, emit) =>
				makeClaudeSessionRunner(
					{
						...deps,
						onAbandonedRun: (id) => {
							lifecycle.push(`retire:${id}`);
						},
						onTurnStateChanged: (_sessionId, busy) => {
							lifecycle.push(busy ? "busy" : "idle");
						},
					},
					emit,
				),
			queryFactory: () =>
				Object.assign(createMockQuery([]), {
					[Symbol.asyncIterator]: () =>
						(async function* () {
							yield {
								type: "command_lifecycle",
								command_uuid: inputId,
								state: "started",
								session_id: "failure-sdk",
								uuid: crypto.randomUUID(),
							};
							await Effect.runPromise(Deferred.await(finish));
							yield makeSuccessResult({
								session_id: "failure-sdk",
								user_message_uuid: inputId,
							});
						})(),
				}),
		});
		try {
			expect(
				(
					await Effect.runPromise(
						instance.sendTurnEffect(
							makeBaseSendTurnInput({
								sessionId: "failure-session",
								inputId,
								runId: "failure-run",
								eventSink: sink,
								model: { providerId: "claude", modelId: "claude-fable-5" },
							}),
						),
					)
				).status,
			).toBe("accepted");
			Effect.runSync(Deferred.succeed(finish, undefined));
			await vi.waitFor(() =>
				expect(lifecycle.slice(-2)).toEqual([`retire:${inputId}`, "idle"]),
			);
		} finally {
			Effect.runSync(Deferred.succeed(finish, undefined));
			await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
		}
	});

	it("publishes an owned terminal when an accepted stream ends without a result", async () => {
		const end = Effect.runSync(Deferred.make<void>());
		const inputId = "11111111-1111-4111-8111-111111111111";
		const events: ProviderRuntimeEvent[] = [];
		const sink = createMockEventSink();
		sink.push = (event) =>
			Effect.sync(() => {
				events.push(event);
			});
		const instance = makeTestClaudeProviderInstance({
			queryFactory: () =>
				Object.assign(createMockQuery([]), {
					[Symbol.asyncIterator]: () =>
						(async function* () {
							yield {
								type: "command_lifecycle",
								command_uuid: inputId,
								state: "started",
								session_id: "eof-sdk",
								uuid: crypto.randomUUID(),
							};
							await Effect.runPromise(Deferred.await(end));
						})(),
				}),
		});
		try {
			expect(
				(
					await Effect.runPromise(
						instance.sendTurnEffect(
							makeBaseSendTurnInput({
								sessionId: "eof-session",
								inputId,
								runId: "eof-run",
								eventSink: sink,
								model: { providerId: "claude", modelId: "claude-fable-5" },
							}),
						),
					)
				).status,
			).toBe("accepted");
			Effect.runSync(Deferred.succeed(end, undefined));
			await vi.waitFor(() =>
				expect(events.filter((event) => event.type === "turn.error")).toEqual([
					expect.objectContaining({
						runId: "eof-run",
						data: expect.objectContaining({
							error: expect.stringContaining("SDK stream ended without result"),
						}),
					}),
				]),
			);
		} finally {
			Effect.runSync(Deferred.succeed(end, undefined));
			await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
		}
	});

	it("acknowledges root and steer intake before the shared native run ends", async () => {
		const ids: [string, string] = [
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
		];
		const finish = Effect.runSync(Deferred.make<void>());
		const events: ProviderRuntimeEvent[] = [];
		const sink = createMockEventSink();
		sink.push = (event) =>
			Effect.sync(() => {
				events.push(event);
			});
		const instance = makeTestClaudeProviderInstance({
			queryFactory: ({ prompt }) => {
				if (typeof prompt === "string")
					throw new Error("Expected streaming input");
				const inputs = prompt[Symbol.asyncIterator]();
				return Object.assign(createMockQuery([]), {
					[Symbol.asyncIterator]: () =>
						(async function* () {
							for (const id of ids) {
								await inputs.next();
								yield {
									type: "command_lifecycle",
									command_uuid: id,
									state: "started",
									session_id: "intake-sdk",
									uuid: crypto.randomUUID(),
								};
							}
							await Effect.runPromise(Deferred.await(finish));
							yield makeSuccessResult({
								session_id: "intake-sdk",
								user_message_uuids: ids,
							});
						})(),
				});
			},
		});
		const replies: string[] = [];
		const send = (inputId: string, runId: string) =>
			Effect.runPromise(
				instance.sendTurnEffect(
					makeBaseSendTurnInput({
						sessionId: "intake-session",
						inputId,
						runId,
						eventSink: sink,
						model: { providerId: "claude", modelId: "claude-fable-5" },
					}),
				),
			).then((result) => {
				replies.push(result.status);
				return result;
			});
		const first = send(ids[0], "run-a");
		let second: ReturnType<typeof send> | undefined;
		try {
			await vi.waitFor(() => expect(replies).toEqual(["accepted"]));
			second = send(ids[1], "run-b");
			await vi.waitFor(() => expect(replies).toEqual(["accepted", "accepted"]));
			expect(
				events
					.filter((event) => event.type === "run.started")
					.map((event) => event.runId),
			).toEqual(["run-a", "run-a"]);
			expect(
				events.filter(
					(event) =>
						event.type.startsWith("turn.") &&
						event.type !== "turn.model_resolved",
				),
			).toHaveLength(0);
			Effect.runSync(Deferred.succeed(finish, undefined));
			await vi.waitFor(() =>
				expect(
					events.filter((event) => event.type === "turn.completed"),
				).toHaveLength(1),
			);
			expect(
				events.find((event) => event.type === "turn.completed")?.runId,
			).toBe("run-a");
		} finally {
			Effect.runSync(Deferred.succeed(finish, undefined));
			await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
			await Promise.allSettled([first, ...(second ? [second] : [])]);
		}
	});

	it("Stop during query setup ends the exact reservation without accepting it", async () => {
		const setup = Effect.runSync(Deferred.make<void>());
		const streamEnd = Effect.runSync(Deferred.make<void>());
		const events: ProviderRuntimeEvent[] = [];
		let busyCount = 0;
		const sink = createMockEventSink();
		sink.push = (event) =>
			Effect.gen(function* () {
				events.push(event);
				if (event.type === "session.status" && ++busyCount === 1)
					yield* Deferred.await(setup);
			});
		const query = Object.assign(createMockQuery([]), {
			interrupt: vi.fn(async () => {
				Effect.runSync(Deferred.succeed(streamEnd, undefined));
			}),
			[Symbol.asyncIterator]: () =>
				(async function* () {
					await Effect.runPromise(Deferred.await(streamEnd));
					yield makeSuccessResult();
				})(),
		});
		const instance = makeTestClaudeProviderInstance({
			queryFactory: () => query,
		});
		const send = Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "setup-stop",
					inputId: "setup-input",
					runId: "setup-run",
					eventSink: sink,
					model: { providerId: "claude", modelId: "claude-fable-5" },
				}),
			),
		);
		try {
			await vi.waitFor(() => expect(busyCount).toBe(1));
			const stop = Effect.runPromise(
				instance.interruptTurnEffect("setup-stop"),
			);
			// Let Stop reach the setup lock before making the query available.
			await new Promise<void>((resolve) => setImmediate(resolve));
			Effect.runSync(Deferred.succeed(setup, undefined));
			await stop;
			expect(
				events.filter((event) => event.type === "turn.interrupted"),
			).toEqual([
				expect.objectContaining({
					runId: "setup-run",
					data: { messageId: "" },
				}),
			]);
			expect(events.some((event) => event.type === "run.started")).toBe(false);
			expect(await send).toMatchObject({ status: "cancelled" });
		} finally {
			Effect.runSync(Deferred.succeed(setup, undefined));
			await Effect.runPromise(instance.shutdownEffect().pipe(Effect.ignore));
			await send.catch(() => undefined);
		}
	});

	it("names the existing user message when a continuation is accepted", async () => {
		const inputId = "11111111-1111-4111-8111-111111111111";
		const sink = createMockEventSink();
		const instance = makeTestClaudeProviderInstance({
			queryFactory: () =>
				createMockQuery([
					{
						type: "command_lifecycle",
						command_uuid: inputId,
						state: "started",
						session_id: "continuation-sdk",
						uuid: "00000000-0000-0000-0000-000000000001",
					},
					makeSuccessResult(),
				]),
		});
		await Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					inputId,
					runId: "continuation-run",
					continuation: { cutOffMessageId: "old-input" },
					eventSink: sink,
					model: { providerId: "claude", modelId: "claude-fable-5" },
				}),
			),
		);
		expect(sink.push).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "run.started",
				runId: "continuation-run",
				data: {
					inputId,
					requestedRunId: "continuation-run",
					userMessageId: "old-input",
				},
			}),
		);
	});
	it.each([
		["steer-during-tool-folds.jsonl", false, ["run-a", "run-a"], ["run-a"]],
		[
			"steer-misses-boundary.jsonl",
			false,
			["run-a", "run-b"],
			["run-a", "run-b"],
		],
		[
			"steer-misses-boundary.jsonl",
			true,
			["run-a", "run-b"],
			["run-a", "run-b"],
		],
	])("keeps the terminal event with its run in %s with delayed snapshot=%s", async (file, delayedSnapshot, owners, terminals) => {
		const messages = readFileSync(
			join(import.meta.dirname, "../../../fixtures/claude-sdk-traces", file),
			"utf8",
		)
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => decodeClaudeSDKMessage(JSON.parse(line)) as SDKMessage);
		const inputIds = [
			...new Set(
				messages.flatMap((message) =>
					message.type === "command_lifecycle" ? [message.command_uuid] : [],
				),
			),
		];
		const events: ProviderRuntimeEvent[] = [];
		const previousAnswer = messages.find(
			(message) => message.type === "assistant",
		);
		const sink = createMockEventSink();
		sink.push = (event) =>
			Effect.sync(() => {
				events.push(event);
			});
		const instance = makeTestClaudeProviderInstance({
			queryFactory: ({ prompt }) => {
				if (typeof prompt === "string")
					throw new Error("Expected streaming input");
				const prompts = prompt[Symbol.asyncIterator]();
				const stream = (async function* () {
					for (const message of messages) {
						if (
							message.type === "command_lifecycle" &&
							message.state === "queued"
						)
							await prompts.next();
						yield message;
						if (
							delayedSnapshot &&
							previousAnswer &&
							message.type === "command_lifecycle" &&
							message.state === "started" &&
							message.command_uuid === inputIds[1]
						)
							yield previousAnswer;
					}
				})();
				return Object.assign(createMockQuery([]), {
					[Symbol.asyncIterator]: () => stream,
				});
			},
		});
		const send = (inputId: string, runId: string) =>
			Effect.runPromise(
				instance.sendTurnEffect(
					makeBaseSendTurnInput({
						sessionId: "run-ownership-replay",
						inputId,
						...{ runId },
						workspaceRoot: "/tmp",
						eventSink: sink,
						model: { providerId: "claude", modelId: "claude-fable-5" },
					}),
				),
			);
		const [firstInput, secondInput] = inputIds;
		if (!firstInput || !secondInput)
			throw new Error("Expected two recorded inputs");
		const first = send(firstInput, "run-a");
		await vi.waitFor(() =>
			expect(events.some((event) => event.type === "message.created")).toBe(
				true,
			),
		);
		const second = send(secondInput, "run-b");
		await Promise.all([first, second]);
		await vi.waitFor(() =>
			expect(
				events.filter((event) => event.type === "turn.completed"),
			).toHaveLength(terminals.length),
		);
		const accepted = events.filter((event) => event.type === "run.started");
		expect(accepted.map((event) => Reflect.get(event, "runId"))).toEqual(
			owners,
		);
		expect(accepted.map((event) => event.data)).toEqual(
			inputIds.map((inputId, index) => ({
				inputId,
				requestedRunId: index === 0 ? "run-a" : "run-b",
			})),
		);
		expect(
			events
				.filter((event) => event.type === "turn.completed")
				.map((event) => Reflect.get(event, "runId")),
		).toEqual(terminals);
		for (const event of events.filter(
			(event) => event.type === "message.created",
		)) {
			expect(Reflect.get(event, "runId")).toBeDefined();
			expect(Reflect.get(event.data as object, "parentID")).toBeDefined();
		}
		if (delayedSnapshot && previousAnswer) {
			const messageId = previousAnswer.message.id ?? previousAnswer.uuid;
			for (const event of events.filter(
				(event) =>
					!event.type.startsWith("turn.") &&
					typeof event.data === "object" &&
					event.data !== null &&
					Reflect.get(event.data, "messageId") === messageId,
			))
				expect(event.runId, event.type).toBe("run-a");
		}
	});
});

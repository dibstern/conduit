import { mkdirSync, writeFileSync } from "node:fs";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	currentRunnerOutput,
	makeRunnerReceiptStore,
} from "../../../src/lib/provider/runner/runner-receipts.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

// Retries replace the prompt's current turn owner. Historical results must still
// retain their own accounting without ending the replacement or accepting aliases.
describe("Claude late accounting after prompt reuse", () => {
	const evidence: unknown[] = [];
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn10-4-fix6-accounting.json",
			JSON.stringify(evidence, null, 2),
		);
	});

	it.each([
		{
			runs: 2,
			arrivalOrder: [1, 2],
			cumulative: true,
			headers: "before-retry",
		},
		{
			runs: 3,
			arrivalOrder: [2, 1, 3],
			cumulative: false,
			headers: "before-retry",
		},
		{ runs: 2, arrivalOrder: [1, 2], cumulative: true, headers: "split" },
		{ runs: 3, arrivalOrder: [2, 1, 3], cumulative: false, headers: "split" },
		{ runs: 2, arrivalOrder: [1, 2], cumulative: true, headers: "same-batch" },
	])("keeps $runs runs' accounting with $headers headers and results in order $arrivalOrder", async ({
		runs,
		arrivalOrder,
		cumulative,
		headers,
	}) => {
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				persistence,
				ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
			),
		);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const projection = yield* ProjectionRunnerEffectTag;
					yield* projection.recover();
					const persist = yield* ClaudeEventPersistEffectTag;
					const commit = yield* makeCommitAndSignal;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const sql = yield* SqlClient.SqlClient;
					const receipts = yield* makeRunnerReceiptStore(sql);
					yield* receipts.attach("runner", "attachment");
					let sequence = 0;
					const ingestOutput = (
						events: readonly ProviderRuntimeEvent[],
						outputSequence: number,
					) =>
						Effect.gen(function* () {
							const committed = yield* Deferred.make<void>();
							return yield* ingestion.ingestBatch(events).pipe(
								Effect.provideService(currentRunnerOutput, {
									runnerId: "runner",
									attachmentId: "attachment",
									sequence: outputSequence,
									committed,
									consumed: false,
								}),
							);
						});
					const sessionId = "retry-session";
					let stamp = 1_000;
					const meta = (runId: string) => ({
						provider: "claude",
						createdAt: stamp++,
						metadata: { runId },
					});
					yield* commit([
						canonicalEvent(
							"session.created",
							sessionId,
							{ sessionId, provider: "claude", title: "Retry the same prompt" },
							{ provider: "claude", createdAt: stamp++ },
						),
					]);
					for (let index = 1; index <= runs; index++) {
						const runId = `r${index}`;
						yield* persist.persistEvent(
							canonicalEvent(
								"run.requested",
								sessionId,
								{ runId, inputId: "prompt" },
								meta(runId),
							),
						);
						yield* persist.persistUserMessage(sessionId, "same prompt", {
							messageId: "prompt",
							inputId: "prompt",
							runId,
						});
						yield* persist.persistEvents([
							canonicalEvent(
								"run.started",
								sessionId,
								{ requestedRunId: runId, inputId: "prompt" },
								meta(runId),
							),
							...(headers === "before-retry" || index === runs
								? [
										canonicalEvent(
											"message.created",
											sessionId,
											{
												messageId: `a${index}`,
												sessionId,
												role: "assistant",
												parentID: "prompt",
											},
											meta(runId),
										),
									]
								: []),
						]);
						if (index < runs)
							yield* ingestion.ingest(
								providerRuntimeEvent(
									"turn.interrupted",
									sessionId,
									{ messageId: `a${index}` },
									{ eventId: `interrupt-${index}`, runId, createdAt: stamp++ },
								),
							);
					}
					const before =
						yield* sql`SELECT state, run_id FROM turns WHERE id = 'prompt'`;
					yield* persist.persistEvents([
						canonicalEvent(
							"run.requested",
							sessionId,
							{ runId: "alias", inputId: "prompt" },
							meta("alias"),
						),
						canonicalEvent(
							"run.started",
							sessionId,
							{ requestedRunId: "alias", inputId: "prompt" },
							meta("r1"),
						),
					]);
					yield* ingestion.ingest(
						providerRuntimeEvent(
							"turn.completed",
							sessionId,
							{ messageId: "a1", cost: 999 },
							{ eventId: "alias-result", runId: "alias", createdAt: stamp++ },
						),
					);
					yield* ingestion.ingest(
						providerRuntimeEvent(
							"turn.completed",
							sessionId,
							{ messageId: `a${runs}`, cost: 999 },
							{ eventId: "wrong-owner", runId: "r1", createdAt: stamp++ },
						),
					);
					for (const index of arrivalOrder) {
						const header = providerRuntimeEvent(
							"message.created",
							sessionId,
							{
								messageId: `a${index}`,
								sessionId,
								role: "assistant",
								parentID: "prompt",
							},
							{
								eventId: `header-${index}`,
								runId: `r${index}`,
								createdAt: stamp++,
							},
						);
						const completion = providerRuntimeEvent(
							"turn.completed",
							sessionId,
							{
								messageId: `a${index}`,
								...(cumulative
									? { providerCostTotalUsd: index, providerSessionId: "sdk" }
									: { cost: index }),
								tokens: { input: index * 100, output: index * 20 },
							},
							{
								eventId: `result-${index}`,
								runId: `r${index}`,
								createdAt: stamp++,
							},
						);
						// Old headers can arrive after the retry has replaced turns.run_id.
						// Replay both batches to check message restoration and accounting dedup.
						const headerSequence = ++sequence;
						const completionSequence =
							headers === "split" && index < runs ? ++sequence : headerSequence;
						for (let replay = 0; replay < 2; replay++) {
							if (headers === "split" && index < runs) {
								yield* ingestOutput([header], headerSequence);
								const [persisted] =
									yield* sql`SELECT parent_id, turn_id FROM messages WHERE id = ${`a${index}`}`;
								expect(persisted).toEqual({
									parent_id: "prompt",
									turn_id: null,
								});
							}
							yield* ingestOutput(
								headers === "same-batch" && index < runs
									? [header, completion]
									: [completion],
								completionSequence,
							);
						}
						yield* ingestion.ingest(completion);
					}
					return {
						before,
						wrongOwner:
							yield* sql`SELECT event_id FROM events WHERE event_id IN ('wrong-owner', 'alias-result')`,
						messages:
							yield* sql`SELECT id, cost, tokens_in, tokens_out FROM messages WHERE role = 'assistant' ORDER BY id`,
						streaming:
							yield* sql`SELECT id FROM messages WHERE role = 'assistant' AND is_streaming = 1`,
						providerRuns:
							yield* sql`SELECT id, status FROM provider_runs WHERE id <> 'alias' ORDER BY id`,
						turns:
							yield* sql`SELECT state, run_id, cost, tokens_in, tokens_out FROM turns WHERE id = 'prompt'`,
						accounting:
							yield* sql`SELECT type, json_extract(metadata, '$.runId') AS run_id, json_extract(data, '$.messageId') AS message_id, json_extract(data, '$.cost') AS cost FROM events WHERE type IN ('turn.completed', 'message.completed') ORDER BY sequence`,
						terminals:
							yield* sql`SELECT type, json_extract(metadata, '$.runId') AS run_id FROM events WHERE type IN ('turn.interrupted', 'turn.completed') ORDER BY sequence`,
					};
				}),
			);
			evidence.push({ runs, arrivalOrder, cumulative, headers, ...result });
			expect(result.wrongOwner).toEqual([]);
			expect(result.streaming).toEqual([]);
			expect(result.before).toEqual([{ state: "running", run_id: `r${runs}` }]);
			expect(result.messages).toEqual(
				Array.from({ length: runs }, (_, offset) => ({
					id: `a${offset + 1}`,
					cost: cumulative ? 1 : offset + 1,
					tokens_in: (offset + 1) * 100,
					tokens_out: (offset + 1) * 20,
				})),
			);
			expect(result.providerRuns).toEqual(
				Array.from({ length: runs }, (_, offset) => ({
					id: `r${offset + 1}`,
					status: offset + 1 === runs ? "completed" : "interrupted",
				})),
			);
			expect(result.turns).toEqual([
				{
					state: "completed",
					run_id: `r${runs}`,
					cost: cumulative ? 1 : runs,
					tokens_in: runs * 100,
					tokens_out: runs * 20,
				},
			]);
			expect(result.accounting).toEqual(
				arrivalOrder.map((index) => ({
					type: index === runs ? "turn.completed" : "message.completed",
					run_id: `r${index}`,
					message_id: `a${index}`,
					cost: cumulative ? 1 : index,
				})),
			);
			expect(result.terminals).toEqual([
				...Array.from({ length: runs - 1 }, (_, offset) => ({
					type: "turn.interrupted",
					run_id: `r${offset + 1}`,
				})),
				{ type: "turn.completed", run_id: `r${runs}` },
			]);
		} finally {
			await runtime.dispose();
		}
	});
});

// SDK-local requests have no new assistant header. Their explicit prompt owns
// late usage, even when messageId still names the preceding answer.
describe("Claude late SDK-local accounting", () => {
	it("accounts an interrupted /compact result once using its explicit prompt", async () => {
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				persistence,
				ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
			),
		);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const persist = yield* ClaudeEventPersistEffectTag;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const commit = yield* makeCommitAndSignal;
					const sql = yield* SqlClient.SqlClient;
					const sessionId = "compact-session";
					const meta = (runId: string) => ({
						provider: "claude",
						metadata: { runId },
					});
					yield* commit([
						canonicalEvent("session.created", sessionId, {
							sessionId,
							provider: "claude",
							title: "Late compact result",
						}),
					]);
					for (const index of [1, 2]) {
						const runId = `r${index}`;
						const inputId = `u${index}`;
						yield* persist.persistEvent(
							canonicalEvent(
								"run.requested",
								sessionId,
								{ runId, inputId },
								meta(runId),
							),
						);
						yield* persist.persistUserMessage(
							sessionId,
							index === 1 ? "normal prompt" : "/compact",
							{ messageId: inputId, inputId, runId },
						);
						yield* persist.persistEvent(
							canonicalEvent(
								"run.started",
								sessionId,
								{ requestedRunId: runId, inputId },
								meta(runId),
							),
						);
						if (index === 1) {
							yield* persist.persistEvent(
								canonicalEvent(
									"message.created",
									sessionId,
									{
										messageId: "a1",
										sessionId,
										role: "assistant",
										parentID: "u1",
									},
									meta(runId),
								),
							);
							yield* ingestion.ingest(
								providerRuntimeEvent(
									"turn.completed",
									sessionId,
									{
										messageId: "a1",
										providerCostTotalUsd: 1,
										providerSessionId: "sdk",
										tokens: { input: 100, output: 10 },
									},
									{ eventId: "first-result", runId },
								),
							);
						} else {
							yield* ingestion.ingest(
								providerRuntimeEvent(
									"turn.interrupted",
									sessionId,
									{ messageId: "" },
									{ eventId: "compact-interrupted", runId },
								),
							);
						}
					}
					for (const { runId, userMessageId } of [
						{ runId: "r1", userMessageId: "u2" },
						{ runId: "r2", userMessageId: "u1" },
					]) {
						yield* ingestion.ingest(
							providerRuntimeEvent(
								"turn.completed",
								sessionId,
								{ messageId: "a1", userMessageId, cost: 999 },
								{ eventId: `wrong-prompt-${runId}`, runId },
							),
						);
					}
					const late = providerRuntimeEvent(
						"turn.completed",
						sessionId,
						{
							messageId: "a1",
							userMessageId: "u2",
							providerCostTotalUsd: 2,
							providerSessionId: "sdk",
							tokens: { input: 200, output: 20 },
						},
						{ eventId: "late-compact-result", runId: "r2" },
					);
					yield* ingestion.ingest(late);
					yield* ingestion.ingest(late);
					return {
						wrongPrompts:
							yield* sql`SELECT event_id FROM events WHERE event_id LIKE 'wrong-prompt-%'`,
						accounting:
							yield* sql`SELECT type, json_extract(data, '$.cost') AS cost FROM events WHERE event_id = 'late-compact-result'`,
						turns:
							yield* sql`SELECT id, state, cost, tokens_in, tokens_out FROM turns ORDER BY id`,
						messages:
							yield* sql`SELECT id, cost, tokens_in, tokens_out FROM messages WHERE role = 'assistant'`,
						runs: yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
					};
				}),
			);
			expect(result.accounting).toEqual([
				{ type: "message.completed", cost: 1 },
			]);
			expect(result.wrongPrompts).toEqual([]);
			expect(result.turns).toEqual([
				{
					id: "u1",
					state: "completed",
					cost: 1,
					tokens_in: 100,
					tokens_out: 10,
				},
				{
					id: "u2",
					state: "interrupted",
					cost: 1,
					tokens_in: 200,
					tokens_out: 20,
				},
			]);
			expect(result.messages).toEqual([
				{ id: "a1", cost: 1, tokens_in: 100, tokens_out: 10 },
			]);
			expect(result.runs).toEqual([
				{ id: "r1", status: "completed" },
				{ id: "r2", status: "interrupted" },
			]);
			mkdirSync("test-results/82tn10-4-round7", { recursive: true });
			writeFileSync(
				"test-results/82tn10-4-round7/late-accounting.json",
				JSON.stringify({ passed: true, replayCount: 2, ...result }, null, 2),
			);
		} finally {
			await runtime.dispose();
		}
	});
});

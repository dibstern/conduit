// Failure modes: disposal loses the call id, stale tools poison later sends,
// restored message ids bypass open-state checks, or stale answers start a turn.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Context, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import {
	defaultDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	PendingInteractionServiceTag,
	type PendingQuestion,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { ProviderRuntimeIngestionTag } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { restoreClaudeQuestionsFromStore } from "../../../src/lib/domain/relay/Services/restore-claude-questions.js";
import {
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { handleAskUserResponse } from "../../../src/lib/handlers/permissions.js";
import {
	ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { ProjectShellEnvResolver } from "../../../src/lib/provider/project-shell-env.js";
import { settleSessionRuns } from "../../../src/lib/provider/session-run-settlement.js";
import {
	claudeSdk,
	responseChunks,
} from "../../helpers/fake-claude-process-sdk.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: recovered Claude questions", () => {
	let root: string;
	let harness: RelayHarness | undefined;
	let evidence: Record<string, unknown>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "conduit-recovered-question-"));
		mkdirSync(join(root, "home"));
		mkdirSync(join(root, "login"));
		vi.stubEnv("HOME", join(root, "home"));
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "login"));
		vi.stubEnv("CONDUIT_CONFIG_DIR", root);
		vi.spyOn(ProjectShellEnvResolver.prototype, "register").mockImplementation(
			() => {},
		);
		vi.spyOn(
			ProjectShellEnvResolver.prototype,
			"waitUntilReady",
		).mockResolvedValue(true);
		__setProbeOverrideForTesting(async () => ({
			models: [{ id: "sonnet", name: "Sonnet", providerId: "claude" }],
			commands: [],
			agents: [],
		}));
	});

	afterEach(async () => {
		try {
			await harness?.stop();
		} finally {
			harness = undefined;
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
			__setProbeOverrideForTesting(undefined);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/u1y3i-2-recovered-question-${evidence["scenario"]}.json`,
				`${JSON.stringify(evidence, null, 2)}\n`,
			);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		"open",
		"open-named-account",
		"completed",
		"missing-tool",
		"missing-call-id",
		"restored-completed",
		"answer-completed",
		"answer-runner-owned",
		"lookup-failure",
		"concurrent-completed",
	] as const)("accepts later sends after recovering a %s question", async (scenario) => {
		evidence = { scenario, passed: false };
		const isOpen = scenario === "open" || scenario === "open-named-account";
		const accountId = scenario === "open-named-account" ? "personal" : "claude";
		if (scenario === "open-named-account") {
			await saveDaemonConfig(
				{
					...defaultDaemonConfig(),
					accountDefaults: { claude: AccountIdSchema.make(accountId) },
					instances: [
						{
							id: accountId,
							name: "Personal Claude",
							driver: "claude",
							configDir: join(root, "login"),
							port: 0,
							managed: false,
						},
					],
				},
				root,
			);
		}
		harness = await createRelayHarness("chat-simple", {
			configDir: root,
			defaultModel: null,
			claudeSdk,
		});
		const fixture = harness;
		const runtime = fixture.stack.effectRuntime.runtime;
		const pending = await runtime.runPromise(PendingInteractionServiceTag);
		const log = await runtime.runPromise(LoggerTag);
		const warnings = vi.spyOn(log, "warn");
		const client = await fixture.connectWsClient();
		await client.waitForInitialState();
		const created = await client.createSession(`Recovered ${scenario}`, {
			instanceId: accountId,
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "",
			},
		});
		const sessionId = created["id"];
		if (typeof sessionId !== "string") throw new Error("Missing session id");
		await client.sendMessage("question-long-recovery", { sessionId });
		const question = await client.waitFor("question_pending", {
			predicate: (message) => message["sessionId"] === sessionId,
		});
		const requestId = String(question["toolId"]);
		const db = new Database(fixture.eventsDbPath);
		try {
			const tool = db
				.prepare<
					[string],
					{ id: string; message_id: string; call_id: string; status: string }
				>(
					"SELECT mp.id, mp.message_id, mp.call_id, mp.status FROM message_parts mp JOIN messages m ON m.id = mp.message_id WHERE m.session_id = ? AND mp.tool_name = 'AskUserQuestion'",
				)
				.get(sessionId);
			expect(tool).toBeDefined();
			if (!tool) throw new Error("Question tool was not persisted");
			expect(tool.call_id).not.toBe(requestId);
			expect(["started", "running", "pending"]).toContain(tool.status);
			expect(
				db.prepare("SELECT provider FROM sessions WHERE id = ?").get(sessionId),
			).toEqual({ provider: accountId });

			// Dispose the actual SDK runner. Stop intentionally resolves its cards;
			// runner disposal leaves recoverable questions behind for the next send.
			await runtime.runPromise(
				fixture.stack.orchestration.engine.dispatchEffect({
					type: "end_session",
					commandId: randomUUID(),
					sessionId,
				}),
			);
			let recovered: PendingQuestion | undefined;
			await vi.waitFor(async () => {
				recovered = (
					await runtime.runPromise(pending.listPendingQuestions(sessionId))
				).find((entry) => entry.requestId === requestId);
				expect(recovered).toMatchObject({
					requestId,
					sessionId,
					toolCallId: tool.call_id,
					recovered: true,
				});
			});
			if (!recovered) throw new Error("Question was not recovered");
			evidence["recovered"] = {
				requestId: recovered.requestId,
				toolCallId: recovered.toolCallId,
				recovered: recovered.recovered,
			};
			// The process driver's confirmed-exit path supplies this terminal. The
			// injected in-process runner has no child exit notification of its own.
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					yield* settleSessionRuns(
						sql,
						sessionId,
						"Recovered-question fixture runner stopped",
						(events) => ingestion.ingestBatch(events),
						{ confirmedStop: true },
					);
				}),
			);
			evidence["runnerStopped"] = {
				adapterCommand: "end_session",
				terminal: "settleSessionRuns confirmedStop after in-process disposal",
			};

			if (scenario === "restored-completed") {
				await runtime.runPromise(pending.markQuestionResolved(requestId));
				await runtime.runPromise(restoreClaudeQuestionsFromStore);
				expect(
					await runtime.runPromise(pending.listPendingQuestions(sessionId)),
				).toContainEqual(
					expect.objectContaining({
						requestId,
						toolCallId: tool.call_id,
						partId: tool.id,
						messageId: expect.any(String),
						recovered: true,
					}),
				);
			} else if (scenario === "open-named-account") {
				await runtime.runPromise(pending.markQuestionResolved(requestId));
				await runtime.runPromise(
					pending.recoverPendingQuestions([
						{
							...recovered,
							messageId: tool.message_id,
							partId: tool.id,
						},
					]),
				);
			}
			if (scenario === "missing-tool") {
				db.prepare("DELETE FROM message_parts WHERE id = ?").run(tool.id);
			} else if (scenario === "missing-call-id") {
				const { toolCallId: _toolCallId, ...withoutCallId } = recovered;
				await runtime.runPromise(pending.markQuestionResolved(requestId));
				await runtime.runPromise(
					pending.recoverPendingQuestions([withoutCallId]),
				);
			} else if (scenario === "lookup-failure") {
				const read = await runtime.runPromise(ReadQueryEffectTag);
				vi.spyOn(read, "getPendingClaudeQuestionTool").mockImplementationOnce(
					() =>
						Effect.fail(
							new ReadQueryEffectError({
								operation: "getPendingClaudeQuestionTool",
								cause: new Error("Recovered question lookup unavailable"),
							}),
						),
				);
			} else if (!isOpen && scenario !== "answer-runner-owned") {
				db.prepare(
					"UPDATE message_parts SET status = 'completed' WHERE id = ?",
				).run(tool.id);
			}
			Object.assign(evidence, { sessionId, requestId, accountId, tool });
			expect(
				await runtime.runPromise(pending.listPendingQuestions(sessionId)),
			).toContainEqual(expect.objectContaining({ requestId, recovered: true }));

			if (scenario === "answer-runner-owned") {
				const stored = db
					.prepare<[string], { provider_process_id: string }>(
						"SELECT provider_process_id FROM pending_approvals WHERE id = ?",
					)
					.get(requestId);
				expect(stored?.provider_process_id).toBeTruthy();
				expect(stored?.provider_process_id).not.toMatch(/^opencode:/);
				const beforeAnswer = db
					.prepare(
						"SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
					)
					.get(sessionId);
				// The compatibility handler has no command engine. A process-owned
				// prompt must expire instead of turning its answer into a new input.
				const contextEffect = fixture.stack.rpcWsHandler.context;
				if (!contextEffect) throw new Error("Missing RPC handler context");
				const handlerContext = await runtime.runPromise(contextEffect);
				await expect(
					Effect.runPromise(
						handleAskUserResponse(client.getClientId(), {
							toolId: requestId,
							answers: { "0": "Continue" },
						}).pipe(
							Effect.provideContext(
								handlerContext.pipe(Context.omit(OrchestrationEngineTag)),
							),
						),
					),
				).rejects.toThrow(
					"This prompt expired because its provider process is no longer running.",
				);
				expect(
					db
						.prepare(
							"SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
						)
						.get(sessionId),
				).toEqual(beforeAnswer);
				evidence["answerOutcome"] = "expired without a follow-up user message";
				evidence["providerProcessId"] = stored?.provider_process_id;
			}

			if (scenario === "answer-completed") {
				const beforeAnswer = db
					.prepare(
						"SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
					)
					.get(sessionId);
				await expect(
					client.rpcCall((rpc) =>
						rpc.AnswerQuestion({
							projectSlug: "integration-test",
							originId: client.getClientId(),
							commandId: randomUUID(),
							toolId: requestId,
							answers: { "0": "Continue" },
						}),
					),
				).rejects.toThrow(
					"This question is no longer answerable. Send a new message to continue.",
				);
				expect(
					db
						.prepare(
							"SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
						)
						.get(sessionId),
				).toEqual(beforeAnswer);
				evidence["answerOutcome"] =
					"This question is no longer answerable. Send a new message to continue.";
			}

			const replies: string[] = [];
			const batches =
				scenario === "concurrent-completed"
					? [["after-recovered-question", "racing-send"], ["send-again"]]
					: [["after-recovered-question"], ["send-again"]];
			for (const prompts of batches) {
				expect(
					await Promise.all(
						prompts.map((prompt) => client.sendMessage(prompt, { sessionId })),
					),
				).toEqual(prompts.map(() => sessionId));
				for (const prompt of prompts) {
					const reply = await client.waitForTranscriptMessage(
						(message) =>
							message.role === "assistant" &&
							(message.parts ?? []).some(
								(part) =>
									part.type === "text" &&
									part.text === responseChunks(prompt).join(""),
							),
						sessionId,
					);
					replies.push(
						reply.parts?.find((part) => part.type === "text")?.text ?? "",
					);
				}
			}
			const warningLines = warnings.mock.calls
				.map((args) => args.map(String).join(" "))
				.filter((line) => line.includes("Recovered Claude question"));
			const expectedWarnings =
				isOpen || scenario === "answer-runner-owned" ? 0 : 1;
			expect(warningLines).toHaveLength(expectedWarnings);
			if (expectedWarnings > 0) {
				expect(warningLines[0]).toContain(sessionId);
				expect(warningLines[0]).toContain(requestId);
				expect(warningLines[0]).toContain(
					scenario === "missing-call-id" ? "toolCallId=missing" : tool.call_id,
				);
			} else if (isOpen) {
				expect(
					db
						.prepare("SELECT status FROM message_parts WHERE id = ?")
						.get(tool.id),
				).toEqual({ status: "completed" });
			}
			expect(
				await runtime.runPromise(pending.listPendingQuestions(sessionId)),
			).toEqual([]);
			const approval = db
				.prepare<[string], { status: string }>(
					"SELECT status FROM pending_approvals WHERE id = ?",
				)
				.get(requestId);
			expect(approval?.status).toBe("resolved");
			Object.assign(evidence, {
				replies,
				warnings: warningLines,
				approval,
				passed: true,
			});
		} catch (error) {
			evidence["error"] =
				error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			evidence["warnings"] = warnings.mock.calls.map((args) =>
				args.map(String).join(" "),
			);
			evidence["recoveredWarnings"] = warnings.mock.calls
				.map((args) => args.map(String).join(" "))
				.filter((line) => line.includes("Recovered Claude question"));
			evidence["observedReplies"] =
				client.getReceivedOfType("transcript_message");
			evidence["transcript"] = db
				.prepare(
					"SELECT role, text FROM messages WHERE session_id = ? ORDER BY created_at, id",
				)
				.all(sessionId);
			db.close();
		}
	}, 30_000);
});

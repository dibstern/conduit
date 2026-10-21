import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetChatState,
	restoreContextFromMessages,
	setMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	applyGetModelsResponse,
	clearDiscoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import {
	applyTranscriptEnvelope,
	type TranscriptEntry,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import type { SDKMessage } from "../../../src/lib/provider/claude/types.js";
import type { OpenCodeRecording } from "../../e2e/fixtures/recorded/types.js";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import { detailRowsOf } from "../../helpers/detail-rows.js";
import { createMockQuery, makeSuccessResult } from "../../helpers/mock-sdk.js";
import { testMessages } from "../../helpers/test-session-slot.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

function recording(status = 200): OpenCodeRecording {
	const base = loadOpenCodeRecording("chat-simple");
	return {
		...base,
		interactions: [
			...base.interactions,
			{
				kind: "rest",
				method: "POST",
				path: "/session/ses_compaction/summarize",
				status,
				responseBody: status === 200 ? true : { error: "Compaction failed" },
			},
		],
	};
}

function seedNativeUserTurn(
	relay: RelayHarness,
	sessionId: string,
	modelID: string,
): void {
	relay.mock.setExactResponse("GET", `/session/${sessionId}/message`, 200, [
		{
			info: {
				id: "msg_prior_user",
				sessionID: sessionId,
				role: "user",
				time: { created: Date.now() - 1_000 },
				agent: "build",
				model: { providerID: "opencode", modelID },
			},
			parts: [
				{
					id: "prt_prior_user",
					sessionID: sessionId,
					messageID: "msg_prior_user",
					type: "text",
					text: "Earlier prompt",
				},
			],
		},
	]);
}

function persistedCompactions(harness: RelayHarness, sessionId: string) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const events = yield* sql<{
				event_id: string;
				data: string;
			}>`SELECT event_id, data FROM events
				WHERE session_id = ${sessionId} AND type = 'session.compaction'
				ORDER BY sequence`;
			const parts = yield* sql<{
				id: string;
				text: string;
				status: string | null;
			}>`SELECT p.id, p.text, p.status
				FROM message_parts p JOIN messages m ON m.id = p.message_id
				WHERE m.session_id = ${sessionId} AND p.type = 'compaction'`;
			return { events, parts };
		}).pipe(
			Effect.provide(SqliteClient.layer({ filename: harness.eventsDbPath })),
		),
	);
}

function saveEvidence(name: string, evidence: unknown): void {
	const directory = join(
		process.env["CONDUIT_TEST_ARTIFACT_DIR"] ??
			join(tmpdir(), "conduit-integration-artifacts"),
		"review5-opencode-compaction",
	);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, `${name}.json`),
		JSON.stringify(evidence, null, 2),
	);
}

describe("Integration: OpenCode compaction through the relay", () => {
	let harness: RelayHarness | undefined;

	beforeEach(() => {
		vi.stubGlobal("window", {
			history: { pushState: vi.fn(), replaceState: vi.fn() },
		});
	});

	afterEach(async ({ task }) => {
		if (harness && task.result?.errors?.length) {
			const events = await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return yield* sql`SELECT sequence, type, data, metadata FROM events ORDER BY sequence DESC LIMIT 40`;
				}).pipe(
					Effect.provide(
						SqliteClient.layer({ filename: harness.eventsDbPath }),
					),
				),
			);
			saveEvidence("failure-events", events);
		}
		await harness?.stop();
		harness = undefined;
		resetChatState();
		clearDiscoveryState();
		openSessionForSetup(null);
		vi.unstubAllGlobals();
	});

	it.each([
		{
			name: "global Claude default",
			modelID: "big-pickle",
		},
		{
			name: "different native session model",
			modelID: "mimo-v2-omni-free",
		},
	])("uses the OpenCode model for Compact with $name", async ({
		name,
		modelID,
	}) => {
		const relay = await createRelayHarness(recording(), {
			defaultModel: "claude/sonnet",
		});
		harness = relay;
		const client = await relay.connectWsClient();
		await client.waitForInitialState();
		const sessionId = String(
			(
				await client.createSession("Compact model", {
					providerId: "opencode",
					model: {
						providerId: "opencode",
						modelId: modelID,
						variant: "",
						contextWindow: "",
					},
				})
			)["id"],
		);
		await client.viewSession(sessionId);
		await client.switchModel(modelID, "opencode", sessionId);
		seedNativeUserTurn(
			relay,
			sessionId,
			modelID === "big-pickle" ? "mimo-v2-omni-free" : "big-pickle",
		);
		await client.sendMessage("/compact");
		await expect
			.poll(
				() =>
					relay.mock.requestBodies.find(
						(request) => request.path === `/session/${sessionId}/summarize`,
					),
				{ timeout: 10_000 },
			)
			.toBeDefined();
		const request = relay.mock.requestBodies.find(
			(candidate) => candidate.path === `/session/${sessionId}/summarize`,
		);
		expect(JSON.parse(request?.body ?? "null")).toEqual({
			providerID: "opencode",
			modelID,
		});
		expect(
			relay.mock.requestBodies.some((candidate) =>
				/\/(?:prompt_async|message)$/.test(candidate.path),
			),
		).toBe(false);
		relay.mock.injectSSEEvents([
			{
				type: "session.status",
				properties: { sessionID: sessionId, status: { type: "idle" } },
			},
		]);
		const stored = await client.getModels(sessionId);
		expect(stored.active).toEqual({ provider: "opencode", model: modelID });
		saveEvidence(`model-${name.replaceAll(" ", "-")}`, { request, stored });
	});

	it("rejects Compact without a stored pick even when native history has a model", async () => {
		const relay = await createRelayHarness(recording(), {
			defaultModel: "claude/sonnet",
		});
		harness = relay;
		const client = await relay.connectWsClient();
		await client.waitForInitialState();
		const sessionId = String(
			(
				await client.createSession("Empty compaction", {
					providerId: "opencode",
					model: {
						providerId: "opencode",
						modelId: "big-pickle",
						variant: "",
						contextWindow: "",
					},
				})
			)["id"],
		);
		await client.viewSession(sessionId);
		seedNativeUserTurn(relay, sessionId, "big-pickle");
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE sessions SET model_id = NULL, model_provider = NULL,
					variant = NULL, context_window = NULL WHERE id = ${sessionId}`;
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: relay.eventsDbPath })),
			),
		);
		await client.sendMessage("/compact");
		const notice = await client.waitForTranscriptMessage(
			(message) =>
				message.parts?.some(
					(part) => part.type === "error" && part.text?.includes("model pick"),
				) === true,
			sessionId,
		);
		const errors = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					code: string;
				}>`SELECT json_extract(data, '$.code') AS code
					FROM events WHERE session_id = ${sessionId} AND type = 'turn.error'`;
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: relay.eventsDbPath })),
			),
		);
		expect(errors).toEqual([{ code: "PICK_REQUIRED" }]);
		expect(
			relay.mock.requestBodies.some((request) =>
				/\/(?:summarize|prompt_async|message)$/.test(request.path),
			),
		).toBe(false);
		const runs = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* (yield* SqlClient.SqlClient)`SELECT status, started_at,
					(SELECT COUNT(*) FROM turns WHERE run_id = provider_runs.id
						AND state = 'error' AND started_at IS NULL) AS failed_inputs
					FROM provider_runs WHERE session_id = ${sessionId}`;
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: relay.eventsDbPath })),
			),
		);
		expect(runs).toEqual([
			{ status: "error", started_at: null, failed_inputs: 1 },
		]);
		saveEvidence("pick-required", { notice, errors, runs });
	});

	it("keeps Claude context when compact_boundary omits post_tokens", async () => {
		let turns = 0;
		const relay = await createRelayHarness(recording(), {
			defaultModel: "claude/sonnet",
			claudeSdk: {
				query: () => {
					const messages: SDKMessage[] =
						turns++ === 0
							? []
							: [
									{
										type: "system",
										subtype: "compact_boundary",
										uuid: randomUUID(),
										session_id: "sdk-compaction-regression",
										compact_metadata: {
											trigger: "manual",
											pre_tokens: 170_000,
										},
									},
								];
					messages.push(
						makeSuccessResult({
							uuid: randomUUID(),
							session_id: "sdk-compaction-regression",
							usage: {
								...makeSuccessResult().usage,
								input_tokens: turns === 1 ? 170_000 : 0,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						}),
					);
					return createMockQuery(messages);
				},
				titleQuery: async function* () {
					yield {
						type: "assistant",
						message: {
							content: [{ type: "text", text: "Compaction regression" }],
						},
					};
				},
				fork: {
					readTranscript: async () => [],
					forkSession: async () => ({ sessionId: randomUUID() }),
				},
			},
		});
		harness = relay;
		const client = await relay.connectWsClient();
		await client.waitForInitialState();
		const sessionId = client.getActiveSessionId();
		if (!sessionId) throw new Error("No Claude session was created");
		await client.rpcCall((rpc) =>
			rpc.SwitchContextWindow({
				sessionId,
				contextWindow: "200k",
			}),
		);
		openSessionForSetup(sessionId, "integration-test");
		applyGetModelsResponse(await client.getModels(sessionId), sessionId);
		const messages = testMessages(sessionId);
		const emptyTranscript: TranscriptEntry = {
			rows: [],
			pending: [],
			hwm: null,
			hasMore: false,
			status: { _tag: "cold" },
			project: "integration-test",
			waiting: new Map(),
			partOrder: new Map(),
		};
		await client.sendMessage("Measure current context");
		await client.waitForTurnEnd(sessionId);
		const before = await client.loadMoreHistory(sessionId);
		const beforeTranscript = applyTranscriptEnvelope(emptyTranscript, {
			_tag: "snapshot",
			rows: before.messages.flatMap(detailRowsOf),
			sequence: 1,
		});
		setMessages(messages, historyToChatMessages(beforeTranscript.rows));
		restoreContextFromMessages(messages);
		expect(messages.contextPercent).toBe(85);
		client.clearReceived();
		await client.sendMessage("/compact");
		await client.waitForTranscriptMessage(
			(message) =>
				message.parts?.some((part) => part.type === "compaction") === true,
			sessionId,
		);
		await client.waitForTurnEnd(sessionId);
		const after = await client.loadMoreHistory(sessionId);
		const afterTranscript = applyTranscriptEnvelope(emptyTranscript, {
			_tag: "snapshot",
			rows: after.messages.flatMap(detailRowsOf),
			sequence: 2,
		});
		setMessages(messages, historyToChatMessages(afterTranscript.rows));
		restoreContextFromMessages(messages);
		expect(messages.contextPercent).toBe(85);
		expect(
			relay.mock.requestBodies.some((request) =>
				request.path.endsWith("/summarize"),
			),
		).toBe(false);
		saveEvidence("claude-missing-post-tokens", {
			before,
			after,
			contextPercent: messages.contextPercent,
		});
	});

	it.each([
		"MessageAbortedError",
		"UnknownError",
	])("does not clear context for an unsuccessful live summary (%s)", async (name) => {
		const relay = await createRelayHarness(recording(), {
			defaultModel: "opencode/big-pickle",
		});
		harness = relay;
		const client = await relay.connectWsClient();
		await client.waitForInitialState();
		const sessionId = client.getActiveSessionId();
		if (!sessionId) throw new Error("No OpenCode session was created");
		seedNativeUserTurn(relay, sessionId, "big-pickle");
		await client.sendMessage("/compact");
		await expect
			.poll(
				() =>
					relay.mock.requestBodies.some((request) =>
						request.path.endsWith("/summarize"),
					),
				{ timeout: 10_000 },
			)
			.toBe(true);
		const info = {
			id: "msg_unsuccessful_summary",
			sessionID: sessionId,
			role: "assistant",
			parentID: "msg_compaction_request",
			modelID: "big-pickle",
			providerID: "opencode",
			mode: "build",
			agent: "build",
			path: { cwd: process.cwd(), root: process.cwd() },
			time: { created: Date.now() - 1_000, completed: Date.now() },
			summary: true,
			error: { name, data: { message: "Summary did not succeed" } },
			cost: 0.01,
			tokens: {
				input: 170_000,
				output: 0,
				reasoning: 0,
				cache: { read: 0, write: 0 },
			},
		};
		relay.mock.injectSSEEvents([
			{
				type: "session.status",
				properties: { sessionID: sessionId, status: { type: "busy" } },
			},
			{ type: "message.updated", properties: { info } },
			{
				type: "session.status",
				properties: { sessionID: sessionId, status: { type: "idle" } },
			},
		]);
		const message = await client.waitForTranscriptMessage(
			(candidate) =>
				candidate.id === info.id && candidate.time?.completed !== undefined,
			sessionId,
		);
		expect(message.contextTokens).toBeUndefined();
		expect(message.tokens?.["input"]).toBe(170_000);
		const stored = await persistedCompactions(relay, sessionId);
		expect(
			stored.events.some(
				(event) => JSON.parse(event.data).state === "completed",
			),
		).toBe(false);
		saveEvidence(`unsuccessful-live-${name}`, { message, stored });
	});

	it.each([
		"next-first",
		"legacy-first",
		"next-only",
		"legacy-only",
		"summary-only",
	])("summarizes with the current model and delivers one durable notice per compaction (%s)", async (mode) => {
		const relay = await createRelayHarness(recording(), {
			defaultModel: "opencode/big-pickle",
		});
		harness = relay;
		const client = await relay.connectWsClient();
		await client.waitForInitialState();
		const sessionId = client.getActiveSessionId();
		if (!sessionId) throw new Error("No OpenCode session was created");
		seedNativeUserTurn(relay, sessionId, "big-pickle");
		const requestsBefore = relay.mock.requestBodies.length;
		const evidence = [];

		// Each compaction must use the stored pick, including a later model switch.
		for (const [index, modelID] of [
			"big-pickle",
			"mimo-v2-omni-free",
		].entries()) {
			let finishSummarize = () => {};
			relay.mock.summarizeHold = new Promise<void>((resolve) => {
				finishSummarize = resolve;
			});
			if (index > 0) await client.switchModel(modelID, "opencode", sessionId);
			client.clearReceived();
			const inputId = randomUUID();
			await client.sendMessage(index === 0 ? "  /compact\n" : "/compact", {
				commandId: inputId,
			});
			await expect
				.poll(
					() =>
						relay.mock.requestBodies.filter(
							(request) => request.path === `/session/${sessionId}/summarize`,
						).length,
					{ timeout: 10_000 },
				)
				.toBe(index + 1);
			const request = relay.mock.requestBodies.filter(
				(candidate) => candidate.path === `/session/${sessionId}/summarize`,
			)[index];
			expect(request?.method).toBe("POST");
			expect(JSON.parse(request?.body ?? "null")).toEqual({
				providerID: "opencode",
				modelID,
			});
			expect(
				relay.mock.requestBodies
					.slice(requestsBefore)
					.some((candidate) =>
						/\/(?:prompt_async|message)$/.test(candidate.path),
					),
			).toBe(false);
			if (index > 0)
				relay.mock.injectSSEEvents([
					{
						type: "message.part.updated",
						properties: {
							part: {
								id: "prt_compact_0",
								sessionID: sessionId,
								messageID: "msg_compact_0",
								type: "compaction",
								auto: false,
							},
						},
					},
				]);
			// summarize has no recorded prompt stream; deliver its busy event
			// before waiting for the shell to report a running turn.
			relay.mock.injectSSEEvents([
				{
					type: "session.status",
					properties: { sessionID: sessionId, status: { type: "busy" } },
				},
			]);
			await client.waitForTurnStart(sessionId);
			await client.waitFor("shell", {
				predicate: (frame) =>
					frame["_tag"] === "upsert" &&
					(frame["item"] as { id: string; compacting?: string }).id ===
						sessionId &&
					Boolean((frame["item"] as { compacting?: string }).compacting),
			});

			const properties = {
				sessionID: sessionId,
				messageID: `msg_compact_${index}`,
				timestamp: Date.now(),
				reason: "manual",
			};
			const summaryId = `msg_summary_${index}`;
			const summaryInfo = {
				id: summaryId,
				sessionID: sessionId,
				role: "assistant",
				parentID: properties.messageID,
				modelID,
				providerID: "opencode",
				mode: "build",
				agent: "build",
				path: { cwd: process.cwd(), root: process.cwd() },
				time: { created: Date.now() },
				summary: true,
				cost: 0.01,
				tokens: {
					input: 170_000,
					output: 1_000,
					reasoning: 0,
					cache: { read: 0, write: 0 },
				},
			};
			relay.mock.injectSSEEvents([
				{
					type: "message.updated",
					properties: {
						info: {
							id: `msg_unrelated_tui_${index}`,
							sessionID: sessionId,
							role: "user",
							time: { created: Date.now() },
						},
					},
				},
				{
					type: "message.updated",
					properties: {
						info: {
							id: properties.messageID,
							sessionID: sessionId,
							role: "user",
							time: { created: Date.now() },
							agent: "build",
							model: { providerID: "opencode", modelID },
						},
					},
				},
				{
					type: "message.part.updated",
					properties: {
						part: {
							id: `prt_compact_${index}`,
							sessionID: sessionId,
							messageID: properties.messageID,
							type: "compaction",
							auto: false,
						},
					},
				},
				{ type: "message.updated", properties: { info: summaryInfo } },
				{
					type: "session.status",
					properties: { sessionID: sessionId, status: { type: "busy" } },
				},
			]);
			const unrelated = await client.waitForTranscriptMessage(
				(message) => message.id === `msg_unrelated_tui_${index}`,
				sessionId,
			);
			expect(unrelated.inputId).toBeUndefined();
			if (mode !== "legacy-only" && mode !== "summary-only") {
				relay.mock.injectSSEEvents([
					{ type: "session.next.compaction.started", properties },
					{
						type: "session.next.compaction.delta",
						properties: { ...properties, text: "Summary in progress" },
					},
				]);
			}
			// The history adapter fills time.completed from updated_at even for
			// streaming rows. Wait for delivery by identity, then check the outcome.
			const announcedSummary = await client.waitForTranscriptMessage(
				(message) => message.id === summaryId,
				sessionId,
			);
			expect(announcedSummary.contextTokens).toBeUndefined();
			const legacy = () =>
				relay.mock.injectSSEEvents([
					{ type: "session.compacted", properties: { sessionID: sessionId } },
				]);
			const next = () =>
				relay.mock.injectSSEEvents([
					{
						type: "session.next.compaction.ended",
						properties: {
							...properties,
							text: "Summary",
							recent: "Recent conversation",
						},
					},
				]);
			if (mode !== "summary-only") {
				if (mode === "legacy-first" || mode === "legacy-only") legacy();
				if (mode !== "legacy-only") next();
				if (mode === "next-first") legacy();
				if (mode !== "next-only") legacy();
				if (mode !== "legacy-only") next();
			}
			// A transport completion cannot claim success before the summary
			// message itself finishes. The rename fences the injected events.
			relay.mock.injectSSEEvents([
				{
					type: "session.updated",
					properties: {
						info: {
							id: sessionId,
							title: `Awaiting summary ${index}`,
						},
					},
				},
			]);
			await client.waitFor("shell", {
				predicate: (frame) =>
					frame["_tag"] === "upsert" &&
					(frame["item"] as { title: string }).title ===
						`Awaiting summary ${index}`,
			});
			expect(
				(await persistedCompactions(relay, sessionId)).events,
			).toHaveLength(index);
			const notice = client.waitForTranscriptMessage(
				(message) =>
					message.parts?.some(
						(part) =>
							part.type === "compaction" && part.text === "Context compacted",
					) === true,
				sessionId,
			);
			const ended = client.waitForTurnEnd(sessionId);
			// The summary is billed against the old large context. Its usage must
			// not resurrect that context gauge after the compaction notice.
			const summary = client.waitForTranscriptMessage(
				(message) => message.id === summaryId && message.contextTokens === 0,
				sessionId,
			);
			relay.mock.injectSSEEvents([
				{
					type: "message.updated",
					properties: {
						info: {
							...summaryInfo,
							time: { ...summaryInfo.time, completed: Date.now() },
						},
					},
				},
				{
					type: "session.status",
					properties: { sessionID: sessionId, status: { type: "idle" } },
				},
			]);
			const [row, summaryMessage, message] = await Promise.all([
				ended,
				summary,
				notice,
			]);
			finishSummarize();
			expect(row.status).toBe("idle");
			expect(row.compacting).toBeUndefined();
			const echo = await client.waitForTranscriptMessage(
				(message) =>
					message.id === properties.messageID && message.inputId === inputId,
				sessionId,
			);
			const stored = await persistedCompactions(relay, sessionId);
			expect(stored.events.map((event) => JSON.parse(event.data))).toEqual(
				Array.from({ length: index + 1 }, () => ({
					sessionId,
					state: "completed",
					detail: "Context compacted",
				})),
			);
			expect(stored.parts).toHaveLength(index + 1);
			evidence.push({
				request,
				announcedSummary,
				message,
				row,
				summaryMessage,
				echo,
				stored,
			});
		}
		// An older keyed completion may be redelivered after a newer cycle.
		const cursor = client.getReceived().length;
		relay.mock.injectSSEEvents([
			{
				type: "session.next.compaction.ended",
				properties: {
					sessionID: sessionId,
					messageID: "msg_compact_0",
					timestamp: Date.now(),
					reason: "manual",
					text: "Summary",
					recent: "Recent conversation",
				},
			},
			{
				type: "session.updated",
				properties: {
					info: {
						id: sessionId,
						projectID: "compaction-test",
						directory: process.cwd(),
						title: "Compaction replay checked",
						version: "1.3.0",
						time: { created: Date.now(), updated: Date.now() },
					},
				},
			},
		]);
		await client.waitFor("shell", {
			cursor,
			predicate: (frame) =>
				frame["_tag"] === "upsert" &&
				(frame["item"] as { id: string; title: string }).id === sessionId &&
				(frame["item"] as { title: string }).title ===
					"Compaction replay checked",
		});

		const reconnected = await relay.connectWsClient();
		await reconnected.viewSession(sessionId);
		await reconnected.waitForTranscriptMessage(
			(message) =>
				message.parts?.some((part) => part.type === "compaction") === true,
			sessionId,
		);
		const history = await reconnected.loadMoreHistory(sessionId);
		const transcript = applyTranscriptEnvelope(
			{
				rows: [],
				pending: [],
				hwm: null,
				hasMore: false,
				status: { _tag: "cold" },
				project: "integration-test",
				waiting: new Map(),
				partOrder: new Map(),
			},
			{
				_tag: "snapshot",
				rows: history.messages.flatMap(detailRowsOf),
				sequence: 1,
			},
		);
		openSessionForSetup(sessionId, "integration-test");
		applyGetModelsResponse(await client.getModels(sessionId), sessionId);
		const messages = testMessages(sessionId);
		messages.contextPercent = 85;
		setMessages(messages, historyToChatMessages(transcript.rows));
		restoreContextFromMessages(messages);
		expect(messages.contextPercent).toBe(0);
		expect((await persistedCompactions(relay, sessionId)).parts).toHaveLength(
			2,
		);
		expect((await persistedCompactions(relay, sessionId)).events).toHaveLength(
			2,
		);
		saveEvidence(mode, {
			sessionId,
			evidence,
			history,
			contextPercent: messages.contextPercent,
		});
	}, 45_000);

	it.each([
		"/compact explain this",
		"Please run /compact",
	])("keeps a non-bare command as ordinary prompt text (%s)", async (text) => {
		const relay = await createRelayHarness(recording(), {
			defaultModel: "opencode/big-pickle",
		});
		harness = relay;
		const client = await relay.connectWsClient();
		await client.waitForInitialState();
		const sessionId = client.getActiveSessionId();
		await client.sendMessage(text);
		await client.waitForTurnEnd();
		const prompts = relay.mock.requestBodies.filter(
			(request) => request.path === `/session/${sessionId}/prompt_async`,
		);
		expect(prompts).toHaveLength(1);
		expect(JSON.parse(prompts[0]?.body ?? "null")).toMatchObject({
			parts: [{ type: "text", text }],
		});
		expect(
			relay.mock.requestBodies.some((request) =>
				request.path.endsWith("/summarize"),
			),
		).toBe(false);
		saveEvidence(
			text.startsWith("/") ? "command-with-arguments" : "embedded-command",
			prompts,
		);
	});

	it("keeps a failed submitted summarize indeterminate until Stop", async () => {
		const relay = await createRelayHarness(recording(500), {
			defaultModel: "opencode/big-pickle",
		});
		harness = relay;
		const client = await relay.connectWsClient();
		await client.waitForInitialState();
		const sessionId = client.getActiveSessionId();
		if (!sessionId) throw new Error("No OpenCode session was created");
		seedNativeUserTurn(relay, sessionId, "big-pickle");
		client.clearReceived();
		await client.sendMessage("/compact");
		const notice = await client.waitForTranscriptMessage(
			(message) =>
				message.parts?.some(
					(part) => part.type === "compaction" && part["failed"] === true,
				) === true,
		);
		const stored = await persistedCompactions(relay, sessionId);
		expect(stored.events).toHaveLength(1);
		expect(stored.parts).toHaveLength(1);
		expect(JSON.parse(stored.events[0]?.data ?? "null")).toMatchObject({
			state: "failed",
		});
		const state = () =>
			Effect.runPromise(
				Effect.gen(function* () {
					return yield* (yield* SqlClient.SqlClient)`SELECT run.status, run.started_at, command.error_code FROM provider_runs run
				JOIN provider_command_outbox command ON command.run_id = run.id WHERE run.session_id = ${sessionId}`;
				}).pipe(
					Effect.provide(SqliteClient.layer({ filename: relay.eventsDbPath })),
				),
			);
		await expect.poll(state).toEqual([
			{
				status: "pending",
				started_at: null,
				error_code: "delivery_indeterminate",
			},
		]);
		relay.mock.setExactResponse(
			"POST",
			`/session/${sessionId}/abort`,
			200,
			true,
		);
		await client.cancelSession(sessionId);
		await expect
			.poll(state)
			.toEqual([
				{ status: "interrupted", started_at: null, error_code: "interrupted" },
			]);
		saveEvidence("summarize-failed", { notice, stored, state: await state() });
	});

	it("translates delta-first progress and a provider compaction error", async () => {
		const relay = await createRelayHarness(recording(), {
			defaultModel: "opencode/big-pickle",
		});
		harness = relay;
		const client = await relay.connectWsClient();
		await client.waitForInitialState();
		const sessionId = client.getActiveSessionId();
		if (!sessionId) throw new Error("No OpenCode session was created");
		seedNativeUserTurn(relay, sessionId, "big-pickle");
		let finishSummarize = () => {};
		relay.mock.summarizeHold = new Promise<void>((resolve) => {
			finishSummarize = resolve;
		});
		await client.sendMessage("/compact");
		await expect
			.poll(() =>
				relay.mock.requestBodies.some(
					(request) => request.path === `/session/${sessionId}/summarize`,
				),
			)
			.toBe(true);
		relay.mock.injectSSEEvents([
			{
				type: "session.status",
				properties: { sessionID: sessionId, status: { type: "busy" } },
			},
			{
				type: "session.next.compaction.delta",
				properties: {
					sessionID: sessionId,
					messageID: "msg_failed_compact",
					timestamp: Date.now(),
					text: "Partial summary",
				},
			},
			{
				type: "message.updated",
				properties: {
					info: {
						id: "msg_failed_compact",
						sessionID: sessionId,
						role: "user",
						time: { created: Date.now() },
					},
				},
			},
			{
				type: "message.part.updated",
				properties: {
					part: {
						id: "prt_failed_compact",
						sessionID: sessionId,
						messageID: "msg_failed_compact",
						type: "compaction",
						auto: false,
					},
				},
			},
			{
				type: "session.error",
				properties: {
					sessionID: sessionId,
					error: {
						name: "UnknownError",
						data: { message: "Summary unavailable" },
					},
				},
			},
			{
				type: "session.status",
				properties: { sessionID: sessionId, status: { type: "idle" } },
			},
		]);
		const notice = await client.waitForTranscriptMessage(
			(message) =>
				message.parts?.some(
					(part) => part.type === "compaction" && part["failed"] === true,
				) === true,
		);
		const stored = await persistedCompactions(relay, sessionId);
		const echo = await client.waitForTranscriptMessage(
			(message) =>
				message.id === "msg_failed_compact" && message.inputId !== undefined,
			sessionId,
		);
		finishSummarize();
		expect(stored.events.map((event) => JSON.parse(event.data))).toEqual([
			{
				sessionId,
				state: "failed",
				detail: "Compaction failed: Summary unavailable",
			},
		]);
		saveEvidence("provider-compaction-error", { notice, stored, echo });
	});
});

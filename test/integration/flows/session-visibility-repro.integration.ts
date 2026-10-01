// Reproduces two reported bugs at the relay-harness seam:
//
//  Bug A ("two tabs, one empty"): a fresh client opening a session with
//    messages must be able to load a populated transcript page.
//
//  Bug B ("new session missing from sidebar"): after CreateSession with an
//    OpenCode providerId, the viewed family that follows must
//    include the new session (read-model projection race).

import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import {
	afterAll,
	assert,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { makeReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";
import type {
	OpenCodeInteraction,
	OpenCodeRecording,
} from "../../e2e/fixtures/recorded/types.js";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";
import { TestWsClient } from "../helpers/test-ws-client.js";

type DifferentialPart = {
	id: string;
	type: string;
	text?: string | undefined;
	tool?: string | undefined;
	mime?: string | undefined;
	filename?: string | undefined;
	url?: string | undefined;
	state?: { metadata?: Record<string, unknown> } | undefined;
};

type DifferentialMessage = {
	id: string;
	role?: string | undefined;
	text?: string | undefined;
	time?: { created?: number | undefined } | undefined;
	parts?: readonly DifferentialPart[] | undefined;
};

type DifferentialHistory = {
	messages: readonly DifferentialMessage[];
	hasMore: boolean;
};

function sse(
	type: string,
	properties: Record<string, unknown>,
): Extract<OpenCodeInteraction, { kind: "sse" }> {
	return { kind: "sse", type, properties, delayMs: 0 };
}

function recordingWithFirstPromptSse(
	name: string,
	build: (sessionId: string) => OpenCodeInteraction[],
): { recording: OpenCodeRecording; sessionId: string; prompt: string } {
	const base = loadOpenCodeRecording("chat-simple");
	const interactions: OpenCodeInteraction[] = base.interactions.filter(
		(entry) => entry.kind !== "sse",
	);
	const promptIndex = interactions.findIndex(
		(entry) =>
			entry.kind === "rest" &&
			entry.method === "POST" &&
			entry.path.includes("/prompt_async"),
	);
	const prompt = interactions[promptIndex];
	if (promptIndex < 0 || prompt?.kind !== "rest") {
		throw new Error("chat-simple recording has no prompt_async interaction");
	}
	const sessionId = /\/session\/([^/]+)\/prompt_async/.exec(prompt.path)?.[1];
	const promptText =
		prompt.requestBody &&
		typeof prompt.requestBody === "object" &&
		"parts" in prompt.requestBody &&
		Array.isArray(prompt.requestBody.parts) &&
		typeof prompt.requestBody.parts[0]?.text === "string"
			? prompt.requestBody.parts[0].text
			: "test prompt";
	if (!sessionId) throw new Error("chat-simple prompt path has no session id");

	interactions.splice(promptIndex + 1, 0, ...build(sessionId));
	return {
		recording: { ...base, name, interactions },
		sessionId,
		prompt: promptText,
	};
}

// Schema-complete message infos: loadPreRenderedHistory decodes REST bodies
// against OpenCodeMessageSchema, which requires agent/model on user messages
// and parentID/modelID/providerID/mode/path/cost/tokens on assistant
// messages. Minimal infos fail decode and silently downgrade the "REST" side
// of the differential to the projection fallback — trivial parity.
function userInfo(sessionId: string, id: string, created: number) {
	return {
		id,
		sessionID: sessionId,
		role: "user",
		time: { created },
		agent: "build",
		model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
	};
}

function assistantInfo(
	sessionId: string,
	id: string,
	created: number,
	completed?: number,
) {
	return {
		id,
		sessionID: sessionId,
		role: "assistant",
		time: { created, ...(completed != null ? { completed } : {}) },
		parentID: "",
		modelID: "claude-sonnet-4-5",
		providerID: "anthropic",
		mode: "build",
		path: { cwd: "/", root: "/" },
		cost: 0,
		tokens: {
			input: 10,
			output: 5,
			reasoning: 0,
			cache: { read: 0, write: 0 },
		},
	};
}

function paginationSse(
	sessionId: string,
	count: number,
): OpenCodeInteraction[] {
	const interactions: OpenCodeInteraction[] = [];
	for (let index = 1; index <= count; index++) {
		const suffix = String(index).padStart(3, "0");
		const messageId = `msg-${suffix}`;
		const role = index % 2 === 1 ? "user" : "assistant";
		const created = 1_000_000 + index;
		interactions.push(
			sse("message.updated", {
				sessionID: sessionId,
				info:
					role === "assistant"
						? assistantInfo(sessionId, messageId, created, created + 1)
						: userInfo(sessionId, messageId, created),
			}),
			sse("message.part.updated", {
				sessionID: sessionId,
				part: {
					id: `part-${suffix}`,
					sessionID: sessionId,
					messageID: messageId,
					type: "text",
					text: `text-${suffix}`,
				},
			}),
		);
	}
	return interactions;
}

/**
 * Wait until the projection has ingested a given message id.
 *
 * These synthetic streams deliver text as settled `message.part.updated`
 * parts, never `message.part.delta`, so no `delta` frame is ever broadcast —
 * waiting for one just burns the timeout. What each differential actually
 * needs is "the projection has caught up", so ask the projection directly.
 */
async function waitForProjectedMessage(
	dbPath: string,
	sessionId: string,
	messageId: string,
	timeoutMs = 20_000,
): Promise<void> {
	await vi.waitFor(
		async () => {
			const projected = await projectedHistory(dbPath, sessionId, 200);
			expect(
				projected.history.messages.some((message) => message.id === messageId),
			).toBe(true);
		},
		{ timeout: timeoutMs },
	);
}

function readStore<A, E>(
	dbPath: string,
	read: Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> {
	return Effect.runPromise(
		read.pipe(Effect.provide(SqliteClient.layer({ filename: dbPath }))),
	);
}

async function projectedHistory(
	dbPath: string,
	sessionId: string,
	pageSize = 50,
	before?: string,
) {
	const page = await readStore(
		dbPath,
		Effect.flatMap(makeReadQueryEffect, (readQuery) =>
			readQuery.readSessionTranscriptPage(sessionId, {
				limit: pageSize,
				...(before ? { before } : {}),
			}),
		),
	);
	return {
		kind: "rest-history" as const,
		history: {
			messages: messageRowsToHistory(page.messages, { pageSize }).messages,
			hasMore: page.hasMore,
		},
	};
}

// These repros model a user whose default is a Claude model: sessions start
// as local Claude rows and materialize into OpenCode on the first send.
/**
 * Bind a fresh session to the OpenCode engine (REPRO-C's materialization
 * pattern). Without this the default session runs on the Claude provider and
 * never touches the mock — the "differential" would silently compare the
 * projection with itself. Returns the local session id; the first sendMessage
 * to it materializes an OpenCode session returned by SendMessage.
 */
async function bindOpenCodeSession(
	client: TestWsClient,
	title: string,
): Promise<string> {
	const modelList = await client.waitFor("model_list");
	const providers = modelList["providers"] as Array<{
		id: string;
		models: Array<{ id: string }>;
	}>;
	const provider = providers?.find(
		(candidate) => candidate.id !== "claude" && candidate.models.length > 0,
	);
	if (!provider) throw new Error("model_list has no OpenCode provider");
	const model = provider.models[0];
	if (!model) throw new Error("OpenCode provider has no models");

	const created = await client.createSession(title, { instanceId: "claude" });
	const localId = created["id"] as string;
	if (!localId) throw new Error("createSession returned no id");
	client.clearReceived();
	await client.switchModel(model.id, provider.id, localId);
	await client.waitFor("model_info", {
		predicate: (message) =>
			message["model"] === model.id && message["provider"] === provider.id,
	});
	client.clearReceived();
	return localId;
}

/** Send the first message to a bound session and wait for materialization. */
async function materializeOpenCodeTurn(
	client: TestWsClient,
	localId: string,
	prompt: string,
): Promise<string> {
	const dispatchedId = await client.sendMessage(prompt, {
		sessionId: localId,
		originId: client.getClientId(),
	});
	expect(dispatchedId).not.toBe(localId);
	return dispatchedId;
}

async function runPaginationDifferential(count: number) {
	const synthetic = recordingWithFirstPromptSse(
		`pagination-${count}`,
		(sessionId) => paginationSse(sessionId, count),
	);
	const paginationHarness = await createRelayHarness(synthetic.recording);
	const dbPath = paginationHarness.eventsDbPath;
	let client1: TestWsClient | undefined;
	let client2: TestWsClient | undefined;
	try {
		client1 = await paginationHarness.connectWsClient();
		await client1.waitForInitialState();
		const localId = await bindOpenCodeSession(client1, `Pagination ${count}`);
		// The real prompt fires the mock's first SSE segment (the synthetic
		// stream), remapped onto the materialized OpenCode session id.
		const sessionId = await materializeOpenCodeTurn(
			client1,
			localId,
			synthetic.prompt,
		);
		const lastMessageId = `msg-${String(count).padStart(3, "0")}`;
		await waitForProjectedMessage(dbPath, sessionId, lastMessageId);
		await vi.waitFor(
			async () => {
				expect(
					JSON.stringify(await projectedHistory(dbPath, sessionId, 200)),
				).toContain(`text-${String(count).padStart(3, "0")}`);
			},
			{ timeout: 20_000 },
		);

		client2 = new TestWsClient(
			`ws://127.0.0.1:${paginationHarness.relayPort}/ws?session=${sessionId}`,
		);
		await client2.waitForOpen();
		await client2.waitForInitialState();
		await client2.viewSession(sessionId);
		const served = await client2.loadMoreHistory(sessionId);
		const providerHistory = new SessionManager({
			client: paginationHarness.stack.client,
		});
		const rest = await providerHistory.loadPreRenderedHistory(sessionId);
		const projected = await projectedHistory(dbPath, sessionId, 50);
		const before = served.messages[0]?.id;
		if (!before) throw new Error("served page has no cursor");
		const older = await client2.loadMoreHistory(sessionId, before);
		const projectedOlder = await projectedHistory(
			dbPath,
			sessionId,
			50,
			before,
		);
		expect(projected.kind).toBe("rest-history");
		const projectedRest =
			projected.kind === "rest-history"
				? (projected.history as DifferentialHistory)
				: { messages: [], hasMore: false };
		const projectedOlderRest =
			projectedOlder.kind === "rest-history"
				? (projectedOlder.history as DifferentialHistory)
				: { messages: [], hasMore: false };
		const summarize = (
			messages: readonly {
				id: string;
				role?: string | undefined;
				text?: string | undefined;
				parts?:
					| readonly { type: string; text?: string | undefined }[]
					| undefined;
			}[],
		) =>
			messages.map((message) => ({
				id: message.id,
				role: message.role,
				text:
					message.text ??
					message.parts
						?.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("") ??
					"",
			}));

		return {
			restSummary: summarize(rest.messages),
			servedSummary: summarize(served.messages),
			projectedSummary: summarize(projectedRest.messages),
			restHasMore: rest.hasMore,
			servedHasMore: served.hasMore,
			projectedHasMore: projectedRest.hasMore,
			olderSummary: summarize(older.messages),
			projectedOlderSummary: summarize(projectedOlderRest.messages),
			olderHasMore: older.hasMore,
			projectedOlderHasMore: projectedOlderRest.hasMore,
			// The REST timestamp proves this comparison uses provider data; the
			// projection substitutes row wall-clock timestamps.
			restFirstCreated: rest.messages[0]?.time?.created,
		};
	} finally {
		await client2?.close().catch(() => {});
		await client1?.close().catch(() => {});
		await paginationHarness.stop();
	}
}

describe("Integration: Session Visibility Repros", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness("chat-simple");
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	beforeEach(async () => {
		harness.mock.resetQueues();
		await vi.waitFor(() => {
			expect(harness.stack.sseStream.getHealth().connected).toBe(true);
		});
	});

	it("second client connecting with ?session= gets populated history after a turn", async () => {
		const client1 = await harness.connectWsClient();
		await client1.waitForInitialState();
		const sessionId = client1.getActiveSessionId() ?? "";
		expect(sessionId).toBeTruthy();
		client1.clearReceived();

		// Run a full turn so the session has at least one user + assistant message.
		await client1.sendMessage("Reply with just the word 'pong'.");
		await client1.waitFor("done");

		await vi.waitFor(
			async () => {
				const projected = await projectedHistory(
					harness.eventsDbPath,
					sessionId,
				);
				expect(projected.kind).toBe("rest-history");
				if (projected.kind === "rest-history") {
					expect(
						projected.history.messages.some(
							(message) =>
								message.role === "assistant" &&
								JSON.stringify(message).includes("pong"),
						),
					).toBe(true);
				}
			},
			{ timeout: 10_000 },
		);

		// Fresh client (second browser tab) opens the same session URL.
		const client2 = new TestWsClient(
			`ws://127.0.0.1:${harness.relayPort}/ws?session=${sessionId}`,
		);
		await client2.waitForOpen();
		await client2.waitForInitialState();
		await client2.viewSession(sessionId as string);
		const history = await client2.loadMoreHistory(sessionId as string);
		expect(history.messages.length).toBeGreaterThan(0);
		// The history must carry actual content — a skeleton of empty
		// messages reproduces the "navigate back and the message is gone" bug.
		expect(JSON.stringify(history.messages)).toContain("pong");

		await client2.close();
		await client1.close();
	}, 20_000);

	it("materialized session: first send keeps message visible, refreshes its family, and survives a second tab", async () => {
		const client1 = await harness.connectWsClient();
		await client1.waitForInitialState();
		const detourId = client1.getActiveSessionId();
		if (!detourId) throw new Error("No initial session");

		// Providers come from the init model_list broadcast.
		const modelList = await client1.waitFor("model_list");
		const providers = modelList["providers"] as Array<{
			id: string;
			models: Array<{ id: string }>;
		}>;
		const provider = providers?.find((p) => p.models.length > 0);
		expect(provider).toBeDefined();
		assert.exists(provider, "expected a provider with models");
		const model = provider.models[0];
		assert.exists(model, "expected the provider to have a model");

		// 1. New session → local claude placeholder row.
		const created = await client1.createSession("Materialize Repro", {
			instanceId: "claude",
		});
		const localId = created["id"] as string;
		expect(localId).toBeTruthy();

		// 2. User selects an OpenCode model for the session (unbinds/rebinds engine).
		const providerId = provider.id;
		client1.clearReceived();
		await client1.switchModel(model.id, providerId, localId);
		await client1.waitFor("model_info", {
			predicate: (message) =>
				message["model"] === model.id && message["provider"] === providerId,
		});
		client1.clearReceived();

		// 3. First message → prepareTurnSession materializes an OpenCode session.
		const newId = await client1.sendMessage(
			"Reply with just the word 'pong'.",
			{
				sessionId: localId,
				originId: client1.getClientId(),
			},
		);
		// eslint-disable-next-line no-console
		console.log(`[REPRO-C] materialized ${localId} -> ${newId}`);
		expect(newId).not.toBe(localId);

		// Bug 1 (server contract): the echo for the materialized session must be
		// renderable by the sender — the optimistic copy lives in the OLD slot,
		// so the echo must NOT carry the sender's originId.
		const userMsg = await client1.waitFor("user_message", {
			predicate: (m) => m["sessionId"] === newId,
		});
		// eslint-disable-next-line no-console
		console.log(
			`[REPRO-C] user_message originId=${String(userMsg["originId"])}`,
		);
		expect(userMsg["originId"]).toBeUndefined();

		// Bug 2: the viewed family after materialization includes the session.
		const list = await client1.waitFor("session_family", {
			predicate: (m) => m["rootId"] === newId,
		});
		const ids = (list["sessions"] as Array<{ id: string }>).map((s) => s.id);
		// eslint-disable-next-line no-console
		console.log(`[REPRO-C] post-materialize list=${JSON.stringify(ids)}`);
		expect(ids).toContain(newId);

		// Let the turn complete and the pipeline persist.
		await client1.waitFor("done", { timeout: 10_000 });
		await vi.waitFor(
			async () => {
				const projected = await projectedHistory(harness.eventsDbPath, newId);
				expect(projected.kind).toBe("rest-history");
				if (projected.kind === "rest-history") {
					expect(
						projected.history.messages.some(
							(message) =>
								message.role === "assistant" &&
								JSON.stringify(message).includes("pong"),
						),
					).toBe(true);
				}
			},
			{ timeout: 10_000 },
		);

		// Bug 4: a second tab opening the materialized session URL must get
		// populated history.
		const client2 = new TestWsClient(
			`ws://127.0.0.1:${harness.relayPort}/ws?session=${newId}`,
		);
		await client2.waitForOpen();
		await client2.waitForInitialState();
		await client2.viewSession(newId);
		const history2 = await client2.loadMoreHistory(newId);
		expect(history2.messages.length).toBeGreaterThan(0);
		// Content, not just structure — the user's message text must survive.
		expect(JSON.stringify(history2.messages)).toContain("pong");

		// Same-client navigate away and back (the ViewSession path): the
		// history must still carry the sent message, and the switch must not
		// surface error frames.
		expect(detourId).not.toBe(newId);
		client1.clearReceived();
		await client1.viewSession(detourId);
		client1.clearReceived();
		await client1.viewSession(newId);
		const back = await client1.loadMoreHistory(newId);
		expect(JSON.stringify(back.messages)).toContain("pong");
		const errorFrames = client1
			.getReceived()
			.filter((m) => m.type === "error" || m.type === "system_error");
		// eslint-disable-next-line no-console
		console.log(`[REPRO-D] errorFrames=${JSON.stringify(errorFrames)}`);
		expect(errorFrames).toEqual([]);

		await client2.close();
		await client1.close();
	}, 30_000);

	it("projected history matches provider REST history content after a turn", async () => {
		// Own harness: the projection can only contain what actually streamed
		// through this relay, so the turn must not race other tests' replay
		// queue consumption on the shared recording session.
		const textHarness = await createRelayHarness("chat-simple");
		const textDbPath = textHarness.eventsDbPath;
		const client1 = await textHarness.connectWsClient();
		await client1.waitForInitialState();
		const localId = await bindOpenCodeSession(client1, "Text Differential");
		const sessionId = await materializeOpenCodeTurn(
			client1,
			localId,
			"Reply with just the word 'pong'.",
		);
		await client1.waitFor("done");
		await vi.waitFor(
			async () => {
				const projected = await projectedHistory(textDbPath, sessionId);
				expect(projected.kind).toBe("rest-history");
				if (projected.kind === "rest-history") {
					expect(projected.history.messages.length).toBeGreaterThanOrEqual(2);
					expect(
						projected.history.messages.some(
							(message) =>
								message.role === "assistant" &&
								JSON.stringify(message).includes("pong"),
						),
					).toBe(true);
				}
			},
			{ timeout: 10_000 },
		);

		// A fresh client requests its own transcript page.
		const client2 = new TestWsClient(
			`ws://127.0.0.1:${textHarness.relayPort}/ws?session=${sessionId}`,
		);
		await client2.waitForOpen();
		await client2.waitForInitialState();
		await client2.viewSession(sessionId);
		const restHistory = await client2.loadMoreHistory(sessionId);

		// Projection-served history: the exact adapter chain the resolvers use
		// when falling back to (or preferring) the read model.
		const projected = await projectedHistory(textDbPath, sessionId, 50);

		const summarize = (
			msgs: readonly {
				role?: string | undefined;
				text?: string | undefined;
				parts?:
					| readonly { type: string; text?: string | undefined }[]
					| undefined;
			}[],
		) =>
			msgs.map((m) => ({
				role: m.role,
				text: (
					m.text ??
					m.parts
						?.filter((p) => p.type === "text")
						.map((p) => p.text)
						.join("") ??
					""
				).trim(),
			}));

		const restSummary = summarize(restHistory.messages);
		const projectedSummary =
			projected.kind === "rest-history"
				? summarize(
						projected.history.messages as readonly {
							role?: string;
							text?: string;
						}[],
					)
				: [];
		// eslint-disable-next-line no-console
		console.log(
			`[REPRO-E] rest=${JSON.stringify(restSummary)}\n[REPRO-E] projected=${JSON.stringify(projectedSummary)}`,
		);
		expect(projectedSummary).toEqual(restSummary);

		await client2.close();
		await client1.close();
		await textHarness.stop();
	}, 45_000);

	it("projected history matches REST for a tool-call turn", async () => {
		const toolHarness = await createRelayHarness("chat-tool-call");
		const toolDbPath = toolHarness.eventsDbPath;
		try {
			const client1 = await toolHarness.connectWsClient();
			await client1.waitForInitialState();
			const localId = await bindOpenCodeSession(client1, "Tool Differential");
			const sessionId = await materializeOpenCodeTurn(
				client1,
				localId,
				"List the files in the current directory.",
			);
			// This recording has no trailing done frame; wait for its tool result.
			await client1.waitFor("tool_result", { timeout: 15_000 });
			await vi.waitFor(
				async () => {
					expect(
						JSON.stringify(await projectedHistory(toolDbPath, sessionId)),
					).toContain("0.1.0");
				},
				{ timeout: 20_000 },
			);

			const client2 = new TestWsClient(
				`ws://127.0.0.1:${toolHarness.relayPort}/ws?session=${sessionId}`,
			);
			await client2.waitForOpen();
			await client2.waitForInitialState();
			await client2.viewSession(sessionId);
			const restHistory = await client2.loadMoreHistory(sessionId);

			const projected = await projectedHistory(toolDbPath, sessionId, 50);

			type Msg = {
				role?: string | undefined;
				text?: string | undefined;
				parts?:
					| readonly {
							type: string;
							text?: string | undefined;
							tool?: string | undefined;
					  }[]
					| undefined;
			};
			// Documented, frontend-equivalent divergences between REST and the
			// projection (both sides render identically — see history-logic.ts):
			//  - structural parts (step-start/step-finish/snapshot/agent) are
			//    never persisted and never rendered → excluded from parity;
			//  - REST names thinking parts "reasoning", the projection stores
			//    "thinking" → normalized to one name;
			//  - REST carries raw tool names ("read"), the projection stores
			//    mapToolName-normalized ones ("Read") and the frontend applies
			//    mapToolName to REST parts at render time → compared caseless.
			const STRUCTURAL_PART_TYPES = new Set([
				"step-start",
				"step-finish",
				"snapshot",
				"agent",
			]);
			const summarize = (msgs: readonly Msg[]) =>
				msgs.map((m) => ({
					role: m.role,
					text: (
						m.text ??
						m.parts
							?.filter((p) => p.type === "text")
							.map((p) => p.text)
							.join("") ??
						""
					).trim(),
					parts: (m.parts ?? [])
						.filter((p) => !STRUCTURAL_PART_TYPES.has(p.type))
						.map((p) => {
							const type = p.type === "reasoning" ? "thinking" : p.type;
							return `${type}${p.tool ? `:${p.tool.toLowerCase()}` : ""}`;
						}),
				}));

			const restSummary = summarize(restHistory.messages);
			const projectedSummary =
				projected.kind === "rest-history"
					? summarize(projected.history.messages as readonly Msg[])
					: [];
			// eslint-disable-next-line no-console
			console.log(
				`[REPRO-F] rest=${JSON.stringify(restSummary)}\n[REPRO-F] projected=${JSON.stringify(projectedSummary)}`,
			);
			expect(projectedSummary).toEqual(restSummary);

			await client2.close();
			await client1.close();
		} finally {
			await toolHarness.stop();
		}
	}, 45_000);

	it("REPRO-G: projected history preserves subagent tool metadata", async () => {
		const synthetic = recordingWithFirstPromptSse(
			"subagent-tool-metadata",
			(sessionId) => [
				sse("message.updated", {
					sessionID: sessionId,
					info: userInfo(sessionId, "msg-user-g", 1_000),
				}),
				sse("message.part.updated", {
					sessionID: sessionId,
					part: {
						id: "part-user-g",
						sessionID: sessionId,
						messageID: "msg-user-g",
						type: "text",
						text: "Delegate this task",
					},
				}),
				sse("message.updated", {
					sessionID: sessionId,
					info: assistantInfo(sessionId, "msg-assistant-g", 2_000),
				}),
				...(["pending", "running", "completed"] as const).map((status) =>
					sse("message.part.updated", {
						sessionID: sessionId,
						part: {
							id: "part-tool-g",
							sessionID: sessionId,
							messageID: "msg-assistant-g",
							type: "tool",
							tool: "task",
							callID: "call-tool-g",
							state: {
								status,
								input: { description: "Delegate", prompt: "Do it" },
								...(status !== "pending"
									? {
											metadata: {
												sessionId: "ses_child_differential",
											},
										}
									: {}),
								...(status === "completed" ? { output: "done" } : {}),
							},
							time: {
								start: 2_100,
								...(status === "completed" ? { end: 2_200 } : {}),
							},
						},
					}),
				),
				sse("message.part.updated", {
					sessionID: sessionId,
					part: {
						id: "part-assistant-g",
						sessionID: sessionId,
						messageID: "msg-assistant-g",
						type: "text",
						text: "Delegation complete",
					},
				}),
				sse("message.updated", {
					sessionID: sessionId,
					info: assistantInfo(sessionId, "msg-assistant-g", 2_000, 2_300),
				}),
			],
		);
		const metadataHarness = await createRelayHarness(synthetic.recording);
		const dbPath = metadataHarness.eventsDbPath;
		let client1: TestWsClient | undefined;
		let client2: TestWsClient | undefined;
		try {
			client1 = await metadataHarness.connectWsClient();
			await client1.waitForInitialState();
			const localId = await bindOpenCodeSession(client1, "Metadata Repro");
			const sessionId = await materializeOpenCodeTurn(
				client1,
				localId,
				synthetic.prompt,
			);
			await client1.waitFor("tool_result", { timeout: 15_000 });
			await vi.waitFor(
				async () => {
					expect(
						JSON.stringify(await projectedHistory(dbPath, sessionId)),
					).toContain("Delegation complete");
				},
				{ timeout: 20_000 },
			);

			client2 = new TestWsClient(
				`ws://127.0.0.1:${metadataHarness.relayPort}/ws?session=${sessionId}`,
			);
			await client2.waitForOpen();
			await client2.waitForInitialState();
			await client2.viewSession(sessionId);
			const served = await client2.loadMoreHistory(sessionId);
			const rest = await new SessionManager({
				client: metadataHarness.stack.client,
			}).loadPreRenderedHistory(sessionId);
			const projected = await projectedHistory(dbPath, sessionId);
			expect(projected.kind).toBe("rest-history");
			const summarize = (messages: readonly DifferentialMessage[]) =>
				messages.map((message) => ({
					role: message.role,
					text:
						message.text ??
						message.parts
							?.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("") ??
						"",
					parts: (message.parts ?? []).map((part) =>
						part.type === "tool"
							? `tool:${String(part.state?.metadata?.["sessionId"] ?? "")}`
							: part.type,
					),
				}));
			const restSummary = summarize(rest.messages as DifferentialMessage[]);
			const projectedSummary =
				projected.kind === "rest-history"
					? summarize(projected.history.messages as DifferentialMessage[])
					: [];
			// eslint-disable-next-line no-console
			console.log(
				`[REPRO-G] rest=${JSON.stringify(restSummary)}\n[REPRO-G] projected=${JSON.stringify(projectedSummary)}`,
			);
			expect(projectedSummary).toEqual(restSummary);
			expect(summarize(served.messages)).toEqual(projectedSummary);
			expect(JSON.stringify(restSummary)).toContain("ses_child_differential");
			expect(JSON.stringify(projectedSummary)).toContain(
				"ses_child_differential",
			);
			// Recorded time proves the REST side really came from the provider
			// (the projection substitutes row wall-clock timestamps).
			expect(rest.messages[0]?.time?.created).toBe(1_000);
		} finally {
			await client2?.close().catch(() => {});
			await client1?.close().catch(() => {});
			await metadataHarness.stop();
		}
	}, 45_000);

	it("REPRO-H: projected history preserves file part identity", async () => {
		const synthetic = recordingWithFirstPromptSse(
			"file-part-history",
			(sessionId) => [
				sse("message.updated", {
					sessionID: sessionId,
					info: userInfo(sessionId, "msg-user-h", 1_000),
				}),
				sse("message.part.updated", {
					sessionID: sessionId,
					part: {
						id: "part-user-text-h",
						sessionID: sessionId,
						messageID: "msg-user-h",
						type: "text",
						text: "Inspect this image",
					},
				}),
				sse("message.part.updated", {
					sessionID: sessionId,
					part: {
						id: "part-file-h",
						sessionID: sessionId,
						messageID: "msg-user-h",
						type: "file",
						mime: "image/png",
						filename: "screenshot.png",
						url: "data:image/png;base64,AAAA",
					},
				}),
				sse("message.updated", {
					sessionID: sessionId,
					info: assistantInfo(sessionId, "msg-assistant-h", 2_000),
				}),
				sse("message.part.updated", {
					sessionID: sessionId,
					part: {
						id: "part-assistant-h",
						sessionID: sessionId,
						messageID: "msg-assistant-h",
						type: "text",
						text: "Image received",
					},
				}),
				sse("message.updated", {
					sessionID: sessionId,
					info: assistantInfo(sessionId, "msg-assistant-h", 2_000, 2_100),
				}),
			],
		);
		const fileHarness = await createRelayHarness(synthetic.recording);
		const dbPath = fileHarness.eventsDbPath;
		let client1: TestWsClient | undefined;
		let client2: TestWsClient | undefined;
		try {
			client1 = await fileHarness.connectWsClient();
			await client1.waitForInitialState();
			const localId = await bindOpenCodeSession(client1, "File Part Repro");
			const sessionId = await materializeOpenCodeTurn(
				client1,
				localId,
				synthetic.prompt,
			);
			// The synthetic stream has no done marker; wait for final assistant text.
			await waitForProjectedMessage(dbPath, sessionId, "msg-assistant-h");
			await vi.waitFor(
				async () => {
					expect(
						JSON.stringify(await projectedHistory(dbPath, sessionId)),
					).toContain("Image received");
				},
				{ timeout: 20_000 },
			);

			client2 = new TestWsClient(
				`ws://127.0.0.1:${fileHarness.relayPort}/ws?session=${sessionId}`,
			);
			await client2.waitForOpen();
			await client2.waitForInitialState();
			await client2.viewSession(sessionId);
			const served = await client2.loadMoreHistory(sessionId);
			const rest = await new SessionManager({
				client: fileHarness.stack.client,
			}).loadPreRenderedHistory(sessionId);
			const projected = await projectedHistory(dbPath, sessionId);
			expect(projected.kind).toBe("rest-history");
			const summarize = (messages: readonly DifferentialMessage[]) =>
				messages.map((message) => ({
					role: message.role,
					parts: (message.parts ?? []).map((part) =>
						part.type === "file"
							? `file:${part.mime}:${part.filename ?? ""}:${part.url}`
							: `${part.type}:${part.text ?? ""}`,
					),
				}));
			const restSummary = summarize(rest.messages as DifferentialMessage[]);
			const projectedMessages =
				projected.kind === "rest-history"
					? (projected.history.messages as DifferentialMessage[])
					: [];
			const projectedSummary = summarize(projectedMessages);
			// eslint-disable-next-line no-console
			console.log(
				`[REPRO-H] rest=${JSON.stringify(restSummary)}\n[REPRO-H] projected=${JSON.stringify(projectedSummary)}`,
			);
			expect(projectedSummary).toEqual(restSummary);
			expect(summarize(served.messages)).toEqual(projectedSummary);
			expect(
				projectedMessages
					.flatMap((message) => message.parts ?? [])
					.find((part) => part.type === "file"),
			).toMatchObject({
				mime: "image/png",
				filename: "screenshot.png",
				url: "data:image/png;base64,AAAA",
			});
			// Recorded time proves the REST side really came from the provider
			// (the projection substitutes row wall-clock timestamps).
			expect(rest.messages[0]?.time?.created).toBe(1_000);
		} finally {
			await client2?.close().catch(() => {});
			await client1?.close().catch(() => {});
			await fileHarness.stop();
		}
	}, 45_000);

	it("REPRO-I: permission-gated history matches REST and persists permission events", async () => {
		const permissionHarness = await createRelayHarness("permissions-bash");
		const dbPath = permissionHarness.eventsDbPath;
		let client1: TestWsClient | undefined;
		let client2: TestWsClient | undefined;
		try {
			client1 = await permissionHarness.connectWsClient();
			await client1.waitForInitialState();
			const localId = await bindOpenCodeSession(client1, "Permission Repro");
			const sessionId = await materializeOpenCodeTurn(
				client1,
				localId,
				"List the files in the current directory using bash: ls -la",
			);
			const requested = await client1.waitFor("permission_request", {
				timeout: 15_000,
			});
			await client1.respondPermission(
				requested["requestId"] as string,
				"allow",
			);
			await client1.waitFor("tool_result", { timeout: 20_000 });
			await vi.waitFor(
				async () => {
					const eventTypes = await readStore(
						dbPath,
						Effect.flatMap(
							SqlClient.SqlClient,
							(sql) =>
								sql<{
									type: string;
								}>`SELECT type FROM events WHERE session_id = ${sessionId} ORDER BY sequence`,
						),
					);
					expect(eventTypes.map((event) => event.type)).toContain(
						"permission.resolved",
					);
					expect(
						JSON.stringify(await projectedHistory(dbPath, sessionId)),
					).toContain("Files listed");
				},
				{ timeout: 20_000 },
			);

			client2 = new TestWsClient(
				`ws://127.0.0.1:${permissionHarness.relayPort}/ws?session=${sessionId}`,
			);
			await client2.waitForOpen();
			await client2.waitForInitialState();
			await client2.viewSession(sessionId);
			const rest = await client2.loadMoreHistory(sessionId);
			const projected = await projectedHistory(dbPath, sessionId as string);
			expect(projected.kind).toBe("rest-history");
			const summarize = (messages: readonly DifferentialMessage[]) =>
				messages.map((message) => ({
					role: message.role,
					text:
						message.text ??
						message.parts
							?.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("") ??
						"",
					parts: (message.parts ?? [])
						.filter((part) => part.type === "text" || part.type === "tool")
						.map((part) => part.type),
				}));
			const restSummary = summarize(rest.messages);
			const projectedSummary =
				projected.kind === "rest-history"
					? summarize(projected.history.messages as DifferentialMessage[])
					: [];
			// eslint-disable-next-line no-console
			console.log(
				`[REPRO-I] rest=${JSON.stringify(restSummary)}\n[REPRO-I] projected=${JSON.stringify(projectedSummary)}`,
			);
			expect(projectedSummary).toEqual(restSummary);

			const eventTypes = await readStore(
				dbPath,
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql<{ type: string }>`
						SELECT type FROM events WHERE session_id = ${sessionId as string} ORDER BY sequence`,
				),
			).then((rows) => rows.map((row) => row.type));
			// eslint-disable-next-line no-console
			console.log(
				`[REPRO-I] permissionEvents=${JSON.stringify(eventTypes.filter((type) => type.startsWith("permission.")))}`,
			);
			expect(eventTypes).toContain("permission.asked");
			expect(eventTypes).toContain("permission.resolved");
		} finally {
			await client2?.close().catch(() => {});
			await client1?.close().catch(() => {});
			await permissionHarness.stop();
		}
	}, 60_000);

	it("REPRO-J: 56-message history returns the newest 50 in ascending order", async () => {
		const result = await runPaginationDifferential(56);
		// eslint-disable-next-line no-console
		console.log(
			`[REPRO-J/56] rest=${JSON.stringify(result.restSummary)} hasMore=${result.restHasMore}\n[REPRO-J/56] projected=${JSON.stringify(result.projectedSummary)} hasMore=${result.projectedHasMore}`,
		);
		expect(result.projectedSummary).toEqual(result.restSummary);
		expect(result.servedSummary).toEqual(result.projectedSummary);
		expect(result.restSummary).toHaveLength(50);
		expect(result.restSummary[0]?.id).toBe("msg-007");
		expect(result.restSummary[49]?.id).toBe("msg-056");
		expect(result.restFirstCreated).toBe(1_000_007);
		expect(result.restHasMore).toBe(true);
		expect(result.servedHasMore).toBe(true);
		expect(result.projectedHasMore).toBe(true);
		expect(result.olderSummary).toEqual(result.projectedOlderSummary);
		expect(result.olderSummary).toHaveLength(6);
		expect(result.olderSummary[0]?.id).toBe("msg-001");
		expect(result.olderSummary[5]?.id).toBe("msg-006");
		expect(result.olderHasMore).toBe(false);
		expect(result.projectedOlderHasMore).toBe(false);
	}, 45_000);

	it("REPRO-J: exactly 50 messages preserves the accepted hasMore boundary divergence", async () => {
		const result = await runPaginationDifferential(50);
		// eslint-disable-next-line no-console
		console.log(
			`[REPRO-J/50] rest=${JSON.stringify(result.restSummary)} hasMore=${result.restHasMore}\n[REPRO-J/50] projected=${JSON.stringify(result.projectedSummary)} hasMore=${result.projectedHasMore}`,
		);
		expect(result.projectedSummary).toEqual(result.restSummary);
		expect(result.servedSummary).toEqual(result.projectedSummary);
		expect(result.restSummary).toHaveLength(50);
		expect(result.restFirstCreated).toBe(1_000_001);
		// REST uses >= page size conservatively, while projection over-fetch is
		// exact. REST's false positive only causes one empty older-page fetch.
		expect(result.restHasMore).toBe(true);
		expect(result.servedHasMore).toBe(false);
		expect(result.projectedHasMore).toBe(false);
		expect(result.olderSummary).toEqual(result.projectedOlderSummary);
		expect(result.olderSummary).toHaveLength(0);
	}, 45_000);

	it("session created with OpenCode providerId appears in its viewed family", async () => {
		const client1 = await harness.connectWsClient();
		await client1.waitForInitialState();
		client1.clearReceived();

		const switched = await client1.createSession("Sidebar Repro Session", {
			providerId: "opencode",
		});
		const newId = switched["id"] as string;
		expect(newId).toBeTruthy();

		const list = await client1.waitFor("session_family", {
			predicate: (m) => m["rootId"] === newId,
		});
		const ids = (list["sessions"] as Array<{ id: string }>).map((s) => s.id);
		// eslint-disable-next-line no-console
		console.log(`[REPRO-B] new=${newId} listed=${JSON.stringify(ids)}`);
		expect(ids).toContain(newId);

		await client1.close();
	}, 20_000);
});

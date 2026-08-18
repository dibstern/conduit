// test/unit/provider/claude/claude-provider-instance-live-settings.test.ts
// conduit keeps one SDK query() per session, so anything fixed at query
// creation — `effort`, and the `init` message the resolved model is read from —
// has to be refreshed explicitly when the user changes it mid-session.
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCapabilitiesService } from "../../../../src/lib/provider/claude/claude-capabilities-service.js";
import { ClaudeProviderInstance } from "../../../../src/lib/provider/claude/claude-provider-instance.js";
import type {
	ClaudeSessionContext,
	Query,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type {
	EventSink,
	ModelInfo,
} from "../../../../src/lib/provider/types.js";
import { getClaudeRuntimeSessionForTest } from "../../../helpers/claude-runtime-state.js";
import {
	createMockEventSink,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

const SONNET = "claude-sonnet-4-6";
const OPUS = "claude-opus-4-6";

const model = (id: string): ModelInfo => ({
	id,
	name: id,
	providerId: "claude",
	resolvedModel: id,
});

function makeCapabilitiesService(): ClaudeCapabilitiesService {
	return {
		get: vi.fn(() =>
			Effect.succeed({
				models: [model(SONNET), model(OPUS)],
				commands: [],
				agents: [],
			}),
		),
	};
}

/** Wrap a generator in the Query surface, exposing the spies tests assert on. */
function makeMockQuery(gen: AsyncGenerator<SDKMessage, void, unknown>) {
	const applyFlagSettings = vi.fn(async () => {});
	const setModel = vi.fn(async () => {});
	const query = Object.assign(gen, {
		interrupt: vi.fn(async () => {}),
		close: vi.fn(),
		setModel,
		setPermissionMode: vi.fn(async () => {}),
		streamInput: vi.fn(async () => {}),
		setMaxThinkingTokens: vi.fn(async () => {}),
		applyFlagSettings,
		initializationResult: vi.fn(async () => ({})),
		supportedCommands: vi.fn(async () => []),
		supportedModels: vi.fn(async () => []),
		supportedAgents: vi.fn(async () => []),
		mcpServerStatus: vi.fn(async () => []),
		getContextUsage: vi.fn(async () => ({})),
		reloadPlugins: vi.fn(async () => ({})),
		accountInfo: vi.fn(async () => ({})),
		rewindFiles: vi.fn(async () => ({ canRewind: false })),
		seedReadState: vi.fn(async () => {}),
		reconnectMcpServer: vi.fn(async () => {}),
		toggleMcpServer: vi.fn(async () => {}),
		setMcpServers: vi.fn(async () => ({})),
		stopTask: vi.fn(async () => {}),
		next: gen.next.bind(gen),
		return: gen.return.bind(gen),
		throw: gen.throw.bind(gen),
		[Symbol.asyncIterator]: () => gen,
	}) as unknown as Query;
	return { query, applyFlagSettings, setModel };
}

/** Shaped to satisfy ClaudeSDKSystemMessageSchema — the stream consumer
 *  schema-decodes every message and silently skips ones that fail. */
const initMessage = (modelId: string) =>
	({
		type: "system",
		subtype: "init",
		session_id: "sdk-1",
		uuid: "init-1",
		model: modelId,
		apiKeySource: "none",
		claude_code_version: "2.1.207",
		cwd: "/tmp",
		tools: [],
		mcp_servers: [],
		permissionMode: "default",
		slash_commands: [],
		output_style: "default",
		skills: [],
		plugins: [],
	}) as unknown as SDKMessage;

const assistantMessage = (uuid: string, modelId: string) =>
	({
		type: "assistant",
		uuid,
		session_id: "sdk-1",
		parent_tool_use_id: null,
		message: { model: modelId, content: [] },
	}) as unknown as SDKMessage;

/** actualModel of every turn.model_resolved the sink has seen, in order. */
function resolvedModels(sink: EventSink): string[] {
	const calls = (sink.push as unknown as { mock: { calls: unknown[][] } }).mock
		.calls;
	return calls
		.map(([event]) => event as { type: string; data: { actualModel: string } })
		.filter((event) => event.type === "turn.model_resolved")
		.map((event) => event.data.actualModel);
}

function resolvedTurns(sink: EventSink): Array<{
	turnId?: string;
	requestedModel?: string;
	expectedModel?: string;
	actualModel: string;
}> {
	const calls = (sink.push as unknown as { mock: { calls: unknown[][] } }).mock
		.calls;
	return calls
		.map(
			([event]) =>
				event as {
					type: string;
					data: {
						turnId?: string;
						requestedModel?: string;
						expectedModel?: string;
						actualModel: string;
					};
				},
		)
		.filter((event) => event.type === "turn.model_resolved")
		.map((event) => event.data);
}

async function waitForAssertion(assertion: () => void): Promise<void> {
	const deadline = Date.now() + 500;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			assertion();
			return;
		} catch (err) {
			lastError = err;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	assertion();
	if (lastError) throw lastError;
}

describe("ClaudeProviderInstance mid-session setting changes", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = join(tmpdir(), `conduit-claude-live-settings-${Date.now()}`);
		mkdirSync(workspace, { recursive: true });
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it("pushes effort changes to the live query and clears it on reset", async () => {
		const gates: Array<() => void> = [];
		const waits = [0, 1].map(
			() =>
				new Promise<void>((resolve) => {
					gates.push(resolve);
				}),
		);
		const gen = (async function* () {
			yield makeSuccessResult({ session_id: "sdk-1" }) as unknown as SDKMessage;
			await waits[0];
			yield makeSuccessResult({
				session_id: "sdk-1",
				total_cost_usd: 0.1,
			}) as unknown as SDKMessage;
			await waits[1];
			yield makeSuccessResult({
				session_id: "sdk-1",
				total_cost_usd: 0.2,
			}) as unknown as SDKMessage;
		})();
		const { query, applyFlagSettings } = makeMockQuery(gen);

		let createdWithEffort: string | undefined;
		const queryFactory = vi.fn((args: { options?: { effort?: string } }) => {
			createdWithEffort = args.options?.effort;
			return query;
		});
		const instance = new ClaudeProviderInstance({
			workspaceRoot: workspace,
			queryFactory,
			capabilitiesService: makeCapabilitiesService(),
		});
		const sink = createMockEventSink();
		const turnInput = (turnId: string, variant?: string) =>
			makeBaseSendTurnInput({
				sessionId: "s1",
				turnId,
				eventSink: sink,
				model: { providerId: "claude", modelId: SONNET },
				...(variant ? { variant } : {}),
			});

		// Turn 1 — effort is an option on the query the factory builds.
		const turn1 = await Effect.runPromise(
			instance.sendTurnEffect(turnInput("turn-1", "low")),
		);
		expect(turn1.status).toBe("completed");
		expect(createdWithEffort).toBe("low");
		expect(applyFlagSettings).not.toHaveBeenCalled();

		// Turn 2 — user raised effort. Same query, so it goes via flag settings.
		const turn2Promise = Effect.runPromise(
			instance.sendTurnEffect(turnInput("turn-2", "high")),
		);
		await waitForAssertion(() => {
			expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "high" });
			expect(
				getClaudeRuntimeSessionForTest<ClaudeSessionContext>(instance, "s1"),
			).toMatchObject({ currentVariant: "high" });
		});
		gates[0]?.();
		expect((await turn2Promise).status).toBe("completed");

		// Turn 3 — user reset to default; null clears the flag layer.
		const turn3Promise = Effect.runPromise(
			instance.sendTurnEffect(turnInput("turn-3")),
		);
		await waitForAssertion(() => {
			expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: null });
		});
		gates[1]?.();
		expect((await turn3Promise).status).toBe("completed");

		expect(queryFactory).toHaveBeenCalledTimes(1);
		expect(applyFlagSettings).toHaveBeenCalledTimes(2);
		expect(
			getClaudeRuntimeSessionForTest<ClaudeSessionContext>(instance, "s1"),
		).not.toHaveProperty("currentVariant");
	});

	it("re-reports the resolved model after a mid-session model change", async () => {
		let releaseTurn2: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseTurn2 = resolve;
		});
		const gen = (async function* () {
			yield initMessage(SONNET);
			yield assistantMessage("a1", SONNET);
			yield makeSuccessResult({ session_id: "sdk-1" }) as unknown as SDKMessage;
			await gate;
			yield assistantMessage("a2", OPUS);
			yield makeSuccessResult({
				session_id: "sdk-1",
				total_cost_usd: 0.1,
			}) as unknown as SDKMessage;
		})();
		const { query, setModel } = makeMockQuery(gen);

		const instance = new ClaudeProviderInstance({
			workspaceRoot: workspace,
			queryFactory: vi.fn(() => query),
			capabilitiesService: makeCapabilitiesService(),
		});
		const sink = createMockEventSink();

		await Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "s2",
					turnId: "turn-1",
					eventSink: sink,
					model: { providerId: "claude", modelId: SONNET },
				}),
			),
		);
		// init and the assistant message agree — no duplicate report.
		expect(resolvedModels(sink)).toEqual([SONNET]);

		const turn2Promise = Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "s2",
					turnId: "turn-2",
					eventSink: sink,
					model: { providerId: "claude", modelId: OPUS },
				}),
			),
		);
		// setModel lands at enqueue; the assistant message only flows once the
		// generator is released.
		await waitForAssertion(() => {
			expect(setModel).toHaveBeenCalledWith(OPUS);
		});
		releaseTurn2?.();
		expect((await turn2Promise).status).toBe("completed");
		expect(resolvedModels(sink)).toEqual([SONNET, OPUS]);
	});

	it("applies overlapping turn settings only at FIFO turn boundaries", async () => {
		const release: Array<() => void> = [];
		const gates = Array.from(
			{ length: 5 },
			() =>
				new Promise<void>((resolve) => {
					release.push(resolve);
				}),
		);
		const gen = (async function* () {
			yield initMessage(SONNET);
			await gates[0];
			yield makeSuccessResult({ session_id: "sdk-1" }) as unknown as SDKMessage;
			await gates[1];
			yield assistantMessage("a2", OPUS);
			await gates[2];
			yield makeSuccessResult({ session_id: "sdk-1" }) as unknown as SDKMessage;
			await gates[3];
			yield assistantMessage("a3", SONNET);
			await gates[4];
			yield makeSuccessResult({ session_id: "sdk-1" }) as unknown as SDKMessage;
		})();
		const { query, applyFlagSettings, setModel } = makeMockQuery(gen);
		const instance = new ClaudeProviderInstance({
			workspaceRoot: workspace,
			queryFactory: vi.fn(() => query),
			capabilitiesService: makeCapabilitiesService(),
		});
		const sink = createMockEventSink();
		const turnInput = (turnId: string, modelId: string, variant?: string) =>
			makeBaseSendTurnInput({
				sessionId: "s-overlap",
				turnId,
				eventSink: sink,
				model: { providerId: "claude", modelId },
				...(variant ? { variant } : {}),
			});

		const turnA = Effect.runPromise(
			instance.sendTurnEffect(turnInput("turn-a", SONNET)),
		);
		await waitForAssertion(() => {
			expect(resolvedTurns(sink)).toHaveLength(1);
		});

		const turnB = Effect.runPromise(
			instance.sendTurnEffect(turnInput("turn-b", OPUS, "high")),
		);
		const turnC = Effect.runPromise(
			instance.sendTurnEffect(turnInput("turn-c", SONNET, "low")),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(setModel).not.toHaveBeenCalled();
		expect(applyFlagSettings).not.toHaveBeenCalled();

		release[0]?.();
		expect((await turnA).status).toBe("completed");
		await waitForAssertion(() => {
			expect(setModel).toHaveBeenCalledTimes(1);
			expect(setModel).toHaveBeenLastCalledWith(OPUS);
			expect(applyFlagSettings).toHaveBeenCalledTimes(1);
			expect(applyFlagSettings).toHaveBeenLastCalledWith({
				effortLevel: "high",
			});
		});

		release[1]?.();
		await waitForAssertion(() => {
			expect(resolvedTurns(sink)).toHaveLength(2);
		});
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(applyFlagSettings).toHaveBeenCalledTimes(1);
		release[2]?.();
		expect((await turnB).status).toBe("completed");
		await waitForAssertion(() => {
			expect(setModel).toHaveBeenCalledTimes(2);
			expect(setModel).toHaveBeenLastCalledWith(SONNET);
			expect(applyFlagSettings).toHaveBeenCalledTimes(2);
			expect(applyFlagSettings).toHaveBeenLastCalledWith({
				effortLevel: "low",
			});
		});

		release[3]?.();
		await waitForAssertion(() => {
			expect(resolvedTurns(sink)).toHaveLength(3);
		});
		release[4]?.();
		expect((await turnC).status).toBe("completed");
		// The resolved-model sequence is the FIFO evidence: A ran on sonnet, B
		// on opus, C back on sonnet, each applied at its own turn boundary.
		expect(resolvedTurns(sink)).toEqual([
			{
				requestedModel: SONNET,
				expectedModel: SONNET,
				actualModel: SONNET,
			},
			{
				requestedModel: OPUS,
				expectedModel: OPUS,
				actualModel: OPUS,
			},
			{
				requestedModel: SONNET,
				expectedModel: SONNET,
				actualModel: SONNET,
			},
		]);
	});

	it("fully reapplies settings after a partially failed admission", async () => {
		let releaseNextTurn: (() => void) | undefined;
		const nextTurnGate = new Promise<void>((resolve) => {
			releaseNextTurn = resolve;
		});
		const gen = (async function* () {
			yield makeSuccessResult({ session_id: "sdk-1" }) as unknown as SDKMessage;
			await nextTurnGate;
			yield makeSuccessResult({ session_id: "sdk-1" }) as unknown as SDKMessage;
		})();
		const { query, applyFlagSettings, setModel } = makeMockQuery(gen);
		applyFlagSettings.mockRejectedValueOnce(new Error("flag settings failed"));
		const instance = new ClaudeProviderInstance({
			workspaceRoot: workspace,
			queryFactory: vi.fn(() => query),
			capabilitiesService: makeCapabilitiesService(),
		});
		const sink = createMockEventSink();
		const turnInput = (turnId: string, modelId: string, variant?: string) =>
			makeBaseSendTurnInput({
				sessionId: "s-dirty",
				turnId,
				eventSink: sink,
				model: { providerId: "claude", modelId },
				...(variant ? { variant } : {}),
			});

		expect(
			(
				await Effect.runPromise(
					instance.sendTurnEffect(turnInput("turn-a", SONNET)),
				)
			).status,
		).toBe("completed");
		await expect(
			Effect.runPromise(
				instance.sendTurnEffect(turnInput("turn-b", OPUS, "high")),
			),
		).rejects.toThrow("flag settings failed");

		const turnC = Effect.runPromise(
			instance.sendTurnEffect(turnInput("turn-c", OPUS)),
		);
		await waitForAssertion(() => {
			expect(setModel).toHaveBeenCalledTimes(2);
			expect(setModel).toHaveBeenNthCalledWith(1, OPUS);
			expect(setModel).toHaveBeenNthCalledWith(2, OPUS);
			expect(applyFlagSettings).toHaveBeenCalledTimes(2);
			expect(applyFlagSettings).toHaveBeenNthCalledWith(1, {
				effortLevel: "high",
			});
			expect(applyFlagSettings).toHaveBeenNthCalledWith(2, {
				effortLevel: null,
			});
		});
		releaseNextTurn?.();
		expect((await turnC).status).toBe("completed");
	});
});

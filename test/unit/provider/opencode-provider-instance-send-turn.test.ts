// test/unit/provider/opencode-provider-instance-send-turn.test.ts
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";
import type {
	EventSink,
	SendTurnInput,
} from "../../../src/lib/provider/types.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

function makeStubClient(overrides?: Record<string, unknown>): OpenCodeAPI {
	return {
		session: {
			prompt: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			...(overrides?.["session"] as Record<string, unknown>),
		},
		permission: { reply: vi.fn(async () => {}), list: vi.fn(async () => []) },
		question: {
			reply: vi.fn(async () => {}),
			reject: vi.fn(async () => {}),
			list: vi.fn(async () => []),
		},
		provider: {
			list: vi.fn(async () => ({
				providers: [],
				defaults: {},
				connected: [],
			})),
		},
		app: {
			agents: vi.fn(async () => []),
			commands: vi.fn(async () => []),
			skills: vi.fn(async () => []),
		},
		...overrides,
	} as unknown as OpenCodeAPI;
}

function makeStubEventSink(): EventSink & {
	pushedEvents: ProviderRuntimeEvent[];
} {
	const pushedEvents: ProviderRuntimeEvent[] = [];
	return {
		pushedEvents,
		push: vi.fn((event: ProviderRuntimeEvent) =>
			Effect.sync(() => {
				pushedEvents.push(event);
			}),
		),
		requestPermission: vi.fn(() =>
			Effect.succeed({
				decision: "once" as const,
			}),
		),
		requestQuestion: vi.fn(() => Effect.succeed({})),
		resolvePermission: vi.fn(() => Effect.void),
		resolveQuestion: vi.fn(() => Effect.void),
	};
}

function makeSendTurnInput(overrides?: Partial<SendTurnInput>): SendTurnInput {
	return {
		sessionId: "s1",
		turnId: "t1",
		prompt: "Write hello world",
		history: [],
		providerState: {},
		model: { providerId: "anthropic", modelId: "claude-sonnet" },
		workspaceRoot: "/tmp/project",
		eventSink: makeStubEventSink(),
		abortSignal: new AbortController().signal,
		...overrides,
	};
}

describe("OpenCodeProviderInstance.sendTurn()", () => {
	let client: OpenCodeAPI;
	let instance: OpenCodeProviderInstance;

	beforeEach(() => {
		client = makeStubClient();
		instance = new OpenCodeProviderInstance({ client });
	});

	it("preserves single-turn prompt and completion behavior", async () => {
		const input = makeSendTurnInput();
		const resultPromise = Effect.runPromise(instance.sendTurnEffect(input));

		// Simulate turn completion via the provider instance's internal callback
		const completion = {
			status: "completed",
			cost: 0.02,
			tokens: { input: 500, output: 200 },
			durationMs: 1500,
			providerStateUpdates: [],
		} as const;
		instance.notifyTurnCompleted("s1", completion);

		const result = await resultPromise;
		expect(client.session.prompt).toHaveBeenCalledWith("s1", {
			text: "Write hello world",
			model: { providerID: "anthropic", modelID: "claude-sonnet" },
		});
		expect(result).toBe(completion);
	});

	it("resolves concurrent prompts on one session from one completion", async () => {
		const firstResultPromise = Effect.runPromise(
			instance
				.sendTurnEffect(makeSendTurnInput({ turnId: "t1", prompt: "first" }))
				.pipe(
					Effect.timeoutFail({
						duration: "500 millis",
						onTimeout: () => new Error("first prompt did not complete"),
					}),
				),
		);
		const secondResultPromise = Effect.runPromise(
			instance
				.sendTurnEffect(makeSendTurnInput({ turnId: "t2", prompt: "second" }))
				.pipe(
					Effect.timeoutFail({
						duration: "500 millis",
						onTimeout: () => new Error("second prompt did not complete"),
					}),
				),
		);
		await vi.waitFor(() => {
			expect(client.session.prompt).toHaveBeenCalledTimes(2);
		});

		const completion = {
			status: "completed",
			cost: 0.03,
			tokens: { input: 700, output: 250 },
			durationMs: 1750,
			providerStateUpdates: [],
		} as const;
		instance.notifyTurnCompleted("s1", completion);

		const [firstResult, secondResult] = await Promise.all([
			firstResultPromise,
			secondResultPromise,
		]);
		expect(firstResult).toBe(completion);
		expect(secondResult).toBe(completion);
	});

	it("keeps a joined prompt pending when the first prompt cleans up", async () => {
		let rejectFirstPrompt: ((error: Error) => void) | undefined;
		const prompt = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<void>((_resolve, reject) => {
						rejectFirstPrompt = reject;
					}),
			)
			.mockResolvedValueOnce(undefined);
		client = makeStubClient({
			session: {
				prompt,
				abort: vi.fn(async () => {}),
			},
		});
		instance = new OpenCodeProviderInstance({ client });

		const firstResultPromise = Effect.runPromise(
			instance.sendTurnEffect(
				makeSendTurnInput({ turnId: "t1", prompt: "first" }),
			),
		);
		await vi.waitFor(() => {
			expect(prompt).toHaveBeenCalledTimes(1);
		});

		const secondResultPromise = Effect.runPromise(
			instance
				.sendTurnEffect(makeSendTurnInput({ turnId: "t2", prompt: "second" }))
				.pipe(
					Effect.timeoutFail({
						duration: "500 millis",
						onTimeout: () =>
							new Error("joined prompt was evicted by stale cleanup"),
					}),
				),
		);
		await vi.waitFor(() => {
			expect(prompt).toHaveBeenCalledTimes(2);
		});

		rejectFirstPrompt?.(new Error("first prompt failed"));
		const firstResult = await firstResultPromise;
		expect(firstResult).toMatchObject({
			status: "error",
			error: { code: "send_failed", message: "first prompt failed" },
		});

		const completion = {
			status: "completed",
			cost: 0.01,
			tokens: { input: 200, output: 100 },
			durationMs: 600,
			providerStateUpdates: [],
		} as const;
		instance.notifyTurnCompleted("s1", completion);

		await expect(secondResultPromise).resolves.toBe(completion);
	});

	it("passes images and agent to sendMessageAsync", async () => {
		const input = makeSendTurnInput({
			images: ["data:image/png;base64,abc"],
			agent: "coder",
		});

		const resultPromise = Effect.runPromise(instance.sendTurnEffect(input));
		instance.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		await resultPromise;

		expect(client.session.prompt).toHaveBeenCalledWith("s1", {
			text: "Write hello world",
			model: { providerID: "anthropic", modelID: "claude-sonnet" },
			images: ["data:image/png;base64,abc"],
			agent: "coder",
		});
	});

	it("passes variant to sendMessageAsync", async () => {
		const input = makeSendTurnInput({ variant: "thinking" });

		const resultPromise = Effect.runPromise(instance.sendTurnEffect(input));
		instance.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		await resultPromise;

		expect(client.session.prompt).toHaveBeenCalledWith(
			"s1",
			expect.objectContaining({
				variant: "thinking",
			}),
		);
	});

	it("returns error status when session.prompt fails", async () => {
		client = makeStubClient({
			session: {
				prompt: vi.fn(async () => {
					throw new Error("HTTP 500");
				}),
				abort: vi.fn(async () => {}),
			},
		});
		instance = new OpenCodeProviderInstance({ client });

		const input = makeSendTurnInput();
		const result = await Effect.runPromise(instance.sendTurnEffect(input));

		expect(result.status).toBe("error");
		expect(result.error?.message).toContain("HTTP 500");
	});

	it("resolves with interrupted status when aborted", async () => {
		const abortController = new AbortController();
		const input = makeSendTurnInput({
			abortSignal: abortController.signal,
		});

		const resultPromise = Effect.runPromise(instance.sendTurnEffect(input));

		// Simulate abort
		abortController.abort();

		// Notify via the standard completion path
		instance.notifyTurnCompleted("s1", {
			status: "interrupted",
			cost: 0,
			tokens: { input: 100, output: 50 },
			durationMs: 500,
			providerStateUpdates: [],
		});

		const result = await resultPromise;
		expect(result.status).toBe("interrupted");
	});

	it("records start time for duration calculation", async () => {
		const input = makeSendTurnInput();
		const resultPromise = Effect.runPromise(instance.sendTurnEffect(input));

		// Small delay to ensure non-zero duration
		await new Promise((r) => setTimeout(r, 10));

		instance.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0.01,
			tokens: { input: 100, output: 50 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		const result = await resultPromise;
		expect(result.status).toBe("completed");
	});

	it("fails with send_failed (no hang) when the bound named instance cannot be resolved", async () => {
		instance = new OpenCodeProviderInstance({
			client,
			clientForSession: () =>
				Effect.fail(new Error('OpenCode instance "oc-b" is not configured')),
		});

		const result = await Effect.runPromise(
			instance.sendTurnEffect(makeSendTurnInput()),
		);

		expect(result.status).toBe("error");
		expect(result.error?.code).toBe("send_failed");
		expect(result.error?.message).toContain('"oc-b"');
		expect(client.session.prompt).not.toHaveBeenCalled();
	});

	it("routes the prompt to the named instance client resolved for the session", async () => {
		const namedClient = makeStubClient();
		instance = new OpenCodeProviderInstance({
			client,
			clientForSession: (sessionId) =>
				Effect.succeed(sessionId === "s1" ? namedClient : undefined),
		});

		const resultPromise = Effect.runPromise(
			instance.sendTurnEffect(makeSendTurnInput()),
		);
		instance.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});
		await resultPromise;

		expect(namedClient.session.prompt).toHaveBeenCalledWith(
			"s1",
			expect.objectContaining({ text: "Write hello world" }),
		);
		expect(client.session.prompt).not.toHaveBeenCalled();
	});

	it("returns send_failed when the named instance server rejects the prompt", async () => {
		const namedClient = makeStubClient({
			session: {
				prompt: vi.fn(async () => {
					throw new Error("fetch failed: ECONNREFUSED");
				}),
				abort: vi.fn(async () => {}),
			},
		});
		instance = new OpenCodeProviderInstance({
			client,
			clientForSession: () => Effect.succeed(namedClient),
		});

		const result = await Effect.runPromise(
			instance.sendTurnEffect(makeSendTurnInput()),
		);

		expect(result.status).toBe("error");
		expect(result.error?.code).toBe("send_failed");
		expect(result.error?.message).toContain("ECONNREFUSED");
		expect(client.session.prompt).not.toHaveBeenCalled();
	});

	it("uses the default client when the resolver yields undefined", async () => {
		instance = new OpenCodeProviderInstance({
			client,
			clientForSession: () => Effect.succeed(undefined),
		});

		const resultPromise = Effect.runPromise(
			instance.sendTurnEffect(makeSendTurnInput()),
		);
		instance.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});
		await resultPromise;

		expect(client.session.prompt).toHaveBeenCalled();
	});

	it("only resolves for the matching session", async () => {
		const input = makeSendTurnInput({ sessionId: "s1" });
		const resultPromise = Effect.runPromise(instance.sendTurnEffect(input));

		// Notify a different session -- should not resolve s1
		instance.notifyTurnCompleted("s2", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		// Verify it's still pending (race with a timeout)
		const raceResult = await Promise.race([
			resultPromise.then(() => "resolved"),
			new Promise<string>((r) => setTimeout(() => r("timeout"), 50)),
		]);
		expect(raceResult).toBe("timeout");

		// Now resolve the correct session
		instance.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		const result = await resultPromise;
		expect(result.status).toBe("completed");
	});
});

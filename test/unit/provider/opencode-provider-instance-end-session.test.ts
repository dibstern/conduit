// test/unit/provider/opencode-provider-instance-end-session.test.ts
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";
import type { SendTurnInput } from "../../../src/lib/provider/types.js";

function makeStubClient(overrides?: Record<string, unknown>): OpenCodeAPI {
	return {
		session: {
			abort: vi.fn(async () => {}),
			prompt: vi.fn(async () => {}),
			...(overrides?.["session"] as Record<string, unknown>),
		},
		permission: {
			reply: vi.fn(async () => {}),
			list: vi.fn(async () => []),
		},
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

function makeSendTurnInput(overrides?: Partial<SendTurnInput>): SendTurnInput {
	return {
		sessionId: "sess-1",
		turnId: "turn-1",
		prompt: "continue",
		history: [],
		providerState: {},
		workspaceRoot: "/tmp/project",
		eventSink: {
			push: vi.fn(() => Effect.void),
			requestPermission: vi.fn(() =>
				Effect.succeed({ decision: "once" as const }),
			),
			requestQuestion: vi.fn(() => Effect.succeed({})),
			resolvePermission: vi.fn(() => Effect.void),
			resolveQuestion: vi.fn(() => Effect.void),
		},
		abortSignal: new AbortController().signal,
		...overrides,
	};
}

describe("OpenCodeProviderInstance.endSessionEffect()", () => {
	let client: OpenCodeAPI;
	let instance: OpenCodeProviderInstance;

	beforeEach(() => {
		client = makeStubClient();
		instance = new OpenCodeProviderInstance({ client });
	});

	it("is a no-op when there is no pending turn", async () => {
		await expect(
			Effect.runPromise(instance.endSessionEffect("missing-session")),
		).resolves.toBeUndefined();
		expect(client.session.abort).not.toHaveBeenCalled();
	});

	it("fails the in-flight send turn for the session", async () => {
		const resultPromise = Effect.runPromise(
			Effect.either(instance.sendTurnEffect(makeSendTurnInput())),
		);
		await vi.waitFor(() => {
			expect(client.session.prompt).toHaveBeenCalled();
		});

		await Effect.runPromise(instance.endSessionEffect("sess-1"));

		const result = await resultPromise;

		expect(result._tag).toBe("Left");
		if (result._tag !== "Left") return;
		expect(result.left).toMatchObject({
			_tag: "ProviderInstanceFailure",
			operation: "sendTurn",
			providerId: "opencode",
		});
		expect(result.left.message).toContain("reload");
	});

	it("does NOT call client.session.abort (reload is not a turn cancel)", async () => {
		const resultPromise = Effect.runPromise(
			Effect.either(
				instance.sendTurnEffect(makeSendTurnInput({ sessionId: "sess-2" })),
			),
		);
		await vi.waitFor(() => {
			expect(client.session.prompt).toHaveBeenCalled();
		});

		await Effect.runPromise(instance.endSessionEffect("sess-2"));
		await resultPromise;

		expect(client.session.abort).not.toHaveBeenCalled();
	});

	it("is idempotent across repeated calls", async () => {
		await Effect.runPromise(instance.endSessionEffect("sess-idempotent"));
		await Effect.runPromise(instance.endSessionEffect("sess-idempotent"));
		expect(client.session.abort).not.toHaveBeenCalled();
	});
});

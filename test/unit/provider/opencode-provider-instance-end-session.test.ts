// test/unit/provider/opencode-provider-instance-end-session.test.ts
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";

function makeStubClient(overrides?: Record<string, unknown>): OpenCodeAPI {
	return {
		session: {
			get: vi.fn(async () => ({ permission: [] })),
			update: vi.fn(async () => {}),
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

describe("OpenCodeProviderInstance.endSessionEffect()", () => {
	let client: OpenCodeAPI;
	let instance: OpenCodeProviderInstance;

	beforeEach(() => {
		client = makeStubClient();
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(client),
		});
	});

	it("leaves provider-owned sessions running", async () => {
		await expect(
			Effect.runPromise(instance.endSessionEffect("missing-session")),
		).resolves.toBeUndefined();
		expect(client.session.abort).not.toHaveBeenCalled();
	});

	it("is idempotent across repeated calls", async () => {
		await Effect.runPromise(instance.endSessionEffect("sess-idempotent"));
		await Effect.runPromise(instance.endSessionEffect("sess-idempotent"));
		expect(client.session.abort).not.toHaveBeenCalled();
	});
});

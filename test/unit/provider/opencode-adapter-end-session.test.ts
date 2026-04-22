// test/unit/provider/opencode-adapter-end-session.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { createDeferred } from "../../../src/lib/provider/deferred.js";
import { OpenCodeAdapter } from "../../../src/lib/provider/opencode-adapter.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";

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

describe("OpenCodeAdapter.endSession()", () => {
	let client: OpenCodeAPI;
	let adapter: OpenCodeAdapter;

	beforeEach(() => {
		client = makeStubClient();
		adapter = new OpenCodeAdapter({ client });
	});

	it("is a no-op when there is no pending turn", async () => {
		await expect(
			adapter.endSession("missing-session"),
		).resolves.toBeUndefined();
		expect(client.session.abort).not.toHaveBeenCalled();
	});

	it("rejects the pending deferred for the session", async () => {
		const deferred = createDeferred<TurnResult>();
		// Inject a pending deferred via the private map
		(
			adapter as unknown as { pendingTurns: Map<string, typeof deferred> }
		).pendingTurns.set("sess-1", deferred);

		// Attach catch BEFORE awaiting endSession so the rejection is handled
		let rejected: Error | undefined;
		const caught = deferred.promise.catch((err) => {
			rejected = err;
		});

		await adapter.endSession("sess-1");
		await caught;

		expect(rejected).toBeInstanceOf(Error);
		expect(rejected?.message).toContain("reload");
		expect(
			(
				adapter as unknown as { pendingTurns: Map<string, unknown> }
			).pendingTurns.has("sess-1"),
		).toBe(false);
	});

	it("does NOT call client.session.abort (reload is not a turn cancel)", async () => {
		const deferred = createDeferred<TurnResult>();
		(
			adapter as unknown as { pendingTurns: Map<string, typeof deferred> }
		).pendingTurns.set("sess-2", deferred);
		deferred.promise.catch(() => {
			/* swallow */
		});

		await adapter.endSession("sess-2");

		expect(client.session.abort).not.toHaveBeenCalled();
	});

	it("is idempotent across repeated calls", async () => {
		await adapter.endSession("sess-idempotent");
		await adapter.endSession("sess-idempotent");
		expect(client.session.abort).not.toHaveBeenCalled();
	});
});

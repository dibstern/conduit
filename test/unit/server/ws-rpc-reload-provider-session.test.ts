import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

let isolatedRoot: string;
beforeEach(() => {
	isolatedRoot = mkdtempSync(join(tmpdir(), "conduit-reload-login-"));
	vi.stubEnv("HOME", isolatedRoot);
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(isolatedRoot, "login"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(isolatedRoot, { recursive: true, force: true });
});

describe("WsRpcServerLayer ReloadProviderSession", () => {
	it.effect("ends the requested provider session", () => {
		const api = makeMockOpenCodeAPI();
		api.provider.list = vi.fn(async () => ({
			connected: ["openai"],
			defaults: {},
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					models: [{ id: "gpt-4", name: "GPT-4" }],
				},
			],
		})) as typeof api.provider.list;
		const engine = withDispatchEffect({
			getProviderForSessionEffect: () => Effect.succeed("claude-sdk"),
			dispatch: vi.fn(async () => ({ models: [], commands: [] })),
		});

		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* client.ReloadProviderSession({
				sessionId: "session-1",
				commandId: "cmd-reload-session",
				originId: "browser-1",
			});

			expect(result).toEqual({
				projectSlug: "test-project",
				sessionId: "session-1",
			});
			expect(engine.dispatchEffect).toHaveBeenCalledWith({
				type: "end_session",
				commandId: "cmd-reload-session",
				sessionId: "session-1",
				targetProviderId: "claude-sdk",
				account: expect.objectContaining({ id: "claude", driver: "claude" }),
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							config: makeMockConfig({
								configDir: isolatedRoot,
								projectDir: isolatedRoot,
							}),
							api,
							log: makeMockLogger(),
							orchestrationEngine: engine,
						}),
					),
				),
			),
		);
	});
});

// Failure modes: reload resolves a legacy binding from disk or ends a runner
// without carrying the account and login selected at the RPC boundary.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

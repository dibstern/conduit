import { describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { CLAUDE_DISPLAYABLE_SETTINGS_KEYS } from "../../../src/lib/contracts/claude-settings.js";
import {
	LoadMoreHistoryResponseSchema,
	PtyInput,
	QuotaForAccountsResponseSchema,
	WsRpcGroup,
	WsRpcRequest,
} from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcGroup as FrontendWsRpcGroup } from "../../../src/lib/frontend/transport/ws-rpc.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { resolveClaudeSettingsFromDisk } from "../../../src/lib/provider/claude/claude-settings-resolver.js";
import { WsRpcGroup as ServerWsRpcGroup } from "../../../src/lib/server/ws-rpc.js";
import { makeRpcWire } from "../../helpers/rpc-wire.js";

describe("browser WebSocket RPC contract", () => {
	it.effect(
		"never returns secret-bearing extra fields from a stubbed resolver child",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const wire = makeRpcWire({
						ResolveClaudeSettings: async ({ projectSlug, instanceId }) => ({
							projectSlug,
							instanceId,
							resolved: await Effect.runPromise(
								resolveClaudeSettingsFromDisk(
									{
										workspaceRoot: "/workspace/project",
										configDir: configuredClaudeConfigDir("/profiles/work"),
									},
									async () => ({
										stdout: JSON.stringify({
											...Object.fromEntries(
												CLAUDE_DISPLAYABLE_SETTINGS_KEYS.map((key) => [
													key,
													{},
												]),
											),
											autoCompactEnabled: {
												value: false,
												source: "user",
												env: { TOKEN: "rpc-secret-canary" },
											},
											env: { TOKEN: "rpc-secret-canary" },
											sources: [
												{
													settings: {
														plugins: {
															example: { apiKey: "rpc-secret-canary" },
														},
													},
												},
											],
										}),
										stderr: "",
										exitCode: 0,
										timedOut: false,
										outputTooLarge: false,
									}),
								),
							),
						}),
					});
					const client = yield* wire.connect({
						url: "ws://contract/rpc",
						trafficClass: "control",
					});
					const result = yield* client("ResolveClaudeSettings", {
						projectSlug: "demo",
						instanceId: "claude",
					});
					expect(result.resolved).toEqual({
						...Object.fromEntries(
							CLAUDE_DISPLAYABLE_SETTINGS_KEYS.map((key) => [key, {}]),
						),
						autoCompactEnabled: { value: false, source: "user" },
					});
					const json = JSON.stringify(result);
					expect(json).not.toContain("rpc-secret-canary");
					expect(json).not.toContain('"env"');
					expect(json).not.toContain('"sources"');
				}),
			),
	);

	it("decodes per-turn model execution in history responses", () => {
		const decode = Schema.decodeUnknownSync(LoadMoreHistoryResponseSchema);
		const decoded = decode({
			projectSlug: "demo",
			sessionId: "session-1",
			messages: [
				{
					id: "user-1",
					role: "user",
					modelExecution: {
						requestedModel: "sonnet",
						expectedModel: "claude-sonnet-5",
						actualModel: "claude-fable-4-0",
						drifted: true,
					},
				},
				{
					id: "user-0",
					role: "user",
				},
			],
			hasMore: false,
		});

		expect(decoded.messages[0]?.modelExecution).toEqual({
			requestedModel: "sonnet",
			expectedModel: "claude-sonnet-5",
			actualModel: "claude-fable-4-0",
			drifted: true,
		});
		expect(decoded.messages[1]).not.toHaveProperty("modelExecution");

		// Two ids that differ only by the `[1m]` context-window suffix name the
		// same model, so this is a legitimate `drifted: false`.
		expect(() =>
			decode({
				projectSlug: "demo",
				sessionId: "session-1",
				messages: [
					{
						id: "user-1",
						role: "user",
						modelExecution: {
							expectedModel: "claude-opus-5[1m]",
							actualModel: "claude-opus-5",
							drifted: false,
						},
					},
				],
				hasMore: false,
			}),
		).not.toThrow();

		expect(() =>
			decode({
				projectSlug: "demo",
				sessionId: "session-1",
				messages: [
					{
						id: "user-1",
						role: "user",
						modelExecution: {
							expectedModel: "claude-sonnet-5",
							actualModel: "claude-sonnet-5",
							drifted: true,
						},
					},
				],
				hasMore: false,
			}),
		).toThrow();
	});

	it("exports one shared WsRpcGroup for frontend and server", () => {
		expect(FrontendWsRpcGroup).toBe(WsRpcGroup);
		expect(ServerWsRpcGroup).toBe(WsRpcGroup);
		expect(WsRpcGroup.requests.has("SetProjectInstance")).toBe(false);
		expect(WsRpcGroup.requests.has("ListSessions")).toBe(false);
	});

	it("rejects an empty terminal id at the contract boundary", () => {
		expect(
			Schema.decodeUnknownEither(PtyInput)({
				_tag: "PtyInput",
				projectSlug: "demo",
				ptyId: "",
				data: "x",
			})._tag,
		).toBe("Left");
	});

	it("rejects unknown browser RPC tags at the contract boundary", () => {
		const decoded = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "UnknownBrowserRequest",
			projectSlug: "demo",
		});

		expect(decoded._tag).toBe("Left");
	});

	it("accepts session.mark_seen only with a non-negative integer upTo", () => {
		const decode = (upTo: unknown) =>
			Schema.decodeUnknownEither(WsRpcRequest)({
				_tag: "MarkSessionSeen",
				projectSlug: "demo",
				sessionId: "session-1",
				upTo,
			})._tag;
		expect(decode(4)).toBe("Right");
		expect(decode(0)).toBe("Right");
		expect(decode(-1)).toBe("Left");
		expect(decode(1.5)).toBe("Left");
		expect(decode("4")).toBe("Left");
		expect(decode(undefined)).toBe("Left");
	});

	it("rejects unknown permission modes at the contract boundary", () => {
		const decoded = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "SwitchPermissionMode",
			projectSlug: "demo",
			sessionId: "session-1",
			mode: "yolo",
		});
		expect(decoded._tag).toBe("Left");
	});

	it("requires commandId on mutating provider command RPCs", () => {
		const sendWithoutCommandId = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "input.submit",
			projectSlug: "demo",
			sessionId: "session-1",
			text: "hello",
			delivery: "queue",
		});
		const cancelWithoutCommandId = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "CancelSession",
			projectSlug: "demo",
			sessionId: "session-1",
		});

		expect(sendWithoutCommandId._tag).toBe("Left");
		expect(cancelWithoutCommandId._tag).toBe("Left");
	});
});

// The on-demand usage RPC returns readings directly, with ISO window resets.
it("decodes QuotaForAccounts as a harness-tagged reading array", () => {
	const readings = [
		{
			accountId: "claude-2",
			harness: "claude",
			status: "available",
			planLabel: "Max",
			windows: [
				{ kind: "five_hour", utilization: 12 },
				{
					kind: "seven_day",
					utilization: 37,
					resetsAt: "2026-10-12T09:00:00.000Z",
				},
			],
			readAt: 1791637200000,
			stale: false,
		},
		{
			accountId: "claude-3",
			harness: "claude",
			status: "unknown",
			windows: [],
			readAt: 1791637200000,
			stale: false,
			reason: "Usage read failed",
		},
	];
	expect(
		Schema.decodeUnknownSync(QuotaForAccountsResponseSchema)(readings),
	).toEqual(readings);
	expect(() =>
		Schema.decodeUnknownSync(QuotaForAccountsResponseSchema)({
			accounts: readings,
		}),
	).toThrow();
});

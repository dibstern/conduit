// test/unit/provider/types.test.ts

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
	AdapterCapabilities,
	CommandInfo,
	CommandSource,
	EventSink,
	PermissionDecision,
	ProviderAdapter,
	SendTurnInput,
	TurnResult,
} from "../../../src/lib/provider/types.js";

describe("ProviderAdapter types", () => {
	it("ProviderAdapter has exactly the 8-method interface", () => {
		// Compile-time check: if the interface changes shape, this won't compile.
		const adapter: ProviderAdapter = {
			providerId: "test",
			discoverEffect: () =>
				Effect.succeed({
					models: [],
					supportsTools: false,
					supportsThinking: false,
					supportsPermissions: false,
					supportsQuestions: false,
					supportsAttachments: false,
					supportsFork: false,
					supportsRevert: false,
					commands: [],
				}),
			sendTurnEffect: (_input: SendTurnInput) =>
				Effect.succeed({
					status: "completed" as const,
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				}),
			interruptTurnEffect: (_sessionId: string) => Effect.void,
			resolvePermissionEffect: (
				_sessionId: string,
				_requestId: string,
				_decision: PermissionDecision,
			) => Effect.void,
			resolveQuestionEffect: (
				_sessionId: string,
				_requestId: string,
				_answers: Record<string, unknown>,
			) => Effect.void,
			shutdownEffect: () => Effect.void,
			endSessionEffect: (_sessionId: string) => Effect.void,
		};

		expect(adapter.providerId).toBe("test");
		expect(typeof adapter.discoverEffect).toBe("function");
		expect(typeof adapter.sendTurnEffect).toBe("function");
		expect(typeof adapter.interruptTurnEffect).toBe("function");
		expect(typeof adapter.resolvePermissionEffect).toBe("function");
		expect(typeof adapter.resolveQuestionEffect).toBe("function");
		expect(typeof adapter.shutdownEffect).toBe("function");
		expect(typeof adapter.endSessionEffect).toBe("function");
	});

	it("SendTurnInput includes all required fields", () => {
		const mockSink: EventSink = {
			push: () => Effect.void,
			requestPermission: () => Effect.succeed({ decision: "once" }),
			requestQuestion: () => Effect.succeed({}),
			resolvePermission: () => Effect.void,
			resolveQuestion: () => Effect.void,
		};

		const input: SendTurnInput = {
			sessionId: "s1",
			turnId: "t1",
			prompt: "hello",
			history: [],
			providerState: {},
			model: { providerId: "anthropic", modelId: "claude-sonnet" },
			workspaceRoot: "/tmp/project",
			eventSink: mockSink,
			abortSignal: new AbortController().signal,
		};

		expect(input.sessionId).toBe("s1");
		expect(input.turnId).toBe("t1");
		expect(input.eventSink).toBe(mockSink);
		expect(Effect.isEffect(mockSink.push({} as never))).toBe(true);
		expect(typeof mockSink.resolvePermission).toBe("function");
		expect(typeof mockSink.resolveQuestion).toBe("function");
	});

	it("SendTurnInput supports optional fields", () => {
		const mockSink: EventSink = {
			push: () => Effect.void,
			requestPermission: () => Effect.succeed({ decision: "once" }),
			requestQuestion: () => Effect.succeed({}),
			resolvePermission: () => Effect.void,
			resolveQuestion: () => Effect.void,
		};

		const input: SendTurnInput = {
			sessionId: "s1",
			turnId: "t1",
			prompt: "hello",
			history: [],
			providerState: {},
			model: { providerId: "anthropic", modelId: "claude-sonnet" },
			workspaceRoot: "/tmp/project",
			eventSink: mockSink,
			abortSignal: new AbortController().signal,
			variant: "thinking",
			images: ["data:image/png;base64,abc"],
			agent: "coder",
		};

		expect(input.variant).toBe("thinking");
		expect(input.images).toEqual(["data:image/png;base64,abc"]);
		expect(input.agent).toBe("coder");
	});

	it("TurnResult captures completion data", () => {
		const result: TurnResult = {
			status: "completed",
			cost: 0.05,
			tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
			durationMs: 3400,
			providerStateUpdates: [{ key: "cursor", value: "abc123" }],
		};

		expect(result.status).toBe("completed");
		expect(result.tokens.input).toBe(1000);
	});

	it("TurnResult captures error state", () => {
		const result: TurnResult = {
			status: "error",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 100,
			error: { code: "provider_error", message: "Too many requests" },
			providerStateUpdates: [],
		};

		expect(result.status).toBe("error");
		expect(result.error?.code).toBe("provider_error");
	});

	it("AdapterCapabilities describes provider features", () => {
		const caps: AdapterCapabilities = {
			models: [
				{
					id: "claude-sonnet",
					name: "Claude Sonnet",
					providerId: "anthropic",
					limit: { context: 200000, output: 8192 },
				},
			],
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: true,
			supportsQuestions: true,
			supportsAttachments: true,
			supportsFork: false,
			supportsRevert: false,
			commands: [
				{ name: "/compact", description: "Compact context", source: "builtin" },
			],
		};

		expect(caps.models).toHaveLength(1);
		expect(caps.supportsTools).toBe(true);
		expect(caps.commands[0]?.source).toBe("builtin");
	});

	it("CommandInfo covers all source types", () => {
		const sources: CommandSource[] = [
			"builtin",
			"user-command",
			"project-command",
			"user-skill",
			"project-skill",
		];

		const commands: CommandInfo[] = sources.map((source) => ({
			name: `/test-${source}`,
			source,
		}));

		expect(commands).toHaveLength(5);
		commands.forEach((cmd) => {
			expect(cmd.name).toBeTruthy();
			expect(sources).toContain(cmd.source);
		});
	});

	it("PermissionDecision is a string union", () => {
		const decisions: PermissionDecision[] = ["once", "always", "reject"];
		expect(decisions).toHaveLength(3);
	});
});

// test/unit/provider/types.test.ts
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
			discover: async () => ({
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
			sendTurn: async (_input: SendTurnInput) => ({
				status: "completed" as const,
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			}),
			interruptTurn: async (_sessionId: string) => {},
			resolvePermission: async (
				_sessionId: string,
				_requestId: string,
				_decision: PermissionDecision,
			) => {},
			resolveQuestion: async (
				_sessionId: string,
				_requestId: string,
				_answers: Record<string, unknown>,
			) => {},
			shutdown: async () => {},
			endSession: async (_sessionId: string) => {},
		};

		expect(adapter.providerId).toBe("test");
		expect(typeof adapter.discover).toBe("function");
		expect(typeof adapter.sendTurn).toBe("function");
		expect(typeof adapter.interruptTurn).toBe("function");
		expect(typeof adapter.resolvePermission).toBe("function");
		expect(typeof adapter.resolveQuestion).toBe("function");
		expect(typeof adapter.shutdown).toBe("function");
		expect(typeof adapter.endSession).toBe("function");
	});

	it("SendTurnInput includes all required fields", () => {
		const mockSink: EventSink = {
			push: async () => {},
			requestPermission: async () => ({ decision: "once" }),
			requestQuestion: async () => ({}),
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
	});

	it("SendTurnInput supports optional fields", () => {
		const mockSink: EventSink = {
			push: async () => {},
			requestPermission: async () => ({ decision: "once" }),
			requestQuestion: async () => ({}),
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

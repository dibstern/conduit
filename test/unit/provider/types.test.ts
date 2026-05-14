// test/unit/provider/types.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
	CommandInfo,
	CommandSource,
	EventSink,
	PermissionDecision,
	ProviderCapabilities,
	ProviderInstance,
	SendTurnInput,
	TurnResult,
} from "../../../src/lib/provider/types.js";

const REPO_ROOT = process.cwd();

describe("ProviderInstance types", () => {
	it("does not expose adapter-named provider type exports", () => {
		const providerTypes = readFileSync(
			join(REPO_ROOT, "src/lib/provider/types.ts"),
			"utf8",
		);
		const providerErrors = readFileSync(
			join(REPO_ROOT, "src/lib/provider/errors.ts"),
			"utf8",
		);

		expect(providerTypes).not.toMatch(
			/\b(?:ProviderAdapter|AdapterCapabilities)\b/,
		);
		expect(providerErrors).not.toMatch(/\bProviderAdapterFailure\b/);
	});

	it("ProviderInstance has exactly the 8-method interface", () => {
		// Compile-time check: if the interface changes shape, this won't compile.
		const instance: ProviderInstance = {
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

		expect(instance.providerId).toBe("test");
		expect(typeof instance.discoverEffect).toBe("function");
		expect(typeof instance.sendTurnEffect).toBe("function");
		expect(typeof instance.interruptTurnEffect).toBe("function");
		expect(typeof instance.resolvePermissionEffect).toBe("function");
		expect(typeof instance.resolveQuestionEffect).toBe("function");
		expect(typeof instance.shutdownEffect).toBe("function");
		expect(typeof instance.endSessionEffect).toBe("function");
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

	it("ProviderCapabilities describes provider features", () => {
		const caps: ProviderCapabilities = {
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

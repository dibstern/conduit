// test/unit/provider/opencode-provider-instance-discover.test.ts

import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";

function makeStubClient(overrides?: Record<string, unknown>): OpenCodeAPI {
	return {
		provider: {
			list: vi.fn(async () => ({
				providers: [
					{
						id: "anthropic",
						name: "Anthropic",
						models: [
							{
								id: "claude-sonnet",
								name: "Claude Sonnet",
								limit: { context: 200000, output: 8192 },
								variants: {
									thinking: { budget_tokens: 10000 },
								},
							},
							{
								id: "claude-haiku",
								name: "Claude Haiku",
								limit: { context: 200000, output: 4096 },
							},
						],
					},
				],
				defaults: { anthropic: "claude-sonnet" },
				connected: ["anthropic"],
			})),
		},
		app: {
			agents: vi.fn(async () => [
				{ id: "coder", name: "Coder", description: "Main coding agent" },
				{
					id: "task",
					name: "Task",
					description: "Sub-agent",
					mode: "subagent",
				},
			]),
			commands: vi.fn(async () => [
				{ name: "/compact", description: "Compact context window" },
				{ name: "/cost", description: "Show cost" },
			]),
			skills: vi.fn(async () => [
				{ name: "debugging", description: "Debug skill" },
			]),
		},
		session: { prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
		permission: { reply: vi.fn(async () => {}), list: vi.fn(async () => []) },
		question: {
			reply: vi.fn(async () => {}),
			reject: vi.fn(async () => {}),
			list: vi.fn(async () => []),
		},
		...overrides,
	} as unknown as OpenCodeAPI;
}

describe("OpenCodeProviderInstance.discoverEffect()", () => {
	let client: OpenCodeAPI;
	let instance: OpenCodeProviderInstance;

	beforeEach(() => {
		client = makeStubClient();
		instance = new OpenCodeProviderInstance({ client });
	});

	it("returns providerId = 'opencode'", () => {
		expect(instance.providerId).toBe("opencode");
	});

	it("discovers models from all providers", async () => {
		const caps = await Effect.runPromise(instance.discoverEffect());

		expect(caps.models).toHaveLength(2);
		expect(caps.models[0]).toMatchObject({
			id: "claude-sonnet",
			name: "Claude Sonnet",
			providerId: "anthropic",
			limit: { context: 200000, output: 8192 },
		});
		expect(caps.models[0]?.variants).toEqual({
			thinking: { budget_tokens: 10000 },
		});
	});

	it("discovers commands", async () => {
		const caps = await Effect.runPromise(instance.discoverEffect());

		const commands = caps.commands.filter((c) => c.source === "builtin");
		expect(commands.length).toBeGreaterThanOrEqual(2);
		expect(commands.find((c) => c.name === "/compact")).toBeDefined();
		expect(commands.find((c) => c.name === "/cost")).toBeDefined();
	});

	it("discovers skills as project-skill commands", async () => {
		const caps = await Effect.runPromise(instance.discoverEffect());

		const skills = caps.commands.filter((c) => c.source === "project-skill");
		expect(skills).toHaveLength(1);
		expect(skills[0]?.name).toBe("debugging");
	});

	it("sets capability flags for OpenCode", async () => {
		const caps = await Effect.runPromise(instance.discoverEffect());

		expect(caps.supportsTools).toBe(true);
		expect(caps.supportsThinking).toBe(true);
		expect(caps.supportsPermissions).toBe(true);
		expect(caps.supportsQuestions).toBe(true);
		expect(caps.supportsAttachments).toBe(true);
		expect(caps.supportsFork).toBe(true);
		expect(caps.supportsRevert).toBe(true);
	});

	it("handles provider with no models", async () => {
		client = makeStubClient({
			provider: {
				list: vi.fn(async () => ({
					providers: [{ id: "empty", name: "Empty", models: [] }],
					defaults: {},
					connected: [],
				})),
			},
		});
		instance = new OpenCodeProviderInstance({ client });

		const caps = await Effect.runPromise(instance.discoverEffect());
		expect(caps.models).toEqual([]);
	});

	it("handles empty commands and skills", async () => {
		client = makeStubClient({
			app: {
				agents: vi.fn(async () => []),
				commands: vi.fn(async () => []),
				skills: vi.fn(async () => []),
			},
		});
		instance = new OpenCodeProviderInstance({ client });

		const caps = await Effect.runPromise(instance.discoverEffect());
		expect(caps.commands).toEqual([]);
	});

	it("returns typed failures when provider discovery rejects", async () => {
		client = makeStubClient({
			provider: {
				list: vi.fn(async () => {
					throw new Error("network error");
				}),
			},
		});
		instance = new OpenCodeProviderInstance({ client });

		const result = await Effect.runPromise(
			Effect.either(instance.discoverEffect()),
		);

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left).toMatchObject({
				_tag: "ProviderInstanceFailure",
				providerId: "opencode",
				operation: "discover",
			});
			expect(result.left.message).toContain("network error");
		}
	});

	it("passes workspace directory for command/skill discovery", async () => {
		instance = new OpenCodeProviderInstance({
			client,
			workspaceRoot: "/my/project",
		});

		await Effect.runPromise(instance.discoverEffect());

		expect(client.app.commands).toHaveBeenCalled();
		expect(client.app.skills).toHaveBeenCalledWith("/my/project");
	});

	it("omits directory for commands when no workspace", async () => {
		instance = new OpenCodeProviderInstance({ client });

		await Effect.runPromise(instance.discoverEffect());

		expect(client.app.commands).toHaveBeenCalled();
		expect(client.app.skills).toHaveBeenCalledWith(undefined);
	});
});

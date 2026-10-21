// test/unit/provider/opencode-provider-instance-discover.test.ts

import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AccountIdSchema,
	type OpenCodeAccount,
} from "../../../src/lib/contracts/account.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";
import type { ProviderInstance } from "../../../src/lib/provider/types.js";

const account: OpenCodeAccount = {
	id: AccountIdSchema.make("opencode"),
	driver: "opencode",
	name: "Test",
	usageEligible: false,
};

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
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(client),
			clientForAccount: () => Effect.succeed(client),
		});
	});

	it("returns providerId = 'opencode'", () => {
		expect(instance.providerId).toBe("opencode");
	});

	it("discovers models from all providers", async () => {
		const caps = await Effect.runPromise(
			instance.discoverEffect("/workspace", account),
		);

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
		const caps = await Effect.runPromise(
			instance.discoverEffect("/workspace", account),
		);

		const commands = caps.commands.filter((c) => c.source === "builtin");
		expect(commands.length).toBeGreaterThanOrEqual(2);
		expect(commands.find((c) => c.name === "/compact")).toBeDefined();
		expect(commands.find((c) => c.name === "/cost")).toBeDefined();
	});

	it("discovers skills as project-skill commands", async () => {
		const caps = await Effect.runPromise(
			instance.discoverEffect("/workspace", account),
		);

		const skills = caps.commands.filter((c) => c.source === "project-skill");
		expect(skills).toHaveLength(1);
		expect(skills[0]?.name).toBe("debugging");
	});

	it("sets capability flags for OpenCode", async () => {
		const caps = await Effect.runPromise(
			instance.discoverEffect("/workspace", account),
		);

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
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(client),
			clientForAccount: () => Effect.succeed(client),
		});

		const caps = await Effect.runPromise(
			instance.discoverEffect("/workspace", account),
		);
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
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(client),
			clientForAccount: () => Effect.succeed(client),
		});

		const caps = await Effect.runPromise(
			instance.discoverEffect("/workspace", account),
		);
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
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(client),
			clientForAccount: () => Effect.succeed(client),
		});

		const result = await Effect.runPromise(
			Effect.result(instance.discoverEffect("/workspace", account)),
		);

		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			expect(result.failure).toMatchObject({
				_tag: "ProviderInstanceFailure",
				providerId: "opencode",
				operation: "discover",
			});
			expect(result.failure.message).toContain("network error");
		}
	});

	it("passes the explicit workspace directory for command/skill discovery", async () => {
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(client),

			clientForAccount: () => Effect.succeed(client),
		});

		await Effect.runPromise(instance.discoverEffect("/my/project", account));

		expect(client.app.commands).toHaveBeenCalled();
		expect(client.app.skills).toHaveBeenCalledWith("/my/project");
	});

	it("discovers through each call's account and directory concurrently", async () => {
		const routed = [makeStubClient(), makeStubClient()];
		const accounts: OpenCodeAccount[] = ["a", "b"].map((id) => ({
			id: AccountIdSchema.make(id),
			driver: "opencode",
			name: id,
			usageEligible: false,
		}));
		const clientForAccount = vi.fn((account: OpenCodeAccount) =>
			Effect.succeed(routed[account.id === "a" ? 0 : 1] ?? client),
		);
		const provider: ProviderInstance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(client),

			clientForAccount,
		});
		await Promise.all(
			accounts.map((account) =>
				Effect.runPromise(
					provider.discoverEffect(`/call/${account.id}`, account),
				),
			),
		);
		expect(clientForAccount).toHaveBeenCalledTimes(2);
		for (const [index, account] of accounts.entries()) {
			expect(clientForAccount).toHaveBeenCalledWith(
				account,
				`/call/${account.id}`,
			);
			expect(routed[index]?.app.skills).toHaveBeenCalledWith(
				`/call/${account.id}`,
			);
		}
		expect(client.provider.list).not.toHaveBeenCalled();
	});

	it("rejects discovery without an explicit workspace", async () => {
		const result = await Effect.runPromise(
			Effect.result(instance.discoverEffect(undefined, account)),
		);
		expect(result._tag).toBe("Failure");
		expect(client.app.commands).not.toHaveBeenCalled();
		expect(client.app.skills).not.toHaveBeenCalled();
	});
});

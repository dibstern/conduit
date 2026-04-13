// ─── M4 Backend Additions Tests ──────────────────────────────────────────────
// Tests for Phase 0B: new types, client methods, router types, todo extraction.

import { describe, expect, it } from "vitest";
import {
	isRouteError,
	parseIncomingMessage,
	routeMessage,
} from "../../../src/lib/server/ws-router.js";
import type {
	AgentInfo,
	CommandInfo,
	ModelInfo,
	ProviderInfo,
	TodoItem,
	TodoStatus,
} from "../../../src/lib/types.js";

// ─── ws-router: new message types ───────────────────────────────────────────

describe("ws-router — new M4 message types", () => {
	const newTypes = [
		"switch_agent",
		"switch_model",
		"get_todo",
		"get_agents",
		"get_models",
		"get_commands",
		"question_reject",
	];

	for (const type of newTypes) {
		it(`routes ${type} messages`, () => {
			const msg = parseIncomingMessage(JSON.stringify({ type }));
			expect(msg).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const result = routeMessage(msg!);
			expect(isRouteError(result)).toBe(false);
			if (!isRouteError(result)) {
				expect(result.handler).toBe(type);
			}
		});
	}

	it("still rejects unknown types", () => {
		const msg = parseIncomingMessage(
			JSON.stringify({ type: "nonexistent_type" }),
		);
		expect(msg).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const result = routeMessage(msg!);
		expect(isRouteError(result)).toBe(true);
	});

	it("routes switch_agent with agentId payload", () => {
		const msg = parseIncomingMessage(
			JSON.stringify({ type: "switch_agent", agentId: "plan" }),
		);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const result = routeMessage(msg!);
		expect(isRouteError(result)).toBe(false);
		if (!isRouteError(result)) {
			expect(result.handler).toBe("switch_agent");
			expect(result.payload["agentId"]).toBe("plan");
		}
	});

	it("routes switch_model with modelId and providerId payload", () => {
		const msg = parseIncomingMessage(
			JSON.stringify({
				type: "switch_model",
				modelId: "gpt-4o",
				providerId: "openai",
			}),
		);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const result = routeMessage(msg!);
		expect(isRouteError(result)).toBe(false);
		if (!isRouteError(result)) {
			expect(result.handler).toBe("switch_model");
			expect(result.payload["modelId"]).toBe("gpt-4o");
			expect(result.payload["providerId"]).toBe("openai");
		}
	});
});

// ─── types: interface shape checks ──────────────────────────────────────────

describe("types — M4 interfaces", () => {
	it("TodoItem has required fields", () => {
		const item: TodoItem = {
			id: "1",
			subject: "Write tests",
			status: "pending",
		};
		expect(item.id).toBe("1");
		expect(item.subject).toBe("Write tests");
		expect(item.status).toBe("pending");
		expect(item.description).toBeUndefined();
	});

	it("TodoItem accepts all statuses", () => {
		const statuses: TodoStatus[] = [
			"pending",
			"in_progress",
			"completed",
			"cancelled",
		];
		for (const s of statuses) {
			const item: TodoItem = { id: "x", subject: "test", status: s };
			expect(item.status).toBe(s);
		}
	});

	it("AgentInfo has required fields", () => {
		const agent: AgentInfo = { id: "build", name: "Build Agent" };
		expect(agent.id).toBe("build");
		expect(agent.description).toBeUndefined();
	});

	it("ProviderInfo has required fields", () => {
		const provider: ProviderInfo = {
			id: "anthropic",
			name: "Anthropic",
			configured: true,
			models: [{ id: "claude-3", name: "Claude 3", provider: "anthropic" }],
		};
		expect(provider.models).toHaveLength(1);
	});

	it("ModelInfo has required fields", () => {
		const model: ModelInfo = {
			id: "gpt-4o",
			name: "GPT-4o",
			provider: "openai",
			cost: { input: 0.005, output: 0.015 },
		};
		expect(model.cost?.input).toBe(0.005);
	});

	it("CommandInfo has required fields", () => {
		const cmd: CommandInfo = { name: "/help", description: "Show help" };
		expect(cmd.name).toBe("/help");
		expect(cmd.args).toBeUndefined();
	});
});

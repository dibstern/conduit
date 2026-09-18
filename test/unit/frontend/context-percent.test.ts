// ─── Context usage bar — percent computation regressions ─────────────────────
// Bug: fable-family models got no limit from the capability probe, so the
// context bar never rendered; the [1m] context-window override was ignored;
// and history replay never restored contextPercent after a reload.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	handleResult,
	restoreContextFromMessages,
	type SessionActivity,
	type SessionMessages,
	setMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	clearDiscoveryState,
	handleContextWindowInfo,
	handleModelInfo,
	handleModelList,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";
import { probeClaudeCapabilities } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

function resultMsg(usage: {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_creation?: number;
}): Extract<RelayMessage, { type: "result" }> {
	return { type: "result", usage } as Extract<RelayMessage, { type: "result" }>;
}

function setClaudeProvider(models: unknown[]): void {
	// The probe's model rows carry fields the frontend `ModelInfo` does not
	// declare, so this goes in through the wire shape like the real thing does.
	handleModelList({
		type: "model_list",
		providers: [{ id: "claude", name: "Claude", models }],
	} as Extract<RelayMessage, { type: "model_list" }>);
}

function selectModel(model: string): void {
	handleModelInfo({ type: "model_info", model, provider: "claude" });
}

describe("context percent computation", () => {
	let activity: SessionActivity;
	let messages: SessionMessages;

	beforeEach(() => {
		activity = testActivity();
		messages = testMessages();
		clearDiscoveryState();
	});

	afterEach(() => {
		clearDiscoveryState();
	});

	it("computes percent from model limit on result", () => {
		selectModel("claude-fable-5");
		setClaudeProvider([
			{
				id: "claude-fable-5",
				name: "Claude Fable 5",
				providerId: "claude",
				limit: { context: 200_000, output: 128_000 },
			},
		]);
		handleResult(activity, messages, resultMsg({ cache_read: 100_000 }));
		expect(messages.contextPercent).toBe(50);
	});

	it("uses the selected 1m context-window override", () => {
		selectModel("claude-fable-5");
		handleContextWindowInfo({
			type: "context_window_info",
			contextWindow: "1m",
			options: [],
		});
		setClaudeProvider([
			{
				id: "claude-fable-5",
				name: "Claude Fable 5",
				providerId: "claude",
				limit: { context: 200_000, output: 128_000 },
			},
		]);
		handleResult(activity, messages, resultMsg({ cache_read: 100_000 }));
		expect(messages.contextPercent).toBe(10);
	});

	it("restores percent from the last result message in history", () => {
		selectModel("claude-fable-5");
		setClaudeProvider([
			{
				id: "claude-fable-5",
				name: "Claude Fable 5",
				providerId: "claude",
				limit: { context: 200_000, output: 128_000 },
			},
		]);
		setMessages(messages, [
			{ type: "result", uuid: "r1", inputTokens: 10, cacheRead: 19_990 },
			{ type: "result", uuid: "r2", inputTokens: 10, cacheRead: 59_990 },
		] as never);
		restoreContextFromMessages(messages);
		expect(messages.contextPercent).toBe(30);
	});

	it("restores percent from a compaction divider's postTokens", () => {
		selectModel("claude-fable-5");
		setClaudeProvider([
			{
				id: "claude-fable-5",
				name: "Claude Fable 5",
				providerId: "claude",
				limit: { context: 200_000, output: 128_000 },
			},
		]);
		setMessages(messages, [
			{ type: "result", uuid: "r1", inputTokens: 10, cacheRead: 179_990 },
			{
				type: "system",
				uuid: "c1",
				text: "Context compacted",
				postTokens: 100_000,
			},
		] as never);
		restoreContextFromMessages(messages);
		expect(messages.contextPercent).toBe(50);
	});

	it("skips the zero-token /compact result and falls through to the divider", () => {
		selectModel("claude-fable-5");
		setClaudeProvider([
			{
				id: "claude-fable-5",
				name: "Claude Fable 5",
				providerId: "claude",
				limit: { context: 200_000, output: 128_000 },
			},
		]);
		setMessages(messages, [
			{
				type: "system",
				uuid: "c1",
				text: "Context compacted",
				postTokens: 100_000,
			},
			{ type: "result", uuid: "r1", inputTokens: 0, outputTokens: 0 },
		] as never);
		restoreContextFromMessages(messages);
		expect(messages.contextPercent).toBe(50);
	});

	it("prefers a real turn's result over an earlier compaction divider", () => {
		selectModel("claude-fable-5");
		setClaudeProvider([
			{
				id: "claude-fable-5",
				name: "Claude Fable 5",
				providerId: "claude",
				limit: { context: 200_000, output: 128_000 },
			},
		]);
		setMessages(messages, [
			{
				type: "system",
				uuid: "c1",
				text: "Context compacted",
				postTokens: 100_000,
			},
			{ type: "result", uuid: "r1", inputTokens: 10, cacheRead: 19_990 },
		] as never);
		restoreContextFromMessages(messages);
		expect(messages.contextPercent).toBe(10);
	});
});

describe("claude capability probe — fable family limits", () => {
	it("gives fable models a context limit and context-window options", async () => {
		const result = await probeClaudeCapabilities({
			workspaceRoot: "/tmp",
			queryFactory: () => ({
				initializationResult: async () => ({
					models: [{ value: "claude-fable-5", displayName: "Claude Fable 5" }],
					commands: [],
					agents: [],
				}),
			}),
		});
		const fable = result.models.find((m) => m.id === "claude-fable-5");
		expect(fable?.limit?.context).toBe(200_000);
		expect(fable?.contextWindowOptions?.some((o) => o.value === "1m")).toBe(
			true,
		);
	});
});

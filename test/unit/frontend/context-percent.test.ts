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
import { discoveryState } from "../../../src/lib/frontend/stores/discovery.svelte.js";
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
	discoveryState.providers = [
		{ id: "claude", name: "Claude", models },
	] as typeof discoveryState.providers;
}

describe("context percent computation", () => {
	let activity: SessionActivity;
	let messages: SessionMessages;

	beforeEach(() => {
		activity = testActivity();
		messages = testMessages();
		discoveryState.currentModelId = "";
		discoveryState.currentContextWindow = "";
		discoveryState.providers = [];
	});

	afterEach(() => {
		discoveryState.providers = [];
		discoveryState.currentModelId = "";
		discoveryState.currentContextWindow = "";
	});

	it("computes percent from model limit on result", () => {
		discoveryState.currentModelId = "claude-fable-5";
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
		discoveryState.currentModelId = "claude-fable-5";
		discoveryState.currentContextWindow = "1m";
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
		discoveryState.currentModelId = "claude-fable-5";
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
		discoveryState.currentModelId = "claude-fable-5";
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
		discoveryState.currentModelId = "claude-fable-5";
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
		discoveryState.currentModelId = "claude-fable-5";
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

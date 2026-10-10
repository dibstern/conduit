// Failure modes, listed before implementation:
// - Workspace ingress accepts blank paths or an unknown source, or writes a canonical move directly.
// - Captured Enter/Exit results are attributed by payload shape instead of tool call ID.
// - Snapshot-only tool calls, reordered results, or duplicate delivery lose their correlation.
// - Failed tools, malformed or ambiguous results, unrelated tools, or subagents move the parent session.
// - Repeated init messages move the session again or acknowledge cwd before the start report.
// - Declared moves retarget SDK transcript readers or drop durable worktree evidence.
// - The query prompt omits the instruction to declare moves with EnterWorktree.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeClaudeSDKMessage } from "../../../../src/lib/contracts/providers/claude-agent-sdk.js";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { CanonicalEventSchema } from "../../../../src/lib/contracts/stored-event.js";
import { createTestLogger } from "../../../../src/lib/logger.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import {
	ClaudeGoalTracker,
	type ReadClaudeGoalStatus,
} from "../../../../src/lib/provider/claude/claude-goal-tracker.js";
import { buildClaudeQueryOptions } from "../../../../src/lib/provider/claude/claude-query-options.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import {
	emptyProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "../../../../src/lib/provider/provider-runtime-event-to-domain.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";
import { partialFake } from "../../../helpers/partial-fake.js";

function trace(name: string): SDKMessage[] {
	return readFileSync(
		join(import.meta.dirname, "../../../fixtures/claude-sdk-traces", name),
		"utf8",
	)
		.trim()
		.split("\n")
		.map((line) => decodeClaudeSDKMessage(JSON.parse(line)));
}

const enterTrace = trace("enter-worktree-turn.jsonl");
const exitTrace = trace("exit-worktree-keep-turn.jsonl");
const mainFolder = "/tmp/conduit-worktree-capture/repo";
const worktreeFolder = `${mainFolder}/.claude/worktrees/contract`;

function runtimeMove(data: unknown): ProviderRuntimeEvent {
	return decodeProviderRuntimeEvent({
		eventId: "workspace-event",
		type: "workspace.changed",
		providerId: "claude",
		sessionId: "workspace-session",
		providerRefs: {},
		rawSource: { kind: "claude.sdk.translator" },
		createdAt: 1,
		data,
	});
}

function harness(readGoalStatus?: ReadClaudeGoalStatus) {
	const events: ProviderRuntimeEvent[] = [];
	const sink = partialFake<EventSink>({
		push: (event) =>
			Effect.sync(() => {
				events.push(event);
			}),
	});
	const ctx = partialFake<ClaudeSessionContext>({
		sessionId: "workspace-session",
		workspaceRoot: mainFolder,
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: sink,
		currentTurnId: "turn-1",
		turnInFlight: true,
		currentModel: undefined,
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
	});
	const translator = new ClaudeEventTranslator({
		getSink: () => sink,
		logger: createTestLogger(),
		...(readGoalStatus ? { readGoalStatus } : {}),
	});
	return {
		ctx,
		events,
		translator,
		replay: async (messages: readonly SDKMessage[]) => {
			for (const message of messages)
				await Effect.runPromise(translator.translate(ctx, message));
		},
	};
}

function declaredToolResult(messages = enterTrace) {
	const message = messages.find(
		(candidate) =>
			candidate.type === "user" &&
			candidate.tool_use_result !== null &&
			typeof candidate.tool_use_result === "object" &&
			"worktreePath" in candidate.tool_use_result,
	);
	if (!message || message.type !== "user")
		throw new Error("Captured worktree result is missing");
	return message;
}

function beforeResult(messages = enterTrace) {
	return messages.slice(0, messages.indexOf(declaredToolResult(messages)));
}

function moves(events: readonly ProviderRuntimeEvent[]) {
	return events.filter((event) => event.type === "workspace.changed");
}

describe("workspace provider ingress", () => {
	it("retains worktree and runner cwd evidence through canonical decoding", () => {
		const metadata = {
			workspaceCwd: mainFolder,
			claudeWorktree: { entered: true, path: worktreeFolder },
		};
		const runtime = decodeProviderRuntimeEvent({
			eventId: "status-with-workspace-evidence",
			type: "session.status",
			providerId: "claude",
			sessionId: "workspace-session",
			providerRefs: {},
			rawSource: { kind: "claude.sdk.translator" },
			createdAt: 1,
			data: { sessionId: "workspace-session", status: "busy" },
			metadata,
		});
		const event = translateProviderRuntimeEventToDomain(runtime).events[0];
		const decoded = Schema.decodeUnknownSync(CanonicalEventSchema)(event);
		expect(decoded.metadata).toMatchObject(metadata);
	});

	it.each([
		"tool",
		"start",
	])("accepts %s reports without writing canonical events", (source) => {
		const event = runtimeMove({ path: worktreeFolder, source });
		expect(event.data).toEqual({ path: worktreeFolder, source });
		expect(translateProviderRuntimeEventToDomain(event)).toEqual({
			events: [],
			state: emptyProviderRuntimeDomainMapperState,
		});
	});

	it.each([
		{ path: "", source: "tool" },
		{ path: "   ", source: "tool" },
		{ path: ` ${worktreeFolder}`, source: "tool" },
		{ path: 42, source: "tool" },
		{ source: "tool" },
		{ path: worktreeFolder, source: "agent" },
		{ path: worktreeFolder },
	])("rejects malformed workspace data %j", (data) => {
		expect(() => runtimeMove(data)).toThrow();
	});
});

describe("Claude declared workspace reports", () => {
	it.each([
		{
			name: "EnterWorktree",
			messages: enterTrace,
			path: worktreeFolder,
			entered: true,
		},
		{
			name: "ExitWorktree",
			messages: exitTrace,
			path: mainFolder,
			entered: false,
		},
	])("replays captured $name traffic with durable tool evidence", async ({
		messages,
		path,
		entered,
	}) => {
		const h = harness();
		await h.replay(messages);
		expect(moves(h.events).map((event) => event.data)).toEqual([
			{
				path: messages === enterTrace ? mainFolder : worktreeFolder,
				source: "start",
			},
			{ path, source: "tool" },
		]);
		const completion = h.events.find(
			(event) =>
				event.type === "tool.completed" && event.metadata?.["claudeWorktree"],
		);
		expect(completion?.metadata?.["claudeWorktree"]).toEqual({ entered, path });
		const canonical =
			completion && translateProviderRuntimeEventToDomain(completion).events[0];
		expect(canonical?.metadata?.["claudeWorktree"]).toEqual({ entered, path });
	});

	it("keeps goal transcript lookup in the SDK query's original project folder", async () => {
		const roots: string[] = [];
		const h = harness(async ({ workspaceRoot }) => {
			roots.push(workspaceRoot);
			return undefined;
		});
		h.ctx.goalTracker = new ClaudeGoalTracker(h.ctx.sessionId, {
			sessionId: h.ctx.sessionId,
			goal: {
				condition: "Wait for confirmation",
				setAt: 1,
				tokensAtStart: 0,
				iterations: 0,
			},
		});
		await h.replay(enterTrace);
		expect(roots).toEqual([mainFolder]);
	});

	it("correlates snapshot-only tool calls and ignores duplicate result delivery", async () => {
		const h = harness();
		await h.replay(
			beforeResult().filter((message) => message.type === "assistant"),
		);
		await h.replay([declaredToolResult(), declaredToolResult()]);
		expect(moves(h.events).map((event) => event.data)).toEqual([
			{ path: worktreeFolder, source: "tool" },
		]);
	});

	it("correlates the reported call ID rather than the latest streamed tool", async () => {
		const h = harness();
		await h.replay(beforeResult());
		const otherCall = decodeClaudeSDKMessage({
			...declaredToolResult(),
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "unrelated",
						content: "worktree moved",
					},
				],
			},
		});
		await h.replay([otherCall, declaredToolResult()]);
		expect(
			moves(h.events).filter(
				(event) =>
					event.data && (event.data as { source: string }).source === "tool",
			),
		).toHaveLength(1);
	});

	it.each([
		undefined,
		null,
		{},
		"not a result object",
		{ worktreePath: 7 },
		{ worktreePath: "" },
		{ worktreePath: " /tmp/worktree" },
	])("ignores malformed declared tool result %j", async (tool_use_result) => {
		const h = harness();
		await h.replay(beforeResult());
		await h.replay([
			decodeClaudeSDKMessage({ ...declaredToolResult(), tool_use_result }),
		]);
		expect(moves(h.events).map((event) => event.data)).toEqual([
			{ path: mainFolder, source: "start" },
		]);
		expect(h.ctx.workspaceRoot).toBe(mainFolder);
	});

	it("ignores a failed EnterWorktree even when its result carries a path", async () => {
		const h = harness();
		await h.replay(beforeResult());
		const captured = declaredToolResult();
		await h.replay([
			decodeClaudeSDKMessage({
				...captured,
				message: {
					...captured.message,
					content: Array.isArray(captured.message.content)
						? captured.message.content.map((block) => ({
								...block,
								is_error: true,
							}))
						: [],
				},
			}),
		]);
		expect(moves(h.events)).toHaveLength(1);
		expect(h.events.some((event) => event.metadata?.["claudeWorktree"])).toBe(
			false,
		);
	});

	it("does not attribute one declared payload to an envelope with multiple tool results", async () => {
		const h = harness();
		await h.replay(beforeResult());
		const captured = declaredToolResult();
		await h.replay([
			decodeClaudeSDKMessage({
				...captured,
				message: {
					...captured.message,
					content: [
						...(Array.isArray(captured.message.content)
							? captured.message.content
							: []),
						{ type: "tool_result", tool_use_id: "other-call", content: "ok" },
					],
				},
			}),
		]);
		expect(moves(h.events)).toHaveLength(1);
		expect(h.ctx.workspaceRoot).toBe(mainFolder);
	});

	it("does not trust an unrelated tool's workspace-shaped result", async () => {
		const h = harness();
		await h.replay(
			beforeResult()
				.map((message) => {
					if (
						message.type !== "stream_event" ||
						message.event.type !== "content_block_start" ||
						message.event.content_block.type !== "tool_use"
					)
						return message;
					return decodeClaudeSDKMessage({
						...message,
						event: {
							...message.event,
							content_block: { ...message.event.content_block, name: "Bash" },
						},
					});
				})
				.filter((message) => message.type !== "assistant"),
		);
		await h.replay([declaredToolResult()]);
		expect(moves(h.events)).toHaveLength(1);
	});

	it("ignores subagent workspace reports", async () => {
		const h = harness();
		await h.replay(beforeResult());
		await h.replay([
			decodeClaudeSDKMessage({
				...declaredToolResult(),
				parent_tool_use_id: "parent-task",
			}),
		]);
		expect(moves(h.events)).toHaveLength(1);
		expect(h.ctx.workspaceRoot).toBe(mainFolder);
	});

	it("reports start once before acknowledging the running query's cwd", async () => {
		const h = harness();
		const init = enterTrace.find(
			(message) => message.type === "system" && message.subtype === "init",
		);
		if (!init) throw new Error("Captured init is missing");
		await h.replay([init, init]);
		expect(moves(h.events)).toHaveLength(1);
		const status = h.events.find((event) => event.type === "session.status");
		expect(status?.data).toEqual({
			sessionId: h.ctx.sessionId,
			status: "busy",
		});
		expect(status?.metadata?.["workspaceCwd"]).toBe(mainFolder);
		expect(
			h.events.findIndex((event) => event.type === "workspace.changed"),
		).toBeLessThan(
			h.events.findIndex((event) => event.type === "session.status"),
		);
	});

	it("does not report or acknowledge a blank runner cwd", async () => {
		const h = harness();
		const init = enterTrace.find(
			(message) => message.type === "system" && message.subtype === "init",
		);
		if (!init) throw new Error("Captured init is missing");
		await h.replay([decodeClaudeSDKMessage({ ...init, cwd: " " })]);
		expect(moves(h.events)).toEqual([]);
		expect(h.events.some((event) => event.metadata?.["workspaceCwd"])).toBe(
			false,
		);
	});

	it("includes the workspace declaration instruction in the Claude system prompt", () => {
		const options = buildClaudeQueryOptions(
			{
				sessionId: "workspace-session",
				workspaceRoot: mainFolder,
				extraFolders: [],
				providerState: {},
				model: { providerId: "claude", modelId: "claude-sonnet-5" },
			},
			new AbortController(),
			async () => ({ behavior: "allow", updatedInput: {} }),
			undefined,
			undefined,
		);
		expect(options.systemPrompt).toEqual({
			type: "preset",
			preset: "claude_code",
			append: "To work in another worktree, use EnterWorktree instead of cd.",
		});
	});
});

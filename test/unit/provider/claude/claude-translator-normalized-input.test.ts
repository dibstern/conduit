import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import type { ClaudeSessionContext } from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";
import { partialFake } from "../../../helpers/partial-fake.js";

function makeCtx(
	overrides: Partial<ClaudeSessionContext> = {},
): ClaudeSessionContext {
	return {
		sessionId: "ses-1",
		workspaceRoot: "/tmp/ws",
		configDir: configuredClaudeConfigDir("/tmp/claude-account"),
		startedAt: "2026-04-22T00:00:00.000Z",
		promptQueue: partialFake<ClaudeSessionContext["promptQueue"]>({
			enqueue: vi.fn(),
			close: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		}),
		query: partialFake<ClaudeSessionContext["query"]>({
			interrupt: vi.fn(),
			close: vi.fn(),
			setModel: vi.fn(),
			setPermissionMode: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		}),
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: undefined,
		currentTurnId: "turn-1",
		currentModel: "claude-sonnet-4",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
		...overrides,
	};
}

function runTranslate(
	translator: ClaudeEventTranslator,
	...args: Parameters<ClaudeEventTranslator["translate"]>
): Promise<void> {
	return Effect.runPromise(translator.translate(...args));
}

function dataOf(
	event: ProviderRuntimeEvent | undefined,
): Record<string, unknown> {
	expect(event).toBeDefined();
	return event?.data as Record<string, unknown>;
}

describe("ClaudeEventTranslator — normalized tool input", () => {
	it.each([
		{
			name: "Edit",
			input: {
				file_path: "/src/main.ts",
				old_string: "old",
				new_string: "new",
			},
			failed: false,
			expected: [
				{ path: "/src/main.ts", kind: "update", before: "old", after: "new" },
			],
		},
		{
			name: "Edit",
			input: {
				file_path: "/src/main.ts",
				old_string: "old",
				new_string: "new",
			},
			result: {
				filePath: "/src/main.ts",
				originalFile: "old\n",
				structuredPatch: [
					{
						oldStart: 1,
						oldLines: 1,
						newStart: 1,
						newLines: 1,
						lines: ["-old", "+new"],
					},
				],
			},
			failed: false,
			expected: [
				{
					path: "/src/main.ts",
					kind: "update",
					before: "old\n",
					patch:
						"--- /src/main.ts\n+++ /src/main.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
				},
			],
		},
		{
			name: "Write",
			input: { file_path: "/src/main.ts", content: "new" },
			result: {
				type: "update",
				filePath: "/src/main.ts",
				originalFile: "old whole file",
				content: "new whole file",
			},
			failed: false,
			expected: [
				{
					path: "/src/main.ts",
					kind: "update",
					before: "old whole file",
					after: "new whole file",
				},
			],
		},
		{
			name: "Write",
			input: { file_path: "/src/new.ts", content: "new" },
			result: { type: "create", filePath: "/src/new.ts", content: "new" },
			failed: false,
			expected: [{ path: "/src/new.ts", kind: "add", after: "new" }],
		},
		{
			name: "Edit",
			input: {
				file_path: "/src/main.ts",
				old_string: "old",
				new_string: "new",
			},
			failed: true,
			expected: [],
		},
	])("records successful $name changes and an empty list for failed edits ($failed)", async ({
		name,
		input,
		result,
		failed,
		expected,
	}) => {
		const events: ProviderRuntimeEvent[] = [];
		const translator = new ClaudeEventTranslator({
			getSink: () =>
				partialFake<EventSink>({
					push: (event: ProviderRuntimeEvent) =>
						Effect.sync(() => {
							events.push(event);
						}),
				}),
		});
		const ctx = makeCtx();
		await runTranslate(translator, ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "edit-1", name, input },
			},
		} as never);
		await runTranslate(translator, ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);
		await runTranslate(translator, ctx, {
			type: "user",
			session_id: "ses-1",
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "edit-1",
						content: "done",
						is_error: failed,
					},
				],
			},
			tool_use_result: result,
		} as never);
		expect(
			dataOf(events.find((event) => event.type === "tool.completed"))[
				"fileChanges"
			],
		).toEqual(expected);
	});

	it("tool.started event carries CanonicalToolInput with camelCase fields", async () => {
		const events: ProviderRuntimeEvent[] = [];
		const translator = new ClaudeEventTranslator({
			getSink: () => ({
				push: (e: ProviderRuntimeEvent) =>
					Effect.sync(() => {
						events.push(e);
					}),
				requestPermission: vi.fn(() =>
					Effect.succeed({ decision: "once" as const }),
				),
				requestQuestion: vi.fn(() => Effect.succeed({})),
				resolvePermission: vi.fn(() => Effect.void),
				resolveQuestion: vi.fn(() => Effect.void),
			}),
		});

		const ctx = makeCtx();

		// Simulate content_block_start with a Read tool_use block
		await runTranslate(translator, ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_123",
					name: "Read",
					input: { file_path: "/src/main.ts", offset: 10 },
				},
			},
		} as never);

		// Flush buffered tool.started via content_block_stop
		await runTranslate(translator, ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);

		const toolStarted = events.find((e) => e.type === "tool.started");
		expect(toolStarted).toBeDefined();
		expect(toolStarted?.providerRefs).toEqual({
			providerToolUseId: "toolu_123",
		});
		expect(dataOf(toolStarted)["input"]).toEqual({
			tool: "Read",
			filePath: "/src/main.ts",
			offset: 10,
		});
	});
});

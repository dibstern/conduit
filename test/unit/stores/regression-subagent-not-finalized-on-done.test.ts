// ─── Regression: subagent Task must survive the parent turn's `done` ─────────
// A subagent (Task/Agent) tool completes via its OWN task_notification →
// tool.completed, and can still be running after the parent emits `done`
// (backgrounded or long-running subagents). handleDone → toolRegistry.finalizeAll
// used to force-complete every running tool, flipping the still-running Task to
// "completed" ("Done"). That stale "completed" then gets pinned across
// navigate-into-subagent-and-back reloads by preserveCachedSubagentToolState.
//
// Fix: finalizeAll skips subagent tools, leaving them to event-driven completion.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	let store: Record<string, string> = {};
	const mock = {
		getItem: vi.fn((key: string) => store[key] ?? null),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
		}),
		clear: vi.fn(() => {
			store = {};
		}),
		get length() {
			return Object.keys(store).length;
		},
		key: vi.fn((_: number) => null),
	};
	Object.defineProperty(globalThis, "localStorage", {
		value: mock,
		writable: true,
		configurable: true,
	});
});
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	chatState,
	clearMessages,
	clearSessionChatState,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";

beforeEach(() => {
	clearMessages();
	sessionState.currentId = null;
	clearSessionChatState("sub-parent");
	sessionState.sessions.set("sub-parent", { id: "sub-parent", title: "" });
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("Regression: parent `done` does not complete a running subagent Task", () => {
	it("keeps the Task running after a parent done while the subagent is in progress", async () => {
		handleMessage({
			type: "session_switched",
			id: "sub-parent",
			sessionId: "sub-parent",
			events: [
				{ type: "user_message", sessionId: "s1", text: "spawn a subagent" },
				{ type: "tool_start", sessionId: "s1", id: "task-1", name: "Task" },
				{
					type: "tool_executing",
					sessionId: "s1",
					id: "task-1",
					name: "Task",
					input: { description: "Explore", subagent_type: "explore" },
				},
				// Parent turn ends while the subagent is STILL running (no tool_result
				// for task-1 — backgrounded / outlives the visible turn).
				{ type: "done", sessionId: "s1", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		const task = chatState.messages.find(
			(m) => m.type === "tool" && m.name === "Task",
		);
		expect(task?.type).toBe("tool");
		if (task?.type === "tool") {
			expect(task.status).toBe("running");
		}
	});

	it("still force-completes ordinary running tools on done", async () => {
		handleMessage({
			type: "session_switched",
			id: "sub-parent",
			sessionId: "sub-parent",
			events: [
				{ type: "user_message", sessionId: "s1", text: "read a file" },
				{ type: "tool_start", sessionId: "s1", id: "t1", name: "Read" },
				{
					type: "tool_executing",
					sessionId: "s1",
					id: "t1",
					name: "Read",
					input: { path: "foo.ts" },
				},
				{ type: "done", sessionId: "s1", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		const read = chatState.messages.find(
			(m) => m.type === "tool" && m.name === "Read",
		);
		expect(read?.type).toBe("tool");
		if (read?.type === "tool") {
			expect(read.status).toBe("completed");
		}
	});
});

// ─── Todo Store ──────────────────────────────────────────────────────────────
// Manages todo items from both SSE `todo_state` events and `TodoWrite` tool results.
// Provides reactive state for the TodoOverlay component.

import type { RelayMessage, TodoItem } from "../types.js";

// ─── State ──────────────────────────────────────────────────────────────────

export const todoState = $state({
	items: [] as TodoItem[],
});

// ─── Message handlers ───────────────────────────────────────────────────────

/** Handle `todo_state` messages from SSE `todo.updated` events. */
export function handleTodoState(
	msg: Extract<RelayMessage, { type: "todo_state" }>,
): void {
	todoState.items = msg.items ?? [];
}

/**
 * Parse a TodoWrite tool result and update the store.
 * Called when a `tool_result` for TodoWrite is received.
 * The raw JSON has `{content, status, priority}` — we map to `TodoItem.subject`.
 */
export function updateTodosFromToolResult(jsonString: string): void {
	try {
		const parsed = JSON.parse(jsonString);
		const rawItems: unknown[] = Array.isArray(parsed?.todos)
			? parsed.todos
			: Array.isArray(parsed)
				? parsed
				: [];

		todoState.items = rawItems.map((item: unknown, i: number) => {
			const t = item as Record<string, unknown>;
			const desc = t["description"] ? String(t["description"]) : undefined;
			return {
				id: t["id"] ? String(t["id"]) : `todo-${i}`,
				// OpenCode TodoWrite outputs `content`; our TodoItem type uses `subject`
				subject: String(t["subject"] ?? t["content"] ?? ""),
				...(desc != null && { description: desc }),
				status: (t["status"] as TodoItem["status"]) ?? "pending",
			};
		});
	} catch {
		// Ignore parse errors — don't clear existing todos
	}
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Clear todo state (for project/session switch). */
export function clearTodoState(): void {
	todoState.items = [];
}

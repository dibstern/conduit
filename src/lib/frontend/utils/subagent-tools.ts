// ─── Subagent Tool Identity ──────────────────────────────────────────────────
// Task/Agent tools spawn child subagent sessions and have a lifecycle
// independent of the parent turn: they complete via their own
// task_notification → tool.completed and may still be running after the parent
// emits `done` (backgrounded or long-running subagents). Several call sites must
// treat them specially — skip turn finalization (tool-registry), preserve a
// cached terminal status across navigate-in/out reloads (ws-dispatch), keep live
// status when loaded from history (history-logic), mark their row in the activity
// log with a rail (turns/ActivityRow), and render the subagent card when one is
// handed back to the transcript (ToolItem). Keep the name check in ONE place so a
// new call site can't forget a variant.

/** Canonical ("Task"/"Agent") plus the legacy lowercase ("task") names the
 *  frontend uses for subagent tools. */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
	"Task",
	"task",
	"Agent",
]);

export function isSubagentToolName(name: string): boolean {
	return SUBAGENT_TOOL_NAMES.has(name);
}

/** The session a subagent tool spawned, or null when it cannot be pinned down.
 *  Each strategy correlates one specific tool call to its session; matching
 *  against the session list generally is deliberately omitted because it cannot
 *  tell two child sessions apart and would return a stale or wrong one. */
export function subagentSessionId(tool: {
	metadata?: unknown;
	input?: unknown;
	result?: string | undefined;
}): string | null {
	const metadata = tool.metadata as Record<string, unknown> | undefined;
	for (const key of ["childSessionId", "sessionId"]) {
		const value = metadata?.[key];
		if (typeof value === "string" && value) return value;
	}
	// Tool inputs arrive under both camelCase and snake_case depending on the
	// provider, and Agent calls nest the real input one level down under `raw`.
	let record = (tool.input ?? {}) as Record<string, unknown>;
	const raw = record["raw"];
	if (
		record["tool"] === "Unknown" &&
		record["name"] === "Agent" &&
		raw &&
		typeof raw === "object" &&
		!Array.isArray(raw)
	) {
		record = raw as Record<string, unknown>;
	}
	for (const key of ["taskId", "task_id"]) {
		const value = record[key];
		if (typeof value === "string" && value) return value;
	}
	return tool.result?.match(/task_id:\s*(\S+)/)?.[1] ?? null;
}

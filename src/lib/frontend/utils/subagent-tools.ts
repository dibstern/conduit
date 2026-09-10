// ─── Subagent Tool Identity ──────────────────────────────────────────────────
// Task/Agent tools spawn child subagent sessions and have a lifecycle
// independent of the parent turn: they complete via their own
// task_notification → tool.completed and may still be running after the parent
// emits `done` (backgrounded or long-running subagents). Several call sites must
// treat them specially — skip turn finalization (tool-registry), preserve a
// cached terminal status across navigate-in/out reloads (ws-dispatch), keep live
// status when loaded from history (history-logic), never group them (group-tools),
// and render the subagent card (ToolItem). Keep the name check in ONE place so a
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

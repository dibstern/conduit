import type { SessionPermissionMode } from "./types.js";

/** `claudeOnly` marks modes backed by a Claude Agent SDK permission mode
 *  with no OpenCode equivalent. All six of the SDK's modes are offered; the
 *  session runs whichever one the SDK reports, which is what keeps the pill
 *  honest when plan mode exits itself on approval.
 *
 *  `elevated` marks the modes that *relax* approvals, so a surface can warn
 *  about them. "Never ask" is more restrictive than "Ask", so it is not
 *  elevated even though it is not the default. */
export const PERMISSION_MODES: ReadonlyArray<{
	mode: SessionPermissionMode;
	label: string;
	claudeOnly?: boolean;
	elevated?: boolean;
}> = [
	{ mode: "plan", label: "Plan", claudeOnly: true },
	{ mode: "ask", label: "Ask" },
	{ mode: "acceptEdits", label: "Edits", elevated: true },
	{ mode: "auto", label: "Auto", claudeOnly: true, elevated: true },
	{ mode: "full", label: "Full access", elevated: true },
	{ mode: "dontAsk", label: "Never ask", claudeOnly: true },
];

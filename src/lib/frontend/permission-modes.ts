import type { SessionPermissionMode } from "./types.js";

/** `claudeOnly` marks modes backed by a Claude Agent SDK permission mode
 *  with no OpenCode equivalent. All six of the SDK's modes are offered; the
 *  session runs whichever one the SDK reports, which is what keeps the pill
 *  honest when plan mode exits itself on approval.
 *
 *  `elevated` marks the modes that *relax* approvals, so a surface can warn
 *  about them. "Never ask" is more restrictive than "Ask", so it is not
 *  elevated even though it is not the default.
 *
 *  `sessionOnly` marks the modes that may only be chosen for the session
 *  you are in, never as a Conduit-wide default. A default is inherited by
 *  sessions of every provider, and these two have no OpenCode equivalent and
 *  no path back out of them: the pill does not offer them to a non-Claude
 *  session, so a session that inherited one would be stuck in a mode with no
 *  visible way to leave. "Auto" is also Claude-only but is not session-only,
 *  because PermissionModeSelector normalises it to "Ask" on any non-Claude
 *  provider, so a session that inherits it recovers on its own. */
export const PERMISSION_MODES: ReadonlyArray<{
	mode: SessionPermissionMode;
	label: string;
	claudeOnly?: boolean;
	elevated?: boolean;
	sessionOnly?: boolean;
}> = [
	{ mode: "plan", label: "Plan", claudeOnly: true, sessionOnly: true },
	{ mode: "ask", label: "Ask" },
	{ mode: "acceptEdits", label: "Edits", elevated: true },
	{ mode: "auto", label: "Auto", claudeOnly: true, elevated: true },
	{ mode: "full", label: "Full access", elevated: true },
	{ mode: "dontAsk", label: "Never ask", claudeOnly: true, sessionOnly: true },
];

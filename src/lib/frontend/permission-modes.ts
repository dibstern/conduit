import type { SessionPermissionMode } from "./types.js";

export const PERMISSION_MODES: ReadonlyArray<{
	mode: SessionPermissionMode;
	label: string;
}> = [
	{ mode: "ask", label: "Ask" },
	{ mode: "acceptEdits", label: "Edits" },
	{ mode: "auto", label: "Auto" },
	{ mode: "full", label: "Full access" },
];

import type { SessionPermissionMode } from "../../shared-types.js";

/** Pin sticky app-server settings on every turn, including leaving plan mode. */
export function codexSessionConfig(input: {
	readonly permissionMode?: SessionPermissionMode | undefined;
	readonly cwd: string;
	readonly modelId: string;
	readonly effort?: string | undefined;
}) {
	const mode = input.permissionMode ?? "ask";
	return {
		approvalPolicy: mode === "ask" ? "untrusted" : "on-request",
		sandboxPolicy:
			mode === "full"
				? { type: "dangerFullAccess" }
				: mode === "acceptEdits" || mode === "auto"
					? { type: "workspaceWrite", writableRoots: [input.cwd] }
					: { type: "readOnly" },
		approvalsReviewer: mode === "auto" ? "auto_review" : "user",
		collaborationMode: {
			mode: mode === "plan" ? "plan" : "default",
			settings: {
				model: input.modelId,
				reasoning_effort: input.effort ?? null,
				developer_instructions: null,
			},
		},
	};
}

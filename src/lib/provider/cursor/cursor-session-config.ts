import type { SessionPermissionMode } from "../../shared-types.js";
import type {
	CursorAgentOptions,
	CursorCredential,
	CursorModelParameter,
	CursorSendOptions,
} from "./sdk-port.js";

export interface CursorSessionConfig {
	readonly agent: CursorAgentOptions;
	readonly send: CursorSendOptions;
	readonly hookPolicy: {
		readonly gatedToolCall: "allow";
		readonly perCallApproval: "unsupported";
	};
}

export function cursorSessionDirs(
	cwd: string | undefined,
	workspaceRoot: string | undefined,
	extraFolders: readonly string[],
): string[] {
	return [...new Set([workspaceRoot, ...extraFolders])]
		.filter(
			(folder): folder is string => folder !== undefined && folder !== cwd,
		)
		.sort();
}

/** cwd is the agent's original lookup identity; workspace changes become dirs. */
export function cursorSessionConfig(input: {
	readonly cwd: string;
	readonly storePath: string;
	readonly workspaceRoot: string;
	readonly extraFolders: readonly string[];
	readonly permissionMode?: SessionPermissionMode | undefined;
	readonly modelId: string;
	readonly modelParams?: readonly CursorModelParameter[] | undefined;
	readonly credential: Pick<CursorCredential, "fingerprint">;
}): CursorSessionConfig {
	const mode = input.permissionMode ?? "ask";
	return {
		agent: {
			cwd: input.cwd,
			dirs: cursorSessionDirs(
				input.cwd,
				input.workspaceRoot,
				input.extraFolders,
			),
			settingSources: ["project", "user", "team", "mdm", "plugins"],
			storePath: input.storePath,
			sandboxOptions: { enabled: mode !== "full" },
			autoReview: mode === "ask" || mode === "auto" || mode === "plan",
			tools: [
				"shell",
				"read",
				"edit",
				"grep",
				"glob",
				"ls",
				"mcp",
				"webSearch",
				"delete",
				"readLints",
				"webFetch",
				"semSearch",
				"updateTodos",
				"readTodos",
				"task",
			],
			disallowedTools: ["askQuestion"],
			customToolNames: ["ask_user"],
			subagentInherit: { reportedWorkspacePath: input.workspaceRoot },
			credentialFingerprint: input.credential.fingerprint,
		},
		send: {
			model: {
				id: input.modelId,
				params: input.modelParams ?? [],
			},
			mode: mode === "plan" ? "plan" : "agent",
		},
		hookPolicy: { gatedToolCall: "allow", perCallApproval: "unsupported" },
	};
}

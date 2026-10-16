import type { SessionPermissionMode } from "../../shared-types.js";
import type {
	CursorAgentOptions,
	CursorCredential,
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

/** cwd is the agent's original lookup identity; workspace changes become dirs. */
export function cursorSessionConfig(input: {
	readonly cwd: string;
	readonly storePath: string;
	readonly workspaceRoot: string;
	readonly extraFolders: readonly string[];
	readonly permissionMode?: SessionPermissionMode | undefined;
	readonly modelId: string;
	readonly credential: Pick<CursorCredential, "fingerprint">;
}): CursorSessionConfig {
	const mode = input.permissionMode ?? "ask";
	return {
		agent: {
			cwd: input.cwd,
			dirs: [...new Set([input.workspaceRoot, ...input.extraFolders])]
				.filter((folder) => folder !== input.cwd)
				.sort(),
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
			],
			disallowedTools: ["task", "askQuestion"],
			customToolNames: [],
			subagentInherit: { reportedWorkspacePath: input.workspaceRoot },
			credentialFingerprint: input.credential.fingerprint,
		},
		send: {
			model: {
				id: input.modelId,
				...(input.modelId === "composer-2.5"
					? { params: [{ id: "fast", value: "false" }] }
					: {}),
			},
			mode: mode === "plan" ? "plan" : "agent",
		},
		hookPolicy: { gatedToolCall: "allow", perCallApproval: "unsupported" },
	};
}

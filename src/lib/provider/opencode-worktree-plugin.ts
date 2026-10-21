import { resolve } from "node:path";
import { z } from "zod";
import { WorkspaceMoveError } from "../contracts/session-workspace.js";
import { sendRpcRequest } from "../daemon/daemon-rpc-client.js";

/** Loaded only by OpenCode servers spawned by Conduit. */
export default async function ConduitWorktreePlugin() {
	const socketPath = process.env["CONDUIT_DAEMON_SOCKET"];
	const instanceId = process.env["CONDUIT_OPENCODE_INSTANCE_ID"];
	return {
		tool: {
			conduit_use_worktree: {
				description:
					"Declare that this Conduit session works in an existing git worktree of its project repository.",
				args: {
					path: z.string().min(1).describe("Path to the existing git worktree"),
				},
				async execute(
					{ path }: { path: string },
					context: { sessionID: string; directory: string },
				): Promise<string> {
					if (!socketPath || !instanceId)
						return "Workspace move refused: the Conduit daemon connection is not configured.";
					try {
						const { directory } = await sendRpcRequest(socketPath, {
							_tag: "OpenCodeUseWorktree",
							instanceId,
							providerSessionId: context.sessionID,
							path: resolve(context.directory, path),
						});
						return `Session workspace moved to ${directory}.`;
					} catch (error) {
						if (error instanceof WorkspaceMoveError) {
							switch (error.reason) {
								case "missing":
									return "Workspace move refused: the path does not exist.";
								case "not-a-worktree":
									return "Workspace move refused: the path is not a git worktree.";
								case "other-repository":
									return "Workspace move refused: the worktree belongs to another repository.";
								case "unsupported-provider":
									return "Workspace move refused: this provider does not support declared worktree moves.";
							}
						}
						return `Workspace move refused: ${error instanceof Error ? error.message : String(error)}`;
					}
				},
			},
		},
	};
}

import type { SessionWorkspace } from "../contracts/session-workspace.js";

/** The primary folder's worktree, otherwise the single moved folder, otherwise primary. */
export function effectiveWorkingDirectory(
	primary: string,
	workspace: SessionWorkspace | null | undefined,
): string {
	const worktrees = workspace?.worktrees;
	if (worktrees?.[primary]) return worktrees[primary];
	const paths = Object.values(worktrees ?? {});
	return paths.length === 1 ? (paths[0] ?? primary) : primary;
}

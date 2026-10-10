# Domain vocabulary

**Session Workspace** is a session's recorded mapping from project folders to
existing git worktrees, with the move's cause and the worktrees' origin. Only the
Session Workspace service writes it, as a `session.workspace_changed` canonical
event through the session-command seam. An empty map projects to NULL, meaning
the project's main folders. Existing sessions keep that default. Branch names
are read from git, never stored in the workspace.

**Effective Working Directory** is the primary project folder's mapped worktree,
otherwise the only mapped worktree, otherwise the primary project folder. The
session's git pill and next provider launch use it. Other launch folders are the
remaining project folders mapped through the workspace. A move updates the
session immediately and takes effect on the next turn, leaving a running turn
undisturbed.

# Conduit project model

## Repository Identity

A Project Folder's Repository Identity is its canonical repository `key`, display
`name`, and repository toplevel `root`. It is derived locally by Git, without
contacting a remote. Non-git and bare folders have no working-tree identity.

Hosted origin remotes collapse SSH, HTTPS and Git URL spellings to
`host/owner/repo`. The key ignores userinfo, ports, trailing slashes, `.git`, and
host/owner/repository case. Nested groups remain in the key. The display name
preserves the repository name's case. With no origin, the key is the absolute
realpath of Git's shared common directory, so linked worktrees share a key and
display name while each keeps its own repository root. Unsupported or malformed
origins, such as local-path remotes, use that same shared-directory key.
Inaccessible folders, Git errors and timeouts produce no identity.

Stored projects and `GetProjects` use an optional `repositoryIdentities` map,
keyed by the project's folder paths. A missing entry means that folder has no
identity. An absent map is legacy state awaiting derivation; an empty map records
a completed attempt with no identities. A map follows folder paths regardless of
folder ordering and contains no detached folders.

Saving a project derives its current folders after path validation and realpath
resolution. Project-list reads lazily backfill legacy state and request a config
save. The daemon's project registry layer refreshes every stored folder before
HTTP/RPC consumers start, so remote changes are reflected after restart. Identity
discovery is best-effort and never rejects a project save or daemon startup.

## Session Workspace

**Session Workspace** is a session's recorded mapping from project folders to
existing git worktrees, with the move's cause and the worktrees' origin. Only the
Session Workspace service writes it, as a `session.workspace_changed` canonical
event through the session-command seam. An empty map projects to NULL, meaning
the project's main folders. Existing sessions keep that default. Branch names
are read from git, never stored in the workspace.

Moves require the session provider's `supportsWorktree` capability. OpenCode
moves are refused before recording an event; Claude supports moves.

**Effective Working Directory** is the primary project folder's mapped worktree,
otherwise the only mapped worktree, otherwise the primary project folder. The
session's git pill and next provider launch use it. Other launch folders are the
remaining project folders mapped through the workspace. A user move updates the
session immediately and takes effect on the next turn, leaving a running turn
undisturbed.

Claude's successful `EnterWorktree` and `ExitWorktree` results emit the provider
event `workspace.changed`. The Session Workspace service validates and records
these agent moves during the turn, and the runner updates its saved launch
folder so the next turn reuses it. Claude-created `.claude/worktrees` folders are
validated as linked git worktrees of a configured project repository. Startup
cwd reports reconcile unrecorded agent moves unless a user move is pending.

`claudeWorktreeState` derives the active EnterWorktree state from recorded tool
metadata. A user move remains pending until a later startup cwd or successful
worktree declaration acknowledges its effective working directory. Both states
survive daemon restarts without additional session columns.

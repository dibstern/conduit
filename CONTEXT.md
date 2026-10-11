# Conduit project model

## Project Provenance

A stored event or durable command belongs to the project's stable slug, its
`projectId`. Folder edits keep that identity. The store binds it at construction,
so event and command writers inherit it. Events use `events.project_id`; command
tables use their existing `project_key` as the project id column. It always holds
the slug, never a workspace path. Opening a per-project store stamps legacy
events and rewrites legacy command keys to its slug without changing ids, order
or payloads. Converging command metadata keeps the highest applied sequence.
Event sequences, command receipts and projector cursors carry that owner in
their in-memory contracts. Reads and projections remain per-store.

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

**Session Workspace** is where a session runs: Local uses the project's folders;
New worktree uses session-owned git worktrees on one generated branch. Its
recorded mapping from Project Folders to worktrees includes the move's cause and
origin, `existing` or `conduit`. Only the
Session Workspace service writes it, as a `session.workspace_changed` canonical
event through the session-command seam. An empty map means the project's main
folders; its projection keeps fallback and origin metadata when needed, otherwise
it is NULL. Existing sessions keep that default. Branch names
are read from git, never stored in the workspace.

Worktree sessions use their own branch's merged signal to settle through the sidebar's automatic rule, keep their workspace and worktrees, and return to Active when messaged, with that merge ignored for the resumed work.

Conduit's Worktree daemon service creates a checkout under
`<configDir>/worktrees/<project>/<session>/<folder>` before the session exists,
then the Session Workspace service records its launch move. By default it starts
from the folder's committed HEAD on its current branch. A new worktree draft can
choose a local base branch for the primary Project Folder; other git folders
still start from their own current HEAD. Tags, remote refs and revision
expressions cannot be bases. Invalid bases fail before any checkout, branch or
session is created, and a base requires New worktree mode. Uncommitted changes
stay in the original checkout. Creation or launch failure rolls back the checkout
and its new branch. These worktrees cannot become projects or Project Folders.

A multi-folder worktree session creates a worktree in every git folder on one
branch name. Folders of one repository share a checkout and must resolve to the
same starting commit. Non-git folders and folders attached later are used in place and
reported as shared; detaching a folder keeps its worktree on disk.

Direct user moves require the session provider's `supportsWorktree` capability.
Claude supports moves. OpenCode keeps that capability disabled: its native
`moveSession` rejects a destination belonging to another repository. The narrower
`supportsNewWorktree` capability permits Conduit-owned launches, recreation and
recovery to the primary folder. OpenCode reserves the launch id through its v2
session API and aligns its native directory before the next turn.

**Effective Working Directory** is the primary Project Folder's worktree,
otherwise the primary folder for a conduit-created workspace. An existing move
can use its only mapped worktree instead. The
session's git pill and next provider launch use it; new terminals default to it
and the picker can start one in any Effective Folder.
**Effective Folders** are each Project Folder's session worktree when mapped,
otherwise the Project Folder itself. A worktree is session state, not a project. Git status is reported per git Effective Folder.
The file tree lists every Effective Folder, each Project Folder mapped through
the workspace, as a labelled root, primary first. Single-folder projects keep
their existing tree without an extra root row. File list and content requests
can target a root; requests without one still use the Effective Working
Directory. Mention completion continues to list that directory. Already-open
terminals keep their start folder. Other launch folders are the
remaining project folders mapped through the workspace. A user move updates the
session immediately and takes effect on the next turn, leaving a running turn
undisturbed.

Claude's successful `EnterWorktree` and `ExitWorktree` results emit the provider
event `workspace.changed`. The Session Workspace service resolves paths, folder
ownership, provider capability and git cache state outside commit permits, then
re-reads the session and records the move through the session-command seam.
Provider ingestion resolves before its write and records inside the receipt
transaction. The runner updates its saved launch folder so the next turn reuses
it. Claude-created `.claude/worktrees` folders are validated as linked git
worktrees of a configured project repository.

Startup cwd reports reconcile unrecorded agent moves unless a user move is
pending. `session.workspace_started` records the normalized reported cwd as an
observation, without changing the workspace. A matching startup after a user
move acknowledges it durably; a mismatching startup leaves that move pending.
Successful tool declarations also acknowledge a user move to the same path.

`claudeWorktreeState` derives the active EnterWorktree state from recorded tool
metadata. A user move remains pending until a later startup cwd or successful
worktree declaration acknowledges its effective working directory. Both states
survive daemon restarts without additional session columns.

At turn start, a missing recorded worktree with origin `existing` moves back to
the main folder with cause `missing`, using the same pending Claude directive
rules as a user move; a missing main folder still fails. Forks copy the parent's
complete worktrees map and origin as a launch move before their first turn.
Conduit-created worktrees never fall back automatically: a missing checkout is
reported on read and requires explicit recreation or a user move to the main folder.

## Workspace Hint

**Workspace Hint** is a suggested effective working directory when the latest
completed turn writes at least three times in one other worktree and never in
the recorded workspace. Read-only tools do not count, and writes split across
worktrees produce no hint. Relative paths use the workspace recorded during
that turn. The watcher resolves paths through the Session Workspace service
and never moves the session.

`session.workspace_hint_changed` projects the suggested path onto the session
row, so the hint survives daemon restarts. Accepting it uses the normal user
move; a move to that path clears the hint. Dismissal is daemon memory keyed by
session and hint folder, omitted from every client's session row through the
normal shell and family subscriptions. A different folder, or a cleared hint,
resets the dismissal. The hint works for writes back to the main checkout too.

The checkout pill shows the folder suggestion with Move and Dismiss actions on
desktop. Phones show an accessible icon and put both actions in the pill menu.

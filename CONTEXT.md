# Conduit project model

## Project

A **Project** is a named, saved set of one or more Project Folders and the only
way sessions are grouped (ADR-0011). Its first folder is the main folder, which
no other project may use as its main folder; other folders can be shared.
Every session belongs to one project for life, and projects never merge.
Conduit is never "in" a project: the `?p=<slug>` Scope names a project but is
not app state.

The **Scratch Project** is the hidden project behind New Session's "No
project". Each scratch session runs in its own `<configDir>/scratch/<session
id>/` folder. Only an unsent draft can switch between it and a real project.

## Project Provenance

A stored event or durable command belongs to the project's stable slug, its
`projectId`. Folder edits keep that identity. The store binds it at construction,
so event and command writers inherit it. Events use `events.project_id`; command
tables use their existing `project_key` as the project id column. It always holds
the slug, never a workspace path. Opening a per-project store stamps legacy
events and rewrites legacy command keys to its slug without changing ids, order
or payloads. Converging command metadata keeps the highest applied sequence.
Event sequences, command receipts and projector cursors carry that owner in
their in-memory contracts. List reads filter by Scope. Session-keyed reads,
projections, projector cursors and the version counter stay store-wide.

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

## Session list Scope

The session list's **Scope** is one project or all projects. The URL's `p`
parameter selects a project by slug; omitting it shows all projects. Each scope
selection adds a browser history entry. `project:` search tokens select one
project. Unknown project slugs show an empty list without widening the scope.
Search, paging and live rows all filter by the project's slug alone.

Projects whose main folders share a Repository Identity remain separate projects.
Session rows show their project title. The sidebar's arrangement can group rows
by status, project or time; project arrangement has one heading per project,
titled with that project's title. Repository Identity remains a folder fact and
appears in the project dialog.

Old repository-group scope links are replaced with the unscoped URL when the
router reads them. Retired grouping settings in existing configuration are
ignored on load and dropped on the next save. No projects or sessions merge.

## Session Workspace

**Session Workspace** is where a session runs: Local uses the project's folders;
New worktree uses session-owned git worktrees on one generated branch. Its
recorded mapping from Project Folders to worktrees includes the move's cause and
origin, `existing` or `conduit`. Only the
Session Workspace service writes it, as a `session.workspace_changed` canonical
event through the session-command seam. An empty map means the project's main
folders; its projection keeps fallback and origin metadata when needed, otherwise
it is NULL. Existing sessions keep that default. Current branch names
are read from git, never stored in the workspace. Conduit launch events retain
the originally created checkout, branch and committed base as deletion
provenance; forks inherit the workspace without that ownership. A branch rename
validates every launch-owned checkout, renames their branches together and rolls
back Git failures. It records updated branch ownership as a
`session.workspace_changed` event with cause `branch-rename`, leaving workspace
paths, move cause and pending moves unchanged. Deletion follows that latest
owned branch name. The git pill offers Rename branch only with launch ownership
and refreshes git status immediately after a rename.

Deleting a session inspects its launch-created checkouts, including ones left
behind after a move or folder detach. Uncommitted changes, unpushed commits,
unmerged commits or an unknown default branch default the prompt to Keep.
Checkouts used by another live session are always kept. Cleanup follows the
canonical `session.deleted` event and is best-effort; it rechecks use and
dirtiness, never force-removes a dirty checkout, and removes a Conduit-created
branch only after successful checkout removal and a merged check. Detached
checkouts are kept unless their commits are known to be merged into the default
branch.

Cleanup also keeps a checkout while its session's Claude runner owns a live
process, including while stopping, exiting after idle, or being adopted after a
daemon restart. Clean up now reports "Agent process is running". This guard is
separate from quiescence and applies again at removal time, including immediate
removal after deletion when ending the agent fails. It reads the relay's runner
pool, never discovers runners from disk. OpenCode sessions have no Claude runner
and are unaffected. Every cleanup run first stops live agents of quiescent
settled sessions, even when cleanup is Off. The sweep can then remove eligible
checkouts in the same run.

Automatic worktree cleanup applies only after a session settles or is deleted.
The default settle rule removes a checkout when nothing is missing: its inspected
head is an ancestor of local main or master, or origin/HEAD when set, and it has
no tracked changes or untracked, non-ignored files. This includes clean branches
with no new commits; squash merges are kept. This rule always protects
uncommitted and untracked files, even when the user's keep level protects only
tracked changes.

An optional settled-age rule removes checkouts after the configured number of
days since settling, even with unmerged commits. Never disables it; Right away
makes the next cleanup run eligible. This rule and the delete rule use the user's
keep level. The settled-age rule takes precedence when due. Automatic cleanup
keeps branches so a checkout can be recreated on the next message. Active
sessions are never removed merely for inactivity, merging, or having no commits.

Each project can use the global cleanup rules, turn cleanup Off, or supply a full
Custom rules override in Settings. Overrides live in the project's daemon.json
entry, never in conduit.json, and each cleanup run reads the current effective
rules again before removal. Off projects still stop quiescent settled agents,
but Clean up now neither removes nor reports their worktrees.

Worktree sessions use their own branch's merged signal to settle through the
sidebar's automatic rule and return to Active when messaged, with that merge
ignored for the resumed work.

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

## Setup Script

A **Setup Script** prepares a New worktree session before its first agent turn.
The daemon project setting takes precedence over the Project File. Empty or
whitespace-only settings clear the override. Local sessions never run setup.
Creation returns as soon as the session and worktrees exist; its first turn waits
for setup to finish. The script runs in the Effective Working Directory through
the user's shell with the project's shell environment. Output is merged, streamed
and capped at 64 KiB with a truncation note. A ten-minute timeout kills its process
group. A daemon-lifetime pipe also stops the group if the daemon dies. Failure
and timeout leave the session usable.

`session.setup_started`, `session.setup_output` and `session.setup_finished` are
canonical session commands. They project one notice in the durable transcript.
Interrupted setup becomes a failed notice on shutdown or the next relay startup,
so a restart never leaves it running forever.

## Project File

The **Project File** is `conduit.json` in the primary Project Folder, never in a
session's worktree. Its implementation-free Effect Schema accepts optional
`setupScript` and `sessionMode` and ignores unknown keys. It is read afresh for every new worktree
session. Invalid JSON or schema data skips setup with a visible notice; a daemon
setup override still takes precedence. An absent script means no setup.

## Default Session Mode

The **Default Session Mode** is `local` or `worktree`. The daemon project
override wins, then the Project File, then the daemon's global default, which
is Local when unset. Clearing a project override restores that inheritance.
The daemon resolver reads the primary folder's Project File afresh for each
draft project or provider change and returns the mode and its source. Invalid
files are ignored with a visible warning, including when a project override
wins.

New worktree is selected only when the project has a Git folder and the provider
supports creating worktrees. Otherwise the draft starts Local and the existing
control explains why. Explicit draft choices survive late defaults and layout
changes. Global edits apply to the next draft. Neither defaults nor workspace
choices are stored in browser storage.

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

## Run

A **Run** is one provider execution owned by Conduit, with a stable identity
separate from the provider's native execution id. A session has at most one
active Run, which can accept several Run Inputs. Its states are Queued,
Starting, Running, Interrupting, Settling and Ended; Ended records an outcome
and a typed reason.

_Avoid_: turn as a synonym for Run. A transcript turn represents one user
input; several inputs can belong to one Run.

## Run Input

A **Run Input** is one user message associated with a Run, including its native
message identity when known. Its states are Queued, Delivered, Accepted and
Declined; delivery alone does not prove provider acceptance.

_Avoid_: Run or turn when the distinction between a message and its execution
matters.

## Run Effect

A **Run Effect** is a durable instruction produced by a Run Ledger decision
for a provider executor, such as start, steer, interrupt, close or end. Its
outcome returns to the ledger as retryable, permanent or delivery-unknown;
delivery-unknown work requires a probe before any resend.

_Avoid_: outbox command as the domain name. The old command outbox is replaced
by Run Effects.

## Send Token

A **Send Token** identifies one transmission of a Run Effect, including timers.
A retry is a new transmission with a new token; tokens are never reused. Every
provider observation names the token of the send it answers, and evidence for a
token that is no longer live never changes Run state. Retiring a Run, an
attempt or a project retires its tokens.

_Avoid_: attempt, admission or version checks as a way to decide staleness;
they are what Send Tokens replace.

## Steer

A **Steer** is a Run Input admitted while a Run is active to redirect that
same Run. If the provider declines it, the input returns to the inbox queue.

_Avoid_: parallel Run or joined Run. Steering adds input to the one active Run.

## Tombstone

A **Tombstone** is the durable fact that a Run is Ended. Later events carrying
that Run's id cannot reopen it or change its state. Late accounting (usage,
cost, token totals) is still recorded against the ended Run's inputs.

_Avoid_: an uncorrelated provider-idle observation or a delivery receipt as
proof that a Run is Ended.

## Run Ledger

The **Run Ledger** is the sole owner of Run state for every provider, including
Run Inputs, pending interactions, deadlines and Run Effects. Its verbs are
admit for new user input, observe for provider events and effect outcomes,
control for user actions and interaction answers, and settle for process loss,
expired deadlines or provider-session termination; other lifecycle views derive
from its decisions.

_Avoid_: runner state or outbox status as an independent authority on a Run.

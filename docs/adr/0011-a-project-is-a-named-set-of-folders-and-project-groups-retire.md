# ADR-0011: A project is a named set of folders that owns its sessions; Project Groups retire

- Status: accepted
- Date: 2026-10-18
- Context: epic conduit-test-m379

## Context

Conduit has two overlapping groupings. A project is a slug with one or more
Project Folders, and its first folder is the main folder. A Project Group
clusters projects whose main folders share a Repository Identity, so
`conduit` and its linked-worktree copy `conduit-82tn19` show under one heading.
A multi-folder project can only be grouped by its main folder, so groups get
arbitrary as multi-folder projects become normal.

The app is also "in" a project: the URL slug is app state, and some surfaces
read the attached project. ADR-0009 already replaces the per-project feed with
one daemon-wide feed.

t3code (89ce030d) makes each folder its own project, rejects a second project
on the same folder, and groups projects for display only, with a manual
"Group into…" action. New threads default to the open thread's project, and
the project picker can add a project. Threads never move between projects;
only an unsent draft can change project. Threads with no project live in a
hidden scratch project, each in its own folder.

## Decision

**A project is a named, saved set of one or more folders, and it is the only
grouping.**

- Every session belongs to exactly one project, fixed when it is created.
- A project is created or picked in New Session as well as from the sidebar.
- Conduit is never "in" a project. `/p/<slug>/s/<id>` URLs stay, but the slug
  only names a project; it is not app state. The attached project retires
  everywhere.
- Project Groups retire: automatic clustering, `groupingMode`,
  `defaultGroupingMode`, group labels and the `/group/<key>` Scope are
  deleted. The Scope is one project or all of them. Repository Identity stays,
  because merging and the cutover use it.

**A folder can be the main folder of one project only.** Other folders, such
as a shared library, can belong to several projects. So every session's
starting folder still maps to one project, and imported provider sessions
stay unambiguous.

**Projects can be merged, and a merge is permanent.**

- Merging moves every session of the absorbed project into the target.
  Sessions keep running where they ran: each session's workspace maps the
  target's main folder to the folder or worktree the session used, as a
  `session.workspace_changed` event with origin `existing`.
- Folders the absorbed project has and the target lacks join the target, so
  no session loses a folder. The target's settings win, and the merge prompt
  lists any absorbed setting that will be dropped.
- The absorbed project leaves a **slug alias**: its slug and main folder,
  pointing at the target. Old `/p/<slug>` links redirect through it, and a
  provider session found in that folder is imported into the target.
- There is no unmerge. Sessions never move between projects; only an unsent
  draft can change project. Forking a session into another project is the
  workaround. This follows t3code.

**The cutover merges copies automatically and asks about the rest once.**

- Projects whose main folders are copies of one folder merge automatically:
  same Repository Identity, the repository root as main folder, the same other
  folders and the same settings. This loses nothing. The project on the
  repository's main checkout survives, otherwise the one added first.
- Every other group of today's grouping is offered once as a merge, showing
  what differs. That covers monorepo subfolders, whose sessions would start in
  the target's main folder, and projects whose other folders or settings
  differ. The answer is stored and never asked again.
- Old `/group/<key>` links open the merged project, or the unscoped list when
  the group was not merged.

**A new session's project defaults to the open session's project.** The order
is the draft's explicit pick, then the open session's project, then the
sidebar's project filter, then the last used project, then the first. The
project chip offers "New project…", which opens Add Project and returns with
the new project picked. This follows t3code and replaces conduit's rule,
which ignored the open session.

**Sessions with no project live in a hidden scratch project.**

- New Session offers "No project". Each scratch session gets its own folder,
  `<configDir>/scratch/<session id>/`, created with the session, so parallel
  sessions never share files.
- An unsent draft can switch between No project and a real project. A scratch
  session cannot move, like any other session.
- The scratch project is not listed as a project and cannot be renamed,
  merged or given folders.

## Consequences

- One grouping concept. The project tree view (conduit-test-m379.4) groups by
  project alone, and the feed (ADR-0009) carries projects, aliases and
  sessions.
- Reads that select sessions by project expand the project to itself plus its
  aliases' slugs, the way group scopes expand today. Events and session rows
  keep the slug they were recorded under, so Project Provenance is unchanged
  and no history is rewritten.
- A wrong merge cannot be undone. The cutover only merges copies by itself,
  and the manual merge prompt must say plainly that it is permanent.
- Fork currently stays in its source project, so it needs a target-project
  choice to be the escape hatch from a wrong project or merge.
- Deleting a scratch session must decide its folder's fate. It uses the
  keep-or-delete prompt of Conduit-created worktrees.
- New Session gains a project picker with inline create, which
  `AddProject` and the Default Session Mode resolver must serve before the
  session exists.

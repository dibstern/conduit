# ADR-0011: A project is a named set of folders that owns its sessions; Project Groups retire

- Status: accepted
- Date: 2026-10-18
- Context: epic conduit-test-m379
- Amended 2026-10-18: Project Merge, Slug Aliases and the cutover merge were
  dropped before implementation; see "Projects never merge".

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
- Conduit is never "in" a project. A session's URL is `/s/<id>`, and the
  sidebar Scope is `?p=<slug>`, which only names a project; it is not app
  state. Old `/p/<slug>/s/<id>` and `/p/<slug>` links are rewritten to those.
  The attached project retires everywhere.
- Project Groups retire: automatic clustering, `groupingMode`,
  `defaultGroupingMode`, group labels and the `/group/<key>` Scope are
  deleted. The Scope is one project or all of them, and old `/group/<key>`
  links open the unscoped list. Repository Identity stays as a folder fact;
  the project dialog shows it.

**A folder can be the main folder of one project only.** Other folders, such
as a shared library, can belong to several projects. So every session's
starting folder still maps to one project, and imported provider sessions
stay unambiguous.

**Projects never merge, and sessions never move between projects.**

- Only an unsent draft can change project. Forking a session into another
  project is the way to carry work across. This follows t3code.
- Projects that share a group today, such as a checkout and its
  linked-worktree copy, stay separate projects when groups retire. Nothing is
  merged or rewritten at upgrade.
- Rejected: Project Merge with Slug Aliases, and a cutover that merges copies.
  Every project read would have to expand a project to its aliases' slugs,
  running turns would need handing to another relay, every moved session's
  workspace would need remapping, and a wrong merge could not be undone.

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
- The scratch project is not listed as a project and cannot be renamed or
  given folders.

## Consequences

- One grouping concept. The project tree view (conduit-test-m379.4) groups by
  project alone, and the feed (ADR-0009) carries projects and sessions.
- A session read by project matches that project's slug alone. Project
  Provenance is unchanged and no history is rewritten.
- Today's grouped copies show as separate projects, so the tree has more
  rows. Removing a copy's project hides its sessions (ADR-0008); it does not
  fold them into another project.
- Fork currently stays in its source project, so it needs a target-project
  choice (conduit-test-m379.11) to be the way out of a wrong project.
- Deleting a scratch session must decide its folder's fate. It uses the
  keep-or-delete prompt of Conduit-created worktrees.
- New Session gains a project picker with inline create, which
  `AddProject` and the Default Session Mode resolver must serve before the
  session exists.

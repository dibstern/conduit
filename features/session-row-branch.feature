Feature: Session rows identify worktree branches

Scenario Outline: Worktree rows show their own branch and Local rows show only the project
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the sidebar has an existing worktree on <existing_branch>, a new worktree on <new_branch> and a Local session on <local_branch>
  Then the session list is open
  And the "Existing worktree" session row shows "myapp" and branch "<existing_branch>"
  And the "New worktree" session row shows "myapp" and branch "<new_branch>"
  And the "Local session" session row shows only "myapp" with no branch
  And the session-list region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | existing_branch    | new_branch       | local_branch | baseline                  | threshold |
  | desktop  | feature/existing   | conduit/parallel | main         | session-row-branch-desktop | 98        |
  | phone    | feature/existing   | conduit/parallel | main         | session-row-branch-phone   | 98        |

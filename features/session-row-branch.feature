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

# Failure modes: ignoring repository identity loses the repository label;
# omitting the project qualifier makes two checkouts indistinguishable;
# qualifying a lone repository adds a project name that is not needed.
Scenario Outline: Repository labels qualify projects only when the repository is shared
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the sidebar has sessions in two projects for a shared repository and one project for a lone repository
  When I select All projects in the session list
  Then the session list is open
  And the "First grouped session" session row shows only "<first_grouped_label>" with no branch
  And the "Second grouped session" session row shows only "<second_grouped_label>" with no branch
  And the "Lone repository session" session row shows only "<lone_label>" with no branch
  And the session list grouping screenshot is saved as <artifact>

Examples:
  | viewport | first_grouped_label   | second_grouped_label  | lone_label | artifact                        |
  | desktop  | Shared · Checkout one | Shared · Checkout two | Solo       | repository-session-rows-desktop |
  | phone    | Shared · Checkout one | Shared · Checkout two | Solo       | repository-session-rows-phone   |

Feature: Worktree cleanup says what a removal loses and reports what a cleanup did

Scenario Outline: The keep rule names the files a removal loses
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  When I open settings to the General section
  And I expand Worktree cleanup
  And I keep worktrees with <keepLabel>
  Then the worktree cleanup keep rule is saved as <keepWhen>
  And the worktree cleanup keep note is a <tone> reading "<note>"

Examples:
  | keepLabel                | keepWhen            | tone    | note                                                                          |
  | Any local files          | any-local-files     | note    | Includes ignored files, except node_modules.                                  |
  | Changes to tracked files | tracked-changes     | warning | Untracked and ignored files, like .env, are deleted when a worktree is removed. |

Scenario Outline: Clean up now counts each outcome and explains every worktree
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the sidebar has an OpenCode session titled "<title>"
  And cleaning up now removes that session's worktree because "<removedReason>", keeps <keptPath> because "<keptReason>" and fails <failedPath> because "<failedReason>"
  When I open settings to the General section
  And I expand Worktree cleanup
  And I run worktree cleanup now
  Then the worktree cleanup report reads "Removed 1 · Kept 1 · Failed 1"
  When I expand the worktree cleanup report
  Then the worktree cleanup report lists "<title>" as removed because "<removedReason>"
  And the worktree cleanup report lists "<keptPath>" as kept because "<keptReason>"
  And the worktree cleanup report lists "<failedPath>" as failed because "<failedReason>"
  And the settings-panel region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | title              | removedReason      | keptPath          | keptReason           | failedPath        | failedReason      | baseline                         | threshold |
  | desktop  | Fix login redirect | Session is settled | /worktrees/notes  | Has an open terminal | /worktrees/stuck  | Permission denied | worktree-cleanup-report-desktop  | 98        |
  | phone    | Fix login redirect | Session is settled | /worktrees/notes  | Has an open terminal | /worktrees/stuck  | Permission denied | worktree-cleanup-report-phone    | 98        |

Scenario: Clean up now shows progress, then a failure that can be retried
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And cleaning up now waits for the server
  When I open settings to the General section
  And I expand Worktree cleanup
  And I run worktree cleanup now
  Then the worktree cleanup button reads "Running…" and is disabled
  When the server fails the cleanup
  Then the worktree cleanup report alerts "Couldn't run cleanup. Try again."
  And the worktree cleanup button reads "Run" and is enabled

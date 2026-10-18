Feature: Worktree cleanup says what a removal loses and reports what a cleanup did

Scenario Outline: Global cleanup explains the settle-driven rules
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  When I open settings to the General section
  And I expand Worktree cleanup
  Then worktree cleanup offers only the settle-driven rows
  And the settle rule offers "Remove if nothing is missing" and "Keep"
  And the settle rule explains "Nothing is missing when every commit is already in the default branch and there are no uncommitted or untracked files. The branch is kept."
  And the settled age rule explains "Counted from when the session settled, even if its commits aren't merged. The branch is kept."
  And Settle idle sessions after appears above Worktree cleanup
  And the worktree cleanup summary reads "When nothing is missing"
  And the settled age presets are Never, Right away, 1 week, 2 weeks, 30 days, 90 days
  And the settings-panel region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                       | threshold |
  | desktop  | worktree-cleanup-rules-desktop | 98        |
  | phone    | worktree-cleanup-rules-phone   | 98        |

Scenario Outline: The settle rule saves its selected action
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  When I open settings to the General section
  And I expand Worktree cleanup
  And I set the settle rule to "<label>"
  Then the worktree cleanup settle rule is saved as <value>

Examples:
  | label                        | value           |
  | Keep                         | keep            |
  | Remove if nothing is missing | nothing-missing |

Scenario Outline: Settled age presets save the selected delay
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  When I open settings to the General section
  And I expand Worktree cleanup
  And I set the settled age rule to "<label>"
  Then the worktree cleanup settled age is saved as <days>

Examples:
  | label      | days  |
  | Never      | never |
  | Right away | 0     |
  | 1 week     | 7     |
  | 2 weeks    | 14    |
  | 30 days    | 30    |
  | 90 days    | 90    |

Scenario Outline: The summary names the enabled cleanup rules
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And worktree cleanup starts with settle <settle_rule>, settled age <days> and delete <delete_rule>
  When I open settings to the General section
  And I expand Worktree cleanup
  Then the worktree cleanup summary reads "<summary>"
  And the settled age rule is set to "<age_label>"

Examples:
  | settle_rule     | days  | delete_rule | summary                 | age_label  |
  | keep            | never | false       | Off                     | Never      |
  | nothing-missing | never | false       | When nothing is missing | Never      |
  | keep            | 0     | false       | When settled            | Right away |
  | keep            | 7     | false       | Settled 7+ days         | 1 week     |
  | keep            | 12    | false       | Settled 12+ days        | 12 days    |
  | keep            | never | true        | When deleted            | Never      |
  | nothing-missing | 30    | false       | 2 rules                 | 30 days    |
  | nothing-missing | 90    | true        | 3 rules                 | 90 days    |

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

Scenario Outline: Deleting a session asks about its worktree unless the rule removes it
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And worktree cleanup <current_rule> worktrees of deleted sessions
  When I open settings to the General section
  And I expand Worktree cleanup
  Then deleting a session is set to "<current_label>"
  When I set deleting a session to "<next_label>"
  Then the worktree cleanup delete rule is saved as <saved>

Examples:
  | current_rule | current_label | next_label | saved |
  | asks about   | Ask           | Remove     | true  |
  | removes      | Remove        | Ask        | false |

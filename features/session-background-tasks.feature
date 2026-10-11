Feature: Live background tasks show in the session header and on the composer

Scenario Outline: Tasks hang off a goal with an elbow, newest task first
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a working goal
  And the session has <count> live background tasks
  Then the background tasks row shows <chips> and <more>
  And the background tasks row hangs off the goal with an elbow
  And the composer shows <count> task dots
  And the old background work banner is gone
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | count | chips                                           | more         | baseline                        | threshold |
  | phone    | 1     | Start the Vite dev server                       | no more pill | session-background-tasks-1-phone   | 98        |
  | phone    | 4     | Review the router refactor                      | +3           | session-background-tasks-4-phone   | 98        |
  | desktop  | 4     | Review the router refactor, Explore route guard usage, Run vitest in watch mode, Start the Vite dev server | no more pill | session-background-tasks-4-desktop | 98        |

Scenario Outline: Without a goal the row sits under the title with no elbow
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 2 live background tasks
  Then the background tasks row shows <chips> and <more>
  And the background tasks row has no elbow
  And the composer shows 2 task dots
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | chips                                             | more         | baseline                               | threshold |
  | phone    | Run vitest in watch mode                          | +1           | session-background-tasks-nogoal-phone   | 98        |
  | desktop  | Run vitest in watch mode, Start the Vite dev server | no more pill | session-background-tasks-nogoal-desktop | 98        |

Scenario Outline: The pull-down lists every task with its kind, command or agent, and age
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a working goal
  And the session has 4 live background tasks
  And the background task launcher details are available
  When I click the background tasks row
  Then the background tasks pull-down lists the 4 tasks with kinds and ages
  And the background tasks pull-down shows each command or agent under its description
  And the background tasks pull-down offers a named stop control for each task
  And the layout region visually matches <baseline> at <threshold> percent
  When I press Escape in the background tasks pull-down
  Then the background tasks pull-down is closed

Examples:
  | viewport | baseline                                 | threshold |
  | phone    | session-background-tasks-pulldown-phone   | 98        |
  | desktop  | session-background-tasks-pulldown-desktop | 98        |

Scenario: Stop all requests each task and waits for the SDK without cancelling the session
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 2 live background tasks
  When I click the background tasks row
  And I press Stop all in the background tasks pull-down
  Then the background tasks pull-down asks to stop b2, b1 without cancelling the session
  And the composer shows 2 task dots
  When the session's last background task ends
  Then the background tasks pull-down is closed
  And the composer shows no task dots

Scenario: Stopping one task leaves every other task until the SDK reports the change
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 2 live background tasks
  When I click the background tasks row
  And I stop the background task Run vitest in watch mode
  Then the background tasks pull-down asks to stop b2 without cancelling the session
  And the composer shows 2 task dots
  When the SDK reports the vitest task stopped
  Then the composer shows 1 task dots
  And the background tasks row shows Start the Vite dev server and no more pill

Scenario: Stopping an agent requests its nested tasks before the agent
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session's live background tasks are an agent with 2 nested shells and a shell
  When I click the background tasks row
  And I stop the background task Fix the flaky router test
  Then the background tasks pull-down asks to stop n2, n1, a1 without cancelling the session
  And the composer shows 4 task dots

Scenario: Unsupported providers show live tasks without stop controls
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the OpenCode harness
  And the session has 2 live background tasks
  When I click the background tasks row
  Then the background tasks pull-down has no stop controls
  And the background tasks pull-down shows only kinds for unjoinable tasks

Scenario: The row and dots disappear when the last task ends
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 2 live background tasks
  When I click the background tasks row
  And the session's last background task ends
  Then the background tasks row is gone
  And the background tasks pull-down is closed
  And the composer shows no task dots

Scenario Outline: The pull-down nests an agent's tasks under it
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session's live background tasks are an agent with 2 nested shells and a shell
  Then the composer shows 4 task dots
  When I click the background tasks row
  Then the background tasks pull-down lists the agent's 2 shells indented under it
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                                | threshold |
  | phone    | session-background-tasks-nested-phone   | 98        |
  | desktop  | session-background-tasks-nested-desktop | 98        |

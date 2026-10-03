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

Scenario Outline: The pull-down lists every task with its kind and age
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a working goal
  And the session has 4 live background tasks
  When I click the background tasks row
  Then the background tasks pull-down lists the 4 tasks with kinds and ages
  And the layout region visually matches <baseline> at <threshold> percent
  When I press Escape in the background tasks pull-down
  Then the background tasks pull-down is closed

Examples:
  | viewport | baseline                                 | threshold |
  | phone    | session-background-tasks-pulldown-phone   | 98        |
  | desktop  | session-background-tasks-pulldown-desktop | 98        |

Scenario: Stop all stops the session
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 2 live background tasks
  When I click the background tasks row
  And I press Stop all in the background tasks pull-down
  Then the background tasks pull-down asks to cancel the current session

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

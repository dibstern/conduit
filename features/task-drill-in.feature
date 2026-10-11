Feature: Tapping a background task opens it, in a drawer on desktop and full screen on phones

Scenario Outline: The pull-down's agents open their tasks; its shells only read
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session's live background tasks are an agent with 2 nested shells and a shell
  When I click the background tasks row
  Then the background tasks pull-down lists the agent's 2 shells indented under it
  And the pull-down's agent rows open their tasks and its shell rows only read
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                 | threshold |
  | phone    | task-drill-in-list-phone   | 98        |
  | desktop  | task-drill-in-list-desktop | 98        |

Scenario Outline: A long task list scrolls inside the pull-down
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 10 live background tasks with long descriptions
  When I click the background tasks row
  Then the pull-down's agent rows open their tasks and its shell rows only read
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                     | threshold |
  | phone    | task-drill-in-overflow-phone   | 98        |
  | desktop  | task-drill-in-overflow-desktop | 98        |

Scenario Outline: On desktop a task opens in a drawer beside the transcript
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the launching row clock advances by 0 seconds
  And a session already exists on the Claude harness
  And the session's live background tasks are the dev server, the flaky-test agent and that agent's nested shell
  And the transcript has a turn that launched a task in every state
  And the flaky-test agent's Child Session is part way through its work
  Then the task drill-in clock matches its fixture time
  When I open the turn's steps
  And I click the background tasks row
  And I open "Fix the flaky test" from the background tasks pull-down
  Then the task drawer shows "Fix the flaky test" with its Child Session transcript
  And the layout region visually matches <baseline> at <threshold> percent
  When I press Escape in the task drawer
  Then the task drawer is closed and focus is back on the background tasks row

Examples:
  | baseline                     | threshold |
  | task-drill-in-drawer-desktop | 98        |

Scenario Outline: A launching row opens its task, which stays readable once everything finishes
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the launching row clock advances by 0 seconds
  And a session already exists on the Claude harness
  And the session's live background tasks are the dev server, the flaky-test agent and that agent's nested shell
  And the transcript has a turn that launched a task in every state
  And the flaky-test agent's Child Session is part way through its work
  Then the task drill-in clock matches its fixture time
  When I open the turn's steps
  And I open the "Fix the flaky test" launching row's task
  Then the task drawer shows "Fix the flaky test" with its Child Session transcript
  When every background task finishes
  Then the task drawer says "Fix the flaky test" ended and still shows its transcript
  And the layout region visually matches <baseline> at <threshold> percent
  When I press Escape in the task drawer
  Then the task drawer is closed and focus is back on the launching row

Examples:
  | baseline                       | threshold |
  | task-drill-in-finished-desktop | 98        |

Scenario Outline: On a phone a task opens full screen and back returns to the pull-down
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the launching row clock advances by 0 seconds
  And a session already exists on the Claude harness
  And the session's live background tasks are the dev server, the flaky-test agent and that agent's nested shell
  And the transcript has a turn that launched a task in every state
  And the flaky-test agent's Child Session is part way through its work
  Then the task drill-in clock matches its fixture time
  When I click the background tasks row
  And I open "Fix the flaky test" from the background tasks pull-down
  Then the flaky-test agent's Child Session fills the screen
  And the layout region visually matches <baseline> at <threshold> percent
  When I go back to the parent session
  Then the background tasks pull-down is open again

Examples:
  | baseline                  | threshold |
  | task-drill-in-child-phone | 98        |

Scenario Outline: On a phone back returns to the launching row, even once everything finished
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the launching row clock advances by 0 seconds
  And a session already exists on the Claude harness
  And the session's live background tasks are the dev server, the flaky-test agent and that agent's nested shell
  And the transcript has a turn that launched a task in every state
  And the flaky-test agent's Child Session is part way through its work
  Then the task drill-in clock matches its fixture time
  When I open the turn's steps
  And I open the "Fix the flaky test" launching row's task
  Then the flaky-test agent's Child Session fills the screen
  When every background task finishes
  And I go back to the parent session
  Then the "Fix the flaky test" launching row is back in view
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                     | threshold |
  | task-drill-in-finished-phone | 98        |

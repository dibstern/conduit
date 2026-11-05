Feature: Fork a session into another project

# conduit-test-m379.11. A session's commands offer Fork into, listing every
# other project. Choosing one forks there: the request names that project, and
# the fork opens attached to it. t3code has no such choice; its fork stays in
# the source project, as plain Fork still does here. With one project there is
# nothing to choose, so the commands keep plain Fork only. An OpenCode session
# offers Fork into like any other.

Scenario Outline: On a <viewport>, Fork into lists the other projects and opens the fork in the chosen one
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the sidebar has the project tree fixture
  And opening a session attaches the session's own project
  And the relay forks sessions into the chosen project
  When I open the commands for Atlas session 1 on a <viewport>
  Then Fork into offers beacon, comet and delta on a <viewport>
  When I fork into beacon on a <viewport>
  Then exactly one fork request takes Atlas session 1 into beacon
  And the fork is open, attached to the beacon project

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: On a <viewport> with one project, the commands keep plain Fork only
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Atlas session 1 is a row in the only project
  When I open the commands for Atlas session 1 on a <viewport>
  Then the commands offer Fork without Fork into

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: On a <viewport>, an OpenCode session offers Fork into too
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the sidebar has the project tree fixture
  And Atlas session 1 runs on OpenCode
  When I open the commands for Atlas session 1 on a <viewport>
  Then Fork into offers beacon, comet and delta on a <viewport>

Examples:
  | viewport |
  | desktop  |
  | phone    |

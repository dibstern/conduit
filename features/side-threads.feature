Feature: Side Threads branch a question off the session and list under the header

Scenario Outline: $btw and $side ask a Side Thread that points back to its parent
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 0 Side Threads
  And the relay answers Side Thread requests
  When I type <command> Which visual baseline is stale? into the composer
  And I send the composer message
  Then a Side Thread titled Which visual baseline is stale? is started from the session
  And the Side Thread receives the sent text Which visual baseline is stale?
  And the back bar reads Side Thread of Stabilise visual suite
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | command | baseline                       | threshold |
  | phone    | $btw    | side-threads-started-phone     | 98        |
  | desktop  | $side   | side-threads-started-desktop   | 98        |

Scenario Outline: A bare command opens the Side Threads list, newest first
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 3 Side Threads
  Then the header shows 3 Side Threads with waiting and unread markers
  When I type <command> into the composer
  And I send the composer message
  Then the Side Threads list shows Which visual baseline is stale?, Why did the Linux gate skip?, Is the island chevron still 44px?
  And the Side Threads list hangs under the header on screen
  And the composer is empty
  And no Side Thread was started
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | command | baseline                    | threshold |
  | phone    | $btw    | side-threads-list-phone     | 98        |
  | desktop  | $side   | side-threads-list-desktop   | 98        |

Scenario Outline: A bare command with no Side Threads explains how to ask one
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 0 Side Threads
  When I type $btw into the composer
  And I send the composer message
  Then the Side Threads list is empty
  And the Side Threads list hangs under the header on screen
  And no Side Thread was started
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                 | threshold |
  | side-threads-empty-phone | 98        |

Scenario: The header control opens the list and a row opens its Side Thread
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 3 Side Threads
  When I click the Side Threads control
  And I press Escape in the Side Threads list
  Then the Side Threads list is closed
  When I click the Side Threads control
  And I open the Side Thread titled Why did the Linux gate skip?
  Then the Side Threads list is closed
  And the back bar reads Side Thread of Stabilise visual suite
  And the Side Threads control is hidden

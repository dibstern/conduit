Feature: Goal details reveal check history and goal actions

Scenario Outline: The goal subtitle opens full-width details and both dismissal paths work
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a working goal
  When I click the session goal subtitle
  Then goal details are open below the full session header
  And the goal details condition reads All 38 scenarios pass
  And the goal details metadata includes 41m and 1.24M tokens
  And the goal details history shows all three checks in iteration order
  And goal details offer Pause, Edit and Clear
  And the layout region visually matches <baseline> at <threshold> percent
  When I click the goal details scrim
  Then goal details are closed
  When I click the session goal subtitle
  And I press Escape in goal details
  Then goal details are closed
  And the session goal subtitle has focus

Examples:
  | viewport | baseline                     | threshold |
  | phone    | session-goal-details-phone   | 98        |
  | desktop  | session-goal-details-desktop | 98        |

Scenario: A running goal check appends a spinner to the returned history
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a checking goal
  When I click the session goal subtitle
  Then the goal details history shows three checks followed by Checking now
  And goal details offer Pause, Edit and Clear

Scenario: Pause interrupts the current session through the stop RPC
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a working goal
  When I click the session goal subtitle
  And I press Pause in goal details
  Then the goal details action interrupts the current session

Scenario: Resume sends Continue through the composer
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a paused goal
  When I click the session goal subtitle
  Then goal details offer Resume, Edit and Clear
  When I press Resume in goal details
  Then the goal details action sends exactly Continue. for the current session

Scenario: Edit closes details and puts the existing condition in the composer
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a working goal
  When I click the session goal subtitle
  And I press Edit in goal details
  Then goal details are closed
  And the composer is ready to edit the goal with its cursor at the end

Scenario: Clear sends the goal command for the current session
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a working goal
  When I click the session goal subtitle
  And I press Clear in goal details
  Then the goal details action sends exactly /goal clear for the current session

Scenario Outline: A met goal offers a new goal and dismissal
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a met goal
  When I click the session goal subtitle
  Then goal details are open below the full session header
  And the goal details condition reads All 38 scenarios pass
  And goal details offer Set a new goal and Dismiss
  And the layout region visually matches <baseline> at <threshold> percent
  When I press Dismiss in goal details
  Then goal details are closed
  And the met goal bar and subtitle are not rendered

Examples:
  | baseline                       | threshold |
  | session-goal-details-met-phone | 98        |

Scenario: Set a new goal closes details and opens a fresh goal draft
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a met goal
  When I click the session goal subtitle
  And I press Set a new goal in goal details
  Then goal details are closed
  And the composer is ready for a new goal with its cursor at the end

Scenario: Details in the met composer bar opens the same goal panel
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a met goal
  When I click Details in the met goal bar
  Then goal details are open below the full session header
  And the goal details condition reads All 38 scenarios pass
  And goal details offer Set a new goal and Dismiss

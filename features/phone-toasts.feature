Feature: Phone toast sheets leave New session reachable

Background:
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list

Scenario Outline: An error sheet pushes New session above it
  Given the usage footer has one Claude account in the <state> state
  When I tap back to the session list
  Then the session list is open
  When pinning a phone session fails
  Then the phone error toast is visible
  And the New session button clears the toast sheet and receives taps
  And the screen region visually matches <baseline> at <threshold> percent
  When I tap New session above the toast
  Then a new session draft is open

Examples:
  | state  | baseline                 | threshold |
  | none   | phone-toast-list         | 98        |
  | normal | phone-toast-list-docked  | 98        |

Scenario: Identical errors replace the previous toast
  When I tap back to the session list
  Then the session list is open
  When pinning a phone session fails
  And pinning a phone session fails
  Then the phone error toast is visible
  And exactly one toast card is visible

Scenario: A tall usage dock and an error sheet both clear New session
  Given the usage footer has several accounts with an unknown Claude reading
  When the usage footer work five_hour reading is 86% resetting at none
  And the usage footer spare five_hour reading is 86% resetting at none
  And the usage footer chatgpt seven_day reading is 91% resetting at none
  And I tap back to the session list
  Then the phone usage rows are claude, work, spare, chatgpt in that order
  When pinning a phone session fails
  Then the phone error toast is visible
  And the New session button clears the toast sheet and receives taps
  When I tap New session above the toast
  Then a new session draft is open

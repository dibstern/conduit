Feature: Phone toasts float at the top, clear of New session and the composer

Background:
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list

Scenario Outline: An error toast floats at the top of the session list
  Given the usage footer has one Claude account in the <state> state
  When I tap back to the session list
  Then the session list is open
  When pinning a phone session fails
  Then the phone error toast is visible
  And the toast floats at the top, clear of New session, which receives taps
  And the screen region visually matches <baseline> at <threshold> percent
  When I tap New session beside the toast
  Then a new session draft is open

Examples:
  | state  | baseline                 | threshold |
  | none   | phone-toast-list         | 98        |
  | normal | phone-toast-list-docked  | 98        |

Scenario Outline: Another session asking for approval toasts once, with Open
  When the open session starts asking for approval
  And Usage footer session 2 starts asking for approval
  Then an arrival toast says Usage footer session 2 needs approval
  And the toast floats between the session bar and the composer
  And the screen region visually matches <baseline> at <threshold> percent
  When I tap Open on the arrival toast
  Then the chat for sess-usage-footer-2 is open

Examples:
  | baseline         | threshold |
  | phone-toast-chat | 98        |

Scenario Outline: With the session sheet open the toast floats above it
  When I open the overflow session sheet
  And Usage footer session 2 starts asking for approval
  Then an arrival toast says Usage footer session 2 needs approval
  And the toast floats above the open session sheet
  And the screen region visually matches <baseline> at <threshold> percent
  When I dismiss the toast
  Then the session sheet is still open

Examples:
  | baseline          | threshold |
  | phone-toast-sheet | 98        |

Scenario: Identical errors replace the previous toast
  When I tap back to the session list
  Then the session list is open
  When pinning a phone session fails
  And pinning a phone session fails
  Then the phone error toast is visible
  And exactly one toast card is visible

Feature: The folded iPhone Duo keeps its controls out from under the status column

# Folded portrait (conduit-test-tw49i.4). The right 84pt strip holds the camera,
# Dynamic Island and status glyphs down to about y253, so nothing tappable may
# sit at x394 or beyond above that line. The session's controls move into a rail
# in that strip instead: Settle and More below the status column, the composer's
# own controls bottom-up from the composer. The top ~30pt never produce a click,
# so header targets sit low with room below them.
#
# Coordinates are CSS px in the installed app's measured 466x657 layout
# viewport. The mockup draws the 678pt screen with the same y origin, so the
# viewport ends at y657 and the home bar (y665 on the screen) sits 8pt below it.
#
# The pose comes after the app loads: the emulated insets do not survive a
# navigation.

Background:
  Given the session loaded the skills "release-notes by you in turn 1; changelog-style by agent in turn 1"
  And the conduit app is served with the long-transcript mockup
  And the viewport is a duo folded portrait

Scenario: Nothing tappable sits under the status column
  Then no control reaches into the status column
  And the session header controls are centred at y 32 or lower with 22 pixels below

Scenario: The header goes back to the session list on lift
  Given I count clicks on the session back button
  When I lift a touch on the session back button that never becomes a click
  Then the session list is open
  And the session back button received 1 click

Scenario: The header stays put where a phone's would collapse to the island
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  When I scroll the transcript back to the bottom
  Then the jump-to-latest control is not visible
  And the session bar is expanded
  And no control reaches into the status column

Scenario Outline: The rail holds the session's controls, and Send moves up for Stop
  Then the rail reads Settle at 260, More at 308, Send at 447, Permissions at 495, Model at 543, Attach at 591
  And the message field spans x 12 to 374 and y 587 to 639
  And the session-bar region visually matches <header> at <threshold> percent
  And the duo-rail region visually matches <rail> at <threshold> percent
  And the composer region visually matches <composer> at <threshold> percent
  When the open session starts working
  Then the rail reads Settle at 260, More at 308, Stop at 447, Permissions at 495, Model at 543, Attach at 591
  When I type keep going into the composer
  And I close the keyboard
  And the handoff settles
  Then the rail reads Settle at 260, More at 308, Send at 399, Stop at 447, Permissions at 495, Model at 543, Attach at 591
  And no control reaches into the status column
  And the duo-rail region visually matches <rail_working> at <threshold> percent

Examples:
  | header        | rail        | composer        | rail_working        | threshold |
  | duo-fp-header | duo-fp-rail | duo-fp-composer | duo-fp-rail-working | 98        |

Scenario Outline: The context hairline turns amber at 80 percent
  When the mock relay reports context <percent> percent
  Then the context hairline reads <percent>% context in <colour>
  And the context hairline ends 8 pixels above the home indicator
  And the composer region visually matches <composer> at <threshold> percent

Examples:
  | percent | colour | composer                  | threshold |
  | 79      | grey   | duo-fp-composer-context   | 98        |
  | 80      | amber  | duo-fp-composer-warning   | 98        |

Scenario Outline: The hairline turns amber at 80 percent whatever the warning setting
  When I open settings to the General section
  And I choose <threshold> for composer context warnings
  And the mock relay reports context <percent> percent
  Then the context hairline reads <percent>% context in <colour>

Examples:
  | threshold | percent | colour |
  | 90        | 80      | amber  |
  | Never     | 85      | amber  |
  | 60        | 79      | grey   |

Scenario: Words controls still put the composer's controls in the rail
  When I open settings to the General section
  And I choose Words for composer controls
  Then the rail reads Send at 447, Permissions at 495, Model at 543, Attach at 591
  And the message field spans x 12 to 374 and y 587 to 639
  And no control reaches into the status column

Scenario Outline: The session list follows the same header and rail rules
  When I tap back to the session list
  Then no control reaches into the status column
  And the list header controls are centred at y 32 or lower with 22 pixels below
  And the rail reads New at 447, Select at 495, Theme at 543, Settings at 591
  And the duo-rail region visually matches <rail> at <threshold> percent
  And the sidebar-header region visually matches <header> at <threshold> percent

Examples:
  | header             | rail             | threshold |
  | duo-fp-list-header | duo-fp-list-rail | 98        |

Feature: The Duo's unfolded portrait header sits left of the status row

# Unfolded portrait reports a 61px top inset, but iOS's status row only fills
# the top right: keep clear of x 465 and up, y 79 and down. The header row moves
# up beside it instead of dropping by the inset: 44px targets at y 10-54,
# centred on y 32, packed to end at x 457. The title follows on its own line at
# y 56, the divider at y 89. The session list's header shares the row.
#
# The pose comes after the app loads: the emulated insets do not survive a
# navigation.

Scenario Outline: The session header row moves up beside the status row
  Given the conduit app is served with the long-transcript mockup
  And the viewport is a duo unfolded portrait
  Then the session header row is centred on y <centre> and ends at x <end>
  And the session title starts at y <title> and the divider sits at y <divider>
  And every session header control is centred at y 32 or lower with at least 22 pixels of hit area below it
  And no control reaches into the keep-clear zone from x 465 rightwards and y 79 upwards
  And the session-bar region visually matches duo-up-session-bar at <threshold> percent

Examples:
  | centre | end | title | divider | threshold |
  | 32     | 457 | 56    | 89      | 98        |

Scenario Outline: The session list header shares the row
  Given the conduit app is served with the long-transcript mockup
  And the viewport is a duo unfolded portrait
  When I tap back to the session list
  Then the list header row is centred on y <centre> and ends at x <end>
  And every list header control is centred at y 32 or lower with at least 22 pixels of hit area below it
  And no control reaches into the keep-clear zone from x 465 rightwards and y 79 upwards
  And the sidebar-header region visually matches duo-up-list-header at <threshold> percent

Examples:
  | centre | end | threshold |
  | 32     | 457 | 98        |

Scenario: The collapsed island also sits beside the status row
  Given the conduit app is served with the long-transcript mockup
  And the viewport is a duo unfolded portrait
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  When I scroll the transcript back to the bottom
  Then the session bar is collapsed
  And the session header row is centred on y 32 and ends at x 455
  And every session header control is centred at y 32 or lower with at least 22 pixels of hit area below it
  And no control reaches into the keep-clear zone from x 465 rightwards and y 79 upwards

Scenario: Header controls beside the status row fire on lift
  Given the conduit app is served with the long-transcript mockup
  And the viewport is a duo unfolded portrait
  When I lift a touch on the session back button that never becomes a click
  Then the session list is open
  When I lift a touch on the list Settings cog that never becomes a click
  Then settings opens at the section list

Scenario Outline: Other devices keep dropping by their top inset
  Given the conduit app is served with the long-transcript mockup
  And the viewport is <viewport>
  Then the session header row is centred on y <session> and ends at x <session_end>
  When I tap back to the session list
  Then the list header row is centred on y <list> and ends at x <list_end>

Examples:
  | viewport                                   | session | session_end | list | list_end |
  | a duo unfolded portrait in a Safari tab    | 83      | 659         | 84   | 661      |
  | an installed iPhone with a 59pt top inset  | 81      | 383         | 82   | 385      |

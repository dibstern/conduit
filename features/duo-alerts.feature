Feature: The iPhone Duo's toasts and header drop-downs start below the header, clear of the status glyphs

# conduit-test-tw49i.8. Toasts float in one layer 8px under the header,
# centred in the content column, at most 400px wide, newest on top, two at
# most. Header drop-downs (tasks, goal, Side Threads, sessions, skills) drop
# from under the header as top sheets across the content column in every pose
# but unfolded landscape, the Duo's desktop, where they stay anchored popovers.
#
# Nothing of ours may cover where iOS draws the camera and status glyphs
# (CSS px in each pose's layout viewport): folded portrait x394+ down to y253,
# unfolded portrait x465+ down to y79, unfolded landscape x873+ down to y191,
# and folded landscape with its inset on the right x604+ from y328 down.
#
# In unfolded portrait the header's content ends at x457 to leave the status
# row clear, and toasts end there with it.
#
# The pose comes after the app loads: the emulated insets do not survive a
# navigation.

Background:
  Given the session loaded the skills "release-notes by you in turn 1"
  And the conduit app is served with the long-transcript mockup
  And the composer status clock is frozen
  And goal details are available for a working goal
  And the session has 4 live background tasks
  And the session has 3 Side Threads

Scenario Outline: Two arrivals stack under the session header in <pose>
  Given the viewport is a duo <pose>
  When Usage footer session 2 starts asking for approval
  And Usage footer session 3 starts asking for approval
  Then 2 toasts stack 8 pixels under the header, newest on top, at most 400 pixels wide and centred between x <left> and x <right>
  And the top toast says Usage footer session 3 needs approval
  And no toast, sheet or scrim covers the status glyphs
  And the toasts region visually matches <baseline> at <threshold> percent

Examples:
  | pose               | left | right | baseline                   | threshold |
  | folded portrait    | 0    | 382   | duo-alerts-toasts-fp       | 98        |
  | folded landscape   | 0    | 594   | duo-alerts-toasts-fl       | 98        |
  | unfolded landscape | 303  | 867   | duo-alerts-toasts-ul       | 98        |
  | unfolded portrait  | 0    | 457   | duo-alerts-toasts-up       | 98        |

Scenario Outline: Arrivals on the session list stack under the list header in <pose>
  Given the viewport is a duo <pose>
  When I tap back to the session list
  Then the session list is open
  When Usage footer session 2 starts asking for approval
  Then 1 toasts stack 8 pixels under the header, newest on top, at most 400 pixels wide and centred between x <left> and x <right>
  And no toast, sheet or scrim covers the status glyphs

Examples:
  | pose              | left | right |
  | folded portrait   | 0    | 382   |
  | unfolded portrait | 0    | 457   |

Scenario Outline: The <surface> drop-down hangs from the header in <pose>
  Given the viewport is a duo <pose>
  When I open the <surface> drop-down
  Then the drop-down hangs from the header's bottom edge across x <left> to <right>
  And no toast, sheet or scrim covers the status glyphs

Examples:
  | pose              | surface      | left | right |
  | folded portrait   | tasks        | 0    | 382   |
  | folded portrait   | goal         | 0    | 382   |
  | folded portrait   | Side Threads | 0    | 382   |
  | folded portrait   | sessions     | 0    | 382   |
  | folded portrait   | skills       | 0    | 382   |
  | folded landscape  | tasks        | 0    | 594   |
  | folded landscape  | goal         | 0    | 594   |
  | folded landscape  | Side Threads | 0    | 594   |
  | folded landscape  | sessions     | 0    | 594   |
  | folded landscape  | skills       | 0    | 594   |
  | unfolded portrait | tasks        | 0    | 669   |
  | unfolded portrait | goal         | 0    | 669   |
  | unfolded portrait | Side Threads | 0    | 669   |
  | unfolded portrait | sessions     | 0    | 669   |
  | unfolded portrait | skills       | 0    | 669   |

Scenario Outline: The tasks sheet and its scrim leave the status glyphs uncovered in <pose>
  Given the viewport is a duo <pose>
  When I open the tasks drop-down
  Then no toast, sheet or scrim covers the status glyphs
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | pose              | baseline                 | threshold |
  | folded portrait   | duo-alerts-sheet-fp      | 98        |
  | folded landscape  | duo-alerts-sheet-fl      | 98        |
  | unfolded portrait | duo-alerts-sheet-up      | 98        |

Scenario Outline: Unfolded landscape keeps the <surface> drop-down anchored to its control
  Given the viewport is a duo unfolded landscape
  When I open the <surface> drop-down
  Then the drop-down is anchored to its control, not a sheet

Examples:
  | surface      |
  | tasks        |
  | goal         |
  | Side Threads |
  | sessions     |
  | skills       |

Scenario: From the collapsed island the sessions sheet stays clear of the status row
  Given the viewport is a duo unfolded portrait
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  When I scroll the transcript back to the bottom
  Then the session bar is collapsed
  When I open the sessions drop-down
  Then no toast, sheet or scrim covers the status glyphs
  When Usage footer session 2 starts asking for approval
  Then the toast floats above the open session sheet
  And no toast, sheet or scrim covers the status glyphs

Scenario: A toast floats above an open header sheet
  Given the viewport is a duo folded portrait
  When I open the sessions drop-down
  And Usage footer session 2 starts asking for approval
  Then an arrival toast says Usage footer session 2 needs approval
  And the toast floats above the open session sheet
  And no toast, sheet or scrim covers the status glyphs

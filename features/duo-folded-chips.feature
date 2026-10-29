Feature: The folded iPhone Duo shows the goal and background tasks as chips under the header

# Folded portrait (conduit-test-tw49i.6, mockup cards 15 and 16). An active goal
# and running background tasks sit in one 44px row of chips under the header,
# at y58-102, clear of the status column (x394 and right, down to y253). Each
# chip opens the sheet its phone row opens. Reading down the transcript, or
# typing, folds the row into two small marks in the header's project line, and
# the transcript takes the row's 48px back; reading back up, or closing the
# keyboard, brings it back. The fold follows the same reading direction as the
# phone's collapsing session bar.
#
# Coordinates are CSS px in the installed app's measured 466x657 layout
# viewport.

Background:
  Given the conduit app is served with the long-transcript mockup
  And the viewport is a duo folded portrait

Scenario: Without a goal or background tasks there is no chip row
  Then the chip row is absent
  And the transcript clears the header at y 55

Scenario Outline: A <goal> goal and background tasks sit as chips under the header
  Given goal details are available for a <goal> goal
  And the session has 4 live background tasks
  Then the chip row reads <chips> across y 58 to 102
  And no control reaches into the status column
  And the transcript clears the header at y 103
  And the session-bar region visually matches <header> at <threshold> percent

  Examples:
  | goal    | chips                      | header                      | threshold |
  | working | Pursuing 3 checks, 4 tasks | duo-fp-chips-expanded       | 98        |
  | stuck   | Stuck 196 checks, 4 tasks  | duo-fp-chips-expanded-stuck | 98        |

Scenario Outline: Background tasks alone show the strip with Stop all
  Given the session has <count> live background tasks
  Then the chip row reads <chips> across y 58 to 102
  And no control reaches into the status column
  And the session-bar region visually matches <header> at <threshold> percent

  Examples:
  | count | chips                        | header                  | threshold |
  | 4     | 4 background tasks, Stop all | duo-fp-chips-tasks-only | 98        |

Scenario: A goal alone shows one chip
  Given goal details are available for a working goal
  Then the chip row reads Pursuing 3 checks across y 58 to 102

Scenario: The goal chip opens goal details
  Given goal details are available for a working goal
  And the session has 4 live background tasks
  When I click the session goal subtitle
  Then goal details open in the session header popover or phone sheet

Scenario: The tasks chip opens the background tasks pull-down
  Given goal details are available for a working goal
  And the session has 4 live background tasks
  When I click the background tasks row
  Then the background tasks pull-down lists the 4 tasks with kinds and ages

Scenario Outline: Reading down folds the chips into the header, reading back up restores them
  Given goal details are available for a working goal
  And the session has 4 live background tasks
  When I scroll the transcript up by 100000 pixels
  Then the chip row reads Pursuing 3 checks, 4 tasks across y 58 to 102
  When I scroll the transcript down by 300 pixels
  Then the chip row folds into the header's goal and tasks marks
  And the transcript clears the header at y 55
  And the session-bar region visually matches <header> at <threshold> percent
  When I scroll the transcript up by 100000 pixels
  Then the chip row reads Pursuing 3 checks, 4 tasks across y 58 to 102
  And the transcript clears the header at y 103

  Examples:
  | header              | threshold |
  | duo-fp-chips-folded | 98        |

Scenario: Typing folds the chips, closing the keyboard restores them
  Given goal details are available for a working goal
  And the session has 4 live background tasks
  When I focus the composer
  Then the keyboard is open
  And the chip row folds into the header's goal and tasks marks
  When I close the keyboard
  Then the keyboard is closed
  And the chip row reads Pursuing 3 checks, 4 tasks across y 58 to 102

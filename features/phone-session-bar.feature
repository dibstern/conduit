Feature: Phone session bar

Scenario: The session owns the top bar on a phone
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  Then the session bar title is above the transcript
  And only the session bar is rendered above the transcript

Scenario Outline: The island floats at the bottom of the transcript
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  When I scroll the transcript back to the bottom
  Then the session bar is collapsed
  And the session-bar region visually matches <baseline> at <threshold> percent
  And the session header has no checkout
  And the session header has no account or instance control

Examples:
  | baseline              | threshold |
  | session-bar-collapsed | 98        |

Scenario Outline: The full bar returns when the transcript is scrolled up
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  And the session bar is expanded
  And the session bar's first row reads back, session controls and the overflow menu from left to right
  And the session header has no checkout
  And the session header has no account or instance control
  And the session-bar region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                | threshold |
  | session-bar-scrolled-up | 98        |

Scenario: Back returns to the session list
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I tap back to the session list
  Then the session list is open

Scenario: Switching to terminal from the session bar shows the terminal
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I choose the Terminal session view
  Then the terminal panel is visible
  And the Terminal session view is selected

Scenario: Switching back to chat keeps the transcript scroll position
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  And I remember the transcript scroll position
  And I choose the Terminal session view
  And I choose the Chat session view
  Then the transcript is visible at the remembered scroll position

Scenario: The collapsed bar overflow lists the same views as the expanded bar overflow
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I remember the session views from the expanded bar overflow
  And I scroll the transcript back to the bottom
  And I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  When I scroll the transcript back to the bottom
  Then the session bar is collapsed
  When I open the session overflow menu
  Then the menu lists the same session views as the expanded bar overflow

Scenario: Activating a view from the menu switches the view
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  When I scroll the transcript back to the bottom
  Then the session bar is collapsed
  When I open the session overflow menu
  And I choose the Terminal view from the menu
  Then the terminal panel is visible
  And the Terminal session view is selected
  And the session overflow menu is closed

Scenario: Closing the session sheet returns focus to the overflow trigger
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I open the overflow session sheet
  Then the session sheet shows four view cards
  When I close the session sheet with its close button
  Then the session overflow menu is closed
  And the session overflow trigger has focus

Scenario Outline: Every phone session sheet omits an unknown branch
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  And the session sheet branch is unknown
  When I open the <entry> session sheet
  Then the session sheet header identifies the session without a branch
  When I close the session sheet with its close button
  Then no session sheet is open

Examples:
  | entry    |
  | overflow |
  | chevron  |
  | list     |

# The collapse is a walk through the state machine rather than four separate
# scenarios: the interesting claims are all about transitions, and a transition
# needs the step before it to have actually happened.
#
# The bar is asserted expanded at the bottom before any scrolling, which is the
# arrival rule: the controls are visible at least once, until a downward scroll
# or a return to the bottom hands over to the collapse rule. The jump-to-latest assertions are here
# to prove the scroll steps actually moved the transcript -- without them, a
# scroll that silently did nothing also leaves the bar expanded, and the
# scenario would pass for the wrong reason.
Scenario Outline: The bar collapses at the bottom and the chevron brings it back
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  Then the session bar is expanded
  When I scroll the transcript back to the bottom
  Then the session bar is expanded
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  And the session bar is expanded
  When I scroll the transcript back to the bottom
  Then the jump-to-latest control is not visible
  And the session bar is collapsed
  And the session-bar region visually matches <baseline> at <threshold> percent
  When I tap the chevron to show the bar
  Then the session bar is expanded
  And the transcript is pinned to the bottom
  And the session header has no checkout
  And the session header has no account or instance control

Examples:
  | baseline                | threshold |
  | session-bar-collapsed   | 98        |

# The bar follows the reading direction anywhere in the transcript, not only at
# the bottom. The jump-to-latest control stays visible throughout to prove the
# downward scroll stopped short of the bottom, where reaching it would collapse
# the bar on its own.
Scenario: Scrolling down collapses the bar mid-transcript and scrolling up restores it
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I scroll the transcript up by 800 pixels
  Then the jump-to-latest control is visible
  And the session bar is expanded
  When I scroll the transcript down by 200 pixels
  Then the session bar is collapsed
  And the jump-to-latest control is visible
  When I scroll the transcript up by 200 pixels
  Then the session bar is expanded

# Just above the bottom the reader still follows new output, but the bar
# changing size is not new output and must not snap them down to it.
Scenario: Showing the bar just above the bottom keeps the reading position
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  When I scroll the transcript back to the bottom
  Then the session bar is collapsed
  When the transcript is parked 30 pixels above the bottom
  And I remember the transcript scroll position
  And I tap the chevron to show the bar
  Then the session bar is expanded
  And the transcript is visible at the remembered scroll position

Scenario: Swiping down from the top of the transcript moves it only with the finger
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I scroll the transcript up by 1500 pixels
  Then the session bar is expanded
  When I remember where the transcript content sits
  And I swipe the transcript towards newer by 200 pixels
  Then the session bar is collapsed
  And the transcript content moved 200 pixels towards newer
  When I remember where the transcript content sits
  And I swipe the transcript towards older by 200 pixels
  Then the session bar is expanded
  And the transcript content moved 200 pixels towards older

Scenario: Arriving at the bottom does not bounce the transcript
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  When I remember where the transcript content sits
  And I swipe the transcript towards newer by 1000 pixels
  Then the jump-to-latest control is not visible
  And the transcript content moved its remembered distance from the bottom towards newer

Scenario Outline: header has no checkout
  Given the session loaded the skills "release-notes by you in turn 1; changelog-style by agent in turn 1; verify by agent in turn 2"
  And the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the <harness> harness
  And the Claude accounts are claude as personal, self as work
  And a named OpenCode instance Bedrock is already configured
  And the composer uses words controls
  And the composer checkout is conduit / account-chip as worktree
  When I open the phone composer sheet
  Then the composer checkout shows conduit / account-chip with a worktree icon
  When I close the phone composer sheet
  Then the skills chip reads 3 skills used
  And the session header has no checkout
  And the session header has no account or instance control
  And the session bar is expanded
  And the session bar's first row reads back, session controls and the overflow menu from left to right
  And the session-bar region visually matches <baseline> at <threshold> percent
  When I choose the Terminal session view
  Then the session header has no checkout
  And the session header has no account or instance control

Examples:
  | harness  | baseline                      | threshold |
  | Claude   | phone-session-bar-a1-claude   | 98        |
  | OpenCode | phone-session-bar-a1-opencode | 98        |

Scenario Outline: Phone session sheets show the shared body for every session state
  Given the viewport is a phone
  And the session sheet theme is <theme>
  And the conduit app is served with the long-transcript mockup
  And the phone session sheet state is <state>
  When I open the overflow session sheet
  Then the session sheet has the shared grids and 4 Session tiles
  And the session sheet displays the <state> commands
  And the session sheet footer is overflow with Debug off
  And the auto-settle status line is <line>
  And the session-sheet region visually matches <baseline> at <threshold> percent

Examples:
  | state    | theme | line                               | baseline                            | threshold |
  | idle     | dark  | On · settles Sat 9:41 if left idle | session-sheet-idle-dark             | 98        |
  | idle     | light | On · settles Sat 9:41 if left idle | session-sheet-idle-light            | 98        |
  | unread   | dark  | On · paused while unread           | session-sheet-unread-dark           | 98        |
  | unread   | light | On · paused while unread           | session-sheet-unread-light          | 98        |
  | snoozed  | dark  | On · paused while snoozed          | session-sheet-snoozed-dark          | 98        |
  | snoozed  | light | On · paused while snoozed          | session-sheet-snoozed-light         | 98        |
  | forever  | dark  | On · paused while snoozed          | session-sheet-forever-dark          | 98        |
  | forever  | light | On · paused while snoozed          | session-sheet-forever-light         | 98        |
  | pinned   | dark  | On · paused while pinned           | session-sheet-pinned-dark           | 98        |
  | pinned   | light | On · paused while pinned           | session-sheet-pinned-light          | 98        |
  | settled  | dark  | On · session is settled            | session-sheet-settled-dark          | 98        |
  | settled  | light | On · session is settled            | session-sheet-settled-light         | 98        |
  | auto_off | dark  | Off · stays until you settle it    | session-sheet-auto-settle-off-dark  | 98        |
  | auto_off | light | Off · stays until you settle it    | session-sheet-auto-settle-off-light | 98        |

Scenario Outline: Disabled session tiles explain why and keep the sheet open
  Given the viewport is a phone
  And the session sheet theme is <theme>
  And the conduit app is served with the long-transcript mockup
  And the phone session sheet state is pinned
  When I open the overflow session sheet
  And I tap the unavailable Snooze tile
  Then the session sheet stays open with the reason pill Unpin to snooze
  And the auto-settle status line is On · paused while pinned
  And the session-sheet region visually matches <baseline> at <threshold> percent

Examples:
  | theme | baseline                            | threshold |
  | dark  | session-sheet-disabled-reason-dark  | 98        |
  | light | session-sheet-disabled-reason-light | 98        |

Scenario Outline: The title chevron sheet shares the body and Debug footer
  Given the viewport is a phone
  And the session sheet theme is <theme>
  And the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  And I enable the desktop Debug action
  When I open the chevron session sheet
  Then the session sheet has the shared grids and 4 Session tiles
  And the session sheet footer is chevron with Debug on
  And the auto-settle status line is On · settles Sat 9:41 if left idle
  And the session-sheet region visually matches <baseline> at <threshold> percent

Examples:
  | theme | baseline                          | threshold |
  | dark  | session-sheet-chevron-debug-dark  | 98        |
  | light | session-sheet-chevron-debug-light | 98        |

Scenario Outline: The session list long-press sheet has five Session tiles and no footer
  Given the viewport is a phone
  And the session sheet theme is <theme>
  And the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  When I open the list session sheet
  Then the session sheet has the shared grids and 5 Session tiles
  And the session sheet footer is absent with Debug off
  And the auto-settle status line is On · settles Sat 9:41 if left idle
  And the session-sheet region visually matches <baseline> at <threshold> percent

Examples:
  | theme | baseline                 | threshold |
  | dark  | session-sheet-list-dark  | 98        |
  | light | session-sheet-list-light | 98        |

Scenario: Auto-settle changes the stored flag and keeps the sheet open
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  When I open the overflow session sheet
  And I toggle Auto-settle in the session sheet
  Then the session sheet stays open with Auto-settle off
  When I toggle Auto-settle in the session sheet
  Then the session sheet stays open with Auto-settle on

Scenario: A failed Auto-settle change keeps the stored flag and shows a sheet pill
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  And the relay refuses the auto-settle change
  When I open the overflow session sheet
  And I toggle Auto-settle in the session sheet
  Then the session sheet stays open with Auto-settle on
  And the session sheet stays open with the reason pill Couldn't change auto-settle

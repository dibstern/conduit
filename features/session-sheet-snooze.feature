Feature: Snooze from every phone session sheet by tap or hold

Background:
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  And the snooze relay accepts changes

Scenario Outline: Tap opens a sticky list in every phone sheet
  When I open the <entry> session sheet
  And I tap the Snooze hold tile
  Then the snooze times stay open
  And the snooze choices keep their preset order and resolved times
  When I choose snooze option 1h
  Then exactly one snooze request sets 1h and closes the session sheet
  And the snooze success toast offers Undo
  When I undo the sheet snooze
  Then the snooze undo restores idle

Examples:
  | entry    |
  | overflow |
  | chevron  |
  | list     |

Scenario: The submenu-open key focuses the first time
  When I open the overflow session sheet
  And I open the Snooze hold tile with ArrowRight
  Then the first snooze time has focus

Scenario Outline: Change snooze preserves the current time for Undo
  Given the phone session sheet state is <state>
  When I open the overflow session sheet
  Then the session sheet displays the <state> commands
  When I tap the Snooze hold tile
  And I choose snooze option 3h
  Then exactly one snooze request sets 3h and closes the session sheet
  And the snooze success toast offers Undo
  When I undo the sheet snooze
  Then the snooze undo restores <state>

Examples:
  | state   |
  | snoozed |
  | forever |

Scenario: Pinned explains why Snooze is unavailable without a hold menu
  Given the phone session sheet state is pinned
  When I open the overflow session sheet
  And I tap the unavailable Snooze tile
  Then the session sheet stays open with the reason pill Unpin to snooze
  And the Snooze tile has no hold menu or hint

Scenario: Pick a date and time opens the existing picker with its field expanded
  When I open the overflow session sheet
  And I tap the Snooze hold tile
  And I choose snooze option pick
  Then no session sheet is open
  And the snooze date and time field is open
  When I enter a future snooze date and time
  Then exactly one snooze request sets custom and closes the session sheet
  And the snooze success toast offers Undo

Scenario: Until something happens sends a null timer
  When I open the overflow session sheet
  And I tap the Snooze hold tile
  And I choose snooze option indefinite
  Then exactly one snooze request sets indefinite and closes the session sheet
  And the snooze success toast offers Undo

Scenario: The command reports a rejected snooze
  Given the snooze relay refuses changes
  When I open the overflow session sheet
  And I tap the Snooze hold tile
  And I choose snooze option 1h
  Then no session sheet is open
  And the snooze error toast is visible

Scenario: Hold slide and release selects once without scrolling or dragging the sheet
  When I open the overflow session sheet
  And I hold the Snooze tile with a native touch
  And I slide the held touch to snooze option evening
  Then the held snooze gesture has not scrolled or dragged the sheet
  When I release the held snooze touch
  Then exactly one snooze request sets evening and closes the session sheet
  And the snooze success toast offers Undo

Scenario: Releasing away from a time keeps the list open
  When I open the overflow session sheet
  And I hold the Snooze tile with a native touch
  And I slide the held touch to snooze option evening
  And I slide the held touch off the snooze list
  And I release the held snooze touch
  Then the snooze times stay open
  And no snooze request has been sent
  When I tap outside the snooze list
  Then only the snooze list closes

Scenario: A swipe starting on Snooze scrolls without opening times
  Given the session sheet viewport is short
  When I open the overflow session sheet
  And I swipe up from the Snooze tile before the hold threshold
  Then the sheet scrolls without opening snooze times

Scenario Outline: Open times keep the header clear and dim the footer
  Given the session sheet theme is <theme>
  And the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  When I open the overflow session sheet
  And I tap the Snooze hold tile
  Then the snooze times stay open
  And the snooze list leaves the header clear and footer dimmed
  And the screen region visually matches <baseline> at <threshold> percent
  When I tap outside the snooze list
  Then only the snooze list closes

Examples:
  | theme | baseline                        | threshold |
  | dark  | session-sheet-snooze-open-dark   | 98        |
  | light | session-sheet-snooze-open-light  | 98        |

Scenario Outline: A held time highlights under the finger
  Given the session sheet theme is <theme>
  And the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  And the snooze relay accepts changes
  When I open the overflow session sheet
  And I hold the Snooze tile with a native touch
  And I slide the held touch to snooze option evening
  Then the held snooze gesture has not scrolled or dragged the sheet
  And the snooze list leaves the header clear and footer dimmed
  And the screen region visually matches <baseline> at <threshold> percent
  When I release the held snooze touch
  Then exactly one snooze request sets evening and closes the session sheet

Examples:
  | theme | baseline                        | threshold |
  | dark  | session-sheet-snooze-held-dark   | 98        |
  | light | session-sheet-snooze-held-light  | 98        |

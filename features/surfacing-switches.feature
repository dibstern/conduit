Feature: Turn summaries work independently of Jev

Scenario Outline: Jev off keeps messages in the log and summaries cite numbered lines
  Given Jev is off with summaries on and a valid key in the <theme> theme
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with no summaries
  Then the turn has no Jev controls
  When I request the turn summary
  Then recap version 1 of 1 says The routing review is complete.
  And recap generation scopes are whole
  And recap citation #3 is a plain chip
  When I follow recap citation #3
  Then the numbered log is focused at message #3
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | theme | baseline                                | threshold |
  | desktop  | dark  | surfacing-split-summary-desktop-dark     | 98        |
  | desktop  | light | surfacing-split-summary-desktop-light    | 98        |
  | phone    | dark  | surfacing-split-summary-phone-dark       | 98        |
  | phone    | light | surfacing-split-summary-phone-light      | 98        |

Scenario Outline: Both switches off preserves the unnumbered turn
  Given Jev is off with summaries off and a valid key in the <theme> theme
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with disabled summaries
  Then the turn has no Jev controls
  And the turn has no summary controls
  When I open the plain turn log
  Then the plain log keeps its messages without numbers
  And no recap generation was requested
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | theme | baseline                                | threshold |
  | desktop  | dark  | surfacing-split-off-desktop-dark         | 98        |
  | desktop  | light | surfacing-split-off-desktop-light        | 98        |
  | phone    | dark  | surfacing-split-off-phone-dark           | 98        |
  | phone    | light | surfacing-split-off-phone-light          | 98        |

Scenario Outline: No TypeSafe key disables Jev while summaries still generate
  Given Jev is off with summaries on and a missing key in the <theme> theme
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with no summaries
  When I request the turn summary
  Then recap version 1 of 1 says The routing review is complete.
  And recap generation scopes are whole
  When I dismiss the summary with Escape
  And I open settings to Surfacing
  Then Jev needs Add key and Turn summaries stays enabled
  And the screen region visually matches <baseline> at <threshold> percent
  When I toggle Turn summaries off and on
  Then the split flags survive reloading settings

Examples:
  | viewport | theme | baseline                                | threshold |
  | desktop  | dark  | surfacing-split-no-key-desktop-dark      | 98        |
  | desktop  | light | surfacing-split-no-key-desktop-light     | 98        |
  | phone    | dark  | surfacing-split-no-key-phone-dark        | 98        |
  | phone    | light | surfacing-split-no-key-phone-light       | 98        |

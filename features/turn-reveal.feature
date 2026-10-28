Feature: Reveal opens a Turn on its target without changing the saved stop

Scenario Outline: A hidden message opens directly at the saved stop
  Given message surfacing is active at Answer
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I open turn message #3 with digits and Enter
  Then the surfaced card shows #3 and announces its category and position
  And the turn card note says At All messages, below Answer · opened directly
  And the effective surfacing level is Answer
  And the messages region visually matches turn-reveal-hidden-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

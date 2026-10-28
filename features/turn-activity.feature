Feature: One turn log spans hand-backs and wake Runs

Scenario Outline: A hand-back stays in one turn log with its earlier message
  Given message surfacing is active at All
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log session has a two-segment <tool> turn
  Then the turn has one activity head, strip and log
  And only the final turn reply is outside the activity
  When I open the combined turn log
  Then the combined log orders the earlier message, hand-back and later work
  And the earlier hand-back message has its judged pin
  When I expand the answered hand-back row
  Then the answered hand-back shows its original tool details
  And the messages region visually matches <baseline> at 98 percent

Examples:
  | viewport | tool            | baseline                   |
  | desktop  | AskUserQuestion | turn-log-question-desktop  |
  | phone    | AskUserQuestion | turn-log-question-phone    |
  | desktop  | ExitPlanMode    | turn-log-plan-desktop      |
  | phone    | ExitPlanMode    | turn-log-plan-phone        |

Scenario Outline: Wake Runs continue inside the same turn log
  Given message surfacing is active at All
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log session has a wake turn
  Then the turn has one activity head, strip and log
  And only the final turn reply is outside the activity
  When I open the combined turn log
  Then the wake divider sits between the earlier reply and resumed work
  And the messages region visually matches <baseline> at 98 percent

Examples:
  | viewport | baseline              |
  | desktop  | turn-log-wake-desktop |
  | phone    | turn-log-wake-phone   |

Scenario Outline: A waiting Turn keeps its open question answerable below its reply
  Given message surfacing is active at All
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log session has a waiting turn
  Then the turn has one activity head, strip and log
  And only the final turn reply is outside the activity
  And the open hand-back is below the reply
  When I answer the waiting turn question
  Then the waiting turn answer reaches the relay
  And the messages region visually matches <baseline> at 98 percent

Examples:
  | viewport | baseline                 |
  | desktop  | turn-log-waiting-desktop  |
  | phone    | turn-log-waiting-phone    |

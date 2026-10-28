Feature: One chronological turn log per Turn, across skills, hand-backs and wake Runs

Scenario Outline: Jev-off turns remember open and collapsed choices across reloads
  Given message surfacing is inactive at Balanced
  And the conduit app is served with the connected mockup
  And minimising uses the dark theme with Turns open <preference>
  And the panel choice session has a settled turn
  Then the panel shows the saved message stop
  When I open the plain turn log
  And I reload the panel choice session
  Then the panel shows the full log
  When I collapse the plain turn log
  And I reload the panel choice session
  Then the panel shows the saved message stop
  And the messages region visually matches turn-panel-plain-persisted at 98 percent

Examples:
  | preference |
  | Expanded   |
  | Auto       |
  | Minimised  |

Scenario Outline: Turn summaries follow the shared phone breakpoint
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is <width> pixels wide
  And the recap session has a settled turn with current summaries
  Then the turn summary uses the <layout> layout
  And the screen region visually matches turn-panel-summary-<width> at 98 percent

Examples:
  | width | layout  |
  | 700   | phone   |
  | 767   | phone   |
  | 768   | desktop |

Scenario: Opening Summary with Jev off leaves the step log closed
  Given Jev is off with summaries on and a valid key in the dark theme
  And the conduit app is served with the connected mockup
  And the recap session has a settled turn with no summaries
  When I request the turn summary
  Then recap version 1 of 1 says The routing review is complete.
  And the panel shows the saved message stop
  And the messages region visually matches turn-panel-plain-summary at 98 percent

Scenario: The existing message level control leaves an open log in place
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the panel choice session has a settled turn
  When I open the plain turn log
  And I set the surfacing level to Key
  Then the panel shows the full log
  And the effective surfacing level is Key
  And the messages region visually matches turn-panel-level-keeps-log at 98 percent

Scenario: A settled log pick survives collapse and suspends during each wake Run
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the panel choice session has a settled turn
  When I open the plain turn log
  And I collapse and reopen the panel choice turn
  Then the panel shows the full log
  When a wake Run starts in the panel choice turn
  Then the panel shows the saved message stop
  When the panel choice Run settles
  Then the panel shows the full log
  When a wake Run starts in the panel choice turn
  Then the panel shows the saved message stop
  And the messages region visually matches turn-panel-settled-pick-wake at 98 percent

Scenario: A log picked while live returns to the saved stop on settle
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the panel choice session has a live turn
  When I open the plain turn log
  Then the panel shows the full log
  When the panel choice Run settles
  Then the panel shows the saved message stop
  And the messages region visually matches turn-panel-live-pick-settled at 98 percent

Scenario Outline: Two skills appear where they happened with their own time column
  Given message surfacing is <jev> at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log has two skills in a settled turn
  When I open the plain turn log
  Then the log shows both skills in order with sparkles, Skill, coloured names and times
  And the messages region visually matches turn-log-skills-settled-<jev>-<viewport> at 98 percent

Examples:
  | viewport | jev      |
  | desktop  | active   |
  | phone    | active   |
  | desktop  | inactive |
  | phone    | inactive |

Scenario Outline: Skills need no picker in a live or settled turn
  Given message surfacing is <jev> at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log has two skills in a <phase> turn
  Then skill events have no separate picker or chapter list
  When I open the plain turn log
  Then skill events have no separate picker or chapter list
  And the turn head counts 2 skills
  And the activity strip keeps every step at full strength
  And the log shows both skills in order with sparkles, Skill, coloured names and times
  And the messages region visually matches turn-log-skills-<phase>-<jev>-<viewport> at 98 percent

Examples:
  | viewport | jev      | phase   |
  | desktop  | active   | settled |
  | phone    | active   | settled |
  | desktop  | inactive | settled |
  | phone    | inactive | settled |
  | desktop  | active   | live    |
  | phone    | active   | live    |
  | desktop  | inactive | live    |
  | phone    | inactive | live    |

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
  And the turn log session has a <run> turn
  Then the turn has one activity head, strip and log
  And only the final turn reply is outside the activity
  When I open the combined turn log
  Then the wake divider sits between the earlier reply and resumed work
  And the messages region visually matches <baseline> at 98 percent

Examples:
  | viewport | run        | baseline                    |
  | desktop  | wake       | turn-log-wake-desktop        |
  | phone    | wake       | turn-log-wake-phone          |
  | desktop  | wake-reply | turn-log-wake-reply-desktop  |
  | phone    | wake-reply | turn-log-wake-reply-phone    |
  | desktop  | wake-empty | turn-log-wake-empty-desktop  |
  | phone    | wake-empty | turn-log-wake-empty-phone    |

Scenario Outline: A waiting Turn keeps its open question answerable below its reply
  Given message surfacing is active at All
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log session has a <kind> turn
  Then the turn has one activity head, strip and log
  And only the final turn reply is outside the activity
  And the open hand-back is below the reply
  When I answer the waiting turn question
  Then the waiting turn answer reaches the relay
  When I open the combined turn log
  Then the waiting hand-back becomes a compact log row
  And the messages region visually matches <baseline> at 98 percent

Examples:
  | viewport | kind    | baseline                 |
  | desktop  | waiting | turn-log-waiting-desktop  |
  | phone    | waiting | turn-log-waiting-phone    |
  | desktop  | async   | turn-log-async-desktop    |
  | phone    | async   | turn-log-async-phone      |

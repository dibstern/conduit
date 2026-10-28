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

Scenario: A message judged hidden opens directly too
  Given message surfacing is active at Answer
  And the conduit app is served with the connected mockup
  And the surfacing session has a settled turn
  When I open turn message #6 with digits and Enter
  Then the surfaced card shows #6 and announces its category and position
  And the turn card note says At Full log, below Answer · opened directly
  And the effective surfacing level is Answer
  And the messages region visually matches turn-reveal-hidden-verdict at 98 percent

Scenario Outline: A never-judged message opens its Full log step
  Given message surfacing is active at Answer
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I open turn message #7 with digits and Enter
  Then turn message #7 is focused in the Full log
  And the session surfacing override is absent
  And the messages region visually matches turn-reveal-unjudged-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario: A citation opens its message without widening Answer
  Given message surfacing is active at Answer
  And the conduit app is served with the connected mockup
  And the recap session has a settled turn with current summaries
  When I open the turn summary
  And I follow recap citation #3
  Then the surfaced card shows #3 and announces its category and position
  And the turn card note says At All messages, below Answer · opened directly
  And the summary shows no second copy of the cited message
  And the effective surfacing level is Answer
  And the messages region visually matches turn-reveal-citation at 98 percent

Scenario: The skills chip reveals an older step after paging history
  Given the viewport is a phone
  And the session loaded skills with transcript anchors
  And the conduit app is served with the skill-navigation mockup
  Then turn 3 is absent from the first transcript page
  When I open the skills chip
  And I tap the skill row "paged-skill"
  Then two older transcript pages were requested
  And the Skill step in turn 3 is focused in its expanded activity panel and in the viewport
  And the messages region visually matches turn-reveal-paged-skill at 98 percent

Scenario Outline: A reply outside the panel lands even with no activity
  Given message surfacing is active at Answer
  And the skills chip links to the reply
  And the conduit app is served with the connected mockup
  And the viewport is a phone
  And minimising uses the dark theme with Turns open Minimised
  And <fixture>
  When I open the skills chip
  And I tap the skill row "reveal-link"
  Then the revealed reply is in view without opening a turn log
  And the messages region visually matches turn-reveal-reply-<kind> at 98 percent

Examples:
  | fixture                                    | kind     |
  | the surfacing session has a settled turn    | activity |
  | the reveal session has a reply-only turn    | only     |

Scenario: A user anchor scrolls to the prompt without opening the panel
  Given message surfacing is active at Answer
  And the skills chip links to the user message
  And the conduit app is served with the connected mockup
  And the viewport is a phone
  And minimising uses the dark theme with Turns open Minimised
  And the surfacing session has a settled turn
  When I open the skills chip
  And I tap the skill row "reveal-link"
  Then the revealed user message is in view without opening a turn log
  And the messages region visually matches turn-reveal-user at 98 percent

Scenario: Text before an earlier hand-back reveals as a message step
  Given message surfacing is active at Answer
  And the skills chip links to the earlier hand-back message
  And the conduit app is served with the connected mockup
  And the turn log session has a two-segment AskUserQuestion turn
  When I open the skills chip
  And I tap the skill row "reveal-link"
  Then the surfaced card shows #1 and announces its category and position
  And the turn card note says At Most, below Answer · opened directly
  And the effective surfacing level is Answer
  And the messages region visually matches turn-reveal-earlier-hand-back at 98 percent

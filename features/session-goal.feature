Feature: Claude session goals

Scenario Outline: A goal follows the session on desktop and disappears when cleared
  Given the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  Then the session goal subtitle reads Goal set · starting
  And the composer has a violet goal border
  And the goal transcript notice reads Goal set · <condition>
  When Claude reports the goal check <reason>
  Then the session goal subtitle reads <condition> · 1 check · <reason>
  And the composer has a violet goal border
  And the goal transcript notice reads Goal set · <condition>
  And the layout region visually matches <baseline> at <threshold> percent
  When Claude clears the goal
  Then no session goal subtitle or transcript notice is rendered
  And the composer has a normal goal border

Examples:
  | condition                                                        | reason                   | baseline             | threshold |
  | All 38 acceptance scenarios pass on two consecutive runs         | 35 of 38 scenarios pass  | session-goal-pursuing | 98        |

Scenario Outline: A goal follows the session on a phone and disappears when cleared
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  Then the session goal subtitle reads Goal set · starting
  And the composer has a violet goal border
  And the goal transcript notice reads Goal set · <condition>
  When Claude reports the goal check <reason>
  Then the session goal subtitle reads <condition> · 1 check · <reason>
  And the composer has a violet goal border
  And the goal transcript notice reads Goal set · <condition>
  And the layout region visually matches <baseline> at <threshold> percent
  When Claude clears the goal
  Then no session goal subtitle or transcript notice is rendered
  And the composer has a normal goal border

Examples:
  | condition                                                        | reason                   | baseline             | threshold |
  | All 38 acceptance scenarios pass on two consecutive runs         | 35 of 38 scenarios pass  | session-goal-pursuing | 98        |

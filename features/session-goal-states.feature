Feature: Claude goal states and outcomes

Scenario Outline: An idle goal check has a checking header and spinner
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  And the goal check is running
  Then the session goal subtitle reads Checking goal · check 3
  And the session goal subtitle has a spinner
  And the composer checks the goal at check 3 without an elapsed timer
  And the composer has a violet goal border
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | condition               | baseline                   | threshold |
  | All 38 scenarios pass   | session-goal-checking-phone | 98        |

Scenario Outline: Claude continues working after a failed goal check
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  And the composer status clock is frozen
  When Claude sets the goal <condition>
  And Claude reports the goal check <reason>
  Then the session goal subtitle reads <condition> · 1 check
  And the composer status header does not include <reason>
  And the composer has a violet goal border
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | condition             | reason                  | baseline                         | threshold |
  | All 38 scenarios pass | 35 of 38 scenarios pass | session-goal-not-yet-working-phone | 98        |

Scenario Outline: An idle failed check has an amber subtitle
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  And Claude reports the goal check <reason>
  And Claude is idle
  Then the amber session goal subtitle reads <condition> · 1 check
  And the composer status header is not visible
  And the composer has a violet goal border
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | condition             | reason                  | baseline                       | threshold |
  | All 38 scenarios pass | 35 of 38 scenarios pass | session-goal-not-yet-idle-phone | 98        |

Scenario Outline: A paused goal explains the pause and has a dashed border
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  And Claude pauses the goal with the reason <reason>
  Then the session goal subtitle reads Goal paused · <condition>
  And the session goal pause title includes <reason>
  And the composer status header is not visible
  And the composer has a dashed violet goal border
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | condition             | reason                | baseline                  | threshold |
  | All 38 scenarios pass | Goal check interrupted | session-goal-paused-phone | 98        |

Scenario Outline: A met goal survives a reload and its dismissal hides both outcomes
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  And the goal is met with the reason <reason>
  And the stored goal is replayed after a reload
  Then the session goal subtitle reads Goal met · 7 checks · 41m
  And the met goal bar reads Goal met · <reason> · 7 checks · 41m
  And the composer has a normal goal border
  And the layout region visually matches <baseline> at <threshold> percent
  When I dismiss the met goal bar
  Then the met goal bar and subtitle are not rendered
  When the stored goal is replayed after a reload
  Then the met goal bar and subtitle are not rendered

Examples:
  | condition             | reason                  | baseline               | threshold |
  | All 38 scenarios pass | 38 of 38 scenarios pass | session-goal-met-phone | 98        |

Scenario Outline: A recently cleared goal can be sent again with Undo
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  And Claude is idle
  And Claude clears the goal
  Then no session goal subtitle or transcript notice is rendered
  And the cleared goal bar offers Undo
  And the composer has a normal goal border
  And the layout region visually matches <baseline> at <threshold> percent
  When I type Keep this draft into the composer
  And I click Undo for the cleared goal
  Then the mock relay received the goal message /goal <condition> for the current session
  And the cleared goal bar is not rendered
  And the composer draft still reads Keep this draft

Examples:
  | condition             | baseline                   | threshold |
  | All 38 scenarios pass | session-goal-cleared-phone | 98        |

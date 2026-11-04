Feature: Claude goal states and outcomes

Scenario Outline: An idle goal before its next check result reads Pursuing, never Checking
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  And the goal is idle before its next check result
  Then the session goal subtitle reads Pursuing · <condition>
  And the session goal subtitle has no running glyph
  And the composer shows no checking goal line
  And the composer status header is not visible
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
  Then the session goal subtitle reads Pursuing · <condition>
  And the composer does not include <reason>
  And the composer has a violet goal border
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | condition             | reason                  | baseline                         | threshold |
  | All 38 scenarios pass | 35 of 38 scenarios pass | session-goal-not-yet-working-phone | 98        |

Scenario Outline: An idle failed check keeps a teal Pursuing subtitle
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  And Claude reports the goal check <reason>
  And Claude is idle
  Then the session goal subtitle reads Pursuing · <condition>
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
  Then the session goal subtitle reads Paused · <condition>
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
  Then the session goal subtitle reads Goal met · <condition>
  And the met goal bar reads Goal met · <condition> and ends · 7 checks · 41m
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
  Then the mock relay received 1 SetGoal action for <condition> with distinct command ids and no goal chat message
  And the cleared goal bar is not rendered
  And the composer draft still reads Keep this draft

Examples:
  | condition             | baseline                   | threshold |
  | All 38 scenarios pass | session-goal-cleared-phone | 98        |

Scenario Outline: A clear shows Clearing, then the turn Claude queued it behind, and Stop never clears
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  And the session reports the goal clear Sent
  Then the session goal subtitle reads Clearing · <condition>
  And the pending goal bar reads Clearing goal…
  When the session reports the goal clear Queued
  Then the pending goal bar reads <queued> and offers Stop
  When I press Stop in the pending goal bar
  Then the mock relay received a stop and no further goal action
  When Claude confirms the goal clear
  Then the pending goal bar is not rendered
  And no session goal subtitle or transcript notice is rendered

Examples:
  | condition             | queued                                       |
  | All 38 scenarios pass | Clearing after this turn (queued by Claude)  |

Scenario Outline: A clear Claude has not confirmed offers Retry under a new command
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  And the session reports the goal clear Unconfirmed
  Then the pending goal bar reads Clear not confirmed and offers Retry
  When I press Retry in the pending goal bar
  Then the mock relay received 1 ClearGoal action with distinct command ids and no goal chat message

Examples:
  | condition             |
  | All 38 scenarios pass |

Scenario Outline: A clear that could not be delivered shows the goal again with a notice
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  And the session reports the goal clear failed
  Then the session goal subtitle reads Pursuing · <condition>
  And the pending goal bar reads <notice> and offers Retry

Examples:
  | condition             | notice                   |
  | All 38 scenarios pass | Couldn't clear the goal  |

Scenario Outline: A pause shows Pausing until it is confirmed, and an unconfirmed one offers Retry
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  And the session reports the goal pause Sent
  Then the session goal subtitle reads Pausing · <condition>
  And the pending goal bar reads Pausing goal…
  When the session reports the goal pause Unconfirmed
  Then the pending goal bar reads Pause not confirmed and offers Retry
  When I press Retry in the pending goal bar
  Then the mock relay received 1 PauseGoal action with distinct command ids and no goal chat message

Examples:
  | condition             |
  | All 38 scenarios pass |

Scenario Outline: A pause or clear applied mid-turn shows a note with Stop that goes when the turn ends
  Given the viewport is a phone
  And the conduit app is served with the matching-model mockup
  When Claude sets the goal <condition>
  And Codex <change> the goal while its turn finishes
  Then the goal note reads <note> and offers Stop
  When I press Stop in the goal note
  Then the mock relay received a stop and no further goal action
  When Codex's turn ends
  Then the goal note is not rendered

Examples:
  | condition             | change | note                                               |
  | All 38 scenarios pass | pauses | Goal paused. Codex is finishing its current turn.  |
  | All 38 scenarios pass | clears | Goal cleared. Codex is finishing its current turn. |

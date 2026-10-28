Feature: One chronological turn log per Turn, across skills, hand-backs and wake Runs

Scenario: Message stops name what they show
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the surfacing session has a settled turn
  Then the message stops read Answer, Key, Most and All messages
  And the messages region visually matches turn-stop-labels at 98 percent

Scenario: Settings uses the same message stop names
  Given the conduit app is served with the connected mockup
  And Surfacing has a valid key in the dark theme
  When I open settings to Surfacing
  Then the default message stops read Answer, Key, Most and All messages
  And the settings-panel region visually matches turn-stop-settings at 98 percent

Scenario: Mark prompts use the message stop names
  Given a surfacing marks ledger is available in the dark theme
  And message surfacing is active at All messages
  And the conduit app is served with the connected mockup
  And the surfacing session has a settled turn
  When I Raise surfaced message #3 from the card
  Then the turn mark prompt contains All messages and Most
  And the messages region visually matches turn-stop-mark-prompt at 98 percent

Scenario: Mark feedback names the new stop
  Given a surfacing marks ledger is available in the dark theme
  And message surfacing is active at All messages
  And the conduit app is served with the connected mockup
  And the surfacing session has a settled turn
  When I Raise surfaced message #3 from the card
  And I save the mark without a reason
  Then the surfacing mark toast says ▲ Raised #3 to Most
  And the messages region visually matches turn-stop-mark-feedback at 98 percent

Scenario: A hidden mark belongs to Full log
  Given a surfacing marks ledger is available in the dark theme
  And message surfacing is active at All messages
  And the conduit app is served with the connected mockup
  And the surfacing session has a settled turn
  When I Lower surfaced message #3 from the card
  Then the turn mark prompt contains All messages and Full log
  And the messages region visually matches turn-stop-hidden-prompt at 98 percent

Scenario: Hidden mark feedback names Full log
  Given a surfacing marks ledger is available in the dark theme
  And message surfacing is active at All messages
  And the conduit app is served with the connected mockup
  And the surfacing session has a settled turn
  When I Lower surfaced message #3 from the card
  And I save the mark without a reason
  Then the surfacing mark toast says ▼ Lowered #3 to Full log
  And the messages region visually matches turn-stop-hidden-feedback at 98 percent

Scenario: A card opened below the saved stop names both stops
  Given a surfacing marks ledger is available in the dark theme
  And message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the surfacing session has a settled turn
  When I Lower surfaced message #1 from the card
  And I save the mark without a reason
  Then the turn card note says At All messages, below Most · opened directly
  And the messages region visually matches turn-stop-card-note at 98 percent

Scenario: Summary citation notes name both stops
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the recap session has a settled turn with current summaries
  When I open the turn summary
  And I follow recap citation #3
  Then the summary stop note says At All messages, below Most · opened directly
  And the screen region visually matches turn-stop-summary-note at 98 percent

Scenario: Feedback uses the same names for message and hidden levels
  Given the conduit app is served with the connected mockup
  And Surfacing tuning has 6 marks and a valid key in the dark theme
  When I open settings to Surfacing
  And I open Surfacing Feedback
  Then the feedback ledger names Most and Full log
  And the settings-panel region visually matches turn-stop-ledger at 98 percent

Scenario: Category previews use the same stop names
  Given the conduit app is served with the connected mockup
  And Surfacing tuning has 6 marks and a valid key in the dark theme
  When I open settings to Surfacing
  And I open Surfacing Categories
  Then the category preview says Most shows
  And the settings-panel region visually matches turn-stop-category-preview at 98 percent

Scenario Outline: Full log uses All messages pins and cards without changing the saved stop
  Given message surfacing is active at <saved>
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I open the plain turn log
  Then the Full log pins are 1,2,3,4,5,8
  And the Full log has no Answer-only note
  When I pick surfaced message #3
  Then the surfaced card shows #3 and announces its category and position
  And the card has no below-stop note
  And the effective surfacing level is <saved>
  And the messages region visually matches turn-full-log-pins-<baseline>-<viewport> at 98 percent

Examples:
  | viewport | saved  | baseline |
  | desktop  | Key    | key      |
  | phone    | Key    | key      |
  | desktop  | Answer | answer   |
  | phone    | Answer | answer   |

Scenario Outline: Full log treats an opened finding as visible at All messages
  Given message surfacing is active at <saved>
  And the conduit app is served with the connected mockup
  And the surfacing session has a settled turn
  When I open the plain turn log
  And I open message #3 from the Full log row
  Then the surfaced card shows #3 and announces its category and position
  And the card has no below-stop note
  And the effective surfacing level is <saved>
  And the messages region visually matches turn-full-log-card-level-<baseline> at 98 percent

Examples:
  | saved  | baseline |
  | Most   | most     |
  | Answer | answer   |

Scenario Outline: Stops count the whole Turn and compaction rules do not count as steps
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log session has a counted-wake turn
  Then the message stop counts are Key 1, Most 1, All messages 2
  When I open the combined turn log
  Then the activity strip announces 5 steps
  And the Full log announces 5 steps
  And the combined log keeps its compaction rule between the messages
  And the messages region visually matches turn-stop-counts-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Jev-off turns remember open and collapsed choices across reloads
  Given message surfacing is inactive at Most
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
  Given message surfacing is active at Most
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

Scenario Outline: Collapsing during a scrub permits auto-read after reopening
  Given message surfacing is active at Most
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I start reading surfaced message #8
  And I collapse and reopen the turn while holding a scrub
  And the surfacing read clock advances 1500 milliseconds
  Then the surfaced message Read checkbox is checked
  And the surfacing read RPC count is 1
  And surfacing read RPC 1 marks only messages 8 read

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A folded card keeps bulk read failures visible and retryable
  Given message surfacing is active at Most
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  And surfacing read writes fail
  When I close the surfaced message
  And I mark 5 surfaced messages read
  Then the turn reports a read save failure
  And the surfacing head says 5 unread
  When surfacing read writes recover
  And I mark 5 surfaced messages read
  Then the surfacing head says All read ✓
  And surfacing read RPC 2 marks only messages 1,2,4,5,8 read
  And the messages region visually matches turn-card-folded-read-retry-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Folding a live card stops following and now resumes it
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a live turn
  When I fold the surfaced message
  Then the surfaced card offers Follow latest
  When I follow the latest surfaced message
  Then the surfaced card shows #8 and announces its category and position
  And the messages region visually matches turn-card-live-fold-now-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Marking a message Unread survives picking another card and returning
  Given message surfacing is active at Most
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I start reading surfaced message #8
  And the surfacing read clock advances 1000 milliseconds
  Then the surfaced message Read checkbox is checked
  When I uncheck the surfaced message Read checkbox
  And I pick surfaced message #2
  And I pick surfaced message #8
  And the surfacing read clock advances 1500 milliseconds
  Then the surfaced message Read checkbox is unchecked
  And the surfacing head says 5 unread
  And the surfacing read RPC count is 2
  And surfacing read RPC 2 marks only messages 8 unread
  And the messages region visually matches turn-card-unread-sticks-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario: Opening Summary with Jev off leaves the step log closed
  Given Jev is off with summaries on and a valid key in the dark theme
  And the conduit app is served with the connected mockup
  And the recap session has a settled turn with no summaries
  When I request the turn summary
  Then recap version 1 of 1 says The routing review is complete.
  And the panel shows the saved message stop
  And the messages region visually matches turn-panel-plain-summary at 98 percent

Scenario: The existing message level control leaves an open log in place
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the panel choice session has a settled turn
  When I open the plain turn log
  And I set the surfacing level to Key
  Then the panel shows the full log
  And the effective surfacing level is Key
  And the messages region visually matches turn-panel-level-keeps-log at 98 percent

Scenario: A settled log pick survives collapse and suspends during each wake Run
  Given message surfacing is active at Most
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
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the panel choice session has a live turn
  When I open the plain turn log
  Then the panel shows the full log
  When the panel choice Run settles
  Then the panel shows the saved message stop
  And the messages region visually matches turn-panel-live-pick-settled at 98 percent

Scenario Outline: Two skills appear where they happened with their own time column
  Given message surfacing is <jev> at Most
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
  Given message surfacing is <jev> at Most
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
  Given message surfacing is active at All messages
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
  Given message surfacing is active at All messages
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
  Given message surfacing is active at All messages
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

Scenario Outline: Cancelling a scrub discards its preview without picking a message
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  Then cancelling a strip scrub preserves the selected message and clears the caption
  And the messages region visually matches turn-strip-cancel-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

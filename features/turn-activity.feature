Feature: One chronological turn log per Turn, across skills, hand-backs and wake Runs

Scenario Outline: Q&A is available only on Turns with hand-backs
  Given message surfacing is <jev> at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log session has a <kind> turn
  Then the Turn <availability> Q&A on <viewport>
  And the messages region visually matches turn-qa-navigation-<jev>-<viewport>-<availability> at 98 percent

Examples:
  | jev      | viewport | kind                         | availability |
  | active   | desktop  | two-segment AskUserQuestion   | offers       |
  | active   | phone    | two-segment AskUserQuestion   | offers       |
  | inactive | desktop  | two-segment ExitPlanMode      | offers       |
  | inactive | phone    | two-segment ExitPlanMode      | offers       |
  | active   | desktop  | wake                         | omits        |
  | active   | phone    | wake                         | omits        |
  | inactive | desktop  | wake                         | omits        |
  | inactive | phone    | wake                         | omits        |

Scenario Outline: Q&A keeps each question, plan and answer in turn order
  Given message surfacing is <jev> at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log session has a qa-history turn
  When I select the Turn Q&A tab
  Then Q&A lists the question and plan with their answers in order
  And the messages region visually matches turn-qa-history-<jev>-<viewport> at 98 percent

Examples:
  | jev      | viewport |
  | active   | desktop  |
  | active   | phone    |
  | inactive | desktop  |
  | inactive | phone    |

Scenario Outline: The phone Show menu explains each cumulative stop
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is <width> pixels wide
  And the surfacing session has a settled turn
  Then the phone Show button reads Show · Most messages ⌄
  When I open the phone Show menu
  Then the phone Show menu lists the stops with counts and descriptions
  And the Show menu stays anchored to its button with a leading selected check
  And the screen region visually matches turn-show-menu-<width> at 98 percent
  When I dismiss the phone Show menu with Escape
  And I set the surfacing level to Key
  Then the phone Show button reads Show · Key messages ⌄
  And the effective surfacing level is Key
  When I choose surfacing Make default
  Then the daemon default becomes Key without changing other settings
  And the session surfacing override is absent
  When I set the surfacing level to All messages
  And I choose surfacing Back to default
  Then the phone Show button reads Show · Key messages ⌄
  When I open the plain turn log
  Then the phone Show button reads Show · Full log ⌄
  And the Full log pins are 1,2,3,4,5,8
  When I reload the surfacing session
  Then the effective surfacing level is Key

Examples:
  | width |
  | 393   |
  | 700   |

Scenario Outline: A running step uses the live row treatment
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log has a running tool
  Then the running log row says Running with an accent striped block and no time
  And the messages region visually matches turn-live-running-row-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Interim streaming text keeps the live ticker and following card through collapse
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the panel choice session has a live turn
  When interim text is streaming in the live Turn
  Then the Turn defaults to Full log with a three-step ticker
  And the live head orders its chevron, spinner and Working label
  And the live card is tagged Following latest
  And the earlier steps control uses the Turn log design
  And the messages region visually matches turn-live-streaming-<viewport> at 98 percent
  When I pick surfaced message #1
  Then the surfaced card offers Follow latest
  And the live card is not tagged Following latest
  When I follow the latest surfaced message
  Then the live card is tagged Following latest
  And the surfaced card shows #8 and announces its category and position
  When I open the live Full log from earlier steps
  Then the live log shows all 16 steps
  When I collapse and reopen the panel choice turn
  Then the live log shows all 16 steps
  When I hide the earlier live steps
  Then the Turn defaults to Full log with a three-step ticker
  When I collapse the surfaced turn
  Then the collapsed live Turn keeps its Working head and strip only
  And the messages region visually matches turn-live-collapsed-<viewport> at 98 percent
  When I expand the surfaced turn
  Then the Turn defaults to Full log with a three-step ticker

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A waiting Turn defaults to Full log with its ticker
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log session has a waiting turn
  Then the Turn defaults to Full log with a three-step ticker
  And the messages region visually matches turn-waiting-ticker-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A live Turn defaults to Full log and restores its saved stop on settle
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the panel choice session has a live turn
  Then the Turn defaults to Full log with a three-step ticker
  When the panel choice Run settles
  Then the effective surfacing level is Most
  And the messages region visually matches turn-live-default-settled-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Usage collects the turn's bill and notable events
  Given message surfacing is <jev> at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the Usage turn is <phase> with reported economics and notable events
  When I select the turn Usage tab
  Then Usage replaces the card and log without selecting a Show stop
  And Usage lists the reported cost, tokens, context, skills and notable events
  And the Usage footer has a divider and <cost> with <gauge> context gauge
  And the messages region visually matches turn-usage-<phase>-<jev>-<viewport> at 98 percent

Examples:
  | jev      | viewport | phase   | cost    | gauge |
  | active   | desktop  | settled | $0.4123 | a     |
  | active   | phone    | settled | $0.41   | no    |
  | inactive | desktop  | settled | $0.4123 | a     |
  | inactive | phone    | settled | $0.41   | no    |
  | active   | desktop  | live    | $0.41   | no    |
  | active   | phone    | live    | $0.41   | no    |
  | inactive | desktop  | live    | $0.41   | no    |
  | inactive | phone    | live    | $0.41   | no    |

Scenario Outline: Usage keeps the strip's collapsed markers and the footer's shared controls
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the Usage turn is settled with reported economics and notable events
  When I select the turn Usage tab
  Then Usage shows centred category dots instead of pins
  And the Usage footer has a divider and <cost> with <gauge> context gauge
  And the Usage panel uses a 6px gauge and a coloured sparkles skill pill
  And Usage and the Show stops share keyboard navigation
  And selecting a Usage strip step opens its Full log row
  And the head tooltip and Full log leave the bill in the footer
  And the messages region visually matches turn-usage-controls-<viewport> at 98 percent

Examples:
  | viewport | cost    | gauge |
  | desktop  | $0.4123 | a     |
  | phone    | $0.41   | no    |

Scenario: A selected pin below the saved stop keeps its category tint
  Given a surfacing marks ledger is available in the dark theme
  And message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the surfacing session has a settled turn
  When I Lower surfaced message #1 from the card
  And I save the mark without a reason
  Then the selected pin keeps its category tint and secondary number below the saved stop
  And the messages region visually matches turn-pin-below-stop-tint at 98 percent

Scenario Outline: A collapsed strip opens its focused message step with Enter
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I collapse the surfaced turn
  And I activate the first collapsed message step with the keyboard
  Then the surfaced card shows #1 and announces its category and position
  And the messages region visually matches turn-collapsed-keyboard-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Strip gaps and compaction seams match the Turn log design
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log session has a counted-wake turn
  Then the strip compaction is a 2px secondary-colour mark taller than its bar
  And the strip segments have 2px clear gaps
  And the messages region visually matches turn-strip-seam-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A live strip segment breathes rather than pulsing
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log has a running tool
  Then the live strip segment fades to 0.35 every 1.2 seconds
  And the messages region visually matches turn-strip-live-fade-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Collapsed dots retain every message and distinguish read from unread
  Given message surfacing is active at Most
  And surfacing read tracking starts with 1,4,8 read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I collapse the surfaced turn
  Then the collapsed strip shows 8 category dots, with 1,4,8 hollow and the rest filled
  And the collapsed Ask dot keeps its outer ring
  And the messages region visually matches turn-collapsed-category-dots-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Strip pins and steps have keyboard focus movement and activation
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  Then arrows move focus between strip pins and Enter picks the focused pin
  And arrows move focus between strip steps and Enter opens the focused step
  And the messages region visually matches turn-strip-keyboard-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Open pins use compact tinted chips and only reserve occupied rows
  Given message surfacing is active at Most
  And surfacing read tracking starts with 1,8 read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  Then open pins use 19px category chips with 6px stems and <numbers> numbers
  And read pins keep their full colour while unread pins keep a corner dot
  And the open Ask pin is tinted without a pulse
  And the pin lane reserves only its occupied rows
  And the messages region visually matches turn-pin-chips-<viewport> at 98 percent

Examples:
  | viewport | numbers |
  | desktop  | visible |
  | phone    | hidden  |

Scenario Outline: The plain activity bar stays centred in its desktop and phone hit target
  Given message surfacing is inactive at Most
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  Then the plain activity strip stays centred in its tap target
  And the messages region visually matches turn-strip-centred-<viewport> at 98 percent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario: Opening Full log at an earlier live step keeps that step in view
  Given message surfacing is active at Most
  And the viewport is a short desktop
  And the conduit app is served with the connected mockup
  And the surfacing session has a live turn
  When I open the first tool step from the live strip
  Then the first tool step is fully in view
  And the messages region visually matches turn-show-live-step-jump at 98 percent

Scenario Outline: Picking a message stop resumes reading its latest card
  Given message surfacing is active at All messages
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I <action>
  And I set the surfacing level to Key
  Then the surfaced card shows #8 and announces its category and position
  And the card has no below-stop note
  And the messages region visually matches turn-show-resume-<state>-<viewport> at 98 percent

Examples:
  | viewport | action                    | state  |
  | desktop  | close the surfaced message | folded |
  | phone    | close the surfaced message | folded |
  | desktop  | pick surfaced message #3   | picked |
  | phone    | pick surfaced message #3   | picked |

Scenario: Unjudged messages remain readable in Full log
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the surfacing session has a live turn
  When a new folded surfacing message awaits its verdict
  And the surfacing turn settles without the pending verdict
  When I open the plain turn log
  And I read the unjudged message in Full log
  Then the unjudged log message shows its full text
  And the messages region visually matches turn-show-unjudged-log at 98 percent

Scenario Outline: Opening the earlier live log keeps the newest step in place
  Given message surfacing is active at Most
  And the viewport is a short desktop
  And the conduit app is served with the connected mockup
  And the surfacing session has a live turn
  When I open the live Full log from <control>
  Then the newest live step stays in place
  And the messages region visually matches turn-show-live-scroll-<baseline> at 98 percent

Examples:
  | control       | baseline |
  | the Show bar  | tabs     |
  | earlier steps | earlier  |

Scenario Outline: One left chevron owns the open and collapsed Turn
  Given message surfacing is <jev> at Most
  And the conduit app is served with the connected mockup
  And the surfacing session has a <phase> turn
  Then the Turn has one left chevron and no separate log toggle
  When I collapse and reopen the Turn with its chevron and h
  Then the Turn has one left chevron and no separate log toggle
  And the messages region visually matches turn-show-chevron-<jev>-<phase> at 98 percent

Examples:
  | jev      | phase   |
  | active   | settled |
  | active   | live    |
  | inactive | settled |

Scenario: The desktop Show bar controls message stops and Full log
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the surfacing session has a settled turn
  Then the Show bar has flat accessible tabs with Answer, Key 3, Most 5, All messages 6, Full log 16 and Usage
  When I navigate the Show tabs with arrow keys
  Then the Show bar selects Full log without changing the saved Most stop
  And the Full log pins are 1,2,3,4,5,8
  And the open Turn is one bordered panel with one-line message rows and card-only actions
  When I reload the surfacing session
  Then the effective surfacing level is Most
  When I set the surfacing level to Key
  Then the panel shows the saved message stop
  And the effective surfacing level is Key
  And the messages region visually matches turn-show-tabs-desktop at 98 percent

Scenario: The Show bar and bill cover the whole Turn across an AskUserQuestion hand-back
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the turn log session has a two-segment AskUserQuestion turn
  Then the Turn has one Show bar with Key 0, Most 1, All messages 1 and Full log 4
  When I open the combined turn log
  Then the combined log orders the earlier message, hand-back and later work
  And the whole Turn bill is $0.0300
  And the messages region visually matches turn-show-hand-back-desktop at 98 percent

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
  And the messages region visually matches turn-full-log-pins-<baseline>-<viewport> at 98 percent
  When I reload the surfacing session
  Then the effective surfacing level is <saved>

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
  And the messages region visually matches turn-full-log-card-level-<baseline> at 98 percent
  When I reload the surfacing session
  Then the effective surfacing level is <saved>

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

Scenario: Picking a message stop leaves Full log
  Given message surfacing is active at Most
  And the conduit app is served with the connected mockup
  And the panel choice session has a settled turn
  When I open the plain turn log
  And I set the surfacing level to Key
  Then the panel shows the saved message stop
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
  Then the Turn defaults to Full log with a three-step ticker
  When the panel choice Run settles
  Then the panel shows the full log
  When a wake Run starts in the panel choice turn
  Then the Turn defaults to Full log with a three-step ticker
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
  And I show every step in the open turn log
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

Scenario Outline: Open questions remain answerable in Q&A
  Given message surfacing is active at All messages
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log session has a <kind> turn
  Then the turn has one activity head, strip and log
  And only the final turn reply is outside the activity
  When I select the Turn Q&A tab
  Then the open hand-back is in Q&A instead of below the reply
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

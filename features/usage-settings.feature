Feature: Settings Usage is the home for Claude plan usage and limit recovery

Background:
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the Usage settings clock is pinned to 2026-01-01T14:25:00Z

Scenario Outline: one account has full window rows on desktop
  Given the viewport is a desktop
  And Usage settings have one Claude account in the <state> state
  When I open settings to the Usage section
  Then the Usage forecast claude is absent
  Then the Usage settings title reads Claude plan usage
  And the settings sections place Usage and Server under This computer
  And the Usage settings subheader reads <subheader>
  And the Usage single-account windows show 5h <fiveHour> and Week <week>
  And the Usage single-account five_hour reset reads <fiveHourReset>
  And the Usage single-account seven_day reset reads <weekReset>
  And the Usage settings empty message reads <emptyMessage>
  And the Usage single-account limit section has only auto-resume
  And the usage limit settings heading reads When the account reaches its limit
  And the Auto-resume limited sessions toggle is off and reads Continue the cut-off request on the same account when its limit resets.
  And the Usage warning choices read 70%, 80%, 90%, off
  And the Usage warning choice 80 is selected
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | state  | subheader                              | fiveHour | week | fiveHourReset                         | weekReset        | emptyMessage                                                                                                                                                                           | baseline                            | threshold |
  | normal | Claude Max · updated 2m ago · Refresh | 41%      | 22%  | resets in 3h 05m (5:30 pm)             | resets Thu 9 am | absent                                                                                                                                                                                 | usage-settings-single-desktop       | 98        |
  | warn5  | Claude Max · updated 2m ago · Refresh | 86%      | 58%  | resets in 3h 05m (5:30 pm)             | resets Thu 9 am | absent                                                                                                                                                                                 | usage-settings-single-warn5-desktop | 98        |
  | warnWk | Claude Max · updated 2m ago · Refresh | 30%      | 91%  | resets in 3h 05m (5:30 pm)             | resets Thu 9 am | absent                                                                                                                                                                                 | usage-settings-single-warn-week-desktop | 98        |
  | limit  | Claude Max · updated 2m ago · Refresh | 100%     | 71%  | limit reached · resets 3:13 pm         | resets Thu 9 am | absent                                                                                                                                                                                 | usage-settings-single-limit-desktop | 98        |
  | none   | Claude                                | absent   | absent | absent                              | absent          | No plan limits for this login. Conduit reads them from a Claude subscription sign-in; API keys, Bedrock, Vertex and proxy routes don't report them. | usage-settings-single-none-desktop  | 98        |

Scenario Outline: one account has a full-screen Usage screen on phones
  Given the viewport is a phone
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list
  And Usage settings have one Claude account in the <state> state
  When I open settings to the Usage section
  Then the Usage forecast claude is absent
  Then the Usage settings title reads Usage
  And the phone Usage screen fills the viewport and has a scrolling body and a back button
  And the Usage settings subheader reads <subheader>
  And the Usage single-account windows show 5h <fiveHour> and Week <week>
  And the Usage single-account five_hour reset reads <fiveHourReset>
  And the Usage single-account seven_day reset reads <weekReset>
  And the Usage settings empty message reads <emptyMessage>
  And the Usage single-account limit section has only auto-resume
  And the usage limit settings heading reads When the account reaches its limit
  And the Auto-resume limited sessions toggle is off and reads Same account, at reset.
  And the Usage warning choices read 70, 80, 90, off
  And the phone Usage warning choices are 44px tall
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | state  | subheader                              | fiveHour | week | fiveHourReset                         | weekReset        | emptyMessage                                                                                                                                                                           | baseline                          | threshold |
  | normal | Claude Max · updated 2m ago · Refresh | 41%      | 22%  | resets in 3h 05m (5:30 pm)             | resets Thu 9 am | absent                                                                                                                                                                                 | usage-settings-single-phone       | 98        |
  | warn5  | Claude Max · updated 2m ago · Refresh | 86%      | 58%  | resets in 3h 05m (5:30 pm)             | resets Thu 9 am | absent                                                                                                                                                                                 | usage-settings-single-warn5-phone | 98        |
  | warnWk | Claude Max · updated 2m ago · Refresh | 30%      | 91%  | resets in 3h 05m (5:30 pm)             | resets Thu 9 am | absent                                                                                                                                                                                 | usage-settings-single-warn-week-phone | 98        |
  | limit  | Claude Max · updated 2m ago · Refresh | 100%     | 71%  | limit reached · resets 3:13 pm         | resets Thu 9 am | absent                                                                                                                                                                                 | usage-settings-single-limit-phone | 98        |
  | none   | Claude                                | absent   | absent | absent                              | absent          | No plan limits for this login. Conduit reads them from a Claude subscription sign-in; API keys, Bedrock, Vertex and proxy routes don't report them. | usage-settings-single-none-phone  | 98        |

Scenario Outline: several accounts share ordered cards on desktop
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the <state> state
  When I open settings to the Usage section
  Then the Usage settings title reads Claude plan usage
  And the Usage settings subheader reads 3 accounts · updated 2m ago · Refresh all
  And the Usage settings headline reads <headline> in <colour>
  And the account order reads Personal, Work, Spare
  And the Usage cards show their positions, account dots, plan badges and drag handles
  And the Usage account claude status reads <status> in <statusColour>
  And the Usage account claude windows show 5h <fiveHour> and Week <week>
  And the Usage account claude five_hour reset reads <fiveHourReset>
  And the Usage account claude seven_day reset reads <weekReset>
  And the Usage account work status reads ok in muted
  And the Usage account work windows show 5h 12% and Week 48%
  And the Usage account spare windows show 5h 0% and Week 9%
  And the Usage account spare five_hour reset reads no window open
  And the Usage no-data card claude reads <emptyMessage>
  And the Usage order hint reads Drag ⠿ to set the auto-switch order.
  And the Usage warning choices read 70%, 80%, 90%, off
  And the usage limit settings heading reads When an account reaches its limit
  And the Auto-resume limited sessions toggle is off and reads Continue the cut-off request on the same account when its limit resets.
  And the Auto-switch account toggle is off and reads Move the session to the first account above that has quota. Runs before auto-resume.
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | state  | headline                                                                                                              | colour | status           | statusColour | fiveHour | week   | fiveHourReset         | weekReset        | emptyMessage                                                                                                           | baseline                              | threshold |
  | normal | All 3 accounts are on pace to stay under their limits.                                                                 | muted  | ok               | muted        | 41%      | 22%    | resets in 3h 05m      | resets Thu 9 am | absent                                                                                                                 | usage-settings-multiple-desktop       | 98        |
  | warn5  | All 3 accounts are on pace to stay under their limits.                                                                 | muted  | 5h 86%           | amber        | 86%      | 58%    | resets in 3h 05m      | resets Thu 9 am | absent                                                                                                                 | usage-settings-multiple-warn5-desktop | 98        |
  | warnWk | All 3 accounts are on pace to stay under their limits.                                                                 | muted  | week 91%         | amber        | 30%      | 91%    | resets in 3h 05m      | resets Thu 9 am | absent                                                                                                                 | usage-settings-multiple-warn-week-desktop | 98        |
  | limit  | Personal is limited until 3:13 pm. Work, next in the switch order, has 88% of its 5h window left.                       | red    | limited · 3:13   | red          | 100%     | 71%    | resets 3:13 pm        | resets Thu 9 am | absent                                                                                                                 | usage-settings-multiple-limit-desktop | 98        |
  | none   | Personal has no plan data. Work and Spare are on pace to stay under their limits.                                     | muted  | no plan data     | muted        | absent   | absent | absent                | absent          | No plan data for this login (API key, Bedrock, Vertex or proxy). Auto-switch can still pick it.                           | usage-settings-multiple-none-desktop  | 98        |

Scenario Outline: several account cards and limit controls fit the phone screen
  Given the viewport is a phone
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list
  And Usage settings have several Claude accounts in the <state> state
  When I open settings to the Usage section
  Then the Usage settings title reads Usage
  And the phone Usage screen fills the viewport and has a scrolling body and a back button
  And the Usage settings subheader reads 3 accounts · updated 2m ago · Refresh all
  And the Usage settings headline reads <headline> in <colour>
  And the account order reads Personal, Work, Spare
  And the Usage cards show their positions, account dots, plan badges and drag handles
  And the Usage account claude status reads <status> in <statusColour>
  And the Usage account claude windows show 5h <fiveHour> and Week <week>
  And the Usage account claude five_hour reset reads <fiveHourReset>
  And the Usage account claude seven_day reset reads <weekReset>
  And the Usage account work windows show 5h 12% and Week 48%
  And the Usage account spare windows show 5h 0% and Week 9%
  And the Usage account spare five_hour reset reads no window open
  And the Usage no-data card claude reads <emptyMessage>
  And the Usage order hint reads Drag ⠿ to set the auto-switch order.
  And the Usage warning choices read 70, 80, 90, off
  And the phone Usage warning choices are 44px tall
  And the usage limit settings heading reads When an account reaches its limit
  And the Auto-resume limited sessions toggle is off and reads Same account, at reset.
  And the Auto-switch account toggle is off and reads First account above with quota.
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | state  | headline                                                                                                              | colour | status           | statusColour | fiveHour | week   | fiveHourReset         | weekReset        | emptyMessage                                                                                                           | baseline                            | threshold |
  | normal | All 3 accounts are on pace to stay under their limits.                                                                 | muted  | ok               | muted        | 41%      | 22%    | resets in 3h 05m      | resets Thu 9 am | absent                                                                                                                 | usage-settings-multiple-phone       | 98        |
  | warn5  | All 3 accounts are on pace to stay under their limits.                                                                 | muted  | 5h 86%           | amber        | 86%      | 58%    | resets in 3h 05m      | resets Thu 9 am | absent                                                                                                                 | usage-settings-multiple-warn5-phone | 98        |
  | warnWk | All 3 accounts are on pace to stay under their limits.                                                                 | muted  | week 91%         | amber        | 30%      | 91%    | resets in 3h 05m      | resets Thu 9 am | absent                                                                                                                 | usage-settings-multiple-warn-week-phone | 98        |
  | limit  | Personal is limited until 3:13 pm. Work, next in the switch order, has 88% of its 5h window left.                       | red    | limited · 3:13   | red          | 100%     | 71%    | resets 3:13 pm        | resets Thu 9 am | absent                                                                                                                 | usage-settings-multiple-limit-phone | 98        |
  | none   | Personal has no plan data. Work and Spare are on pace to stay under their limits.                                     | muted  | no plan data     | muted        | absent   | absent | absent                | absent          | No plan data for this login (API key, Bedrock, Vertex or proxy). Auto-switch can still pick it.                           | usage-settings-multiple-none-phone  | 98        |

Scenario Outline: one account shows only its reported model weeks without reset lines
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the normal state
  And the Usage account claude has model windows Fable <fable>% and Sonnet 6%
  When I open settings to the Usage section
  Then the Usage single-account windows show 5h 41% and Week 22%
  And the Usage single-account model rows show Fable <fable>% and Sonnet 6% without reset lines
  And the Usage account claude remains available
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | fable | baseline                                   | threshold |
  | desktop  | 12    | usage-settings-single-models-desktop       | 98        |
  | phone    | 12    | usage-settings-single-models-phone         | 98        |
  | desktop  | 100   | usage-settings-single-model-limit-desktop  | 98        |
  | phone    | 100   | usage-settings-single-model-limit-phone    | 98        |

Scenario Outline: an account without model windows shows no extra rows
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the normal state
  When I open settings to the Usage section
  Then the Usage single-account windows show 5h 41% and Week 22%
  And the Usage single-account has no model rows
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                                  | threshold |
  | desktop  | usage-settings-single-no-models-desktop    | 98        |
  | phone    | usage-settings-single-no-models-phone      | 98        |

Scenario Outline: desktop cards show model weeks without changing account limits
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the normal state
  And the Usage account claude has model windows Fable <fable>% and Sonnet 6%
  When I open settings to the Usage section
  Then the Usage account claude model line reads Fable week <fable>% · Sonnet week 6%
  And the Usage account work model line reads absent
  And the Usage account spare model line reads absent
  And the Usage account claude remains available
  And the Usage account claude status reads ok in muted
  And the Usage settings headline reads All 3 accounts are on pace to stay under their limits. in muted
  And the account order reads Personal, Work, Spare
  And the usage-settings region visually matches <baseline> at <threshold> percent
  When I close settings
  Then the usage footer claude shows five_hour 41% and seven_day 22%
  And the usage footer claude five_hour meter is normal at 41 percent
  And the usage footer claude seven_day meter is normal at 22 percent

Examples:
  | fable | baseline                                      | threshold |
  | 12    | usage-settings-multiple-models-desktop         | 98        |
  | 100   | usage-settings-multiple-model-limit-desktop    | 98        |

Scenario Outline: phone cards and chips keep account limits separate from model weeks
  Given the viewport is a phone
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list
  And Usage settings have several Claude accounts in the normal state
  And the Usage account claude has model windows Fable <fable>% and Sonnet 6%
  When I open settings to the Usage section
  Then the Usage account claude model line reads Fable week <fable>% · Sonnet week 6%
  And the Usage account work model line reads absent
  And the Usage account spare model line reads absent
  And the Usage account claude remains available
  And the Usage account claude status reads ok in muted
  And the Usage settings headline reads All 3 accounts are on pace to stay under their limits. in muted
  And the account order reads Personal, Work, Spare
  And the usage-settings region visually matches <baseline> at <threshold> percent
  When I close settings
  And I tap back to the session list
  Then the phone usage rows are claude in that order
  And the usage footer claude five_hour meter is normal at 41 percent

Examples:
  | fable | baseline                                    | threshold |
  | 12    | usage-settings-multiple-models-phone         | 98        |
  | 100   | usage-settings-multiple-model-limit-phone    | 98        |

Scenario: a single account with no five-hour window still has its weekly usage
  Given the viewport is a desktop
  And Usage settings have one Claude account in the normal state
  And the Usage account claude has no five-hour window
  When I open settings to the Usage section
  Then the Usage single-account windows show 5h — and Week 22%
  And the Usage single-account five_hour reset reads no window open
  And the Usage single-account seven_day reset reads resets Thu 9 am

Scenario: a limit without a reset time does not invent a reset
  Given the viewport is a desktop
  And Usage settings have one Claude account in the limit state
  When the usage footer claude five_hour reading is 100% resetting at none
  And I open settings to the Usage section
  Then the Usage single-account five_hour reset reads limit reached

Scenario: the reached five-hour limit binds even when the weekly window warns
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the limit state
  When the usage footer claude seven_day reading is 91% resetting at 2026-01-08T09:00:00Z
  And I open settings to the Usage section
  Then the Usage settings headline reads Personal is limited until 3:13 pm. Work, next in the switch order, has 88% of its 5h window left. in red
  And the Usage account claude status reads limited · 3:13 in red
  And the Usage account claude windows show 5h 100% and Week 91%
  And the Usage account claude five_hour reset reads resets 3:13 pm
  And the Usage account claude seven_day reset reads resets Thu 9 am

Scenario: no eligible successor omits the switch recommendation
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the limit state
  And the Usage account work is unavailable
  And the usage footer spare five_hour reading is 100% resetting at 2026-01-01T15:13:00Z
  When I open settings to the Usage section
  Then the Usage settings headline reads Personal is limited until 3:13 pm. in red

Scenario: the recommendation follows the saved switch order and skips unavailable accounts
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the limit state
  And the Usage account work is unavailable
  When I open settings to the Usage section
  Then the Usage settings headline reads Personal is limited until 3:13 pm. Spare, next in the switch order, has 100% of its 5h window left. in red

Scenario Outline: warning thresholds are saved, survive reload and change the desktop footer
  Given the viewport is a desktop
  And Usage settings have one Claude account in the warn5 state
  When I open settings to the Usage section
  And I select the Usage warning choice <initial>
  And I select the Usage warning choice <choice>
  Then the SetUsageLimitsSetting RPC saves warnAt <choice>
  And the Usage warning choice <choice> is selected
  When I reload the app and open the Usage section
  Then the Usage warning choice <choice> is selected
  When I close settings
  Then the usage footer claude five_hour level is <level> with an <fill> bar

Examples:
  | initial | choice | level   | fill   |
  | 90      | 70     | warning | amber  |
  | 90      | 80     | warning | amber  |
  | 70      | 90     | normal  | normal |
  | 90      | off    | normal  | amber  |

Scenario Outline: the phone usage dock uses the saved warning threshold
  Given the viewport is a phone
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list
  And Usage settings have several Claude accounts in the warn5 state
  When I open settings to the Usage section
  And I select the Usage warning choice <initial>
  And I select the Usage warning choice <choice>
  Then the SetUsageLimitsSetting RPC saves warnAt <choice>
  When I close settings
  And I tap back to the session list
  Then the usage footer claude shows five_hour 86% and seven_day 58%
  And the usage footer claude five_hour window is at level <level>

Examples:
  | initial | choice | level   |
  | 90      | 70     | warning |
  | 90      | 80     | warning |
  | 70      | 90     | normal  |
  | 90      | off    | normal  |

Scenario Outline: desktop card dragging saves and replays the switch order
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the normal state
  When I open settings to the Usage section
  And I drag the Usage account Spare above Personal
  Then the account order reads Spare, Personal, Work
  And the SetUsageLimitsSetting RPC saves auto-resume off, auto-switch off, order spare, claude, work
  When I drag the Usage account Work above Personal
  Then the account order reads Spare, Work, Personal
  And the SetUsageLimitsSetting RPC saves auto-resume off, auto-switch off, order spare, work, claude
  When I reload the app and open the Usage section
  Then the account order reads Spare, Work, Personal
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                          | threshold |
  | usage-settings-reordered-desktop | 98        |

Scenario: desktop cards drag down and up again
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the normal state
  When I open settings to the Usage section
  And I drag the Usage account Personal below Work
  Then the account order reads Work, Personal, Spare
  When I drag the Usage account Personal below Spare
  Then the account order reads Work, Spare, Personal
  When I drag the Usage account Personal above Work
  Then the account order reads Personal, Work, Spare

Scenario: phone cards touch-drag repeatedly
  Given the viewport is a phone
  And Usage settings have several Claude accounts in the normal state
  When I open settings to the Usage section
  And I touch-drag the Usage account Spare above Personal
  Then the account order reads Spare, Personal, Work
  When I touch-drag the Usage account Work above Personal
  Then the account order reads Spare, Work, Personal
  When I touch-drag the Usage account Spare below Personal
  Then the account order reads Work, Personal, Spare

Scenario: the card handle supports ArrowUp and ArrowDown without pickup
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the normal state
  When I open settings to the Usage section
  And I press ArrowUp on the Usage account Work handle
  Then the account order reads Work, Personal, Spare
  And the SetUsageLimitsSetting RPC saves auto-resume off, auto-switch off, order work, claude, spare
  When I press ArrowDown on the Usage account Work handle
  Then the account order reads Personal, Work, Spare
  And the SetUsageLimitsSetting RPC saves auto-resume off, auto-switch off, order claude, work, spare

Scenario Outline: auto-resume is now saved from Usage
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the normal state
  And auto-resume limited sessions is off on the daemon
  When I open settings to the Usage section
  Then the usage limit settings heading reads When the account reaches its limit
  And the Auto-resume limited sessions toggle is off and reads <description>
  When I turn on Auto-resume limited sessions
  Then the SetUsageLimitsSetting RPC turns auto-resume on
  And the Auto-resume limited sessions toggle is on and reads <description>
  And the usage-limit-settings region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | description                                                              | baseline                      | threshold |
  | desktop  | Continue the cut-off request on the same account when its limit resets. | usage-settings-resume-desktop | 98        |
  | phone    | Same account, at reset.                                                  | usage-settings-resume-phone   | 98        |

Scenario Outline: auto-switch retains its toggles and accessible reordering in Usage
  Given the viewport is a <viewport>
  And the Claude accounts are claude as work2claude, self as personal, team as team-max
  And the daemon's usage limits are auto-resume on, auto-switch off, order team, claude
  And the quota check reads claude limited until 2026-01-05T09:00:00Z, self 38% used, team unknown
  And the quota check is published as the live Usage reading
  When I open settings to the Usage section
  Then the Auto-switch account toggle is off and reads <description>
  And the account order reads team-max, work2claude, personal
  And the account work2claude shows limited · 9:00 quota
  And the account personal shows ok quota
  And the Usage account self windows show 5h 38% and Week —
  And the account team-max shows no plan data quota
  And the Usage no-data card team reads No plan data for this login (API key, Bedrock, Vertex or proxy). Auto-switch can still pick it.
  And the usage-settings region visually matches <baseline> at <threshold> percent
  When I turn on Auto-switch account
  Then the SetUsageLimitsSetting RPC saves auto-resume on, auto-switch on, order team, claude
  When I move personal to the top of the account order by <input>
  Then the account order reads personal, team-max, work2claude
  And the SetUsageLimitsSetting RPC saves auto-resume on, auto-switch on, order self, team, claude
  And the account order announces Dropped personal at position 1 of 3.

Examples:
  | viewport | description                                                                          | input    | baseline                           | threshold |
  | desktop  | Move the session to the first account above that has quota. Runs before auto-resume. | keyboard | usage-settings-auto-switch-desktop | 98        |
  | phone    | First account above with quota.                                                      | touch    | usage-settings-auto-switch-phone   | 98        |

Scenario: Refresh requests quota and the subscription replaces the view
  Given the viewport is a desktop
  And Usage settings have one Claude account in the normal state
  And the next Usage refresh publishes the warn5 reading
  When I open settings to the Usage section
  And I press Refresh in Usage settings
  Then the QuotaForAccounts RPC refreshes the attached project
  And the Usage single-account windows show 5h 86% and Week 58%
  And the Usage settings subheader reads Claude Max · updated just now · Refresh
  And the SubscribeUsage RPC has no project payload
  When the Usage settings clock advances by 120 seconds
  Then the Usage settings subheader reads Claude Max · updated 2m ago · Refresh

Scenario: Refresh all names every account and the oldest reading sets the update age
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the normal state
  And the next Usage refresh publishes the warnWk reading
  When I open settings to the Usage section
  Then the Usage settings subheader reads 3 accounts · updated 2m ago · Refresh all
  When I press Refresh all in Usage settings
  Then the QuotaForAccounts RPC refreshes the attached project
  And the Usage account claude status reads week 91% in amber
  And the Usage settings subheader reads 3 accounts · updated just now · Refresh all

Scenario: the desktop footer opens the Usage section directly
  Given the viewport is a desktop
  And Usage settings have one Claude account in the normal state
  When I click the desktop usage footer
  Then the Usage settings title reads Claude plan usage
  And the Usage settings subheader reads Claude Max · updated 2m ago · Refresh

Scenario: the phone usage sheet opens Usage
  Given the viewport is a phone
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list
  And Usage settings have several Claude accounts in the normal state
  When I tap back to the session list
  And I open the phone usage sheet
  And I tap Settings in the usage sheet
  Then the Usage settings title reads Usage
  And the phone Usage screen fills the viewport and has a scrolling body and a back button
  When I press the Usage back button
  Then the settings sections place Usage and Server under This computer

Scenario: the phone single-account row opens Usage directly
  Given the viewport is a phone
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list
  And Usage settings have one Claude account in the normal state
  When I tap back to the session list
  And I tap the phone single-account usage row
  Then the Usage settings title reads Usage
  And the Usage settings subheader reads Claude Max · updated 2m ago · Refresh

Scenario Outline: a single-account forecast describes the selected window
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the normal state
  And the usage footer claude <kind> reading is <used>% resetting at <reset>
  And the Usage account claude <kind> forecast is <forecast> resetting at <reset>
  And the Usage account claude <otherKind> forecast is under at <otherValue>% resetting at <otherReset>
  When I open settings to the Usage section
  Then the Usage forecast claude is framed
  And the Usage forecast claude selects <kind>
  And the Usage forecast claude sentence reads <sentence> in <level>
  And the Usage forecast claude emphasizes <emphasis>
  And the Usage forecast claude other line reads <otherLine>
  And the Usage forecast claude chart has a <crossing> crossing dot and a <projection> projection
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | kind | used | reset | forecast | otherKind | otherValue | otherReset | sentence | level | emphasis | otherLine | crossing | projection | baseline | threshold |
  | desktop | five_hour | 41 | 2026-01-01T17:30:00Z | under at 74% | seven_day | 48 | 2026-01-08T09:00:00Z | On pace to finish this 5h window at ~74% (resets 5:30 pm). | neutral | ~74% | Week: on pace for ~48% by Thu 9 am. | absent | rising | usage-settings-forecast-fine-desktop | 98 |
  | phone | five_hour | 41 | 2026-01-01T17:30:00Z | under at 74% | seven_day | 48 | 2026-01-08T09:00:00Z | On pace to finish this 5h window at ~74% (resets 5:30 pm). | neutral | ~74% | Week: on pace for ~48% by Thu 9 am. | absent | rising | usage-settings-forecast-fine-phone | 98 |
  | desktop | five_hour | 86 | 2026-01-01T15:37:00Z | runs_out at 2026-01-01T15:04:00Z | seven_day | 48 | 2026-01-08T09:00:00Z | At this pace the 5h limit runs out ≈ 3:04 pm, 33m before it resets. | amber | 3:04 pm | Week: on pace for ~48% by Thu 9 am. | present | rising | usage-settings-forecast-five-hour-out-desktop | 98 |
  | phone | five_hour | 86 | 2026-01-01T15:37:00Z | runs_out at 2026-01-01T15:04:00Z | seven_day | 48 | 2026-01-08T09:00:00Z | At this pace the 5h limit runs out ≈ 3:04 pm, 33m before it resets. | amber | 3:04 pm | Week: on pace for ~48% by Thu 9 am. | present | rising | usage-settings-forecast-five-hour-out-phone | 98 |
  | desktop | seven_day | 91 | 2026-01-08T09:00:00Z | runs_out at 2026-01-06T05:00:00Z | five_hour | 55 | 2026-01-01T18:45:00Z | At this pace the weekly limit runs out ≈ Tue 5 am, 2 days before it resets. | amber | Tue 5 am | 5h window: on pace for ~55% by 6:45 pm. | present | rising | usage-settings-forecast-week-out-desktop | 98 |
  | phone | seven_day | 91 | 2026-01-08T09:00:00Z | runs_out at 2026-01-06T05:00:00Z | five_hour | 55 | 2026-01-01T18:45:00Z | At this pace the weekly limit runs out ≈ Tue 5 am, 2 days before it resets. | amber | Tue 5 am | 5h window: on pace for ~55% by 6:45 pm. | present | rising | usage-settings-forecast-week-out-phone | 98 |
  | desktop | five_hour | 100 | 2026-01-01T15:13:00Z | under at 100% | seven_day | 48 | 2026-01-08T09:00:00Z | Limit reached. The 5h window resets at 3:13 pm. | red | 3:13 pm | Week: on pace for ~48% by Thu 9 am. | absent | flat | usage-settings-forecast-limit-desktop | 98 |
  | phone | five_hour | 100 | 2026-01-01T15:13:00Z | under at 100% | seven_day | 48 | 2026-01-08T09:00:00Z | Limit reached. The 5h window resets at 3:13 pm. | red | 3:13 pm | Week: on pace for ~48% by Thu 9 am. | absent | flat | usage-settings-forecast-limit-phone | 98 |
  | desktop | seven_day | 100 | 2026-01-08T09:00:00Z | under at 100% | five_hour | 55 | 2026-01-01T18:45:00Z | Limit reached. The weekly window resets at Thu 9 am. | red | Thu 9 am | 5h window: on pace for ~55% by 6:45 pm. | absent | flat | usage-settings-forecast-week-limit-desktop | 98 |
  | phone | seven_day | 100 | 2026-01-08T09:00:00Z | under at 100% | five_hour | 55 | 2026-01-01T18:45:00Z | Limit reached. The weekly window resets at Thu 9 am. | red | Thu 9 am | 5h window: on pace for ~55% by 6:45 pm. | absent | flat | usage-settings-forecast-week-limit-phone | 98 |

Scenario Outline: a weekly-only forecast opens on Week
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the normal state
  And the Usage account claude has no five-hour window
  And the Usage account claude seven_day forecast is under at 48% resetting at 2026-01-08T09:00:00Z
  When I open settings to the Usage section
  Then the Usage forecast claude selects seven_day
  And the Usage forecast claude sentence reads On pace to finish this week at ~48% (resets Thu 9 am). in neutral
  And the Usage forecast claude emphasizes ~48%
  And the Usage forecast claude other line reads absent
  And the Usage forecast claude chart has a absent crossing dot and a rising projection
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline | threshold |
  | desktop | usage-settings-forecast-week-fine-desktop | 98 |
  | phone | usage-settings-forecast-week-fine-phone | 98 |

Scenario Outline: the first crossing opens and switching updates the whole forecast
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the normal state
  And the Usage account claude five_hour forecast is runs_out at 2026-01-01T15:04:00Z resetting at 2026-01-01T15:37:00Z
  And the Usage account claude seven_day forecast is runs_out at <weekCrossing> resetting at 2026-01-08T09:00:00Z
  When I open settings to the Usage section
  Then the Usage forecast claude selects <first>
  And the Usage forecast claude sentence reads <firstSentence> in amber
  And the Usage forecast claude other line reads <firstOther>
  And the Usage forecast claude chart has a present crossing dot and a rising projection
  And the usage-settings region visually matches <baseline>-initial at <threshold> percent
  When I select the Usage forecast claude <second> window
  Then the Usage forecast claude selects <second>
  And the Usage forecast claude sentence reads <secondSentence> in amber
  And the Usage forecast claude other line reads <secondOther>
  And the Usage forecast claude chart has a present crossing dot and a rising projection
  And the usage-settings region visually matches <baseline>-switched at <threshold> percent

Examples:
  | viewport | weekCrossing | first | second | firstSentence | firstOther | secondSentence | secondOther | baseline | threshold |
  | desktop | 2026-01-06T05:00:00Z | five_hour | seven_day | At this pace the 5h limit runs out ≈ 3:04 pm, 33m before it resets. | Week: runs out ≈ Tue 5 am, 2 days before it resets. | At this pace the weekly limit runs out ≈ Tue 5 am, 2 days before it resets. | 5h window: runs out ≈ 3:04 pm, 33m before it resets. | usage-settings-forecast-five-first-desktop | 98 |
  | phone | 2026-01-06T05:00:00Z | five_hour | seven_day | At this pace the 5h limit runs out ≈ 3:04 pm, 33m before it resets. | Week: runs out ≈ Tue 5 am, 2 days before it resets. | At this pace the weekly limit runs out ≈ Tue 5 am, 2 days before it resets. | 5h window: runs out ≈ 3:04 pm, 33m before it resets. | usage-settings-forecast-five-first-phone | 98 |
  | desktop | 2026-01-01T14:55:00Z | seven_day | five_hour | At this pace the weekly limit runs out ≈ 2:55 pm, 6 days before it resets. | 5h window: runs out ≈ 3:04 pm, 33m before it resets. | At this pace the 5h limit runs out ≈ 3:04 pm, 33m before it resets. | Week: runs out ≈ 2:55 pm, 6 days before it resets. | usage-settings-forecast-week-first-desktop | 98 |
  | phone | 2026-01-01T14:55:00Z | seven_day | five_hour | At this pace the weekly limit runs out ≈ 2:55 pm, 6 days before it resets. | 5h window: runs out ≈ 3:04 pm, 33m before it resets. | At this pace the 5h limit runs out ≈ 3:04 pm, 33m before it resets. | Week: runs out ≈ 2:55 pm, 6 days before it resets. | usage-settings-forecast-week-first-phone | 98 |

Scenario Outline: switching to an under-limit window removes the crossing dot
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the normal state
  And the Usage account claude five_hour forecast is under at 55% resetting at 2026-01-01T18:45:00Z
  And the Usage account claude seven_day forecast is runs_out at 2026-01-06T05:00:00Z resetting at 2026-01-08T09:00:00Z
  When I open settings to the Usage section
  Then the Usage forecast claude selects seven_day
  And the Usage forecast claude chart has a present crossing dot and a rising projection
  When I select the Usage forecast claude five_hour window
  Then the Usage forecast claude selects five_hour
  And the Usage forecast claude sentence reads On pace to finish this 5h window at ~55% (resets 6:45 pm). in amber
  And the Usage forecast claude other line reads Week: runs out ≈ Tue 5 am, 2 days before it resets.
  And the Usage forecast claude chart has a absent crossing dot and a rising projection
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline | threshold |
  | desktop | usage-settings-forecast-switch-under-desktop | 98 |
  | phone | usage-settings-forecast-switch-under-phone | 98 |

Scenario Outline: a forecast formats the hours and minutes before reset
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the warn5 state
  And the Usage account claude five_hour forecast is runs_out at 2026-01-01T15:04:00Z resetting at 2026-01-01T16:24:00Z
  When I open settings to the Usage section
  Then the Usage forecast claude sentence reads At this pace the 5h limit runs out ≈ 3:04 pm, 1h 20m before it resets. in amber
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline | threshold |
  | desktop | usage-settings-forecast-duration-desktop | 98 |
  | phone | usage-settings-forecast-duration-phone | 98 |

Scenario Outline: early history keeps the bars without a forecast card
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the normal state
  And the Usage account claude five_hour has <count> history readings without a forecast
  And the Usage account claude seven_day has <count> history readings without a forecast
  When I open settings to the Usage section
  Then the Usage forecast claude is absent
  And the Usage single-account windows show 5h 41% and Week 22%
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | count | baseline | threshold |
  | desktop | 1 | usage-settings-forecast-one-reading-desktop | 98 |
  | phone | 1 | usage-settings-forecast-one-reading-phone | 98 |
  | desktop | 3 | usage-settings-forecast-short-history-desktop | 98 |
  | phone | 3 | usage-settings-forecast-short-history-phone | 98 |

Scenario Outline: a reached limit with early history still has a reset forecast
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the limit state
  And the Usage account claude five_hour has 1 history readings without a forecast
  When I open settings to the Usage section
  Then the Usage forecast claude selects five_hour
  And the Usage forecast claude sentence reads Limit reached. The 5h window resets at 3:13 pm. in red
  And the Usage forecast claude other line reads absent
  And the Usage forecast claude chart has a absent crossing dot and a flat projection
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline | threshold |
  | desktop | usage-settings-forecast-limit-early-desktop | 98 |
  | phone | usage-settings-forecast-limit-early-phone | 98 |

Scenario Outline: other account pace lines expand into unframed forecasts
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the normal state
  And the Usage account claude five_hour forecast is under at 74% resetting at 2026-01-01T17:30:00Z
  And the Usage account claude seven_day forecast is under at 48% resetting at 2026-01-08T09:00:00Z
  And the Usage account work five_hour forecast is under at 35% resetting at 2026-01-01T17:30:00Z
  And the Usage account work seven_day forecast is under at 70% resetting at 2026-01-03T09:00:00Z
  And the Usage account spare seven_day forecast is under at 20% resetting at 2026-01-05T09:00:00Z
  When I open settings to the Usage section
  Then the Usage forecast claude is unframed
  And the Usage account claude pace line reads absent
  And the Usage forecast work is absent
  And the Usage account work pace line reads 5h on pace for ~35% · week ~70% by Sat
  And the Usage account spare pace line reads No 5h window open · week ~20% by Mon
  And the usage-settings-card-work region visually matches <baseline>-collapsed at <threshold> percent
  When I toggle the Usage account work pace line using click
  Then the Usage forecast work is unframed
  And the Usage forecast work sentence reads On pace to finish this 5h window at ~35% (resets 5:30 pm). in neutral
  And the Usage forecast work chart has a absent crossing dot and a rising projection
  And the usage-settings-card-work region visually matches <baseline>-expanded at <threshold> percent
  When I toggle the Usage account work pace line using keyboard
  Then the Usage forecast work is absent
  When I toggle the Usage account work pace line using chevron
  Then the Usage forecast work is unframed
  When I toggle the Usage account work pace line using chevron
  Then the Usage forecast work is absent

Examples:
  | viewport | baseline | threshold |
  | desktop | usage-settings-forecast-accounts-desktop | 98 |
  | phone | usage-settings-forecast-accounts-phone | 98 |

Scenario Outline: fleet headlines describe five-hour and weekly crossings
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the normal state
  And the Usage account claude <kind> forecast is runs_out at <crossing> resetting at <reset>
  When I open settings to the Usage section
  Then the Usage settings headline reads <headline> in amber
  And the Usage headline emphasizes <firstSentence>
  And the Usage forecast claude is unframed
  And the Usage account work pace line reads absent
  And the usage-settings-headline region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | kind | crossing | reset | headline | firstSentence | baseline | threshold |
  | desktop | five_hour | 2026-01-01T15:04:00Z | 2026-01-01T15:37:00Z | Personal runs out of its 5h window ≈ 3:04 pm. Work, next in the switch order, has 88% of its 5h window left. | Personal runs out of its 5h window ≈ 3:04 pm. | usage-settings-forecast-headline-five-desktop | 98 |
  | phone | five_hour | 2026-01-01T15:04:00Z | 2026-01-01T15:37:00Z | Personal runs out of its 5h window ≈ 3:04 pm. Work, next in the switch order, has 88% of its 5h window left. | Personal runs out of its 5h window ≈ 3:04 pm. | usage-settings-forecast-headline-five-phone | 98 |
  | desktop | seven_day | 2026-01-06T05:00:00Z | 2026-01-08T09:00:00Z | Personal runs out of its week ≈ Tue 5 am, 2 days before it resets. Work has 52% of its week left, Spare 91%. | Personal runs out of its week ≈ Tue 5 am, 2 days before it resets. | usage-settings-forecast-headline-week-desktop | 98 |
  | phone | seven_day | 2026-01-06T05:00:00Z | 2026-01-08T09:00:00Z | Personal runs out of its week ≈ Tue 5 am, 2 days before it resets. Work has 52% of its week left, Spare 91%. | Personal runs out of its week ≈ Tue 5 am, 2 days before it resets. | usage-settings-forecast-headline-week-phone | 98 |

Scenario Outline: weekly crossings outrank five-hour crossings and follow switch order
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the normal state
  And the Usage account claude five_hour forecast is runs_out at 2026-01-01T15:04:00Z resetting at 2026-01-01T15:37:00Z
  And the Usage account work five_hour forecast is runs_out at 2026-01-01T15:04:00Z resetting at 2026-01-01T15:37:00Z
  And the Usage account work seven_day forecast is runs_out at 2026-01-06T05:00:00Z resetting at 2026-01-08T09:00:00Z
  And the Usage account spare seven_day forecast is runs_out at 2026-01-06T05:00:00Z resetting at 2026-01-08T09:00:00Z
  When I open settings to the Usage section
  Then the Usage settings headline reads Work runs out of its week ≈ Tue 5 am, 2 days before it resets. Personal has 78% of its week left, Spare 91%. in amber
  And the Usage account work pace line reads 5h runs out ≈ 3:04 pm · week runs out ≈ Tue 5 am
  And the Usage account spare pace line reads No 5h window open · week runs out ≈ Tue 5 am
  And the usage-settings-headline region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline | threshold |
  | desktop | usage-settings-forecast-headline-priority-desktop | 98 |
  | phone | usage-settings-forecast-headline-priority-phone | 98 |

Scenario Outline: a limited headline outranks forecast crossings
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the Usage account claude five_hour has 1 history readings without a forecast
  And the Usage account work seven_day forecast is runs_out at 2026-01-06T05:00:00Z resetting at 2026-01-08T09:00:00Z
  When I open settings to the Usage section
  Then the Usage settings headline reads Personal is limited until 3:13 pm. Work, next in the switch order, has 88% of its 5h window left. in red
  And the Usage forecast claude sentence reads Limit reached. The 5h window resets at 3:13 pm. in red
  And the usage-settings-headline region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline | threshold |
  | desktop | usage-settings-forecast-headline-limited-desktop | 98 |
  | phone | usage-settings-forecast-headline-limited-phone | 98 |

Scenario Outline: the open session account shows its forecast after a switch
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the normal state
  And the Usage account claude five_hour forecast is under at 74% resetting at 2026-01-01T17:30:00Z
  And the Usage account work five_hour forecast is under at 35% resetting at 2026-01-01T17:30:00Z
  And the session resumes on work from claude by user and replies Continued on Work.
  When I open settings to the Usage section
  Then the Usage forecast work is unframed
  And the Usage forecast claude is absent
  And the Usage account claude pace line reads 5h on pace for ~74%
  And the Usage account work pace line reads absent
  And the usage-settings-card-work region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline | threshold |
  | desktop | usage-settings-forecast-session-account-desktop | 98 |
  | phone | usage-settings-forecast-session-account-phone | 98 |

Scenario Outline: a forecast with no eligible successor omits the recommendation
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the normal state
  And the Usage account work is unavailable
  And the Usage account spare is unavailable
  And the Usage account claude five_hour forecast is runs_out at 2026-01-01T15:04:00Z resetting at 2026-01-01T15:37:00Z
  When I open settings to the Usage section
  Then the Usage settings headline reads Personal runs out of its 5h window ≈ 3:04 pm. in amber
  And the Usage headline emphasizes Personal runs out of its 5h window ≈ 3:04 pm.
  And the usage-settings-headline region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline | threshold |
  | desktop | usage-settings-forecast-no-successor-desktop | 98 |
  | phone | usage-settings-forecast-no-successor-phone | 98 |

Scenario Outline: a secondary limited account keeps its reset forecast without a pace line
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the normal state
  And the Usage account claude five_hour forecast is under at 74% resetting at 2026-01-01T17:30:00Z
  And the usage footer work five_hour reading is 100% resetting at 2026-01-01T15:13:00Z
  And the Usage account work five_hour has 1 history readings without a forecast
  When I open settings to the Usage section
  Then the Usage forecast claude is unframed
  And the Usage forecast work is unframed
  And the Usage account work pace line reads absent
  And the Usage forecast work sentence reads Limit reached. The 5h window resets at 3:13 pm. in red
  And the Usage forecast work chart has a absent crossing dot and a flat projection
  And the usage-settings-card-work region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline | threshold |
  | desktop | usage-settings-forecast-secondary-limited-desktop | 98 |
  | phone | usage-settings-forecast-secondary-limited-phone | 98 |

Scenario Outline: an unconfigured session account falls back to the fullest account
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the normal state
  And the Claude accounts are work as Work, spare as Spare
  And the usage footer spare seven_day reading is 97% resetting at 2026-01-08T09:00:00Z
  And the Usage account work five_hour forecast is under at 35% resetting at 2026-01-01T17:30:00Z
  And the Usage account spare seven_day forecast is under at 98% resetting at 2026-01-08T09:00:00Z
  When I open settings to the Usage section
  Then the Usage forecast <primary> is unframed
  And the Usage account <primary> pace line reads absent
  And the Usage forecast <secondary> is absent
  And the Usage account <secondary> pace line reads <pace>
  And the usage-settings-card-<primary> region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | primary | secondary | pace | baseline | threshold |
  | desktop | spare | work | 5h on pace for ~35% | usage-settings-forecast-fullest-fallback-desktop | 98 |
  | phone | spare | work | 5h on pace for ~35% | usage-settings-forecast-fullest-fallback-phone | 98 |

Feature: Settings Usage is the home for Claude plan usage and limit recovery

Background:
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the Usage settings clock is pinned to 2026-01-01T14:25:00Z

Scenario Outline: one account has full window rows on desktop
  Given the viewport is a desktop
  And Usage settings have one Claude account in the <state> state
  When I open settings to the Usage tab
  Then the Usage settings title reads Claude plan usage
  And the settings tabs place Usage between Claude and Instances
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
  When I open settings to the Usage tab
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
  When I open settings to the Usage tab
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
  When I open settings to the Usage tab
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

Scenario: a single account with no five-hour window still has its weekly usage
  Given the viewport is a desktop
  And Usage settings have one Claude account in the normal state
  And the Usage account claude has no five-hour window
  When I open settings to the Usage tab
  Then the Usage single-account windows show 5h — and Week 22%
  And the Usage single-account five_hour reset reads no window open
  And the Usage single-account seven_day reset reads resets Thu 9 am

Scenario: a limit without a reset time does not invent a reset
  Given the viewport is a desktop
  And Usage settings have one Claude account in the limit state
  When the usage footer claude five_hour reading is 100% resetting at none
  And I open settings to the Usage tab
  Then the Usage single-account five_hour reset reads limit reached

Scenario: the reached five-hour limit binds even when the weekly window warns
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the limit state
  When the usage footer claude seven_day reading is 91% resetting at 2026-01-08T09:00:00Z
  And I open settings to the Usage tab
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
  When I open settings to the Usage tab
  Then the Usage settings headline reads Personal is limited until 3:13 pm. in red

Scenario: the recommendation follows the saved switch order and skips unavailable accounts
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the limit state
  And the Usage account work is unavailable
  When I open settings to the Usage tab
  Then the Usage settings headline reads Personal is limited until 3:13 pm. Spare, next in the switch order, has 100% of its 5h window left. in red

Scenario Outline: warning thresholds are saved, survive reload and change the desktop footer
  Given the viewport is a desktop
  And Usage settings have one Claude account in the warn5 state
  When I open settings to the Usage tab
  And I select the Usage warning choice <initial>
  And I select the Usage warning choice <choice>
  Then the SetUsageLimitsSetting RPC saves warnAt <choice>
  And the Usage warning choice <choice> is selected
  When I reload the app and open the Usage tab
  Then the Usage warning choice <choice> is selected
  When I close settings
  Then the usage footer claude five_hour level is <level> with an <fill> bar

Examples:
  | initial | choice | level   | fill   |
  | 90      | 70     | warning | amber  |
  | 90      | 80     | warning | amber  |
  | 70      | 90     | normal  | normal |
  | 90      | off    | normal  | amber  |

Scenario Outline: phone chips use the saved warning threshold
  Given the viewport is a phone
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list
  And Usage settings have several Claude accounts in the warn5 state
  When I open settings to the Usage tab
  And I select the Usage warning choice <initial>
  And I select the Usage warning choice <choice>
  Then the SetUsageLimitsSetting RPC saves warnAt <choice>
  When I close settings
  And I tap back to the session list
  Then the phone usage chip claude shows 5h 86% at level <level>

Examples:
  | initial | choice | level |
  | 90      | 70     | warn  |
  | 90      | 80     | warn  |
  | 70      | 90     | ok    |
  | 90      | off    | ok    |

Scenario Outline: desktop card dragging saves and replays the switch order
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the normal state
  When I open settings to the Usage tab
  And I drag the Usage account Spare above Personal
  Then the account order reads Spare, Personal, Work
  And the SetUsageLimitsSetting RPC saves auto-resume off, auto-switch off, order spare, claude, work
  When I reload the app and open the Usage tab
  Then the account order reads Spare, Personal, Work
  And the usage-settings region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                          | threshold |
  | usage-settings-reordered-desktop | 98        |

Scenario: the card handle supports ArrowUp and ArrowDown without pickup
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the normal state
  When I open settings to the Usage tab
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
  When I open settings to the Usage tab
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
  When I open settings to the Usage tab
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
  When I open settings to the Usage tab
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
  When I open settings to the Usage tab
  Then the Usage settings subheader reads 3 accounts · updated 2m ago · Refresh all
  When I press Refresh all in Usage settings
  Then the QuotaForAccounts RPC refreshes the attached project
  And the Usage account claude status reads week 91% in amber
  And the Usage settings subheader reads 3 accounts · updated just now · Refresh all

Scenario: the desktop footer opens the Usage tab directly
  Given the viewport is a desktop
  And Usage settings have one Claude account in the normal state
  When I click the desktop usage footer
  Then the Usage settings title reads Claude plan usage
  And the Usage settings subheader reads Claude Max · updated 2m ago · Refresh

Scenario: a phone usage chip opens Usage without stopping list scrolling
  Given the viewport is a phone
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list
  And Usage settings have several Claude accounts in the normal state
  When I tap back to the session list
  Then the phone usage footer allows list scrolling around its chips
  When I tap the phone usage chip claude
  Then the Usage settings title reads Usage
  And the phone Usage screen fills the viewport and has a scrolling body and a back button
  When I press the Usage back button
  Then the settings tabs place Usage between Claude and Instances

Scenario: the phone single-account row opens Usage directly
  Given the viewport is a phone
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list
  And Usage settings have one Claude account in the normal state
  When I tap back to the session list
  And I tap the phone single-account usage row
  Then the Usage settings title reads Usage
  And the Usage settings subheader reads Claude Max · updated 2m ago · Refresh

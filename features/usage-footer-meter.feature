Feature: Desktop sidebar footer shows live plan usage for each account

Scenario Outline: one account shows the design's usage states
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has one Claude account in the <state> state
  Then the usage footer is pinned below the session list
  And the single usage footer shows 5h <fiveHour> and Week <week>
  And the usage footer claude five_hour meter is <fiveHourLevel> at <fiveHourUsed> percent
  And the usage footer claude seven_day meter is <weekLevel> at <weekUsed> percent
  And the single usage footer bars are 26px and 26px wide
  And the sidebar region visually matches <baseline> at <threshold> percent

Examples:
  | state  | fiveHour | week | fiveHourLevel | weekLevel | fiveHourUsed | weekUsed | baseline                           | threshold |
  | normal | 41%      | 22%  | normal        | normal    | 41           | 22       | usage-footer-normal-desktop         | 98        |
  | warn5  | 86%      | 58%  | warning       | normal    | 86           | 58       | usage-footer-five-hour-warning      | 98        |
  | warnWk | 30%      | 91%  | normal        | warning   | 30           | 91       | usage-footer-week-warning           | 98        |
  | limit  | 3:13     | 71%  | danger        | normal    | 100          | 71       | usage-footer-at-limit-desktop       | 98        |

Scenario Outline: one account without plan windows has no footer row
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has one Claude account in the none state
  Then the usage footer is not visible
  And the sidebar region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                      | threshold |
  | usage-footer-no-data-desktop   | 98        |

Scenario: a live reading updates the existing footer
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has one Claude account in the normal state
  Then the single usage footer shows 5h 41% and Week 22%
  When the usage footer receives the warn5 reading
  Then the single usage footer shows 5h 86% and Week 58%
  And the usage footer claude five_hour meter is warning at 86 percent
  And the SubscribeUsage RPC has no project payload

Scenario: usage values stay visible while tab focus re-reads them
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has one Claude account in the normal state
  Then the single usage footer shows 5h 41% and Week 22%
  Given the next tab focus usage reading is held
  When I return to the conduit tab
  Then tab focus has requested one usage re-read
  And the single usage footer shows 5h 41% and Week 22%
  And the usage footer claude five_hour meter is normal at 41 percent
  When I return to the conduit tab
  Then tab focus has requested one usage re-read
  And the single usage footer shows 5h 41% and Week 22%
  When the tab focus usage re-read completes with the warn5 reading
  Then the single usage footer shows 5h 86% and Week 58%

Scenario Outline: accounts follow auto-switch order inside their harness groups
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has several accounts with an <status> Claude reading
  Then the usage footer is pinned below the session list
  And the usage footer groups read Claude, Codex, Cursor in that order
  And the Claude usage footer rows read Personal, Work, Spare, Unreadable in auto-switch order
  And the usage footer claude row is the highlighted current account
  And the usage footer claude badge matches the composer account badge
  And the usage footer account claude shows a claude logo with badge P
  And the usage footer account work shows a claude logo with badge W
  And the usage footer account unreadable shows a claude logo with badge U
  And the usage footer account chatgpt shows an opencode logo with badge C
  And the usage footer account cursor shows a cursor logo without a badge
  And the usage footer names for claude, work, chatgpt, cursor are left-aligned
  And the usage footer claude shows five_hour 41% and seven_day 22%
  And the usage footer work shows five_hour 12% and seven_day 48%
  And the usage footer spare shows five_hour 0% and seven_day 9%
  And the usage footer unreadable shows five_hour — and seven_day —
  And the Claude usage footer headings read 5h and Week
  And the Codex usage footer headings read 5h and Week
  And the usage footer chatgpt shows five_hour 30% and seven_day 64%
  And the Cursor usage footer heading reads Month
  And the usage footer cursor month window reads 38% and spans both columns
  And the usage footer omits accounts without a quota source
  And the sidebar region visually matches <baseline> at <threshold> percent

Examples:
  | status      | baseline                         | threshold |
  | unknown     | usage-footer-multiple-desktop     | 98        |
  | unavailable | usage-footer-multiple-desktop     | 98        |

Scenario: the highlighted account follows the new session draft's pick
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has several accounts with an unknown Claude reading
  When I pick work for a new session draft
  Then the usage footer work row is the highlighted current account

Scenario Outline: the minimum sidebar width hides the second window without clipping
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has several accounts with an unknown Claude reading
  When I resize the sidebar to its 180px minimum
  Then the usage footer second window columns are hidden
  And the usage footer claude five_hour meter is normal at 41 percent
  And the usage footer cursor month value reads 38%
  And the usage footer has no horizontal clipping
  And the sidebar region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                       | threshold |
  | usage-footer-minimum-desktop     | 98        |

Scenario: one account also fits the minimum sidebar width
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has one Claude account in the normal state
  When I resize the sidebar to its 180px minimum
  Then the usage footer claude five_hour value reads 41%
  And the usage footer claude seven_day cell is not visible
  And the usage footer has no horizontal clipping

Scenario: grouped limit values remain compact and fit at either sidebar width
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has several accounts with an unknown Claude reading
  When the usage footer claude five_hour reading is 100% resetting at 2026-01-02T12:13:00Z
  And the usage footer work seven_day reading is 100% resetting at 2026-01-05T09:00:00Z
  Then the usage footer claude five_hour value reads 12:13
  And the usage footer claude five_hour meter is danger at 100 percent
  And the usage footer work seven_day value reads 100%
  And the usage footer work seven_day meter is danger at 100 percent
  And the usage footer has no horizontal clipping
  When I resize the sidebar to its 180px minimum
  Then the usage footer claude five_hour value reads 12:13
  And the usage footer claude five_hour meter is danger at 100 percent
  And the usage footer has no horizontal clipping

Scenario: a five-hour limit without its reset time keeps a percentage
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has one Claude account in the limit state
  When the usage footer claude five_hour reading is 100% resetting at none
  Then the single usage footer shows 5h 100% and Week 71%
  And the usage footer claude five_hour meter is warning at 100 percent
  And the usage footer has no horizontal clipping

Scenario: account buttons change only the new-session default
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has several accounts with an unknown Claude reading
  Then the desktop meter marks claude as default instead of work
  When I make claude the default from the desktop meter
  Then the meter has sent 0 SetDefault requests for claude
  When I make work the default from the desktop meter
  Then the meter has sent 1 SetDefault requests for work
  And the desktop meter marks work as default instead of claude
  And the usage footer claude row is the highlighted current account
  And the usage composer still selects claude
  When I make work the default from the desktop meter
  Then the meter has sent 1 SetDefault requests for work
  When I open Usage settings from the desktop meter
  And I open settings to the Server section
  Then only the Work Claude account has the default marker

Scenario: managed defaults offer no account button
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has several accounts with an unknown Claude reading
  Then the desktop meter row chatgpt is not a button

Scenario: a failed default change shows a toast and keeps the marker
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has several accounts with an unknown Claude reading
  Given changing the usage meter default fails
  When I make work the default from the desktop meter
  Then the usage meter default failure toast is visible
  And the desktop meter marks claude as default instead of work

Scenario: an untouched draft follows the meter default
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has several accounts with an unknown Claude reading
  When I open an untouched usage draft
  Then the usage composer still selects claude
  When I make work the default from the desktop meter
  Then the usage composer still selects work
  And the usage footer work row is the highlighted current account

Scenario: an explicit draft account survives a meter default change
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has several accounts with an unknown Claude reading
  When I pick spare for a new session draft
  And I make work the default from the desktop meter
  Then the usage composer still selects spare
  And the usage footer spare row is the highlighted current account
  And the desktop meter marks work as default instead of claude

Scenario: changing a Cursor default preserves the Claude default
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has a Claude account and a hidden Cursor account named Team
  When I make hidden the default from the desktop meter
  Then the meter has sent 1 SetDefault requests for hidden
  And the desktop meter marks hidden as default
  And the desktop meter marks claude as default

Scenario Outline: the footer handle folds the accounts that need no attention, like the phone dock
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has several accounts with an unknown Claude reading
  Then the usage footer shows every account
  When I drag the usage footer handle down by 120 pixels
  Then the usage footer is folded to the claude row with +5 more
  And the sidebar region visually matches <baseline> at <threshold> percent
  When I drag the usage footer handle up by 120 pixels
  Then the usage footer shows every account
  When I click the usage footer handle
  Then the usage footer is folded to the claude row with +5 more
  When I click the usage footer more summary
  Then the usage footer shows every account

Examples:
  | baseline                    | threshold |
  | usage-footer-folded-desktop | 98        |

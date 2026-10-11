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
  And the single usage footer bars are 40px and 36px wide
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

Scenario Outline: accounts follow auto-switch order inside their harness groups
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the usage footer has several accounts with an <status> Claude reading
  Then the usage footer is pinned below the session list
  And the usage footer groups read CLAUDE, CODEX, CURSOR in that order
  And the Claude usage footer rows read Personal, Work, Spare, Unreadable in auto-switch order
  And the usage footer claude row is the highlighted current account
  And the usage footer claude dot matches the session account pill
  And the usage footer claude shows five_hour 41% and seven_day 22%
  And the usage footer work shows five_hour 12% and seven_day 48%
  And the usage footer spare shows five_hour 0% and seven_day 9%
  And the usage footer unreadable shows five_hour — and seven_day —
  And the Claude usage footer headings read 5H and WEEK
  And the Codex usage footer headings read 5H and WEEK
  And the usage footer chatgpt shows five_hour 30% and seven_day 64%
  And the Cursor usage footer heading reads MONTH
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
  And the usage footer claude five_hour meter is danger at 100 percent
  And the usage footer has no horizontal clipping

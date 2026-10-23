Feature: Phone session list docks the live plan usage meter

Background:
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list

Scenario Outline: normal accounts dock the current account's row and fold the rest
  Given the usage footer has several accounts with an unknown Claude reading
  When I tap back to the session list
  Then the session list is open
  And the phone usage rows are claude in that order
  And the phone usage row claude is the highlighted current account
  And the usage footer account claude shows a claude logo with badge P
  And the usage footer claude shows five_hour 41% and seven_day 22%
  And the phone usage footer folds 5 more accounts
  And the phone usage footer clears the new-session button and the last row text
  And the sidebar region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                     | threshold |
  | usage-footer-multiple-phone  | 98        |

Scenario Outline: a warning account docks its own row with both windows
  Given the usage footer has several accounts with an unknown Claude reading
  When the usage footer work five_hour reading is 86% resetting at none
  And the usage footer work seven_day reading is <week>% resetting at none
  And I tap back to the session list
  Then the session list is open
  And the phone usage rows are claude, work in that order
  And the phone usage row claude is the highlighted current account
  And the usage footer work shows five_hour 86% and seven_day <week>%
  And the usage footer work <window> meter is warning at <used> percent
  And the phone usage footer folds 4 more accounts
  And the phone usage footer clears the new-session button and the last row text
  And the sidebar region visually matches <baseline> at <threshold> percent

Examples:
  | week | window    | used | baseline                         | threshold |
  | 48   | five_hour | 86   | usage-footer-warning-phone       | 98        |
  | 91   | seven_day | 91   | usage-footer-week-warning-phone  | 98        |

Scenario Outline: a limited default shows its compact reset time
  Given the usage footer has several accounts with an unknown Claude reading
  When the usage footer claude five_hour reading is 100% resetting at 2026-01-01T15:13:00Z
  And I tap back to the session list
  Then the session list is open
  And the phone usage rows are claude in that order
  And the phone usage row claude is the highlighted current account
  And the usage footer claude shows five_hour 3:13 and seven_day 22%
  And the usage footer claude five_hour meter is danger at 100 percent
  And the phone usage footer folds 5 more accounts
  And the phone usage footer clears the new-session button and the last row text
  And the sidebar region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                     | threshold |
  | usage-footer-at-limit-phone  | 98        |

Scenario Outline: tapping the dock opens every account's meter in a sheet
  Given the usage footer has several accounts with an unknown Claude reading
  When the usage footer work five_hour reading is 86% resetting at none
  And I tap back to the session list
  And I open the phone usage sheet
  Then the usage sheet groups read Claude, Codex, Cursor with rows claude, work, spare, unreadable, chatgpt, cursor
  And the usage sheet row claude is the highlighted current account
  And the usage sheet work shows five_hour 86% and seven_day 48%
  And the usage sheet chatgpt shows five_hour 30% and seven_day 64%
  And the usage sheet account claude shows a claude logo with badge P
  And the usage sheet account work shows a claude logo with badge W
  And the usage sheet account chatgpt shows a codex logo without a badge
  And the usage sheet account cursor shows a cursor logo without a badge
  And the usage sheet names for claude, work, chatgpt, cursor are left-aligned
  And the screen region visually matches <baseline> at <threshold> percent
  When I tap Settings in the usage sheet
  Then the usage sheet is closed and Usage settings are open

Examples:
  | baseline                  | threshold |
  | usage-footer-sheet-phone  | 98        |

Scenario: the dock pulls up into the sheet and the sheet drags back down
  Given the usage footer has several accounts with an unknown Claude reading
  When I tap back to the session list
  And I drag the phone usage dock up by 60 pixels
  Then the usage sheet is open
  When I drag the usage sheet down by 200 pixels
  Then the usage sheet is closed
  When I drag the phone usage dock up by 60 pixels
  Then the usage sheet is open

Scenario: the usage sheet rises under the finger pulling the dock
  Given the usage footer has several accounts with an unknown Claude reading
  When I tap back to the session list
  Then the usage sheet follows my finger up the phone usage dock
  And the usage sheet is open

Scenario: the usage sheet folds back to the top of the raised dock
  Given the usage footer has several accounts with an unknown Claude reading
  When I tap back to the session list
  And I drag the phone usage dock up by 120 pixels
  Then the usage sheet is open
  And the usage sheet uses the shared sheet surface
  And the phone usage dock uses the sidebar surface
  And the usage sheet dragged down past the phone usage dock lands at its top
  And the usage sheet is closed

Scenario Outline: one account uses inline windows without the sheet
  Given the usage footer has one Claude account in the <state> state
  When I tap back to the session list
  Then the session list is open
  And the single phone usage footer shows 5h <fiveHour> and Week <week>
  And the usage footer claude five_hour meter is <fiveHourLevel> at <fiveHourUsed> percent
  And the usage footer claude seven_day meter is <weekLevel> at <weekUsed> percent
  And the phone usage footer clears the new-session button and the last row text
  And the sidebar region visually matches <baseline> at <threshold> percent

Examples:
  | state  | fiveHour | week | fiveHourLevel | weekLevel | fiveHourUsed | weekUsed | baseline                          | threshold |
  | normal | 41%      | 22%  | normal        | normal    | 41           | 22       | usage-footer-single-phone         | 98        |
  | warn5  | 86%      | 58%  | warning       | normal    | 86           | 58       | usage-footer-single-warning-phone | 98        |
  | warnWk | 30%      | 91%  | normal        | warning   | 30           | 91       | usage-footer-single-week-phone    | 98        |
  | limit  | 3:13     | 71%  | danger        | normal    | 100          | 71       | usage-footer-single-limit-phone   | 98        |

Scenario Outline: one account without plan data hides the phone footer
  Given the usage footer has one Claude account in the none state
  When I tap back to the session list
  Then the session list is open
  And the phone usage footer is not visible
  And the sidebar region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                    | threshold |
  | usage-footer-no-data-phone  | 98        |

Scenario: the docked row follows the new session draft's pick and can show dashes
  Given the usage footer has several accounts with an unknown Claude reading
  When I pick unreadable for a new session draft
  And I tap back to the session list
  Then the session list is open
  And the phone usage rows are unreadable in that order
  And the phone usage row unreadable is the highlighted current account
  And the usage footer unreadable shows five_hour — and seven_day —
  And the phone usage footer folds 5 more accounts
  And the phone usage footer clears the new-session button and the last row text

Scenario: live readings dock warning accounts from other harnesses in account order
  Given the usage footer has several accounts with an unknown Claude reading
  When I tap back to the session list
  Then the session list is open
  When the usage footer chatgpt seven_day reading is 91% resetting at none
  And the usage footer spare five_hour reading is 86% resetting at none
  And the usage footer work five_hour reading is 86% resetting at none
  Then the phone usage rows are claude, work, spare, chatgpt in that order
  And the usage footer chatgpt seven_day meter is warning at 91 percent
  And the phone usage footer folds 2 more accounts
  And the phone usage footer clears the new-session button and the last row text
  And the SubscribeUsage RPC has no project payload

Scenario Outline: one folded account names its provider
  Given the usage footer has a Claude account and a hidden <provider> account named <account>
  When I tap back to the session list
  Then the phone usage rows are claude in that order
  And the phone usage footer labels the hidden account "+1 <provider> account"
  And the sidebar region visually matches <baseline> at <threshold> percent
  When I open the phone usage sheet
  Then the usage sheet shows the hidden account named <account>

Examples:
  | provider | account  | baseline                         | threshold |
  | Codex    | Personal | usage-footer-hidden-codex-phone   | 98        |
  | Claude   | Work     | usage-footer-hidden-claude-phone  | 98        |
  | Cursor   | Team     | usage-footer-hidden-cursor-phone  | 98        |

Scenario: sheet account buttons change the default and the untouched draft follows
  Given the usage footer has several accounts with an unknown Claude reading
  When I tap back to the session list
  And I open the phone usage sheet
  Then the phone sheet marks claude as default instead of work
  And the phone sheet row chatgpt is not a button
  When I make claude the default from the phone sheet
  Then the meter has sent 0 SetDefault requests for claude
  When I make work the default from the phone sheet
  Then the meter has sent 1 SetDefault requests for work
  And the phone sheet marks work as default instead of claude
  And the usage sheet row work is the highlighted current account
  When I make work the default from the phone sheet
  Then the meter has sent 1 SetDefault requests for work
  When I tap Settings in the usage sheet
  Then the usage sheet is closed and Usage settings are open

Scenario: a failed sheet default change shows a toast
  Given the usage footer has several accounts with an unknown Claude reading
  When I tap back to the session list
  And I open the phone usage sheet
  Given changing the usage meter default fails
  When I make work the default from the phone sheet
  Then the usage meter default failure toast is visible
  And the phone sheet marks claude as default instead of work

Scenario: a Cursor sheet button changes only its harness default
  Given the usage footer has a Claude account and a hidden Cursor account named Team
  When I tap back to the session list
  And I open the phone usage sheet
  And I make hidden the default from the phone sheet
  Then the meter has sent 1 SetDefault requests for hidden
  And the phone sheet marks hidden as default
  And the phone sheet marks claude as default

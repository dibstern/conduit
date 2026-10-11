Feature: Phone session list shows compact live plan usage

Background:
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the session list has 24 rows for usage footer clearance
  And I open "Usage footer session 1" from the phone session list

Scenario Outline: normal accounts collapse to the current account and a count
  Given the usage footer has several accounts with an unknown Claude reading
  When I tap back to the session list
  Then the session list is open
  And the phone usage chips are claude in that order
  And the phone usage chip claude is the highlighted current account
  And the phone usage chip claude shows 5h 41% at level ok
  And the phone usage footer counts 5 remaining accounts
  And the phone usage footer clears the new-session button and the last row text
  And the sidebar region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                     | threshold |
  | usage-footer-multiple-phone  | 98        |

Scenario Outline: warning accounts get chips with the binding window
  Given the usage footer has several accounts with an unknown Claude reading
  When the usage footer work five_hour reading is 86% resetting at none
  And the usage footer work seven_day reading is <week>% resetting at none
  And I tap back to the session list
  Then the session list is open
  And the phone usage chips are claude, work in that order
  And the phone usage chip claude is the highlighted current account
  And the phone usage chip work shows <window> <value> at level warn
  And the phone usage footer counts 4 remaining accounts
  And the phone usage footer clears the new-session button and the last row text
  And the sidebar region visually matches <baseline> at <threshold> percent

Examples:
  | week | window | value | baseline                         | threshold |
  | 48   | 5h     | 86%   | usage-footer-warning-phone       | 98        |
  | 91   | wk     | 91%   | usage-footer-week-warning-phone  | 98        |

Scenario Outline: a limited default shows its compact reset time
  Given the usage footer has several accounts with an unknown Claude reading
  When the usage footer claude five_hour reading is 100% resetting at 2026-01-01T03:13:00Z
  And I tap back to the session list
  Then the session list is open
  And the phone usage chips are claude in that order
  And the phone usage chip claude is the highlighted current account
  And the phone usage chip claude shows 5h 3:13 at level limited
  And the phone usage footer counts 5 remaining accounts
  And the phone usage footer clears the new-session button and the last row text
  And the sidebar region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                     | threshold |
  | usage-footer-at-limit-phone  | 98        |

Scenario Outline: one account uses inline windows without chips
  Given the usage footer has one Claude account in the <state> state
  When I tap back to the session list
  Then the session list is open
  And the single phone usage footer shows 5h <fiveHour> and Wk <week>
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

Scenario: the default uses the fuller window even when both windows warn
  Given the usage footer has several accounts with an unknown Claude reading
  When the usage footer claude five_hour reading is 92% resetting at none
  And the usage footer claude seven_day reading is 91% resetting at none
  And I tap back to the session list
  Then the session list is open
  And the phone usage chip claude shows 5h 92% at level warn
  And the phone usage footer counts 5 remaining accounts

Scenario: the first chip follows the new session draft's pick and can show a dash
  Given the usage footer has several accounts with an unknown Claude reading
  When I pick unreadable for a new session draft
  And I tap back to the session list
  Then the session list is open
  And the phone usage chips are unreadable in that order
  And the phone usage chip unreadable is the highlighted current account
  And the phone usage chip unreadable shows none — at level unknown
  And the phone usage footer counts 5 remaining accounts
  And the phone usage footer clears the new-session button and the last row text

Scenario: live readings include warning accounts from other harnesses in account order
  Given the usage footer has several accounts with an unknown Claude reading
  When I tap back to the session list
  Then the session list is open
  When the usage footer chatgpt seven_day reading is 91% resetting at none
  And the usage footer spare five_hour reading is 86% resetting at none
  And the usage footer work five_hour reading is 86% resetting at none
  Then the phone usage chips are claude, work, spare, chatgpt in that order
  And the phone usage chip chatgpt shows wk 91% at level warn
  And the phone usage footer counts 2 remaining accounts
  And the phone usage footer clears the new-session button and the last row text
  And the SubscribeUsage RPC has no project payload

Feature: A limited session shows the limit strip and tags the cut-off message

Scenario Outline: desktop limit strip names the account, the limit and its reset
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the <limit> limit on <account> resetting at <resets>
  Then the usage limit strip sits directly above the composer
  And the usage limit strip title reads <title>
  And the usage limit strip detail reads <detail>
  And the cut-off tag under Now run the provider tests reads ⏸ Cut off by usage limit · Dismiss

Examples:
  | limit      | account | resets               | title                                | detail                          |
  | seven_day  | claude  | 2026-01-05T09:00:00Z | Usage limit reached · work2claude    | Weekly limit · resets Mon 9:00  |
  | five_hour  | claude  | 2026-01-01T14:30:00Z | Usage limit reached · work2claude    | 5-hour limit · resets 14:30     |
  | seven_day  | claude  | none                 | Usage limit reached · work2claude    | Reset time unavailable          |
  | five_hour  | retired | 2026-01-01T14:30:00Z | Usage limit reached · retired        | 5-hour limit · resets 14:30     |

Scenario Outline: phone limit strip folds the account into the detail line
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the <limit> limit on claude resetting at <resets>
  Then the usage limit strip sits directly above the composer
  And the usage limit strip title reads Usage limit reached
  And the usage limit strip detail reads <detail>
  And the cut-off tag under Now run the provider tests reads ⏸ Cut off · Dismiss

Examples:
  | limit     | resets               | detail                                     |
  | seven_day | 2026-01-05T09:00:00Z | work2claude · resets Mon 9:00              |
  | five_hour | 2026-01-01T14:30:00Z | work2claude · resets 14:30                 |
  | seven_day | none                 | work2claude · reset time unavailable       |

Scenario Outline: Dismiss clears the cut-off tag and leaves the strip
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  And I press Dismiss on the cut-off tag
  Then the DismissCutOff RPC names the current session
  When the server clears the cut-off
  Then the cut-off tag is not visible
  And the usage limit strip is visible

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario: A reply clears both the strip and the tag
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  Then the usage limit strip is visible
  And the cut-off tag is visible
  When a reply clears the usage limit
  Then the usage limit strip is not visible
  And the cut-off tag is not visible

Scenario Outline: desktop limited session matches frame A
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  Then the usage limit strip is visible
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                  | threshold |
  | usage-limit-strip-desktop | 98        |

Scenario Outline: phone limited session matches frame A
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  Then the usage limit strip is visible
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                | threshold |
  | usage-limit-strip-phone | 98        |

Scenario Outline: a strip without a reset time offers Try again on the same account
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at none
  Then the usage limit strip shows Try again
  When I press Try again on the usage limit strip
  Then the ContinueSession RPC continues the current session on claude now
  When the server starts the continuation
  Then the usage limit strip has no Try again
  And the usage limit strip is visible

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario: a strip with a reset time offers no Try again
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  Then the usage limit strip has no Try again

Scenario Outline: a session that resumed keeps a divider above the reply
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at none
  And the session resumes on claude by user and replies All provider tests pass now.
  Then the usage limit strip is not visible
  And the transcript divider reading ↻ Resumed on work2claude · retried by you sits directly above the reply All provider tests pass now.

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: limited session without a reset time matches the no-reset strip
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at none
  Then the usage limit strip shows Try again
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                           | threshold |
  | desktop  | usage-limit-strip-no-reset-desktop | 98        |
  | phone    | usage-limit-strip-no-reset-phone   | 98        |

Scenario Outline: resumed session matches frame F
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at none
  And the session resumes on claude by user and replies All provider tests pass now.
  Then the usage limit strip is not visible
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                        | threshold |
  | desktop  | usage-limit-resumed-desktop     | 98        |
  | phone    | usage-limit-resumed-phone       | 98        |

Scenario Outline: Resume at reset schedules the resume and Cancel auto-resume undoes it
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  Then the usage limit strip is limited
  And the usage limit strip shows Resume at reset
  When I press Resume at reset on the usage limit strip
  Then the ContinueSession RPC continues the current session on claude at 2026-01-05T09:00:00Z
  When the server schedules the resume at reset
  Then the usage limit strip is waiting
  And the usage limit strip title reads <title>
  And the usage limit strip detail reads <detail>
  And the usage limit strip has no Resume at reset
  And the usage limit strip shows Cancel auto-resume
  When I press Cancel auto-resume on the usage limit strip
  Then the CancelContinuation RPC names the current session
  When the server cancels the resume at reset
  Then the usage limit strip is limited
  And the usage limit strip shows Resume at reset
  And the usage limit strip has no Cancel auto-resume

Examples:
  | viewport | title                                | detail                       |
  | desktop  | Resumes on work2claude at Mon 9:00   | in 3d 23h                    |
  | phone    | Resumes Mon 9:00                     | work2claude · in 3d 23h      |

Scenario Outline: a session that resumed at reset keeps a divider with the reset time
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-01T09:40:00Z
  And the session resumes on claude by reset and replies All provider tests pass now.
  Then the usage limit strip is not visible
  And the transcript divider reading ↻ Resumed on work2claude after reset · 9:40 sits directly above the reply All provider tests pass now.

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: waiting session matches frame E
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  And the server schedules the resume at reset
  Then the usage limit strip is waiting
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                        | threshold |
  | desktop  | usage-limit-waiting-desktop     | 98        |
  | phone    | usage-limit-waiting-phone       | 98        |

Scenario Outline: session resumed at reset matches frame F
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-01T09:40:00Z
  And the session resumes on claude by reset and replies All provider tests pass now.
  Then the usage limit strip is not visible
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                           | threshold |
  | desktop  | usage-limit-reset-resumed-desktop  | 98        |
  | phone    | usage-limit-reset-resumed-phone    | 98        |

Scenario Outline: a resume the limit policy scheduled is waiting and says auto-resume is on
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude account claude is named work2claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  And the limit policy schedules the resume at reset
  Then the usage limit strip is waiting
  And the usage limit strip title reads <title>
  And the usage limit strip detail reads <detail>
  And the usage limit strip has no Resume at reset
  And the usage limit strip shows Cancel auto-resume
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | title                              | detail                                      | baseline                         | threshold |
  | desktop  | Resumes on work2claude at Mon 9:00 | in 3d 23h · auto-resume is on               | usage-limit-auto-waiting-desktop | 98        |
  | phone    | Resumes Mon 9:00                   | work2claude · in 3d 23h · auto-resume is on | usage-limit-auto-waiting-phone   | 98        |

Scenario Outline: Switch account lists each account's fresh quota and pre-selects the most headroom
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal, team as team-max
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  And the quota check reads claude limited until 2026-01-05T09:00:00Z, self <quota>, team limited until 2026-01-01T14:30:00Z
  And I open Switch account on the usage limit strip
  Then the account picker row for personal reads <caption> and can be picked
  And the account picker row for work2claude reads limited · Mon 9:00 and cannot be picked
  And the account picker row for team-max reads limited · 14:30 and cannot be picked
  And the account picker pre-selects personal
  And the account picker shows claude with a blue dot
  And the account picker shows self with a teal dot
  And the account picker shows team with a violet dot

Examples:
  | viewport | quota       | caption       |
  | desktop  | 23% used    | 77% left      |
  | desktop  | 85% used    | 15% left      |
  | desktop  | unknown     | quota unknown |
  | phone    | 23% used    | 77% left      |
  | phone    | unavailable | unavailable   |

Scenario Outline: switching confirms what carries over, hands the session over and marks the transcript
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal, team as team-max
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  And the quota check reads claude limited until 2026-01-05T09:00:00Z, self 23% used, team limited until 2026-01-01T14:30:00Z
  And the handoff carries 47 of 112 messages with the first
  And I open Switch account on the usage limit strip
  And I pick personal in the account picker
  Then the PreviewContinuation RPC previews the current session on self
  And the handoff dialog asks Continue on personal?
  And the handoff dialog carries <messages>
  And the swap card hands work2claude at limited to personal at 77% left
  And the handoff dialog shows claude with a blue dot
  And the handoff dialog shows self with a teal dot
  When I press Switch and continue
  Then the ContinueSession RPC switches the current session from claude to self
  And the handoff dialog is closed
  When the server switches the session
  Then the usage limit strip is not visible
  And the cut-off tag is visible
  When the session resumes on self from claude by user and replies All provider tests pass now.
  Then the transcript divider reading <divider> sits directly above the reply All provider tests pass now.
  And the transcript divider shows self with a teal dot
  And the What carried over? link sits <link> under the divider
  When I open What carried over? on the transcript divider
  Then the handoff dialog is read-only and carries <messages>

Examples:
  | viewport | messages                                             | divider                                                        | link             |
  | desktop  | Last 46 messages and your first one, word for word   | ↪ Continued on personal · switched by you · What carried over? | inline           |
  | phone    | Last 46 messages and your first one                  | ↪ Continued on personal · switched by you                      | on its own line  |

Scenario Outline: a switch the daemon refuses changes nothing and says why
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  And the quota check reads claude limited until 2026-01-05T09:00:00Z, self unavailable
  And the handoff carries 3 of 3 messages with the first
  And the daemon refuses the switch with Claude account authentication failed
  And I open Switch account on the usage limit strip
  And I pick personal in the account picker
  And I press Switch and continue
  Then the ContinueSession RPC switches the current session from claude to self
  And an error toast titled Couldn't switch to personal says Claude account authentication failed
  And the handoff dialog is closed
  And the usage limit strip is visible

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: limited session with a second account matches frame A
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  Then the usage limit strip is visible
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                          | threshold |
  | desktop  | usage-limit-switch-strip-desktop  | 98        |
  | phone    | usage-limit-switch-strip-phone    | 98        |

Scenario Outline: account picker matches frame B
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal, team as team-max
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  And the quota check reads claude limited until 2026-01-05T09:00:00Z, self 23% used, team limited until 2026-01-01T14:30:00Z
  And I open Switch account on the usage limit strip
  Then the account picker pre-selects personal
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                    | threshold |
  | desktop  | usage-limit-picker-desktop  | 98        |
  | phone    | usage-limit-picker-phone    | 98        |

Scenario Outline: handoff confirm matches frame C
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal, team as team-max
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  And the quota check reads claude limited until 2026-01-05T09:00:00Z, self 23% used, team limited until 2026-01-01T14:30:00Z
  And the handoff carries 47 of 112 messages with the first
  And I open Switch account on the usage limit strip
  And I pick personal in the account picker
  Then the handoff dialog asks Continue on personal?
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                     | threshold |
  | desktop  | usage-limit-confirm-desktop  | 98        |
  | phone    | usage-limit-confirm-phone    | 98        |

Scenario Outline: switched session matches frame D
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  And the server switches the session
  And the session resumes on self from claude by user and replies All provider tests pass now.
  Then the usage limit strip is not visible
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                      | threshold |
  | desktop  | usage-limit-switched-desktop  | 98        |
  | phone    | usage-limit-switched-phone    | 98        |

Scenario Outline: auto-switch matches frame G: a divider and a toast say the session moved
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  And the handoff carries 47 of 112 messages with the first
  When the session hits the seven_day limit on claude resetting at 2026-01-05T09:00:00Z
  And the session resumes on self from claude by auto-switch and replies All provider tests pass now.
  Then the transcript divider reading <divider> sits directly above the reply All provider tests pass now.
  And the transcript divider shows self with a teal dot
  And a toast titled Switched to personal says work2claude reached its weekly limit.
  And the toast offers What carried over? at the left and Settings at the right
  And the layout region visually matches <baseline> at <threshold> percent
  When I press What carried over? on the toast
  Then the handoff dialog is read-only and carries <messages>

Examples:
  | viewport | divider                                                    | messages                                           | baseline                         | threshold |
  | desktop  | ↪ Continued on personal · auto-switch · What carried over? | Last 46 messages and your first one, word for word | usage-limit-auto-switched-desktop | 98        |
  | phone    | ↪ Continued on personal · auto-switch                      | Last 46 messages and your first one                | usage-limit-auto-switched-phone   | 98        |

Scenario Outline: the auto-switch toast's Settings opens the usage limit settings
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  When the session hits the five_hour limit on claude resetting at 2026-01-05T09:00:00Z
  And the session resumes on self from claude by auto-switch and replies All provider tests pass now.
  Then a toast titled Switched to personal says work2claude reached its 5-hour limit.
  When I press Settings on the toast
  Then settings are open on the Instances tab at the usage limit settings

Examples:
  | viewport |
  | desktop  |
  | phone    |

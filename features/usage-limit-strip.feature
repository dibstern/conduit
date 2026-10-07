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

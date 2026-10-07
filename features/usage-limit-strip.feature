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
  | seven_day  | claude  | none                 | Usage limit reached · work2claude    | Weekly limit                    |
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
  | limit     | resets               | detail                        |
  | seven_day | 2026-01-05T09:00:00Z | work2claude · resets Mon 9:00 |
  | five_hour | 2026-01-01T14:30:00Z | work2claude · resets 14:30    |

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

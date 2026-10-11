Feature: The composer's Claude account warns before its plan usage limit

Background:
  Given the conduit app is served with the connected mockup
  And the Usage settings clock is pinned to 2026-01-01T14:25:00Z
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog

Scenario Outline: one account warns without a prefix and uses the viewport's actions
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the <state> state
  When the mock usage window five_hour for claude is 86 percent resetting at 2026-01-01T15:37:00Z
  Then the usage warning strip is visible
  And the usage warning strip shows the <window> window
  And the usage warning strip title reads <title>
  And the usage warning strip detail reads <detail>
  And the usage warning actions match the <viewport> one account layout
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | state  | window    | title                      | detail               | baseline                                       | threshold |
  | desktop  | warn5  | five_hour | 5h limit 86% used.         | Resets in 1h 12m.    | usage-warning-strip-single-five-hour-desktop   | 98        |
  | phone    | warn5  | five_hour | 5h limit 86% used.         | Resets in 1h 12m.    | usage-warning-strip-single-five-hour-phone     | 98        |
  | desktop  | warnWk | seven_day | Weekly limit 91% used.     | Resets Thu 9 am.     | usage-warning-strip-single-weekly-desktop      | 98        |
  | phone    | warnWk | seven_day | Weekly limit 91% used.     | Resets Thu 9 am.     | usage-warning-strip-single-weekly-phone        | 98        |

Scenario Outline: several accounts name the session's account and offer its picker
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the <state> state
  When the mock usage window five_hour for claude is 86 percent resetting at 2026-01-01T15:37:00Z
  Then the usage warning strip is visible
  And the usage warning strip shows the <window> window
  And the usage warning strip title reads <title>
  And the usage warning strip detail reads <detail>
  And the usage warning actions match the <viewport> several account layout
  And the composer region visually matches <baseline> at <threshold> percent
  When I press Switch account on the usage warning strip
  Then the account picker row for Personal reads <quota> and cannot be picked
  And the account picker row for Work reads 52% left and can be picked
  And the account picker pre-selects Spare

Examples:
  | viewport | state  | window    | title                             | detail            | quota    | baseline                                   | threshold |
  | desktop  | warn5  | five_hour | Personal: 5h limit 86% used.      | Resets in 1h 12m. | 14% left | usage-warning-strip-multi-five-hour-desktop | 98        |
  | phone    | warn5  | five_hour | Personal: 5h limit 86% used.      | Resets in 1h 12m. | 14% left | usage-warning-strip-multi-five-hour-phone   | 98        |
  | desktop  | warnWk | seven_day | Personal: Weekly limit 91% used.  | Resets Thu 9 am.  | 9% left  | usage-warning-strip-multi-weekly-desktop    | 98        |
  | phone    | warnWk | seven_day | Personal: Weekly limit 91% used.  | Resets Thu 9 am.  | 9% left  | usage-warning-strip-multi-weekly-phone      | 98        |

Scenario: desktop Details opens Settings directly to Usage
  Given the viewport is a desktop
  And Usage settings have one Claude account in the warn5 state
  Then the usage warning strip is visible
  When I press Details on the usage warning strip
  Then the Usage settings title reads Claude plan usage
  And the Usage warning choice 80 is selected

Scenario Outline: a dismissal below 95 percent rearms once when that window reaches 95
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the normal state
  When the mock usage window <window> for claude is 86 percent resetting at <reset>
  Then the usage warning strip is visible
  When I press Dismiss on the usage warning strip
  Then the usage warning strip is not visible
  When the mock usage window <window> for claude is 94 percent resetting at <reset>
  Then the usage warning strip is not visible
  When the mock usage window <window> for claude is 95 percent resetting at <reset>
  Then the usage warning strip is visible
  And the usage warning strip title reads <label> limit 95% used.
  When the mock usage window <window> for claude is 94 percent resetting at <reset>
  Then the usage warning strip is visible
  And the usage warning strip title reads <label> limit 94% used.

Examples:
  | viewport | window    | label  | reset                |
  | desktop  | five_hour | 5h     | 2026-01-01T15:37:00Z |
  | phone    | five_hour | 5h     | 2026-01-01T15:37:00Z |
  | desktop  | seven_day | Weekly | 2026-01-08T09:00:00Z |
  | phone    | seven_day | Weekly | 2026-01-08T09:00:00Z |

Scenario Outline: a new window restores a dismissed warning even when dismissed above 95
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the normal state
  When the mock usage window <window> for claude is 96 percent resetting at <reset>
  Then the usage warning strip is visible
  When I press Dismiss on the usage warning strip
  Then the usage warning strip is not visible
  When the mock usage window <window> for claude is 99 percent resetting at <reset>
  Then the usage warning strip is not visible
  When the mock usage window <window> for claude is 86 percent resetting at <nextReset>
  Then the usage warning strip is visible
  And the usage warning strip title reads <label> limit 86% used.

Examples:
  | viewport | window    | label  | reset                | nextReset            |
  | desktop  | five_hour | 5h     | 2026-01-01T15:37:00Z | 2026-01-01T20:37:00Z |
  | phone    | five_hour | 5h     | 2026-01-01T15:37:00Z | 2026-01-01T20:37:00Z |
  | desktop  | seven_day | Weekly | 2026-01-08T09:00:00Z | 2026-01-15T09:00:00Z |
  | phone    | seven_day | Weekly | 2026-01-08T09:00:00Z | 2026-01-15T09:00:00Z |

Scenario Outline: a weekly warning takes over a dismissed five-hour warning
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the warn5 state
  Then the usage warning strip shows the five_hour window
  When I press Dismiss on the usage warning strip
  Then the usage warning strip is not visible
  When the mock usage window seven_day for claude is 91 percent resetting at 2026-01-08T09:00:00Z
  Then the usage warning strip is visible
  And the usage warning strip shows the seven_day window
  And the usage warning strip title reads Weekly limit 91% used.

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: usage and context warnings share their styling and stack above the composer
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the warn5 state
  When the mock relay reports context 85 percent
  Then the usage warning strip is visible
  And the composer context warning is visible
  And the usage warning stacks above the composer context warning
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                           | threshold |
  | desktop  | usage-warning-strip-stacked-desktop | 98        |
  | phone    | usage-warning-strip-stacked-phone   | 98        |

Scenario Outline: either plan window at 100 replaces the warning with the existing limit strip
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the warnWk state
  When the mock usage window five_hour for claude is 86 percent resetting at 2026-01-01T15:37:00Z
  Then the usage warning strip shows the seven_day window
  When the mock usage window <window> for claude is 100 percent resetting at <reset>
  Then the usage warning strip is not visible
  When the session hits the <window> limit on claude resetting at <reset>
  Then the usage warning strip is not visible
  And the usage limit strip is visible
  And the usage limit strip title reads <title>

Examples:
  | viewport | window    | reset                | title                          |
  | desktop  | five_hour | 2026-01-01T15:37:00Z | Usage limit reached · Personal |
  | phone    | five_hour | 2026-01-01T15:37:00Z | Usage limit reached            |
  | desktop  | seven_day | 2026-01-08T09:00:00Z | Usage limit reached · Personal |
  | phone    | seven_day | 2026-01-08T09:00:00Z | Usage limit reached            |

Scenario Outline: an open limit recovery suppresses a warning from an older reading
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the warn5 state
  Then the usage warning strip is visible
  When the session hits the five_hour limit on claude resetting at 2026-01-01T15:37:00Z
  Then the usage limit strip is visible
  And the usage warning strip is not visible
  When the server schedules the resume at reset
  Then the usage limit strip is waiting
  And the usage warning strip is not visible

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: warnings off and readings below the chosen threshold suppress the strip
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the warnWk state
  Then the usage warning strip is visible
  When I open settings to the Usage tab
  And I select the Usage warning choice <warnAt>
  Then the Usage warning choice <warnAt> is selected
  When I close settings
  And the mock usage window five_hour for claude is <percent> percent resetting at 2026-01-01T15:37:00Z
  And the mock usage window seven_day for claude is <percent> percent resetting at 2026-01-08T09:00:00Z
  Then the usage warning strip is not visible

Examples:
  | viewport | warnAt | percent |
  | desktop  | off    | 99      |
  | phone    | off    | 99      |
  | desktop  | 70     | 69      |
  | phone    | 70     | 69      |
  | desktop  | 80     | 79      |
  | phone    | 80     | 79      |
  | desktop  | 90     | 89      |
  | phone    | 90     | 89      |

Scenario Outline: a warning without a reset time omits the reset sentence
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the normal state
  When the mock usage window <window> for claude is 86 percent resetting at none
  Then the usage warning strip shows the <window> window
  And the usage warning strip title reads <label> limit 86% used.
  And the usage warning strip has no reset detail

Examples:
  | viewport | window    | label  |
  | desktop  | five_hour | 5h     |
  | phone    | five_hour | 5h     |
  | desktop  | seven_day | Weekly |
  | phone    | seven_day | Weekly |

Scenario Outline: unavailable, limited and missing readings cannot warn
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the warn5 state
  Then the usage warning strip is visible
  When the mock usage reading for claude becomes <status>
  Then the usage warning strip is not visible

Examples:
  | viewport | status      |
  | desktop  | limited     |
  | phone    | limited     |
  | desktop  | unknown     |
  | phone    | unknown     |
  | desktop  | unavailable |
  | phone    | unavailable |
  | desktop  | missing     |
  | phone    | missing     |

Scenario Outline: model-specific weekly usage never warns on its own
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the warn5 state
  Then the usage warning strip is visible
  When the mock usage window seven_day_model for claude is 99 percent resetting at 2026-01-08T09:00:00Z
  And the mock usage window five_hour for claude is 41 percent resetting at 2026-01-01T15:37:00Z
  Then the usage warning strip is not visible

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: a resumed account takes priority over the session's original binding
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the normal state
  When the mock usage window five_hour for work is 86 percent resetting at 2026-01-01T15:37:00Z
  Then the usage warning strip is not visible
  When the session resumes on work by user and replies Ready on Work.
  Then the usage warning strip is visible
  And the usage warning strip title reads Work: 5h limit 86% used.
  When I press Switch account on the usage warning strip
  Then the account picker row for Work reads 14% left and cannot be picked
  And the account picker row for Personal reads 59% left and can be picked

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: a draft warns on its project's bound account without session switching
  Given the viewport is a <viewport>
  And Usage settings have <accounts> Claude accounts in the warn5 state
  When I open the usage warning draft for myapp
  Then the usage warning strip is visible
  And the usage warning strip title reads <title>
  And the usage warning has no Switch account action

Examples:
  | viewport | accounts | title                         |
  | desktop  | one      | 5h limit 86% used.            |
  | phone    | one      | 5h limit 86% used.            |
  | desktop  | several  | Personal: 5h limit 86% used.  |
  | phone    | several  | Personal: 5h limit 86% used.  |

Scenario: warning dismissals do not survive a reload
  Given the viewport is a desktop
  And Usage settings have one Claude account in the warn5 state
  Then the usage warning strip is visible
  When I press Dismiss on the usage warning strip
  Then the usage warning strip is not visible
  When I reload the usage warning session
  Then the usage warning strip is visible

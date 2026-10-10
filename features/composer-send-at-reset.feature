Feature: The composer queues at reset or sends now on another Claude account

Background:
  Given the conduit app is served with the connected mockup
  And the Usage settings clock is pinned to 2026-01-01T14:25:00Z
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog

Scenario Outline: a warning window adds an amber ring to the ordinary send button
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the <state> state
  When I type Check the next task into the composer
  Then the composer send mode is warning
  And the send button has a gapped amber ring and no words
  And the send button reads Send
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | state  | baseline                                     | threshold |
  | desktop  | warn5  | composer-send-at-reset-warning-desktop        | 98        |
  | phone    | warn5  | composer-send-at-reset-warning-phone          | 98        |
  | desktop  | warnWk | composer-send-at-reset-weekly-warning-desktop | 98        |
  | phone    | warnWk | composer-send-at-reset-weekly-warning-phone   | 98        |

Scenario Outline: warnings off and readings below warnAt keep the ordinary button
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the normal state
  When I open settings to the Usage tab
  And I select the Usage warning choice <warnAt>
  And I close settings
  And the mock usage window five_hour for claude is <percent> percent resetting at 2026-01-01T15:13:00Z
  And I type Check the next task into the composer
  Then the composer send mode is normal
  And the composer has a plain Send button

Examples:
  | viewport | warnAt | percent |
  | desktop  | 80     | 79      |
  | phone    | 80     | 79      |
  | desktop  | off    | 99      |
  | phone    | off    | 99      |

Scenario Outline: the desktop button and placeholder name a future reset
  Given the viewport is a desktop
  And Usage settings have one Claude account in the limit state
  When the mock usage window five_hour for claude is 100 percent resetting at <reset>
  Then the composer send mode is at-reset
  And the reset send label reads <label>
  And the composer placeholder reads <placeholder>
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | reset                | label                | placeholder                          | baseline                                  | threshold |
  | 2026-01-01T15:13:00Z | Send at 3:13 pm      | Message Claude… sends at 3:13 pm      | composer-send-at-reset-same-day-desktop    | 98        |
  | 2026-01-08T09:00:00Z | Send at Thu 9 am     | Message Claude… sends at Thu 9 am     | composer-send-at-reset-another-day-desktop | 98        |

Scenario Outline: the phone button keeps a compact time and the reset placeholder
  Given the viewport is a phone
  And Usage settings have one Claude account in the limit state
  When the mock usage window five_hour for claude is 100 percent resetting at <reset>
  Then the composer send mode is at-reset
  And the reset send label reads <label>
  And the phone reset send button is 32 pixels tall
  And the composer placeholder reads <placeholder>
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | reset                | label    | placeholder       | baseline                                | threshold |
  | 2026-01-01T15:13:00Z | 3:13     | Sends at 3:13 pm  | composer-send-at-reset-same-day-phone    | 98        |
  | 2026-01-08T09:00:00Z | Thu 9 am | Sends at Thu 9 am | composer-send-at-reset-another-day-phone | 98        |

Scenario Outline: a limited reading without a future reset keeps plain Send
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the limit state
  When the mock usage window five_hour for claude is 100 percent resetting at <reset>
  Then the composer send mode is normal
  And the composer has a plain Send button
  And the composer placeholder reads Ask Claude…
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | reset                | baseline                                 | threshold |
  | desktop  | none                 | composer-send-at-reset-no-reset-desktop   | 98        |
  | phone    | none                 | composer-send-at-reset-no-reset-phone     | 98        |
  | desktop  | 2026-01-01T14:00:00Z | composer-send-at-reset-past-reset-desktop | 98        |
  | phone    | 2026-01-01T14:00:00Z | composer-send-at-reset-past-reset-phone   | 98        |

Scenario Outline: clicking or pressing Enter queues an ordinary input with its reset caption
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the limit state
  And the mock relay queues submitted messages for reset
  When I type Also run the provider tests afterwards into the composer
  And I send the reset-bound message with <method>
  Then the pending-input tray has 1 row
  And pending-input row 1 reads Also run the provider tests afterwards
  And pending-input row 1 has the reset caption Sends at 3:13 pm
  And pending-input row 1 offers Edit and Remove
  And the composer is empty
  And the composer status header is not visible
  And the usage limit strip is not visible
  And the composer region visually matches <baseline> at <threshold> percent
  When I Edit pending reset input row 1
  Then the pending-input tray is not visible
  And the composer still holds Also run the provider tests afterwards
  When I send the reset-bound message with the button
  Then pending-input row 1 has the reset caption Sends at 3:13 pm
  When I Remove pending reset input row 1
  Then the pending-input tray is not visible
  And the composer is empty

Examples:
  | viewport | method       | baseline                                      | threshold |
  | desktop  | the button   | composer-send-at-reset-queued-desktop          | 98        |
  | desktop  | the keyboard | composer-send-at-reset-queued-keyboard-desktop | 98        |
  | phone    | the button   | composer-send-at-reset-queued-phone            | 98        |

Scenario Outline: a queued caption follows the continuation's scheduled time
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the limit state
  And the session has a scheduled reset continuation at 2026-01-01T15:37:00Z
  And the mock relay queues submitted messages for reset
  When I type Also run the provider tests afterwards into the composer
  And I send the reset-bound message with the button
  Then pending-input row 1 has the reset caption Sends at 3:37 pm
  And pending-input row 1 offers Edit and Remove
  And the usage limit strip is not visible
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                                  | threshold |
  | desktop  | composer-send-at-reset-scheduled-desktop    | 98        |
  | phone    | composer-send-at-reset-scheduled-phone      | 98        |

Scenario Outline: send options appear only for a limited account with another Claude account
  Given the viewport is a <viewport>
  And Usage settings have <accounts> Claude accounts in the <state> state
  When I type Check the next task into the composer
  Then the composer send mode is <mode>
  And the composer send menu trigger is <trigger>

Examples:
  | viewport | accounts | state  | mode     | trigger |
  | desktop  | one      | limit  | at-reset | absent  |
  | phone    | one      | limit  | at-reset | absent  |
  | desktop  | several  | normal | normal   | absent  |
  | phone    | several  | normal | normal   | absent  |
  | desktop  | several  | warn5  | warning  | absent  |
  | phone    | several  | warn5  | warning  | absent  |

Scenario Outline: several accounts add a separate chevron to the reset pill
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  When I type Check the next task into the composer
  Then the composer send mode is at-reset
  And the reset send label reads <label>
  And the composer send menu trigger is visible
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | label           | baseline                                | threshold |
  | desktop  | Send at 3:13 pm | composer-send-menu-chevron-desktop      | 98        |
  | phone    | 3:13            | composer-send-menu-chevron-phone        | 98        |

Scenario Outline: send options show the selected reset then accounts in switch order
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  When I type Check the next task into the composer
  And I open the composer send menu
  Then the send menu is a <presentation>
  And the send menu starts with selected Send at 3:13 pm on Personal
  And the send menu account order is work, spare
  And send menu account work offers Send now on Work with wk 48%
  And send menu account spare offers Send now on Spare with wk 9%
  And the send menu explains the account takeover
  And the composer still holds Check the next task
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | presentation | baseline                             | threshold |
  | desktop  | popover      | composer-send-menu-open-desktop       | 98        |
  | phone    | sheet        | composer-send-menu-open-sheet-phone   | 98        |

Scenario Outline: the fuller window follows usage and five hours wins a tie
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the daemon's usage limits are auto-resume off, auto-switch off, order claude, spare, work
  And the mock usage window seven_day for work is <weekly> percent resetting at 2026-01-08T09:00:00Z
  And the mock usage window seven_day for spare is 40 percent resetting at 2026-01-08T09:00:00Z
  When I type Check the next task into the composer
  And I open the composer send menu
  Then the send menu starts with selected Send at 3:13 pm on Personal
  And the send menu account order is spare, work
  And send menu account spare offers Send now on Spare with wk 40%
  And send menu account work offers Send now on Work with <fuller>

Examples:
  | viewport | weekly | fuller |
  | desktop  | 4      | 5h 12% |
  | phone    | 4      | 5h 12% |
  | desktop  | 12     | 5h 12% |
  | phone    | 12     | 5h 12% |
  | desktop  | 48     | wk 48% |
  | phone    | 48     | wk 48% |

Scenario Outline: limited, blocked and unread accounts are left out
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the send menu also has limited and unread accounts
  And the daemon's usage limits are auto-resume off, auto-switch off, order missing, limited, unknown, unavailable, blocked, claude, work, spare
  When I type Check the next task into the composer
  And I open the composer send menu
  Then the send menu starts with selected Send at 3:13 pm on Personal
  And the send menu account order is work, spare
  And the send menu explains the account takeover

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: choosing the reset row queues the composer with its Sends at caption
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the mock relay queues submitted messages for reset
  When I type Also run the provider tests afterwards into the composer
  And I send the reset-bound message with <method>
  Then the pending-input tray has 1 row
  And pending-input row 1 reads Also run the provider tests afterwards
  And pending-input row 1 has the reset caption Sends at 3:13 pm
  And the composer is empty

Examples:
  | viewport | method             |
  | desktop  | the reset menu row |
  | phone    | the reset menu row |
  | desktop  | the keyboard menu  |
  | desktop  | the button         |
  | desktop  | the keyboard       |
  | phone    | the button         |

Scenario Outline: Send now switches this session then submits its composer text
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the mock relay accepts send-menu switches
  When I type Check the next task into the composer
  And I open the composer send menu
  And I choose Send now on work
  Then the ContinueSession RPC switches the current session from claude to work
  And the composer submits Check the next task after switching to work

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: a refused send-now switch shows the account's toast and preserves the input
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the daemon refuses the switch with The account is not logged in
  When I type Check the next task into the composer
  And I open the composer send menu
  And I choose Send now on work
  Then the ContinueSession RPC switches the current session from claude to work
  And an error toast titled Couldn't switch to Work says The account is not logged in
  And the composer still holds Check the next task
  And the refused send-menu switch submits no input
  And the composer send mode is at-reset

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: auto-switch sends through the first account in the switch order
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the daemon's usage limits are auto-resume off, auto-switch on, order claude, work, spare
  And the mock usage reading for claude becomes limited
  And the mock relay accepts send-menu switches
  When I type Check the next task into the composer
  Then the composer send mode is switch
  And the auto-switch send button reads <label> for work
  And the composer send menu trigger is visible
  And the composer region visually matches <baseline> at <threshold> percent
  When I send the switch-bound message with <method>
  Then the ContinueSession RPC switches the current session from claude to work
  And the composer submits Check the next task after switching to work

Examples:
  | viewport | label        | method       | baseline                                  | threshold |
  | desktop  | Send on Work | the button   | composer-send-menu-auto-switch-desktop     | 98        |
  | phone    | Work         | the button   | composer-send-menu-auto-switch-phone       | 98        |
  | desktop  | Send on Work | the keyboard | composer-send-menu-auto-switch-desktop     | 98        |
  | phone    | Work         | the shortcut | composer-send-menu-auto-switch-phone       | 98        |

Scenario Outline: auto-switch uses reordered accounts and keeps the same reset choice
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the daemon's usage limits are auto-resume off, auto-switch on, order claude, spare, work
  And the mock usage reading for claude becomes limited
  And the mock relay queues submitted messages for reset
  When I type Check the next task into the composer
  Then the composer send mode is switch
  And the auto-switch send button reads <label> for spare
  When I open the composer send menu
  Then the send menu starts with selected Send at 3:13 pm on Personal
  And the send menu account order is spare, work
  When I send the reset-bound message with the open reset menu row
  Then pending-input row 1 has the reset caption Sends at 3:13 pm

Examples:
  | viewport | label         |
  | desktop  | Send on Spare |
  | phone    | Spare         |

Scenario Outline: auto-switch falls back to reset when the other accounts have no room
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the daemon's usage limits are auto-resume off, auto-switch on, order claude, work, spare
  And the mock usage reading for work becomes limited
  And the mock usage reading for spare becomes unavailable
  When I type Check the next task into the composer
  Then the composer send mode is at-reset
  And the reset send label reads <label>
  And the composer send menu trigger is visible
  When I open the composer send menu
  Then the send menu account order is none
  And the send menu explains the account takeover

Examples:
  | viewport | label           |
  | desktop  | Send at 3:13 pm |
  | phone    | 3:13            |

Scenario Outline: a draft offers only the reset row and takeover note
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the daemon's usage limits are auto-resume off, auto-switch on, order claude, work, spare
  When I open the usage warning draft for myapp
  And I type Check the next task into the composer
  Then the composer send mode is at-reset
  And the composer send menu trigger is visible
  When I open the composer send menu
  Then the send menu starts with selected Send at 3:13 pm on Personal
  And the send menu account order is none
  And the send menu explains the account takeover

Examples:
  | viewport |
  | desktop  |
  | phone    |

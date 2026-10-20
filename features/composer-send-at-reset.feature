Feature: The send menu selects and the composer button commits

Background:
  Given the conduit app is served with the connected mockup
  And the Usage settings clock is pinned to 2026-01-01T14:25:00Z
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog

Scenario Outline: a usage warning keeps the neutral send circle beside its fused strip
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the <state> state
  When I type Check the next task into the composer
  Then the composer send mode is warning
  And the warning send button stays a neutral circle without words
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
  When I open settings to the Usage section
  And I select the Usage warning choice <warn_at>
  And I close settings
  And the mock usage window five_hour for claude is <percent> percent resetting at 2026-01-01T15:13:00Z
  And I type Check the next task into the composer
  Then the composer send mode is normal
  And the composer has a plain Send button

Examples:
  | viewport | warn_at | percent |
  | desktop  | 80     | 79      |
  | phone    | 80     | 79      |
  | desktop  | off    | 99      |
  | phone    | off    | 99      |

Scenario Outline: the desktop button and placeholder name a future reset
  Given the viewport is a desktop
  And Usage settings have one Claude account in the limit state
  When the mock usage window five_hour for claude is 100 percent resetting at <reset>
  Then the composer send mode is at-reset
  And the reset send control announces <label>
  And the composer placeholder reads <placeholder>
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | reset                | label                | placeholder                          | baseline                                  | threshold |
  | 2026-01-01T15:13:00Z | Send at 3:13 pm      | Message Claude… sends at 3:13 pm      | composer-send-at-reset-same-day-desktop    | 98        |
  | 2026-01-08T09:00:00Z | Send at Thu 9 am     | Message Claude… sends at Thu 9 am     | composer-send-at-reset-another-day-desktop | 98        |

Scenario Outline: the phone button uses a clock and keeps the reset placeholder
  Given the viewport is a phone
  And Usage settings have one Claude account in the limit state
  When the mock usage window five_hour for claude is 100 percent resetting at <reset>
  Then the composer send mode is at-reset
  And the reset send control announces <label>
  And the phone reset send control is a neutral 34 pixel clock
  And the composer placeholder reads <placeholder>
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | reset                | label    | placeholder       | baseline                                | threshold |
  | 2026-01-01T15:13:00Z | Send at 3:13 pm | Message Claude… sends at 3:13 pm | composer-send-at-reset-same-day-phone | 98 |
  | 2026-01-08T09:00:00Z | Send at Thu 9 am | Message Claude… sends at Thu 9 am | composer-send-at-reset-another-day-phone | 98        |

Scenario Outline: a limited reading without a future reset keeps plain Send
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the limit state
  When the mock usage window five_hour for claude is 100 percent resetting at <reset>
  Then the composer send mode is normal
  And the composer has a plain Send button
  And the composer placeholder matches the <viewport> reply copy
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
  And the mock relay holds submitted messages until reset
  When I type Also run the provider tests afterwards into the composer
  And I send the reset-bound message with <method>
  Then the pending-input tray has 1 row
  And pending-input row 1 reads Also run the provider tests afterwards
  And pending-input row 1 has the reset caption sends 3:13 pm
  And pending-input row 1 offers Edit and Remove
  And the composer is empty
  And the composer status header is not visible
  And the usage limit strip is not visible
  And the queued usage recovery title reads Waiting for Personal's limit to reset
  And the queued usage recovery shows Cancel auto-resume
  And the composer region visually matches <baseline> at <threshold> percent
  When I Edit pending reset input row 1
  Then the pending-input tray is not visible
  And the composer still holds Also run the provider tests afterwards
  When I send the reset-bound message with the button
  Then pending-input row 1 has the reset caption sends 3:13 pm
  When I Remove pending reset input row 1
  Then the pending-input tray is not visible
  And the composer is empty

Examples:
  | viewport | method       | baseline                                      | threshold |
  | desktop  | the button   | composer-send-at-reset-queued-desktop          | 98        |
  | desktop  | the keyboard | composer-send-at-reset-queued-keyboard-desktop | 98        |
  | phone    | the button   | composer-send-at-reset-queued-phone            | 98        |

Scenario Outline: tray strip and composer agree on the scheduled Resume time
  Given the viewport is a <viewport>
  And Usage settings have one Claude account in the limit state
  And the session has a scheduled reset continuation at 2026-01-01T15:37:00Z
  And the mock relay holds submitted messages until reset
  When I type Also run the provider tests afterwards into the composer
  And I send the reset-bound message with the button
  Then pending-input row 1 has the reset caption sends 3:37 pm
  And the reset send control announces Send at 3:37 pm
  And the composer placeholder reads Message Claude… sends at 3:37 pm
  And the queued usage recovery detail reads <waiting_detail>
  And pending-input row 1 offers Edit and Remove
  And the usage limit strip is not visible
  And the queued usage recovery title reads Waiting for Personal's limit to reset
  And the queued usage recovery shows Cancel auto-resume
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | waiting_detail       | baseline                                  | threshold |
  | desktop  | in 1h 12m            | composer-send-at-reset-scheduled-desktop    | 98        |
  | phone    | Personal · in 1h 12m | composer-send-at-reset-scheduled-phone      | 98        |

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
  And the reset send control announces <label>
  And the composer send menu trigger is visible
  And the reset send split pill is neutral
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | label           | baseline                                | threshold |
  | desktop  | Send at 3:13 pm | composer-send-menu-chevron-desktop      | 98        |
  | phone    | Send at 3:13 pm            | composer-send-menu-chevron-phone        | 98        |

Scenario Outline: send options show the selected reset then accounts in switch order
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  When I type Check the next task into the composer
  And I open the composer send menu
  Then the send menu is a <presentation>
  And the send menu starts with selected Send at 3:13 pm on Personal
  And the send menu account order is work, spare
  And the send menu has no Send now on this account option
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

Scenario Outline: Account Limit leaves out full and signed-out accounts and labels unknown readings
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the send menu also has limited and unread accounts
  And the daemon's usage limits are auto-resume off, auto-switch off, order missing, limited, unknown, unavailable, blocked, claude, work, spare
  When I type Check the next task into the composer
  And I open the composer send menu
  Then the send menu starts with selected Send at 3:13 pm on Personal
  And the send menu account order is missing, unknown, work, spare, unmeasured
  And send menu account missing offers Send now on Missing with usage unknown
  And send menu account unknown offers Send now on Unknown with usage unknown
  And the send menu explains the account takeover

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: unknown Usage Readings are listed but automatic sends skip them
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the daemon's usage limits are auto-resume off, auto-switch on, order claude, work, spare
  And the mock usage reading for work becomes <reading_state>
  And the mock relay accepts send-menu switches
  When I type Check the next task into the composer
  Then the auto-switch send button reads <label> for spare
  When I open the composer send menu
  Then the send menu account order is work, spare
  And send menu account work offers Send now on Work with usage unknown
  And the send menu selects account spare
  And the composer has sent no message or account switch
  And the screen region visually matches <baseline> at <threshold> percent
  When I dismiss the composer send menu
  And I send the switch-bound message with the button
  Then the ContinueSession RPC switches the current session from claude to spare
  And the composer submits Check the next task after switching to spare

Examples:
  | viewport | reading_state | label         | baseline                          | threshold |
  | desktop  | unknown       | Send on Spare | composer-send-menu-unknown-desktop | 98        |
  | phone    | unknown       | Spare         | composer-send-menu-unknown-phone   | 98        |
  | desktop  | missing       | Send on Spare | composer-send-menu-unknown-desktop | 98        |
  | desktop  | stale         | Send on Spare | composer-send-menu-unknown-desktop | 98        |

Scenario Outline: unknown usage is used only after the user picks that account
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the daemon's usage limits are auto-resume off, auto-switch <auto_switch>, order claude, work, spare
  And the mock usage reading for work becomes unknown
  And the mock usage reading for spare becomes unavailable
  And the mock relay accepts send-menu switches
  When I type Check the next task into the composer
  Then the composer send mode is at-reset
  And the reset send control announces Send at 3:13 pm
  When I open the composer send menu
  Then the send menu account order is work
  And send menu account work offers Send now on Work with usage unknown
  And the send menu starts with selected Send at 3:13 pm on Personal
  When I choose Send now on work
  Then the auto-switch send button reads <label> for work
  And the composer has sent no message or account switch
  When I send the switch-bound message with <method>
  Then the ContinueSession RPC switches the current session from claude to work
  And the composer submits Check the next task after switching to work

Examples:
  | viewport | auto_switch | label        | method       |
  | desktop  | on          | Send on Work | the button   |
  | desktop  | off         | Send on Work | the keyboard |
  | phone    | on          | Work         | the button   |

Scenario Outline: the account switcher offers unknown usage and rejects signed-out accounts
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the mock usage reading for work becomes <reading_state>
  And the mock usage reading for spare becomes unavailable
  When the session hits the five_hour limit on claude resetting at 2026-01-01T15:13:00Z
  And I open Switch account on the usage limit strip
  Then the account picker row for Work reads usage unknown and can be picked
  And the account picker row for Spare reads unavailable and cannot be picked
  And the composer has sent no message or account switch

Examples:
  | viewport | reading_state |
  | desktop  | unknown       |
  | phone    | missing       |
  | desktop  | stale         |

Scenario Outline: the reset choice uses the Usage Reading taken after the Limit Recovery
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the limit state
  When the session has a Limit Recovery recorded at <limited_at> resetting at 2026-01-01T17:00:00Z
  Then the composer send mode is <mode>
  And the composer placeholder reads <placeholder>

Examples:
  | limited_at           | mode     | placeholder                     |
  | 2026-01-01T14:22:00Z | at-reset | Message Claude… sends at 3:13 pm |
  | 2026-01-01T14:24:00Z | normal   | Reply to Claude…                |
  | unknown             | normal   | Reply to Claude…                |

Scenario Outline: choosing the reset row changes the button and committing queues the Held Message
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the daemon's usage limits are auto-resume off, auto-switch on, order claude, work, spare
  And the mock relay holds submitted messages until reset
  When I type Also run the provider tests afterwards into the composer
  Then the auto-switch send button reads <default_label> for work
  When I open the composer send menu
  And I choose Send at reset with <selection_method>
  Then the composer send mode is at-reset
  And the reset send control announces Send at 3:13 pm
  And the composer still holds Also run the provider tests afterwards
  And the composer has sent no message or account switch
  When I send the reset-bound message with <commit_method>
  Then the pending-input tray has 1 row
  And pending-input row 1 reads Also run the provider tests afterwards
  And pending-input row 1 has the reset caption sends 3:13 pm
  And the queued usage recovery title reads Waiting for Personal's limit to reset
  And the queued usage recovery shows Cancel auto-resume
  And the queued usage recovery offers Switch account
  And the composer is empty
  And the composer send mode is switch
  And the auto-switch send button reads <default_label> for work

Examples:
  | viewport | default_label | selection_method | commit_method |
  | desktop  | Send on Work  | the pointer      | the button    |
  | desktop  | Send on Work  | the keyboard     | the keyboard  |
  | desktop  | Send on Work  | the pointer      | the shortcut  |
  | phone    | Work          | the pointer      | the button    |

Scenario Outline: choosing Send now changes the button and committing switches before submitting
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the mock relay accepts send-menu switches
  When I type Check the next task into the composer
  And I open the composer send menu
  And I choose Send now on work
  Then the composer send mode is switch
  And the auto-switch send button reads <label> for work
  And the composer still holds Check the next task
  And the composer has sent no message or account switch
  When I open the composer send menu
  Then the send menu starts with unselected Send at 3:13 pm on Personal
  And the send menu selects account work
  When I dismiss the composer send menu
  And I send the switch-bound message with <method>
  Then the ContinueSession RPC switches the current session from claude to work
  And the composer submits Check the next task after switching to work
  And the composer commits Check the next task as queue

Examples:
  | viewport | label        | method       |
  | desktop  | Send on Work | the button   |
  | desktop  | Send on Work | the keyboard |
  | desktop  | Send on Work | the shortcut |
  | phone    | Work         | the button   |

Scenario Outline: a refused send-now switch shows the account's toast and preserves the input
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the daemon refuses the switch with The account is not logged in
  When I type Check the next task into the composer
  And I open the composer send menu
  And I choose Send now on work
  Then the composer has sent no message or account switch
  When I send the switch-bound message with the button
  Then the ContinueSession RPC switches the current session from claude to work
  And an error toast titled Couldn't switch to Work says The account is not logged in
  And the composer still holds Check the next task
  And the refused send-menu switch submits no input
  And the composer send mode is switch
  And the auto-switch send button reads <label> for work

Examples:
  | viewport | label        |
  | desktop  | Send on Work |
  | phone    | Work         |

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
  And the reset send split pill is neutral
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
  And the mock relay holds submitted messages until reset
  When I type Check the next task into the composer
  Then the composer send mode is switch
  And the auto-switch send button reads <label> for spare
  When I open the composer send menu
  Then the send menu starts with unselected Send at 3:13 pm on Personal
  And the send menu account order is spare, work
  And the send menu selects account spare
  When I choose Send at reset with the pointer
  Then the reset send control announces Send at 3:13 pm
  And the composer has sent no message or account switch
  When I send the reset-bound message with the button
  Then pending-input row 1 has the reset caption sends 3:13 pm
  And the auto-switch send button reads <label> for spare

Examples:
  | viewport | label         |
  | desktop  | Send on Spare |
  | phone    | Spare         |

Scenario Outline: auto-switch falls back to reset when the other accounts have no room
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the daemon's usage limits are auto-resume off, auto-switch on, order claude, work, spare
  And the mock usage reading for work becomes limited
  And the mock usage window five_hour for work is 100 percent resetting at 2026-01-01T15:13:00Z
  And the mock usage reading for spare becomes unavailable
  When I type Check the next task into the composer
  Then the composer send mode is at-reset
  And the reset send control announces <label>
  And the composer send menu trigger is visible
  When I open the composer send menu
  Then the send menu account order is none
  And the send menu explains the account takeover

Examples:
  | viewport | label           |
  | desktop  | Send at 3:13 pm |
  | phone    | Send at 3:13 pm            |

Scenario: the composer keeps each session's selection and draft
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the limit state
  When I type Keep this session's pick into the composer
  And I open the composer send menu
  And I choose Send now on spare
  Then the auto-switch send button reads Send on Spare for spare
  When I open send-menu session other-send-session
  Then the composer send mode is at-reset
  And the composer is empty
  When I open the composer send menu
  And I choose Send now on work
  Then the auto-switch send button reads Send on Work for work
  When I open send-menu session sess-bound-claude
  Then the auto-switch send button reads Send on Spare for spare
  And the composer still holds Keep this session's pick
  And the composer has sent no message or account switch

Scenario Outline: an account pick falls back to the unpicked mode when its account fills up
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  And the daemon's usage limits are auto-resume off, auto-switch <auto_switch>, order claude, work, spare
  When I type Check the next task into the composer
  And I open the composer send menu
  And I choose Send now on spare
  Then the auto-switch send button reads <picked_label> for spare
  When the mock usage window five_hour for spare is 100 percent resetting at 2026-01-01T15:13:00Z
  Then the composer send mode is <fallback_mode>
  And the composer commit button announces <fallback_label>
  When the mock usage window five_hour for spare is 12 percent resetting at 2026-01-01T15:13:00Z
  Then the composer send mode is <fallback_mode>
  And the composer commit button announces <fallback_label>
  And the composer still holds Check the next task
  And the composer has sent no message or account switch

Examples:
  | viewport | auto_switch | picked_label  | fallback_mode | fallback_label  |
  | desktop  | off         | Send on Spare | at-reset      | Send at 3:13 pm |
  | phone    | off         | Spare         | at-reset      | Send at 3:13 pm |
  | desktop  | on          | Send on Spare | switch        | Send on Work    |
  | phone    | on          | Spare         | switch        | Send on Work    |

Scenario Outline: an account pick falls back to ordinary Send when the current account's limit clears
  Given the viewport is a <viewport>
  And Usage settings have several Claude accounts in the limit state
  When I type Check the next task into the composer
  And I open the composer send menu
  And I choose Send now on work
  Then the composer send mode is switch
  When the mock usage reading for claude becomes available
  And the mock usage window five_hour for claude is 0 percent resetting at 2026-01-01T15:13:00Z
  Then the composer send mode is normal
  And the composer has a plain Send button
  And the composer send menu trigger is absent
  And the composer has sent no message or account switch
  When the mock usage reading for claude becomes limited
  And the mock usage window five_hour for claude is 100 percent resetting at 2026-01-01T15:13:00Z
  Then the composer send mode is at-reset
  And the reset send control announces Send at 3:13 pm

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario: a reset pick is forgotten when the limit clears
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the limit state
  And the daemon's usage limits are auto-resume off, auto-switch on, order claude, work, spare
  When I type Check the next task into the composer
  And I open the composer send menu
  And I choose Send at reset with the pointer
  Then the reset send control announces Send at 3:13 pm
  When the mock usage reading for claude becomes available
  And the mock usage window five_hour for claude is 0 percent resetting at 2026-01-01T15:13:00Z
  Then the composer send mode is normal
  And the composer has a plain Send button
  When the mock usage reading for claude becomes limited
  And the mock usage window five_hour for claude is 100 percent resetting at 2026-01-01T15:13:00Z
  Then the auto-switch send button reads Send on Work for work
  And the composer has sent no message or account switch

Scenario: Cmd+Enter commits the picked account with the existing steer delivery
  Given the viewport is a desktop
  And Usage settings have several Claude accounts in the limit state
  And the mock relay accepts send-menu switches
  When I type Steer through the picked account into the composer
  And I open the composer send menu
  And I choose Send now on spare
  And the open session starts working
  Then the auto-switch send button reads Send on Spare for spare
  And the composer has sent no message or account switch
  When I send the switch-bound message with the shortcut
  Then the ContinueSession RPC switches the current session from claude to spare
  And the composer submits Steer through the picked account after switching to spare
  And the composer commits Steer through the picked account as steer

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

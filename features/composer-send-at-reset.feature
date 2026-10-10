Feature: The composer queues an account-limited send for its scheduled reset

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

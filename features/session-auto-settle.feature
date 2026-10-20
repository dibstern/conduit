Feature: Phone Auto-settle explains the server outlook and saves in place

Background:
  Given the viewport is a phone

Scenario: The default mock outlook is deterministic without scenario seeding
  Given the conduit app is served with the long-transcript mockup
  When I open the overflow session sheet
  Then the auto-settle status line is On · turned off for all sessions in Settings
  And the session sheet stays open with Auto-settle on

Scenario Outline: Every server outlook has exact copy
  Given the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  And the auto-settle read returns <outlook>
  When I open the overflow session sheet
  Then the auto-settle status line is <line>
  And the session sheet stays open with Auto-settle <enabled>

Examples:
  | outlook           | enabled | line                                         |
  | off               | off     | Off · stays until you settle it              |
  | never             | on      | On · turned off for all sessions in Settings |
  | settled           | on      | On · session is settled                      |
  | pinned            | on      | On · paused while pinned                     |
  | snoozed           | on      | On · paused while snoozed                    |
  | unread            | on      | On · paused while unread                     |
  | working           | on      | On · paused while working                    |
  | awaiting-activity | on      | On · waits for new activity                  |
  | due               | on      | On · settles shortly                         |
  | scheduled         | on      | On · settles Sat 9:41 AM if left idle        |

Scenario Outline: Loading preserves the stored flag without guessed copy
  Given the conduit app is served with the long-transcript mockup
  And the phone session sheet state is <state>
  And the auto-settle read is held as scheduled
  When I open the overflow session sheet
  Then the auto-settle status line is blank
  And the session sheet stays open with Auto-settle <enabled>
  And no auto-settle error toast is shown

Examples:
  | state    | enabled |
  | idle     | on      |
  | auto_off | off     |

Scenario Outline: A failed read quietly preserves the stored flag
  Given the conduit app is served with the long-transcript mockup
  And the phone session sheet state is <state>
  And the auto-settle read is held as failure
  When I open the overflow session sheet
  And the held auto-settle read is released
  Then the auto-settle status line is blank
  And the session sheet stays open with Auto-settle <enabled>
  And no auto-settle error toast is shown

Examples:
  | state    | enabled |
  | idle     | on      |
  | auto_off | off     |

Scenario Outline: Saving is busy and renders the write reply without closing
  Given the conduit app is served with the long-transcript mockup
  And the phone session sheet state is <state>
  And the auto-settle read returns <before>
  And the auto-settle write is held as <after>
  When I open the overflow session sheet
  Then the auto-settle status line is <before_line>
  When I toggle Auto-settle in the session sheet
  Then auto-settle is saving with disabled <disabled>
  And the auto-settle status line is <before_line>
  When the held auto-settle write is released
  Then the auto-settle status line is <after_line>
  And the session sheet stays open with Auto-settle <enabled>
  And auto-settle is interactive

Examples:
  | state    | before    | after     | disabled | enabled | before_line                        | after_line                         |
  | idle     | scheduled | off       | true     | off     | On · settles Sat 9:41 AM if left idle | Off · stays until you settle it       |
  | auto_off | off       | scheduled | false    | on      | Off · stays until you settle it       | On · settles Sat 9:41 AM if left idle |

Scenario: A read that lands while saving is dropped
  Given the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  And the auto-settle read is held as scheduled
  And the auto-settle write is held as off
  When I open the overflow session sheet
  And I toggle Auto-settle in the session sheet
  Then auto-settle is saving with disabled true
  When the held auto-settle read is released
  Then the auto-settle status line is blank
  And auto-settle is saving with disabled true
  When the held auto-settle write is released
  Then the auto-settle status line is Off · stays until you settle it
  And the session sheet stays open with Auto-settle off
  And auto-settle is interactive

Scenario: A read that lands after the write cannot replace its outlook
  Given the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  And the auto-settle read is held as scheduled
  And the auto-settle write is held as off
  When I open the overflow session sheet
  And I toggle Auto-settle in the session sheet
  Then auto-settle is saving with disabled true
  When the held auto-settle write is released
  And the held auto-settle read is released
  Then the auto-settle status line is Off · stays until you settle it
  And the session sheet stays open with Auto-settle off

Scenario: A failed write preserves the row and shows the existing error toast
  Given the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  And the auto-settle read returns scheduled
  And the auto-settle write is held as failure
  When I open the overflow session sheet
  Then the auto-settle status line is On · settles Sat 9:41 AM if left idle
  When I toggle Auto-settle in the session sheet
  Then auto-settle is saving with disabled true
  When the held auto-settle write is released
  Then the auto-settle status line is On · settles Sat 9:41 AM if left idle
  And the session sheet stays open with Auto-settle on
  And auto-settle is interactive
  And the session sheet stays open with the reason pill Couldn't change auto-settle Relay unavailable

Scenario: A read for the previous list sheet cannot replace the new session's outlook
  Given the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  And the auto-settle read is held as off
  When I open the list session sheet
  Then the auto-settle status line is blank
  When I close the session sheet with its close button
  And I open the list sheet for another session with a pinned outlook
  Then the auto-settle status line is On · paused while pinned
  When the held auto-settle read is released
  Then the auto-settle status line is On · paused while pinned

Scenario: A failed write during loading still invalidates the old read
  Given the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  And the auto-settle read is held as scheduled
  And the auto-settle write is held as failure
  When I open the overflow session sheet
  And I toggle Auto-settle in the session sheet
  Then auto-settle is saving with disabled true
  When the held auto-settle write is released
  And the held auto-settle read is released
  Then the auto-settle status line is blank
  And the session sheet stays open with Auto-settle on
  And auto-settle is interactive
  And the session sheet stays open with the reason pill Couldn't change auto-settle Relay unavailable

Scenario Outline: Every phone sheet reads and saves the outlook
  Given the conduit app is served with the long-transcript mockup
  And the phone session sheet state is idle
  And the auto-settle read returns scheduled
  And the auto-settle write is held as off
  When I open the <sheet> session sheet
  Then the auto-settle status line is On · settles Sat 9:41 AM if left idle
  When I toggle Auto-settle in the session sheet
  Then auto-settle is saving with disabled true
  When the held auto-settle write is released
  Then the auto-settle status line is Off · stays until you settle it
  And the session sheet stays open with Auto-settle off

Examples:
  | sheet    |
  | overflow |
  | list     |

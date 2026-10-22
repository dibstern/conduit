Feature: Surfaced messages share the activity strip's scale and preserve a reader's pick

Scenario Outline: Inactive surfacing preserves today's activity UI
  Given message surfacing is <state> at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  Then the turn has only its existing activity UI

Examples:
  | viewport | state       |
  | desktop  | inactive    |
  | phone    | inactive    |
  | desktop  | missing-key |
  | phone    | missing-key |
  | desktop  | invalid-key |
  | phone    | invalid-key |

Scenario Outline: The Jev card sits above numbered pins on the strip's own scale
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a live turn
  Then the full-width message card sits above pins aligned with their own steps
  And the surfaced card shows #8 and announces its category and position
  And the open Ask head chip shows #2
  And the surfacing pins are 1,2,4,5,8 and level counts are Key 3, Balanced 5, All 6
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                | threshold |
  | desktop  | surfacing-live-desktop  | 98        |
  | phone    | surfacing-live-phone    | 98        |

Scenario Outline: A tap under four pixels and a drag on either lane keep the selected message
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a live turn
  When I tap surfaced message #2 moving 3 pixels
  Then the surfaced card shows #2 and announces its category and position
  When I scrub the pins from message #2 to #5
  Then the surfaced card shows #5 and announces its category and position
  When I scrub the strip from message #5 to #1
  Then the surfaced card shows #1 and announces its category and position
  And the surfaced card offers Follow latest
  And an ordinary strip segment still captions the head and opens its log row

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Dense All pins fill two rows without hiding the open Ask or a Blocked leader
  Given message surfacing is active at All
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a dense turn
  Then dense surfaced messages occupy two non-overlapping rows with labelled groups
  And the open Ask stays separate and a Blocked message leads its group
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                 | threshold |
  | desktop  | surfacing-dense-desktop   | 98        |
  | phone    | surfacing-dense-phone     | 98        |

Scenario Outline: Group taps and scrubbing preserve access to every dense message
  Given message surfacing is active at All
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a dense turn
  Then tapping a group cycles through its own members from the leader and wraps
  And scrubbing and stepping reach every member and fill its group pill
  When the pin lane narrows to 180 pixels
  Then dense surfaced messages occupy two non-overlapping rows with labelled groups
  And the open Ask stays separate and a Blocked message leads its group
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                    | threshold |
  | desktop  | surfacing-overflow-desktop   | 98        |
  | phone    | surfacing-overflow-phone     | 98        |

Scenario Outline: Levels filter pins without renumbering and Final preserves the strip
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I set the surfacing level to Key
  Then the surfacing pins are 2,5,8 and level counts are Key 3, Balanced 5, All 6
  When I set the surfacing level to All
  Then the surfacing pins are 1,2,3,4,5,8 and level counts are Key 3, Balanced 5, All 6
  When I set the surfacing level to Final
  Then Final shows 6 hidden messages and keeps the strip
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                 | threshold |
  | desktop  | surfacing-final-desktop  | 98        |
  | phone    | surfacing-final-phone    | 98        |

Scenario Outline: A local session override survives reload and can become or return to the default
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I set the surfacing level to Key
  Then the session surfacing override is Key
  When I open another surfacing session using the daemon default
  Then the effective surfacing level is Balanced
  When I reload the surfacing session
  Then the effective surfacing level is Key
  And the session surfacing override is Key
  When I choose surfacing Make default
  Then the daemon default becomes Key without changing other settings
  And the session surfacing override is absent
  When I set the surfacing level to Balanced
  And I choose surfacing Back to default
  Then the effective surfacing level is Key
  And the session surfacing override is absent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Live follow holds a pending folded message then falls back after its routine verdict
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a live turn
  When a new folded surfacing message awaits its verdict
  Then the card follows the pending message without inventing a number
  When the pending surfacing verdict is routine
  Then the surfaced card shows #8 and announces its category and position

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A reader's pick survives new pending parts until Follow latest is pressed
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a live turn
  When I pick surfaced message #2
  And a new folded surfacing message awaits its verdict
  Then the surfaced card shows #2 and announces its category and position
  And the surfaced card offers Follow latest
  When I follow the latest surfaced message
  Then the card follows the pending message without inventing a number
  When the pending surfacing verdict is routine
  Then the surfaced card shows #8 and announces its category and position

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A settled unjudged part remains only in the log
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a live turn
  When a new folded surfacing message awaits its verdict
  Then the card follows the pending message without inventing a number
  When the surfacing turn settles without the pending verdict
  Then the surfaced card shows #8 and announces its category and position

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: The latest Ask remains open only until a later user message
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  Then the open Ask head chip shows #2
  When a later user message answers the open Ask
  Then the open Ask head chip is absent

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Folding hides only the card and a pin reopens it
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a live turn
  When I fold the surfaced message
  Then the surfaced card is hidden but pins and the strip remain
  When I pick surfaced message #2
  Then the surfaced card shows #2 and announces its category and position

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A short settled turn opens its newest message and can close it
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a short turn
  Then the surfaced card shows #2 and announces its category and position
  When I close the surfaced message
  Then the surfaced card is hidden but pins and the strip remain

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Older turns start folded while keeping their pins available
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has an older turn
  Then the older turn starts folded with its pins available
  And the open Ask head chip is absent
  When I pick surfaced message #2
  Then the surfaced card shows #2 and announces its category and position

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A hand-back divides the lane while keeping turn-wide numbers
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a hand-back turn
  Then the two hand-back blocks keep turn-wide numbers on their own strips
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                    | threshold |
  | desktop  | surfacing-handback-desktop  | 98        |
  | phone    | surfacing-handback-phone    | 98        |

Scenario Outline: Empty levels offer Show All while failed judgments remain visible as a note
  Given message surfacing is active at Key
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has an empty turn
  Then the turn shows 1 not judged and Nothing at Key
  When I show all surfaced messages from the empty state
  Then the surfaced card shows #3 and announces its category and position

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Focused card keyboard commands navigate without triggering session commands
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a live turn
  Then surfacing keyboard navigation selects messages and consumes focused-turn shortcuts

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A message becomes read after one continuous visible second
  Given message surfacing is active at Balanced
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I start reading surfaced message #8
  And the surfacing read clock advances 999 milliseconds
  Then the surfaced message Read checkbox is unchecked
  And the surfacing head says 5 unread
  And the surfacing read RPC count is 0
  When the surfacing read clock advances 1 milliseconds
  Then the surfaced message Read checkbox is checked
  And the surfacing head says 4 unread
  And the surfacing read RPC count is 1
  And surfacing read RPC 1 marks only messages 8 read

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A hidden document resets the continuous read interval
  Given message surfacing is active at Balanced
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I start reading surfaced message #8
  And the surfacing read clock advances 600 milliseconds
  And the surfacing document becomes hidden
  And the surfacing read clock advances 1500 milliseconds
  Then the surfaced message Read checkbox is unchecked
  And the surfacing read RPC count is 0
  When the surfacing document becomes visible
  And the surfacing read clock advances 999 milliseconds
  Then the surfacing read RPC count is 0
  When the surfacing read clock advances 1 milliseconds
  Then the surfaced message Read checkbox is checked
  And surfacing read RPC 1 marks only messages 8 read

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: An offscreen card does not read its message
  Given message surfacing is active at Balanced
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I start reading surfaced message #8
  And the surfacing read clock advances 600 milliseconds
  And the surfaced card moves outside the viewport
  And the surfacing read clock advances 1500 milliseconds
  Then the surfacing read RPC count is 0
  And the surfaced message Read checkbox is unchecked
  When the surfaced card moves inside the viewport
  And the surfacing read clock advances 1000 milliseconds
  Then the surfaced message Read checkbox is checked
  And surfacing read RPC 1 marks only messages 8 read

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A slow scrub reads only the released message
  Given message surfacing is active at Balanced
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I start reading surfaced message #1
  And I slowly scrub pins from #1 through #4 to #8
  And the surfacing read clock advances 999 milliseconds
  Then the surfacing read RPC count is 0
  When the surfacing read clock advances 1 milliseconds
  Then the surfaced message Read checkbox is checked
  And the surfacing read RPC count is 1
  And surfacing read RPC 1 marks only messages 8 read

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Explicitly marking an open message unread survives the automatic timer
  Given message surfacing is active at Balanced
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I start reading surfaced message #8
  And the surfacing read clock advances 1000 milliseconds
  Then the surfaced message Read checkbox is checked
  When I uncheck the surfaced message Read checkbox
  And the surfacing read clock advances 1500 milliseconds
  Then the surfaced message Read checkbox is unchecked
  And the surfacing head says 5 unread
  And the surfacing read RPC count is 2
  And surfacing read RPC 2 marks only messages 8 unread

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Bulk read uses only the effective level and leaves the axis at zero
  Given message surfacing is active at Balanced
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I set the surfacing level to Key
  Then the surfacing head says 3 unread
  And the surfacing axis offers Mark 3 read
  When I mark 3 surfaced messages read
  Then surfacing read RPC 1 marks only messages 2,5,8 read
  And the surfacing head says All read ✓
  And the surfacing axis offers no bulk read
  When I set the surfacing level to Balanced
  Then the surfacing head says 2 unread
  And the surfacing axis offers Mark 2 read
  When I set the surfacing level to All
  Then the surfacing head says 3 unread

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: The head and u shortcut advance to the next unread pin and wrap
  Given message surfacing is active at Balanced
  And surfacing read tracking starts with 1,4,8 read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  Then the surfacing head says 2 unread
  When I open the next unread surfaced message from the head
  Then the surfaced card shows #2 and announces its category and position
  When I press surfacing read shortcut u
  Then the surfaced card shows #5 and announces its category and position
  When I press surfacing read shortcut u
  Then the surfaced card shows #2 and announces its category and position
  And the surfacing read RPC count is 0

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: The m shortcut toggles persisted read state in both directions
  Given message surfacing is active at Balanced
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I start reading surfaced message #8
  And I press surfacing read shortcut m
  Then the surfaced message Read checkbox is checked
  And surfacing read RPC 1 marks only messages 8 read
  When I press surfacing read shortcut m
  And the surfacing read clock advances 1500 milliseconds
  Then the surfaced message Read checkbox is unchecked
  And the surfacing read RPC count is 2
  And surfacing read RPC 2 marks only messages 8 unread

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Final hides every message and has zero unread at its effective level
  Given message surfacing is active at Balanced
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I set the surfacing level to Final
  Then Final shows 6 hidden messages and keeps the strip
  And the surfacing head says All read ✓
  And the surfacing axis offers no bulk read
  When the surfacing read clock advances 1500 milliseconds
  Then the surfacing read RPC count is 0

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Final hides a live pending message without reading it
  Given message surfacing is active at Balanced
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a live turn
  When I set the surfacing level to Final
  And a new folded surfacing message awaits its verdict
  Then Final shows 7 hidden messages and keeps the strip
  And the surfacing head says All read ✓
  And the surfacing axis offers no bulk read
  When the surfacing read clock advances 1500 milliseconds
  Then the surfacing read RPC count is 0
  And Final shows 7 hidden messages and keeps the strip

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A failed read save stays unread and permits an explicit retry
  Given message surfacing is active at Balanced
  And surfacing read tracking starts with none read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  And surfacing read writes fail
  When I start reading surfaced message #8
  And the surfacing read clock advances 1000 milliseconds
  Then the surfaced message reports a read save failure
  And the surfacing head says 5 unread
  When the surfacing read clock advances 1500 milliseconds
  Then the surfacing read RPC count is 1
  When surfacing read writes recover
  And I check the surfaced message Read checkbox
  Then the surfaced message Read checkbox is checked
  And the surfacing head says 4 unread
  And the surfacing read RPC count is 2
  And surfacing read RPC 2 marks only messages 8 read

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Mixed read states and the zero state preserve the final theme
  Given message surfacing is active at Balanced
  And surfacing read tracking starts with 1,4,8 read and summaries off
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  And the surfacing capture uses the <theme> theme
  Then the surfacing head says 2 unread
  And the surfaced message Read checkbox is checked
  And the messages region visually matches <mixedbaseline> at <threshold> percent
  When I mark 2 surfaced messages read
  Then the surfacing head says All read ✓
  And the surfacing axis offers no bulk read
  And the messages region visually matches <zerobaseline> at <threshold> percent

Examples:
  | viewport | theme | mixedbaseline                       | zerobaseline                      | threshold |
  | desktop  | dark  | surfacing-read-mixed-dark-desktop    | surfacing-read-zero-dark-desktop   | 98        |
  | phone    | dark  | surfacing-read-mixed-dark-phone      | surfacing-read-zero-dark-phone     | 98        |
  | desktop  | light | surfacing-read-mixed-light-desktop   | surfacing-read-zero-light-desktop  | 98        |
  | phone    | light | surfacing-read-mixed-light-phone     | surfacing-read-zero-light-phone    | 98        |
